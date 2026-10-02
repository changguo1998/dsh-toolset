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
//
// 执行期复查（2026-10-02）：executor 的 command 后端与 mechanical 验收命令在执行**之前**
// 各过一次 security-guard（惰性 `ctx.get('guard')`，不要求挂载）：命中即不执行、回执原文作
// 失败原因；未挂载 / 复查抛错 → fail-open 放行 + 只告警一次。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  TaskEngine,
  type ExecuteRequest,
  type ExecutorRunner,
  type RootSpec,
  type EntailHook,
} from "./engine.ts";
import { createTools, type TaskToolDef, type ToolExecuteCtx } from "./tools.ts";
import { validateIsolateId } from "./gate.ts";
import type { AuditRequest, AuditVerdict } from "./acceptance.ts";
import type {
  Acceptance,
  AcceptanceLevel,
  ChildSpec,
  ExecutorSpec,
  FrameId,
  TokenKind,
} from "./types.ts";

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
  /**
   * 语义面（audit / entail）开关与超时：两者各跑一次**裁决子代理**（经 `ctx.subagents`）。
   * 缺省都开（`audit` 关掉 → semantic 验收仍 fail-closed；`entail` 关掉 → 该门跳过，回到旧行为）；
   * 任一次裁决 run 失败 / 超时 / 输出不可解析 → fail-closed 打回（不假通过）。
   */
  semantic?: {
    /** 语义级验收的独立 audit run（缺省 true） */
    audit?: boolean;
    /** 拆解第二道门的 entail run（缺省 true） */
    entail?: boolean;
    /** 单次裁决 run 超时 ms（缺省 120000） */
    timeoutMs?: number;
  };
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
      /** 请求了 `outputSchema` 时宿主校验后的结构化产出 */
      structured?: unknown;
    }>;
    dispose(): Promise<void>;
  }>;
  getProvider?(name: string): {
    capabilities?: { agentOptions?: boolean; outputSchema?: boolean };
  };
}

/** 宿主 workflow 面（`ctx.workflowEngine`，@deepseek-ai/dsh-workflow[-ptc]）最小形态 */
interface WorkflowEngineLike {
  start(request: Record<string, unknown>): {
    result: Promise<{
      value?: unknown;
      stopReason?: string;
      error?: string;
      /** 本次 run 启动的子代理数（失败反馈里带上，便于定位） */
      agentsStarted?: number;
    }>;
    dispose(): Promise<void>;
  };
}

/** 宿主默认模型面（`ctx.agentDefaultModel`）最小形态：只读当前选择 */
interface AgentDefaultModelLike {
  currentSelection(): { provider?: string; model?: string };
}

/** 宿主 token 计量面（`ctx.tokenMeter`）最小形态（pressure 口径：上下文压力） */
interface TokenMeterLike {
  measure(session: unknown): { totalTokens?: number };
}

