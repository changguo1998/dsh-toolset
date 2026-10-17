/**
 * 到期决策与补发口径（纯函数, 时钟由调用方注入）。
 *
 * 口径（设计 §A 关键时序 2 与 §C④）：
 * - 周期任务只补发**最近一次**错过的发生时点（不是逐次补齐）;
 * - 一次性任务过期但在**补发窗口**内 → 仍触发一次; 超窗 → `missed`（不静默丢弃）;
 * - 暂停期间到点 → `missed`（原因 `paused`）, 解除暂停时按当前时钟重算（待裁定项按此缺省）;
 * - 终态（`done` / `missed`）不再触发。
 */

import { isPeriodic, nextAfter, type Selector } from "./selectors.ts";
import type { TaskStatus } from "./types.ts";

/** 任务状态（`active` = 参与调度; 其余为暂停 / 终态）。见 `types.ts`。 */
export type { TaskStatus };

/** 一次性任务过期的补发窗口缺省值（缺省 24 h, 可经 config 覆盖）。 */
export const DEFAULT_CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 决策所需的任务切片（不依赖完整任务记录, 便于纯函数测试）。 */
export interface DueInput {
  status: TaskStatus;
  selector: Selector;
  /** 任务创建时刻（`every_seconds` 相位基准）。 */
  anchor: number;
  /** 已算好的下次触发时刻；null = 不再触发。 */
  next: number | null;
}

export type DueDecision =
  | { kind: "idle" }
  | { kind: "fire"; fireAt: number; next: number | null }
  | { kind: "missed"; reason: "expired" | "paused" };

/**
 * 单任务的到期决策。
 *
 * @param catchUpWindowMs 一次性任务过期后仍可补发的窗口（< 0 视为不补发）。
 */
export function decide(
  task: DueInput,
  now: number,
  catchUpWindowMs: number = DEFAULT_CATCH_UP_WINDOW_MS,
): DueDecision {
  if (task.status !== "active" && task.status !== "paused") {
    return { kind: "idle" };
  }
  if (task.next === null) return { kind: "idle" };
  if (task.next > now) return { kind: "idle" };
  if (task.status === "paused") {
    // 暂停期间到点：记 `missed`, 不补做（解除暂停时按当时的时钟重算下次）
    return { kind: "missed", reason: "paused" };
  }
  if (!isPeriodic(task.selector)) {
    if (now - task.next <= catchUpWindowMs) {
      return { kind: "fire", fireAt: task.next, next: null };
    }
    return { kind: "missed", reason: "expired" };
  }
  // 周期：只补最近一次 —— 触发一次, 下次从「现在」重算（跳过中间的多次）
  return {
    kind: "fire",
    fireAt: task.next,
    next: nextAfter(task.selector, now, task.anchor),
  };
}

/** 尚未到期的最近触发时刻（调度器据此排单 timer）；null = 无待触发任务。 */
export function nextWakeAt(tasks: readonly DueInput[]): number | null {
  let earliest: number | null = null;
  for (const task of tasks) {
    if (task.status !== "active") continue;
    if (task.next === null) continue;
    if (earliest === null || task.next < earliest) earliest = task.next;
  }
  return earliest;
}

/** 计划到点即触发（含已过期）= 该任务是否应立即处理。 */
export function isDue(task: DueInput, now: number): boolean {
  return task.next !== null && task.next <= now;
}
