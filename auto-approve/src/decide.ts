/**
 * 判定编排：把「纯规则层」+ 指纹状态 + LLM 灰区段 + 审计落点串成一次裁定。
 *
 * 两个挂载点共用本模块（决策 1 的「两处裁定共用同一判定核心，避免两套逻辑」）：
 * - `tools/pre-execute` 的监听器（`gate.ts`）：记录参数，并执行**不需要参数即可终结**的拒绝名单；
 *   其余层留给审批层 —— 不提前放行，避免把工具自己的 `ask` 决定吞掉。
 * - `approval/request` 的应答者（`answerer.ts`）：拿 `callId` 反查参数后跑完整阶梯。
 *
 * **单次判定纪律**：一次调用只判一次，裁定缓存进 `CallTable`，同一次调用的后续审批请求直接复用；
 * 审计行也只写一次（由调用方在缓存未命中时写）。
 */

import type { ResolvedConfig } from "./config.ts";
import { reviewActive } from "./config.ts";
import { FingerprintStore, fingerprintOf } from "./fingerprint.ts";
import type { AuditWriter } from "./audit.ts";
import {
  applyReviewDecision,
  runReview,
  type ReviewDecision,
  type ReviewHistoryItem,
  type Reviewer,
} from "./review.ts";
import {
  checkCommandAllow,
  checkDenyEscalation,
  checkDenyTools,
  checkEscalationAllow,
  checkPathAllow,
  checkReadonly,
  denialReason,
  isBypassed,
  isGatedOut,
  needsArguments,
  parseEscalationTarget,
} from "./rules.ts";
import type { AuditLine, CallInfo, Decision, RiskLevel } from "./types.ts";

/** 判定的输入（一次工具调用 + 可选的审批理由）。 */
export interface DecisionInput {
  call: CallInfo;
  /** 审批请求自带的理由（`pre-execute` 侧没有）。 */
  reason?: string;
  /** 会话 cwd（`ENVIRONMENT` 段与路径解析）。 */
  cwd: string;
  /** 过滤后的会话历史（LLM 段用）。 */
  history: readonly ReviewHistoryItem[];
  /** 项目规则（LLM 段用）。 */
  projectInstructions: readonly { source: string; text: string }[];
  signal?: AbortSignal;
}

/** 判定上下文（一次 apply 一份）。 */
export interface DecisionContext {
  config: ResolvedConfig;
  fingerprints: FingerprintStore;
  audit: AuditWriter;
  reviewer?: Reviewer;
  warn: (message: string) => void;
}

/** 判定结果 + 元信息（审计行从中取字段）。 */
export interface DecisionResult {
  decision: Decision;
  fingerprintHash?: string;
}

/** 该次调用的升级目标模式（审批理由优先，其次 `pre-execute` 侧记录）。 */
export function escalationTargetOf(input: DecisionInput): string | undefined {
  return parseEscalationTarget(input.reason) ?? input.call.escalationTarget;
}

/** 只做**确定性层**（0-6）；`undefined` = 灰区（交给 LLM 或人工面板）。 */
export function decideDeterministic(
  ctx: DecisionContext,
  input: DecisionInput,
): DecisionResult | undefined {
  const { config, fingerprints } = ctx;
  const { call } = input;
  if (!config.enabled || config.mode === "off") {
    return { decision: { outcome: "next" } };
  }
  if (isBypassed(config, call.name) || isGatedOut(config, call.name)) {
    return { decision: { outcome: "next" } };
  }
  const target = escalationTargetOf(input);
  // 拒绝名单优先于一切放行，也优先于 LLM（这两层都不需要参数原文）
  const denied =
    checkDenyTools(config, call.name) ??
    checkDenyEscalation(config, call.name, target);
  if (denied !== undefined) return { decision: denied };
  // 缺信息不猜：判定要求看参数而参数取不到时一律落人工面板（可配 deny.missingArguments 收紧）
  if (
    call.arguments === undefined &&
    needsArguments(config, call.name, target)
  ) {
    if (config.denyMissingArguments) {
      return {
        decision: {
          outcome: "rejected",
          source: "rule",
          ruleId: "deny.missingArguments",
          reason: denialReason(call.name, "审批请求取不到参数原文"),
        },
      };
    }
    return { decision: { outcome: "next" } };
  }
  const hash = fingerprintOf(call.name, call.arguments, target);
  if (call.sessionId !== undefined && fingerprints.has(call.sessionId, hash)) {
    return {
      decision: {
        outcome: "allowed-once",
        source: "fingerprint",
        ruleId: `fingerprint:${hash}`,
      },
      fingerprintHash: hash,
    };
  }
  const hit =
    checkReadonly(config, call.name) ??
    checkPathAllow(config, call) ??
    checkCommandAllow(config, call) ??
    checkEscalationAllow(config, call, target);
  if (hit !== undefined) return { decision: hit, fingerprintHash: hash };
  if (config.mode === "all") {
    return {
      decision: { outcome: "allowed-once", source: "rule", ruleId: "mode:all" },
      fingerprintHash: hash,
    };
  }
  return undefined;
}