/** 宿主会话投影注册表（`ctx.sessionProjections`）最小形态：只读某会话的投影状态 */
interface ProjectionRegistryLike {
  stateOf(session: unknown, key: string): unknown;
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

/** 值 → 证据文本（workflow `value` 可能是对象；JSON 缩进化，失败回退 String） */
function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 证据正文上限（字符）：三类后端统一截断，防超大产出撑爆事件流与模型上下文 */
export const MAX_EVIDENCE_CHARS = 8000;

/** 截断证据正文（保留头部 + 标注原始长度；未超限原样返回） */
export function truncateEvidence(text: string): string {
  return text.length <= MAX_EVIDENCE_CHARS
    ? text
    : `${text.slice(0, MAX_EVIDENCE_CHARS)}…（已截断，原始 ${text.length} 字符）`;
}

/** 是否值得记入 `plan/frame-executed.structured`（对象 / 数组；字符串与空值走证据正文） */
function isStructured(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * 从 `tokenUsage` 投影状态里取 provider 上报的输出 token 累计（结构子集；取不到返回 undefined）。
 * `last === null` 表示该会话**还没有任何 usage 样本**（此时 `totals` 全 0 是初值，不是「用量为 0」），
 * 故按不可用处理 → 由调用方回退 pressure 口径。
 */
export function readUsageOutputTokens(state: unknown): number | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const { totals, last } = state as { totals?: unknown; last?: unknown };
  if (last === null || last === undefined) return undefined;
  if (totals === null || typeof totals !== "object") return undefined;
  const output = (totals as { outputTokens?: unknown }).outputTokens;
  return typeof output === "number" && Number.isFinite(output)
    ? output
    : undefined;
}

/** subagent 计量字段（②） */
export interface ChildTokenFields {
  tokens?: number;
  tokensKind?: TokenKind;
}

/**
 * 子会话计量（②）：**优先 usage 口径**（`sessionProjections` 的 `tokenUsage` 投影 =
 * provider 实际上报的**输出 token 累计**），投影不可用时**回退 pressure**（`tokenMeter.measure`
 * 的上下文压力，含系统提示词 / 工具定义）。
 *
 * 注意：本函数只负责**记录用量**，不判超预算——投影的 `totals` 是**跨请求累计**，而
 * `budget.maxTokens`（宿主 `agentOptions.maxTokens`）是**每次请求**的输出上限，两者不可比
 * （真机 12 个 spawn 子会话实测：totals 6–81,955，而实际声明的预算是 256/512/4000）。
 * 是否触顶改用宿主的**权威信号** `stopReason === "max-tokens"`（见调用处）。
 */
export function measureChildTokens(opts: {
  session: unknown;
  resolve<T>(name: string): T | undefined;
  warn(message: string): void;
}): ChildTokenFields {
  const { session, resolve, warn } = opts;
  if (session === undefined) return {};
  const projections = resolve<ProjectionRegistryLike>("sessionProjections");
  if (projections !== undefined) {
    try {
      const usage = readUsageOutputTokens(
        projections.stateOf(session, "tokenUsage"),
      );
      if (usage !== undefined) return { tokens: usage, tokensKind: "usage" };
    } catch (err) {
      warn(
        `sessionProjections.stateOf 失败（回退 pressure 口径）：${String(err)}`,
      );
    }
  }
  const tokenMeter = resolve<TokenMeterLike>("tokenMeter");
  if (tokenMeter === undefined) return {};
  try {
    const measured = tokenMeter.measure(session).totalTokens;
    if (typeof measured === "number" && Number.isFinite(measured)) {
      return { tokens: measured, tokensKind: "pressure" };
    }
  } catch (err) {
    warn(`tokenMeter.measure 失败（忽略）：${String(err)}`);
  }
  return {};
}

/** 一次子代理运行的结果（executor 与裁决 run 共用）。 */
export type ChildRunOutcome =
  | {
      ok: true;
      text: string;
      stopReason: string;
      /** 子会话句柄（executor 侧用于计量；裁决 run 不用） */
      session: unknown;
      /** 请求了 `outputSchema` 时宿主校验后的结构化产出（裁决 run 用它，避免自报假保证） */
      structured?: unknown;
    }
  | {
      ok: false;
      retryable: boolean;
      feedback: string;
      /** 已发起过的 run 才带（供 executor 失败路径继续计量 / 标注） */
      session?: unknown;
      stopReason?: string;
    };

/**
 * 发起一次子代理运行并等终态（`ctx.subagents.start` + 宿主 `settleRun`）。
 * executor 后端与 audit / entail 裁决 run 共用：能力位检查、父 agent、可选模型/预算覆盖、
 * 超时中止（`timeoutMs` 到点 abort，防止 gate 悬挂）、终态判定与文本提取。
 * 缺 `parent` 且 `requireParent` 时 fail-closed（executor 需要归属；裁决 run 允许省略）。
 */
export async function runChildOnce(
  opts: {
    resolve<T>(name: string): T | undefined;
    agent?: unknown;
    warn(message: string): void;
  },
  req: {
    label: string;
    prompt: string;
    model?: { provider: string; model: string };
    maxTokens?: number;
    timeoutMs?: number;
    requireParent?: boolean;
    /** 结构化产出 schema（宿主 `assertObjectJsonSchema` 校验 + 子会话 `structured_output` 工具） */
    outputSchema?: unknown;
  },
): Promise<ChildRunOutcome> {
  const svc = opts.resolve<SubagentsLike>("subagents");
  if (svc === undefined || typeof svc.start !== "function") {
    return {
      ok: false,
      retryable: false,
      feedback:
        "宿主 ctx.subagents 不可用，subagent 后端无法发起（环境问题，不计重试）",
    };
  }
  const requireParent = req.requireParent === true;
  if (requireParent && opts.agent === undefined) {
    return {
      ok: false,
      retryable: false,
      feedback: "拿不到当前 agent（工具执行上下文缺失），subagent 后端无法发起",
    };
  }
  const caps = svc.getProvider?.(SUBAGENT_PROVIDER)?.capabilities;
  if (req.outputSchema !== undefined && caps?.outputSchema === false) {
    return {
      ok: false,
      retryable: false,
      feedback: `provider ${SUBAGENT_PROVIDER} 不支持 outputSchema（声明问题，不计重试）`,
    };
  }
  const wantsOptions = req.model !== undefined || req.maxTokens !== undefined;
  if (wantsOptions && caps?.agentOptions === false) {
    return {
      ok: false,
      retryable: false,
      feedback: `provider ${SUBAGENT_PROVIDER} 不支持模型/预算覆盖（缺 agentOptions 能力位，不计重试）`,
    };
  }
  const timeoutMs = req.timeoutMs ?? 600_000;
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let run: Awaited<ReturnType<SubagentsLike["start"]>>;
    try {
      run = await svc.start(SUBAGENT_PROVIDER, {
        label: req.label,
        prompt: [{ type: "text", text: req.prompt }],
        ...(opts.agent === undefined ? {} : { parent: opts.agent }),
        ...(req.outputSchema === undefined
          ? {}
          : { outputSchema: req.outputSchema }),
        signal: controller.signal,
        ...(wantsOptions
          ? {
              agentOptions: {
                ...(req.model === undefined
                  ? {}
                  : { provider: req.model.provider, model: req.model.model }),
                ...(req.maxTokens === undefined
                  ? {}
                  : { maxTokens: req.maxTokens }),
              },
            }
          : {}),
      });
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        feedback: `subagent 发起失败：${String(err)}`,
      };
    }
    // 等终态：与超时/取消信号竞速（宿主 `run.result` 可能无界；见 command-template 同类教训），
    // 竞速落败时发起回收但不等待（in-process dispose 内部同样 await result）
    const settled = await Promise.race([
      run.result.then((result) => ({ kind: "settled" as const, result })),
      abortPromise(controller.signal),
    ]).catch((err: unknown) => ({ kind: "aborted" as const, err }));
    if (settled.kind === "aborted") {
      reclaimRun(run, opts.warn);
      // 三态区分：超时 / 调用方取消（都不计重试）vs `run.result` 基础设施 reject（可重试）
      if (timedOut) {
        return {
          ok: false,
          retryable: false,
          feedback: `子代理运行超时（${timeoutMs} ms）后中止`,
        };
      }
      if (controller.signal.aborted) {
        return {
          ok: false,
          retryable: false,
          feedback: `子代理运行被取消：${String(settled.err)}`,
        };
      }
      return {
        ok: false,
        retryable: true,
        feedback: `子代理运行失败：${String(settled.err)}`,
      };
    }
    const result = settled.result;
    try {
      await run.dispose();
    } catch (err) {
      opts.warn(`subagent dispose 失败（忽略）：${String(err)}`);
    }
    const stopReason = result.stopReason ?? "unknown";
    if (stopReason !== "completed" && stopReason !== "max-tokens") {
      return {
        ok: false,
        retryable: stopReason !== "aborted",
        feedback: `子代理未正常完成（stopReason=${stopReason}）${result.diagnostic === undefined ? "" : `：${result.diagnostic}`}`,
        session: run.localAgent?.session,
        stopReason,
      };
    }
    return {
      ok: true,
      text: blocksToText(result.output),
      stopReason,
      session: run.localAgent?.session,
      ...(result.structured === undefined
        ? {}
        : { structured: result.structured }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** abort 竞速用的永挂 promise（abort 时 reject）。 */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 发起回收但不等待（失败只告警；宿主 in-process dispose 可能随 result 一起悬挂）。 */
function reclaimRun(run: unknown, warn: (message: string) => void): void {
  const dispose = (run as { dispose?: unknown } | undefined)?.dispose;
  if (typeof dispose !== "function") return;
  try {
    void (dispose as () => Promise<unknown>)
      .call(run)
      .catch((err: unknown) =>
        warn(`subagent dispose 失败（忽略）：${String(err)}`),
      );
  } catch (err) {
    warn(`subagent dispose 失败（忽略）：${String(err)}`);
  }
}

/** 从裁决文本取 JSON 对象（先剥 ``` 围栏）；不可解析返回 undefined。 */
export function parseVerdictJson(
  text: string,
): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const direct = asJsonObject(body);
  if (direct !== undefined) return direct;
  // 回退：扫第一个平衡括号对象（容忍「说明 + 围栏 + JSON」/ 前后缀散文）
  const braceStart = body.indexOf("{");
  if (braceStart < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = braceStart; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return asJsonObject(body.slice(braceStart, i + 1));
    }
  }
  return undefined;
}

/** JSON 文本 → 对象（非对象 / 坏 JSON → undefined）。 */
function asJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 裁决信封 schema（交给宿主 `outputSchema` 校验；子会话经 `structured_output` 工具上报）：
 * `{ <kind>: boolean, feedback?: string, structured?: <声明 schema> }`。
 */
export function verdictEnvelope(
  kind: "pass" | "ok",
  schema?: unknown,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [kind]: { type: "boolean" },
      feedback: { type: "string" },
      ...(schema === undefined ? {} : { structured: schema }),
    },
    required: schema === undefined ? [kind] : [kind, "structured"],
  };
}

