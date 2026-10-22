/**
 * 模型侧工具面：`script_run`（唯一注册项，决策 9）。
 *
 * 参数面照官方 `tool-bash` 镜像（`script` / `description` / `workdir` / `timeoutMs`），
 * 另加 `language`；**不镜像** `sandbox_permissions` 与 `justification`（不暴露提权，
 * 决策 7）、`run_in_background`（首期无后台作业面）。
 *
 * 执行顺序（每一步失败都是**预期失败值**，不是工具异常）：
 * 参数校验 → 语言选择（未启用即报错，不静默回落）→ 解释器存在性 → 超时钳位 →
 * 策略解析与 workdir 校验 → 审批（`approval: ask` 时）→ 围栏（失败即 fail-closed）→
 * 执行 → 围栏事实（运行器失败 / 拒绝判定）→ 规范值。
 */

import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { probeInterpreter } from "./probe.ts";
import { renderScriptValue } from "./render.ts";
import { runScript } from "./run.ts";
import type { SpillSink } from "./run.ts";
import type { Deadline } from "./timers.ts";
import {
  SANDBOX_UNAVAILABLE,
  SandboxUnavailableError,
  classifyRunnerFailure,
  confineArgv,
  matchesSignature,
  resolveSandboxPolicy,
} from "./sandbox.ts";
import type {
  ApprovalServiceLike,
  ConfinedArgvLike,
  EnabledLanguage,
  LanguageId,
  SandboxExecutionPolicyLike,
  SandboxFacts,
  SandboxPolicyServiceLike,
  SandboxProviderLike,
  ScriptRunFailure,
  ScriptRunResult,
  ScriptRunValue,
} from "./types.ts";

/** 注册的工具名（与 `security-guard` 的登记键同名，不要改）。 */
export const TOOL_NAME = "script_run";

/** 解释器缺失时的安装指引（按语言给；模型可直接照做）。 */
export const INSTALL_GUIDANCE: Readonly<Record<string, string>> = {
  python:
    "未探测到 Python 解释器：请安装 python3（如 apt install python3 / brew install python）并确保在 PATH 上；" +
    "或用插件配置 pythonPath（等价环境变量 SCRIPT_PY_INTERPRETER）指定解释器路径。",
  bash:
    "未探测到 Bash 解释器：请安装 bash 并确保在 PATH 上；" +
    "或用插件配置 bashPath（等价环境变量 SCRIPT_BASH_INTERPRETER）指定解释器路径。",
  node:
    "未探测到 Node 解释器：请安装 Node.js（如 apt install nodejs / brew install node / fnm install --lts）" +
    "并确保在 PATH 上；或用插件配置 nodePath（等价环境变量 SCRIPT_NODE_INTERPRETER）指定解释器路径。",
  sh:
    "未探测到 POSIX sh 解释器：请安装 sh（多数系统由 dash / busybox 提供）并确保在 PATH 上；" +
    "或用插件配置 shPath（等价环境变量 SCRIPT_SH_INTERPRETER）指定解释器路径。",
};

/** 未知语言的通用指引。 */
const GENERIC_GUIDANCE =
  "未探测到解释器：请安装对应语言的解释器并确保在 PATH 上，或用插件配置的解释器路径覆盖项指定。";

/** 工具的运行设置（`resolveSettings` 的结果里与本工具相关的部分）。 */
export interface ToolSettings {
  /** 启用的语言（顺序即缺省选择）。 */
  readonly languages: readonly LanguageId[];
  /** 逐次审批开关。 */
  readonly approval: "never" | "ask";
  /** 缺省超时（毫秒）。 */
  readonly timeoutMs: number;
  /** 逐次超时上限（毫秒）。 */
  readonly maxTimeoutMs: number;
  /** 单条流保留输出上限（字符）。 */
  readonly maxOutputChars: number;
  /** Python 解释器路径覆盖（execute 期按工作区重探测时的第一顺位）。 */
  readonly pythonPath?: string;
}

