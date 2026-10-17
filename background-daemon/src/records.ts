/**
 * 记录底座适配：`memory-base` **冻结接口**（2026-10-17，见
 * `memory-base/docs/implementation/2026-10-17-slim-and-storage-surfaces.md`）。
 *
 * 契约要点（消费方视角，全部是结构面，不 import 对方代码）：
 * - `registerKind(spec): MemoryScope` **同步**返回写入句柄；句柄绑定 kind 与可写层；
 * - `scope.put({content, tier?, title?, importance?, sessionId?})` 异步写入,
 *   内容级闸门（隐私 / `preWrite`）不抛错而是返回 `{ids: [], skipped: {reason}}`；
 * - `scope.forget([{tier, ids}])` 真删并返回条数；
 * - 全局 `list({kind, tier?, project?, limit?, offset?})` 只读、跨层合并, 行带 `kind` / `tier`。
 *
 * 本模块的用法（没有 update 面, 故为**追加式修订行**）：
 * - 任务：`kind = daemon_task`, 每次状态变更写一条修订行（content 是任务快照 JSON）,
 *   读侧按 `(createdAt, id)` 取**最新一条**为当前状态；删除走 `forget`。
 * - 流水：`kind = daemon_run`, 每条一条行, 因此进入 `search`（「流水可搜索」）。
 *
 * 层映射（设计 D19 的 S / P / U 三档）：`S → session` / `P → project` / `U → user`。
 * S 层写入要求 `sessionId`（memory-base 侧硬要求）, 任务与流水记录都带它。
 */

import type { RunSink } from "./journal.ts";
import { validateDaemonTask, type TaskMirror } from "./store.ts";
import type { DaemonTask, RunRecord, TaskTier } from "./types.ts";

/** 记录底座的两种形态（`memory` = memory-base 注册 kind；`json` = 本地快照降级）。 */
export type RecordsBackend = "memory" | "json";

/** memory-base 的层（分档）。 */
export type Tier = "session" | "project" | "user";

/** 三层全集（注册句柄时声明为可写层）。 */
export const TIERS: readonly Tier[] = ["session", "project", "user"];

/** 任务记录的 kind 名（注册方自定, memory-base 不校验）。 */
export const KIND_TASK = "daemon_task";

/** 运行流水的 kind 名（进 FTS, 因此可搜索）。 */
export const KIND_RUN = "daemon_run";

/** 本包使用的全部 kind（`/daemon` 文案与测试共用）。 */
export const DAEMON_KINDS: readonly string[] = [KIND_TASK, KIND_RUN];

/** 写前钩子入参（冻结接口; 本包不注册 `preWrite`, 仅类型对齐）。 */
export interface KindWriteInputLike {
  content: string;
  title?: string;
  project: string;
  kind: string;
}

/** 写前钩子判定（冻结接口）。 */
export interface KindVerdictLike {
  accept: boolean;
  reason?: string;
  importance?: number;
}

/** 注册声明（冻结接口; 本包只用到 `kind` / `writableTiers`）。 */
export interface KindSpecLike {
  kind: string;
  table?: string;
  writableTiers?: readonly Tier[];
  preWrite?(
    input: KindWriteInputLike,
  ): KindVerdictLike | Promise<KindVerdictLike>;
}

/** 写入入参（冻结接口的子集）。 */
export interface ScopePutInputLike {
  content: string;
  tier?: Tier;
  project?: string;
  title?: string;
  importance?: number;
  source?: { kind: string; ref?: string; label?: string };
  sessionId?: string;
}

/** 写入结果（冻结接口）。 */
export interface PutResultLike {
  ids: number[];
  sourceId: number;
  created: number;
  skipped?: { reason: string };
}

/** 写入句柄（冻结接口）。 */
export interface MemoryScopeLike {
  readonly kind: string;
  readonly writableTiers: readonly Tier[];
  put(input: ScopePutInputLike): Promise<PutResultLike>;
  forget(refs: readonly { tier: Tier; ids: readonly number[] }[]): Promise<number>;
}

/** 列举入参（冻结接口）。 */
export interface ListOptionsLike {
  kind?: string;
  tier?: Tier;
  project?: string;
  limit?: number;
  offset?: number;
}

