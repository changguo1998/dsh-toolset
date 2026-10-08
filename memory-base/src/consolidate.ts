/**
 * 记忆 auto-consolidation（BACKLOG「记忆 auto-consolidation（自动巩固）」）。
 *
 * 一次巩固 = 三段机械策略（零模型依赖，判据见下），`plan()` 只读预演、`run()` 执行并记报告：
 * - **提升**：被检索命中过（`last_referenced > created_at`）且 `importance < 5` 的条目 +1 ——
 *   「高频」以 `search` 会刷新 `last_referenced` 作机械代理（README 已述 search 命中即刷新）；
 * - **合并**：同 `target` 分组内，归一化后完全相同，或一条是另一条子串且长度占比 ≥ 0.8 时，
 *   保留排序靠前者（importance 高 → 最近引用 → id 小），淘汰其余；无语义相似（留给后续条目）；
 * - **淘汰**：`staleCandidates`（TTL + 重要度上限）先 `compress` 降级再 `evict` 硬淘汰，
 *   随后按 `maxTokens` 走容量守卫（`enforceBudget`）。
 *
 * 自动触发（启动后一次 / `compaction/end` 后）与节流在入口 `index.ts`：本模块只提供
 * 「怎么巩固」与「巩固了什么」，不自己挂事件。
 */

import { enforceBudget, type BudgetEnforcement } from "./budget.ts";
import type { KnowledgeService } from "./knowledge.ts";

/** 提升候选：被检索命中过且还能提权。 */
export interface BoostCandidate {
  id: number;
  importance: number;
  lastReferenced: number;
  createdAt: number;
}

export interface ConsolidationOptions {
  project: string;
  /** 单段候选上限（缺省 50，clamp 1..500）。 */
  limit?: number;
  /** 陈旧判定 TTL（ms，缺省 30 天）。 */
  ttlMs?: number;
  /** 陈旧判定的重要度上限（缺省 2，与 `staleCandidates` 同口径）。 */
  maxImportance?: number;
  /** 容量上限（估算 token；≤ 0 = 不设限）。 */
  maxTokens?: number;
  /** 段开关（缺省全开）。 */
  promote?: boolean;
  merge?: boolean;
  evict?: boolean;
  now?: number;
}

export interface ConsolidationReport {
  project: string;
  at: number;
  dryRun: boolean;
  /** 各段候选规模（合并段按组数计） */
  scanned: { boost: number; mergeGroups: number; stale: number };
  promoted: Array<{ id: number; from: number; to: number }>;
  merged: Array<{ kept: number; dropped: number[]; target: string }>;
  compressed: number;
  evicted: number;
  budget: BudgetEnforcement | null;
  tokensBefore: number;
  tokensAfter: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 合并判据的长度占比阈值：短的一条至少要有长的一条 80% 才视为同义重复。 */
const CONTAIN_RATIO = 0.8;

/** 归一化：压缩空白 + 小写（合并判据用；不改变入库内容）。 */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 同组内 a 是否可被 b 取代（完全相同，或 a 是 b 的子串且长度占比达标）。 */
function redundant(shorter: string, longer: string): boolean {
  if (shorter === longer) return true;
  if (!longer.includes(shorter)) return false;
  return shorter.length / Math.max(1, longer.length) >= CONTAIN_RATIO;
}

export class ConsolidationService {
  readonly #kb: KnowledgeService;
  #last: ConsolidationReport | undefined;

  constructor(kb: KnowledgeService) {
    this.#kb = kb;
  }

  /** 最近一次 `run()` 的报告（`plan()` 不记）。 */
  get last(): ConsolidationReport | undefined {
    return this.#last;
  }

  /** 只读预演：判据与 `run()` 完全一致，但不写库。 */
  plan(opts: ConsolidationOptions): ConsolidationReport {
    return this.#compute(opts, true);
  }

