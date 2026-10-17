/**
 * `approval/request` 应答者（挂载点 ②）：审批链上排在外层，命中即裁定、未命中调 `next()`
 * 交给下一位（TUI 人工面板）。覆盖**全部** ask 来源 —— 沙箱升级、策略式 ask、任何插件的直连请求。
 *
 * 裁定链（与 `decide.ts` 同源，本文件只做「取参数 + 取历史 + 翻译结果」）：
 * 参数优先取 `tools/pre-execute` 记录的表，其次按 `callId` 反查会话日志；两处都取不到时
 * 仍跑判定（拒绝名单与只读类不需要参数），路径 / 命令 / 升级类判据自然不生效 → 落人工面板。
 * 取不到就不猜（验收 09 / 16）。
 */

import { answerOf, type Runtime } from "./runtime.ts";
import type {
  ApprovalAnswerer,
  ApprovalOutcome,
  ApprovalRequestLike,
  CallInfo,
  PreToolDecision,
} from "./types.ts";
import { identityOf } from "./gate.ts";
import { parseArguments } from "./patterns.ts";
import type { SessionLike } from "./sessions.ts";
import type { ReviewInstructionItem } from "./review.ts";

/** 反查不到参数时构造的最小快照（`arguments` 留 undefined → 需要参数的判据不生效）。 */
export function recoveredCall(
  req: ApprovalRequestLike,
  sessionId: string | undefined,
  agentId: string | undefined,
  cwd: string | undefined,
): CallInfo {
  const callId = typeof req.callId === "string" ? req.callId : `approval-${req.toolName}`;
  return {
    callId,
    name: req.toolName,
    arguments: undefined,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(escalationTargetOf(req) === undefined
      ? {}
      : { escalationTarget: escalationTargetOf(req) }),
  };
}

function escalationTargetOf(req: ApprovalRequestLike): string | undefined {
  const match = /^escalate sandbox to ([A-Za-z0-9_-]+):/.exec((req.reason ?? "").trim());
  return match?.[1];
}

/** 创建应答者（注册到 `approval/request`）。 */
export function createAnswerer(
  runtime: Runtime,
  options: {
    /** 取项目规则（`AGENTS.md` 摘要）。 */
    instructionsFor: (cwd: string) => readonly ReviewInstructionItem[];
    /** 取会话对象（历史过滤用；不可得时传 undefined）。 */
    sessionOf?: (sessionId: string) => SessionLike | undefined;
  },
): ApprovalAnswerer {
  return async (req, next) => {
    const identity = identityOf(req.agent);
    const sessionId = identity.sessionId;
    // 信号已中断：直接按宿主词表回 cancelled（不在已作废的请求上做自动裁定）
    if (req.signal?.aborted === true) return "cancelled";
    if (runtime.mode === "off" || !runtime.context.config.enabled) return next();
    // 参数：先查本进程记录的表，再按 callId 反查会话日志（观测到的话）
    let call = runtime.calls.get(req.callId);
    if (call === undefined && sessionId !== undefined && typeof req.callId === "string") {
      const observed = runtime.sessions.callOf(sessionId, req.callId);
      if (observed !== undefined) {
        call = {
          callId: req.callId,
          name: observed.name,
          arguments: parseArguments(observed.arguments),
          sessionId,
          ...(identity.agentId === undefined ? {} : { agentId: identity.agentId }),
          ...(identity.cwd === undefined ? {} : { cwd: identity.cwd }),
        };
      }
    }
    // 保留原始 callId 以便与 gate 的缓存对齐
    const effective =
      call ??
      recoveredCall(req, sessionId, identity.agentId, identity.cwd);
    const cwd = effective.cwd ?? identity.cwd ?? process.cwd();
    const session =
      sessionId === undefined ? undefined : options.sessionOf?.(sessionId);
    const result = await runtime.evaluate(
      {
        call: effective,
        ...(req.reason === undefined ? {} : { reason: req.reason }),
        cwd,
        history: runtime.sessions.historyOf(session),
        projectInstructions: options.instructionsFor(cwd),
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      },
      true,
    );
    const answer = answerOf(result.decision);
    if (answer === "allowed-once" || answer === "rejected") return answer;
    return delegate(next, req.signal);
  };
}

/** 交下一位应答者；异常与信号中断按宿主词表归一（fail-closed）。 */
async function delegate(
  next: () => Promise<ApprovalOutcome>,
  signal: AbortSignal | undefined,
): Promise<ApprovalOutcome> {
  if (signal?.aborted === true) return "cancelled";
  try {
    return await next();
  } catch {
    return "unavailable";
  }
}

/** `PreToolDecision` 与应答词共用的判定结果类型（类型面 re-export，便于测试断言）。 */
export type { PreToolDecision };