/** 裁决值：优先宿主校验过的 `structured`（避免自报假保证），否则回退文本解析。 */
export function readVerdictValue(
  out: ChildRunOutcome,
): Record<string, unknown> | undefined {
  if (!out.ok) return undefined;
  const structured = out.structured;
  if (
    structured !== null &&
    typeof structured === "object" &&
    !Array.isArray(structured)
  ) {
    return structured as Record<string, unknown>;
  }
  return parseVerdictJson(out.text);
}

/** audit run 提示词（§16.2）：只输出一个 JSON 对象。 */
export function auditPrompt(req: AuditRequest): string {
  const lines = [
    "你是独立验收裁决者。请只依据下面给出的产出判断该验收项是否通过，不要调用工具。",
    "",
    `验收项：${req.check}`,
    "",
    "被审产出：",
    req.result === undefined ? "（无产出文本）" : truncateEvidence(req.result),
  ];
  if (req.outputSchema !== undefined) {
    lines.push(
      "",
      "结构化裁决要求：在 JSON 中额外给出 `structured` 字段，其形状必须严格符合下面的 JSON Schema：",
      JSON.stringify(req.outputSchema),
    );
  }
  lines.push(
    "",
    '只输出一个 JSON 对象，形如 {"pass": true, "feedback": "理由"}（pass 为布尔值，feedback 为简洁理由' +
      (req.outputSchema === undefined ? "）" : '，另加 "structured"）'),
  );
  return lines.join("\n");
}

/** entail run 提示词（§17.2）：只输出一个 JSON 对象。 */
export function entailPrompt(
  parent: {
    id: string;
    title?: string;
    spec?: string;
    acceptance: Acceptance[];
  },
  children: ChildSpec[],
): string {
  const lines = [
    "你是拆解门禁的语义裁决者。请判断：若下面每个子任务的验收都通过，父任务的验收是否必然成立？",
    "只做逻辑判断，不要调用工具。",
    "",
    `父任务：${parent.title ?? parent.id}`,
    ...(parent.spec === undefined || parent.spec === ""
      ? []
      : [`父任务规格：${parent.spec}`]),
    "父任务验收：",
    ...parent.acceptance.map((a) => `- [${a.level}] ${a.check}`),
    "",
    "子任务：",
  ];
  for (const child of children) {
    lines.push(`- ${child.id}：${child.title}`);
    lines.push(`  规格：${child.spec}`);
    for (const a of child.acceptance)
      lines.push(`  验收 [${a.level}]：${a.check}`);
  }
  lines.push(
    "",
    '只输出一个 JSON 对象，形如 {"ok": true, "feedback": "理由"}（ok 为布尔值：true 表示蕴含成立）',
  );
  return lines.join("\n");
}

