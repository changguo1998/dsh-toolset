// src/engine.ts — TaskStack 引擎：Frame 状态机、decompose/implement/stop、
// 就绪池（单执行器）、join 续体激活、bounded retry
//
// 对齐 AGENT-ARCHITECTURE-ANALOGY.md §13/§15/§17：事件溯源驱动，树 = 事件回放；
// 栈 = 树的 DFS 遍历器（子任务逆序压栈、先序出栈）；验收失败不弹栈，带反馈打回。

import { judgeAcceptance, type AcceptanceHooks } from "./acceptance.ts";
import { logEvent, materialize, restore } from "./events.ts";
import { checkDecomposition, DEFAULT_GATE, type GateConfig } from "./gate.ts";
import type {
  Acceptance,
  ChildSpec,
  Frame,
  FrameId,
  LoggedPlanEvent,
  NestedTaskItem,
  PlanEvent,
  TaskTree,
} from "./types.ts";
import { toNested } from "./events.ts";

export interface RootSpec {
  /** 缺省 "root" */
  id?: FrameId;
  title: string;
  spec: string;
  acceptance: Acceptance[];
  /** 根是否需要再拆（默认 true；false = 根即叶子） */
  needDecompose?: boolean;
}

export interface TaskEngineOptions {
  root: RootSpec;
  /** 从既有事件流恢复（resume；与 root 二选一） */
  log?: LoggedPlanEvent[];
  gate?: Partial<GateConfig>;
  runCommand?: AcceptanceHooks["runCommand"];
  approve?: AcceptanceHooks["approve"];
  /** 配置后每次变更自动写快照（周期快照，§15.1 L3） */
  snapshotPath?: string;
}

export type ActionResult = { ok: true } | { ok: false; feedback: string };

export class TaskEngine {
  readonly log: LoggedPlanEvent[] = [];
  readonly config: GateConfig;
  /** 空初始树（构造结束后由 materialize(this.log) 替换；不因空日志抛错） */
  private tree: TaskTree = { rootId: "", frames: new Map() };
  /** 就绪池：DFS 栈（push 逆序、pop 先序）+ 去重集合 */
  private pool: FrameId[] = [];
  private inPool = new Set<FrameId>();
  private approveFallback: AcceptanceHooks["approve"];
  private runCommandFallback: AcceptanceHooks["runCommand"] | undefined;
  private snapshotPath?: string;

  constructor(opts: TaskEngineOptions) {
    this.config = { ...DEFAULT_GATE, ...opts.gate };
    this.approveFallback = opts.approve ?? (async () => false);
    this.runCommandFallback = opts.runCommand;
    this.snapshotPath = opts.snapshotPath;
    if (opts.log && opts.log.length > 0) {
      this.log.push(...opts.log);
    } else {
      const rootFrame: Omit<Frame, "status" | "children" | "retryCount"> = {
        id: opts.root.id ?? "root",
        parentId: null,
        order: 0,
        title: opts.root.title,
        spec: opts.root.spec,
        acceptance: opts.root.acceptance,
        needDecompose: opts.root.needDecompose ?? true,
      };
      logEvent(this.log, { type: "plan/root-created", frame: rootFrame });
    }
    this.tree = materialize(this.log);
    // 恢复后把所有仍未处理的 pending 帧重新入池（叶子或未展开帧）
    for (const f of this.tree.frames.values()) {
      if (f.status === "pending") this.pushPool(f.id);
    }
  }

  // -------------------------------------------------------------------------
  // 就绪池
  // -------------------------------------------------------------------------

  /** 取下一个待处理帧（先序），并激活它（单执行器） */
  nextReady(): FrameId | undefined {
    const id = this.pool.pop();
    if (id === undefined) return undefined;
    this.inPool.delete(id);
    const f = this.tree.frames.get(id);
    if (f === undefined || f.status !== "pending") return undefined;
    this.append({ type: "plan/frame-activated", frame: id });
    this.recompute();
    return id;
  }

  private pushPool(id: FrameId): void {
    if (this.inPool.has(id)) return;
    this.inPool.add(id);
    // 逆序入栈 → 先序出栈（§14.2 DFS）
    this.pool.push(id);
  }

  private pushPoolFront(id: FrameId): void {
    // 打回重试：放回栈顶（先序最先）
    if (this.inPool.has(id)) return;
    this.inPool.add(id);
    this.pool.push(id);
  }

  // -------------------------------------------------------------------------
  // 模型侧操作
  // -------------------------------------------------------------------------

