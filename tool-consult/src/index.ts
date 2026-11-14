/**
 * index.ts — tool-consult 的宿主接线。
 *
 * 机制（见 `docs/archived/2026-11-13-tool-reveal-redesign.md`）:
 * - 首请求起常驻全量工具声明; 初始集保持宿主完整定义, 其余非初始、非条件工具在
 *   agent 作用域 shadow 成短定义, 完整说明与 schema 收进 tool-surface catalog。
 * - 白名单外的条件工具用一次静态 `restrict({ deny })` 从模型面移除; 白名单内的
 *   条件工具保持宿主原样。
 * - 揭示只写会话授权集合并按工具登记 pinNotes.hold; 不调用 register / restrict,
 *   不改变工具声明。
 * - 未揭示的受管工具由 `tools/pre-execute` 拒绝。
 *
 * 自检失败、静态 deny 失败或 `schemas(agent)` 残留时整体/本代理不接管, 工具面
 * 回退宿主默认。宿主面全部用结构类型（不 import @deepseek-ai/*）。
 */

import {
  isWrappedDefinition,
  listSurface,
  lookupSurface,
  wrapToolDefinition,
} from "@dsh-toolset/tool-surface";
import {
  expandInitialTools,
  isSubagentSession,
  resolveConfig,
  type Config,
  type ResolvedConfig,
} from "./config.ts";
import {
  classifyToolRegisterError,
  decideCatalogSelfCheck,
  decideDenyFailure,
  decideDenyResidual,
  decideMissingService,
} from "./degrade.ts";
import { createMatcher, type Matcher } from "./matcher.ts";
import { RevealSet } from "./state.ts";
import {
  CONSULT_TOOL_NAME,
  createConsultTool,
  type ConsultRuntime,
} from "./tool.ts";

export { type Config };
export const name = "tool-consult";

/** 硬依赖：工具注册表与代理注册表。 */
export const inject = ["tools", "agents"];

/** 未揭示受管工具的错误码。 */
const NOT_REVEALED_CODE = "TOOL_NOT_REVEALED";

/** 宿主工具 schema 的最小形态。 */
interface HostToolSchema {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** 宿主工具定义（注册与枚举共用）。 */
interface HostToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec?: unknown) => Promise<unknown> | unknown;
  output: {
    schema: Record<string, unknown>;
    render: (
      args: unknown,
      value: unknown,
    ) => Array<{ type: string; text: string }>;
  };
  timeoutMs?: number;
  deferLoading?: boolean;
}

/** 宿主工具执行对象的最小形态。 */
interface HostToolExecution {
  name?: string;
  agent?: HostAgent;
}

/** 宿主工具服务的最小面。 */
interface HostTools {
  register?: (definition: HostToolDefinition) => () => void;
  restrict?: (filter: { allow?: string[]; deny?: string[] }) => () => void;
  schemas?: (scope?: unknown) => HostToolSchema[] | undefined;
  definitions?: (scope?: unknown) => readonly HostToolDefinition[];
  get?: (name: string, scope?: unknown) => HostToolDefinition | undefined;
  executable?: (
    name: string,
    scope?: unknown,
  ) => HostToolDefinition | undefined;
}

/** tool-surface 只读服务面。 */
interface ToolSurfaceFace {
  lookup: (name: string) => SurfaceDoc | undefined;
  list: () => SurfaceDoc[];
}