/** ② 模型事实：声明了就记声明值，否则读宿主默认选择（不显式传，保持宿主合并语义）。 */
function modelFactOf(
  resolve: <T>(name: string) => T | undefined,
  model: { provider: string; model: string } | undefined,
): { model?: string } {
  if (model !== undefined) return { model: `${model.provider}/${model.model}` };
  const defaultModel = resolve<AgentDefaultModelLike>("agentDefaultModel");
  const current = defaultModel?.currentSelection?.();
  if (current === undefined) return {};
  return {
    model: `${current.provider ?? "?"}/${current.model ?? "?"}（宿主默认）`,
  };
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
  /**
   * 宿主服务**惰性**解析（① 发起 / ② 计量）：执行期按名解析，而不是 apply 期快照。
   * 真机 2026-10-02 观察：`subagents` / `workflowEngine` 在 apply 期 `ctx.get` 返回 undefined
   * （cordis 的 `get` 是不要求 inject 的读取，但服务 fiber 未激活 / 作用域不同时为 undefined），
   * 到工具执行期（agent 侧 ctx）才可读 —— 故这里把「读服务」推迟到每次发起时。
   */
  resolve<T>(name: string): T | undefined;
  runShell: (
    cmd: string,
    cwd?: string,
  ) => Promise<{ code: number; output?: string }>;
  /** 执行前命令复查（security-guard 服务面）：命中返回拦截回执，null = 放行 */
  checkCommand: CommandChecker;
  /** 隔离器（叶子声明 `isolate: "worktree"` 时建 / 复用 / 回收；未声明不触达） */
  isolator: WorktreeIsolator;
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
    // 隔离声明复查（执行期兜底；声明期由 gate.validateExecutor 先挡一道）：命中即不执行
    const declError = checkIsolateDecl(spec, req.frame);
    if (declError !== null) {
      return {
        ok: false,
        retryable: false,
        feedback: `${declError}（声明问题，不计重试）`,
      };
    }
    // 隔离（D2）：建 / 复用 worktree，成功后其路径**覆盖**声明的 cwd 交给后端
    let cwd = spec.cwd;
    if (spec.isolate === "worktree") {
      const made = await opts.isolator.ensure(req.frame, spec.cwd);
      if (!made.ok) {
        return { ok: false, retryable: false, feedback: made.feedback };
      }
      cwd = made.cwd;
    }
    /** 执行失败的回执带上隔离现场（工作区保留、重试复用；不静默） */
    const retainedNote =
      spec.isolate === "worktree" && cwd !== undefined
        ? `（隔离工作区保留在 ${cwd}，重试复用）`
        : "";
    // —— command：/bin/sh -c（退出码非 0 = 失败）——
    if (spec.kind === "command") {
      const command = spec.command;
      if (command === undefined || command.trim() === "") {
        return {
          ok: false,
          retryable: false,
          feedback: "command 后端缺少 command（声明问题，不计重试）",
        };
      }
      // 执行前复查（D1①）：命令来自契约声明（不在工具入参里，声明处检查覆盖不到）——
      // 命中即不执行，回执原文作为失败原因（声明问题，不计重试）
      const receipt = opts.checkCommand(
        command,
        `task-engine{executor} ${req.frame}`,
      );
      if (receipt !== null) {
        return {
          ok: false,
          retryable: false,
          feedback: `命令被 security-guard 执行前复查拦截（未执行）：\n${receipt}`,
        };
      }
      const out = await opts.runShell(command, cwd);
      const text = truncateEvidence((out.output ?? "").trim());
      if (out.code !== 0) {
        return {
          ok: false,
          feedback: `命令退出码 ${out.code}${text === "" ? "" : `：${text.slice(0, 500)}`}${retainedNote}`,
        };
      }
      return { ok: true, result: text === "" ? "（命令无输出）" : text };
    }
    // —— subagent：ctx.subagents.start（模型覆盖走 agentOptions 能力位；与裁决 run 共用 runChildOnce）——
    if (spec.kind === "subagent") {
      const started = await runChildOnce(opts, {
        label: `task:${req.frame}`,
        prompt: spec.prompt ?? defaultPrompt(req),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.budget?.maxTokens === undefined
          ? {}
          : { maxTokens: spec.budget.maxTokens }),
        requireParent: true,
      });
      const model = modelFactOf(opts.resolve, spec.model);
      if (!started.ok) {
        // 失败路径仍带回计量与超预算标注（与重接前一致）
        const tokenFields = measureChildTokens({
          session: started.session,
          resolve: opts.resolve,
          warn: opts.warn,
        });
        const overBudget =
          spec.budget?.maxTokens === undefined
            ? undefined
            : started.stopReason === "max-tokens";
        return {
          ok: false,
          retryable: started.retryable,
          feedback: started.feedback,
          ...model,
          ...tokenFields,
          ...(overBudget === undefined ? {} : { overBudget }),
        };
      }
      // ① 计量：优先 usage 投影（provider 上报输出 token 累计）；投影不可用时回退 pressure
      const tokenFields = measureChildTokens({
        session: started.session,
        resolve: opts.resolve,
        warn: opts.warn,
      });
      // ② 超预算：只认宿主权威信号——声明了预算且 `stopReason === "max-tokens"`（宿主因**每次请求**
      //    的输出上限截断了子代理）。不用 tokens 数值比较：usage 投影是跨请求累计，口径不同
      //    （真机实测会把 10/12 个子会话恒判超预算）
      const overBudget =
        spec.budget?.maxTokens === undefined
          ? undefined
          : started.stopReason === "max-tokens";
      const text = truncateEvidence(started.text);
      return {
        ok: true,
        result: text === "" ? "（子代理未返回文本产出）" : text,
        ...model,
        ...tokenFields,
        ...(overBudget === undefined ? {} : { overBudget }),
      };
    }
    // —— workflow：ctx.workflowEngine.start（脚本由叶子显式声明，引擎不生成）——
    const wf = opts.resolve<WorkflowEngineLike>("workflowEngine");
    if (wf === undefined || typeof wf.start !== "function") {
      return {
        ok: false,
        retryable: false,
        feedback:
          "宿主 ctx.workflowEngine 不可用，workflow 后端无法发起（环境问题，不计重试）",
      };
    }
    const script = spec.script;
    if (script === undefined || script.trim() === "") {
      return {
        ok: false,
        retryable: false,
        feedback:
          "workflow 后端缺少 script（引擎不生成脚本，声明问题不计重试）",
      };
    }
    if (opts.agent === undefined) {
      return {
        ok: false,
        retryable: false,
        feedback:
          "拿不到当前 agent（工具执行上下文缺失），workflow 后端无法发起",
      };
    }
    // 默认 meta 生成：`name` / `description` 由帧补齐，叶子声明的字段覆盖之
    // （无效值的 META_INVALID 已在门禁前置拒绝）
    const meta = {
      name: `task:${req.frame}`,
      description: req.title,
      ...(spec.meta ?? {}),
    };
    let handle: ReturnType<WorkflowEngineLike["start"]>;
    try {
      handle = wf.start({ script, meta, parent: opts.agent });
    } catch (err) {
      // 同步抛错 = 请求根本无法开始（META_INVALID / SCRIPT_PARSE）→ 声明问题，重试无用
      return {
        ok: false,
        retryable: false,
        feedback: `workflow 无法开始（请修 script / meta 声明）：${String(err)}`,
      };
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
    const stopReason = outcome.stopReason ?? "unknown";
    if (stopReason !== "completed") {
      const agents =
        typeof outcome.agentsStarted === "number" && outcome.agentsStarted > 0
          ? `（已启动子代理 ${outcome.agentsStarted} 个）`
          : "";
      return {
        ok: false,
        // cancelled = 用户取消：不打回重试；error 等运行期失败交 bounded retry
        retryable: stopReason !== "cancelled",
        feedback: `workflow ${stopReason}${outcome.error === undefined ? "" : `：${outcome.error}`}${agents}`,
      };
    }
    const text = truncateEvidence(valueToText(outcome.value));
    return {
      ok: true,
      result: text === "" ? "（workflow 无返回值）" : text,
      ...(isStructured(outcome.value) ? { structured: outcome.value } : {}),
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

/**
 * JSON 文本（render 必须全函数，`text` 恒为 string）：字符串原样返回（避免二次编码），
 * 其余 `JSON.stringify(value, null, 2)`；`undefined` / 函数 / symbol 结果为非字符串，
 * 循环引用 / BigInt 直接抛错——两种情况退化为 `String(value)`，`String` 仍抛则给占位。
 */
function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text === "string") return text;
  } catch {
    // 循环引用 / BigInt：序列化抛错，落到下方 String 兜底
  }
  try {
    return String(value);
  } catch {
    return "（无法序列化的值）";
  }
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
      // JsonValue，JSON.stringify 不会抛循环引用；但**可能返回非字符串**——
      // `undefined` / 函数 / symbol 时返回 `undefined`，宿主会拒畸形块
      // `{type:"text", text:undefined}`；故统一走 jsonText 兜底，text 恒为 string。
      // 超大值由宿主 materialize 截断。）
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
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

