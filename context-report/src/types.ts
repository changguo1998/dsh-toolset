// src/types.ts — 纯类型层（不 import 任何宿主包）
//
// 契约对齐 docs/host/DSH-CTX-API.md 与宿主类型声明（dsh 0.1.5-rc.2）：
//   - `fold.ts` 只吃宿主 `SessionEvent` 的结构子集（`ReportEvent`），故本包零宿主运行期依赖、
//     可在无 dsh 环境下单测；真实事件对象（含宿主事件类型）满足该结构面。
//   - 会话级累计值来自**两个已挂载的宿主投影**：会话统计（回合/步/墙钟）取官方
//     `sessionStats`，token 分桶取本包 `sessionContext`（官方空缺）；请求压力与模型容量
//     来自宿主 `ctx.tokenMeter.measure(session)`（见 main.ts 的 TokenMeterLike 结构面）。

/** 事件信封的结构子集（宿主 SessionEvent 可赋值给它）。 */
export interface ReportEvent {
  /** 事件类型判别键（未知类型一律跳过）。 */
  readonly type: string;
  /** 事件载荷（逐类型收窄，未知形态按缺省处理）。 */
  readonly data?: unknown;
  /** Unix epoch 毫秒；缺失按 0 处理（对应墙钟统计随之不可用）。 */
  readonly time?: number;
  /** 逻辑序号；缺失时按数组下标填充。 */
  readonly seq?: number;
  /** 进程内首条事件序号，用于区分 fork 继承前缀与本地事件。 */
  readonly firstLiveSeq?: number;
}

/** 请求压力的快照（宿主 TokenMeter.measure 的投影子集）。 */
export interface ContextPressureLike {
  /** 最近一次 provider 上报的 prompt 规模（不含回复输出）。 */
  readonly pressureTokens?: number;
  /** 下一次请求的 prompt 预估：pressure + 自采样以来的启发式重计价。 */
  readonly projectedTokens?: number;
  /** 最近一次已知的路由容量（模型上下文窗口）。 */
  readonly contextWindow?: number;
}

/** 下次请求上下文的启发式构成（宿主 ContextBreakdownProjection 子集）。 */
export interface ContextBreakdownLike {
  /** 最近一条存活 system prompt 的启发式 token 数。 */
  readonly systemTokens: number;
  /** 最新请求信封里工具 schema 的启发式 token 数。 */
  readonly toolsTokens: number;
  /** 其余可见 surface 节点的启发式 token 数。 */
  readonly messageTokens: number;
}

/**
 * 本包 host-only 投影 `sessionContext` 的状态：**只装官方没有的部分**——token 分桶。
 * 回合 / 步 / 墙钟 / 首 token / 解码统计一律读宿主官方 `sessionStats`（见 {@link SessionStatsLike}），
 * 本包不再自折叠（2026-10-06 去重，见 `docs/archived/2026-10-05-context-report-official-projections.md`）。
 * 纯 JSON、可持久化（投影单元的 state 契约）。
 */
export interface SessionContextState {
  /** 已折叠的最后一个事件 seq（`-1` = 空日志）。 */
  readonly asOfSeq: number;
  /** 未命中缓存的 prompt 输入 token 累计。 */
  readonly uncachedInputTokens: number;
  /** 输出 token 累计（含 reasoning，reasoning 不重复计入）。 */
  readonly outputTokens: number;
  /** 缓存读 token 累计。 */
  readonly cacheReadTokens: number;
  /** 缓存写 token 累计。 */
  readonly cacheWriteTokens: number;
  /** reasoning token 累计（输出的子集）。 */
  readonly reasoningTokens: number;
  /** 有 provider 上报 token 的步数（分母不可靠时的参考）。 */
  readonly usageSamples: number;
  /** 最近一次 provider 上报的路由（无则缺省）。 */
  readonly provider?: string;
  /** 最近一次 provider 上报的模型（无则缺省）。 */
  readonly model?: string;
}

/**
 * 官方 `sessionStats` 投影的**视图**子集（结构面；字段名与官方 `sessionStatsSchema` 逐一对应）：
 * `dsh-session-stats/lib/index.js:28-37`。官方 fold 与本包原自折叠口径一致，直接采用。
 */
export interface SessionStatsLike {
  /** 含至少一个已关闭步的回合数（同回合多步只计一次）。 */
  readonly turns: number;
  /** 已关闭的步数。 */
  readonly steps: number;
  /** 各步 `step/start` → `assistant/message` 墙钟合计 ms。 */
  readonly llmMs: number;
  /** `tool/call` → `tool/result` 配对墙钟合计 ms。 */
  readonly toolMs: number;
  /** 各步首 token 延迟合计 ms。 */
  readonly ttftMs: number;
  /** 已记录首 token 的步数（ttftMs 的分母）。 */
  readonly ttftSteps: number;
  /** 各步解码墙钟合计 ms（首 token → `assistant/message`）。 */
  readonly decodeMs: number;
  /** 与 decodeMs 同步口径的 provider 输出 token 合计。 */
  readonly decodeTokens: number;
}

