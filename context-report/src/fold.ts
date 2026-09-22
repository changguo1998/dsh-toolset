// src/fold.ts — 会话级累计折叠（纯函数，零宿主运行期依赖）
//
// 折叠口径（对齐宿主 dsh-session-stats / dsh-token-meter，见包 README「口径」节）：
//   - **只统计已关闭的步**（`step/end`）：步内的模型墙钟、token 分桶、回合计数先挂账在
//     在途账（scratch）上，`step/end` 时一次提交；未闭合的步一律不计（在途回合不算完成）；
//   - token 只累计 provider 实际上报的步（`assistant/message.usage`），缺桶按 0；
//   - `decodeTokens` 与 `decodeMs` 同步口径（都只在有 usage 的步上计），便于算 tok/s；
//   - 墙钟差为负、时间戳缺失（0）时跳过该样本，不写入负数；
//   - 未配对/倒挂的工具调用不计入工具墙钟。
//
// 性能：单遍 O(events)，每事件只读其判别键；未匹配的事件返回原状态引用（宿主据此零下游工作）。

import type { ReportEvent, SessionContextState } from "./types.ts";

/** 空日志初态（asOfSeq = -1，与宿主投影水位口径一致）。 */
export function createInitialState(): SessionContextState {
  return {
    asOfSeq: -1,
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
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
  /** 所属回合号（0 = 未知，`turn/start` 之前）。 */
  turn: number;
  /** `step/start` 时间戳。 */
  startMs: number;
  /** 本步首 token 时间戳（未记录时 0）。 */
  firstTokenMs: number;
  /** 本步模型消息时间戳（未记录 0 = 无模型消息）。 */
  messageMs: number;
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
  /** 当前回合号（`turn/start` 更新）。 */
  turn: number;
  /** 已计过数的最后一个回合号（同回合多步只计一次回合）。 */
  countedTurn: number;
  /** 当前打开步（无则 null）。 */
  open: StepLedger | null;
  /** 在途工具调用：callId → 发起时间。 */
  openCalls: Map<string, number>;
}

/** 事件时间戳：非有限正数按缺失处理（返回 0）。 */
function eventTime(event: ReportEvent): number {
  const t = event.time;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 0;
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

/** 判断流记录是否为「非空文本 / 推理增量」（首 token 判定）。 */
function isTokenDelta(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const chunk = entry as Record<string, unknown>;
  const kind = chunk["type"] ?? chunk["kind"];
  // 宿主 0.1.5-rc.2 实测形态：text-chunks / reasoning-chunks（texts 数组）。
  if (kind === "text-chunks" || kind === "reasoning-chunks") {
    const texts = chunk["texts"];
    return (
      Array.isArray(texts) &&
      texts.some((t) => typeof t === "string" && t.length > 0)
    );
  }
  if (kind !== "text-delta" && kind !== "reasoning-delta") return false;
  const text = chunk["text"];
  return typeof text === "string" && text.length > 0;
}

/**
 * 首 token 绝对时间：优先块增量自带的 `time0`（text-chunks / reasoning-chunks），
 * 退回增量 entry 的 `time`；都没有返回 0（由调用方按消息时间兜底）。
 */
function firstTokenTimeOf(data: Record<string, unknown>): number {
  const stream = data["stream"];
  if (!Array.isArray(stream)) return 0;
  for (const entry of stream) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const kind = record["type"] ?? record["kind"];
    if (kind === "text-chunks" || kind === "reasoning-chunks") {
      const texts = record["texts"];
      const hasText =
        Array.isArray(texts) &&
        texts.some((t) => typeof t === "string" && t.length > 0);
      if (!hasText) continue;
      const t0 = record["time0"];
      if (typeof t0 === "number" && Number.isFinite(t0) && t0 > 0) return t0;
      continue;
    }
    if (kind !== "text-delta" && kind !== "reasoning-delta") continue;
    const text = record["text"];
    if (typeof text !== "string" || text.length === 0) continue;
    const t = record["time"];
    if (typeof t === "number" && Number.isFinite(t) && t > 0) return t;
  }
  return 0;
}

/** `assistant/message` 载荷里的流记录判定（取 payload.stream 数组）。 */
function hasTokenDelta(data: Record<string, unknown>): boolean {
  const stream = data["stream"];
  if (!Array.isArray(stream)) return false;
  return stream.some(isTokenDelta);
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
 * @param seq - `step/end` 的事件序号（新水位）。
 * @returns 提交后的状态。
 */
function commitStep(
  state: SessionContextState,
  ledger: StepLedger,
  scratch: FoldScratch,
): SessionContextState {
  const hasMessage = ledger.messageMs > 0 && ledger.messageMs >= ledger.startMs;
  const llmMs = hasMessage ? ledger.messageMs - ledger.startMs : 0;
  const ttftMs =
    hasMessage && ledger.firstTokenMs > 0
      ? ledger.firstTokenMs - ledger.startMs
      : 0;
  const decodeMs =
    hasMessage &&
    ledger.firstTokenMs > 0 &&
    ledger.messageMs >= ledger.firstTokenMs
      ? ledger.messageMs - ledger.firstTokenMs
      : 0;
  // 回合计数：同回合多步只计一次（回合身份来自 turn/start；无回合信息的步不计回合）。
  const countsTurn = ledger.turn > 0 && ledger.turn !== scratch.countedTurn;
  if (countsTurn) scratch.countedTurn = ledger.turn;
  const usage = ledger.usage;
  return {
    ...state,
    asOfSeq: scratch.seq,
    steps: state.steps + 1,
    turns: state.turns + (countsTurn ? 1 : 0),
    llmMs: state.llmMs + llmMs,
    ttftMs: state.ttftMs + ttftMs,
    ttftSteps: state.ttftSteps + (ttftMs > 0 ? 1 : 0),
    decodeMs: state.decodeMs + decodeMs,
    decodeTokens: state.decodeTokens + (usage?.output ?? 0),
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
  const time = eventTime(event);
  const data = payloadOf(event);
  scratch.seq = eventSeq(event, index);
  // 结束标记：水位推进但不改计数（fork/续跑的定位依据）。
  if (type === "session/end-seed") return state;
  if (type === "turn/start") {
    scratch.turn = num(data["turn"]);
    return state;
  }
  if (type === "step/start") {
    // 无时间戳的步不可测墙钟，但仍可计一次步数（挂账用 0 表示未知）。
    scratch.open = {
      turn: num(data["turn"]) || scratch.turn,
      startMs: time,
      firstTokenMs: 0,
      messageMs: 0,
      usage: null,
    };
    scratch.openCalls.clear();
    return state;
  }
  if (type === "step/end") {
    const ledger = scratch.open ?? {
      turn: 0,
      startMs: 0,
      firstTokenMs: 0,
      messageMs: 0,
      usage: null,
    };
    scratch.open = null;
    scratch.openCalls.clear();
    return commitStep(state, ledger, scratch);
  }
  if (type === "assistant/attempt") {
    // 未提交 surface 消息的尝试：仅用于首 token 判定。
    const ledger = scratch.open;
    if (ledger !== null && ledger.firstTokenMs === 0) {
      const ft = firstTokenTimeOf(data);
      if (ft > 0) ledger.firstTokenMs = ft;
      else if (time > 0 && hasTokenDelta(data)) ledger.firstTokenMs = time;
    }
    return state;
  }
  if (type === "assistant/message") {
    const ledger = scratch.open;
    if (ledger !== null) {
      if (time > 0) ledger.messageMs = time;
      const buckets = usageBuckets(data);
      if (buckets !== null) ledger.usage = buckets;
      // 消息自带流记录时（无 attempt 前置）：优先块增量 time0 精确首 token，
      // 无 time0 的旧形态退回消息时间作上界
      if (ledger.firstTokenMs === 0) {
        const ft = firstTokenTimeOf(data);
        if (ft > 0) ledger.firstTokenMs = ft;
        else if (time > 0 && hasTokenDelta(data)) ledger.firstTokenMs = time;
      }
    }
    return state;
  }
  if (type === "tool/call") {
    const callId = data["callId"];
    if (typeof callId === "string" && time > 0)
      scratch.openCalls.set(callId, time);
    return state;
  }
  if (type === "tool/result") {
    const callId = toolResultCallId(data);
    if (callId !== null) {
      const started = scratch.openCalls.get(callId);
      if (started !== undefined) {
        scratch.openCalls.delete(callId);
        if (time > 0 && time >= started) {
          return {
            ...state,
            asOfSeq: scratch.seq,
            toolMs: state.toolMs + (time - started),
          };
        }
      }
    }
    return state;
  }
  return state;
}

/** 从 `tool/result` 载荷里取配对的 callId（缺省返回 null）。 */
function toolResultCallId(data: Record<string, unknown>): string | null {
  const direct = data["callId"];
  if (typeof direct === "string") return direct;
  const message = data["message"];
  if (message !== null && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const id = (block as Record<string, unknown>)["toolCallId"];
        if (typeof id === "string") return id;
      }
    }
  }
  return null;
}

/**
 * 折叠整段事件日志（新会话 / 缓存行缺失时的整段折叠路径）。
 * @param events - 会话事件（结构子集数组，可以是宿主 Session.events）。
 * @returns 会话级累计状态。
 */
export function foldSession(
  events: readonly ReportEvent[],
): SessionContextState {
  const scratch: FoldScratch = {
    seq: -1,
    turn: 0,
    countedTurn: 0,
    open: null,
    openCalls: new Map(),
  };
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
