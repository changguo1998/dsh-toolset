/**
 * 容量守卫（BACKLOG「会话事件自动入知识库」的「容量边界」）：project 体积超预算时
 * 按「低重要度 → 最旧」先压缩降级（正文降为单行摘要，保留可检索足迹），仍超预算再硬淘汰。
 *
 * 与写策略（`writepolicy.ts`）的分工：写策略管「写失败重试 / TTL 淘汰」的显式批处理，
 * 本模块管「写入路径上的即时预算守卫」——由 `SessionHooks` 在每次入库后调用，缺省关闭。
 */

import type { KnowledgeService } from "./knowledge.ts";

export interface BudgetEnforcement {
  tokensBefore: number;
  tokensAfter: number;
  compressed: number;
  evicted: number;
}

export interface BudgetGuardOptions {
  project: string;
  /** 预算上限（估算 token，1 token ≈ 3 字符）；≤ 0 表示不设限。 */
  maxTokens: number;
  /** 候选批大小（缺省 50，clamp 1..500）；也是单次守卫最多淘汰的条数。 */
  batch?: number;
  /** 是否先压缩降级（缺省 true）。 */
  compressFirst?: boolean;
}

/** 每轮硬淘汰的条数：小步淘汰 + 重量测，避免一次删掉整片低重要度内容。 */
const EVICT_STEP = 10;

/** 执行一次容量守卫；返回压缩 / 淘汰计数与前后体积（无超限时为恒等返回）。 */
export function enforceBudget(
  kb: KnowledgeService,
  opts: BudgetGuardOptions,
): BudgetEnforcement {
  const batch = Math.max(1, Math.min(opts.batch ?? 50, 500));
  const before = kb.tokenBudgetUsage(opts.project);
  if (opts.maxTokens <= 0 || before <= opts.maxTokens) {
    return {
      tokensBefore: before,
      tokensAfter: before,
      compressed: 0,
      evicted: 0,
    };
  }
  let tokens = before;
  let compressed = 0;
  let evicted = 0;

  // 1）压缩降级一轮：把低重要度 + 最旧的正文降为摘要行（≤300 字符）
  if (opts.compressFirst !== false) {
    const candidates = kb.budgetCandidates({
      project: opts.project,
      limit: batch,
    });
    if (candidates.length > 0) {
      compressed = kb.compress(candidates);
      tokens = kb.tokenBudgetUsage(opts.project);
    }
  }

  // 2）仍超预算 → 小步硬淘汰（候选顺序同「低重要度 → 最旧」），累计不超过 batch 条
  while (tokens > opts.maxTokens && evicted < batch) {
    const step = Math.min(EVICT_STEP, batch - evicted);
    const candidates = kb.budgetCandidates({
      project: opts.project,
      limit: step,
    });
    if (candidates.length === 0) break;
    const removed = kb.evict(candidates);
    if (removed === 0) break;
    evicted += removed;
    tokens = kb.tokenBudgetUsage(opts.project);
  }

  return {
    tokensBefore: before,
    tokensAfter: tokens,
    compressed,
    evicted,
  };
}
