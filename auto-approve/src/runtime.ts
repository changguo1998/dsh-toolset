/**
 * 运行时状态：把判定上下文、`callId → 参数` 表、会话观测器与审计去重绑在一处
 * （gate 与应答者共用一份，符合「两处裁定共用同一判定核心」）。
 */

import type { AuditWriter } from "./audit.ts";
import {
  auditLineOf,
  decide,
  recordApproval,
  type DecisionContext,
  type DecisionInput,
  type DecisionResult,
} from "./decide.ts";
import type { CallTable } from "./calls.ts";
import type { SessionObserver } from "./sessions.ts";
import type { AutoApproveMode, Decision, PluginHost } from "./types.ts";
import type { ResolvedConfig } from "./config.ts";

/** 一次裁定的最终去向（应答者用）。 */
export type AnswerOutcome = "allowed-once" | "rejected" | "next";

/** 运行时。 */
export interface Runtime {
  config: ResolvedConfig;
  /** 运行态模式（`/autoapprove` 改动只影响当前进程）。 */
  mode: AutoApproveMode;
  /** 判定上下文（`config` 随运行态模式同步更新）。 */
  context: DecisionContext;
  calls: CallTable;
  sessions: SessionObserver;
  audit: AuditWriter;
  warn: (message: string) => void;
  /** 判定（带单次调用缓存；`write` = 命中后是否记指纹与写审计）。 */
  evaluate(input: DecisionInput, write: boolean): Promise<DecisionResult>;
  /** 取本次调用已算出的裁定。 */
  cached(callId: string | undefined): DecisionResult | undefined;
  /** 清空（dispose / 测试）。 */
  dispose(): void;
}

/** 创建运行时（配置已归一）。 */
export function createRuntime(options: {
  config: ResolvedConfig;
  context: DecisionContext;
  calls: CallTable;
  sessions: SessionObserver;
  audit: AuditWriter;
  warn: (message: string) => void;
}): Runtime {
  const { config, calls, audit, sessions, warn } = options;
  const context: DecisionContext = { ...options.context };
  /** 已写审计的 callId（单次判定纪律：同一调用只记一行）。 */
  const audited = new Set<string>();
  /** 已算出的裁定（同一次调用的后续审批请求复用）。 */
  const cache = new Map<string, DecisionResult>();
  let mode = config.mode;

  function commit(
    input: DecisionInput,
    result: DecisionResult,
  ): DecisionResult {
    if (result.decision.outcome === "next") return result;
    const callId = input.call.callId;
    if (callId === undefined || !audited.has(callId)) {
      audit.write(auditLineOf(context, input, result, result.decision.outcome));
      // 会话审计落点在这一刻失效（目录不可写 / 不可得）：本次不自动裁定，
      // 退回人工面板（决策 5 第 4 条：绝不静默放行）；降级警告由审计写入器发过一次
      if (!audit.sessionUsable()) return { decision: { outcome: "next" } };
      if (callId !== undefined) audited.add(callId);
    }
    recordApproval(context, input, result);
    if (callId !== undefined) cache.set(callId, result);
    return result;
  }

  const runtime: Runtime = {
    config,
    get mode(): AutoApproveMode {
      return mode;
    },
    set mode(value: AutoApproveMode) {
      mode = value;
      // 运行态模式决定判定层看到的口径（`off` 立即停止裁定）
      context.config = { ...config, mode: value };
    },
    context,
    calls,
    sessions,
    audit,
    warn,
    async evaluate(input, write) {
      const callId = input.call.callId;
      const hit = callId === undefined ? undefined : cache.get(callId);
      if (hit !== undefined) return hit;
      const result = await decide(context, input);
      if (!write) {
        if (callId !== undefined && result.decision.outcome !== "next") {
          cache.set(callId, result);
        }
        return result;
      }
      return commit(input, result);
    },
    cached(callId) {
      return callId === undefined ? undefined : cache.get(callId);
    },
    dispose() {
      audited.clear();
      cache.clear();
      sessions.clear();
      audit.dispose();
    },
  };
  return runtime;
}

/** 判定结果 → 应答词（`next` 表示交下一位应答者）。 */
export function answerOf(decision: Decision): AnswerOutcome {
  return decision.outcome === "allowed-once" || decision.outcome === "rejected"
    ? decision.outcome
    : "next";
}
