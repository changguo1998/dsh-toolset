// src/main.ts — cordis 插件入口（DSH bundle 接入面）
//
// 契约对齐 docs/host/DSH-CTX-API.md §0（`export { name, inject, provide, Config, apply }`）与
// dsh 0.1.5-rc.2 宿主实现（0.1.7-rc.2 → 0.2.0-rc.2 升级复核：本包消费面零 diff，见
// docs/host/HOST-UPGRADE-0.2.0-rc.2.md）：
//   - `inject: ['sessionProjections', 'sessions', 'tools']`（三者皆硬依赖，任缺则 fiber 等待）：
//     投影注册表是 registry 驱动面；宿主按会话持有单元（`cellFor`）、每次提交事件 eager 驱动
//     `apply`、缺缓存行时按需惰性整段折叠（`buildCell`），故本插件**不订阅 session/event、
//     不自行记会话**——单元是纯折叠。
//   - `provide: ['contextReport']`：只读报告面（宿主命令/其他插件经 `ctx.get('contextReport')`）。
//   - 工具面 `context_report` 走宿主 tools registry。
//
// 投影口径（BACKLOG #34）：注册 host-only 单元 `sessionContext`（只声明 state、不声明 wire）——
// 宿主 public 类型 `SessionProjectionMap` 由宿主包声明，第三方 key 无 wire 语义；host-only
// 单元同样被 eager 驱动、可经 `stateOf()` 读取，且不参与客户端快照。
//
// 惰性/防御：`tokenMeter` 是唯一**可选**服务（经 `optionalService` 先探测再读，未挂载时报告
// 只缺即时读数）；`sessionProjections` / `sessions` / `tools` 已在 inject 声明（cordis 保证
// apply 时已就绪），代码仍按结构面防御取值，以便单测不经 cordis 直接传普通对象。

import { createInitialState, reduceEvent, type FoldScratch } from "./fold.ts";
import { sessionContextSchema } from "./schema.ts";
import { buildReport, normalizeDetail, withDefaults } from "./report.ts";
import type {
  ContextPressureLike,
  ContextReport,
  ContextReportInput,
  ReportDetail,
  ReportEvent,
  SessionContextState,
  SessionStatsLike,
} from "./types.ts";

export const name = "context-report";
/**
 * 依赖声明（cordis `inject`）——三者都是本插件的数据源，缺任一则 fiber 保持 pending 直至服务就绪：
 * `sessionProjections`（投影注册表，eager 驱动 + 按会话缓存）、`sessions`（会话仓库，解析目标会话）、
 * `tools`（工具注册表，注册 `context_report`）。
 *
 * 注意：cordis 的 ctx 代理对**未 inject 的服务属性**访问即抛错
 * （`cannot get property "x" without inject`），不能靠「读到 undefined 再降级」；
 * 可选服务（`tokenMeter`）必须先经 {@link optionalService} 做存在性探测。
 */
export const inject = ["sessionProjections", "sessions", "tools"];
/** 供宿主/其他插件读取的报告面。 */
export const provide = ["contextReport"];

/** 投影 key（host-only 状态单元名）。 */
export const PROJECTION_KEY = "sessionContext";
/**
 * 官方会话统计投影 key（回合 / 步 / 墙钟；由 `dsh-session-stats` 注册）。
 * 本包只读不注册：官方不在位时该组数字缺省，不回退自折叠（见追踪文档「决策」）。
 */
export const STATS_KEY = "sessionStats";
/**
 * 投影状态版本：序列化字段或折叠语义变更时递增（宿主按此丢弃旧缓存行）。
 * v2：修复宿主逐事件驱动 `apply` 时在途账（scratch）跨调用丢失的问题
 * （v1 的 apply 每次重建 scratch，导致回合/token/墙钟恒 0，仅步数可计）。
 * v3：与官方 `sessionStats` 去重——状态只保留 token 分桶（删除回合/步/墙钟字段）。
 */
export const STATE_VERSION = 3;

/** 宿主投影定义（`ProjectionDefinition` 的结构子集，wire 缺省 = host-only）。 */
export interface ProjectionDefLike {
  readonly key: string;
  readonly stateSchema: { parse(value: unknown): unknown };
  init(header: unknown, inheritedEventCount: number): unknown;
  apply(state: unknown, event: unknown): unknown;
  readonly stateVersion: number;
}

