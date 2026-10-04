// src/tasks.ts — 委托任务的纯函数面（常量、注入/通知文案、结果截断、状态判定）。
//
// 与 IO 解耦：便于单测；Redis 读写见 broker.ts，服务面组装见 index.ts。

import type { TaskRecord, TaskStatus } from "./types.ts";

/** 任务记录缺省 TTL：7 天（结果回收后仍可查询，过期自动清）。 */
export const DEFAULT_TASK_TTL_SEC = 7 * 24 * 60 * 60;

/** 任务缺省超时：1800 秒（读取时懒判定为 `timeout`）。 */
export const DEFAULT_TASK_TIMEOUT_SEC = 1800;

/** 任务结果全文存储上限（UTF-8 字节，超出截断并标注）。 */
export const DEFAULT_TASK_RESULT_MAX_BYTES = 64 * 1024;

/** 回传通知注入正文的上限（UTF-8 字节，超出截断并标注；全文仍在任务表里）。 */
export const DEFAULT_TASK_NOTIFY_MAX_BYTES = 8 * 1024;

/** 任务正文上限（复用消息上限口径，避免注入体过大）。 */
export const DEFAULT_TASK_TEXT_MAX_BYTES = 8192;

/** 每会话任务索引保留条数（新→旧，超出丢弃最旧）。 */
export const TASK_INDEX_MAX = 50;

/** 终态集合（`isTerminalTaskStatus` 判定用）。 */
const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "done",
  "failed",
  "canceled",
  "timeout",
]);

/** 是否终态（终态不可再被覆盖，除显式工具结果优先于 auto 的例外见 `applyTaskPatch`）。 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

/** 按 UTF-8 字节截断（不切多字节字符；返回截断后文本与是否截断）。 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text !== "" };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  let end = maxBytes;
  while (end > 0) {
    const slice = text.slice(0, end);
    if (Buffer.byteLength(slice, "utf8") <= maxBytes) {
      return { text: slice, truncated: true };
    }
    end -= 1;
  }
  return { text: "", truncated: true };
}

/**
 * 任务注入正文（发给 worker）：`TASK <id>: <正文>` + 回传提示。
 * 注意：**不带** `[CHANNEL](来源)` 前缀——投递路径（`#deliver`）会统一加，避免双前缀。
 */
export function taskInjectionText(
  task: Pick<TaskRecord, "id" | "text">,
): string {
  return (
    `TASK ${task.id}: ${task.text}\n` +
    `（任务 ${task.id}：完成后可直接结束本轮，结果会自动回传；` +
    `如需指定内容，调用 channel_task_result 工具回传。）`
  );
}

/** 结果回传通知正文（发给委托方）：`RESULT <id>: <结果>`，带截断标注。 */
export function resultNotificationText(
  task: Pick<TaskRecord, "id" | "result" | "resultTruncated">,
  maxBytes: number = DEFAULT_TASK_NOTIFY_MAX_BYTES,
): string {
  const raw = task.result ?? "";
  const { text, truncated } = truncateUtf8(raw, maxBytes);
  const mark =
    task.resultTruncated === true || truncated ? "\n[…结果已截断]" : "";
  return `RESULT ${task.id}: ${text}${mark}`;
}

/** 失败/超时通知正文（发给委托方）。 */
export function failureNotificationText(
  task: Pick<TaskRecord, "id" | "status" | "error">,
): string {
  const reason = task.error ?? task.status;
  return `${task.status.toUpperCase()} ${task.id}: ${reason}`;
}

/**
 * 任务记录补丁的合并规则（纯函数，供 broker 的读改写与测试共用）：
 * - 终态不可被非终态覆盖（防 auto 回收把 canceled 翻回 running）；
 * - `tool` 来源结果可覆盖 `auto` 来源结果（显式回传优先）；
 * - 其余字段后写覆盖前写。
 * @param current - 当前记录。
 * @param patch - 待应用补丁。
 * @param now - 本次更新时刻（epoch ms）。
 * @returns 合并后的记录（未变化时返回 current）。
 */
export function applyTaskPatch(
  current: TaskRecord,
  patch: Partial<TaskRecord>,
  now: number,
): TaskRecord {
  const next: TaskRecord = { ...current };
  for (const [key, value] of Object.entries(patch) as [
    keyof TaskRecord,
    unknown,
  ][]) {
    if (value === undefined) continue;
    if (key === "status") {
      const wanted = value as TaskStatus;
      const refusing =
        isTerminalTaskStatus(current.status) && !isTerminalTaskStatus(wanted);
      const autoOverTool =
        current.resultSource === "tool" && patch.resultSource !== "tool";
      if (refusing || autoOverTool) continue;
    }
    if (
      key === "result" &&
      current.resultSource === "tool" &&
      patch.resultSource !== "tool"
    ) {
      continue;
    }
    (next[key] as unknown) = value;
  }
  next.updatedAt = now;
  return next;
}

/** 懒判定超时：非终态且已过 deadline → 返回带 `timeout` 的记录（否则原样返回）。 */
export function withTimeoutCheck(task: TaskRecord, now: number): TaskRecord {
  if (task.deadline === undefined || isTerminalTaskStatus(task.status)) {
    return task;
  }
  if (now < task.deadline) return task;
  return {
    ...task,
    status: "timeout",
    error: task.error ?? "等待 worker 结果超时",
    updatedAt: now,
  };
}