/** 报告细节级别：summary 关键数字、standard 含 token/耗时、full 再加构成与口径。 */
export type ReportDetail = "summary" | "standard" | "full";

/** 渲染报告的输入：token 累计（本包投影）+ 会话统计（官方投影）+ 即时读数。 */
export interface ContextReportInput {
  /** 会话 id（可缺省，如未知）。 */
  readonly sessionId?: string;
  /** 本包 token 累计状态；缺省时按空状态渲染。 */
  readonly state?: SessionContextState;
  /** 官方 `sessionStats` 视图（回合 / 步 / 墙钟）；缺省即该组数字不可用。 */
  readonly stats?: SessionStatsLike;
  /** 即时请求压力（来自 token-meter）。 */
  readonly pressure?: ContextPressureLike;
  /** 即时上下文构成（当前未接宿主投影，保留字段）。 */
  readonly breakdown?: ContextBreakdownLike;
  /** 细节级别（缺省 standard）。 */
  readonly detail?: ReportDetail;
  /** 报告生成时间（Unix epoch ms；由调用方注入以便测试）。 */
  readonly generatedAt?: number;
}

/** 上下文占用（压力 / 模型容量）；容量未知时 occupancyPct 缺省。 */
export interface ContextOccupancy {
  /** 下一次请求的 prompt 预估 token。 */
  readonly projectedTokens?: number;
  /** 最近一次 provider 上报的 prompt token。 */
  readonly pressureTokens?: number;
  /** 模型上下文窗口 token。 */
  readonly contextWindow?: number;
  /** 占用百分比（保留一位小数）。 */
  readonly occupancyPct?: number;
}

/** 墙钟统计（会话累计，来自官方 `sessionStats` 投影）。 */
export interface ContextDurations {
  /** 模型调用墙钟合计 ms。 */
  readonly llmMs: number;
  /** 工具执行墙钟合计 ms。 */
  readonly toolMs: number;
  /** 首 token 延迟合计 ms。 */
  readonly ttftMs: number;
  /** 已记录首 token 的步数（ttftMs 的分母）。 */
  readonly ttftSteps: number;
  /** 解码墙钟合计 ms。 */
  readonly decodeMs: number;
  /** 与 decodeMs 同步口径的输出 token 合计（算解码速率用）。 */
  readonly decodeTokens: number;
}

/** token 分桶累计（输入/输出/缓存/推理）。 */
export interface TokenBuckets {
  /** 未命中缓存的 prompt 输入。 */
  readonly uncachedInput: number;
  /** 输出（含 reasoning）。 */
  readonly output: number;
  /** 缓存读。 */
  readonly cacheRead: number;
  /** 缓存写。 */
  readonly cacheWrite: number;
  /** reasoning（输出的子集，不重复计入总量）。 */
  readonly reasoning: number;
  /** 以上分桶之和（输入侧 + 输出）。 */
  readonly total: number;
}

/** 结构化报告（工具返回值；text 为同一份数据的文本渲染）。 */
export interface ContextReport {
  /** 会话 id。 */
  readonly sessionId?: string;
  /** 报告生成时间（Unix epoch ms）。 */
  readonly generatedAt: number;
  /** 细节级别。 */
  readonly detail: ReportDetail;
  /**
   * 会话累计来源（两组投影的在位情况）：官方 `sessionStats` 提供回合 / 步 / 墙钟，
   * 本包 `sessionContext` 提供 token 分桶；两者皆缺为 `unavailable`。
   */
  readonly projection:
    | "sessionStats+sessionContext"
    | "sessionStats"
    | "sessionContext"
    | "unavailable";
  /** 折叠水位（本包 token 状态已计入的最后一个事件 seq；空日志 `-1`）。 */
  readonly asOfSeq: number;
  /** 回合数（官方投影；缺省 0 表示不可用）。 */
  readonly turns: number;
  /** 步数（官方投影；缺省 0 表示不可用）。 */
  readonly steps: number;
  /** token 分桶累计。 */
  readonly tokens: TokenBuckets;
  /** 上下文占用（即时读数）。 */
  readonly occupancy: ContextOccupancy;
  /** 墙钟统计（detail != summary 时给出）。 */
  readonly durations?: ContextDurations;
  /** 下次请求上下文构成（当前仅 detail = full 且已接入时给出）。 */
  readonly breakdown?: ContextBreakdownLike;
  /** 最近一次上报的路由（detail != summary 时给出）。 */
  readonly route?: { readonly provider: string; readonly model: string };
  /** 渲染文本（人类可读，含口径提示）。 */
  readonly text: string;
}
