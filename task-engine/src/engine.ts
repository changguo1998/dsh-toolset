// src/engine.ts — TaskStack 引擎：Frame 状态机、decompose/implement/execute/stop、
// 就绪池（fan-out 多执行器 + 有界并发）、join 续体激活、bounded retry
//
// 对齐 docs/host/AGENT-ARCHITECTURE-ANALOGY.md §13/§14/§15/§17：事件溯源驱动，树 = 事件回放；
// 栈 = 树的 DFS 遍历器（子任务逆序压栈、先序出栈）；验收失败不弹栈，带反馈打回。
// 第二迭代（BACKLOG #5/#13）：
//   - fan-out：active 帧数达 maxConcurrent 上限时不再弹栈，保持 join 续体语义（§14.2/§15.2）。
//   - step 级裁决：stop/decompose 返回并落事件流 accepted/next（§8/§11.2）。
//   - 语义蕴含：decompose 第二道门经可注入 entail hook 裁决 ∧Qᵢ ⟹ Q_parent（§17.2）。
//   - abort 路径：恢复时在途(active)帧回收为 pending，不增重试计数（turn/end reason=aborted）。
//
// 分层：状态（事件流 / 物化树 / 就绪池 / 视图）在 engine-store，裁决流（验收 / 打回 /
// 终态 / join）在 engine-flow；本文件只留模型侧操作与装配。

import type {
  AcceptanceHooks,
  AuditRequest,
  AuditVerdict,
} from "./acceptance.ts";
import { AcceptanceFlow, GUARD_SKIPPED_NOTICE, reject } from "./engine-flow.ts";
import { EngineStore } from "./engine-store.ts";
import type {
  ActionResult,
  DecomposeResult,
  EntailHook,
  ExecuteOutcome,
  ExecuteResult,
  ExecutorRunner,
  RootSpec,
  StopResult,
  TaskEngineOptions,
  TaskEngineSnapshot,
  TerminalHook,
} from "./engine-types.ts";
import { logEvent, restore } from "./events.ts";
import { checkDecomposition, DEFAULT_GATE, type GateConfig } from "./gate.ts";
import type {
  ChildSpec,
  Frame,
  FrameId,
  LoggedPlanEvent,
  NestedTaskItem,
  PlanEvent,
  TaskTree,
} from "./types.ts";

export type {
  ActionResult,
  DecomposeResult,
  EntailHook,
  ExecuteOutcome,
  ExecuteRequest,
  ExecuteResult,
  ExecutorRunner,
  RootSpec,
  StopResult,
  TaskEngineOptions,
  TerminalHook,
} from "./engine-types.ts";
export type { TaskEngineSnapshot } from "./engine-types.ts";

export class TaskEngine {
  readonly log: LoggedPlanEvent[];
  readonly config: GateConfig;
  /** 状态层：事件流、物化树、就绪池、只读视图与周期快照 */
  private readonly store: EngineStore;
  /** 裁决流：验收、打回、终态与 join 续体 */
  private readonly flow: AcceptanceFlow;
  private approveFallback: AcceptanceHooks["approve"];
  private runCommandFallback: AcceptanceHooks["runCommand"] | undefined;
  private auditFallback:
    ((req: AuditRequest) => Promise<AuditVerdict>) | undefined;
  private entail: EntailHook | undefined;
  private executorFallback: ExecutorRunner | undefined;
  private onFrameTerminal: TerminalHook | undefined;
  /** 根契约（每轮新根沿用同一份；多轮 2026-10-05） */
  private rootTemplate: RootSpec;