/** 完整说明与完整参数 schema。 */
interface SurfaceDoc {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** pin-note 动态保持登记面。 */
interface PinNotesFace {
  hold?(
    key: string,
    provider: (context: { sessionId: string }) => string | undefined,
  ): () => void;
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

/** 宿主上下文的最小面。 */
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
  grants: RevealSet;
  config: ResolvedConfig;
  matcher: Matcher;
  /** 初始集（展开后, 已去掉被静态隐藏的条件工具）。 */
  initialNames: string[];
  /** 全局条件工具名。 */
  conditional: Set<string>;
  /** 白名单外、已静态隐藏的条件工具名。 */
  denied: Set<string>;
  /** 已 shadow（或 shadow 失败仍纳管）的工具名。 */
  managed: Set<string>;
  /** shadow 注册的撤销函数（按工具名）。 */
  shadowDisposers: Map<string, () => void>;
  /** 静态 deny 的撤销函数。 */
  denyDisposer: (() => void) | undefined;
  /** 咨询工具注册的撤销函数。 */
  consultDisposer: (() => void) | undefined;
  /** 代理级监听器的撤销函数。 */
  listeners: Array<() => void>;
  /** 全局定义里的完整说明与 schema（shadow 之后仍可投递）。 */
  fullDocs: Map<string, SurfaceDoc>;
  /** 插件根上下文（pinNotes 等可选服务在揭示时懒解析）。 */
  pluginCtx: HostCtx;
  /** 本代理已就关键失败告警过一次。 */
  warnedOnce: boolean;
  /** pinNotes 缺席已告警过一次。 */
  warnedPinNotes: boolean;
  /** 初始化 / 重算期间屏蔽 tools/change 自激。 */
  applying: boolean;
}

/** 跨 apply 保留的代理状态（配置热重载时保留授权集合）。 */
const REGISTRY = new Map<string, AgentRuntime>();

/** 插件级 hold 登记（key = `revealed:<工具名>`, 全局唯一）。 */
const HOLD_DISPOSERS = new Map<string, () => void>();

/** 当前插件实例的全局监听 / hold 清理函数。 */
let activeCleanup: (() => void) | undefined;

/** 结构面取工具服务。 */
function asTools(value: unknown): HostTools | undefined {
  if (value === undefined || value === null || typeof value !== "object")
    return undefined;
  return value as HostTools;
}

/** 结构面取 tool-surface 只读服务面。 */
function asToolSurface(value: unknown): ToolSurfaceFace | undefined {
  if (value === undefined || value === null || typeof value !== "object")
    return undefined;
  const candidate = value as { lookup?: unknown; list?: unknown };
  return typeof candidate.lookup === "function" &&
    typeof candidate.list === "function"
    ? (candidate as ToolSurfaceFace)
    : undefined;
}

/** 结构面取代理注册表。 */
function asAgents(value: unknown): { list: () => HostAgent[] } | undefined {
  if (value === undefined || value === null || typeof value !== "object")
    return undefined;
  const candidate = value as { list?: unknown };
  return typeof candidate.list === "function"
    ? (candidate as { list: () => HostAgent[] })
    : undefined;
}

/** 结构面取 pinNotes 服务。 */
function asPinNotes(value: unknown): PinNotesFace | undefined {
  if (value === undefined || value === null || typeof value !== "object")
    return undefined;
  const candidate = value as { hold?: unknown };
  return typeof candidate.hold === "function"
    ? (candidate as PinNotesFace)
    : undefined;
}

/** 记录一条日志（宿主 logger 形态差异不影响主流程）。 */
function log(
  ctx: HostCtx,
  level: "info" | "warn" | "debug",
  message: string,
): void {
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

/** 当前全局完整定义（按名索引）。 */
function globalDefinitions(tools: HostTools): Map<string, HostToolDefinition> {
  const defs = tools.definitions?.() ?? [];
  return new Map(defs.map((definition) => [definition.name, definition]));
}

/** 从全局定义抽取完整说明与 schema（shadow 前的全文）。 */
function fullDocsOf(
  definitions: ReadonlyMap<string, HostToolDefinition>,
): Map<string, SurfaceDoc> {
  const docs = new Map<string, SurfaceDoc>();
  for (const [toolName, definition] of definitions) {
    docs.set(toolName, {
      name: toolName,
      description:
        typeof definition.description === "string"
          ? definition.description
          : "",
      parameters:
        definition.parameters !== undefined &&
        typeof definition.parameters === "object"
          ? definition.parameters
          : {},
    });
  }
  return docs;
}

/** 由当前定义 + 本地 catalog 重建检索器（denied 不入索引）。 */
function buildMatcher(
  definitions: ReadonlyMap<string, HostToolDefinition>,
  denied: ReadonlySet<string>,
): Matcher {
  const docs: SurfaceDoc[] = [];
  for (const [toolName, definition] of definitions) {
    if (toolName === CONSULT_TOOL_NAME || denied.has(toolName)) continue;
    const full = lookupSurface(toolName);
    docs.push(
      full ?? {
        name: toolName,
        description:
          typeof definition.description === "string"
            ? definition.description
            : "",
        parameters:
          definition.parameters !== undefined &&
          typeof definition.parameters === "object"
            ? definition.parameters
            : {},
      },
    );
  }
  return createMatcher(docs);
}

/** 撤销一个注册（幂等, 失败忽略）。 */
function disposeQuietly(dispose: (() => void) | undefined): void {
  if (dispose === undefined) return;
  try {
    dispose();
  } catch {
    // 已回收 / 宿主拒绝, 忽略。
  }
}

/** 撤销一个代理的全部注册（保留授权集合与全文缓存）。 */
function teardownRegistrations(runtime: AgentRuntime): void {
  for (const dispose of runtime.shadowDisposers.values())
    disposeQuietly(dispose);
  runtime.shadowDisposers.clear();
  runtime.managed.clear();
  disposeQuietly(runtime.consultDisposer);
  runtime.consultDisposer = undefined;
  disposeQuietly(runtime.denyDisposer);
  runtime.denyDisposer = undefined;
  for (const dispose of runtime.listeners.splice(0)) disposeQuietly(dispose);
}

/** 移除一个代理的运行时（回归宿主默认）。 */
function removeRuntime(runtime: AgentRuntime): void {
  teardownRegistrations(runtime);
  REGISTRY.delete(runtime.id);
}

/** 本代理告警一次。 */
function warnOnce(runtime: AgentRuntime, message: string): void {
  if (runtime.warnedOnce) return;
  runtime.warnedOnce = true;
  log(runtime.agent.ctx, "warn", message);
}

/** 未揭示拒绝文案。 */
function notRevealedReason(toolName: string): string {
  return `tool ${toolName} 未在当前会话揭示, 请先经 tool_consult 查询后再调用`;
}

/** 未揭示拒绝的返回值。 */
function notRevealedDecision(toolName: string): {
  kind: "deny";
  reason: string;
  info: { name: string; code: string };
} {
  return {
    kind: "deny",
    reason: notRevealedReason(toolName),
    info: { name: NOT_REVEALED_CODE, code: NOT_REVEALED_CODE },
  };
}

/** 某工具是否在 denied 集合里。 */
function isDenied(runtime: AgentRuntime, toolName: string): boolean {
  return runtime.denied.has(toolName);
}

/** 咨询运行时（闭包到单个代理）。 */
function consultRuntime(runtime: AgentRuntime): ConsultRuntime {
  return {
    get matcher() {
      return runtime.matcher;
    },
    config: runtime.config,
    isCallable: (toolName) =>
      toolName === CONSULT_TOOL_NAME ||
      (!isDenied(runtime, toolName) &&
        (runtime.initialNames.includes(toolName) ||
          runtime.grants.has(toolName))),
    isInitial: (toolName) => runtime.initialNames.includes(toolName),
    grantedNames: () => runtime.grants.names(),
    reveal: (names) => {
      const outcomes: Array<{
        name: string;
        result: ReturnType<RevealSet["grant"]>;
      }> = [];
      for (const toolName of names) {
        if (
          toolName === CONSULT_TOOL_NAME ||
          isDenied(runtime, toolName) ||
          runtime.matcher.get(toolName) === undefined
        )
          continue;
        const result = runtime.grants.grant(toolName);
        ensureHold(runtime, toolName);
        outcomes.push({ name: toolName, result });
      }
      return outcomes;
    },
  };
}

/** 揭示正文（每个工具一条, 由已揭示集合与全文源决定）。 */
function revealPayload(toolName: string, doc: SurfaceDoc): string {
  return [
    `[tool-consult] 已揭示工具 ${toolName}（本会话内可调用）`,
    JSON.stringify({
      description: doc.description,
      input_schema: doc.parameters,
    }),
  ].join("\n");
}

/** 按工具登记 pinNotes.hold（每个工具 key 固定一次）。 */
function ensureHold(runtime: AgentRuntime, toolName: string): void {
  if (HOLD_DISPOSERS.has(toolName)) return;
  const pinNotes = asPinNotes(runtime.pluginCtx.get?.("pinNotes"));
  if (pinNotes === undefined) {
    if (runtime.warnedPinNotes) return;
    runtime.warnedPinNotes = true;
    log(
      runtime.agent.ctx,
      "warn",
      "ctx.pinNotes 不可用：揭示仍写授权，但完整说明与 schema 不会投递（请检查 pin-note 是否挂载）",
    );
    return;
  }
  try {
    const dispose = pinNotes.hold?.(
      `revealed:${toolName}`,
      (context: { sessionId: string }) => {
        const current = REGISTRY.get(context.sessionId);
        if (
          current === undefined ||
          isDenied(current, toolName) ||
          !current.grants.has(toolName)
        )
          return undefined;
        const doc =
          lookupSurface(toolName) ??
          current.fullDocs.get(toolName) ??
          undefined;
        return doc === undefined ? undefined : revealPayload(toolName, doc);
      },
    );
    if (typeof dispose === "function") HOLD_DISPOSERS.set(toolName, dispose);
  } catch (error: unknown) {
    warnOnce(runtime, `pinNotes.hold 登记失败：${String(error)}`);
  }
}

/** 注册咨询工具进代理自身层（自身层豁免静态 deny）。 */
function attachConsultTool(runtime: AgentRuntime): void {
  const agentTools = asTools(runtime.agent.ctx.tools);
  if (agentTools?.register === undefined) {
    warnOnce(runtime, "agent.ctx 缺少 tools.register，咨询工具未注册。");
    return;
  }
  try {
    runtime.consultDisposer = agentTools.register(
      createConsultTool(
        consultRuntime(runtime),
      ) as unknown as HostToolDefinition,
    );
  } catch (error: unknown) {
    const kind = classifyToolRegisterError(error);
    log(
      runtime.agent.ctx,
      "warn",
      kind === "duplicate"
        ? "咨询工具名已被占用，本代理不注册咨询工具。"
        : `咨询工具注册失败：${String(error)}`,
    );
  }
}

/** 注册代理级门禁（重复调用先撤旧的）。 */
function attachListeners(runtime: AgentRuntime): void {
  for (const dispose of runtime.listeners.splice(0)) disposeQuietly(dispose);
  const on = runtime.agent.ctx.on;
  if (on === undefined) return;
  const dispose = on("tools/pre-execute", (...args: unknown[]) => {
    const exec = args[0] as HostToolExecution | undefined;
    const next = args[1] as (() => unknown) | undefined;
    const passthrough = (): unknown =>
      typeof next === "function" ? next() : { kind: "allow" };
    const toolName = exec?.name;
    if (typeof toolName !== "string") return passthrough();
    if (!runtime.managed.has(toolName)) return passthrough();
    if (isDenied(runtime, toolName)) return passthrough();
    if (runtime.grants.has(toolName)) return passthrough();
    return notRevealedDecision(toolName);
  });
  if (typeof dispose === "function")
    runtime.listeners.push(dispose as () => void);
}

/**
 * 安装静态 deny 并核对模型面。
 * @returns 成功时 true; 失败已撤销 deny 并告警。
 */
function installDeny(
  runtime: AgentRuntime,
  tools: HostTools,
  denied: ReadonlySet<string>,
): boolean {
  disposeQuietly(runtime.denyDisposer);
  runtime.denyDisposer = undefined;
  if (denied.size === 0) return true;
  const agentTools = asTools(runtime.agent.ctx.tools);
  if (agentTools?.restrict === undefined) {
    warnOnce(
      runtime,
      "agent.ctx 缺少 tools.restrict，无法隐藏条件工具；本代理不接管。",
    );
    return false;
  }
  try {
    runtime.denyDisposer = agentTools.restrict({
      deny: [...denied].sort((a, b) => a.localeCompare(b)),
    });
  } catch (error: unknown) {
    warnOnce(runtime, decideDenyFailure(error).message);
    return false;
  }
  const visible = tools.schemas?.(runtime.agent);
  if (!Array.isArray(visible)) {
    disposeQuietly(runtime.denyDisposer);
    runtime.denyDisposer = undefined;
    warnOnce(
      runtime,
      "无法核对 schemas(agent)，不能确认条件工具已隐藏；本代理不接管。",
    );
    return false;
  }
  const leaked = visible
    .map((schema) => schema.name)
    .filter((toolName) => denied.has(toolName));
  if (leaked.length > 0) {
    disposeQuietly(runtime.denyDisposer);
    runtime.denyDisposer = undefined;
    warnOnce(runtime, decideDenyResidual(leaked).message);
    return false;
  }
  return true;
}

/** 计算当前条件工具与静态隐藏集。 */
function computeDenied(
  tools: HostTools,
  definitions: ReadonlyMap<string, HostToolDefinition>,
  config: ResolvedConfig,
): { conditional: Set<string>; denied: Set<string> } {
  const allowed = new Set(config.allowedWhenTools);
  const conditional = new Set<string>();
  for (const toolName of definitions.keys()) {
    if (tools.executable?.(toolName) === undefined) conditional.add(toolName);
  }
  const denied = new Set(
    [...conditional].filter((toolName) => !allowed.has(toolName)),
  );
  return { conditional, denied };
}

/** 展开初始集，去掉被静态隐藏的条件工具并告警。 */
function computeInitial(
  runtime: AgentRuntime,
  names: readonly string[],
  denied: ReadonlySet<string>,
): string[] {
  const expanded = expandInitialTools(runtime.config.initialTools, names);
  if (expanded.unknown.length > 0) {
    log(
      runtime.agent.ctx,
      "warn",
      `initialTools 未命中任何工具：${expanded.unknown.join(", ")}`,
    );
  }
  const hidden = expanded.names.filter((toolName) => denied.has(toolName));
  if (hidden.length > 0) {
    log(
      runtime.agent.ctx,
      "warn",
      `initialTools 含白名单外条件工具：${hidden.join(", ")}；已按隐藏处理。`,
    );
  }
  return expanded.names.filter((toolName) => !denied.has(toolName));
}

/** 注册非初始、非条件工具的 shadow。 */
function installShadows(
  runtime: AgentRuntime,
  definitions: ReadonlyMap<string, HostToolDefinition>,
): boolean {
  const agentTools = asTools(runtime.agent.ctx.tools);
  if (agentTools?.register === undefined) {
    warnOnce(runtime, "agent.ctx 缺少 tools.register，无法收短工具定义。");
    return false;
  }
  const initial = new Set(runtime.initialNames);
  const names = [...definitions.keys()].sort((a, b) => a.localeCompare(b));
  for (const toolName of names) {
    if (
      toolName === CONSULT_TOOL_NAME ||
      initial.has(toolName) ||
      runtime.conditional.has(toolName)
    )
      continue;
    const definition = definitions.get(toolName);
    if (definition === undefined) continue;
    try {
      const wrapped = wrapToolDefinition(definition);
      const dispose = agentTools.register(wrapped);
      runtime.managed.add(toolName);
      if (typeof dispose === "function")
        runtime.shadowDisposers.set(toolName, dispose);
    } catch (error: unknown) {
      // 注册失败也纳管：未揭示先拒绝，揭示后放行（宁可拒绝也不绕过门禁）。
      runtime.managed.add(toolName);
      log(
        runtime.agent.ctx,
        "warn",
        `工具 ${toolName} 的短定义注册失败（${String(error)}）；仍按未揭示拒绝。`,
      );
    }
  }
  return true;
}

/** 初始化 / 重建一个代理的注册。 */
function setupAgent(
  agent: HostAgent | undefined,
  ctx: HostCtx,
  tools: HostTools,
  config: ResolvedConfig,
  owned: Set<AgentRuntime>,
): void {
  if (
    agent === undefined ||
    typeof agent.id !== "string" ||
    agent.ctx === undefined
  )
    return;
  if (!shouldManage(config, agent)) return;

  const existing = REGISTRY.get(agent.id);
  const runtime: AgentRuntime = existing ?? {
    id: agent.id,
    agent,
    grants: new RevealSet(),
    config,
    matcher: createMatcher([]),
    initialNames: [],
    conditional: new Set(),
    denied: new Set(),
    managed: new Set(),
    shadowDisposers: new Map(),
    denyDisposer: undefined,
    consultDisposer: undefined,
    listeners: [],
    fullDocs: new Map(),
    pluginCtx: ctx,
    warnedOnce: false,
    warnedPinNotes: false,
    applying: false,
  };
  if (existing !== undefined) {
    teardownRegistrations(runtime);
    runtime.agent = agent;
    runtime.config = config;
    runtime.pluginCtx = ctx;
    runtime.warnedOnce = false;
    runtime.warnedPinNotes = false;
  }
  REGISTRY.set(agent.id, runtime);
  owned.add(runtime);
  runtime.applying = true;
  try {
    const definitions = globalDefinitions(tools);
    const names = [...definitions.keys()];
    const { conditional, denied } = computeDenied(tools, definitions, config);
    runtime.conditional = conditional;
    runtime.denied = denied;
    runtime.fullDocs = fullDocsOf(definitions);
    runtime.initialNames = computeInitial(runtime, names, denied);
    runtime.matcher = buildMatcher(definitions, denied);

    if (!installDeny(runtime, tools, denied)) {
      owned.delete(runtime);
      removeRuntime(runtime);
      return;
    }

    if (!installShadows(runtime, definitions)) {
      owned.delete(runtime);
      removeRuntime(runtime);
      return;
    }
    attachConsultTool(runtime);
    attachListeners(runtime);

    // 热重载后保留的授权项重新登记 hold（旧 hold 已随 apply 撤掉）。
    for (const toolName of runtime.grants.names())
      ensureHold(runtime, toolName);

    log(
      ctx,
      "info",
      `tool-consult: agent ${agent.id} 已就绪（初始 ${runtime.initialNames.length}，` +
        `shadow ${runtime.managed.size}，deny ${runtime.denied.size}）。`,
    );
  } finally {
    runtime.applying = false;
  }
}

/** 工具面变化后重算 deny / 初始集 / 索引（不补 shadow）。 */
function recomputeAgent(
  runtime: AgentRuntime,
  tools: HostTools,
  owned: Set<AgentRuntime>,
): void {
  if (runtime.applying) return;
  runtime.applying = true;
  try {
    const definitions = globalDefinitions(tools);
    const names = [...definitions.keys()];
    const { conditional, denied } = computeDenied(
      tools,
      definitions,
      runtime.config,
    );
    const conditionalChanged = !setsEqual(conditional, runtime.conditional);
    const deniedChanged = !setsEqual(denied, runtime.denied);
    runtime.conditional = conditional;
    runtime.denied = denied;
    runtime.fullDocs = fullDocsOf(definitions);

    if (conditionalChanged || deniedChanged) {
      if (!installDeny(runtime, tools, denied)) {
        owned.delete(runtime);
        removeRuntime(runtime);
        return;
      }
    }

    // 已注销的工具不再保留 shadow（不补新工具）。
    for (const [toolName, dispose] of [...runtime.shadowDisposers]) {
      if (names.includes(toolName)) continue;
      disposeQuietly(dispose);
      runtime.shadowDisposers.delete(toolName);
      runtime.managed.delete(toolName);
    }

    runtime.initialNames = computeInitial(runtime, names, denied);
    runtime.matcher = buildMatcher(definitions, denied);
  } finally {
    runtime.applying = false;
  }
}

/** 两个集合是否完全相同。 */
function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** catalog 自检（失败时整体不接管）。 */
function catalogSelfCheck(
  tools: HostTools,
  surface: ToolSurfaceFace,
): string | undefined {
  if (typeof tools.definitions !== "function")
    return "tools.definitions 不可用";
  if (typeof tools.executable !== "function") return "tools.executable 不可用";
  if (typeof tools.schemas !== "function") return "tools.schemas 不可用";
  let serviceNames: string[];
  try {
    serviceNames = surface
      .list()
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    return `toolSurface.list 失败（${String(error)}）`;
  }
  const localNames = listSurface()
    .map((entry) => entry.name)
    .sort();
  if (
    serviceNames.length !== localNames.length ||
    serviceNames.some((entry, index) => entry !== localNames[index])
  ) {
    return (
      "服务面与本地 catalog 名集不一致（可能挂载了多份 tool-surface）: " +
      `服务面 ${serviceNames.length} 项, 本地 ${localNames.length} 项`
    );
  }
  for (const definition of tools.definitions() ?? []) {
    if (
      isWrappedDefinition(definition) &&
      lookupSurface(definition.name) === undefined
    )
      return `已包装工具 ${definition.name} 不在本地 catalog`;
  }
  return undefined;
}

/** 撤销本插件实例的全局监听与全部 hold（保留运行时与授权）。 */
function cleanupActive(): void {
  const cleanup = activeCleanup;
  activeCleanup = undefined;
  if (cleanup !== undefined) {
    try {
      cleanup();
    } catch {
      // 清理失败忽略。
    }
  }
  for (const dispose of HOLD_DISPOSERS.values()) disposeQuietly(dispose);
  HOLD_DISPOSERS.clear();
  for (const runtime of REGISTRY.values()) teardownRegistrations(runtime);
}

/** 插件 apply 面。 */
export function apply(ctx: HostCtx, rawConfig?: Config): void {
  const config = resolveConfig(rawConfig);
  cleanupActive();
  if (!config.enabled) return;
  if (config.ignoredKeys.length > 0) {
    log(
      ctx,
      "warn",
      `配置项已废弃并忽略：${config.ignoredKeys.join(", ")}；` +
        "揭示固定为会话内有效，条件工具由 allowedWhenTools 管理。",
    );
  }

  const tools = asTools(ctx.get?.("tools") ?? ctx.tools);
  const agents = asAgents(ctx.get?.("agents"));
  if (tools === undefined || agents === undefined) {
    log(ctx, "warn", decideMissingService().message);
    return;
  }

  const surface = asToolSurface(ctx.get?.("toolSurface"));
  if (surface === undefined) {
    log(
      ctx,
      "warn",
      decideCatalogSelfCheck("ctx.toolSurface 服务未挂载").message,
    );
    return;
  }
  const selfCheck = catalogSelfCheck(tools, surface);
  if (selfCheck !== undefined) {
    log(ctx, "warn", decideCatalogSelfCheck(selfCheck).message);
    return;
  }

  const pinNotes = asPinNotes(ctx.get?.("pinNotes"));
  if (pinNotes === undefined) {
    // 可选服务可能在插件之后才挂载；此处只作提示，真正投递在揭示时懒解析。
    log(
      ctx,
      "info",
      "ctx.pinNotes 当前不可用：揭示时再解析；若届时仍缺席，只告警一次且不阻断授权。",
    );
  }

  const owned = new Set<AgentRuntime>();
  const globalListeners: Array<() => void> = [];

  const created = ctx.on?.("agent/created", (...args: unknown[]) => {
    const payload = args[0] as { agent?: HostAgent } | undefined;
    setupAgent(payload?.agent, ctx, tools, config, owned);
  });
  if (typeof created === "function")
    globalListeners.push(created as () => void);

  const disposed = ctx.on?.("agent/disposed", (...args: unknown[]) => {
    const payload = args[0] as { agent?: { id?: string } } | undefined;
    const id = payload?.agent?.id;
    if (typeof id !== "string") return;
    const runtime = REGISTRY.get(id);
    if (runtime === undefined) return;
    removeRuntime(runtime);
    owned.delete(runtime);
  });
  if (typeof disposed === "function")
    globalListeners.push(disposed as () => void);

  // 工具面变化：重算静态 deny 与索引；不补新工具的 shadow。
  const changed = ctx.on?.("tools/change", () => {
    for (const runtime of [...owned]) {
      if (runtime.applying) continue;
      recomputeAgent(runtime, tools, owned);
    }
  });
  if (typeof changed === "function")
    globalListeners.push(changed as () => void);

  activeCleanup = () => {
    for (const dispose of globalListeners.splice(0)) disposeQuietly(dispose);
    for (const dispose of HOLD_DISPOSERS.values()) disposeQuietly(dispose);
    HOLD_DISPOSERS.clear();
  };

  // 插件卸载：撤销注册与全局监听；运行时表清空，授权随会话结束释放。
  ctx.effect?.(() => () => {
    activeCleanup?.();
    activeCleanup = undefined;
    for (const runtime of [...REGISTRY.values()])
      teardownRegistrations(runtime);
    REGISTRY.clear();
    owned.clear();
  });

  // 热挂载：对已存在的代理补做。
  for (const agent of agents.list())
    setupAgent(agent, ctx, tools, config, owned);
}
