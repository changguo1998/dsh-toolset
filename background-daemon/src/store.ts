/**
 * 任务表：权威记录（任务定义 + 状态 + 下次触发）落 JSON 文件。
 *
 * 口径（设计 §C④）：
 * - **原子写**（写 tmp 再 rename）, 带 `schemaVersion`；
 * - 版本不认识 / JSON 损坏 / 记录非法（含选择器非规范化）→ **拒绝启用该面**,
 *   报错文案带路径, **不**静默清空（对齐宿主「损坏拒启、不发布部分目录」的取向）；
 * - 所有写操作是同步方法：单线程事件循环内每次读-改-写天然串行（设计 §A 时序口径 5
 *   的「单一 FIFO」在这里由同步方法承担, 不需要额外的队列）。
 *
 * 记录底座（设计 D19）：权威记录落 `memory-base` 的注册 kind（`daemon_task`，见
 * `records.ts`）——本类只保留**内存镜像 + JSON 快照**：JSON 是 memory-base 未挂载时的
 * 降级后端，也是首次迁移的导入源；`memory` 可用时由 `TaskMirror` 逐次写透
 * （追加式修订行，读侧取最新一条）。因此本类的同步方法签名不变（调度器不受影响）。
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { firstNext, isCanonicalSelector } from "./selectors.ts";
import type {
  DaemonTask,
  NewTaskInput,
  RunOutcome,
  TaskMode,
  TaskStatus,
  TaskTier,
} from "./types.ts";

/** 任务表 schema 版本（不认识即拒绝启用）。 */
export const TASK_STORE_VERSION = 1;

const TIERS: readonly TaskTier[] = ["S", "P", "U"];
const MODES: readonly TaskMode[] = ["deliver", "command"];
const STATUSES: readonly TaskStatus[] = ["active", "paused", "done", "missed"];
const OUTCOMES: readonly RunOutcome[] = [
  "delivered",
  "failed",
  "skipped",
  "missed",
];

export type TaskStoreLoadResult =
  { ok: true; tasks: DaemonTask[] } | { ok: false; error: string };

/** 已存记录的逐条校验（非法即整表拒绝启用）。 */
export function validateDaemonTask(raw: unknown): DaemonTask {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("记录不是对象");
  }
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("记录缺少 id");
  }
  const tier = record["tier"];
  if (typeof tier !== "string" || !TIERS.includes(tier as TaskTier)) {
    throw new Error(`记录 ${id} 的 tier 非法：${String(tier)}`);
  }
  const mode = record["mode"];
  if (typeof mode !== "string" || !MODES.includes(mode as TaskMode)) {
    throw new Error(`记录 ${id} 的 mode 非法：${String(mode)}`);
  }
  const selector = record["selector"];
  if (typeof selector !== "object" || selector === null) {
    throw new Error(`记录 ${id} 缺少 selector`);
  }
  if (!isCanonicalSelector(selector as DaemonTask["selector"])) {
    throw new Error(`记录 ${id} 的 selector 非规范化或非法`);
  }
  const payload = record["payload"];
  if (typeof payload !== "string" || payload.trim() === "") {
    throw new Error(`记录 ${id} 的 payload 非法`);
  }
  const sessionId = record["sessionId"];
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new Error(`记录 ${id} 的 sessionId 非法`);
  }
  const status = record["status"];
  if (typeof status !== "string" || !STATUSES.includes(status as TaskStatus)) {
    throw new Error(`记录 ${id} 的 status 非法：${String(status)}`);
  }
  const createdAt = record["createdAt"];
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    throw new Error(`记录 ${id} 的 createdAt 非法`);
  }
  const next = record["next"];
  if (next !== null && (typeof next !== "number" || !Number.isFinite(next))) {
    throw new Error(`记录 ${id} 的 next 非法`);
  }
  const lastFireAt = record["lastFireAt"];
  if (
    lastFireAt !== null &&
    (typeof lastFireAt !== "number" || !Number.isFinite(lastFireAt))
  ) {
    throw new Error(`记录 ${id} 的 lastFireAt 非法`);
  }
  const lastOutcome = record["lastOutcome"];
  if (
    lastOutcome !== null &&
    (typeof lastOutcome !== "string" ||
      !OUTCOMES.includes(lastOutcome as RunOutcome))
  ) {
    throw new Error(`记录 ${id} 的 lastOutcome 非法`);
  }
  const lastError = record["lastError"];
  if (lastError !== null && typeof lastError !== "string") {
    throw new Error(`记录 ${id} 的 lastError 非法`);
  }
  return {
    id,
    tier: tier as TaskTier,
    mode: mode as TaskMode,
    selector: selector as DaemonTask["selector"],
    payload,
    sessionId,
    status: status as TaskStatus,
    createdAt,
    next: next as number | null,
    lastFireAt: lastFireAt as number | null,
    lastOutcome: lastOutcome as RunOutcome | null,
    lastError: lastError as string | null,
  };
}

