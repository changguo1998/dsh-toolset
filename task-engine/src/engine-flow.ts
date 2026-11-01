// src/engine-flow.ts — 引擎裁决流：验收裁决、打回、终态与 join 续体
//
// 与状态层分开：这里只表达「一个帧怎么被判、被打回、被完成并向上 join」，
// 状态读写一律经 host（引擎提供的最小协作面），不直接碰事件流实现。

import {
  judgeAcceptance,
  type AcceptanceHooks,
  type AuditRequest,
  type AuditVerdict,
} from "./acceptance.ts";
import type { GateConfig } from "./gate.ts";
import type {
  ActionResult,
  DecomposeResult,
  TerminalHook,
} from "./engine-types.ts";
import type { Frame, FrameId, PlanEvent, StepVerdict } from "./types.ts";

/**
 * 复查被跳过时的留痕文案（`task_stop` 反馈；与事件流的 `guardSkipped` 同口径）。
 * fail-open 策略不变（命令照常执行），但「这条命令没复查过」必须写出来（D1：不可见 → 可见）。
 */
export const GUARD_SKIPPED_NOTICE =
  "复查留痕：security-guard 执行前复查不可用（fail-open 放行），验收命令未复查即执行（guardSkipped）";

/** 失败结果构造（引擎操作层与本模块共用同一口径）。 */
export function reject(feedback: string): ActionResult {
  return { ok: false, feedback };
}

/** 裁决流依赖的引擎协作面：只给读状态与落事件的最小入口。 */
export interface AcceptanceFlowHost {
  readonly config: GateConfig;
  readonly runCommandFallback: AcceptanceHooks["runCommand"] | undefined;
  readonly auditFallback:
    ((req: AuditRequest) => Promise<AuditVerdict>) | undefined;
  readonly onFrameTerminal: TerminalHook | undefined;
  append(ev: PlanEvent): void;
  recompute(): void;
  /** 按帧 id 取当前物化帧（未知返回 undefined） */
  frame(id: FrameId): Frame | undefined;
  /** 打回后放回就绪池顶部 */
  pushPoolFront(id: FrameId): void;
}

export class AcceptanceFlow {
  constructor(private readonly host: AcceptanceFlowHost) {}

  // -------------------------------------------------------------------------
  // 内部：审计、打回、完成与 join 续体
  // -------------------------------------------------------------------------

  /** decompose 收尾：落 step 级裁决事件（#5）后返回结果 */
  finishDecompose(parentId: FrameId, res: DecomposeResult): DecomposeResult {
    this.emitStepVerdict(parentId, {
      accepted: res.ok,
      next: res.ok ? res.next : parentId,
      ...(res.ok ? {} : { feedback: res.feedback }),
    });
    return res;
  }

  /** 落一条 step 级裁决事件（§11.2：裁决进事件流，供宿主/审计消费） */
  emitStepVerdict(frameId: FrameId, v: StepVerdict): void {
    this.host.append({
      type: "plan/step-verdict",
      frame: frameId,
      accepted: v.accepted,
      next: v.next,
      ...(v.feedback === undefined ? {} : { feedback: v.feedback }),
    });
  }

  /**
   * 语义裁决的证据文本：叶子用自身产出；**父帧没有自身产出**（父验收在子任务 join 后才判），
   * 故汇总子帧结论——否则语义级 audit run 对父验收「无产出可审」，语义门形同虚设。
   */
  evidenceFor(f: Frame): string | undefined {
    if (f.result !== undefined && f.result.trim() !== "") return f.result;
    if (f.children.length === 0) return f.result;
    const parts: string[] = [];
    for (const childId of f.children) {
      const child = this.host.frame(childId);
      if (child === undefined) continue;
      const text = child.result ?? "";
      parts.push(
        `- ${child.id}（${child.title}）：${text === "" ? "（无产出）" : text}`,
      );
    }
    return parts.length === 0 ? f.result : parts.join("\n");
  }

  /** 依序裁决一个帧的全部验收条目；任一失败 → 打回（bounded retry） */
  async audit(
    frameId: FrameId,
    approve: AcceptanceHooks["approve"],
    perCallAudit?: (req: AuditRequest) => Promise<AuditVerdict>,
  ): Promise<ActionResult> {
    const f = this.host.frame(frameId);
    if (f === undefined) return reject(`未知帧 ${frameId}`);
    if (f.acceptance.length === 0) return { ok: true };
    // 本轮验收里是否有「命令复查被跳过」（guard 不可用 / 抛错 → fail-open）：留痕给事件与 stop 反馈
    let guardSkipped = false;
    for (const acc of f.acceptance) {
      const verdict = await judgeAcceptance(
        frameId,
        acc,
        {
          runCommand:
            this.host.runCommandFallback ??
            (async () => ({ code: 1, output: "未配置 runCommand" })),
          approve,
          ...((perCallAudit ?? this.host.auditFallback)
            ? { audit: perCallAudit ?? this.host.auditFallback }
            : {}),
        },
        this.evidenceFor(f),
      );
      if (verdict.guardSkipped === true) guardSkipped = true;
      this.host.append({
        type: "plan/acceptance-verdict",
        frame: frameId,
        acceptance: acc.id,
        level: acc.level,
        pass: verdict.pass,
        ...(verdict.pass ? {} : { evidence: verdict.feedback }),
        ...(verdict.structured === undefined
          ? {}
          : { structured: verdict.structured }),
        ...(verdict.guardSkipped === true
          ? { guardSkipped: true as const }
          : {}),
      });
      if (!verdict.pass) {
        // 复查被跳过（guard 不可用 / 抛错 → fail-open）：失败反馈里同口径留痕（D1，不静默）
        const feedback =
          verdict.guardSkipped === true
            ? `${verdict.feedback}\n${GUARD_SKIPPED_NOTICE}`
            : verdict.feedback;
        await this.rejectFrame(frameId, `acceptance:${acc.id}`, feedback);
        return {
          ok: false,
          feedback,
          ...(guardSkipped ? { guardSkipped: true as const } : {}),
        };
      }
    }
    return {
      ok: true,
      ...(guardSkipped ? { guardSkipped: true as const } : {}),
    };
  }