/** 存储行（冻结接口; 只写出本包读得到的字段）。 */
export interface StoreRowLike {
  id: number;
  kind: string;
  tier: Tier;
  project: string;
  title: string | null;
  content: string;
  importance: number;
  sourceId: number | null;
  sessionId: string | null;
  createdAt: number;
}

/** 全局面 `ctx.get("memory")` 的结构子集（本包只用注册与列举）。 */
export interface MemoryServiceLike {
  registerKind(spec: KindSpecLike): MemoryScopeLike;
  list?(opts?: ListOptionsLike): Promise<StoreRowLike[]>;
  search?(opts: {
    query: string;
    kind?: string;
    tier?: Tier;
    project?: string;
    limit?: number;
    fuzzy?: boolean;
  }): Promise<unknown[]>;
}

/** 本包注册的两个句柄。 */
export interface DaemonKinds {
  task: MemoryScopeLike;
  run: MemoryScopeLike;
}

/**
 * 注册本包的两个 kind（每次装配调用一次）。
 *
 * 可写层声明为三层全集：任务分档由用户指定（S / P / U）, 句柄必须能写对应的层；
 * 越权层的拒绝因此发生在**任务记录本身的 tier 校验**上, 而不是句柄注册期。
 */
export function registerDaemonKinds(memory: MemoryServiceLike): DaemonKinds {
  return {
    task: memory.registerKind({ kind: KIND_TASK, writableTiers: TIERS }),
    run: memory.registerKind({ kind: KIND_RUN, writableTiers: TIERS }),
  };
}

const TIER_OF_TASK: Record<TaskTier, Tier> = {
  S: "session",
  P: "project",
  U: "user",
};

const TASK_TIER_OF: Record<Tier, TaskTier> = {
  session: "S",
  project: "P",
  user: "U",
};

/** 分档 → 层。 */
export function tierForTask(tier: TaskTier): Tier {
  return TIER_OF_TASK[tier];
}

/** 层 → 分档。 */
export function taskTierFor(tier: Tier): TaskTier {
  return TASK_TIER_OF[tier];
}

/** 层是否合法（读侧收到的行可能来自手改 / 别的版本）。 */
export function isTier(value: unknown): value is Tier {
  return value === "session" || value === "project" || value === "user";
}

/**
 * 任务快照编码。
 *
 * 外层带 `syncedAt`：修订行的 content 必须逐次不同, 否则 memory-base 的
 * `content_hash` 去重可能把「状态未变但重新写一次」合并掉, 读侧就分不清先后。
 */
export function encodeTaskSnapshot(
  task: DaemonTask,
  syncedAt: number = Date.now(),
): string {
  return JSON.stringify({ task, syncedAt: Math.floor(syncedAt) });
}

export type DecodeResult =
  | { ok: true; task: DaemonTask }
  | { ok: false; reason: string };