/** 完整判定（含 LLM 灰区与失败兜底）。 */
export async function decide(
  ctx: DecisionContext,
  input: DecisionInput,
): Promise<DecisionResult> {
  // 会话审计不可用 → 退回人工面板（决策 5 第 4 条）：任何裁定都不得静默放行
  if (ctx.audit.sessionUsable() === false)
    return { decision: { outcome: "next" } };
  const deterministic = decideDeterministic(ctx, input);
  if (deterministic !== undefined) return deterministic;
  if (!reviewActive(ctx.config)) return { decision: { outcome: "next" } };
  const reviewer = ctx.reviewer;
  if (reviewer === undefined) return failure(ctx, "LLM 审查器不可用");
  const target = escalationTargetOf(input);
  let reviewed: ReviewDecision;
  try {
    reviewed = await runReview(
      reviewer,
      {
        ...(input.call.sessionId === undefined
          ? {}
          : { sessionId: input.call.sessionId }),
        toolName: input.call.name,
        arguments: input.call.arguments,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(target === undefined ? {} : { escalationTarget: target }),
        cwd: input.cwd,
        history: input.history,
        projectInstructions: input.projectInstructions,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      ctx.config.review.timeoutMs,
      input.signal,
    );
  } catch (error) {
    return failure(ctx, String(error));
  }
  const withinRisk =
    reviewed.decision === "allow" &&
    riskAtMost(reviewed.risk, ctx.config.review.maxRiskAllow);
  const applied = applyReviewDecision(
    withinRisk ? reviewed : { ...reviewed, decision: "deny" },
    input.call.name,
  );
  const hash = fingerprintOf(input.call.name, input.call.arguments, target);
  return {
    decision: {
      outcome: applied.outcome,
      source: "llm",
      ruleId: `llm:${reviewed.risk}`,
      risk: applied.risk,
      reviewerDecision: applied.reviewerDecision,
      ...(reviewed.model === undefined
        ? {}
        : { reviewerModel: reviewed.model }),
      ...(applied.reason === undefined ? {} : { reason: applied.reason }),
    },
    ...(applied.outcome === "allowed-once" ? { fingerprintHash: hash } : {}),
  };
}

/** 失败兜底（R7）：`panel` 交人工 / 原路径，`reject` 直接拒；两条都**不静默放行**。 */
function failure(ctx: DecisionContext, detail: string): DecisionResult {
  if (ctx.config.review.onFailure === "reject") {
    return {
      decision: {
        outcome: "rejected",
        source: "llm",
        ruleId: "llm:failure",
        fallback: "reject",
        reason: `auto-approve 拒绝了这次调用：LLM 审查不可用（${detail}），已按 onFailure: reject 拒绝。`,
      },
    };
  }
  ctx.warn(`LLM 审查失败，交人工面板：${detail}`);
  return { decision: { outcome: "next", fallback: "panel" } };
}

/** 风险档比较：`risk` 不高于 `max`。 */
export function riskAtMost(risk: RiskLevel, max: RiskLevel): boolean {
  const order: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
  return order[risk] <= order[max];
}

/** 只允许放行在 `maxRiskAllow` 以内的风险（对外暴露，供测试与文档断言）。 */
export function allowedByRisk(
  decision: ReviewDecision,
  max: RiskLevel,
): boolean {
  return decision.decision === "allow" && riskAtMost(decision.risk, max);
}

/** 判定后记账：放行记指纹（只有 `allowed-once` 进放行集；拒绝不记）。 */
export function recordApproval(
  ctx: DecisionContext,
  input: DecisionInput,
  result: DecisionResult,
): void {
  if (result.decision.outcome !== "allowed-once") return;
  const sessionId = input.call.sessionId;
  if (sessionId === undefined) return;
  const hash =
    result.fingerprintHash ??
    fingerprintOf(
      input.call.name,
      input.call.arguments,
      escalationTargetOf(input),
    );
  ctx.fingerprints.approve(sessionId, hash, input.call.name);
}

/** 审计行（判定层组装；写入器只负责落盘）。 */
export function auditLineOf(
  ctx: DecisionContext,
  input: DecisionInput,
  result: DecisionResult,
  outcome: "allowed-once" | "rejected",
): AuditLine {
  const decision = result.decision;
  return {
    t: new Date().toISOString(),
    sessionId: input.call.sessionId ?? "",
    ...(input.call.agentId === undefined
      ? {}
      : { agentId: input.call.agentId }),
    ...(input.call.callId === undefined ? {} : { callId: input.call.callId }),
    toolName: input.call.name,
    outcome,
    source: decision.source ?? "rule",
    ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
    ...(decision.risk === undefined ? {} : { risk: decision.risk }),
    ...(decision.reviewerDecision === undefined
      ? {}
      : { reviewerDecision: decision.reviewerDecision }),
    ...(decision.reviewerModel === undefined
      ? {}
      : { reviewerModel: decision.reviewerModel }),
    ...(decision.fallback === undefined ? {} : { fallback: decision.fallback }),
    mode: ctx.config.mode,
    ...(result.fingerprintHash === undefined
      ? {}
      : { fingerprintHash: result.fingerprintHash }),
  };
}
