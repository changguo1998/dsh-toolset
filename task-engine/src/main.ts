// src/main.ts — cordis 插件入口（零 DSH 运行时依赖，结构面访问）
//
// 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
// name / inject / provide / Config / apply，Config 以类型声明给出（interface Config；
// 无运行时 schema，不引入 schemastery；宿主不校验，配置原样透传给 apply；缺省/非法值
// 沿用本包既有语义——root 缺省示例根、level 非法归一 mechanical，不新增校验）。
//
// 惰性、防御：可选服务（approval/tools）缺失时降级告警而非抛错；工具注册按结构面构造，
// 失败只告警——保证 dsh 加载本 bundle 时不崩。
//
// 已知边界（README 注明）：v1 单执行器、单会话实例；验收命令由本插件以
// /bin/sh -c 执行（信任契约内命令）；human 级审批在工具 execute 内调用
// ctx.approval.request（工具执行发生在 open turn 内，满足 turn-enclosed）。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  TaskEngine,
  type ExecuteRequest,
  type ExecutorRunner,
  type RootSpec,
} from "./engine.ts";
import { createTools, type TaskToolDef, type ToolExecuteCtx } from "./tools.ts";
import type { Acceptance, AcceptanceLevel } from "./types.ts";

export const name = "task-engine";
export const inject = ["tools"];
/** 只读查询面挂载声明（BACKLOG C1 补全：TUI /task 经 ctx.get('taskEngine') 接线） */
export const provide = ["taskEngine"];

export interface Config {
  /** 根任务契约（缺省提供示例根） */
  root?: {
    title: string;
    spec: string;
    acceptance: {
      id: string;
      check: string;
      level: string;
      command?: string;
    }[];
    needDecompose?: boolean;
  };
  /** 每次变更自动写快照的路径（周期快照） */
  snapshotPath?: string;
  /** mechanical 验收命令超时（ms，默认 30s） */
  commandTimeoutMs?: number;
  /** fan-out 并发上限（BACKLOG #13，默认 4）：active 帧数达上限时不再弹栈 */
  maxConcurrent?: number;
}

const LEVELS: readonly AcceptanceLevel[] = ["mechanical", "semantic", "human"];

function isLevel(v: string): v is AcceptanceLevel {
  return (LEVELS as readonly string[]).includes(v);
}

const execFileAsync = promisify(execFile);

/** 真实链路 mechanical 验收：/bin/sh -c 执行，退出码 0 = 通过（executor `command` 后端同用） */
function makeRunCommand(timeoutMs: number) {
  return async (
    cmd: string,
    cwd?: string,
  ): Promise<{ code: number; output?: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", cmd], {
        timeout: timeoutMs,
        ...(cwd === undefined ? {} : { cwd }),
      });
      return { code: 0, output: String(stdout) + String(stderr) };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      const code = typeof e.code === "number" ? e.code : 1;
      return { code, output: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  };
}

// ---------------------------------------------------------------------------
// executor 后端接线（① 发起 / ② 模型与计量）——结构面访问宿主，缺面 fail-closed
// 契约来源：docs/host/HOST-PACKAGES.md 与宿主包类型（@deepseek-ai/dsh-subagent 等）
// ---------------------------------------------------------------------------

/** 宿主子代理面（`ctx.subagents`，@deepseek-ai/dsh-subagent）最小形态 */
interface SubagentsLike {
  start(
    name: string,
    request: Record<string, unknown>,
  ): Promise<{
    id: string;
    localAgent?: { session?: unknown };
    result: Promise<{
      output?: unknown;
      stopReason?: string;
      diagnostic?: string;
    }>;
    dispose(): Promise<void>;
  }>;
  getProvider?(name: string): { capabilities?: { agentOptions?: boolean } };
}

/** 宿主 workflow 面（`ctx.workflowEngine`，@deepseek-ai/dsh-workflow[-ptc]）最小形态 */
interface WorkflowEngineLike {
  start(request: Record<string, unknown>): {
    result: Promise<{ value?: unknown; stopReason?: string; error?: string }>;
    dispose(): Promise<void>;
  };
}