/** 宿主投影注册表（`SessionProjectionRegistry` 的结构子集）。 */
export interface ProjectionRegistryLike {
  register(definition: ProjectionDefLike): () => void;
  stateOf(session: unknown, key: string): unknown;
}

/** 宿主会话（`Session` 的结构子集）。 */
export interface HostSessionLike {
  readonly id?: string;
  readonly events?: readonly ReportEvent[];
  readonly seq?: number;
  requestHeader?(): unknown;
}

/** 宿主持久化会话仓库（`SessionStore` 的结构子集）。 */
export interface SessionStoreLike {
  list(): readonly HostSessionLike[];
  get(id: string): HostSessionLike | undefined;
}

/** 宿主 token 计量服务（`TokenMeter` 的结构子集）。 */
export interface TokenMeterLike {
  measure(session: unknown): unknown;
}

/** 宿主工具注册表（`ToolRuntime` 的结构子集）。 */
export interface ToolRegistryLike {
  register(definition: unknown): unknown;
}

/** 结构化宿主 ctx（最小 DSH cordis 形态；可选能力见 {@link optionalService}）。 */
export interface BundleHost {
  sessionProjections?: ProjectionRegistryLike;
  sessions?: SessionStoreLike;
  tokenMeter?: TokenMeterLike;
  tools?: ToolRegistryLike;
  logger?(ns: string): {
    info(message: string): void;
    warn?(message: string): void;
  };
}

/**
 * 探测可选服务：cordis 的 ctx 代理对未 inject 的属性访问会抛错，
 * 故先看属性是否存在于代理背后（`in` 走特殊属性通道，不触发服务解析），再读取并吞掉异常。
 * @param host - 宿主 ctx（或其子代理）。
 * @param key - 服务属性名（如 `tokenMeter`）。
 * @returns 服务实例，或 undefined（未挂载）。
 */
export function optionalService<T>(host: object, key: string): T | undefined {
  if (!(key in host)) return undefined;
  try {
    const value = (host as Record<string, unknown>)[key];
    return (value ?? undefined) as T | undefined;
  } catch {
    return undefined;
  }
}

/** 插件配置（类型别名：无运行期 schema，宿主原样透传）。 */
export interface ContextReportConfig {
  /** 报告默认细节级别（缺省 standard）。 */
  detail?: string;
  /** 是否注册投影单元（缺省 true；false = 只在即时读数可用时出报告）。 */
  projection?: boolean;
}

export type Config = ContextReportConfig;

/** 报告服务面（provide: contextReport）。 */
export interface ContextReportService {
  /** 生成一份报告（sessionId 缺省时用调用方/唯一会话）。 */
  report(options?: ContextReportInput): ContextReport;
  /** 读投影状态（未注册/未知会话返回 undefined）。 */
  sessionState(sessionId?: string): SessionContextState | undefined;
  /** 列表当前会话（id + 是否有投影状态）。 */
  listSessions(): { id: string; tracked: boolean }[];
  /** 卸载本插件的注册（宿主重载与测试用）。 */
  dispose(): void;
}

/** 判定宿主传入值是否为本插件状态（形状校验；失败退回空态）。 */
function isState(value: unknown): value is SessionContextState {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { asOfSeq?: unknown }).asOfSeq === "number" &&
    typeof (value as { outputTokens?: unknown }).outputTokens === "number"
  );
}

/** 判定官方 `sessionStats` 视图形状（字段缺一即视为不可用，宁可缺省不猜）。 */
function isStats(value: unknown): value is SessionStatsLike {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["turns"] === "number" &&
    typeof record["steps"] === "number" &&
    typeof record["llmMs"] === "number" &&
    typeof record["toolMs"] === "number" &&
    typeof record["ttftMs"] === "number" &&
    typeof record["ttftSteps"] === "number" &&
    typeof record["decodeMs"] === "number" &&
    typeof record["decodeTokens"] === "number"
  );
}

