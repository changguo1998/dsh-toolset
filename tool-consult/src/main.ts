/**
 * main.ts — tool-consult 的宿主接线：按代理注册咨询工具、维护替换式 allow 遮罩、
 * 拦截被遮罩工具的调用、在 turn/end 收敛 turn 档授权。
 *
 * 宿主面全部用结构类型（不 import @deepseek-ai/*），契约与证据见
 * `docs/implementation/2026-10-22-tool-consult.md`（R2 / R3 / R4 / D3 / D4）。
 * 关键约束：
 * - `tools.restrict()` 只能从 agent 作用域调用，故遮罩在 `agent/created` 里对 `agent.ctx` 应用；
 * - 同一代理只保留**一条**活动遮罩：每次先 dispose 旧遮罩再追加新名单；
 * - 名单每次现算「初始集 ∪ 已授权 ∩ 当前可限制名」，交集为空立即回退为不遮；
 * - 咨询工具注册进代理自身层，不受遮罩影响（R2 的自身层豁免）。
 */

import {
  expandInitialTools,
  isSubagentSession,
  resolveConfig,
  type Config,
  type ResolvedConfig,
  type RevealScope,
} from "./config.ts";
import {
  classifyRestrictError,
  classifyToolRegisterError,
  decideDegradation,
  decideMissingService,
} from "./degrade.ts";
import { createMatcher, type Matcher } from "./matcher.ts";
import { AgentGrants } from "./state.ts";
import { CONSULT_TOOL_NAME, createConsultTool, type ConsultRuntime } from "./tool.ts";

export { type Config };
export const name = "tool-consult";

/** 硬依赖：工具注册表（遮罩 / 注册 / schemas）与代理注册表（已存在代理补挂）。 */
export const inject = ["tools", "agents"];

/** 宿主工具 schema 的最小形态。 */
interface HostToolSchema {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** 宿主工具定义（注册用）。 */
interface HostToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>;
  };
}

/** 宿主工具执行对象的最小形态（`tools/pre-execute` 与 `tools/result` 共用）。 */
interface HostToolExecution {
  name?: string;
  agent?: HostAgent;
}

/** 宿主工具服务的最小面。 */
interface HostTools {
  register?: (definition: HostToolDefinition) => () => void;
  restrict?: (filter: { allow?: string[]; deny?: string[] }) => () => void;
  schemas?: (scope?: unknown) => HostToolSchema[];
}

/** 宿主会话头的最小面。 */
interface HostSession {
  id: string;
  header?: { origin?: string; delegationDepth?: number };
}

/** 宿主代理的最小面。 */
interface HostAgent {
  id: string;
  ctx: HostCtx;
  session: HostSession;
}

/** 宿主上下文的最小面（cordis ctx 的结构子集）。 */
interface HostCtx {
  get?: (service: string) => unknown;
  on?: (event: string, callback: (...args: unknown[]) => unknown) => unknown;
  effect?: (callback: () => (() => void) | void) => unknown;
  logger?: (namespace: string) => {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    debug?: (message: string) => void;
  };
  tools?: HostTools;
}

/** 单个代理的运行时状态。 */
interface AgentRuntime {
  id: string;
  agent: HostAgent;
  grants: AgentGrants;
  config: ResolvedConfig;
  matcher: Matcher;
  masked: boolean;
  maskDisposer: (() => void) | undefined;
  consultDisposer: (() => void) | undefined;
  listeners: Array<() => void>;
  currentTurn: number;
  warnedUnmasked: boolean;
  /** 初始可见名（按当前可限制名展开后）。 */
  initialNames: string[];
}

/** 跨 apply 保留的代理状态：配置热重载后仍能按「退休 / 降级」语义迁移。 */
const REGISTRY = new Map<string, AgentRuntime>();

/** 结构面取工具服务。 */
function asTools(value: unknown): HostTools | undefined {
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  return value as HostTools;
}

/** 结构面取代理注册表。 */
function asAgents(value: unknown): { list: () => HostAgent[] } | undefined {
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  const candidate = value as { list?: unknown };
  return typeof candidate.list === "function"
    ? (candidate as { list: () => HostAgent[] })
    : undefined;
}