  constructor(opts: TaskEngineOptions) {
    this.config = { ...DEFAULT_GATE, ...opts.gate };
    this.store = new EngineStore({
      ...(opts.log === undefined ? {} : { log: opts.log }),
      config: this.config,
      ...(opts.snapshotPath === undefined
        ? {}
        : { snapshotPath: opts.snapshotPath }),
    });
    this.log = this.store.log;
    this.approveFallback = opts.approve ?? (async () => false);
    this.runCommandFallback = opts.runCommand;
    this.auditFallback = opts.audit;
    this.entail = opts.entail;
    this.executorFallback = opts.executor;
    this.onFrameTerminal = opts.onFrameTerminal;
    this.rootTemplate = opts.root;
    if (opts.log && opts.log.length > 0) {
      // 恢复：根契约以**最后**一条 root-created 的载荷为准（`resumeFromSnapshot` 传的 root
      // 只是占位，空验收；否则新一轮会继承空契约）
      for (const ev of this.log) {
        if (ev.type === "plan/root-created")
          this.rootTemplate = { ...ev.frame };
      }
    } else {
      logEvent(this.log, {
        type: "plan/root-created",
        frame: this.buildRootFrame(opts.root.id ?? "root"),
        round: 1,
      });
    }
    this.recompute();
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
    this.flow = new AcceptanceFlow({
      config: this.config,
      runCommandFallback: this.runCommandFallback,
      auditFallback: this.auditFallback,
      onFrameTerminal: this.onFrameTerminal,
      append: (ev) => this.append(ev),
      recompute: () => this.recompute(),
      frame: (id) => this.tree.frames.get(id),
      pushPoolFront: (id) => this.pushPoolFront(id),
    });
  }

  /** 物化树（本层的操作都读它；写只经 append + recompute） */
  private get tree(): TaskTree {
    return this.store.tree;
  }

  // -------------------------------------------------------------------------
  // 状态层转接（就绪池与只读视图；语义见 engine-store）
  // -------------------------------------------------------------------------

  activeCount(): number {
    return this.store.activeCount();
  }

  nextReady(): FrameId | undefined {
    return this.store.nextReady();
  }

  peekNextReady(): FrameId | null {
    return this.store.peekNextReady();
  }

  private pushPool(id: FrameId): void {
    this.store.pushPool(id);
  }

  private pushPoolFront(id: FrameId): void {
    this.store.pushPoolFront(id);
  }

  private append(ev: PlanEvent): void {
    this.store.append(ev);
  }

  private recompute(): void {
    this.store.recompute();
  }

  nested(): NestedTaskItem[] {
    return this.store.nested();
  }

  frames(): Map<FrameId, Frame> {
    return this.store.frames();
  }

  root(): Frame {
    return this.store.root();
  }

  isComplete(): boolean {
    return this.store.isComplete();
  }

  frameStack(): FrameId[] {
    return this.store.frameStack();
  }

  query(): TaskEngineSnapshot {
    return this.store.query();
  }

  snapshotText(): string {
    return this.store.snapshotText();
  }

