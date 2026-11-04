// TUI/src/app/adapter/dsh-approval.ts — 审批桥: approval/request 与 user-questions 应答
//
// 由 dsh.ts 的 createRealDshAdapter 机械搬出（行为不变）。只依赖上下文对象。

import type {
  DshAdapter,
  ApprovalRequest,
  ApprovalOutcome,
  QuestionAnswer,
  UserQuestionRequestLike,
} from "./types.ts";
import { buildApprovalPrompt } from "./normalize.ts";
import type { AdapterContext } from "./context.ts";

export function createApprovalBridge(ctx: AdapterContext) {
  const s = ctx.state;
  const { opts, runtime } = ctx;

  // 3.3.3: tool/call 参数短期登记表（键 = 宿主 callId, 明细投影见 ./approval-tool-calls.ts）;
  // 实例在上下文上, 事件转接侧登记、审批桥侧取用。

  /**
   * 裁定并清理。reason 非空表示「由宿主侧裁定」（超时 / abort）——此时额外发
   * approval-closed 让 app 关闭面板并提示，避免「面板仍开着但决议已失效」（3.3.2）。
   */
  const settle = (
    id: string,
    outcome: ApprovalOutcome,
    reason?: "timeout" | "abort",
  ): void => {
    const pending = s.pendingApprovals.get(id);
    if (!pending) return;
    s.pendingApprovals.delete(id);
    clearTimeout(pending.timer);
    if (reason) ctx.emit({ type: "approval-closed", id, reason });
    pending.resolve(outcome);
  };

  const approvalAnswerer = (
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    if (s.disposed || s.listeners.size === 0) return next();
    const id = "approval-" + s.approvalSeq++;
    const prompt = buildApprovalPrompt(
      req,
      typeof req.callId === "string"
        ? ctx.toolCalls.get(req.callId)
        : undefined,
    );
    // 超时裁定为 rejected（BACKLOG 3.3.5：无操作到点 = 默认拒绝，比取消更保守）
    const timer = setTimeout(
      () => settle(id, "rejected", "timeout"),
      opts.approvalTimeoutMs ?? 60_000,
    );
    return new Promise<ApprovalOutcome>((resolve) => {
      s.pendingApprovals.set(id, { resolve, timer });
      ctx.emit({ type: "approval", id, prompt });
      const signal = req.signal;
      if (signal?.aborted) {
        settle(id, "cancelled");
        resolve("cancelled");
        return;
      }
      signal?.addEventListener(
        "abort",
        () => settle(id, "cancelled", "abort"),
        {
          once: true,
        },
      );
    }).finally(() => {
      if (typeof req.callId === "string") ctx.toolCalls.delete(req.callId);
    });
  };

  // --- user-questions/request waterfall 应答者（每次最多一个活动请求） ---

  const questionAnswerer = (
    req: UserQuestionRequestLike,
    next: () => Promise<QuestionAnswer>,
  ): Promise<QuestionAnswer> => {
    // 无监听者/已释放 → 放行给后续 waterfall 监听者（最终无应答 NO_PROVIDER）
    if (s.disposed || s.listeners.size === 0) return next();
    // 单面板约束：已有活动请求时拒绝新请求（绝不覆盖旧 Promise），让 agent 自行处理
    if (s.pendingQuestions.size > 0) {
      return Promise.reject(
        new Error("已有待回答的提问，请先完成当前问答面板"),
      );
    }
    const id = "question-" + s.questionSeq++;
    return new Promise<QuestionAnswer>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        cleanup: () => {},
      };
      const onAbort = () => {
        entry.cleanup();
        reject(
          new Error("ask_user_question was aborted before the user answered"),
        );
      };
      entry.cleanup = () => {
        if (s.pendingQuestions.get(id) !== entry) return;
        s.pendingQuestions.delete(id);
        req.signal?.removeEventListener("abort", onAbort);
      };
      s.pendingQuestions.set(id, entry);
      if (req.signal?.aborted) {
        onAbort();
        return;
      }
      req.signal?.addEventListener("abort", onAbort, { once: true });
      ctx.emit({ type: "question", id, questions: req.questions });
    });
  };

  const part: Partial<DshAdapter> = {
    approve(id, allow) {
      if (s.disposed) return;
      settle(id, allow ? "allowed-once" : "rejected");
    },
    cancelApproval(id) {
      if (s.disposed) return;
      settle(id, "cancelled");
    },
    approvalTimeoutMs() {
      // App 侧倒计时据此显示（与上面 setTimeout 同源，BACKLOG 3.3.2）
      return opts.approvalTimeoutMs ?? 60_000;
    },
    stopApprovalTimeout(id) {
      // 用户已开始操作 → 不再自动裁定（BACKLOG 3.3.5）；已裁定时 pending 不在，天然幂等
      const pending = s.pendingApprovals.get(id);
      if (pending) clearTimeout(pending.timer);
    },
    async setApprovalPolicy(policy) {
      // C 阶段：两态切换写路径 → 宿主 ctx.approval.setPolicy(agent, policy)（A0 已核实
      // user-approval/src/index.ts L226 → session.append('approval/policy', {policy})，
      // 即本调用是 approval/policy 事件的产生源，状态行经事件回读 latest-wins）。
      // 宿主未挂载 ctx.approval 或活跃 agent 缺失 → reject，调用方 notice「审批策略服务不可用」。
      if (s.disposed) return;
      // SAFETY: DshRuntime 结构面仅声明 on()；ctx.approval 为可选宿主服务，
      // 经 userspace 结构分类（{setPolicy(agent, policy)}）窄化，缺失则下方 reject，
      // 绝不无保护访问成员——与既有结构面（sessionQuery/llm 等）同构。
      const approval = (
        runtime as unknown as {
          approval?: { setPolicy?: (agent: unknown, p: string) => unknown };
        }
      ).approval;
      if (
        !approval ||
        typeof approval.setPolicy !== "function" ||
        !s.activeAgent
      ) {
        throw new Error("审批策略服务不可用");
      }
      await approval.setPolicy(s.activeAgent, policy);
    },

    answerQuestion(id, answer) {
      if (s.disposed) return;
      const pending = s.pendingQuestions.get(id);
      if (!pending) return;
      pending.cleanup();
      pending.resolve(answer);
    },
    cancelQuestion(id) {
      if (s.disposed) return;
      const pending = s.pendingQuestions.get(id);
      if (!pending) return;
      pending.cleanup();
      pending.reject(new Error("用户取消了提问"));
    },
  };

  return { part, settle, approvalAnswerer, questionAnswerer };
}
