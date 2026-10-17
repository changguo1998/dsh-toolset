/**
 * auto-approve 插件入口（DSH bundle 接入面）。
 *
 * 角色：审批链上的**自动裁定者**。挂在两个点，共用同一判定核心：
 * 1. `approval/request` 应答者（`answerer.ts`）——命中即 `allowed-once` / `rejected`，未命中调
 *    `next()` 交下一位（TUI 人工面板）; 覆盖全部 ask 来源（沙箱升级 / 策略式 ask / 插件直连）;
 * 2. `tools/pre-execute` 监听器（`gate.ts`）——记录 `callId → 参数`、执行拒绝名单，**不提前放行**。
 *
 * 判定阶梯（第一个命中者胜出，见设计文档「决策 1 优先级」）：
 * 拒绝名单 → 指纹 → 只读类 → 路径白名单 → 命令白名单 → 沙箱升级白名单 → LLM 灰区审查 → 人工面板。
 * 缺省（R6）: `enabled: true` + `mode: "rules"` + 四张名单全空 → 只在只读类与指纹上生效、零 token。
 *
 * 边界（R3）: **不调用** `ctx.get("guard")` —— 危险命令与敏感路径归 `security-guard`（它在守卫层
 * 有最终否决权）; 本插件的拒绝名单只表达「不自动批」。**自动放行不等于沙箱放行**。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CallTable } from "./calls.ts";
import { resolveConfig, reviewActive, type Config, type ResolvedConfig } from "./config.ts";
import { createAudit, type MemoryLike, type SessionPathsLike } from "./audit.ts";
import { createAnswerer } from "./answerer.ts";
import { createGate, identityOf } from "./gate.ts";
import { FingerprintStore } from "./fingerprint.ts";
import { registerCommand } from "./command.ts";
import { createReviewer, type LlmLike, type ReviewInstructionItem } from "./review.ts";
import { createRuntime, type Runtime } from "./runtime.ts";
import { SessionObserver, type SessionEventLike, type SessionLike } from "./sessions.ts";
import {
  readService,
  type ApprovalAnswerer,
  type ApprovalRequestLike,
  type AuditHealth,
  type AutoApproveMode,
  type AutoApproveService,
  type AutoApproveStatus,
  type PluginHost,
  type PreExecuteExecution,
} from "./types.ts";

export const name = "auto-approve";

/**
 * 硬依赖：审批服务（应答者挂载点）与工具运行时（`tools/pre-execute` 水位线）。
 * `commands` / `llm` / `sessionPaths` / `memory` 都是**可选面**（经 `readService` 受保护读取）。
 */
export const inject = ["approval", "tools"];

/** 提供的服务名（只读查询面 + 运行态模式切换）。 */
export const provide = ["autoApprove"];

/** 配置契约别名（DSH bundle §0 的 `Config`；无运行时 schema，宿主原样透传）。 */
export type { Config };

/** 会话事件订阅名。 */
const SESSION_EVENT = "session/event";
const PRE_EXECUTE_EVENT = "tools/pre-execute";
const APPROVAL_EVENT = "approval/request";

/** 项目规则文件（与宿主同名的项目指令文件）。 */
const INSTRUCTION_FILE = "AGENTS.md";
/** 向上查找的项目规则文件数上限（cwd → 根）。 */
const INSTRUCTION_DEPTH = 4;