/** 记录一条日志（宿主 logger 形态差异不影响主流程）。 */
function log(ctx: HostCtx, level: "info" | "warn" | "debug", message: string): void {
  try {
    ctx.logger?.(name)?.[level]?.(message);
  } catch {
    // 日志失败不影响主流程。
  }
}

/** 代理是否应被管理（`applyTo: "roots"` 时跳过子代理）。 */
function shouldManage(config: ResolvedConfig, agent: HostAgent): boolean {
  if (config.applyTo === "all") return true;
  return !isSubagentSession(agent.session?.header);
}

/** 是否在当前可见集（初始集 ∪ 已授权 ∪ 咨询工具自身）。 */
function isVisible(runtime: AgentRuntime, toolName: string): boolean {
  if (toolName === CONSULT_TOOL_NAME) return true;
  if (runtime.initialNames.includes(toolName)) return true;
  return runtime.grants.has(toolName);
}

/** 当前可限制名（全局视图；`schemas()` 不传 scope）。 */
function restrictableNames(tools: HostTools): string[] {
  const schemas = tools.schemas?.() ?? [];
  return schemas.map((schema) => schema.name).filter((toolName) => toolName !== CONSULT_TOOL_NAME);
}

/** 由当前工具面重建检索器。 */
function buildMatcher(tools: HostTools): Matcher {
  const schemas = tools.schemas?.() ?? [];
  return createMatcher(
    schemas.map((schema) => ({
      name: schema.name,
      description: typeof schema.description === "string" ? schema.description : "",
      parameters: schema.parameters,
    })),
  );
}

/** 撤销当前遮罩（幂等）。 */
function disposeMask(runtime: AgentRuntime): void {
  const dispose = runtime.maskDisposer;
  runtime.maskDisposer = undefined;
  runtime.masked = false;
  if (dispose === undefined) return;
  try {
    dispose();
  } catch {
    // 已撤销 / 宿主回收，忽略。
  }
}

/** 拆除一个运行时的全部注册（遮罩 / 代理级监听 / 咨询工具）。 */
function teardownRuntime(runtime: AgentRuntime): void {
  disposeMask(runtime);
  const consult = runtime.consultDisposer;
  runtime.consultDisposer = undefined;
  if (consult !== undefined) {
    try {
      consult();
    } catch {
      // 已回收，忽略。
    }
  }
  for (const dispose of runtime.listeners.splice(0)) {
    try {
      dispose();
    } catch {
      // 已回收，忽略。
    }
  }
}

/** 降级为不遮罩并告警一次。 */
function degradeUnmasked(runtime: AgentRuntime, message: string): void {
  disposeMask(runtime);
  if (runtime.warnedUnmasked) return;
  runtime.warnedUnmasked = true;
  log(runtime.agent.ctx, "warn", message);
}

/** 揭示 / 收回后重算并替换遮罩（替换式：先撤旧再追加）。 */
function applyMask(runtime: AgentRuntime, tools: HostTools): void {
  const restrictable = new Set(restrictableNames(tools));
  runtime.initialNames = expandInitialTools(runtime.config.initialTools, [...restrictable]).names;

  if (runtime.config.maskMode === "off") {
    disposeMask(runtime);
    return;
  }

  let allow: string[];
  if (runtime.config.maskMode === "denylist") {
    const hidden = new Set(runtime.initialNames);
    allow = [...restrictable].filter((toolName) => !hidden.has(toolName));
  } else {
    const granted = runtime.grants.allowedNames().filter((toolName) => restrictable.has(toolName));
    allow = [...new Set([...runtime.initialNames, ...granted])].sort((a, b) => a.localeCompare(b));
  }

  if (allow.length === 0) {
    // 空交集：回退不遮，避免把所有工具藏光（D4）。
    degradeUnmasked(runtime, decideDegradation("empty-intersection").message);
    return;
  }

  const agentTools = asTools(runtime.agent.ctx.tools);
  if (agentTools?.restrict === undefined) {
    degradeUnmasked(runtime, decideDegradation("no-scope").message);
    return;
  }

  disposeMask(runtime);
  try {
    runtime.maskDisposer = agentTools.restrict({ allow });
    runtime.masked = true;
  } catch (error: unknown) {
    const failure = classifyRestrictError(error);
    const decision = decideDegradation(failure);
    if (decision.action === "retry-filtered") {
      const known = new Set(restrictableNames(tools));
      const filtered = allow.filter((toolName) => known.has(toolName));
      if (filtered.length > 0) {
        try {
          runtime.maskDisposer = agentTools.restrict({ allow: filtered });
          runtime.masked = true;
          return;
        } catch {
          // 落到下面的 unmasked。
        }
      }
    }
    degradeUnmasked(runtime, decision.message);
  }
}

