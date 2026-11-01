/**
 * 学习层判定面：判定编排（`decide.ts`）依赖的钩子契约，与学习审阅的准入口径。
 *
 * 本层只定义「判定层怎么问学习层」以及「审阅结论能否入表」，不持有状态、不读事件：
 * 状态机在观测层（`learn-observe.ts`），形态与词法在规则层（`learn-rules.ts`）。
 */

import { riskAtMost } from "./review.ts";
import type { RiskLevel } from "./types.ts";

/** 判定层用到的学习钩子（`decide.ts` 只依赖这个面，不依赖整个学习器）。 */
export interface LearnHooks {
  /** 本插件自己裁定的 `allowed-once`（按 callId 自记，decided 时据此排除）。 */
  noteSelfDecision(callId?: string): void;
  /** 首用某会话时触发一次回填（同步触发、异步完成、失败降级空集）。 */
  ensureRehydrated(sessionId: string): void;
}

/** 审阅结论是否达标（`allow` 且风险不高于运行时的 `maxRiskAllow`）。 */
export function admitLearnOutcome(
  outcome: { allow: boolean; risk: RiskLevel },
  maxRiskAllow: RiskLevel,
): boolean {
  return outcome.allow && riskAtMost(outcome.risk, maxRiskAllow);
}