/** 会话 id 取值（宿主 Session.id 是品牌字符串）。 */
function sessionIdOf(session: HostSessionLike | undefined): string | undefined {
  const id = session?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** 从宿主 `requestHeader()` 结果里取路由（provider/model 缺省忽略）。 */
export function routeOf(
  header: unknown,
): { provider: string; model: string } | undefined {
  if (header === null || typeof header !== "object") return undefined;
  const record = header as Record<string, unknown>;
  const provider = record["provider"];
  const model = record["model"];
  if (typeof provider !== "string" || typeof model !== "string")
    return undefined;
  if (provider.length === 0 || model.length === 0) return undefined;
  return { provider, model };
}

/**
 * 在途账的跨调用保持：宿主按「逐事件调用 `apply(state, event)`」驱动投影，
 * 而折叠的在途账（当前回合号、打开步、配对中的工具调用）天然是跨事件的，
 * 不能每次重建。这里以 state 对象为键缓存 scratch：宿主传入的 state 恒为上一次
 * `apply` 的返回值（不可变更新），WeakMap 命中即延续在途账；缓存行反序列化恢复
 * 时（新对象、无命中）自然重建——跨重启的在途步本就不应继续计数。
 */
const scratchByState = new WeakMap<object, FoldScratch>();

/**
 * 构造 `sessionContext` 投影定义（host-only：只给 state，无 wire）。
 *
 * 纯折叠契约：`apply` 只吃「上一状态 + 一条事件」；未匹配的事件必须返回**同一引用**
 * （宿主据此零下游工作）。新会话 / 缓存行缺失时由宿主从 `init` 起整段折叠。
 * @returns 宿主 `register()` 可直接消费的定义对象。
 */
export function createProjectionDef(): ProjectionDefLike {
  return {
    key: PROJECTION_KEY,
    stateSchema: sessionContextSchema(),
    // fork 继承前缀（inheritedEventCount > 0）的累计值不计入本会话（与宿主 sessionStats 同口径）。
    init(): SessionContextState {
      return createInitialState();
    },
    apply(state: unknown, event: unknown): SessionContextState {
      const prev = isState(state) ? state : createInitialState();
      // 在途账按 state 对象延续（见 scratchByState 注释）；首次/恢复时新建。
      let scratch = scratchByState.get(prev);
      if (scratch === undefined) {
        scratch = { seq: -1, open: null };
      }
      const next = reduceEvent(prev, event as ReportEvent, scratch, 0);
      scratchByState.set(next, scratch);
      return next;
    },
    stateVersion: STATE_VERSION,
  };
}

/** 即时压力读数的归一（不可信输入一律丢弃）。 */
function toPressure(value: unknown): ContextPressureLike | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const num = (field: string): number | undefined => {
    const raw = record[field];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : undefined;
  };
  const pressureTokens = num("pressureTokens");
  const projectedTokens = num("projectedTokens");
  const contextWindow = num("contextWindow");
  if (
    pressureTokens === undefined &&
    projectedTokens === undefined &&
    contextWindow === undefined
  ) {
    return undefined;
  }
  return {
    ...(pressureTokens !== undefined ? { pressureTokens } : {}),
    ...(projectedTokens !== undefined ? { projectedTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/** 强制压力读数：宿主 `ctx.tokenMeter.measure` 的 `{pressureTokens, projectedTokens, contextWindow, totalTokens}` 结构子集。 */
export function pressureFromMeasure(
  measured: unknown,
): ContextPressureLike | undefined {
  if (measured === null || typeof measured !== "object") return undefined;
  const record = measured as Record<string, unknown>;
  const direct = toPressure(record);
  if (direct !== undefined) return direct;
  const total = record["totalTokens"];
  return typeof total === "number" && Number.isFinite(total) && total > 0
    ? { projectedTokens: total }
    : undefined;
}

/**
 * 宿主按 bundle 契约调用：惰性、防御，失败只告警不抛。
 * @param ctx - 宿主结构化 ctx（见 {@link BundleHost}）。
 * @param config - 插件配置（缺省值见 {@link ContextReportConfig}）。
 */
export function apply(
  ctx: BundleHost & Record<string, unknown>,
  config: ContextReportConfig = {},
): void {
  const warn = (msg: string): void => {
    optionalService<{ info(message: string): void }>(ctx, "logger")?.info(
      `[context-report] ${msg}`,
    );
  };
  const disposers: Array<() => void> = [];
  const defaultDetail: ReportDetail = normalizeDetail(config.detail);
  // 三个数据源在 inject 中声明（cordis 保证 apply 时已就绪），但仍按结构面防御式取值：
  // 单测可不经 cordis 直接传普通对象。
  const registry = optionalService<ProjectionRegistryLike>(
    ctx,
    "sessionProjections",
  );
  const sessions = optionalService<SessionStoreLike>(ctx, "sessions");
  const tools = optionalService<ToolRegistryLike>(ctx, "tools");

  // 1) 投影单元注册（host-only；宿主负责按会话驱动与持久化缓存）。
  if (
    registry !== undefined &&
    typeof registry.register === "function" &&
    config.projection !== false
  ) {
    try {
      disposers.push(registry.register(createProjectionDef()));
    } catch (err) {
      warn(`sessionContext 投影注册失败：${String(err)}`);
    }
  } else if (registry === undefined) {
    warn("sessionProjections 不可用：报告将缺省会话累计（仅即时读数）");
  }

  /** 取会话：显式 id → 调用方会话 → 唯一会话。 */
  const resolveSession = (
    sessionId: string | undefined,
    callerSession: HostSessionLike | undefined,
  ): HostSessionLike | undefined => {
    if (sessionId !== undefined) {
      const found = sessions?.get(sessionId);
      if (found !== undefined) return found;
      return sessionIdOf(callerSession) === sessionId
        ? callerSession
        : undefined;
    }
    if (callerSession !== undefined) return callerSession;
    const list = sessions?.list() ?? [];
    return list.length === 1 ? list[0] : undefined;
  };

  /** 读状态：宿主投影注册表是权威读面（缺行时宿主自行惰性折叠）。 */
  const stateFor = (
    session: HostSessionLike | undefined,
  ): SessionContextState | undefined => {
    if (session === undefined || registry === undefined) return undefined;
    if (typeof registry.stateOf !== "function") return undefined;
    let raw: unknown;
    try {
      raw = registry.stateOf(session, PROJECTION_KEY);
    } catch (err) {
      warn(`投影读面失败：${String(err)}`);
      return undefined;
    }
    if (!isState(raw)) return undefined;
    const route = routeOf(session.requestHeader?.());
    return route === undefined
      ? raw
      : { ...raw, provider: route.provider, model: route.model };
  };

  /**
   * 读官方会话统计投影（回合 / 步 / 墙钟）。官方不在位 / 形状不符 → undefined，
   * 报告按「该组数字不可用」渲染（不回退自折叠，见追踪文档「决策」）。
   */
  const statsFor = (
    session: HostSessionLike | undefined,
  ): SessionStatsLike | undefined => {
    if (session === undefined || registry === undefined) return undefined;
    if (typeof registry.stateOf !== "function") return undefined;
    let raw: unknown;
    try {
      raw = registry.stateOf(session, STATS_KEY);
    } catch (err) {
      warn(`sessionStats 读面失败：${String(err)}`);
      return undefined;
    }
    return isStats(raw) ? raw : undefined;
  };

  /** 即时压力读数（tokenMeter 为可选服务，先探测再读）。 */
  const pressureFor = (
    session: HostSessionLike | undefined,
  ): ContextPressureLike | undefined => {
    if (session === undefined) return undefined;
    const meter = optionalService<TokenMeterLike>(ctx, "tokenMeter");
    if (meter === undefined || typeof meter.measure !== "function")
      return undefined;
    try {
      return pressureFromMeasure(meter.measure(session));
    } catch (err) {
      warn(`tokenMeter 读数失败：${String(err)}`);
      return undefined;
    }
  };

  /**
   * 组装一次报告输入（会话解析 + token 状态 + 官方统计 + 压力读数）。
   * @param options - 调用方给的报告输入（sessionId / detail）。
   * @param callerSession - 调用方会话（工具面来自 `exec.agent.session`），可选。
   * @returns 补齐状态与压力后的输入，可直接喂给 `buildReport`。
   */
  const collect = (
    options: ContextReportInput = {},
    callerSession?: HostSessionLike,
  ): ContextReportInput => {
    const session = resolveSession(options.sessionId, callerSession);
    const state = stateFor(session);
    const stats = statsFor(session);
    const pressure = pressureFor(session);
    const resolvedId = options.sessionId ?? sessionIdOf(session);
    return withDefaults(
      {
        ...options,
        detail: options.detail ?? defaultDetail,
        ...(resolvedId !== undefined ? { sessionId: resolvedId } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(stats !== undefined ? { stats } : {}),
        ...(pressure !== undefined ? { pressure } : {}),
      },
      undefined,
    );
  };

  const service: ContextReportService = {
    report(options) {
      return buildReport(collect(options));
    },
    sessionState(sessionId) {
      return stateFor(resolveSession(sessionId, undefined));
    },
    listSessions() {
      return (sessions?.list() ?? []).map((session) => {
        const id = sessionIdOf(session) ?? "";
        return { id, tracked: stateFor(session) !== undefined };
      });
    },
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // 卸载幂等：单个 disposer 抛错不影响其余清理
        }
      }
    },
  };

  // 2) provide 面（宿主 cordis：ctx.provide）。
  const provideFn = optionalService<(key: string, value: unknown) => unknown>(
    ctx,
    "provide",
  );
  if (typeof provideFn === "function") {
    try {
      provideFn("contextReport", service);
    } catch (err) {
      warn(`contextReport 服务注册失败：${String(err)}`);
    }
  }

  // 3) 工具注册（宿主 tools registry；结构面构造，失败只告警）。
  if (tools !== undefined && typeof tools.register === "function") {
    try {
      tools.register(createContextReportTool(collect, service, defaultDetail));
    } catch (err) {
      warn(`context_report 工具注册失败：${String(err)}`);
    }
  }
}

/** `context_report` 工具参数（模型可传）。 */
interface ToolArgs {
  action?: string;
  session_id?: string;
  sessionId?: string;
  detail?: string;
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

/**
 * 构造 `context_report` 工具定义（结构面：name/description/parameters/execute/output）。
 * @param collect - 组装一次报告输入（会话解析 + 状态 + 压力读数）。
 * @param service - 报告服务面（供 action=list 复用会话清单）。
 * @param defaultDetail - 缺省细节级别。
 * @returns 宿主 tools registry 可注册的定义对象。
 */
export function createContextReportTool(
  collect: (
    options: ContextReportInput,
    callerSession?: HostSessionLike,
  ) => ContextReportInput,
  service: Pick<ContextReportService, "listSessions">,
  defaultDetail: ReportDetail = "standard",
): unknown {
  return {
    name: "context_report",
    description:
      "会话累计用量报告：回合/步数、token 分桶（未缓存输入/缓存读/缓存写/输出，reasoning 为子集）、上下文占用（请求压力/模型容量）、模型与工具墙钟、首 token 与解码速率。action=report（缺省）渲染报告；action=state 出投影原始状态；action=list 列会话。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["report", "state", "list"],
          description:
            "report（缺省）：渲染报告；state：投影状态原始值；list：会话清单",
        },
        session_id: {
          type: "string",
          description:
            "目标会话 id（缺省：当前会话；会话多于一个且未指定时返回错误）",
        },
        detail: {
          type: "string",
          enum: ["summary", "standard", "full"],
          description: "报告细节级别（缺省 standard）",
        },
      },
    },
    // 说明：execute 的调用方会话来自 exec.agent.session（宿主 ToolRunContext 面），
    // 由 main.ts 的 collect 读取，因此这里不重复解释 exec。
    async execute(args: unknown, exec: unknown): Promise<unknown> {
      const input = (args ?? {}) as ToolArgs;
      const callerSession = (
        exec as { agent?: { session?: HostSessionLike } } | undefined
      )?.agent?.session;
      const sessionId = input.session_id ?? input.sessionId;
      if (input.action === "list") {
        return { sessions: service.listSessions() };
      }
      const options: ContextReportInput = {
        ...(sessionId !== undefined ? { sessionId } : {}),
        detail:
          input.detail !== undefined
            ? normalizeDetail(input.detail)
            : defaultDetail,
      };
      const full = collect(options, callerSession);
      if (input.action === "state") {
        return (
          full.state ?? {
            ok: false,
            error: "会话累计不可用（sessionContext 投影未注册或缺会话）",
          }
        );
      }
      if (full.sessionId === undefined && callerSession === undefined) {
        return {
          ok: false,
          error:
            "无法定位会话：请显式传 session_id（当前会话未知且活动会话不唯一）",
        };
      }
      return buildReport(full);
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        {
          type: "text",
          text:
            value !== null &&
            typeof value === "object" &&
            typeof (value as { text?: unknown }).text === "string"
              ? String((value as { text: string }).text)
              : jsonText(value),
        },
      ],
    },
  };
}