  /** 打回：记事件、计数、超限即 failed（进终态前先过终态钩子，回收失败不静默） */
  async rejectFrame(
    frameId: FrameId,
    reason: string,
    feedback: string,
  ): Promise<void> {
    this.host.append({
      type: "plan/frame-rejected",
      frame: frameId,
      reason,
      feedback,
    });
    this.host.recompute();
    const f = this.host.frame(frameId);
    if (f !== undefined && f.retryCount >= this.host.config.maxRetries) {
      await this.failFrame(frameId);
    } else {
      // 打回后放回就绪池顶部等待重新处理（带反馈）
      this.host.pushPoolFront(frameId);
    }
  }

  /**
   * 转 failed 并**向上传播**。
   * 父帧只在全部子帧 done 时才被 join（tryJoinParent），子帧 failed 永远等不到 join →
   * 祖先会停在 pending：既不能再分解（已展开过），根也非终态故不能开新一轮，就绪池空 = 卡死。
   * 因此这里沿 parentId 链把仍在进行中的祖先一并转 failed（各自过终态钩子回收现场），
   * 根进终态后自然获得「开新一轮」出口。
   */
  async failFrame(frameId: FrameId): Promise<void> {
    await this.markFailed(frameId);
    let cursor = this.host.frame(frameId)?.parentId ?? null;
    while (cursor !== null) {
      const parent = this.host.frame(cursor);
      if (
        parent === undefined ||
        parent.status === "done" ||
        parent.status === "failed"
      )
        break;
      await this.markFailed(cursor);
      cursor = this.host.frame(cursor)?.parentId ?? null;
    }
  }

  /** 单帧落地 failed：先取终态注记（回收 worktree 等），再记事件并重算 */
  async markFailed(frameId: FrameId): Promise<void> {
    const notice = await this.terminalNotice(frameId, "failed");
    this.host.append({
      type: "plan/frame-failed",
      frame: frameId,
      ...(notice === undefined ? {} : { notice }),
    });
    this.host.recompute();
  }

  /**
   * 终态钩子（帧 done / failed 之前调用；executor 隔离在此回收 worktree）。
   * 未注入 = 无注记；钩子抛错**不冒泡**（终态照常落地），抛错文本本身作为注记。
   */
  async terminalNotice(
    frameId: FrameId,
    status: "done" | "failed",
  ): Promise<string | undefined> {
    const hook = this.host.onFrameTerminal;
    if (typeof hook !== "function") return undefined;
    try {
      const notice = await hook(frameId, status);
      return typeof notice === "string" && notice.trim() !== ""
        ? notice.trim()
        : undefined;
    } catch (err) {
      return `终态钩子抛错（现场未回收，需人工处理）：${String(err)}`;
    }
  }

  /**
   * 完成一个帧并向上 join：父帧全部子任务 done 后，对其合取复核父 Q（§17.3），
   * 通过则继续向上；失败则父帧打回重试（不弹栈）。join 续体语义在 fan-out 下保持。
   */
  async completeUp(
    frameId: FrameId,
    approve: AcceptanceHooks["approve"],
    perCallAudit?: (req: AuditRequest) => Promise<AuditVerdict>,
  ): Promise<string[]> {
    const notice = await this.terminalNotice(frameId, "done");
    this.host.append({
      type: "plan/frame-completed",
      frame: frameId,
      ...(notice === undefined ? {} : { notice }),
    });
    this.host.recompute();
    const notices = notice === undefined ? [] : [notice];
    const f = this.host.frame(frameId);
    if (f === undefined || f.parentId === null) return notices;
    notices.push(
      ...(await this.tryJoinParent(f.parentId, approve, perCallAudit)),
    );
    return notices;
  }

  async tryJoinParent(
    parentId: FrameId,
    approve: AcceptanceHooks["approve"],
    perCallAudit?: (req: AuditRequest) => Promise<AuditVerdict>,
  ): Promise<string[]> {
    const parent = this.host.frame(parentId);
    if (
      parent === undefined ||
      parent.status === "done" ||
      parent.status === "failed"
    )
      return [];
    // 全部子任务 done 才激活父帧续体（fan-out：最后一个完成子任务触发）
    const allDone = parent.children.every(
      (c) => this.host.frame(c)?.status === "done",
    );
    if (!allDone) return [];
    const result = await this.audit(parentId, approve, perCallAudit);
    if (!result.ok) {
      // 打回已完成：父帧 pending + 反馈（含留痕），等待模型重新 stop；
      // 父帧验收由**本次 stop** 的 join 续体触发 → 复查被跳过时把留痕透给本次反馈（不静默）
      return result.guardSkipped === true ? [GUARD_SKIPPED_NOTICE] : [];
    }
    const notices = await this.completeUp(parentId, approve, perCallAudit);
    if (result.guardSkipped === true) notices.push(GUARD_SKIPPED_NOTICE);
    return notices;
  }
}