  /** 执行巩固（提升 / 合并 / 淘汰 + 容量守卫）并记报告。 */
  run(opts: ConsolidationOptions): ConsolidationReport {
    const report = this.#compute(opts, false);
    this.#last = report;
    return report;
  }

  #compute(opts: ConsolidationOptions, dryRun: boolean): ConsolidationReport {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const now = opts.now ?? Date.now();
    const tokensBefore = this.#kb.tokenBudgetUsage(opts.project);

    // 1）提升：被检索命中过的条目提权（clamp 5）
    const promoted: Array<{ id: number; from: number; to: number }> = [];
    let boostCandidates: BoostCandidate[] = [];
    if (opts.promote !== false) {
      boostCandidates = this.#kb.boostCandidates({
        project: opts.project,
        limit,
        now,
      });
      for (const candidate of boostCandidates) {
        const to = Math.min(5, candidate.importance + 1);
        promoted.push({ id: candidate.id, from: candidate.importance, to });
        if (!dryRun) this.#kb.setImportance(candidate.id, to);
      }
    }

    // 2）合并：同 target 分组内去掉重复 / 近似重复（保留排序靠前者）
    const merged: Array<{ kept: number; dropped: number[]; target: string }> =
      [];
    const droppedIds: number[] = [];
    let mergeGroups = 0;
    if (opts.merge !== false) {
      const rows = this.#kb.targetRows({
        project: opts.project,
        limit: limit * 10,
      });
      const byTarget = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = row.target ?? "";
        const bucket = byTarget.get(key);
        if (bucket === undefined) byTarget.set(key, [row]);
        else bucket.push(row);
      }
      for (const [target, group] of byTarget) {
        if (group.length < 2) continue;
        mergeGroups += 1;
        const ordered = [...group].sort(
          (a, b) =>
            b.importance - a.importance ||
            b.lastReferenced - a.lastReferenced ||
            a.id - b.id,
        );
        const kept: typeof ordered = [];
        const dropped: number[] = [];
        for (const row of ordered) {
          const text = normalize(row.content);
          const covered = kept.some((k) =>
            redundant(text, normalize(k.content)),
          );
          if (covered) dropped.push(row.id);
          else kept.push(row);
        }
        if (dropped.length > 0) {
          const keeper = kept[0];
          if (keeper !== undefined) {
            merged.push({ kept: keeper.id, dropped, target });
            droppedIds.push(...dropped);
          }
        }
      }
      if (!dryRun && droppedIds.length > 0) this.#kb.evict(droppedIds);
    }

    // 3）淘汰：陈旧条目先压缩降级再硬淘汰
    let compressed = 0;
    let evicted = 0;
    let stale: number[] = [];
    if (opts.evict !== false) {
      stale = this.#kb.staleCandidates({
        project: opts.project,
        ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
        maxImportance: opts.maxImportance ?? 2,
        limit,
        now,
      });
      if (!dryRun && stale.length > 0) {
        compressed = this.#kb.compress(stale);
        evicted = this.#kb.evict(stale);
      }
    }

    // 4）容量守卫：仍超预算时按「低重要度 → 最旧」继续降级 / 淘汰
    const budget =
      opts.maxTokens !== undefined && opts.maxTokens > 0 && !dryRun
        ? enforceBudget(this.#kb, {
            project: opts.project,
            maxTokens: opts.maxTokens,
            batch: limit,
          })
        : null;
    if (budget !== null) {
      compressed += budget.compressed;
      evicted += budget.evicted;
    }

    return {
      project: opts.project,
      at: now,
      dryRun,
      scanned: {
        boost: boostCandidates.length,
        mergeGroups,
        stale: stale.length,
      },
      promoted,
      merged,
      compressed,
      evicted,
      budget,
      tokensBefore,
      tokensAfter: dryRun
        ? tokensBefore
        : this.#kb.tokenBudgetUsage(opts.project),
    };
  }
}