/** 项目规则的读取缓存（按 cwd）。 */
export function createInstructionReader(
  readFile: (path: string) => string | undefined = defaultRead,
  depth = INSTRUCTION_DEPTH,
): (cwd: string) => readonly ReviewInstructionItem[] {
  const cache = new Map<string, readonly ReviewInstructionItem[]>();
  return (cwd: string) => {
    const hit = cache.get(cwd);
    if (hit !== undefined) return hit;
    const out: ReviewInstructionItem[] = [];
    const dirs: string[] = [];
    let current = cwd;
    for (let i = 0; i < depth; i += 1) {
      dirs.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // 从外层到内层（内层更具体，排在后面）
    for (const dir of dirs.reverse()) {
      const path = join(dir, INSTRUCTION_FILE);
      const text = readFile(path);
      if (text === undefined || text.trim() === "") continue;
      out.push({ source: path, text });
    }
    cache.set(cwd, out);
    return out;
  };
}

function defaultRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 插件返回的句柄（宿主在卸载时调用 dispose）。 */
export interface AutoApproveBundle {
  dispose(): void;
  /** 只读查询面（与 `provide("autoApprove")` 同一份）。 */
  service: AutoApproveService;
  /** 运行态（测试与诊断用）。 */
  runtime: Runtime;
}

/** bundle 入口。 */
export function apply(ctx: PluginHost, config?: Config): () => void {
  const resolved = resolveConfig(config);
  const warn = createWarner(ctx);
  for (const message of resolved.diagnostics) warn(message);
  const bundle = createBundle(ctx, resolved, warn);
  // 防御式服务面挂载（与 security-guard 同款）：宿主不消费 `provide` 导出时仍可经 ctx.get 取到
  ctx.provide?.("autoApprove", bundle.service);
  recordApply(ctx, resolved, bundle.service);
  return () => {
    bundle.dispose();
  };
}

/** 创建完整运行时（含服务面）；`apply` 与测试共用。 */
export function createBundle(
  ctx: PluginHost,
  resolved: ResolvedConfig,
  warn: (message: string) => void,
): AutoApproveBundle {
  const calls = new CallTable(resolved.callTableCapacity);
  const sessions = new SessionObserver();
  const fingerprints = new FingerprintStore(resolved.fingerprintCapacity);
  const sessionPaths = readService<SessionPathsLike>(ctx, "sessionPaths");
  const memory = readService<MemoryLike>(ctx, "memory");
  const audit = createAudit({
    sessionPaths,
    memory,
    projectEnabled: resolved.audit.project,
    maxBytes: resolved.audit.maxBytes,
    warn,
    projectOf: (sessionId) => sessions.cwdOf(sessionId),
  });
  const reviewer = createReviewer({
    llm: readService<LlmLike>(ctx, "llm"),
    config: resolved,
    route: (sessionId) => lastRoute(ctx, sessions, sessionId),
  });
  const runtime = createRuntime({
    config: resolved,
    context: { config: resolved, fingerprints, audit, reviewer, warn },
    calls,
    sessions,
    audit,
    warn,
  });
  const instructions = createInstructionReader();
  const answerer = createAnswerer(runtime, {
    instructionsFor: instructions,
    sessionOf: (sessionId) => sessionOf(ctx, sessionId),
  });

  const detach: Array<() => void> = [];
  bind(detach, ctx.on(SESSION_EVENT, (...args: unknown[]) => {
    const [session, event] = args as [SessionLike | undefined, SessionEventLike | undefined];
    const sessionId = typeof session?.id === "string" ? session.id : undefined;
    if (sessionId === undefined || event === undefined) return;
    sessions.setCwd(sessionId, session?.header?.cwd);
    sessions.observe(sessionId, event);
  }));
  bind(detach, ctx.on(PRE_EXECUTE_EVENT, (...args: unknown[]) => {
    const [exec, next] = args as [
      PreExecuteExecution,
      () => unknown,
    ];
    return createGate(runtime)(exec, next as never);
  }));
  // 应答者按注册顺序排在外层：先注册（插件装载顺序）→ 未命中调 next() 落 TUI 面板
  bind(detach, ctx.on(APPROVAL_EVENT, (...args: unknown[]) => {
    const [req, next] = args as [ApprovalRequestLike, () => Promise<never>];
    return answerer(req, next as never);
  }));
  const commandOff = registerCommand(ctx, {
    config: resolved,
    service: () => service,
    clearFingerprints: () => {
      const before = fingerprints.size();
      fingerprints.clear();
      return before;
    },
  });
  if (commandOff !== undefined) detach.push(commandOff);

  const service: AutoApproveService = {
    status(): AutoApproveStatus {
      return statusOf(resolved, runtime, audit.health(), fingerprints);
    },
    recent(n = 10) {
      return audit.recent(n);
    },
    fingerprints() {
      return fingerprints.list();
    },
    setMode(mode: AutoApproveMode) {
      runtime.mode = mode;
    },
  };

  return {
    service,
    runtime,
    dispose() {
      for (const off of detach.splice(0)) {
        try {
          off();
        } catch (error) {
          warn(`撤销监听器失败：${String(error)}`);
        }
      }
      runtime.dispose();
    },
  };
}

/** 监听器返回值归一为 disposer。 */
function bind(target: Array<() => void>, handle: unknown): void {
  if (typeof handle === "function") target.push(handle as () => void);
}

/** 启动日志（一次）。 */
function recordApply(
  ctx: PluginHost,
  resolved: ResolvedConfig,
  service: AutoApproveService,
): void {
  const status = service.status();
  const message =
    `auto-approve mounted: mode=${resolved.mode}` +
    ` readonly=${status.readonlyTools} allow=${status.allowRules}` +
    ` deny=${status.denyRules} upgrade=${status.upgradeRules}` +
    ` llm=${status.llmEnabled ? status.llmRoute : "off"}` +
    ` audit.session=${status.audit.sessionWritable ? "ok" : "degraded"}` +
    ` audit.project=${status.audit.projectWritable ? "ok" : "skipped"}`;
  try {
    ctx.logger?.(name).info(message);
  } catch {
    process.stderr.write(`[${name}] ${message}\n`);
  }
}

function createWarner(ctx: PluginHost): (message: string) => void {
  let logger: { info(message: string): void } | undefined;
  try {
    logger = ctx.logger?.(name);
  } catch {
    logger = undefined;
  }
  return (message: string) => {
    const text = `[${name}] warn: ${message}`;
    try {
      if (logger !== undefined) logger.info(text);
      else process.stderr.write(`${text}\n`);
    } catch {
      process.stderr.write(`${text}\n`);
    }
  };
}

/** 最近一次请求的模型路由：先查事件观测器，再扫 live 会话日志（缺省跟随当前会话模型）。 */
export function lastRoute(
  ctx: PluginHost,
  sessions: SessionObserver,
  sessionId?: string,
): { provider: string; model: string } | undefined {
  const target = sessionId ?? activeSessionId(ctx);
  if (target === undefined) return undefined;
  const observed = sessions.routeOf(target);
  if (observed !== undefined) return observed;
  const live = sessionOf(ctx, target);
  if (live?.events === undefined) return undefined;
  for (let index = live.events.length - 1; index >= 0; index -= 1) {
    const event = live.events[index];
    if (event?.type !== "request/header") continue;
    const header = (event.data as { header?: { config?: Record<string, unknown> } } | undefined)
      ?.header?.config;
    const provider = header?.["provider"];
    const model = header?.["model"];
    if (typeof provider === "string" && typeof model === "string") {
      return { provider, model };
    }
  }
  return undefined;
}

/** 当前会话 id：优先 `agents` 注册表里带会话的代理（结构面，不保证宿主有 `list`）。 */
export function activeSessionId(ctx: PluginHost): string | undefined {
  const agents = readService<{ list?(): readonly unknown[] }>(ctx, "agents");
  const list = agents?.list?.();
  if (Array.isArray(list)) {
    for (const agent of list) {
      const identity = identityOf(agent);
      if (identity.sessionId !== undefined) return identity.sessionId;
    }
  }
  return undefined;
}

/** 取会话对象（历史过滤用）。 */
function sessionOf(ctx: PluginHost, sessionId: string): SessionLike | undefined {
  const sessions = readService<{ get?(id: string): unknown }>(ctx, "sessions");
  const value = sessions?.get?.(sessionId);
  return value !== null && typeof value === "object"
    ? (value as SessionLike)
    : undefined;
}

/** 状态快照。 */
export function statusOf(
  config: ResolvedConfig,
  runtime: Runtime,
  audit: AuditHealth,
  fingerprints: FingerprintStore,
): AutoApproveStatus {
  const sessionId = undefined;
  return {
    enabled: runtime.mode !== "off",
    mode: runtime.mode,
    configuredMode: config.mode,
    llmEnabled: reviewActive({ ...config, mode: runtime.mode }),
    llmRoute: routeLabel(config),
    readonlyTools: config.readonlyTools.length,
    allowRules: config.allowCommands.length + config.allowPaths.length,
    denyRules: config.denyTools.length + config.denyEscalationTo.length,
    upgradeRules: config.escalationRules.length,
    fingerprints: fingerprints.size(sessionId),
    audit,
  };
}

/** LLM 路由标签（`session` = 跟随当前会话模型）。 */
function routeLabel(config: ResolvedConfig): string {
  if (config.review.provider !== undefined && config.review.model !== undefined) {
    return `${config.review.provider}/${config.review.model}`;
  }
  return "session";
}

export type { ApprovalAnswerer, AutoApproveMode, AutoApproveService, AutoApproveStatus };