  writeSnapshot(): Promise<void> {
    return this.store.writeSnapshot();
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
    /** 按次注入的语义蕴含 hook（缺省用实例级） */
    entail?: EntailHook,
  ): Promise<DecomposeResult> {
    const entailHook = entail ?? this.entail;
    // `"root"` 始终指**当前轮**的根（多轮后第一轮根 id 仍是 `root`，直接查表会落到旧轮）
    parentId = this.resolveId(parentId);
    let parent = this.tree.frames.get(parentId);
    if (parent === undefined)
      return this.flow.finishDecompose(parentId, {
        ok: false,
        accepted: false,
        next: null,
        feedback: `未知父帧 ${parentId}`,
      });
    // 当前轮根已**终态**（done / failed）→ 再分解 = 开新一轮（会话 = 解释器，不是一次性 main()）。
    // 这里只造**临时**新根给门禁校验用：门禁 + 蕴含通过后才真正落盘开轮（打回不留空轮，
    // 也不把重试计数记到尚不存在的新根上）
    let autoRoundId: FrameId | undefined;
    if (parent.status === "done" || parent.status === "failed") {
      if (parent.parentId !== null || parent.id !== this.tree.rootId) {
        return this.flow.finishDecompose(parentId, {
          ok: false,
          accepted: false,
          next: null,
          feedback: `父帧 ${parentId} 状态 ${parent.status}，不可再拆`,
        });
      }
      const spec = this.rootTemplate;
      if (spec.needDecompose === false || spec.executor !== undefined) {
        return this.flow.finishDecompose(parentId, {
          ok: false,
          accepted: false,
          next: null,
          feedback:
            "根契约本身是叶子（needDecompose:false 或带 executor），不能展开作父帧；" +
            "请先调整根契约（去掉 executor / 置 needDecompose:true）再开新一轮",
        });
      }
      autoRoundId = this.freeRootId(this.tree.rootIds.length + 1);
      parent = {
        ...this.buildRootFrame(autoRoundId),
        status: "pending",
        children: [],
        retryCount: 0,
      };
    }
    // frame 表按 id 全局唯一：跨轮复用 id 会覆盖旧轮帧并污染 pool / worktree 注册表
    const clash = children.find((c) => this.tree.frames.has(c.id));
    if (clash !== undefined) {
      return this.flow.finishDecompose(parentId, {
        ok: false,
        accepted: false,
        next: null,
        feedback: `子帧 id ${clash.id} 已存在（本帧内或历史轮已用）；跨轮 id 必须唯一，请改名`,
      });
    }
    if (parent.children.length > 0)
      return this.flow.finishDecompose(parentId, {
        ok: false,
        accepted: false,
        next: null,
        feedback: `父帧 ${parentId} 已展开过：请先处理子任务或对其 stop。`,
      });

    // 第一道：机械门禁（§17.2 第一道：粒度四规则 + coverage + 前置传递）
    const gate = checkDecomposition(parent, children, this.config);
    if (!gate.ok) {
      // 自动开轮路径下父帧是临时新根：不把打回计数记到已完成的旧轮上
      if (autoRoundId === undefined) {
        await this.flow.rejectFrame(
          parentId,
          `gate:${String(gate.rule)}`,
          gate.feedback,
        );
      }
      return this.flow.finishDecompose(parentId, {
        ok: false,
        accepted: false,
        next: null,
        feedback: gate.feedback,
      });
    }

    // 第二道：语义蕴含 ∧Qᵢ ⟹ Q_parent（§17.2，独立 entail run；未配置 / 父帧无验收则跳过）
    if (typeof entailHook === "function" && parent.acceptance.length > 0) {
      const ent = await entailHook(parent, children);
      if (!ent.ok && ent.skipped !== true) {
        if (autoRoundId === undefined) {
          await this.flow.rejectFrame(parentId, "gate:entail", ent.feedback);
        }
        return this.flow.finishDecompose(parentId, {
          ok: false,
          accepted: false,
          next: null,
          feedback: ent.feedback,
        });
      }
    }

    // 门禁 + 蕴含都通过 → 现在才真正开新一轮（事件落盘 + 入池）
    if (autoRoundId !== undefined) {
      this.openRound(autoRoundId);
      parentId = autoRoundId;
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
    return this.flow.finishDecompose(parentId, {
      ok: true,
      accepted: true,
      next: first,
    });
  }

  /** implement(frame, result)：仅叶子，写入产出 */
  implement(frameId: FrameId, result: string): ActionResult {
    frameId = this.resolveId(frameId);
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
   * execute(frame, runner?)：按叶子声明的 `executor` 发起独立执行面（①），
   * 成功后把证据写回 `plan/frame-implemented` 并落 `plan/frame-executed` 记录（② 计量）。
   *
   * 边界：`model` 语义 = 本会话执行（等价模型自己调 `task_implement`），不走此路径；
   * 引擎只做「发起 / 证据回填 / 验收」——脚本、提示词与命令都由叶子显式声明。
   */
  async execute(
    frameId: FrameId,
    runner?: ExecutorRunner,
  ): Promise<ExecuteResult> {
    frameId = this.resolveId(frameId);
    const f = this.tree.frames.get(frameId);
    if (f === undefined)
      return {
        ok: false,
        accepted: false,
        next: null,
        feedback: `未知帧 ${frameId}`,
      };
    if (f.needDecompose)
      return {
        ok: false,
        accepted: false,
        next: frameId,
        feedback: `帧 ${frameId} 非叶子，不允许 execute（请先 decompose）。`,
      };
    if (f.status === "done" || f.status === "failed")
      return {
        ok: false,
        accepted: false,
        next: null,
        feedback: `帧 ${frameId} 状态 ${f.status}，不可 execute`,
      };
    const spec = f.executor;
    if (spec === undefined || spec.kind === "model")
      return {
        ok: false,
        accepted: false,
        next: frameId,
        feedback: `帧 ${frameId} 未声明非 model 执行后端（model = 本会话执行，请用 task_implement 写产出）。`,
      };
    const run = runner ?? this.executorFallback;
    if (typeof run !== "function")
      return {
        ok: false,
        accepted: false,
        next: frameId,
        feedback: `帧 ${frameId} 声明了 ${spec.kind} 后端，但引擎未注入 executor 适配器（fail-closed）。`,
      };
    let out: ExecuteOutcome;
    try {
      out = await run({
        frame: frameId,
        title: f.title,
        spec: f.spec,
        acceptance: f.acceptance,
        executor: spec,
        ...(f.feedback === undefined ? {} : { feedback: f.feedback }),
      });
    } catch (err) {
      out = { ok: false, feedback: `executor 适配器抛错：${String(err)}` };
    }
    const max = spec.budget?.maxTokens;
    // 预算判定只认后端给出的**权威信号**（`out.overBudget`，subagent = 宿主 `stopReason === "max-tokens"`）。
    // 不做 tokens 数值比较：pressure 是上下文压力（真机稳定误报），usage 投影的 totals 是跨请求累计
    // 而 `maxTokens` 是每次请求上限（真机 12 个子会话实测恒真）——两者都不是同口径。
    const overBudget = max === undefined ? undefined : out.overBudget;
    const summary = summarize(
      out.ok ? (out.result ?? "") : (out.feedback ?? ""),
    );
    this.append({
      type: "plan/frame-executed",
      frame: frameId,
      executor: spec.kind,
      ...(out.model === undefined || out.model === ""
        ? {}
        : { model: out.model }),
      ...(out.tokens === undefined ? {} : { tokens: out.tokens }),
      ...(out.tokensKind === undefined ? {} : { tokensKind: out.tokensKind }),
      ...(overBudget === undefined ? {} : { overBudget }),
      ...(out.structured === undefined ? {} : { structured: out.structured }),
      ...(summary === "" ? {} : { evidence: summary }),
      ...(out.ok ? {} : { retryable: out.retryable !== false }),
      // 复查不可用（guard 缺失 / 抛错 → fail-open 放行）时的**可见留痕**：命令照常执行，
      // 但事件流标明「这一条没复查过」（D1，不静默）
      ...(out.guardSkipped === true ? { guardSkipped: true as const } : {}),
    });
    if (!out.ok) {
      const feedback = out.feedback ?? `${spec.kind} 后端执行失败（未给反馈）`;
      // 声明 / 环境问题（retryable=false）：重试无用 —— 不打回、不计重试、不改帧状态，
      // 只落 step 裁决事件（审计留痕）并把反馈交给模型去改声明
      if (out.retryable === false) {
        this.flow.emitStepVerdict(frameId, {
          accepted: false,
          next: frameId,
          feedback,
        });
        return { ok: false, accepted: false, next: frameId, feedback };
      }
      await this.flow.rejectFrame(frameId, "executor", feedback);
      const now = this.tree.frames.get(frameId);
      const next: FrameId | null = now?.status === "failed" ? null : frameId;
      this.flow.emitStepVerdict(frameId, { accepted: false, next, feedback });
      return { ok: false, accepted: false, next, feedback };
    }
    const result =
      typeof out.result === "string" && out.result.trim().length > 0
        ? out.result
        : `（${spec.kind} 后端未返回证据正文）`;
    this.append({ type: "plan/frame-implemented", frame: frameId, result });
    this.recompute();
    const usage = {
      ...(out.tokens === undefined ? {} : { tokens: out.tokens }),
      ...(out.tokensKind === undefined ? {} : { tokensKind: out.tokensKind }),
      ...(overBudget === undefined ? {} : { overBudget }),
    };
    return {
      ok: true,
      accepted: true,
      // 证据已回填但尚未验收：下一步仍是本帧（对它 task_stop）
      next: frameId,
      evidence: summarize(result),
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
    };
  }

  /**
   * stop(frame, hooks?)：RET 验收；全部通过才完成并向上 join。
   * 返回 step 级裁决 accepted/next（BACKLOG #5）：打回 next 指向本帧，通过指向就绪池候选。
   */
  async stop(
    frameId: FrameId,
    hooks?: {
      approve?: AcceptanceHooks["approve"];
      /** 按次注入的语义 audit hook（缺省用实例级；见 apply 的按次构造） */
      audit?: (req: AuditRequest) => Promise<AuditVerdict>;
    },
  ): Promise<StopResult> {
    frameId = this.resolveId(frameId);
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
    const result = await this.flow.audit(frameId, approve, hooks?.audit);
    if (!result.ok) {
      // 打回：带反馈重试；终态(failed)无下一步，否则下一步 = 本帧（重做）
      // （反馈里的复查留痕由 audit 统一附上，此处不重复拼接）
      const now = this.tree.frames.get(frameId);
      const next: FrameId | null = now?.status === "failed" ? null : frameId;
      this.flow.emitStepVerdict(frameId, {
        accepted: false,
        next,
        feedback: result.feedback,
      });
      return { ok: false, accepted: false, next, feedback: result.feedback };
    }
    const notices = await this.flow.completeUp(frameId, approve, hooks?.audit);
    // 成功路径同样留痕：否则「验收命令没复查过却通过了」会静默
    if (result.guardSkipped === true) notices.push(GUARD_SKIPPED_NOTICE);
    const next = this.peekNextReady();
    this.flow.emitStepVerdict(frameId, {
      accepted: true,
      next,
      ...(notices.length === 0 ? {} : { feedback: notices.join("；") }),
    });
    return {
      ok: true,
      accepted: true,
      next,
      ...(notices.length === 0 ? {} : { feedback: notices.join("；") }),
    };
  }

  /** 根帧骨架：首轮沿用 `opts.root.id ?? "root"`（向后兼容），第二轮回起 `root-<轮次>` */
  private buildRootFrame(
    id: FrameId,
  ): Omit<Frame, "status" | "children" | "retryCount"> {
    const spec = this.rootTemplate;
    return {
      id,
      parentId: null,
      order: 0,
      title: spec.title,
      spec: spec.spec,
      acceptance: spec.acceptance,
      needDecompose: spec.needDecompose ?? true,
      ...(spec.executor === undefined ? {} : { executor: spec.executor }),
    };
  }

  /** 新根 id：`root-<n>`，跳过已被占用的名字（子帧可以叫 `root-2`，不能静默覆盖） */
  private freeRootId(start: number): FrameId {
    let n = start;
    while (this.tree.frames.has(`root-${n}`)) n += 1;
    return `root-${n}`;
  }

  /** 帧 id 别名：`"root"` 始终指**当前轮**根（多轮后第一轮根 id 也是 `root`） */
  private resolveId(frameId: FrameId): FrameId {
    return frameId === "root" ? this.tree.rootId : frameId;
  }

  /** 开新一轮（会话 = 解释器：一轮 = 一棵完整树；2026-10-05 方案 A）
   *  落一条 `plan/root-created`（带 `round`）并把新根入池——**只在门禁 + 蕴含通过后调用**，
   *  打回时不留空轮、也不把重试计数记到新根 */
  private openRound(id: FrameId): FrameId {
    const round = this.tree.rootIds.length + 1;
    this.append({
      type: "plan/root-created",
      frame: this.buildRootFrame(id),
      round,
    });
    this.recompute();
    this.pushPool(id);
    return id;
  }
}

/** 证据摘要（折叠空白 + 截断；供事件与工具返回值展示，非全文） */
function summarize(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

/** 从快照恢复引擎（resume 加速，§15.1 L3；在途帧回收为 pending） */
export function resumeFromSnapshot(
  snapshotText: string,
  opts: Omit<TaskEngineOptions, "root" | "log">,
): TaskEngine {
  const log = restore(snapshotText);
  // 多轮：取**最后**一条 root-created（= 当前轮）
  const rootId =
    log.filter((e) => e.type === "plan/root-created").at(-1)?.frame.id ??
    "root";
  const rootSpec: RootSpec = {
    id: rootId,
    title: "",
    spec: "",
    acceptance: [],
  };
  // 以恢复事件流为准重建引擎（root 参数仅占位）
  return new TaskEngine({ ...opts, root: rootSpec, log });
}