/** 宿主默认模型面（`ctx.agentDefaultModel`）最小形态：只读当前选择 */
interface AgentDefaultModelLike {
  currentSelection(): { provider?: string; model?: string };
}

/** 宿主 token 计量面（`ctx.tokenMeter`）最小形态 */
interface TokenMeterLike {
  measure(session: unknown): { totalTokens?: number };
}

/** 子代理 provider（一次性、不继承父上下文；fork 非本包职责） */
const SUBAGENT_PROVIDER = "spawn";

/** 内容块 → 文本（subagent 输出 / 结构化值兜底） */
function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (
      b !== null &&
      typeof b === "object" &&
      b.type === "text" &&
      typeof b.text === "string"
    ) {
      parts.push(b.text);
    }
  }
  return parts.join("\n").trim();
}

/** 值 → 证据文本（workflow `value` 可能是对象；JSON 化，失败回退 String） */
function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 叶子未声明 `prompt` 时的提示词拼装（引擎只拼「要什么」，不生成「怎么做」）。
 */
function defaultPrompt(req: ExecuteRequest): string {
  const lines: string[] = [`任务：${req.title}`, "", req.spec];
  if (req.acceptance.length > 0) {
    lines.push("", "验收要求：");
    for (const a of req.acceptance) lines.push(`- [${a.level}] ${a.check}`);
  }
  if (req.feedback !== undefined) {
    lines.push("", `上一次反馈（请据此修正）：${req.feedback}`);
  }
  return lines.join("\n");
}

interface ExecutorWireOptions {
  subagents?: SubagentsLike | undefined;
  workflow?: WorkflowEngineLike | undefined;
  defaultModel?: AgentDefaultModelLike | undefined;
  tokenMeter?: TokenMeterLike | undefined;
  runShell: (
    cmd: string,
    cwd?: string,
  ) => Promise<{ code: number; output?: string }>;
  /** 当前工具调用所属 agent（subagent 的 parent / workflow 的 parent） */
  agent?: unknown;
  warn(message: string): void;
}

/**
 * 构造 executor 适配器（①）：引擎只做发起 / 证据回填 / 验收，这里负责把声明翻成宿主调用。
 * 三类后端各自 fail-closed：宿主面缺失、能力位不足、同步抛错都返回可读反馈而非中断引擎。
 */