/**
 * 命令复查器（security-guard 服务面）：返回 null = 放行；字符串 = 拦截回执（多行，
 * 首行为来源标注）。真实实现由 security-guard 插件经 `ctx.get('guard')` 提供；
 * 未挂载即不复查（fail-open 放行）。
 */
export type CommandChecker = (command: string, source: string) => string | null;

/** security-guard 服务面（结构子集；不 import 对方代码、不进 inject，避免跨包硬依赖）。 */
interface GuardServiceLike {
  /** 命令复查 API（见 security-guard 的 GuardService.inspectCommand） */
  inspectCommand?: (command: string, source?: string) => string | null;
}

/**
 * 构造命令复查器（executor 命令后端与 mechanical 验收共用的执行期检查点）：
 * 按名**惰性**解析 security-guard 的复查 API（apply 期服务 fiber 常未激活，执行期才可读）。
 *
 * fail-open 粒度（D2）：服务缺失 / 形状不符 / 复查自身抛错一律**放行**（不得让既有流程失败），
 * 且每种失效模式**只告警一次**（不刷屏）。返回非字符串 / 空串一律按放行，
 * 只有明确的非空回执才算拦截。
 */
export function makeCommandGuard(
  ctx: unknown,
  warn: (message: string) => void,
): CommandChecker {
  let warnedMissing = false;
  let warnedThrow = false;
  return (command, source) => {
    const svc = readService<GuardServiceLike>(ctx, "guard");
    const inspect = svc?.inspectCommand;
    if (typeof inspect !== "function") {
      if (!warnedMissing) {
        warnedMissing = true;
        warn(
          "security-guard 服务不可用（ctx.get('guard') 无 inspectCommand）：" +
            "执行期命令复查已跳过（fail-open，已知残余边界）",
        );
      }
      return null;
    }
    try {
      const receipt = inspect.call(svc, command, source);
      return typeof receipt === "string" && receipt.length > 0 ? receipt : null;
    } catch (err) {
      if (!warnedThrow) {
        warnedThrow = true;
        warn(
          `security-guard 复查异常（按放行处理，同类异常不再重复告警）：${String(err)}`,
        );
      }
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// executor 隔离（自建简易 worktree，见 README「executor 隔离」）
//
// 语义：叶子声明 `isolate: "worktree"` → 执行前建 git worktree（`<repo>/.worktree/<leafId>`，
// 分支 `dsh/<leafId>`），把该路径作为 `cwd` 交给后端；帧进入终态（done / failed）时回收。
// 边界（简单版）：不自动 merge、不做审查 / checkpoint、不处理远程；**仅 command 后端生效**
// （宿主 `SubagentStartRequest` / workflow 面都没有 cwd 参数 → 声明期即拒绝，不做「假装隔离」）。
// 所有 git 调用一律 `execFile` 直调（不经 shell），且**复用** `makeCommandGuard` 做执行前复查
// （source = `task-engine{worktree} <leafId> cwd=<repo>`）：命中即不执行，回执原文原样返回。
// ---------------------------------------------------------------------------

/** 隔离工作区在仓库根下的目录名（本仓已 .gitignore 忽略） */
const WORKTREE_DIR = ".worktree";
/** 隔离分支前缀 */
const WORKTREE_BRANCH_PREFIX = "dsh/";

/** 隔离出的工作区句柄（同一 leafId 二次执行复用，D5） */
interface WorktreeHandle {
  repo: string;
  path: string;
  branch: string;
}

/** git 调用结果（blocked = guard 命中，命令未执行，stdout 为回执原文） */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  blocked?: boolean;
}

/** 隔离器的对外形态（建 / 复用 + 回收） */
interface WorktreeIsolator {
  /** 建或复用该帧的 worktree；ok 时 `cwd` = 该路径 */
  ensure(frameId: FrameId, declaredCwd?: string): Promise<IsolateOutcome>;
  /** 回收 worktree + 分支；返回非空 = 回收失败注记（现场保留，路径在内） */
  reclaim(frameId: FrameId): Promise<string | undefined>;
  /** 批量回收（插件卸载等收尾路径的 best-effort；逐帧与 reclaim 同语义） */
  reclaimAll(): Promise<string[]>;
}

/** ensure 结果 */
type IsolateOutcome =
  { ok: true; cwd: string } | { ok: false; feedback: string };

/** 路径规范化（realpath 失败回退 resolve；用于「该路径是否就是 worktree 根」比对） */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** 取文本首行（错误反馈只带关键一行，避免整段 stderr 灌进回执） */
function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * leafId → 隔离段（目录名 / 分支名）：只留 `[A-Za-z0-9_-]`，其余替换为 `_`
 * （防 `../../evil` 之类路径穿越，也避开非法 git 引用名）；若清洗结果与原值不同，
 * 追加 8 位短哈希，避免「清洗后撞名」让两个 leaf 共用同一工作区。
 * 合法 id（如 `c1` / `frame-2`）零变化。
 */
export function worktreeSegment(frameId: string): string {
  const cleaned = frameId.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = cleaned === "" ? "_" : cleaned;
  if (base === frameId) return base;
  return `${base}-${createHash("sha1").update(frameId).digest("hex").slice(0, 8)}`;
}

/**
 * 隔离声明复查（执行期；同一套规则在声明期由 `gate.validateExecutor` 先挡一道，
 * 这里兜住 Config / 旁路带进来的 executor）：只认 `"worktree"`，且只对 `command` 后端生效。
 * 返回 null = 放行。
 */
function checkIsolateDecl(spec: ExecutorSpec, frameId: FrameId): string | null {
  const isolate: unknown = spec.isolate;
  if (isolate === undefined) return null;
  if (isolate !== "worktree") {
    return `executor.isolate 目前只支持 "worktree"（收到 ${JSON.stringify(isolate)}）`;
  }
  if (spec.kind !== "command") {
    return `isolate:"worktree" 只对 command 后端生效：宿主 ${spec.kind} 面没有 cwd 参数，隔离无处落地（请改用 command 后端，或去掉 isolate 声明）`;
  }
  // id 规则（同 gate.validateIsolateId）：root 契约声明执行后端时绕过 decompose 门禁，这里兜住
  return validateIsolateId(frameId);
}

/**
 * 自建简易 worktree 隔离器（内存态：进程内按 leafId 记账；重启后靠 worktree 现状复用）。
 * 三个不变量：① 建之前先复查 git 命令（D3）；② 同一 leafId 只 `add` 一次（D5）；
 * ③ 回收失败保留现场并把路径写进注记（D4，不静默）。
 */
function makeWorktreeIsolator(opts: {
  checkCommand: CommandChecker;
  warn(message: string): void;
}): WorktreeIsolator {
  const held = new Map<FrameId, WorktreeHandle>();

  const sourceOf = (frameId: FrameId, repo: string): string =>
    `task-engine{worktree} ${frameId} cwd=${repo}`;

  /** git 调用（D3）：先经 guard 复查，命中即不执行；未命中才 execFile 直调 */
  const git = async (
    args: string[],
    cwd: string,
    source: string,
  ): Promise<GitResult> => {
    const receipt = opts.checkCommand(["git", ...args].join(" "), source);
    if (receipt !== null) {
      return { code: -1, stdout: receipt, stderr: "", blocked: true };
    }
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        timeout: 60_000,
      });
      return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: typeof e.code === "number" ? e.code : 1,
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? ""),
      };
    }
  };

  /** guard 命中的统一回执包装（回执原文**原样**进 feedback，D3） */
  const blockedFeedback = (what: string, receipt: string): string =>
    `${what}被 security-guard 执行前复查拦截（未执行）：\n${receipt}`;

  /** 该路径是否已是可用 worktree（`--show-toplevel` 指回自己，而非外层主树） */
  const isWorktree = async (
    path: string,
    frameId: FrameId,
    repo: string,
  ): Promise<boolean> => {
    if (!existsSync(path)) return false;
    const r = await git(
      ["rev-parse", "--show-toplevel"],
      path,
      sourceOf(frameId, repo),
    );
    if (r.code !== 0) return false;
    return realPath(r.stdout.trim()) === realPath(path);
  };

  const ensure = async (
    frameId: FrameId,
    declaredCwd?: string,
  ): Promise<IsolateOutcome> => {
    // D5 幂等：同一 leafId 已在册 → 按**注册表**复核仍是可用 worktree（不用 fs 存在判断：
    // 被外部删剩的空目录会被 git 接管成畸形工作区），复核不过就丢掉句柄重建
    const existing = held.get(frameId);
    if (
      existing !== undefined &&
      (await isWorktree(existing.path, frameId, existing.repo))
    ) {
      return { ok: true, cwd: existing.path };
    }
    held.delete(frameId);
    // 仓库根：只在声明的 cwd 下问 git（不猜 process.cwd()，避免建到别的仓）
    if (declaredCwd === undefined || declaredCwd.trim() === "") {
      return {
        ok: false,
        feedback:
          'isolate:"worktree" 需要同时声明 cwd（隔离仓库内的起点目录）：引擎在它下面跑 `git rev-parse --show-toplevel`，不猜 process.cwd()（声明问题，不计重试）。',
      };
    }
    const start = declaredCwd;
    const top = await git(
      ["rev-parse", "--show-toplevel"],
      start,
      sourceOf(frameId, start),
    );
    if (top.blocked === true) {
      return {
        ok: false,
        feedback: blockedFeedback("隔离仓库定位（git rev-parse）", top.stdout),
      };
    }
    const repo = top.stdout.trim();
    if (top.code !== 0 || repo === "") {
      const detail = firstLine(top.stderr === "" ? top.stdout : top.stderr);
      return {
        ok: false,
        feedback:
          `isolate:"worktree" 需要一个 git 仓库：` +
          `\`git rev-parse --show-toplevel\`（cwd=${start}）失败` +
          (detail === "" ? "。" : `：${detail}。`) +
          "（环境 / 声明问题，不计重试）",
      };
    }
    const segment = worktreeSegment(frameId);
    const rootDir = join(repo, WORKTREE_DIR);
    const path = resolve(rootDir, segment);
    // 路径收敛断言（防穿越）：最终路径必须在 <repo>/.worktree/ 之内，否则不执行任何 git 写操作
    if (!(path === rootDir || path.startsWith(`${rootDir}${sep}`))) {
      return {
        ok: false,
        feedback:
          `隔离工作区路径越界：leafId=${JSON.stringify(frameId)} → ${path} 不在 ${rootDir} 之内，` +
          "已拒绝执行（leafId 安全化规则见 worktreeSegment；声明问题，不计重试）。",
      };
    }
    const branch = `${WORKTREE_BRANCH_PREFIX}${segment}`;
    // 目录已是同帧的 worktree（例如进程重启后重入）→ 直接复用
    if (await isWorktree(path, frameId, repo)) {
      held.set(frameId, { repo, path, branch });
      return { ok: true, cwd: path };
    }
    const add = await git(
      ["worktree", "add", "-b", branch, path],
      repo,
      sourceOf(frameId, repo),
    );
    if (add.blocked === true) {
      return {
        ok: false,
        feedback: blockedFeedback(
          "建隔离工作区（git worktree add）",
          add.stdout,
        ),
      };
    }
    if (add.code !== 0) {
      // 崩后残留 / 分支已存在（分支在、目录不在）：先 `worktree prune` 清掉指向已消失目录的元数据，
      // 否则下一步 -B 会因「already used by worktree」继续失败（实测）；再用 -B 重建并绑定该分支
      const pruned = await git(
        ["worktree", "prune"],
        repo,
        sourceOf(frameId, repo),
      );
      if (pruned.blocked === true) {
        return {
          ok: false,
          feedback: blockedFeedback(
            "清理 worktree 元数据（git worktree prune）",
            pruned.stdout,
          ),
        };
      }
      const rebind = await git(
        ["worktree", "add", "-B", branch, path],
        repo,
        sourceOf(frameId, repo),
      );
      if (rebind.blocked === true) {
        return {
          ok: false,
          feedback: blockedFeedback(
            "建隔离工作区（git worktree add -B）",
            rebind.stdout,
          ),
        };
      }
      if (rebind.code !== 0) {
        return {
          ok: false,
          feedback:
            `建隔离工作区失败（路径 ${path} / 分支 ${branch} 冲突或不可建）：` +
            `${firstLine(rebind.stderr === "" ? rebind.stdout : rebind.stderr)}` +
            `（首次失败：${firstLine(add.stderr === "" ? add.stdout : add.stderr)}；prune 后仍失败）`,
        };
      }
    }
    held.set(frameId, { repo, path, branch });
    return { ok: true, cwd: path };
  };

  /**
   * 回收一帧的隔离工作区（D4，**永不 `--force`**）：
   * ① 先查**注册表**（`git worktree list --porcelain`）：不在册 = 已回收干净（幂等，不靠 fs 存在判断）；
   * ② 目录不在但注册残留 → `worktree prune` 清元数据；
   * ③ 目录在 → 先 `git status --porcelain`：**非空（有未提交改动 / 未跟踪产出）一律保留现场**，
   *    给出路径 + 取回提示，并**跳过** `branch -D`（回收不丢产出）；
   * ④ 只有干净工作区才 `worktree remove`，成功后才 `branch -D`（worktree 还在时删其分支必失败）；
   * 任何一步失败都保留现场，并把路径与原因写进注记（不静默）。
   */
  const reclaim = async (frameId: FrameId): Promise<string | undefined> => {
    const h = held.get(frameId);
    if (h === undefined) return undefined; // 未隔离 / 已回收
    const src = sourceOf(frameId, h.repo);
    const failures: string[] = [];
    const target = realPath(h.path);
    // ① 注册表核对（幂等：外部已回收 / 已 prune 过 → 视为干净）
    const listed = await git(["worktree", "list", "--porcelain"], h.repo, src);
    if (listed.blocked === true) {
      failures.push(
        blockedFeedback(
          "查 worktree 注册表（git worktree list）",
          listed.stdout,
        ),
      );
    } else if (listed.code !== 0) {
      failures.push(
        `git worktree list --porcelain 失败：${firstLine(listed.stderr === "" ? listed.stdout : listed.stderr)}`,
      );
    } else {
      const inRegistry = listed.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .some((line) => realPath(line.slice("worktree ".length)) === target);
      if (!inRegistry) {
        // 已不在注册表：回收已完成（可能由外部 / 上一次 prune 完成）
      } else if (!existsSync(h.path)) {
        // 注册残留（崩后残留）但目录已不在：prune 清元数据即可，不动任何工作区内容
        const pruned = await git(["worktree", "prune"], h.repo, src);
        if (pruned.code !== 0) {
          failures.push(
            pruned.blocked === true
              ? blockedFeedback(
                  "清理 worktree 元数据（git worktree prune）",
                  pruned.stdout,
                )
              : `git worktree prune 失败：${firstLine(pruned.stderr === "" ? pruned.stdout : pruned.stderr)}`,
          );
        }
      } else {
        // ③ 脏树取舍：非空即保留现场（不删文件、不删分支），并给取回提示
        const status = await git(["status", "--porcelain"], h.path, src);
        if (status.blocked === true) {
          failures.push(
            blockedFeedback("查隔离工作区状态（git status）", status.stdout),
          );
        } else if (status.code !== 0) {
          failures.push(
            `git status --porcelain 失败：${firstLine(status.stderr === "" ? status.stdout : status.stderr)}`,
          );
        } else if (status.stdout.trim() !== "") {
          const dirty = status.stdout.trim().split("\n").length;
          failures.push(
            `工作区有未提交改动（${dirty} 处）：按「不丢产出」策略**不删除**（回收永不 --force），` +
              `现场保留在 ${h.path}；如需保留产出，请先自行提交 / 复制到主树，再手动回收` +
              `（git worktree remove ${h.path} 与 git branch -D ${h.branch}）`,
          );
        } else {
          // ④ 干净工作区才 remove；失败（锁定等）同样保留现场
          const remove = await git(["worktree", "remove", h.path], h.repo, src);
          if (remove.code !== 0) {
            failures.push(
              remove.blocked === true
                ? blockedFeedback(
                    "回收隔离工作区（git worktree remove）",
                    remove.stdout,
                  )
                : `git worktree remove 被拒（被锁定等，现场保留）：${firstLine(remove.stderr === "" ? remove.stdout : remove.stderr)}`,
            );
          }
        }
      }
    }
    // ⑤ 分支：上面全成功才删；分支已不在 = 已回收干净（幂等，不靠本地化报错文本判断）
    if (failures.length === 0) {
      const branches = await git(["branch", "--list", h.branch], h.repo, src);
      if (branches.blocked === true) {
        failures.push(
          blockedFeedback("查隔离分支（git branch --list）", branches.stdout),
        );
      } else if (branches.code !== 0) {
        failures.push(
          `git branch --list 失败：${firstLine(branches.stderr === "" ? branches.stdout : branches.stderr)}`,
        );
      } else if (branches.stdout.trim() !== "") {
        const del = await git(["branch", "-D", h.branch], h.repo, src);
        if (del.code !== 0) {
          failures.push(
            del.blocked === true
              ? blockedFeedback("删除隔离分支（git branch -D）", del.stdout)
              : `git branch -D 失败：${firstLine(del.stderr === "" ? del.stdout : del.stderr)}`,
          );
        }
      }
    }
    if (failures.length === 0) {
      held.delete(frameId);
      return undefined;
    }
    // 回收失败：保留现场（句柄不删，路径写进注记 → 事件流 / stop 返回 / 告警三处可见）
    return `隔离 worktree 回收失败（现场保留在 ${h.path}，分支 ${h.branch}）：${failures.join("；")}`;
  };

  /** 批量回收（插件卸载等收尾路径的 best-effort）：逐帧同语义，失败只收集注记不抛 */
  const reclaimAll = async (): Promise<string[]> => {
    const notices: string[] = [];
    for (const frameId of [...held.keys()]) {
      try {
        const notice = await reclaim(frameId);
        if (notice !== undefined) notices.push(notice);
      } catch (err) {
        notices.push(`隔离 worktree 回收异常（帧 ${frameId}）：${String(err)}`);
      }
    }
    return notices;
  };

  return { ensure, reclaim, reclaimAll };
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
  // 叶子执行后端（① 发起 / ② 模型与计量）：宿主面**惰性**解析（执行期按名重试）+ 缺面 fail-closed
  const runShell = makeRunCommand(config?.commandTimeoutMs ?? 30_000);
  // 命令复查器（执行期检查点）：executor 命令后端与 mechanical 验收共用同一实例
  // （惰性 ctx.get("guard")；未挂载 / 抛错 → 放行 + 各告警一次，见 makeCommandGuard）
  const checkCommand = makeCommandGuard(ctx, warn);
  // 隔离器（叶子声明 isolate:"worktree"）：建 / 复用在 executor 适配器里，回收走引擎终态钩子
  // （stop / join / 重试耗尽 → done / failed），与命令复查共用同一 checkCommand 实例
  const worktrees = makeWorktreeIsolator({ checkCommand, warn });
  /**
   * 验收命令（mechanical 级）：执行前复查（D1②）——命中即**不执行**，回执原文随
   * `blocked` 标志交给裁决层当失败原因（不按退出码措辞，避免误导）。
   */
  const runCommand = async (
    cmd: string,
    frame?: FrameId,
  ): Promise<{ code: number; output?: string; blocked?: boolean }> => {
    const receipt = checkCommand(
      cmd,
      `task-engine{acceptance} ${frame ?? "?"}`,
    );
    if (receipt !== null) return { code: 1, output: receipt, blocked: true };
    return runShell(cmd);
  };
  // 语义面（audit / entail）：**按次构造**——hook 闭包捕获本次工具执行的 exec（父 agent 与
  // 执行期服务解析都从它取）。宿主 `SubagentStartRequest.parent` 是必填（宿主无条件解引用
  // `parent.session`），故 requireParent=true：拿不到 agent 时 fail-closed 而不是省略 parent。
  const semantic = config?.semantic ?? {};
  /** 执行期服务解析：工具执行 ctx 优先 → 回退插件 ctx（apply 期服务 fiber 常未激活） */
  const serviceResolver =
    (exec: unknown) =>
    <T>(name: string): T | undefined =>
      readService<T>(exec, name) ?? readService<T>(ctx, name);
  const semanticHooksFor = (
    exec: unknown,
  ): {
    audit?: (req: AuditRequest) => Promise<AuditVerdict>;
    entail?: EntailHook;
  } => {
    const resolve = <T>(name: string): T | undefined =>
      readService<T>(exec, name) ?? readService<T>(ctx, name);
    const parent = (exec as { agent?: unknown } | undefined)?.agent;
    const timeoutMs = semantic.timeoutMs ?? 120_000;
    const audit: (req: AuditRequest) => Promise<AuditVerdict> = async (req) => {
      const out = await runChildOnce(
        { resolve, agent: parent, warn },
        {
          label: `task:audit:${req.frame}`,
          prompt: auditPrompt(req),
          requireParent: true,
          timeoutMs,
          ...(req.outputSchema === undefined
            ? {}
            : { outputSchema: verdictEnvelope("pass", req.outputSchema) }),
        },
      );
      if (!out.ok) {
        return { pass: false, feedback: `audit run 不可用：${out.feedback}` };
      }
      const verdict = readVerdictValue(out);
      if (verdict === undefined) {
        return {
          pass: false,
          feedback: `audit run 输出不可解析（需 {"pass": boolean, "feedback": string}）：${truncateEvidence(out.text).slice(0, 300)}`,
        };
      }
      return {
        pass: verdict["pass"] === true,
        ...(typeof verdict["feedback"] === "string"
          ? { feedback: String(verdict["feedback"]).slice(0, 500) }
          : {}),
        ...(verdict["structured"] === undefined
          ? {}
          : { structured: verdict["structured"] }),
      };
    };
    const entail: EntailHook = async (parentFrame, children) => {
      const out = await runChildOnce(
        { resolve, agent: parent, warn },
        {
          label: `task:entail:${parentFrame.id}`,
          prompt: entailPrompt(
            {
              id: parentFrame.id,
              title: parentFrame.title,
              spec: parentFrame.spec,
              acceptance: parentFrame.acceptance,
            },
            children,
          ),
          requireParent: true,
          timeoutMs,
          outputSchema: verdictEnvelope("ok"),
        },
      );
      if (!out.ok) {
        // 裁决 run 跑不起来 ≠ 模型判出不成立：跳过该门（不烧重试预算），并在告警里留痕
        warn(`entail run 不可用，已跳过语义蕴含门：${out.feedback}`);
        return {
          ok: true,
          skipped: true,
          feedback: `entail run 不可用，已跳过语义蕴含门：${out.feedback}`,
        };
      }
      const verdict = readVerdictValue(out);
      if (verdict === undefined) {
        warn("entail run 输出不可解析，已跳过语义蕴含门");
        return {
          ok: true,
          skipped: true,
          feedback: `entail run 输出不可解析，已跳过语义蕴含门：${truncateEvidence(out.text).slice(0, 300)}`,
        };
      }
      return {
        ok: verdict["ok"] === true,
        feedback:
          typeof verdict["feedback"] === "string"
            ? String(verdict["feedback"]).slice(0, 500)
            : verdict["ok"] === true
              ? "语义蕴含成立"
              : "子项验收不能推出父验收",
      };
    };
    return {
      ...(semantic.audit === false ? {} : { audit }),
      ...(semantic.entail === false ? {} : { entail }),
    };
  };
  const toolCtx: ToolExecuteCtx = {
    makeSemanticHooks: (exec: unknown) => semanticHooksFor(exec),
    makeApprove: approveVia,
    makeExecutor: (exec) => {
      const agent = (exec as { agent?: unknown } | undefined)?.agent;
      return makeExecutor({
        resolve: serviceResolver(exec),
        runShell,
        checkCommand,
        isolator: worktrees,
        ...(agent === undefined ? {} : { agent }),
        warn,
      });
    },
  };

  let engine: TaskEngine;
  try {
    engine = new TaskEngine({
      root: normalizeRoot(config?.root),
      runCommand,
      gate: {
        ...(config?.maxConcurrent === undefined
          ? {}
          : { maxConcurrent: config.maxConcurrent }),
      },
      snapshotPath: config?.snapshotPath,
      // 终态钩子（隔离回收）：帧 done（stop / join 续体）或 failed（重试耗尽）时触发；
      // 注记（含回收失败保留现场的路径）进事件流与 stop 返回，并在此另行告警（不静默）
      onFrameTerminal: async (frameId, status) => {
        const notice = await worktrees.reclaim(frameId);
        if (notice !== undefined)
          warn(`${notice}（帧 ${frameId} 已 ${status}）`);
        return notice;
      },
      // 语义 hook 走**按次注入**（tools 层用本次 exec 构造）；实例级不注入，避免跨会话串线
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

  // cordis 生命周期：unload 时写最终快照 + best-effort 回收在册隔离工作区
  // （未 stop / 未失败的在途帧不会走终态钩子，这里是兜底；不带 --force，脏树天然被拒 → 保留现场）
  const ctxAny = ctx as { effect?: (fn: () => unknown) => unknown };
  ctxAny.effect?.(() => async () => {
    await engine.writeSnapshot();
    const notices = await worktrees.reclaimAll();
    for (const notice of notices) warn(`${notice}（插件卸载收尾）`);
  });
}

// 只读查询面 re-export（BACKLOG C1）：供 TUI /task 等接线方从包入口消费引擎只读子集
export { TaskEngine, type TaskEngineSnapshot } from "./engine.ts";