/** 本工具消费的宿主面（三项都是可选服务）。 */
export interface ToolHost {
  readonly sandbox?: SandboxProviderLike;
  readonly sandboxPolicy?: SandboxPolicyServiceLike;
  readonly approval?: ApprovalServiceLike;
}

/** 工具装配输入：设置 + 已启用语言 + 落盘后端 + 宿主面 + 超时排期。 */
export interface ToolRuntime {
  readonly settings: ToolSettings;
  readonly languages: readonly EnabledLanguage[];
  readonly spill: SpillSink;
  readonly host: ToolHost;
  /** 超时排期（缺省进程内定时器；装配期由 `apply` 注入统一面）。 */
  readonly deadline?: Deadline;
}

/** 宿主 `ToolRunContext` 里本工具读到的字段（其余字段与本工具无关）。 */
export interface ToolExecLike {
  readonly callId?: string;
  readonly signal?: AbortSignal;
  /** 调用方 agent；本工具只读 `agent.session`（cwd / id），并把它交给审批服务。 */
  readonly agent?: unknown;
}

/** 工具定义的结构面（宿主 `ToolDefinition` 的结构子集）。 */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: "object";
    readonly additionalProperties: boolean;
    readonly required: readonly string[];
    readonly properties: Record<string, unknown>;
  };
  execute(args: unknown, exec?: ToolExecLike): Promise<unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: "text"; text: string }>;
  };
}

/** 会话的最小结构面（宿主 `Session`）。 */
interface SessionLike {
  readonly id?: unknown;
  readonly header?: { readonly cwd?: unknown };
}

/** 一条预期失败值。 */
function fail(code: string, error: string): ScriptRunFailure {
  return { code, error };
}