function makeExecutor(opts: ExecutorWireOptions): ExecutorRunner {
  return async (req: ExecuteRequest) => {
    const spec = req.executor;
    // —— command：/bin/sh -c（退出码非 0 = 失败）——
    if (spec.kind === "command") {
      const command = spec.command;
      if (command === undefined || command.trim() === "") {
        return { ok: false, feedback: "command 后端缺少 command" };
      }
      const out = await opts.runShell(command, spec.cwd);
      const text = (out.output ?? "").trim();
      if (out.code !== 0) {
        return {
          ok: false,
          feedback: `命令退出码 ${out.code}${text === "" ? "" : `：${text.slice(0, 500)}`}`,
        };
      }
      return { ok: true, result: text === "" ? "（命令无输出）" : text };
    }
    // —— subagent：ctx.subagents.start（模型覆盖走 agentOptions 能力位）——
    if (spec.kind === "subagent") {
      const svc = opts.subagents;
      if (svc === undefined || typeof svc.start !== "function") {
        return {
          ok: false,
          feedback: "宿主 ctx.subagents 不可用，subagent 后端无法发起",
        };
      }
      if (opts.agent === undefined) {
        return {
          ok: false,
          feedback:
            "拿不到当前 agent（工具执行上下文缺失），subagent 后端无法发起",
        };
      }
      const caps = svc.getProvider?.(SUBAGENT_PROVIDER)?.capabilities;
      const wantsOptions =
        spec.model !== undefined || spec.budget?.maxTokens !== undefined;
      if (wantsOptions && caps?.agentOptions === false) {
        return {
          ok: false,
          feedback: `provider ${SUBAGENT_PROVIDER} 不支持模型/预算覆盖（缺 agentOptions 能力位）`,
        };
      }
      // ② 模型：未声明时读宿主默认选择记录事实（不显式传，保持宿主合并语义）
      const declaredModel =
        spec.model === undefined
          ? undefined
          : `${spec.model.provider}/${spec.model.model}`;
      const modelFact =
        declaredModel ??
        (opts.defaultModel?.currentSelection === undefined
          ? undefined
          : `${opts.defaultModel.currentSelection().provider ?? "?"}/${opts.defaultModel.currentSelection().model ?? "?"}（宿主默认）`);
      const controller = new AbortController();
      let run: Awaited<ReturnType<SubagentsLike["start"]>>;
      try {
        run = await svc.start(SUBAGENT_PROVIDER, {
          label: `task:${req.frame}`,
          prompt: [{ type: "text", text: spec.prompt ?? defaultPrompt(req) }],
          parent: opts.agent,
          signal: controller.signal,
          ...(spec.model === undefined && spec.budget?.maxTokens === undefined
            ? {}
            : {
                agentOptions: {
                  ...(spec.model === undefined
                    ? {}
                    : {
                        provider: spec.model.provider,
                        model: spec.model.model,
                      }),
                  ...(spec.budget?.maxTokens === undefined
                    ? {}
                    : { maxTokens: spec.budget.maxTokens }),
                },
              }),
        });
      } catch (err) {
        return { ok: false, feedback: `subagent 发起失败：${String(err)}` };
      }
      let result: Awaited<typeof run.result>;
      try {
        result = await run.result;
      } finally {
        try {
          await run.dispose();
        } catch (err) {
          opts.warn(`subagent dispose 失败（忽略）：${String(err)}`);
        }
      }
      // ① 计量：子会话终态 pressure（近似口径，非账单）
      let tokens: number | undefined;
      const childSession = run.localAgent?.session;
      if (childSession !== undefined && opts.tokenMeter !== undefined) {
        try {
          const measured = opts.tokenMeter.measure(childSession).totalTokens;
          if (typeof measured === "number" && Number.isFinite(measured)) {
            tokens = measured;
          }
        } catch (err) {
          opts.warn(`tokenMeter.measure 失败（忽略）：${String(err)}`);
        }
      }
      const stopReason = result.stopReason ?? "unknown";
      const model = modelFact === undefined ? {} : { model: modelFact };
      if (stopReason !== "completed" && stopReason !== "max-tokens") {
        return {
          ok: false,
          feedback: `子代理未正常完成（stopReason=${stopReason}）${result.diagnostic === undefined ? "" : `：${result.diagnostic}`}`,
          ...model,
          ...(tokens === undefined ? {} : { tokens }),
        };
      }
      const text = blocksToText(result.output);
      return {
        ok: true,
        result: text === "" ? "（子代理未返回文本产出）" : text,
        ...model,
        ...(tokens === undefined ? {} : { tokens }),
      };
    }
    // —— workflow：ctx.workflowEngine.start（脚本由叶子显式声明，引擎不生成）——
    const wf = opts.workflow;
    if (wf === undefined || typeof wf.start !== "function") {
      return {
        ok: false,
        feedback: "宿主 ctx.workflowEngine 不可用，workflow 后端无法发起",
      };
    }
    const script = spec.script;
    if (script === undefined || script.trim() === "") {
      return {
        ok: false,
        feedback: "workflow 后端缺少 script（引擎不生成脚本）",
      };
    }
    if (opts.agent === undefined) {
      return {
        ok: false,
        feedback:
          "拿不到当前 agent（工具执行上下文缺失），workflow 后端无法发起",
      };
    }
    let handle: ReturnType<WorkflowEngineLike["start"]>;
    try {
      handle = wf.start({
        script,
        meta: spec.meta ?? {
          name: `task:${req.frame}`,
          description: req.title,
        },
        parent: opts.agent,
      });
    } catch (err) {
      return { ok: false, feedback: `workflow 发起失败：${String(err)}` };
    }
    let outcome: Awaited<typeof handle.result>;
    try {
      outcome = await handle.result;
    } finally {
      try {
        await handle.dispose();
      } catch (err) {
        opts.warn(`workflow dispose 失败（忽略）：${String(err)}`);
      }
    }
    if (outcome.stopReason !== "completed") {
      return {
        ok: false,
        feedback: `workflow ${outcome.stopReason}${outcome.error === undefined ? "" : `：${outcome.error}`}`,
      };
    }
    const text = valueToText(outcome.value);
    return {
      ok: true,
      result: text === "" ? "（workflow 无返回值）" : text,
    };
  };
}