/**
 * 写透镜像（memory-base 记录底座; 缺省不接）。
 *
 * 方法必须**不抛**且**不阻塞**调用方：TaskStore 是同步面, 镜像内部按任务串成 FIFO,
 * 失败只累计到 `failures`（与「不重试、只记账」的口径一致）。
 */
export interface TaskMirror {
  save(task: DaemonTask): void;
  remove(task: DaemonTask): void;
}

/** 任务表（内存镜像 + 落盘）。 */
export class TaskStore {
  readonly #file: string;
  readonly #now: () => number;
  readonly #tasks = new Map<string, DaemonTask>();
  #mirror: TaskMirror | null = null;
  #snapshot = true;
  #error: string | null = null;

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
  }

  /** 接上写透镜像（memory-base 可用时调用；传 null 摘掉）。 */
  attachMirror(mirror: TaskMirror | null): void {
    this.#mirror = mirror;
  }

  /**
   * 关掉 JSON 快照（memory-base 作权威底座时调用）。
   *
   * 此时 JSON 既不是权威记录也不是迁移源, 继续每次写盘只会在只读 HOME 等场景
   * 引入无关失败。
   */
  disableSnapshot(): void {
    this.#snapshot = false;
  }

  /** 落盘路径（`/daemon` 与告警文案用）。 */
  get file(): string {
    return this.#file;
  }

  /** false = 面不可用（损坏 / 版本不符 / 记录非法）。 */
  get available(): boolean {
    return this.#error === null;
  }

  /** 不可用原因（含路径）；null = 可用。 */
  get error(): string | null {
    return this.#error;
  }

  /** 读盘并启用；文件缺失视为空表（首次使用）。 */
  load(): TaskStoreLoadResult {
    this.#tasks.clear();
    this.#error = null;
    if (!existsSync(this.#file)) return { ok: true, tasks: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#file, "utf8"));
    } catch (err) {
      const error = `任务表损坏（非合法 JSON）：${this.#file} — ${String(err)}`;
      this.#error = error;
      return { ok: false, error };
    }
    if (typeof parsed !== "object" || parsed === null) {
      const error = `任务表结构非法（要求对象）：${this.#file}`;
      this.#error = error;
      return { ok: false, error };
    }
    const root = parsed as Record<string, unknown>;
    if (root["schemaVersion"] !== TASK_STORE_VERSION) {
      const error =
        `任务表版本不兼容（schemaVersion=${String(root["schemaVersion"])}，` +
        `要求 ${TASK_STORE_VERSION}）：${this.#file}`;
      this.#error = error;
      return { ok: false, error };
    }
    const rawTasks = root["tasks"];
    if (!Array.isArray(rawTasks)) {
      const error = `任务表缺少 tasks 数组：${this.#file}`;
      this.#error = error;
      return { ok: false, error };
    }
    const loaded: DaemonTask[] = [];
    for (const raw of rawTasks) {
      try {
        loaded.push(validateDaemonTask(raw));
      } catch (err) {
        const error = `任务表记录非法：${this.#file} — ${
          err instanceof Error ? err.message : String(err)
        }`;
        this.#error = error;
        this.#tasks.clear();
        return { ok: false, error };
      }
    }
    for (const task of loaded) this.#tasks.set(task.id, task);
    return { ok: true, tasks: this.list() };
  }

  /**
   * 接管一批已从别的底座（memory-base）读出的任务。
   *
   * 不落盘, 也不校验两次（调用方负责校验）; 会清掉 JSON 侧的不可用状态——此时
   * 权威记录不在这份 JSON 上。
   */
  adopt(tasks: readonly DaemonTask[]): void {
    this.#tasks.clear();
    for (const task of tasks) this.#tasks.set(task.id, { ...task });
    this.#error = null;
  }

  /** 任务列表（按下次触发升序, `next` 为 null 的排最后；同序按创建时刻）。 */
  list(): DaemonTask[] {
    return [...this.#tasks.values()]
      .map((task) => ({ ...task }))
      .sort((left, right) => {
        const leftNext = left.next ?? Number.POSITIVE_INFINITY;
        const rightNext = right.next ?? Number.POSITIVE_INFINITY;
        if (leftNext !== rightNext) return leftNext - rightNext;
        return left.createdAt - right.createdAt;
      });
  }

  get(id: string): DaemonTask | undefined {
    const task = this.#tasks.get(id);
    return task === undefined ? undefined : { ...task };
  }

  /**
   * 新建任务：分配 id、记 `createdAt`、算首目标（一次性 = 固定时点；周期 = 下一次）。
   * 选择器应已规范化（调用方负责 `normalizeSelector`）。
   */
  create(input: NewTaskInput): DaemonTask {
    this.#assertAvailable();
    const createdAt = this.#now();
    const next = firstNext(input.selector, createdAt, createdAt);
    const task: DaemonTask = {
      id: `d-${randomUUID().slice(0, 8)}`,
      tier: input.tier ?? "S",
      mode: input.mode,
      selector: input.selector,
      payload: input.payload,
      sessionId: input.sessionId,
      status: "active",
      createdAt,
      next,
      lastFireAt: null,
      lastOutcome: null,
      lastError: null,
    };
    this.#tasks.set(task.id, task);
    this.#persist();
    this.#mirror?.save({ ...task });
    return { ...task };
  }

  /** 覆盖一条任务（调度器记账 / 暂停恢复用）。 */
  replace(task: DaemonTask): DaemonTask {
    this.#assertAvailable();
    if (!this.#tasks.has(task.id)) {
      throw new Error(`任务不存在：${task.id}`);
    }
    this.#tasks.set(task.id, { ...task });
    this.#persist();
    this.#mirror?.save({ ...task });
    return { ...task };
  }

  /** 局部更新（未给的字段不动）。 */
  update(id: string, patch: Partial<Omit<DaemonTask, "id">>): DaemonTask {
    this.#assertAvailable();
    const current = this.#tasks.get(id);
    if (current === undefined) throw new Error(`任务不存在：${id}`);
    const next: DaemonTask = { ...current, ...patch, id };
    this.#tasks.set(id, next);
    this.#persist();
    this.#mirror?.save({ ...next });
    return { ...next };
  }

  /** 删除一条任务；返回是否真的删掉了。 */
  remove(id: string): boolean {
    this.#assertAvailable();
    const existing = this.#tasks.get(id);
    if (existing === undefined) return false;
    this.#tasks.delete(id);
    this.#persist();
    this.#mirror?.remove(existing);
    return true;
  }

  #assertAvailable(): void {
    if (this.#error !== null) throw new Error(this.#error);
  }

  /** 原子写整表（tmp + rename）。 */
  #persist(): void {
    if (!this.#snapshot) return;
    const directory = path.dirname(this.#file);
    mkdirSync(directory, { recursive: true });
    const payload = JSON.stringify(
      { schemaVersion: TASK_STORE_VERSION, tasks: this.list() },
      null,
      2,
    );
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, this.#file);
  }
}