/** 授权上限（按运行时配置取）。 */
function limitsOf(runtime: AgentRuntime): { maxRevealed: number; ttlTurns: number; maxPinned: number } {
  return {
    maxRevealed: runtime.config.maxRevealed,
    ttlTurns: runtime.config.ttlTurns,
    maxPinned: runtime.config.maxPinned,
  };
}

/** 咨询工具的运行时 API（闭包到单个代理）。 */
function consultRuntime(runtime: AgentRuntime, tools: HostTools): ConsultRuntime {
  return {
    matcher: runtime.matcher,
    config: runtime.config,
    grants: runtime.grants,
    currentTurn: () => runtime.currentTurn,
    isVisible: (toolName) => isVisible(runtime, toolName),
    grantedNames: () => runtime.grants.allowedNames(),
    reveal: (names, scope, pin) => {
      const outcomes = names.map((toolName) => ({
        name: toolName,
        result: runtime.grants.grant(toolName, scope, pin, runtime.currentTurn, limitsOf(runtime)),
      }));
      if (outcomes.some((outcome) => outcome.result.granted)) applyMask(runtime, tools);
      return outcomes;
    },
  };
}

/** 被遮罩工具被调用时的可行动文案（D3）。 */
function denyReason(toolName: string): string {
  return `工具 "${toolName}" 当前不可见（被 tool-consult 管理）。`
    + `调用 consult_tools（names: ["${toolName}"]）揭示后即可调用；`
    + `也可以 query 描述用途来检索。`;
}

/** 把咨询工具注册进代理自身层（自身层豁免遮罩）。 */
function attachConsultTool(runtime: AgentRuntime, tools: HostTools): void {
  if (runtime.consultDisposer !== undefined) return;
  const agentTools = asTools(runtime.agent.ctx.tools);
  if (agentTools?.register === undefined) {
    log(runtime.agent.ctx, "warn", "agent.ctx 缺少 tools.register，咨询工具未注册。");
    return;
  }
  try {
    runtime.consultDisposer = agentTools.register(
      createConsultTool(consultRuntime(runtime, tools)) as unknown as HostToolDefinition,
    );
  } catch (error: unknown) {
    const kind = classifyToolRegisterError(error);
    log(
      runtime.agent.ctx,
      "warn",
      kind === "duplicate"
        ? "咨询工具名已被占用，本代理不注册咨询工具（遮罩照常）。"
        : `咨询工具注册失败：${String(error)}`,
    );
  }
}

/** 注册代理级监听器（重复调用先撤旧的）。 */
function attachListeners(runtime: AgentRuntime): void {
  for (const dispose of runtime.listeners.splice(0)) {
    try {
      dispose();
    } catch {
      // 已回收，忽略。
    }
  }
  const on = runtime.agent.ctx.on;
  if (on === undefined) return;

  // 被遮罩工具被调用：拦在审批之前，给可行动文案（D3）。
  const deny = on("tools/pre-execute", (...args: unknown[]) => {
    const exec = args[0] as HostToolExecution | undefined;
    const next = args[1] as (() => unknown) | undefined;
    const toolName = exec?.name;
    if (typeof toolName !== "string" || !runtime.masked || isVisible(runtime, toolName)) {
      return typeof next === "function" ? next() : { kind: "allow" };
    }
    return { kind: "deny", reason: denyReason(toolName) };
  });
  if (typeof deny === "function") runtime.listeners.push(deny as () => void);
}

