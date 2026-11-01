/**
 * 引擎内部共享形状与会话内存态。
 *
 * 放各层都要用的数据形状（待注入段 `Segment` / 每回合用量 `TurnUsage` / 单会话记账
 * `SessionState` / 对齐尺度表）与只碰这些数据的纯函数（恢复判据、正文缓冲、淘汰、值预览）。
 * 不含事件分流（engine.ts）、匹配（evaluation.ts）、消费者唤醒（consumers.ts）与交付
 * （delivery.ts）。
 *
 * 容量口径集中在此：会话数上限、回合缓冲保留数、单条正文截断上限。
 */

import type { TurnUsage } from "./delivery.ts";
import type { RuleSource } from "./types.ts";

/** 单条 `assistant/message` 正文的缓冲上限（字符），超出截断（防长回复把内存撑大）。 */
export const TEXT_BUFFER_LIMIT = 200_000;

/** 保留的回合缓冲数（只留最近几回合）。 */
export const TURN_BUFFER_KEEP = 4;

/** 会话内存态上限（超过后淘汰最早插入的会话）。 */
export const SESSION_STATE_LIMIT = 64;

/** 对齐尺度（越靠后越细）。 */
export type Scale = "session" | "turn" | "step" | "tool";

/** 尺度从粗到细的顺序。 */
export const SCALE_ORDER: readonly Scale[] = [
  "session",
  "turn",
  "step",
  "tool",
];

/** 每消费者的对齐 flag（Set 成员 = true，缺省 = false）。 */
export interface ScaleFlags {
  startFired: Set<Scale>;
  endFired: Set<Scale>;
}

/** 节点 → 尺度与类（不在此表 = 不参与对齐合并，如 `compaction`）。 */
export const NODE_SCALES: ReadonlyMap<
  RuleSource,
  { scale: Scale; kind: "start" | "end" }
> = new Map([
  ["session-start", { scale: "session", kind: "start" }],
  ["user-message", { scale: "turn", kind: "start" }],
  ["turn-start", { scale: "turn", kind: "start" }],
  ["assistant-text", { scale: "turn", kind: "end" }],
  ["turn-end", { scale: "turn", kind: "end" }],
  ["step-start", { scale: "step", kind: "start" }],
  ["step-end", { scale: "step", kind: "end" }],
  ["tool-call", { scale: "tool", kind: "start" }],
  ["tool-result", { scale: "tool", kind: "end" }],
]);

/** 单会话内存态（回合号、节流记账、正文缓冲）。 */
export interface SessionState {
  /** 本会话是否为「恢复 / 重载」（含 fork 继承）：**首次**见到该会话时判定一次，会话内稳定
   *  （判据见 isResumedSession；供 `session-fresh` / `session-resumed` 谓词与消费者 ctx 使用）。 */
  resumed: boolean;
  /** 最近一次见到的回合号。 */
  turn: number;
  /** 本会话各回合的注入用量（条数 + 已用正文，用于上限与同内容去重）。 */
  injected: Map<number, TurnUsage>;
  /** 每规则最近一次命中（回合号 + 时刻）。 */
  fired: Map<string, { turn: number; time: number }>;
  /** 每消费者最近一次反馈（回合号 + 时刻）。 */
  consumerFired: Map<string, { turn: number; time: number }>;
  /** 每消费者的对齐 flag（尺度 × start / end）。 */
  consumerFlags: Map<string, ScaleFlags>;
  /** 回合正文缓冲：turn → 各 step 正文。 */
  buffers: Map<number, string[]>;
}

/**
 * 会话内存态（按需创建；超限淘汰最早插入的会话）。
 *
 * `session`（宿主 Session，结构面读取）只在**首次**创建该会话状态时参与 `resumed` 判定并记住；
 * 已有会话不覆盖——宿主 `seq` 会随事件增长，现读会让同一会话内的判定翻转（如 fresh 在
 * `session-start` 之后立刻变假）。缺省（只给 sessionId）按 fresh 处理。
 */
export function sessionStateOf(
  sessions: Map<string, SessionState>,
  sessionId: string,
  session?: unknown,
): SessionState {
  const existing = sessions.get(sessionId);
  if (existing !== undefined) return existing;
  if (sessions.size >= SESSION_STATE_LIMIT) {
    const oldest = sessions.keys().next();
    if (!oldest.done) sessions.delete(oldest.value);
  }
  const state: SessionState = {
    resumed: isResumedSession(session),
    turn: 0,
    injected: new Map(),
    fired: new Map(),
    consumerFired: new Map(),
    consumerFlags: new Map(),
    buffers: new Map(),
  };
  sessions.set(sessionId, state);
  return state;
}

/** 回合正文缓冲（有文本类规则或已注册消费者时才缓冲，超长截断）。 */
export function bufferText(
  state: SessionState,
  turn: number,
  text: string,
  needed: boolean,
  warn: (message: string) => void,
): void {
  if (text.length === 0) return;
  if (!needed) return;
  const list = state.buffers.get(turn) ?? [];
  if (text.length > TEXT_BUFFER_LIMIT) {
    // 截断对消费者不透明（显示面是全文、插件面只有前缀）：显式告警，使差异可观测
    warn(
      `回合 ${turn} 的单条 assistant/message 正文 ${text.length} 字符超过上限 ${TEXT_BUFFER_LIMIT}，已截断（消费者只看得到前 ${TEXT_BUFFER_LIMIT} 字符）`,
    );
  }
  list.push(text.slice(0, TEXT_BUFFER_LIMIT));
  state.buffers.set(turn, list);
}

/** 丢弃过旧回合缓冲与计数。 */
export function pruneBuffers(state: SessionState, keepTurn: number): void {
  for (const turn of state.buffers.keys()) {
    if (turn < keepTurn - TURN_BUFFER_KEEP) state.buffers.delete(turn);
  }
  state.buffers.delete(keepTurn);
}

/** 丢弃过旧回合的注入计数。 */
export function pruneCounters(state: SessionState, keepTurn: number): void {
  for (const turn of state.injected.keys()) {
    if (turn < keepTurn - TURN_BUFFER_KEEP) state.injected.delete(turn);
  }
}

/** 正整数计数（缺省 / 非法 / ≤ 0 一律算 0）：宿主计数字段的兜底。 */
function isPositiveCount(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 「从记录恢复 / 重载」（含 fork 继承）判据，读宿主 Session 的结构面：
 * - `seq` = 事件日志长度 getter（> 0 = 已有历史，宿主 `dsh-session-projection` 同口径）；
 * - `inheritedEventCount` = fork 继承前缀长度（> 0 = 继承了历史）。
 *
 * 两者任一为正即 resumed。属性读取抛错（会话已释放等）或字段缺失按 fresh 兜底，不向上抛。
 */
export function isResumedSession(session: unknown): boolean {
  if (session === null || typeof session !== "object") return false;
  try {
    const like = session as { seq?: unknown; inheritedEventCount?: unknown };
    return (
      isPositiveCount(like.seq) || isPositiveCount(like.inheritedEventCount)
    );
  } catch {
    return false;
  }
}

/** 值的一行预览（JSON 优先；循环引用 / BigInt 等不可序列化值退化为 `String`）。 */
export function previewValue(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") return text;
  } catch {
    // 循环引用 / BigInt：落到 String 兜底
  }
  try {
    return String(value);
  } catch {
    return "（无法序列化的值）";
  }
}

/** 本尺度及更细尺度（含自身，从粗到细）。 */
export function scalesFrom(scale: Scale): Scale[] {
  return SCALE_ORDER.slice(SCALE_ORDER.indexOf(scale));
}
