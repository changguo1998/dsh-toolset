// src/fold.ts — token 分桶折叠（纯函数，零宿主运行期依赖）
//
// 职责边界（2026-10-06 去重）：回合 / 步 / 墙钟 / 首 token / 解码统计由宿主官方
// `sessionStats` 投影提供，本折叠**不再重复计算**；这里只折官方空缺的 token 分桶。
// 分工与依据见 README「口径」节与
// docs/archived/2026-10-05-context-report-official-projections.md。
//   - **只统计已关闭的步**（`step/end`）：步内的 token 分桶先挂账在在途账（scratch）上，
//     `step/end` 时一次提交；未闭合的步一律不计；
//   - token 只累计 provider 实际上报的步（`assistant/message.usage`），缺桶按 0。
//
// 性能：单遍 O(events)，每事件只读其判别键；未匹配的事件返回原状态引用（宿主据此零下游工作）。

import type { ReportEvent, SessionContextState } from "./types.ts";

/** 空日志初态（asOfSeq = -1，与宿主投影水位口径一致）。 */
export function createInitialState(): SessionContextState {
  return {
    asOfSeq: -1,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    usageSamples: 0,
  };
}

/** 步内挂账：待 `step/end` 提交的样本（不进状态、不持久化）。 */
interface StepLedger {
  /** token 分桶（无 usage 时 null）。 */
  usage: {
    uncachedInput: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  } | null;
}

/** 折叠过程中的在途账（调用方按会话级持有，投影单元逐事件新建即可）。 */
export interface FoldScratch {
  /** 本条事件序号（缺省按下标）。 */
  seq: number;
  /** 当前打开步（无则 null）。 */
  open: StepLedger | null;
}

/** 事件序号：缺失时由调用方按下标补位。 */
function eventSeq(event: ReportEvent, index: number): number {
  const s = event.seq;
  return typeof s === "number" && Number.isFinite(s) ? s : index;
}

/** 数值载荷：非有限数或负数按 0 处理。 */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** 从 `assistant/message.usage` 抽取 token 分桶（无有效桶时返回 null）。 */
function usageBuckets(data: Record<string, unknown>): StepLedger["usage"] {
  const usage = data["usage"];
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const uncachedInput = num(u["inputTokens"]);
  const output = num(u["outputTokens"]);
  if (uncachedInput === 0 && output === 0) return null;
  return {
    uncachedInput,
    output,
    cacheRead: num(u["cacheReadTokens"]),
    cacheWrite: num(u["cacheWriteTokens"]),
    reasoning: num(u["reasoningTokens"]),
  };
}

/** 事件载荷取值（非对象一律按空对象，缺省处理）。 */
function payloadOf(event: ReportEvent): Record<string, unknown> {
  const data = event.data;
  return data !== null && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * 提交已关闭步的挂账（`step/end` 时调用）。
 * @param state - 当前状态。
 * @param ledger - 该步的挂账样本。
 * @param scratch - 在途账（取新水位）。
 * @returns 提交后的状态。
 */
function commitStep(
  state: SessionContextState,
  ledger: StepLedger,
  scratch: FoldScratch,
): SessionContextState {
  const usage = ledger.usage;
  return {
    ...state,
    asOfSeq: scratch.seq,
    uncachedInputTokens:
      state.uncachedInputTokens + (usage?.uncachedInput ?? 0),
    outputTokens: state.outputTokens + (usage?.output ?? 0),
    cacheReadTokens: state.cacheReadTokens + (usage?.cacheRead ?? 0),
    cacheWriteTokens: state.cacheWriteTokens + (usage?.cacheWrite ?? 0),
    reasoningTokens: state.reasoningTokens + (usage?.reasoning ?? 0),
    usageSamples: state.usageSamples + (usage !== null ? 1 : 0),
  };
}

/**
 * 折叠一条事件。未匹配的事件返回原状态引用；匹配时返回新状态（不可变更新）。
 * @param state - 已覆盖此前全部事件的状态。
 * @param event - 下一条事件（结构子集）。
 * @param scratch - 在途账（调用方按会话级持有）。
 * @param index - 事件下标（事件缺 seq 时补位）。
 * @returns 下一条状态。
 */
export function reduceEvent(
  state: SessionContextState,
  event: ReportEvent,
  scratch: FoldScratch,
  index: number,
): SessionContextState {
  const type = event.type;
  scratch.seq = eventSeq(event, index);
  // 结束标记：水位推进但不改计数（fork/续跑的定位依据）。
  if (type === "session/end-seed") return state;
  if (type === "step/start") {
    scratch.open = { usage: null };
    return state;
  }
  if (type === "step/end") {
    const ledger = scratch.open ?? { usage: null };
    scratch.open = null;
    return commitStep(state, ledger, scratch);
  }
  if (type === "assistant/message") {
    const ledger = scratch.open;
    if (ledger !== null) {
      const buckets = usageBuckets(payloadOf(event));
      if (buckets !== null) ledger.usage = buckets;
    }
    return state;
  }
  return state;
}

/**
 * 折叠整段事件日志（新会话 / 缓存行缺失时的整段折叠路径）。
 * @param events - 会话事件（结构子集数组，可以是宿主 Session.events）。
 * @returns token 分桶累计状态。
 */
export function foldSession(
  events: readonly ReportEvent[],
): SessionContextState {
  const scratch: FoldScratch = { seq: -1, open: null };
  let state = createInitialState();
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined) continue;
    state = reduceEvent(state, event, scratch, i);
  }
  // 水位是「已消费的最后一条事件」：无匹配事件时也要推进（宿主按 seq 判进度）。
  return state.asOfSeq === events.length - 1
    ? state
    : { ...state, asOfSeq: events.length - 1 };
}
