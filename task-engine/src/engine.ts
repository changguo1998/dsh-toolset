// src/engine.ts — TaskStack 引擎：Frame 状态机、decompose/implement/stop、
// 就绪池（fan-out 多执行器 + 有界并发）、join 续体激活、bounded retry
//
// 对齐 AGENT-ARCHITECTURE-ANALOGY.md §13/§14/§15/§17：事件溯源驱动，树 = 事件回放；
// 栈 = 树的 DFS 遍历器（子任务逆序压栈、先序出栈）；验收失败不弹栈，带反馈打回。
// 第二迭代（BACKLOG #5/#13）：
//   - fan-out：active 帧数达 maxConcurrent 上限时不再弹栈，保持 join 续体语义（§14.2/§15.2）。
//   - step 级裁决：stop/decompose 返回并落事件流 accepted/next（§8/§11.2）。
//   - 语义蕴含：decompose 第二道门经可注入 entail hook 裁决 ∧Qᵢ ⟹ Q_parent（§17.2）。
//   - abort 路径：恢复时在途(active)帧回收为 pending，不增重试计数（turn/end reason=aborted）。

import {
  judgeAcceptance,
  type AcceptanceHooks,
  type AuditRequest,
  type AuditVerdict,
} from "./acceptance.ts";
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
  StepVerdict,
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

/** 语义蕴含（第二道门）hook：独立 entail run 判定 ∧Qᵢ ⟹ Q_parent（§17.2）。宿主侧实现。 */
export type EntailHook = (
  parent: Frame,
  children: ChildSpec[],
) => Promise<{ ok: boolean; feedback: string }>;

export interface TaskEngineOptions {
  root: RootSpec;
  /** 从既有事件流恢复（resume；与 root 二选一） */
  log?: LoggedPlanEvent[];
  gate?: Partial<GateConfig>;
  runCommand?: AcceptanceHooks["runCommand"];
  approve?: AcceptanceHooks["approve"];
  /** 语义级验收的独立 audit run（§16.2）。未配置时语义级 fail-closed。 */
  audit?: (req: AuditRequest) => Promise<AuditVerdict>;
  /** 语义蕴含第二道门（§17.2）。未配置时只做机械门禁（结构蕴含跳过）。 */
  entail?: EntailHook;
  /** 配置后每次变更自动写快照（周期快照，§15.1 L3） */
  snapshotPath?: string;
}

export type ActionResult = { ok: true } | { ok: false; feedback: string };

/** decompose 结果（BACKLOG #5：step 级 accepted/next） */
export type DecomposeResult =
  | { ok: true; accepted: true; next: FrameId | null }
  | { ok: false; accepted: false; next: null; feedback: string };