/** 归一化根契约（容忍非法 level → 自动修成 mechanical 打回由裁决层兜底） */
function normalizeRoot(raw: Config["root"]): RootSpec {
  const acceptance: Acceptance[] = (raw?.acceptance ?? []).map(
    (a): Acceptance => ({
      id: a.id,
      check: a.check,
      level: isLevel(a.level) ? a.level : "mechanical",
      ...(a.command === undefined ? {} : { command: a.command }),
    }),
  );
  return {
    title: raw?.title ?? "当前任务",
    spec: raw?.spec ?? "",
    acceptance,
    needDecompose: raw?.needDecompose ?? true,
  };
}

/**
 * 将作者友好的参数 property-map 编译成网关接受的 JSON Schema。
 * dsh 官方工具经 defineTool→parameterSchemaSpecToJsonSchema 产出
 * {type:"object", properties, required}；本 bundle 独立注册需自补这一层，
 * 否则 Ark/OpenAI 兼容网关收到顶层无 type 的裸 map，报
 * "schema must be a JSON Schema of 'type: \"object\"', got 'type: null'"。
 * 对本身已是 JSON Schema（顶层带 type:"object"）的输入保持幂等原样返回。
 */
interface TaskToolParametersSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

function compileParameters(spec: unknown): TaskToolParametersSchema {
  if (
    typeof spec === "object" &&
    spec !== null &&
    "type" in (spec as Record<string, unknown>)
  ) {
    return spec as TaskToolParametersSchema;
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(
    spec as Record<string, { required?: boolean; [k: string]: unknown }>,
  )) {
    const { required: isRequired, ...rest } = value;
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** 结构面适配：把纯工具定义转成 dsh tools.register 接受的形态 */
function toDshTool(def: TaskToolDef) {
  return {
    name: def.name,
    description: def.description,
    parameters: compileParameters(def.parameters),
    async execute(args: Record<string, unknown>, exec: unknown) {
      return def.execute(args, exec);
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      // dsh 0.1.5 ToolOutputDefinition 强制要求 render（args/value → ContentBlock[]）；
      // 结构面最小实现：把规范化 JSON 值序列化为文本块。（SAFETY: value 为
      // JsonValue，JSON.stringify 不会抛循环引用；超大值由宿主 materialize 截断。）
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: JSON.stringify(value) },
      ],
    },
  };
}

interface ToolsRegistrar {
  register(def: unknown): void;
}

/** 可选服务读取（cordis 严格模式下未注入服务的直接属性访问会抛；缺失一律降级） */
function readService<T>(ctx: unknown, name: string): T | undefined {
  try {
    return (ctx as { get?: (n: string) => unknown }).get?.(name) as
      T | undefined;
  } catch {
    return undefined;
  }
}

interface ApprovalLike {
  request(req: {
    agent?: unknown;
    toolName: string;
    callId?: string;
    reason?: string;
    signal?: unknown;
  }): Promise<unknown>;
}

