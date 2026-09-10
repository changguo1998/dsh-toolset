/**
 * #9 两级写策略与淘汰提升（docs/AGENT-ARCHITECTURE-ANALOGY.md §12.2-§12.4）。
 *
 * - 写直达（实时，会话内）：由 hooks.ts 事件过滤器完成（stage 4）；
 * - 批量写回（consolidation 锁）：WritePolicy.writeBack 在锁内聚合写入，失败项入 pending，
 *   backfill() 下次启动/compaction 重试兜底（最终一致）；
 * - 淘汰：evictStale 先 compress 降级（单行摘要），再硬淘汰（复用 kb.evict 联动 source 清理）；
 * - 提升：按 project 拉 top-K（last_referenced 倒序 × importance 加权，kb.promote）注入上下文。
 * 锁为进程内互斥；多进程共享同一库时需升级为文件锁（当前宿主单进程持有库）。
 */

import type { KnowledgeService, PutInput } from "./knowledge.ts";

/** 进程内互斥锁：同 key 串行化，防并发 consolidation（hermes `.consolidation-locks` 模式进程内版）。 */
// ponytail: 进程内锁；多进程共享库时升级为锁文件（如 .consolidation-locks 目录）。
export class ConsolidationLock {
  readonly #chains = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.#chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(() => gate);
    this.#chains.set(key, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#chains.get(key) === chain) this.#chains.delete(key);
    }
  }
}

export interface WriteBackResult {
  written: number;
  remaining: number;
}

export interface EvictResult {
  compressed: number;
  evicted: number;
}

export interface EvictStaleOptions {
  project: string;
  ttlMs: number;
  maxImportance?: number;
  limit?: number;
  now?: number;
  /** 硬淘汰前先压缩降级为单行摘要。 */
  compressFirst?: boolean;
}

/** 两级写策略编排：批量写回 + backfill 兜底 + 淘汰 + 提升。 */
export class WritePolicy {
  readonly #kb: KnowledgeService;
  readonly #lock = new ConsolidationLock();
  #pending: PutInput[] = [];

  constructor(kb: KnowledgeService) {
    this.#kb = kb;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  /** 批量写回（consolidation 锁内），失败项暂存 pending 供 backfill 重试。 */
  async writeBack(items: PutInput[]): Promise<WriteBackResult> {
    return this.#lock.withLock("writeback", () => {
      let written = 0;
      for (const item of items) {
        try {
          this.#kb.put(item);
          written += 1;
        } catch (error) {
          // 失败可延迟：留到下次 backfill（最终一致）。
          this.#pending.push(item);
        }
      }
      return { written, remaining: this.#pending.length };
    });
  }

  /** 重试 pending（下次启动/compaction 兜底）。成功项出队。 */
  async backfill(): Promise<WriteBackResult> {
    return this.#lock.withLock("writeback", () => {
      let written = 0;
      const stillPending: PutInput[] = [];
      for (const item of this.#pending) {
        try {
          this.#kb.put(item);
          written += 1;
        } catch (error) {
          stillPending.push(item);
        }
      }
      this.#pending = stillPending;
      return { written, remaining: this.#pending.length };
    });
  }

  /** 淘汰编排：可选先压缩降级，再硬淘汰（kb.evict 联动 chunks/sources 记账）。 */
  async evictStale(opts: EvictStaleOptions): Promise<EvictResult> {
    const candidates = this.#kb.staleCandidates({
      project: opts.project,
      ttlMs: opts.ttlMs,
      maxImportance: opts.maxImportance ?? 2,
      limit: opts.limit,
      now: opts.now,
    });
    if (candidates.length === 0) return { compressed: 0, evicted: 0 };
    const compressFirst = opts.compressFirst ?? true;
    const compressed = compressFirst ? this.#kb.compress(candidates) : 0;
    const evicted = this.#kb.evict(candidates);
    return { compressed, evicted };
  }
}
