/**
 * 只读查询面 `ctx.backgroundDaemon`（设计 §C③）。
 *
 * 供 `/daemon` 与**后续** TUI 状态列块消费：`list` / `status` / `journal` 三个只读方法,
 * 不提供任何写入口。服务缺失时 TUI 侧按仓内惯例提示不可用（`ctx.get('backgroundDaemon')`）。
 */

import type { Journal } from "./journal.ts";
import type { RecordsBackend } from "./records.ts";
import type { Scheduler, SchedulerStatus } from "./scheduler.ts";
import type { TaskStore } from "./store.ts";
import type { DaemonTask, RunRecord, TaskMode } from "./types.ts";

/** 状态视图（`/daemon` 与将来的状态列块共用）。 */
export interface DaemonStatusView extends SchedulerStatus {
  storeFile: string;
  journalFile: string;
  /** 记录底座（`memory` = memory-base 注册 kind；`json` = 本地快照降级）。 */
  records: RecordsBackend;
  /** 启动时被隔离的坏行数（`records: "json"` 恒 0）。 */
  rejectedRows: number;
  /** 已注册渠道（`deliver` / `command`）。 */
  channels: TaskMode[];
  taskCount: number;
  journalCount: number;
}

/** 只读服务面。 */
export interface BackgroundDaemonService {
  list(): DaemonTask[];
  status(): DaemonStatusView;
  journal(limit?: number, taskId?: string): RunRecord[];
}

/** 服务面方法键清单（新增公开方法时必须同步；测试守卫断言两者一致）。 */
export const SERVICE_FACE_METHODS = ["list", "status", "journal"] as const;

export interface DaemonServiceDeps {
  store: TaskStore;
  journal: Journal;
  scheduler: Scheduler;
  channels: { list(): { mode: TaskMode }[] };
  /** 记录底座（缺省 `json`，与降级口径一致）。 */
  records?: RecordsBackend;
  rejectedRows?: number;
}

export function createDaemonService(
  deps: DaemonServiceDeps,
): BackgroundDaemonService {
  return {
    list: () => deps.store.list(),
    status: () => ({
      ...deps.scheduler.status(),
      storeFile: deps.store.file,
      journalFile: deps.journal.file,
      records: deps.records ?? "json",
      rejectedRows: deps.rejectedRows ?? 0,
      channels: deps.channels.list().map((channel) => channel.mode),
      taskCount: deps.store.list().length,
      journalCount: deps.journal.tail(Number.MAX_SAFE_INTEGER).length,
    }),
    journal: (limit, taskId) => deps.journal.tail(limit, taskId),
  };
}