export async function apply(ctx: unknown, config?: Config): Promise<void> {
  const warn = (msg: string): void => {
    process.stderr.write(`[task-engine] warn: ${msg}\n`);
  };
  const toolsSvc: ToolsRegistrar | undefined = (
    ctx as { tools?: ToolsRegistrar }
  ).tools;
  if (toolsSvc === undefined || typeof toolsSvc.register !== "function") {
    warn("ctx.tools 不可用，跳过工具注册");
  }

  // 审批服务（可选）：human 级验收经 ctx.approval.request，fail-closed
  const approval: ApprovalLike | undefined = (
    ctx as { get?: (name: string) => unknown }
  ).get?.("approval") as ApprovalLike | undefined;
  const approveVia = (
    exec: unknown,
  ): ((req: { frame: string; reason: string }) => Promise<boolean>) => {
    const agent = (exec as { agent?: unknown } | undefined)?.agent;
    return async (req: { frame: string; reason: string }): Promise<boolean> => {
      if (approval === undefined || typeof approval.request !== "function")
        return false;
      try {
        // 工具执行在 open turn 内 → approval.request turn-enclosed 约束满足
        const outcome = await approval.request({
          agent,
          toolName: "task_stop",
          reason: req.reason,
        });
        return outcome === "allowed-once";
      } catch (err) {
        warn(`approval.request 失败，fail-closed：${String(err)}`);
        return false;
      }
    };
  };
  // 叶子执行后端（① 发起 / ② 模型与计量）：宿主面结构读取，缺面 fail-closed
  const runShell = makeRunCommand(config?.commandTimeoutMs ?? 30_000);
  const subagents = readService<SubagentsLike>(ctx, "subagents");
  const workflow = readService<WorkflowEngineLike>(ctx, "workflowEngine");
  const defaultModel = readService<AgentDefaultModelLike>(
    ctx,
    "agentDefaultModel",
  );
  const tokenMeter = readService<TokenMeterLike>(ctx, "tokenMeter");
  if (subagents === undefined) {
    warn("ctx.subagents 不可用：executor 的 subagent 后端将 fail-closed");
  }
  if (workflow === undefined) {
    warn("ctx.workflowEngine 不可用：executor 的 workflow 后端将 fail-closed");
  }
  if (tokenMeter === undefined) {
    warn("ctx.tokenMeter 不可用：executor 用量只由后端自报");
  }

  const toolCtx: ToolExecuteCtx = {
    makeApprove: approveVia,
    makeExecutor: (exec) => {
      const agent = (exec as { agent?: unknown } | undefined)?.agent;
      return makeExecutor({
        subagents,
        workflow,
        defaultModel,
        tokenMeter,
        runShell,
        ...(agent === undefined ? {} : { agent }),
        warn,
      });
    },
  };

  let engine: TaskEngine;
  try {
    engine = new TaskEngine({
      root: normalizeRoot(config?.root),
      runCommand: runShell,
      gate: {
        ...(config?.maxConcurrent === undefined
          ? {}
          : { maxConcurrent: config.maxConcurrent }),
      },
      snapshotPath: config?.snapshotPath,
    });
  } catch (err) {
    warn(`引擎初始化失败：${String(err)}`);
    return;
  }

  const tools = createTools(engine, toolCtx);
  if (toolsSvc !== undefined && typeof toolsSvc.register === "function") {
    for (const t of tools) {
      try {
        toolsSvc.register(toDshTool(t));
      } catch (err) {
        warn(`工具 ${t.name} 注册失败：${String(err)}`);
      }
    }
  }

  // 只读查询面挂到 ctx（防御降级，与 metric-loop/C5 同款）：供 TUI /task 接线
  const provideSvc = (
    ctx as { provide?: (name: string, value: unknown) => unknown }
  ).provide;
  if (typeof provideSvc === "function") {
    provideSvc("taskEngine", {
      query: () => engine.query(),
      frameStack: () => engine.frameStack(),
    });
  }

  // cordis 生命周期：unload 时写最终快照
  const ctxAny = ctx as { effect?: (fn: () => unknown) => unknown };
  ctxAny.effect?.(() => () => {
    void engine.writeSnapshot();
  });
}

// 只读查询面 re-export（BACKLOG C1）：供 TUI /task 等接线方从包入口消费引擎只读子集
export { TaskEngine, type TaskEngineSnapshot } from "./engine.ts";
