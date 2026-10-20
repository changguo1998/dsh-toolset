/**
 * 共享控制帐：跨实例的任务控制事件（取消 / 暂停 / 恢复）。
 *
 * 口径（追踪文档 `docs/implementation/2026-10-20-daemon-cross-instance-cancel.md` 决策 D1/D2）：
 * - 与 `tasks.json` / `journal.jsonl` 同作用域（同一状态目录）：同一 DSH_HOME 的多个 dsh
 *   实例天然共享；不依赖任何可选服务（`session-channel` 缺失时仍生效）；
 * - **append-only JSONL**：`{taskId, action, at}`；同一任务取**最后一条**为当前意图；
 * - **不轮转**（决策 D5）：只有人工 `cancel` / `pause` / `resume` 写入，量级可忽略；
 *   多进程压缩存在「读到旧内容再 rename 丢并发追加」的竞态；
 * - 读取容错：坏行（手改 / 写到一半的残行）跳过, **不告警**（残行是常态, 告警会变成噪声）；
 * - `apply()` 幂等（决策 D3）：每轮 `runDue` 前调用, 只改本地副本（`mirror: false`——
 *   执行操作的实例已写过自己的修订行）；进程重启后同样按控制帐收敛（控制帐兼作墓碑）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { isPeriodic, nextAfter } from "./selectors.ts";
import type { TaskStore } from "./store.ts";

/** 控制动作（`cancel` 删除、`pause` / `resume` 暂定与恢复）。 */
export type ControlAction = "cancel" | "pause" | "resume";

/** 一条控制事件。 */
export interface ControlEntry {
  taskId: string;
  action: ControlAction;
  at: number;
}

/** 控制帐选项。 */
export interface ControlLogOptions {
  warn?: (message: string) => void;
  now?: () => number;
}

const ACTIONS: readonly ControlAction[] = ["cancel", "pause", "resume"];

/** 共享控制帐（append-only JSONL）。 */
export class ControlLog {
  readonly #file: string;
  readonly #warn: (message: string) => void;
  readonly #now: () => number;

  constructor(file: string, options: ControlLogOptions = {}) {
    this.#file = file;
    this.#warn =
      options.warn ??
      ((message) => {
        process.stderr.write(`[background-daemon] warn: ${message}\n`);
      });
    this.#now = options.now ?? Date.now;
  }

  /** 落盘路径（排障与测试用）。 */
  get file(): string {
    return this.#file;
  }

  /**
   * 追加一条控制事件。
   *
   * 写失败只告警、不抛：控制帐是「尽力传播」面, 本实例的操作本身已经生效。
   */
  append(taskId: string, action: ControlAction, at?: number): void {
    const entry: ControlEntry = {
      taskId,
      action,
      at: Math.floor(at ?? this.#now()),
    };
    try {
      mkdirSync(path.dirname(this.#file), { recursive: true });
      appendFileSync(this.#file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      this.#warn(`控制帐写入失败（${taskId} / ${action}）：${String(err)}`);
    }
  }

  /** 读出全部**合法**事件（文件缺失 = 空；坏行静默跳过）。 */
  load(): ControlEntry[] {
    if (!existsSync(this.#file)) return [];
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch {
      return [];
    }
    const entries: ControlEntry[] = [];
    for (const line of text.split("\n")) {
      const entry = parseControlLine(line);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  /** 每个任务的最后一条事件（文件的写入顺序 = 时间顺序）。 */
  latest(
    entries: readonly ControlEntry[] = this.load(),
  ): Map<string, ControlEntry> {
    const map = new Map<string, ControlEntry>();
    for (const entry of entries) map.set(entry.taskId, entry);
    return map;
  }

  /**
   * 把控制帐收敛到本地任务表；返回实际改动条数（幂等：无改动返回 0）。
   *
   * - `cancel`：删除本地副本（不写透——目标会话可能已删）；
   * - `pause`：`active` → `paused`；
   * - `resume`：`paused` → `active`, 周期任务按当前时钟重算下次（与 `/daemon resume` 同口径）。
   */
  apply(store: TaskStore, now: number = this.#now()): number {
    let changed = 0;
    for (const entry of this.latest().values()) {
      const task = store.get(entry.taskId);
      if (task === undefined) continue;
      if (entry.action === "cancel") {
        store.remove(entry.taskId, { mirror: false });
        changed += 1;
        continue;
      }
      if (entry.action === "pause" && task.status === "active") {
        store.update(entry.taskId, { status: "paused" }, { mirror: false });
        changed += 1;
        continue;
      }
      if (entry.action === "resume" && task.status === "paused") {
        const next = isPeriodic(task.selector)
          ? nextAfter(task.selector, now, task.createdAt)
          : task.next;
        store.update(
          entry.taskId,
          { status: "active", next },
          { mirror: false },
        );
        changed += 1;
      }
    }
    return changed;
  }
}

/** 解析一行控制事件；形状不符返回 null（调用方静默跳过）。 */
function parseControlLine(line: string): ControlEntry | null {
  if (line.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const taskId = record["taskId"];
  if (typeof taskId !== "string" || taskId.trim() === "") return null;
  const action = record["action"];
  if (
    typeof action !== "string" ||
    !ACTIONS.includes(action as ControlAction)
  ) {
    return null;
  }
  const at = record["at"];
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { taskId, action: action as ControlAction, at: Math.floor(at) };
}