/** 错误转一行说明。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取非空字符串参数；保留原值（脚本正文的缩进与空行不能被 trim 掉）。 */
function argumentText(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

/** 取整数参数；非数字按「未提供」处理（宿主已按 schema 校验过类型）。 */
function argumentInteger(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

/** 从执行上下文取会话。 */
function sessionOf(exec: ToolExecLike | undefined): SessionLike | undefined {
  const agent = exec?.agent;
  if (typeof agent !== "object" || agent === null) return undefined;
  const session = (agent as { session?: unknown }).session;
  if (typeof session !== "object" || session === null) return undefined;
  return session as SessionLike;
}

/** 会话 id（宿主 `SessionId` 运行时是字符串）；拿不到返回 `undefined`。 */
function sessionIdOf(session: SessionLike | undefined): string | undefined {
  const id = session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** 会话 cwd（`session.header.cwd`）；拿不到返回 `undefined`。 */
function sessionCwdOf(session: SessionLike | undefined): string | undefined {
  const cwd = session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

/** 工作目录解析结果。 */
export interface WorkdirOutcome {
  /** 解析出的绝对 / 已存在目录；两处都没给时缺省（交给 spawn 继承本进程 cwd）。 */
  readonly dir?: string;
  readonly error?: string;
}

/**
 * 解析工作目录：显式值优先（相对路径按工作区根解析），否则用工作区根
 * （沙箱策略解析出的 `workspaceRoot` 即会话 cwd，与围栏用同一身份）。
 */
export function resolveWorkdir(
  requested: string | undefined,
  root: string | undefined,
): WorkdirOutcome {
  const value = requested?.trim();
  let dir = root;
  if (value !== undefined && value !== "") {
    dir = isAbsolute(value) || root === undefined ? value : join(root, value);
  }
  if (dir === undefined) return {};
  try {
    if (!statSync(dir).isDirectory()) {
      return { error: `工作目录不是目录：${dir}` };
    }
  } catch {
    return { error: `工作目录不存在：${dir}` };
  }
  return { dir };
}

/**
 * 逐次审批（`approval: ask` 时）：调用宿主的 `ctx.approval.request()`，
 * 由服务本身写 `approval/asked` + `approval/decided` 审计对。
 * 缺审批服务或没有调用方 agent 时 fail-closed（不执行）。
 */
async function requestApproval(
  runtime: ToolRuntime,
  exec: ToolExecLike | undefined,
  label: string,
  description: string,
): Promise<ScriptRunFailure | undefined> {
  if (runtime.settings.approval !== "ask") return undefined;
  const approval = runtime.host.approval;
  if (approval === undefined) {
    return fail(
      "APPROVAL_UNAVAILABLE",
      "已配置 approval: ask，但宿主未提供 ctx.approval；拒绝执行（fail-closed）。",
    );
  }
  const agent = exec?.agent;
  if (agent === undefined) {
    return fail(
      "APPROVAL_UNAVAILABLE",
      "已配置 approval: ask，但本次调用没有调用方 agent（审计事件无处挂）；拒绝执行（fail-closed）。",
    );
  }
  let outcome: string;
  try {
    outcome = await approval.request({
      agent,
      toolName: TOOL_NAME,
      ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
      reason: `执行 ${label} 脚本：${description}`,
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    });
  } catch (error) {
    return fail("APPROVAL_UNAVAILABLE", `审批请求失败：${describe(error)}`);
  }
  if (outcome === "allowed-once") return undefined;
  return fail("APPROVAL_DENIED", `审批未通过（${outcome}），脚本未执行。`);
}

/**
 * 围栏事实：运行器自身失败 → fail-closed（命令根本没跑，不能当成脚本错误）；
 * 否则按后端的拒绝方言判定「围栏生效并拦下」。
 */
function sandboxFacts(
  policy: SandboxExecutionPolicyLike | undefined,
  confined: ConfinedArgvLike | undefined,
  unavailable: string | undefined,
  exitCode: number | null,
  stderrText: string,
): SandboxFacts | ScriptRunFailure {
  let denied = false;
  if (confined !== undefined) {
    const runnerFailure = classifyRunnerFailure(
      exitCode,
      stderrText,
      confined.runnerFailureRules,
    );
    if (runnerFailure !== undefined) {
      return fail(
        SANDBOX_UNAVAILABLE,
        `沙箱运行器自身失败（命令未执行）：${runnerFailure.detail}`,
      );
    }
    denied = matchesSignature(
      exitCode,
      stderrText,
      confined.denialSignatures ?? [],
    );
  }
  return {
    confined: confined !== undefined,
    ...(policy === undefined ? {} : { mode: policy.mode }),
    ...(confined?.enforcement === undefined
      ? {}
      : { enforcement: confined.enforcement }),
    denied,
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

/**
 * 工具主体：参数校验（script / description / language / timeoutMs）→ 策略与 workdir →
 * 解释器存在性 → 审批 → 围栏 → 执行 → 围栏事实 → 规范值。
 */
async function executeScript(
  runtime: ToolRuntime,
  args: Record<string, unknown>,
  exec: ToolExecLike | undefined,
): Promise<ScriptRunValue> {
  // ① 参数校验：空串报错（对应官方 bash 的 command / description 口径）。
  const script = argumentText(args, "script");
  if (script === undefined) {
    return fail(
      "BAD_ARGUMENT",
      "script 不能为空：把脚本正文放进 script 参数（不是 command），解释器经 stdin 接收。",
    );
  }
  const description = argumentText(args, "description");
  if (description === undefined) {
    return fail(
      "BAD_ARGUMENT",
      "description 不能为空：给一句 5 至 10 词的说明，用于界面展示。",
    );
  }

  // ② 语言选择：缺省 = 已启用的首个；未启用明确报错，不静默回落。
  const enabledIds = runtime.languages.map((entry) => entry.backend.id);
  const requestedLanguage = argumentText(args, "language")?.trim();
  const languageId = requestedLanguage ?? enabledIds[0];
  const selected = runtime.languages.find(
    (entry) => entry.backend.id === languageId,
  );
  if (languageId === undefined || selected === undefined) {
    return fail(
      "LANGUAGE_NOT_ENABLED",
      `语言 ${languageId ?? "(未指定)"} 未启用：可用语言 = ${enabledIds.join(" / ") || "(无)"}；` +
        "缺省取已启用的首个。要启用其它后端，请改插件配置 languages。",
    );
  }
  // python 的解释器在执行时按工作区重探测（见 ④ 之后的 ④.5）；这里先声明。
  let interpreter = selected.interpreter;
  let interpreterChanged = false;

  // ③ 超时：非正数报错，超过上限按上限执行。
  const requestedTimeout = argumentInteger(args, "timeoutMs");
  if (requestedTimeout !== undefined && requestedTimeout <= 0) {
    return fail(
      "BAD_ARGUMENT",
      `timeoutMs 必须是正整数（收到 ${requestedTimeout}）。`,
    );
  }
  const timeoutMs = Math.min(
    requestedTimeout ?? runtime.settings.timeoutMs,
    runtime.settings.maxTimeoutMs,
  );

  // ④ 沙箱策略与工作目录（同一身份：策略根优先于会话 cwd）。
  const session = sessionOf(exec);
  const policyOutcome = resolveSandboxPolicy(runtime.host, session);
  const policy = policyOutcome.policy;
  const workdir = resolveWorkdir(
    argumentText(args, "workdir"),
    policy?.workspaceRoot ?? sessionCwdOf(session),
  );
  if (workdir.error !== undefined) return fail("BAD_ARGUMENT", workdir.error);

  // ④.5 python 后端按工作区重探测（`.venv` / `uv`，显式覆盖仍第一顺位）：
  // 命中且不同于装配期默认 → 切换并记 `interpreterChanged`（回执渲染用）；
  // 未命中 → 回落装配期解释器（即「探测不到回落当前解释器」）。
  if (selected.backend.id === "python" && workdir.dir !== undefined) {
    const workplace = probeInterpreter(selected.backend, {
      config: runtime.settings.pythonPath,
      version: false,
      workspace: { dir: workdir.dir },
    });
    const before = selected.interpreter;
    if (
      workplace.info !== null &&
      (before === null || workplace.info.path !== before.path)
    ) {
      interpreter = workplace.info;
      interpreterChanged = true;
    }
  }

  // ⑤ 解释器缺失：注册了工具但机器上没装（决策 5：不隐藏工具，返回安装指引）。
  if (interpreter === null) {
    return fail(
      "INTERPRETER_MISSING",
      INSTALL_GUIDANCE[selected.backend.id] ?? GENERIC_GUIDANCE,
    );
  }

  // ⑥ 审批先于围栏与执行（与官方 bash 的「先答应，再动手」同序）。
  const approvalFailure = await requestApproval(
    runtime,
    exec,
    selected.backend.label,
    description,
  );
  if (approvalFailure !== undefined) return approvalFailure;

  // ⑦ 围栏：失败即 fail-closed（绝不退回无围栏路径）。
  const rawArgv = [interpreter.path, ...selected.backend.args];
  let argv: readonly string[] = rawArgv;
  let confined: ConfinedArgvLike | undefined;
  if (policy !== undefined && policy.mode !== "danger-full-access") {
    try {
      const outcome = await confineArgv(
        rawArgv,
        runtime.host,
        policy,
        exec?.signal,
      );
      argv = outcome.argv;
      confined = outcome.confined;
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        return fail(error.code, error.message);
      }
      return fail(
        SANDBOX_UNAVAILABLE,
        `围栏失败（命令未执行）：${describe(error)}`,
      );
    }
  }

  // ⑧ 执行。
  const sessionId = sessionIdOf(session);
  const outcome = await runScript({
    argv,
    script,
    timeoutMs,
    maxOutputChars: runtime.settings.maxOutputChars,
    spill: runtime.spill,
    ...(workdir.dir === undefined ? {} : { cwd: workdir.dir }),
    ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(runtime.deadline === undefined ? {} : { deadline: runtime.deadline }),
  });
  if (outcome.spawnError !== undefined) {
    return fail(
      "SPAWN_FAILED",
      `${selected.backend.label} 解释器起不来：${outcome.spawnError}`,
    );
  }

  // ⑨ 围栏事实（运行器失败仍是 fail-closed）。
  const facts = sandboxFacts(
    policy,
    confined,
    policyOutcome.unavailable,
    outcome.exitCode,
    outcome.stderr.text,
  );
  if ("error" in facts) return facts;

  const result: ScriptRunResult = {
    language: selected.backend.id,
    interpreter: interpreter.path,
    ...(interpreterChanged ? { interpreterChanged: true } : {}),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    timeoutMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    sandbox: facts,
  };
  return result;
}

/** 工具描述（模型可见；说明与官方 bash 的分工、回执口径与围栏语义）。 */
function toolDescription(defaultLanguage: LanguageId | undefined): string {
  return (
    "执行一段脚本并返回 stdout / stderr（按 language 选择已启用的解释器；脚本正文经 stdin 交给解释器，" +
    "每次调用都是全新进程；换目录用 workdir，不要在脚本里 cd）。" +
    "非零退出码回执为 [exit code: N]，那是脚本自己的结果、不是工具错误；" +
    "超时回执为 [timed out after Nms]；输出过长时保留尾部，全文落盘并在回执里给出路径。" +
    "命令可能在文件沙箱下执行：被拦下的文件操作回执为 " +
    "[sandbox: file access denied under <mode> mode]，不要换别的写法重试。" +
    (defaultLanguage === undefined
      ? ""
      : `缺省语言 = ${defaultLanguage}；也可用 language 参数指定已启用的其它语言。`) +
    " 解释器缺失时返回含安装指引的错误。"
  );
}

/**
 * 构造 `script_run` 工具定义。
 * `enum` 用**已启用**语言表：未启用的语言在 schema 层就被挡住，execute 里再兜一层。
 */
export function createScriptRunTool(runtime: ToolRuntime): ToolDef {
  const enabledIds = runtime.languages.map((entry) => entry.backend.id);
  const defaultLanguage = enabledIds[0];
  return {
    name: TOOL_NAME,
    description: toolDescription(defaultLanguage),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["script", "description"],
      properties: {
        script: {
          type: "string",
          description:
            "脚本正文（必填，不能为空）：经 stdin 交给解释器，不落临时脚本文件。",
        },
        description: {
          type: "string",
          description: "5 至 10 词的简短说明（必填，不能为空），用于界面展示。",
        },
        language: {
          type: "string",
          enum: enabledIds,
          description:
            `脚本语言（可选）：取值限于已启用的语言 ${enabledIds.join(" / ") || "(无)"}；` +
            `缺省 = 已启用的首个（${defaultLanguage ?? "(无)"}）。`,
        },
        workdir: {
          type: "string",
          description:
            "工作目录（可选）：缺省 = 会话工作区（沙箱策略解析出的根）；相对路径按会话工作区解析。",
        },
        timeoutMs: {
          type: "integer",
          description: `超时毫秒（可选）：缺省 ${runtime.settings.timeoutMs}，上限 ${runtime.settings.maxTimeoutMs}。`,
        },
      },
    },
    async execute(args: unknown, exec?: ToolExecLike): Promise<unknown> {
      const parsed =
        typeof args === "object" && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      return executeScript(runtime, parsed, exec);
    },
    output: {
      // 与仓内其它工具同口径：宽松 schema + 全函数 render。
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (args: unknown, value: unknown) => renderScriptValue(args, value),
    },
  };
}
