// task-engine/src/engine-store.ts — 引擎状态层：事件流 / 物化树 / 就绪池 / 只读视图 / 周期快照
//
// 状态与视图都只在这里落：引擎操作层只 append 事件 + 重算，视图经本层读取；
// 就绪池（DFS 栈 + fan-out 有界并发）的判据也只读本层状态。

import { logEvent, materialize, toNested } from "./events.ts";
import type { GateConfig } from "./gate.ts";
import type { TaskEngineSnapshot } from "./engine-types.ts";
import type {
  Frame,
  FrameId,
  LoggedPlanEvent,
  NestedTaskItem,
  PlanEvent,
  TaskTree,
} from "./types.ts";

/** 状态层构造选项：恢复时给既有事件流，正常首次构造留空。 */
export interface EngineStoreOptions {
  log?: LoggedPlanEvent[];
  config: GateConfig;
  snapshotPath?: string;
}

export class EngineStore {
  readonly log: LoggedPlanEvent[];
  readonly config: GateConfig;
  /** 事件流物化出的树（每次 recompute 整体替换；空日志给出空树） */
  private state: TaskTree;
  /** 就绪池：DFS 栈（push 逆序、pop 先序）+ 去重集合 */
  private pool: FrameId[] = [];
  private inPool = new Set<FrameId>();
  private snapshotPath?: string;
  /** 周期快照写盘串行链：避免并发 fire-and-forget 写乱序（新快照覆盖旧快照） */
  private snapshotChain: Promise<void> = Promise.resolve();

  constructor(opts: EngineStoreOptions) {
    this.config = opts.config;
    this.log = opts.log === undefined ? [] : [...opts.log];
    this.snapshotPath = opts.snapshotPath;
    // 空日志（首次构造）给空树：materialize 要求事件流自带 root-created，
    // 引擎随后 append 第一条 root-created 并 recompute
    this.state =
      this.log.length > 0
        ? materialize(this.log)
        : { rootId: "", rootIds: [], frames: new Map() };
  }

  /** 物化树（引擎操作层按帧 id 查表用） */
  get tree(): TaskTree {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // 就绪池（fan-out：多执行器 + 有界并发上限）
  // -------------------------------------------------------------------------

  /** 当前在途（active）帧数：fan-out 并发计数 */
  activeCount(): number {
    let n = 0;
    for (const f of this.tree.frames.values()) {
      if (f.status === "active") n += 1;
    }
    return n;
  }

  /**
   * 取下一个待处理帧（先序）并激活它。
   * fan-out（BACKLOG #13）：active 帧数达 maxConcurrent 上限时返回 undefined
   * （不消费候选），留待某个执行器完成后释放容量再次取用。
   */
  nextReady(): FrameId | undefined {
    if (this.activeCount() >= this.config.maxConcurrent) return undefined;
    const id = this.pool.pop();
    if (id === undefined) return undefined;
    this.inPool.delete(id);
    const f = this.tree.frames.get(id);
    if (f === undefined || f.status !== "pending") return undefined;
    this.append({ type: "plan/frame-activated", frame: id });
    this.recompute();
    return id;
  }

  /** 就绪池首个候选帧（不消费）：用于 step 裁决的 next 提示 */
  peekNextReady(): FrameId | null {
    if (this.activeCount() >= this.config.maxConcurrent) return null;
    for (let i = this.pool.length - 1; i >= 0; i -= 1) {
      const id = this.pool[i];
      if (id === undefined) continue;
      const f = this.tree.frames.get(id);
      if (f !== undefined && f.status === "pending") return id;
    }
    return null;
  }

  pushPool(id: FrameId): void {
    if (this.inPool.has(id)) return;
    this.inPool.add(id);
    // 逆序入栈 → 先序出栈（§14.2 DFS）
    this.pool.push(id);
  }

  pushPoolFront(id: FrameId): void {
    // 打回重试：放回栈顶（先序最先）
    if (this.inPool.has(id)) return;
    this.inPool.add(id);
    this.pool.push(id);
  }

  // -------------------------------------------------------------------------
  // 视图与快照
  // -------------------------------------------------------------------------

  /** 嵌套任务列表（parent_id + order，先序展开） */
  nested(): NestedTaskItem[] {
    return toNested(this.tree);
  }

  /** 扁平帧表（深拷贝，防外部改动） */
  frames(): Map<FrameId, Frame> {
    return new Map(this.tree.frames);
  }

  /** 根帧（存在返回；根缺失抛错） */
  root(): Frame {
    const r = this.tree.frames.get(this.tree.rootId);
    if (r === undefined) throw new Error("引擎缺少根帧");
    return r;
  }

  isComplete(): boolean {
    return this.root().status === "done";
  }

  /** 当前帧栈（就绪池 DFS 栈的只读副本；数组末位 = 下一待处理帧） */
  frameStack(): FrameId[] {
    return [...this.pool];
  }

  /** 只读查询面快照：任务清单/当前帧栈/active 计数/是否完成（复用既有视图，零副作用） */
  query(): TaskEngineSnapshot {
    return {
      tasks: this.nested(),
      frameStack: this.frameStack(),
      activeCount: this.activeCount(),
      isComplete: this.isComplete(),
    };
  }

  /** 事件流快照（JSON，用于恢复/审计） */
  snapshotText(): string {
    return JSON.stringify(this.log);
  }

  /** 写快照到 snapshotPath（配置时）；未配置时 no-op */
  async writeSnapshot(): Promise<void> {
    if (!this.snapshotPath) return;
    // 与周期快照共用同一条串行链：最终写排在已排队的写之后，
    // await 返回时链尾已落定，读侧不会读到后续并发写截断出的半截文件。
    await this.scheduleSnapshot();
  }

  /** 把一次落盘排到串行链尾；返回本次写的 promise（失败会抛给调用方）。 */
  private scheduleSnapshot(): Promise<void> {
    const write = this.snapshotChain.then(() => this.writeFileNow());
    // 链上保留吞错版本：一次写失败不阻断后续快照。
    this.snapshotChain = write.catch(() => {
      /* 快照写失败不阻塞主流程 */
    });
    return write;
  }

  /** 实际落盘（只经串行链调用）。 */
  private async writeFileNow(): Promise<void> {
    if (!this.snapshotPath) return;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(this.snapshotPath, this.snapshotText(), "utf8");
  }

  append(ev: PlanEvent): void {
    logEvent(this.log, ev);
    // 周期快照：配置 snapshotPath 时每次事件后串行写盘（fire-and-forget），
    // 保证硬中止（turn/end reason=aborted）后磁盘上存在可恢复的最新事件流
    if (this.snapshotPath) {
      this.scheduleSnapshot().catch(() => {
        /* 快照写失败不阻塞主流程 */
      });
    }
  }

  recompute(): void {
    this.state = materialize(this.log);
  }
}