/** 任务快照解码（兼容「外层包装」与「裸任务对象」两种形态）。 */
export function decodeTaskSnapshot(content: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { ok: false, reason: `非合法 JSON：${String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "快照不是对象" };
  }
  const wrapped = (parsed as Record<string, unknown>)["task"];
  const candidate = wrapped === undefined ? parsed : wrapped;
  try {
    return { ok: true, task: validateDaemonTask(candidate) };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface LoadTasksOptions {
  /** 每页条数（缺省 500）。 */
  pageSize?: number;
  /** 分页上限保护（缺省 200 页, 即 10 万行）。 */
  maxPages?: number;
  /** 坏行告警（缺省交给调用方的 warn）。 */
  warn?: (message: string) => void;
}

/** 读盘结果：当前任务、修订索引、被隔离的坏行。 */
export interface LoadedTasks {
  tasks: DaemonTask[];
  /** 任务 id → 层 → 该任务全部修订行 id（升序）。删除时按层 `forget`。 */
  revisions: Map<string, Map<Tier, number[]>>;
  /** 坏行（不加载, 只告警；行还在库里, 由用户决定是否清理）。 */
  rejected: { rowId: number; reason: string }[];
}

/**
 * 从 memory-base 读出任务表。
 *
 * - 分页遍历 `list({kind})`（跨层合并, 行自带 `tier`）；
 * - 每条任务取 `(createdAt, id)` 最大的修订为当前状态；
 * - 坏行（解码失败 / 层与任务分档不符）进 `rejected`, 不参与加载。
 */
export async function loadTasks(
  memory: MemoryServiceLike,
  scope: MemoryScopeLike,
  options: LoadTasksOptions = {},
): Promise<LoadedTasks> {
  const list = memory.list;
  if (typeof list !== "function") {
    throw new Error("memory-base 缺少 list 面（冻结接口要求全局面提供 list）");
  }
  const pageSize =
    options.pageSize !== undefined && options.pageSize > 0
      ? Math.floor(options.pageSize)
      : 500;
  const maxPages =
    options.maxPages !== undefined && options.maxPages > 0
      ? Math.floor(options.maxPages)
      : 200;
  const rows: StoreRowLike[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await list.call(memory, {
      kind: scope.kind,
      limit: pageSize,
      offset: page * pageSize,
    });
    for (const row of batch) rows.push(row);
    if (batch.length < pageSize) break;
    if (page === maxPages - 1) {
      options.warn?.(
        `任务行数超过分页上限（${maxPages * pageSize} 行）, 只加载了前 ${rows.length} 行`,
      );
    }
  }

  const rejected: { rowId: number; reason: string }[] = [];
  const revisions = new Map<string, Map<Tier, number[]>>();
  const latest = new Map<
    string,
    { task: DaemonTask; createdAt: number; rowId: number }
  >();

  const matching = rows.filter((row) =>
    typeof row.kind === "string" ? row.kind === scope.kind : true,
  );
  matching.sort(
    (left, right) =>
      (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.id - right.id,
  );
  for (const row of matching) {
    const decoded = decodeTaskSnapshot(row.content);
    if (!decoded.ok) {
      rejected.push({ rowId: row.id, reason: decoded.reason });
      continue;
    }
    const task = decoded.task;
    const expectedTier = tierForTask(task.tier);
    const rowTier = isTier(row.tier) ? row.tier : null;
    if (rowTier !== null && rowTier !== expectedTier) {
      rejected.push({
        rowId: row.id,
        reason: `层不匹配（行 ${rowTier} / 任务 ${expectedTier}）`,
      });
      continue;
    }
    const bucket = revisions.get(task.id) ?? new Map<Tier, number[]>();
    revisions.set(task.id, bucket);
    const ids = bucket.get(expectedTier) ?? [];
    ids.push(row.id);
    bucket.set(expectedTier, ids);

    const createdAt = typeof row.createdAt === "number" ? row.createdAt : 0;
    const current = latest.get(task.id);
    if (
      current === undefined ||
      createdAt > current.createdAt ||
      (createdAt === current.createdAt && row.id > current.rowId)
    ) {
      latest.set(task.id, { task, createdAt, rowId: row.id });
    }
  }

  const tasks = [...latest.values()]
    .map((entry) => entry.task)
    .sort((left, right) => {
      const leftNext = left.next ?? Number.POSITIVE_INFINITY;
      const rightNext = right.next ?? Number.POSITIVE_INFINITY;
      if (leftNext !== rightNext) return leftNext - rightNext;
      return left.createdAt - right.createdAt;
    });

  for (const item of rejected) {
    options.warn?.(`任务行被隔离（不加载）：行 ${item.rowId} — ${item.reason}`);
  }
  return { tasks, revisions, rejected };
}

export interface MemoryTaskMirrorOptions {
  /** 启动时从 `loadTasks` 拿到的修订索引（删除时要按层 `forget`）。 */
  revisions?: Map<string, Map<Tier, number[]>>;
  warn?: (message: string) => void;
  now?: () => number;
}

/**
 * 任务表的写透镜像：把每次变更写成 `daemon_task` 的一条修订行。
 *
 * 同步面（`TaskMirror`）→ 内部按任务串成 FIFO（同一任务的 save / remove 不乱序）;
 * 失败只累计到 `failures`（不重试、不抛给调度器）。
 */
export class MemoryTaskMirror implements TaskMirror {
  readonly #scope: MemoryScopeLike;
  readonly #warn: (message: string) => void;
  readonly #now: () => number;
  readonly #revisions: Map<string, Map<Tier, number[]>>;
  readonly #chains = new Map<string, Promise<void>>();
  readonly #failures: { taskId: string; message: string }[] = [];

  constructor(scope: MemoryScopeLike, options: MemoryTaskMirrorOptions = {}) {
    this.#scope = scope;
    this.#warn =
      options.warn ??
      ((message) => {
        process.stderr.write(`[background-daemon] warn: ${message}\n`);
      });
    this.#now = options.now ?? Date.now;
    this.#revisions = options.revisions ?? new Map();
  }

  save(task: DaemonTask): void {
    this.#enqueue(task.id, async () => {
      const tier = tierForTask(task.tier);
      const result = await this.#scope.put({
        content: encodeTaskSnapshot(task, this.#now()),
        tier,
        title: task.id,
        importance: 3,
        // S 层要求 sessionId；P / U 层给了就落列（留痕）
        sessionId: task.sessionId,
      });
      if (result.ids.length === 0) {
        this.#fail(
          task.id,
          `写入被拒（${result.skipped?.reason ?? "unknown"}）`,
        );
        return;
      }
      const bucket = this.#revisions.get(task.id) ?? new Map<Tier, number[]>();
      this.#revisions.set(task.id, bucket);
      const ids = bucket.get(tier) ?? [];
      ids.push(...result.ids);
      bucket.set(tier, ids);
    });
  }

  remove(task: DaemonTask): void {
    this.#enqueue(task.id, async () => {
      const tier = tierForTask(task.tier);
      const bucket = this.#revisions.get(task.id);
      const ids = bucket?.get(tier);
      if (bucket === undefined || ids === undefined || ids.length === 0) {
        // 还没写进去过（或已删）：没有 id 可删, 不算失败
        return;
      }
      await this.#scope.forget([{ tier, ids: [...ids] }]);
      bucket.delete(tier);
      if (bucket.size === 0) this.#revisions.delete(task.id);
    });
  }

  /** 等在途写入 / 删除结束（关闭与测试用）。 */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#chains.values()]);
  }

  /** 写入失败（被拒 / 抛错 / 内容级 skip）, 供 `/daemon` 与日志展示。 */
  get failures(): readonly { taskId: string; message: string }[] {
    return this.#failures;
  }

  /** 某任务当前记录的修订行（测试与排障用）。 */
  revisionsFor(taskId: string): { tier: Tier; ids: number[] }[] {
    const bucket = this.#revisions.get(taskId);
    if (bucket === undefined) return [];
    return [...bucket.entries()].map(([tier, ids]) => ({ tier, ids: [...ids] }));
  }

  #fail(taskId: string, message: string): void {
    this.#failures.push({ taskId, message });
    this.#warn(`任务写入 memory-base 失败（${taskId}）：${message}`);
  }

  #enqueue(taskId: string, work: () => Promise<void>): void {
    const previous = this.#chains.get(taskId) ?? Promise.resolve();
    const next = previous.then(work).catch((err: unknown) => {
      this.#fail(
        taskId,
        err instanceof Error ? err.message : String(err),
      );
    });
    this.#chains.set(taskId, next);
    void next.then(() => {
      if (this.#chains.get(taskId) === next) this.#chains.delete(taskId);
    });
  }
}

export interface RunSinkOptions {
  warn?: (message: string) => void;
  now?: () => number;
  /** 流水行的重要度（缺省 2：低于任务, 便于按重要度过滤）。 */
  importance?: number;
}

/**
 * 流水外送口：每条流水写一行 `daemon_run`（append-only, 因此可被 `search` 检索）。
 *
 * 与任务表的差别：流水不需要「最新一条」语义, 也不需要在关闭时精确对账 ——
 * 写失败只告警（流水是账本, 不是权威状态）。
 */
export function createRunSink(
  scope: MemoryScopeLike,
  options: RunSinkOptions = {},
): RunSink {
  const warn =
    options.warn ??
    ((message) => {
      process.stderr.write(`[background-daemon] warn: ${message}\n`);
    });
  const now = options.now ?? Date.now;
  const importance = options.importance ?? 2;
  return (record: RunRecord): void => {
    const tier = tierForTask(record.tier ?? "S");
    const content = JSON.stringify({ ...record, syncedAt: Math.floor(now()) });
    void scope
      .put({
        content,
        tier,
        title: `${record.taskId}@${record.at}`,
        importance,
        ...(record.sessionId === "" ? {} : { sessionId: record.sessionId }),
      })
      .then((result) => {
        if (result.ids.length === 0) {
          warn(
            `流水未入库（${result.skipped?.reason ?? "unknown"}）：${record.taskId}`,
          );
        }
      })
      .catch((err: unknown) => {
        warn(`流水入库失败（${record.taskId}）：${String(err)}`);
      });
  };
}