/** stop 结果（BACKLOG #5：step 级 accepted/next + 打回反馈） */
export interface StopResult {
  ok: boolean;
  /** 本步验收是否通过（accepted 与 ok 在 stop 上一致；ok=false 表示打回/拒绝） */
  accepted: boolean;
  /** 建议下一步帧：打回指向本帧（重做），终态指向 null，通过指向就绪池候选 */
  next: FrameId | null;
  feedback?: string;
}

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
  private auditFallback:
    ((req: AuditRequest) => Promise<AuditVerdict>) | undefined;
  private entail: EntailHook | undefined;
  private snapshotPath?: string;
  /** 周期快照写盘串行链：避免并发 fire-and-forget 写乱序（新快照覆盖旧快照） */
  private snapshotChain: Promise<void> = Promise.resolve();

  constructor(opts: TaskEngineOptions) {
    this.config = { ...DEFAULT_GATE, ...opts.gate };
    this.approveFallback = opts.approve ?? (async () => false);
    this.runCommandFallback = opts.runCommand;
    this.auditFallback = opts.audit;
    this.entail = opts.entail;
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
    // abort 路径（turn/end reason=aborted）：恢复时在途(active)帧回收为 pending，
    // 不增重试计数（区别于打回），保证跨 turn 不丢帧
    if (opts.log && opts.log.length > 0) {
      const activeIds: FrameId[] = [];
      for (const f of this.tree.frames.values()) {
        if (f.status === "active") activeIds.push(f.id);
      }
      for (const id of activeIds) {
        this.append({
          type: "plan/frame-interrupted",
          frame: id,
          reason: "resume:in-flight-reclaimed",
        });
      }
      if (activeIds.length > 0) this.recompute();
    }
    // 恢复后把所有仍未处理的 pending 帧重新入池（叶子或未展开帧）
    for (const f of this.tree.frames.values()) {
      if (f.status === "pending") this.pushPool(f.id);
    }
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

  /**
   * decompose(parent, children)：双重门禁（机械 + 语义蕴含）裁决后挂树，子任务入就绪池。
   * 第二迭代：async（承载独立 entail run）；返回 step 级 accepted/next（BACKLOG #5）。
   */
  async decompose(
    parentId: FrameId,
    children: ChildSpec[],
  ): Promise<DecomposeResult> {
    const parent = this.tree.frames.get(parentId);
    if (parent === undefined)
      return this.finishDecompose(parentId, {
        ok: false,
        accepted: false,
        next: null,
        feedback: `未知父帧 ${parentId}`,
      });
    if (parent.status === "done" || parent.status === "failed")
      return this.finishDecompose(parentId, {
        ok: false,
        accepted: false,
        next: null,
        feedback: `父帧 ${parentId} 状态 ${parent.status}，不可再拆`,
      });
    if (parent.children.length > 0)
      return this.finishDecompose(parentId, {
        ok: false,
        accepted: false,
        next: null,
        feedback: `父帧 ${parentId} 已展开过：请先处理子任务或对其 stop。`,
      });

    // 第一道：机械门禁（§17.2 第一道：粒度四规则 + coverage + 前置传递）
    const gate = checkDecomposition(parent, children, this.config);
    if (!gate.ok) {
      this.rejectFrame(parentId, `gate:${String(gate.rule)}`, gate.feedback);
      return this.finishDecompose(parentId, {
        ok: false,
        accepted: false,
        next: null,
        feedback: gate.feedback,
      });
    }

    // 第二道：语义蕴含 ∧Qᵢ ⟹ Q_parent（§17.2，独立 entail run；未配置则跳过）
    if (typeof this.entail === "function") {
      const ent = await this.entail(parent, children);
      if (!ent.ok) {
        this.rejectFrame(parentId, "gate:entail", ent.feedback);
        return this.finishDecompose(parentId, {
          ok: false,
          accepted: false,
          next: null,
          feedback: ent.feedback,
        });
      }
    }

    this.append({ type: "plan/node-expanded", parent: parentId, children });
    this.recompute();
    // 子任务逆序入栈，保证先序（第一个子任务先处理）
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const c = children[i];
      if (c === undefined) continue;
      this.pushPool(c.id);
    }
    const first = children[0]?.id ?? null;
    return this.finishDecompose(parentId, {
      ok: true,
      accepted: true,
      next: first,
    });
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

  /**
   * stop(frame, hooks?)：RET 验收；全部通过才完成并向上 join。
   * 返回 step 级裁决 accepted/next（BACKLOG #5）：打回 next 指向本帧，通过指向就绪池候选。
   */
  async stop(
    frameId: FrameId,
    hooks?: { approve?: AcceptanceHooks["approve"] },
  ): Promise<StopResult> {
    const f = this.tree.frames.get(frameId);
    if (f === undefined)
      return {
        ok: false,
        accepted: false,
        next: frameId,
        feedback: `未知帧 ${frameId}`,
      };
    if (f.status === "done" || f.status === "failed")
      return {
        ok: false,
        accepted: false,
        next: null,
        feedback: `帧 ${frameId} 状态 ${f.status}，已终态`,
      };
    if (f.needDecompose === false && f.result === undefined)
      return {
        ok: false,
        accepted: false,
        next: frameId,
        feedback: `帧 ${frameId} 尚未 implement，无法 stop`,
      };
    const approve = hooks?.approve ?? this.approveFallback;
    const result = await this.audit(frameId, approve);
    if (!result.ok) {
      // 打回：带反馈重试；终态(failed)无下一步，否则下一步 = 本帧（重做）
      const now = this.tree.frames.get(frameId);
      const next: FrameId | null = now?.status === "failed" ? null : frameId;
      this.emitStepVerdict(frameId, {
        accepted: false,
        next,
        feedback: result.feedback,
      });
      return { ok: false, accepted: false, next, feedback: result.feedback };
    }
    await this.completeUp(frameId, approve);
    const next = this.peekNextReady();
    this.emitStepVerdict(frameId, { accepted: true, next });
    return { ok: true, accepted: true, next };
  }

  // -------------------------------------------------------------------------
  // 内部：审计、打回、完成与 join 续体
  // -------------------------------------------------------------------------

  /** decompose 收尾：落 step 级裁决事件（#5）后返回结果 */
  private finishDecompose(
    parentId: FrameId,
    res: DecomposeResult,
  ): DecomposeResult {
    this.emitStepVerdict(parentId, {
      accepted: res.ok,
      next: res.ok ? res.next : parentId,
      ...(res.ok ? {} : { feedback: res.feedback }),
    });
    return res;
  }

  /** 落一条 step 级裁决事件（§11.2：裁决进事件流，供宿主/审计消费） */
  private emitStepVerdict(frameId: FrameId, v: StepVerdict): void {
    this.append({
      type: "plan/step-verdict",
      frame: frameId,
      accepted: v.accepted,
      next: v.next,
      ...(v.feedback === undefined ? {} : { feedback: v.feedback }),
    });
  }

  /** 依序裁决一个帧的全部验收条目；任一失败 → 打回（bounded retry） */
  private async audit(
    frameId: FrameId,
    approve: AcceptanceHooks["approve"],
  ): Promise<ActionResult> {
    const f = this.tree.frames.get(frameId);
    if (f === undefined) return reject(`未知帧 ${frameId}`);
    if (f.acceptance.length === 0) return { ok: true };
    for (const acc of f.acceptance) {
      const verdict = await judgeAcceptance(
        frameId,
        acc,
        {
          runCommand:
            this.runCommandFallback ??
            (async () => ({ code: 1, output: "未配置 runCommand" })),
          approve,
          ...(this.auditFallback ? { audit: this.auditFallback } : {}),
        },
        f.result,
      );
      this.append({
        type: "plan/acceptance-verdict",
        frame: frameId,
        acceptance: acc.id,
        level: acc.level,
        pass: verdict.pass,
        ...(verdict.pass ? {} : { evidence: verdict.feedback }),
        ...(verdict.structured === undefined
          ? {}
          : { structured: verdict.structured }),
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
   * 通过则继续向上；失败则父帧打回重试（不弹栈）。join 续体语义在 fan-out 下保持。
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
    // 全部子任务 done 才激活父帧续体（fan-out：最后一个完成子任务触发）
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
    // 周期快照：配置 snapshotPath 时每次事件后串行写盘（fire-and-forget），
    // 保证硬中止（turn/end reason=aborted）后磁盘上存在可恢复的最新事件流
    if (this.snapshotPath) {
      this.snapshotChain = this.snapshotChain
        .then(() => this.writeSnapshot())
        .catch(() => {
          /* 快照写失败不阻塞主流程 */
        });
    }
  }

  private recompute(): void {
    this.tree = materialize(this.log);
  }
}

function reject(feedback: string): ActionResult {
  return { ok: false, feedback };
}

/** 从快照恢复引擎（resume 加速，§15.1 L3；在途帧回收为 pending） */
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
