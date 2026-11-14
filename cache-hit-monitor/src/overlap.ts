/**
 * 前缀重叠度计算（cache-hit-monitor 预估口径, 纯函数）。
 *
 * 口径（追踪文档决策 3/12）：预估可命中率 = 重叠长度 / 本次总输入。请求前没有 token
 * 计数, 用「消息条数」做等价代理: 重叠长度 = 上次与本次快照的共同前缀消息条数,
 * 本次总输入 = 本次快照消息条数（与 /stats 的实际分母 input+cacheRead 不同量纲,
 * 但同为「上下文量」的近似——README 已注明是粗估 + 容差）。
 *
 * 消息相等性: 按 role + content 结构深比较（`JSON.stringify` 规范化, 不看 source / id,
 * 那些与模型可见上下文无关）。
 */

/** 快照里单条消息的最小结构（deriveMessages() 的产物子集）。 */
export interface SnapshotMessage {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

function canonical(message: unknown): string {
  if (typeof message !== "object" || message === null) return String(message);
  const { role, content } = message as SnapshotMessage;
  return JSON.stringify({ role, content });
}

/**
 * 两个快照的共同前缀消息条数（逐条按 role+content 深比较, 遇第一条不等即停）。
 */
export function prefixOverlap(
  last: readonly unknown[],
  current: readonly unknown[],
): number {
  const n = Math.min(last.length, current.length);
  let i = 0;
  for (; i < n; i += 1) {
    if (canonical(last[i]) !== canonical(current[i])) break;
  }
  return i;
}

/**
 * 粗估命中率: 重叠条数 / 本次消息条数（0–1）。
 * 本次为空返回 0（无上下文可命中）; 上次为空返回 0（无基线, 属首次, 由调用方判 first）。
 */
export function estimateHitRate(overlap: number, currentCount: number): number {
  if (currentCount <= 0) return 0;
  return Math.min(1, overlap / currentCount);
}

/**
 * 实际命中率: cacheRead / (input + cacheRead)（与 /stats 同基准, 0–1）。
 * 分子分母都 <= 0 时返回 0（没有可判断的数据）。
 */
export function actualHitRate(cacheRead: number, input: number): number {
  const total = input + cacheRead;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, cacheRead / total));
}
