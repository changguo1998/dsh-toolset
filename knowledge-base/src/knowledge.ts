/**
 * ctx_knowledge 四接口实现：search / put / touch / evict。
 *
 * 契约对齐 DSH-CTX-API.md 与 docs/AGENT-ARCHITECTURE-ANALOGY.md §12：
 * - put：content_hash 去重、~2K token 按 markdown 边界分块、source 记账（chunk_count）；
 * - search：porter 语义 BM25 检索（可叠加 trigram 模糊召回），命中即更新 last_referenced（提升 §12.4）；
 * - touch：手动刷新 last_referenced（LRU 参考计数入口）；
 * - evict：删除 chunks 并联动 sources.chunk_count，归零清理 source（§12.3 溯源联动，供 #9 淘汰策略复用）。
 * 仅依赖 node:sqlite + node:crypto，无新增依赖。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** 单块 token 预算上限（~2K token）。 */
const MAX_TOKENS = 2000;
// ponytail: 粗略估算 1 token ≈ 3 字符（ASCII/CJK 平均）。精确 tokenizer 需要时再引入。

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

  constructor(db: DatabaseSync) {
    this.#db = db;
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

    const porter = runQuery("chunks_fts");
    const hits = new Map<number, SearchHit>();
    for (const { row } of porter) hits.set(row.id, row);
    if (opts.fuzzy) {
      for (const { row } of runQuery("chunks_trigram_fts")) {
        if (!hits.has(row.id) && hits.size < limit) hits.set(row.id, row);
      }
    }

    const now = Date.now();
    const touch = this.#db.prepare(
      "UPDATE chunks SET last_referenced = ? WHERE id = ?",
    );
    for (const id of hits.keys()) touch.run(now, id);
    return [...hits.values()];
  }

  /** 写入：去重 + 分块 + source 记账。相同 content_hash 的块不重复写。 */
  put(input: PutInput): PutResult {
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
}
