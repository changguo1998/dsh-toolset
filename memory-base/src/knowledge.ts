/**
 * ctx_knowledge 四接口实现：search / put / touch / evict。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md 与 docs/host/AGENT-ARCHITECTURE-ANALOGY.md §12：
 * - put：content_hash 去重、~2K token 按 markdown 边界分块、source 记账（chunk_count）；
 * - search：porter 语义 BM25 检索（可叠加 trigram 模糊召回），命中即更新 last_referenced（提升 §12.4）；
 * - touch：手动刷新 last_referenced（LRU 参考计数入口）；
 * - evict：删除 chunks 并联动 sources.chunk_count，归零清理 source（§12.3 溯源联动，供 #9 淘汰策略复用）。
 * 仅依赖 node:sqlite + node:crypto，无新增依赖。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  checkContent,
  compileRules,
  matchDenyPattern,
  type CompiledRules,
  type SkipReason,
} from "./rules.ts";

/** 单块 token 预算上限（~2K token）。 */
const MAX_TOKENS = 2000;
// ponytail: 粗略估算 1 token ≈ 3 字符（ASCII/CJK 平均）。精确 tokenizer 需要时再引入。

/** 存量回扫命中的一行（**不含正文**：报告不回显内容）。 */
export interface DeniedRow {
  id: number;
  /** 命中的拒绝模式源串。 */
  pattern: string;
  category: string | null;
  project: string;
}

/** 存量回扫报告（`apply: false` 时只看前四项，用于「先报告、后清理」）。 */
export interface RescanReport {
  scanned: number;
  matched: number;
  /** 命中分布（按 category；无分类归 `(none)`）。 */
  byCategory: Record<string, number>;
  applied: boolean;
  hits: DeniedRow[];
  /** 实际删除的行数（`apply: true` 时）。 */
  removed: number;
}

export type SourceKind = "session" | "file" | "url" | "tool_result" | "manual";

export interface SourceRef {
  kind: SourceKind;
  label?: string;
  ref?: string;
}

export interface PutInput {
  /** 归属项目（跨会话检索/淘汰的作用域）。 */
  project: string;
  content: string;
  title?: string;
  target?: string;
  category?: string;
  importance?: number;
  sessionId?: string;
  source?: SourceRef;
}

export interface SearchOptions {
  query: string;
  project?: string;
  target?: string;
  category?: string;
  limit?: number;
  /** true 时叠加 trigram 子串召回（无法召回 <3 字符的串）。 */
  fuzzy?: boolean;
}

export interface SearchHit {
  id: number;
  project: string;
  target: string | null;
  category: string | null;
  title: string | null;
  content: string;
  summary: string | null;
  importance: number;
  lastReferenced: number;
  score: number;
}