/** 创建或复用代理运行时，并完成注册 / 遮罩。 */
function setupAgent(
  agent: HostAgent | undefined,
  ctx: HostCtx,
  tools: HostTools,
  config: ResolvedConfig,
  owned: Set<AgentRuntime>,
): void {
  if (agent === undefined || typeof agent.id !== "string" || agent.ctx === undefined) return;
  if (!shouldManage(config, agent)) return;

  const existing = REGISTRY.get(agent.id);
  const runtime: AgentRuntime = existing ?? {
    id: agent.id,
    agent,
    grants: new AgentGrants(config.revealScope),
    config,
    matcher: buildMatcher(tools),
    masked: false,
    maskDisposer: undefined,
    consultDisposer: undefined,
    listeners: [],
    currentTurn: 0,
    warnedUnmasked: false,
    initialNames: [],
  };

  if (existing !== undefined) {
    // 配置热重载：保留既有授权，按新缺省档迁移（session → turn 待回合末降级）。
    runtime.config = config;
    runtime.matcher = buildMatcher(tools);
    runtime.agent = agent;
    runtime.grants.switchScope(config.revealScope);
    runtime.consultDisposer = undefined;
  }

  REGISTRY.set(agent.id, runtime);
  owned.add(runtime);
  attachListeners(runtime);
  attachConsultTool(runtime, tools);
  applyMask(runtime, tools);
  log(ctx, "info", `tool-consult: agent ${agent.id} 已就绪（${runtime.grants.mode()} 档）。`);
}

/** 查找会话对应的运行时。 */
function runtimeOf(sessionId: unknown): AgentRuntime | undefined {
  return typeof sessionId === "string" ? REGISTRY.get(sessionId) : undefined;
}

/** 插件 apply 面。 */
export function apply(ctx: HostCtx, rawConfig?: Config): void {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) return;

  const tools = asTools(ctx.get?.("tools") ?? ctx.tools);
  const agents = asAgents(ctx.get?.("agents"));
  if (tools === undefined || agents === undefined) {
    log(ctx, "warn", decideMissingService().message);
    return;
  }

  const owned = new Set<AgentRuntime>();

  // 全局监听（随插件 fiber 回收）。
  const created = ctx.on?.("agent/created", (...args: unknown[]) => {
    const payload = args[0] as { agent?: HostAgent } | undefined;
    setupAgent(payload?.agent, ctx, tools, config, owned);
  });
  if (typeof created === "function") {
    // 由插件 fiber 持有；这里只保留引用防止被回收。
    void created;
  }

  ctx.on?.("agent/disposed", (...args: unknown[]) => {
    const payload = args[0] as { agent?: { id?: string } } | undefined;
    const id = payload?.agent?.id;
    if (typeof id !== "string") return;
    const runtime = REGISTRY.get(id);
    if (runtime === undefined) return;
    teardownRuntime(runtime);
    REGISTRY.delete(id);
    owned.delete(runtime);
  });

  ctx.on?.("tools/change", () => {
    const matcher = buildMatcher(tools);
    for (const runtime of owned) {
      runtime.matcher = matcher;
      applyMask(runtime, tools);
    }
  });

  ctx.on?.("tools/result", (...args: unknown[]) => {
    const exec = args[0] as HostToolExecution | undefined;
    const runtime = runtimeOf(exec?.agent?.id);
    if (runtime === undefined || typeof exec?.name !== "string") return;
    runtime.grants.noteUse(exec.name, runtime.currentTurn);
  });

  ctx.on?.("session/event", (...args: unknown[]) => {
    const event = args[1] as { type?: string; data?: { turn?: number } } | undefined;
    const session = args[0] as { id?: string } | undefined;
    const runtime = runtimeOf(session?.id);
    if (runtime === undefined || event?.type === undefined) return;
    if (event.type === "turn/start") {
      if (typeof event.data?.turn === "number") runtime.currentTurn = event.data.turn;
      return;
    }
    if (event.type !== "turn/end") return;
    const turn = typeof event.data?.turn === "number" ? event.data.turn : runtime.currentTurn;
    const result = runtime.grants.converge(turn, limitsOf(runtime));
    if (result.changed) applyMask(runtime, tools);
  });

  // 插件卸载：撤销本实例注册的遮罩与代理级监听（agent.ctx 上的 Effect 不随插件回收）。
  ctx.effect?.(() => () => {
    for (const runtime of [...owned]) {
      teardownRuntime(runtime);
      REGISTRY.delete(runtime.id);
    }
    owned.clear();
  });

  // 热挂载：对已存在的代理补做。
  for (const agent of agents.list()) setupAgent(agent, ctx, tools, config, owned);
}
