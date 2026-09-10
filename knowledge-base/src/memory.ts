/**
 * #10 持久记忆 CRUD 与检索（docs/AGENT-ARCHITECTURE-ANALOGY.md §12 + BACKLOG #10）。
 * 记忆直接沉淀在 chunks 表（target=记忆域，类别=category），复用 knowledge 检索底座：
 * add（content_hash 去重）、replace / remove（按 target + 内容子串定位）、
 * search（target/category/project 过滤 + token-aware 预算截断）。
 * 检索命中经 kb.search 自动更新 last_referenced（提升）。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { KnowledgeService } from "./knowledge.ts";

export type MemoryTarget = "user" | "memory" | "project" | "failure";

/** 无 project 归属的全局记忆统一放入该 project 作用域。 */
export const GLOBAL_PROJECT = "__global__";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface MemoryAddInput {
  target: MemoryTarget;
  content: string;
  project?: string;
  category?: string;
  importance?: number;
}

export interface MemorySearchOptions {
  query: string;
  target?: string;
  project?: string;
  category?: string;
  limit?: number;
  /** true 时叠加 trigram 子串召回。 */
  fuzzy?: boolean;
  /** token 预算：命中按相关性顺序截断，返回实际用量与是否截断。 */
  tokenBudget?: number;
}

export interface MemoryHit {
  id: number;
  content: string;
  target: string | null;
  project: string;
  category: string | null;
  importance: number;
  lastReferenced: number;
  score: number;
}

export interface MemorySearchResult {
  hits: MemoryHit[];
  usedTokens: number;
  truncated: boolean;
}

export class MemoryService {
  readonly #db: DatabaseSync;
  readonly #kb: KnowledgeService;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#kb = new KnowledgeService(db);
  }

  /** 新增一条记忆；相同 content_hash 去重（返回既有 id）。 */
  add(input: MemoryAddInput): { id: number } {
    const result = this.#kb.put({
      project: input.project ?? GLOBAL_PROJECT,
      target: input.target,
      category: input.category,
      content: input.content,
      importance: input.importance ?? 3,
    });
    return { id: result.ids[0]! };
  }

  /** 按 target + 内容子串定位并替换内容；找不到返回 false。 */
  replace(input: {
    target: string;
    oldText: string;
    content: string;
    project?: string;
    category?: string;
    importance?: number;
  }): boolean {
    const id = this.findByText(input.target, input.oldText);
    if (id === undefined) return false;
    this.#db
      .prepare(
        `UPDATE chunks SET content = ?, content_hash = ?, category = ?, importance = ?, last_referenced = ? WHERE id = ?`,
      )
      .run(
        input.content,
        sha256(input.content),
        input.category ?? null,
        Math.max(1, Math.min(5, input.importance ?? 3)),
        Date.now(),
        id,
      );
    return true;
  }

  /** 按 target + 内容子串定位并删除；找不到返回 false。 */
  remove(input: { target: string; oldText: string }): boolean {
    const id = this.findByText(input.target, input.oldText);
    if (id === undefined) return false;
    return this.#kb.evict([id]) > 0;
  }

  /** 过滤检索（target/category/project）+ token-aware 预算截断。 */
  search(opts: MemorySearchOptions): MemorySearchResult {
    const hits = this.#kb.search({
      query: opts.query,
      project: opts.project,
      target: opts.target,
      category: opts.category,
      limit: opts.limit ?? 20,
      fuzzy: opts.fuzzy,
    });
    const budget = opts.tokenBudget;
    const out: MemoryHit[] = [];
    let usedTokens = 0;
    let truncated = false;
    for (const hit of hits) {
      const tokens = estimateTokens(hit.content);
      if (
        budget !== undefined &&
        usedTokens + tokens > budget &&
        out.length > 0
      ) {
        truncated = true;
        break;
      }
      out.push({
        id: hit.id,
        content: hit.content,
        target: hit.target,
        project: hit.project,
        category: hit.category,
        importance: hit.importance,
        lastReferenced: hit.lastReferenced,
        score: hit.score,
      });
      usedTokens += tokens;
    }
    return { hits: out, usedTokens, truncated };
  }

  /** target 域内按内容子串定位首条 chunk id（LIKE 转义）。 */
  findByText(target: string, text: string): number | undefined {
    const like = `%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const row = this.#db
      .prepare(
        "SELECT id FROM chunks WHERE target = ? AND (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\') ORDER BY id LIMIT 1",
      )
      .get(target, like, like) as { id: number } | undefined;
    return row === undefined ? undefined : Number(row.id);
  }
}