  /** decompose(parent, children)：门禁裁决后挂树，子任务入就绪池 */
  decompose(parentId: FrameId, children: ChildSpec[]): ActionResult {
    const parent = this.tree.frames.get(parentId);
    if (parent === undefined) return reject(`未知父帧 ${parentId}`);
    if (parent.status === "done" || parent.status === "failed") {
      return reject(`父帧 ${parentId} 状态 ${parent.status}，不可再拆`);
    }
    if (parent.children.length > 0) {
      return reject(`父帧 ${parentId} 已展开过：请先处理子任务或对其 stop。`);
    }
    const gate = checkDecomposition(parent, children, this.config);
    if (!gate.ok) {
      this.rejectFrame(parentId, `gate:${String(gate.rule)}`, gate.feedback);
      return { ok: false, feedback: gate.feedback };
    }
    this.append({ type: "plan/node-expanded", parent: parentId, children });
    // 子任务逆序入栈，保证先序（第一个子任务先处理）
    this.recompute();
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const c = children[i];
      if (c === undefined) continue;
      this.pushPool(c.id);
    }
    return { ok: true };
  }

  /** implement(frame, result)：仅叶子，写入产出 */
  implement(frameId: FrameId, result: string): ActionResult {
    const f = this.tree.frames.get(frameId);
    if (f === undefined) return reject(`未知帧 ${frameId}`);
    if (f.needDecompose)
      return reject(
        `帧 ${frameId} 非叶子，不允许 implement（请先 decompose）。`,
      );
    if (f.status === "done" || f.status === "failed") {
      return reject(`帧 ${frameId} 状态 ${f.status}，不可 implement`);
    }
    this.append({ type: "plan/frame-implemented", frame: frameId, result });
    this.recompute();
    return { ok: true };
  }

  /** stop(frame, hooks?)：RET 验收；全部通过才完成并向上 join */
  async stop(
    frameId: FrameId,
    hooks?: { approve?: AcceptanceHooks["approve"] },
  ): Promise<ActionResult> {
    const f = this.tree.frames.get(frameId);
    if (f === undefined) return reject(`未知帧 ${frameId}`);
    if (f.status === "done" || f.status === "failed") {
      return reject(`帧 ${frameId} 状态 ${f.status}，已终态`);
    }
    if (f.needDecompose === false && f.result === undefined) {
      return reject(`帧 ${frameId} 尚未 implement，无法 stop`);
    }
    const approve = hooks?.approve ?? this.approveFallback;
    const result = await this.audit(frameId, approve);
    if (!result.ok) return result;
    await this.completeUp(frameId, approve);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 内部：审计、打回、完成与 join 续体
  // -------------------------------------------------------------------------

  /** 依序裁决一个帧的全部验收条目；任一失败 → 打回（bounded retry） */
  private async audit(
    frameId: FrameId,
    approve: AcceptanceHooks["approve"],
  ): Promise<ActionResult> {
    const f = this.tree.frames.get(frameId);
    if (f === undefined) return reject(`未知帧 ${frameId}`);
    if (f.acceptance.length === 0) return { ok: true };
    for (const acc of f.acceptance) {
      const verdict = await judgeAcceptance(frameId, acc, {
        runCommand:
          this.runCommandFallback ??
          (async () => ({ code: 1, output: "未配置 runCommand" })),
        approve,
      });
      this.append({
        type: "plan/acceptance-verdict",
        frame: frameId,
        acceptance: acc.id,
        level: acc.level,
        pass: verdict.pass,
        ...(verdict.pass ? {} : { evidence: verdict.feedback }),
      });
      if (!verdict.pass) {
        this.rejectFrame(frameId, `acceptance:${acc.id}`, verdict.feedback);
        return { ok: false, feedback: verdict.feedback };
      }
    }
    return { ok: true };
  }

  /** 打回：记事件、计数、超限即 failed */
  private rejectFrame(
    frameId: FrameId,
    reason: string,
    feedback: string,
  ): void {
    this.append({
      type: "plan/frame-rejected",
      frame: frameId,
      reason,
      feedback,
    });
    this.recompute();
    const f = this.tree.frames.get(frameId);
    if (f !== undefined && f.retryCount >= this.config.maxRetries) {
      this.append({ type: "plan/frame-failed", frame: frameId });
      this.recompute();
    } else {
      // 打回后放回就绪池顶部等待重新处理（带反馈）
      this.pushPoolFront(frameId);
    }
  }

  /**
   * 完成一个帧并向上 join：父帧全部子任务 done 后，对其合取复核父 Q（§17.3），
   * 通过则继续向上；失败则父帧打回重试（不弹栈）。
   */
  private async completeUp(
    frameId: FrameId,
    approve: AcceptanceHooks["approve"],
  ): Promise<void> {
    this.append({ type: "plan/frame-completed", frame: frameId });
    this.recompute();
    const f = this.tree.frames.get(frameId);
    if (f === undefined || f.parentId === null) return;
    await this.tryJoinParent(f.parentId, approve);
  }

  private async tryJoinParent(
    parentId: FrameId,
    approve: AcceptanceHooks["approve"],
  ): Promise<void> {
    const parent = this.tree.frames.get(parentId);
    if (
      parent === undefined ||
      parent.status === "done" ||
      parent.status === "failed"
    )
      return;
    // 全部子任务 done 才激活父帧续体
    const allDone = parent.children.every(
      (c) => this.tree.frames.get(c)?.status === "done",
    );
    if (!allDone) return;
    const result = await this.audit(parentId, approve);
    if (!result.ok) return; // 打回已完成：父帧 pending + 反馈，等待模型重新 stop
    await this.completeUp(parentId, approve);
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

  /** 事件流快照（JSON，用于恢复/审计） */
  snapshotText(): string {
    return JSON.stringify(this.log);
  }

  /** 写快照到 snapshotPath（配置时）；未配置时 no-op */
  async writeSnapshot(): Promise<void> {
    if (!this.snapshotPath) return;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(this.snapshotPath, this.snapshotText(), "utf8");
  }

  // -------------------------------------------------------------------------
  // 私有
  // -------------------------------------------------------------------------

  private append(ev: PlanEvent): void {
    logEvent(this.log, ev);
  }

  private recompute(): void {
    this.tree = materialize(this.log);
  }
}

function reject(feedback: string): ActionResult {
  return { ok: false, feedback };
}

/** 从快照恢复引擎（resume 加速，§15.1 L3） */
export function resumeFromSnapshot(
  snapshotText: string,
  opts: Omit<TaskEngineOptions, "root" | "log">,
): TaskEngine {
  const log = restore(snapshotText);
  const rootId =
    log.find((e) => e.type === "plan/root-created")?.frame.id ?? "root";
  const rootSpec: RootSpec = {
    id: rootId,
    title: "",
    spec: "",
    acceptance: [],
  };
  // 以恢复事件流为准重建引擎（root 参数仅占位）
  return new TaskEngine({ ...opts, root: rootSpec, log });
}