export interface PutResult {
  ids: number[];
  sourceId: number;
  created: number;
  /** 被本层闸门拒绝的原因（拒绝时 `ids` 为空、不写库）。 */
  skipped?: SkipReason;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** 单个段落超限时按行/字节预算硬切。 */
function splitBlock(paragraph: string): string[] {
  const out: string[] = [];
  const maxChars = MAX_TOKENS * 3;
  let rest = paragraph;
  while (estimateTokens(rest) > MAX_TOKENS) {
    const nl = rest.lastIndexOf("\n", maxChars);
    const cut = nl > maxChars * 0.5 ? nl : maxChars;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** 按 markdown 段落边界切块，保持每块 ≤ budget。 */
function chunkContent(content: string): string[] {
  if (estimateTokens(content) <= MAX_TOKENS) return [content];
  const chunks: string[] = [];
  let acc: string[] = [];
  let accTokens = 0;
  for (const paragraph of content.split(/\n\s*\n/)) {
    const tokens = estimateTokens(paragraph);
    if (accTokens + tokens > MAX_TOKENS && acc.length > 0) {
      chunks.push(acc.join("\n\n"));
      acc = [];
      accTokens = 0;
    }
    if (tokens > MAX_TOKENS) {
      chunks.push(...splitBlock(paragraph));
      continue;
    }
    acc.push(paragraph);
    accTokens += tokens;
  }
  if (acc.length > 0) chunks.push(acc.join("\n\n"));
  return chunks;
}

const SOURCE_COLUMNS =
  "id, project, target, category, title, content, summary, importance, last_referenced";

function mapHit(row: Record<string, unknown>, score: number): SearchHit {
  return {
    id: Number(row.id),
    project: String(row.project),
    target: row.target == null ? null : String(row.target),
    category: row.category == null ? null : String(row.category),
    title: row.title == null ? null : String(row.title),
    content: String(row.content),
    summary: row.summary == null ? null : String(row.summary),
    importance: Number(row.importance),
    lastReferenced: Number(row.last_referenced),
    score,
  };
}

export class KnowledgeService {
  readonly #db: DatabaseSync;
  readonly #rules: CompiledRules;

  /**
   * @param db 已打开的层库连接。
   * @param options.rules 该层的入库闸门（**闸门在库核心**，设计 §5）：缺省只用内置隐私底线。
   *   调用方（事件钩子 / writeBack / backfill / memory.add）无法绕过——这是「换个调用方就绕过」的修复点。
   */
  constructor(db: DatabaseSync, options: { rules?: CompiledRules } = {}) {
    this.#db = db;
    this.#rules = options.rules ?? compileRules(undefined, null);
  }

  /** 检索（porter 语义 BM25；fuzzy 时叠加 trigram 子串召回），命中即更新 last_referenced。 */
  search(opts: SearchOptions): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (opts.project !== undefined) {
      filters.push("c.project = ?");
      params.push(opts.project);
    }
    if (opts.target !== undefined) {
      filters.push("c.target = ?");
      params.push(opts.target);
    }
    if (opts.category !== undefined) {
      filters.push("c.category = ?");
      params.push(opts.category);
    }
    const where = filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";

    const runQuery = (
      table: string,
    ): Array<{ row: SearchHit; score: number }> => {
      const rows = this.#db
        .prepare(
          `SELECT c.${SOURCE_COLUMNS.replaceAll(", ", ", c.")}, bm25(${table}) AS score
           FROM ${table} JOIN chunks c ON c.id = ${table}.rowid
           WHERE ${table} MATCH ?${where}
           ORDER BY score LIMIT ?`,
        )
        .all(opts.query, ...params, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        row: mapHit(row, Number(row.score)),
        score: Number(row.score),
      }));
    };

    // FTS5 对自由输入语法错误（如 '-' 排除符）容错：失败退回 LIKE 兜底。
    let porter: Array<{ row: SearchHit; score: number }>;
    let ftsFailed = false;
    try {
      porter = runQuery("chunks_fts");
    } catch {
      ftsFailed = true;
      porter = [];
    }
    const hits = new Map<number, SearchHit>();
    for (const { row } of porter) hits.set(row.id, row);
    if (opts.fuzzy) {
      let trigram: Array<{ row: SearchHit; score: number }> = [];
      try {
        trigram = runQuery("chunks_trigram_fts");
      } catch {
        ftsFailed = true;
        trigram = [];
      }
      for (const { row } of trigram) {
        if (!hits.has(row.id) && hits.size < limit) hits.set(row.id, row);
      }
    }

    const now = Date.now();
    // LIKE 子串兜底：仅在 FTS 语法错误或 CJK 短词（≤2 字符 porter/trigram 无法召回）时启用，
    // 保持 fuzzy 语义（fuzzy=false 不额外子串召回）。
    if (
      hits.size < limit &&
      (ftsFailed || /[\u4e00-\u9fff]/u.test(opts.query))
    ) {
      const like = `%${opts.query
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_")}%`;
      const likeRows = this.#db
        .prepare(
          `SELECT c.${SOURCE_COLUMNS.replaceAll(", ", ", c.")} FROM chunks c
           WHERE (c.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')${where}
           LIMIT ?`,
        )
        .all(like, like, ...params, limit - hits.size) as Array<
        Record<string, unknown>
      >;
      for (const row of likeRows) {
        if (hits.size >= limit) break;
        const id = Number(row.id);
        if (!hits.has(id)) hits.set(id, mapHit(row, 0));
      }
    }
    const touch = this.#db.prepare(
      "UPDATE chunks SET last_referenced = ? WHERE id = ?",
    );
    for (const id of hits.keys()) touch.run(now, id);
    return [...hits.values()];
  }

  /** 写入：**先过本层闸门**（设计 §5），再去重 + 分块 + source 记账。 */
  put(input: PutInput): PutResult {
    const verdict = checkContent(this.#rules, input.content);
    if (!verdict.accept) {
      return {
        ids: [],
        sourceId: 0,
        created: 0,
        skipped: verdict.reason ?? "pattern",
      };
    }
    const now = Date.now();
    const importance = Math.max(1, Math.min(5, input.importance ?? 3));
    const source = input.source ?? { kind: "manual" as const };
    const chunks = chunkContent(input.content);
    const fullHash = sha256(input.content);

    const existingSource = this.#db
      .prepare(
        "SELECT id FROM sources WHERE content_hash = ? AND kind = ? LIMIT 1",
      )
      .get(fullHash, source.kind) as { id: number } | undefined;

    this.#db.exec("BEGIN");
    try {
      let sourceId: number;
      if (existingSource === undefined) {
        sourceId = Number(
          this.#db
            .prepare(
              "INSERT INTO sources (kind, label, ref, content_hash, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              source.kind,
              source.label ?? null,
              source.ref ?? null,
              fullHash,
              0,
              now,
            ).lastInsertRowid,
        );
      } else {
        sourceId = Number(existingSource.id);
      }

      const existing = this.#db.prepare(
        "SELECT id FROM chunks WHERE content_hash = ? LIMIT 1",
      );
      const insert = this.#db.prepare(
        `INSERT INTO chunks
           (source_id, project, target, category, title, content, content_hash, importance, session_id, last_referenced, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ids: number[] = [];
      let created = 0;
      for (const chunk of chunks) {
        const dup = existing.get(sha256(chunk)) as { id: number } | undefined;
        if (dup !== undefined) {
          ids.push(Number(dup.id));
          continue;
        }
        const id = Number(
          insert.run(
            sourceId,
            input.project,
            input.target ?? null,
            input.category ?? null,
            input.title ?? null,
            chunk,
            sha256(chunk),
            importance,
            input.sessionId ?? null,
            now,
            now,
          ).lastInsertRowid,
        );
        ids.push(id);
        created += 1;
      }
      // source 记账按实际新增块数计数（去重命中的块不重复计入）。
      if (created > 0) {
        this.#db
          .prepare(
            "UPDATE sources SET chunk_count = chunk_count + ? WHERE id = ?",
          )
          .run(created, sourceId);
      }
      this.#db.exec("COMMIT");
      return { ids, sourceId, created };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 刷新 chunk 的 last_referenced（LRU 参考计数）。返回是否命中。 */
  touch(id: number): boolean {
    const result = this.#db
      .prepare("UPDATE chunks SET last_referenced = ? WHERE id = ?")
      .run(Date.now(), id);
    return Number(result.changes) > 0;
  }

  /** 删除 chunks（供 #9 淘汰策略复用），联动 sources.chunk_count，归零清理 source。 */
  evict(ids: number[]): number {
    if (ids.length === 0) return 0;
    this.#db.exec("BEGIN");
    try {
      const stmt = this.#db.prepare("DELETE FROM chunks WHERE id = ?");
      let deleted = 0;
      for (const id of ids) deleted += Number(stmt.run(id).changes);
      this.#db.exec(
        "UPDATE sources SET chunk_count = (SELECT COUNT(*) FROM chunks WHERE chunks.source_id = sources.id)",
      );
      this.#db.exec("DELETE FROM sources WHERE chunk_count = 0");
      this.#db.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 存量回扫（设计 §5 / §10）：按当前隐私拒绝模式重扫已有行，防「闸门上线前的存量」复发。
   * 默认只报告——条数 + 分类分布 + 命中模式源串，**不回显内容**；`apply: true` 才删除（走 `evict` 联动 source）。
   */
  rescanDenied(
    opts: { project?: string; apply?: boolean; rules?: CompiledRules } = {},
  ): RescanReport {
    const compiled = opts.rules ?? compileRules(undefined, null);
    const rows = (
      opts.project === undefined
        ? this.#db
            .prepare("SELECT id, content, category, project FROM chunks")
            .all()
        : this.#db
            .prepare(
              "SELECT id, content, category, project FROM chunks WHERE project = ?",
            )
            .all(opts.project)
    ) as Array<{
      id: number;
      content: string;
      category: string | null;
      project: string;
    }>;

    const hits: DeniedRow[] = [];
    const byCategory: Record<string, number> = {};
    for (const row of rows) {
      const pattern = matchDenyPattern(compiled, row.content);
      if (pattern === null) continue;
      hits.push({
        id: row.id,
        pattern,
        category: row.category,
        project: row.project,
      });
      const key = row.category ?? "(none)";
      byCategory[key] = (byCategory[key] ?? 0) + 1;
    }

    const applied = opts.apply === true && hits.length > 0;
    return {
      scanned: rows.length,
      matched: hits.length,
      byCategory,
      applied,
      hits,
      removed: applied ? this.evict(hits.map((hit) => hit.id)) : 0,
    };
  }

  /**
   * 硬淘汰候选（设计 §8 统一顺序）：`importance` 升序 → `last_referenced` 升序 → `id` 升序。
   * 按**缺口**取（不是「每轮固定 N 条」）；`importance = 5` 与已提升行照常参与（否则上限不可满足）。
   */
  evictionCandidates(opts: { limit?: number } = {}): number[] {
    const limit = Math.max(1, opts.limit ?? 10);
    return (
      this.#db
        .prepare(
          "SELECT id FROM chunks ORDER BY importance ASC, last_referenced ASC, id ASC LIMIT ?",
        )
        .all(limit) as Array<{ id: number }>
    ).map((row) => row.id);
  }

  /**
   * 降级候选（设计 §8：**只对 S 层生效**，就地压缩保留可检索足迹）：
   * 跳过 `importance = 5`（它们仍参与硬淘汰），且**只取尚未压缩过的行**（`summary IS NULL`）
   * ——压缩是幂等的有限动作，重复挑同一批会让淘汰循环无法收敛。
   */
  demotionCandidates(opts: { limit?: number } = {}): number[] {
    const limit = Math.max(1, opts.limit ?? 10);
    return (
      this.#db
        .prepare(
          "SELECT id FROM chunks WHERE importance < 5 AND summary IS NULL ORDER BY importance ASC, last_referenced ASC, id ASC LIMIT ?",
        )
        .all(limit) as Array<{ id: number }>
    ).map((row) => row.id);
  }

  /** 淘汰候选：last_referenced 早于 ttl 且 importance 不高于上限（§12.3 LRU+importance）。 */
  staleCandidates(opts: {
    project: string;
    ttlMs: number;
    maxImportance?: number;
    limit?: number;
    now?: number;
  }): number[] {
    const now = opts.now ?? Date.now();
    const maxImportance = opts.maxImportance ?? 2;
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const rows = this.#db
      .prepare(
        `SELECT id FROM chunks
         WHERE project = ? AND last_referenced > 0 AND last_referenced < ? AND importance <= ?
         ORDER BY last_referenced ASC LIMIT ?`,
      )
      .all(opts.project, now - opts.ttlMs, maxImportance, limit) as Array<{
      id: number;
    }>;
    return rows.map((row) => Number(row.id));
  }

  /** 压缩为单行摘要（内容降为摘要行，保留可检索足迹，供淘汰前降级 §12.3）。 */
  compress(ids: number[]): number {
    if (ids.length === 0) return 0;
    const update = this.#db.prepare(
      "UPDATE chunks SET content = ?, summary = ? WHERE id = ?",
    );
    let changed = 0;
    for (const id of ids) {
      const row = this.#db
        .prepare("SELECT content FROM chunks WHERE id = ?")
        .get(id) as { content: string } | undefined;
      if (row === undefined) continue;
      const line = (
        row.content.split("\n").find((l) => l.trim().length > 0) ?? ""
      ).trim();
      const summaryLine = line.slice(0, 300);
      changed += Number(update.run(summaryLine, summaryLine, id).changes);
    }
    return changed;
  }

  /** project 级内容体积估算（token，供超预算淘汰触发判断 §12.3）。 */
  tokenBudgetUsage(project: string): number {
    const row = this.#db
      .prepare(
        "SELECT COALESCE(SUM(LENGTH(content) / 3), 0) AS tokens FROM chunks WHERE project = ?",
      )
      .get(project) as { tokens: number };
    return Number(row.tokens);
  }

  /** 提升候选（巩固用）：被检索命中过（`last_referenced > created_at`）且还能提权（importance < 5）。 */
  boostCandidates(opts: {
    project: string;
    limit?: number;
    now?: number;
  }): Array<{
    id: number;
    importance: number;
    lastReferenced: number;
    createdAt: number;
  }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    const rows = this.#db
      .prepare(
        `SELECT id, importance, last_referenced, created_at FROM chunks
         WHERE project = ? AND importance < 5 AND last_referenced > created_at
         ORDER BY importance DESC, last_referenced DESC, id ASC
         LIMIT ?`,
      )
      .all(opts.project, limit) as Array<{
      id: number;
      importance: number;
      last_referenced: number;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      importance: Number(row.importance),
      lastReferenced: Number(row.last_referenced),
      createdAt: Number(row.created_at),
    }));
  }

  /** 设置 importance（clamp 1..5）；返回是否有变更。 */
  setImportance(id: number, importance: number): boolean {
    const value = Math.max(1, Math.min(5, Math.trunc(importance)));
    const result = this.#db
      .prepare("UPDATE chunks SET importance = ? WHERE id = ?")
      .run(value, id);
    return Number(result.changes) > 0;
  }

  /** 具名记忆条目（`target` 非空）快照，供合并判据分组（按 target / importance / 最近引用排序）。 */
  targetRows(opts: { project: string; limit?: number }): Array<{
    id: number;
    target: string | null;
    content: string;
    importance: number;
    lastReferenced: number;
  }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    const rows = this.#db
      .prepare(
        `SELECT id, target, content, importance, last_referenced FROM chunks
         WHERE project = ? AND target IS NOT NULL
         ORDER BY target ASC, importance DESC, last_referenced DESC, id ASC
         LIMIT ?`,
      )
      .all(opts.project, limit) as Array<{
      id: number;
      target: string | null;
      content: string;
      importance: number;
      last_referenced: number;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      target: row.target === null ? null : String(row.target),
      content: String(row.content),
      importance: Number(row.importance),
      lastReferenced: Number(row.last_referenced),
    }));
  }

  /**
   * 超预算淘汰候选（容量守卫用）：importance 升序 → 最近引用时间升序（未引用过用创建时间）。
   * 与 `staleCandidates` 的区别：后者按 TTL + 重要度上限筛「已经陈旧」的条目，本方法**不设门槛**，
   * 只给「先牺牲谁」的稳定顺序，由调用方按预算决定淘汰到哪。
   */
  budgetCandidates(opts: { project: string; limit?: number }): number[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    const rows = this.#db
      .prepare(
        `SELECT id FROM chunks
         WHERE project = ?
         ORDER BY importance ASC,
                  CASE WHEN last_referenced > 0 THEN last_referenced ELSE created_at END ASC,
                  id ASC
         LIMIT ?`,
      )
      .all(opts.project, limit) as Array<{ id: number }>;
    return rows.map((row) => Number(row.id));
  }

  /** resume top-K 提升：last_referenced 倒序 × importance 加权（§12.4），供注入 L0/回填。 */
  promote(opts: {
    project: string;
    limit?: number;
    now?: number;
  }): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const now = opts.now ?? Date.now();
    const rows = this.#db
      .prepare(
        `SELECT c.${SOURCE_COLUMNS.replaceAll(", ", ", c.")},
           c.importance * (1.0 / (1.0 + ((? - c.last_referenced) / 86400000.0))) AS score
         FROM chunks c
         WHERE c.project = ? AND c.last_referenced > 0
         ORDER BY score DESC, c.last_referenced DESC
         LIMIT ?`,
      )
      .all(now, opts.project, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => mapHit(row, Number(row.score)));
  }
}
