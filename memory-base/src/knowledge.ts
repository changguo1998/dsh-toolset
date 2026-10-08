/**
 * ctx_knowledge 四接口实现：search / put / touch / evict。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md 与 docs/DESIGN.md §4 / §5 / §7：
 * - put：分类闸门（未注册 kind 拒写；兜底分类可被层禁用）→ 隐私底线 → 注册方写前钩子 →
 *   content_hash 去重、~2K token 按 markdown 边界分块、source 记账（chunk_count）、按需建表；
 * - search：跨已注册分类的并集检索（层 × 分类），porter 语义 BM25（可叠加 trigram 模糊召回），
 *   命中即更新 last_referenced（提升 §12.4）；结果带 `kind` 标签；
 * - touch：手动刷新 last_referenced（LRU 参考计数入口）；
 * - evict：删除 chunks 并联动 sources.chunk_count，归零清理 source（§12.3 溯源联动，供 #9 淘汰策略复用）。
 * 仅依赖 node:sqlite + node:crypto，无新增依赖。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  checkContent,
  compileRules,
  matchDenyPattern,
  type CompiledRules,
  type SkipReason,
} from "./rules.ts";
import { fallbackSpec, KindRegistry, type RegisteredKind } from "./router.ts";
import { ensureKindTable } from "./schema.ts";

/** 单块 token 预算上限（~2K token）。 */
const MAX_TOKENS = 2000;
// ponytail: 粗略估算 1 token ≈ 3 字符（ASCII/CJK 平均）。精确 tokenizer 需要时再引入。

/** 存量回扫命中的一行（**不含正文**：报告不回显内容）。 */
export interface DeniedRow {
  kind: string;
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
  /** 分类（设计 §4）：须已注册；缺省按事件类型认领路由，再落兜底分类。 */
  kind?: string;
  /** 事件类型 / 旧「类别」元数据：参与注册方的事件认领路由；随行存入 `category` 列。 */
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
  /** 限定单个分类（设计 §7「层 × 分类」）；缺省查全部参与检索的分类。 */
  kind?: string;
  limit?: number;
  /** true 时叠加 trigram 子串召回（无法召回 <3 字符的串）。 */
  fuzzy?: boolean;
}

export interface SearchHit {
  id: number;
  /** 所属分类（即命中行的物理表）。 */
  kind: string;
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

/**
 * 跨分类行句柄（决策 D39）：各分类表 id 独立自增，裸 id 只在单表内有意义；
 * 跨表维护方法一律以 `(kind, id)` 定位行。裸 `number` 仅作 v1 兼容入口 = 兜底表的行。
 */
export interface RowRef {
  kind: string;
  id: number;
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

function mapHit(
  row: Record<string, unknown>,
  score: number,
  kind: string,
): SearchHit {
  return {
    id: Number(row.id),
    kind,
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

/** 缺省注册表：只有兜底分类（v1 兼容行为——全部写入落 `chunks`）。 */
function defaultRegistry(): KindRegistry {
  const registry = new KindRegistry();
  registry.register(fallbackSpec(registry.fallbackKind));
  return registry;
}

export class KnowledgeService {
  readonly #db: DatabaseSync;
  readonly #rules: CompiledRules;
  readonly #registry: KindRegistry;
  readonly #allowFallback: boolean;
  /** 本连接已建过表的分类（「空表不建」，首次写入时才建；连接内缓存避免重复 DDL）。 */
  readonly #ensured = new Set<string>();
  readonly #tableExistsStmt: StatementSync;

  /**
   * @param db 已打开的层库连接。
   * @param options.rules 该层的入库闸门（**闸门在库核心**，设计 §5）：缺省只用内置隐私底线。
   *   调用方（事件钩子 / writeBack / backfill / memory.add）无法绕过——这是「换个调用方就绕过」的修复点。
   * @param options.registry 分类注册表（设计 §4）：缺省只注册兜底分类（落 `chunks`，v1 兼容）。
   * @param options.allowFallback 是否允许未指定 `kind` 的写入落兜底分类（设计 §5：U 层不允许）。
   */
  constructor(
    db: DatabaseSync,
    options: {
      rules?: CompiledRules;
      registry?: KindRegistry;
      allowFallback?: boolean;
    } = {},
  ) {
    this.#db = db;
    this.#rules = options.rules ?? compileRules(undefined, null);
    this.#registry = options.registry ?? defaultRegistry();
    this.#allowFallback = options.allowFallback ?? true;
    this.#tableExistsStmt = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    );
  }

  /** 兜底分类名（裸 id 的归属；来自注册表配置）。 */
  get fallbackKind(): string {
    return this.#registry.fallbackKind;
  }

  /** 兜底分类的物理表名（裸 id 与 memory 域直写的落点；缺省 v1 的 `chunks`）。 */
  get fallbackTable(): string | undefined {
    return this.#registry.fallback()?.table;
  }

  /** 该表是否已存在（「空表不建」：未写入过的分类表不存在）。 */
  #tableExists(table: string): boolean {
    return this.#tableExistsStmt.get(table) !== undefined;
  }

  /** 已注册且已建表的分类（跨表读写的遍历面；未建表 = 空分类，无可读写行）。 */
  #existingEntries(): RegisteredKind[] {
    return this.#registry
      .list()
      .filter((entry) => this.#tableExists(entry.table));
  }

  /** 把行句柄按物理表分组；解析不到分类（未注册）的句柄忽略。 */
  #groupByTable(refs: readonly (number | RowRef)[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const ref of refs) {
      const kind =
        typeof ref === "number" ? this.#registry.fallbackKind : ref.kind;
      const table = this.#registry.resolve(kind)?.table;
      if (table === undefined) continue;
      const ids = out.get(table) ?? [];
      ids.push(typeof ref === "number" ? ref : ref.id);
      out.set(table, ids);
    }
    return out;
  }

  /** 兜底分类的行句柄（裸 id → RowRef 的桥）。 */
  #asRef(ref: number | RowRef): RowRef {
    return typeof ref === "number"
      ? { kind: this.#registry.fallbackKind, id: ref }
      : ref;
  }

  /** 全部分类表的行数合计（容量/摘要统计用）。 */
  countAll(): number {
    let total = 0;
    for (const entry of this.#existingEntries()) {
      const row = this.#db
        .prepare(`SELECT COUNT(*) AS n FROM ${entry.table}`)
        .get() as { n: number };
      total += Number(row.n);
    }
    return total;
  }

  /**
   * 检索（设计 §7「层 × 分类」）：对全部参与检索的分类表取并集；porter 语义 BM25（fuzzy 时叠加
   * trigram 子串召回），命中即更新 last_referenced。结果按并入顺序去重、全局截断到 limit。
   */
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

    const participants = this.#registry.participants({
      query: opts.query,
      project: opts.project,
      target: opts.target,
      kind: opts.kind,
    });
    // 「空表不建」：还没建表的分类无行可查，跳过（建表由 put 按需触发）。
    const entries = participants.filter((entry) =>
      this.#tableExists(entry.table),
    );

    const runQuery = (
      entry: RegisteredKind,
      fts: string,
    ): Array<{ row: SearchHit; score: number }> => {
      const rows = this.#db
        .prepare(
          `SELECT c.${SOURCE_COLUMNS.replaceAll(", ", ", c.")}, bm25(${fts}) AS score
           FROM ${fts} JOIN ${entry.table} c ON c.id = ${fts}.rowid
           WHERE ${fts} MATCH ?${where}
           ORDER BY score LIMIT ?`,
        )
        .all(opts.query, ...params, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        row: mapHit(row, Number(row.score), entry.kind),
        score: Number(row.score),
      }));
    };

    // 并集去重键 = (kind, id)：各分类表 id 独立自增，裸 id 会跨表相撞（决策 D39）。
    const hits = new Map<string, SearchHit>();
    const owners = new Map<string, RegisteredKind>();
    const add = (entry: RegisteredKind, hit: SearchHit): boolean => {
      const key = `${entry.kind}\u0000${hit.id}`;
      if (hits.has(key)) return false;
      if (hits.size >= limit) return false;
      hits.set(key, hit);
      owners.set(key, entry);
      return true;
    };

    // FTS5 对自由输入语法错误（如 '-' 排除符）容错：失败退回 LIKE 兜底。
    let ftsFailed = false;
    for (const entry of entries) {
      try {
        for (const { row } of runQuery(entry, entry.fts)) add(entry, row);
      } catch {
        ftsFailed = true;
      }
      if (opts.fuzzy) {
        try {
          for (const { row } of runQuery(entry, entry.trigram)) add(entry, row);
        } catch {
          ftsFailed = true;
        }
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
      for (const entry of entries) {
        if (hits.size >= limit) break;
        const likeRows = this.#db
          .prepare(
            `SELECT c.${SOURCE_COLUMNS.replaceAll(", ", ", c.")} FROM ${entry.table} c
             WHERE (c.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')${where}
             LIMIT ?`,
          )
          .all(like, like, ...params, limit - hits.size) as Array<
          Record<string, unknown>
        >;
        for (const row of likeRows) {
          if (hits.size >= limit) break;
          add(entry, mapHit(row, 0, entry.kind));
        }
      }
    }
    // last_referenced 按命中行所在的表刷新（各分类表独立）。
    const byTable = new Map<string, number[]>();
    for (const [key, hit] of hits) {
      const entry = owners.get(key);
      if (entry === undefined) continue;
      const ids = byTable.get(entry.table) ?? [];
      ids.push(hit.id);
      byTable.set(entry.table, ids);
    }
    for (const [table, ids] of byTable) {
      const touch = this.#db.prepare(
        `UPDATE ${table} SET last_referenced = ? WHERE id = ?`,
      );
      for (const id of ids) touch.run(now, id);
    }
    return [...hits.values()];
  }

  /** 写入：**先过本层闸门**（设计 §5：隐私 → 分类 → 钩子），再去重 + 分块 + source 记账。 */
  put(input: PutInput): PutResult {
    // 闸门 1：隐私底线（六类形态 + profile 扩展）。
    const verdict = checkContent(this.#rules, input.content);
    if (!verdict.accept) {
      return {
        ids: [],
        sourceId: 0,
        created: 0,
        skipped: verdict.reason ?? "pattern",
      };
    }
    // 闸门 2：分类闸门（设计 §4）——显式 kind > 事件类型认领 > 兜底；未注册拒写并回报。
    const entry = this.#registry.pick({
      kind: input.kind,
      eventType: input.category,
    });
    if (
      entry === undefined ||
      // 该层禁止落兜底（U 层）：未显式给 kind 一律拒写。
      (!this.#allowFallback && input.kind === undefined)
    ) {
      return { ids: [], sourceId: 0, created: 0, skipped: "kind" };
    }
    // 闸门 3：注册方写前钩子（隐私闸之后、INSERT 之前）；可建议 importance。
    const hook = entry.preWrite?.({
      content: input.content,
      title: input.title,
      project: input.project,
      kind: entry.kind,
    });
    if (hook !== undefined && !hook.accept) {
      return { ids: [], sourceId: 0, created: 0, skipped: "hook" };
    }
    const now = Date.now();
    const importance = Math.max(
      1,
      Math.min(5, hook?.importance ?? input.importance ?? 3),
    );
    const source = input.source ?? { kind: "manual" as const };
    const chunks = chunkContent(input.content);
    const fullHash = sha256(input.content);

    // 「空表不建」（设计 §4）：首次写到该分类时才建表；连接内缓存已建集合。
    if (!this.#ensured.has(entry.table)) {
      ensureKindTable(this.#db, entry.table, entry.columns);
      this.#ensured.add(entry.table);
    }

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

      // 去重与插入都落在该分类自己的物理表（决策 D39：跨表 id 独立，键 = (kind, id)）。
      const existing = this.#db.prepare(
        `SELECT id FROM ${entry.table} WHERE content_hash = ? LIMIT 1`,
      );
      const insert = this.#db.prepare(
        `INSERT INTO ${entry.table}
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
  touch(ref: number | RowRef): boolean {
    const row = this.#asRef(ref);
    const table = this.#registry.resolve(row.kind)?.table;
    if (table === undefined) return false;
    const result = this.#db
      .prepare(`UPDATE ${table} SET last_referenced = ? WHERE id = ?`)
      .run(Date.now(), row.id);
    return Number(result.changes) > 0;
  }

  /**
   * 删除行（供 #9 淘汰策略复用），联动 sources.chunk_count，归零清理 source。
   * 裸 `number` 视为兜底表的行（v1 兼容）；跨表删除后 chunk_count 聚合**全部分类表**重算
   * （决策 D40：只算本表会把其他表的行误判为孤儿并连带删掉来源）。
   */
  evict(refs: readonly (number | RowRef)[]): number {
    const byTable = this.#groupByTable(refs);
    if (byTable.size === 0) return 0;
    this.#db.exec("BEGIN");
    try {
      let deleted = 0;
      for (const [table, ids] of byTable) {
        const stmt = this.#db.prepare(`DELETE FROM ${table} WHERE id = ?`);
        for (const id of ids) deleted += Number(stmt.run(id).changes);
      }
      const tables = this.#existingEntries().map((entry) => entry.table);
      if (tables.length > 0) {
        const parts = tables
          .map(
            (table) =>
              `(SELECT COUNT(*) FROM ${table} WHERE ${table}.source_id = sources.id)`,
          )
          .join(" + ");
        this.#db.exec(`UPDATE sources SET chunk_count = ${parts}`);
      }
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
    // 跨分类回扫（设计 §5「存量回扫」）：逐张已建表的分类表扫一遍。
    const rows: Array<{
      kind: string;
      id: number;
      content: string;
      category: string | null;
      project: string;
    }> = [];
    for (const entry of this.#existingEntries()) {
      const sql =
        opts.project === undefined
          ? `SELECT id, content, category, project FROM ${entry.table}`
          : `SELECT id, content, category, project FROM ${entry.table} WHERE project = ?`;
      const found = this.#db
        .prepare(sql)
        .all(...(opts.project === undefined ? [] : [opts.project])) as Array<{
        id: number;
        content: string;
        category: string | null;
        project: string;
      }>;
      for (const row of found) rows.push({ kind: entry.kind, ...row });
    }

    const hits: DeniedRow[] = [];
    const byCategory: Record<string, number> = {};
    for (const row of rows) {
      const pattern = matchDenyPattern(compiled, row.content);
      if (pattern === null) continue;
      hits.push({
        kind: row.kind,
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
      removed: applied
        ? this.evict(hits.map((hit) => ({ kind: hit.kind, id: hit.id })))
        : 0,
    };
  }

  /**
   * 硬淘汰候选（设计 §8 统一顺序）：`importance` 升序 → `last_referenced` 升序 → `id` 升序。
   * 按**缺口**取（不是「每轮固定 N 条」）；`importance = 5` 与已提升行照常参与（否则上限不可满足）。
   * 跨分类：逐表取候选后按同一排序合并（保证全局优先级，而非按表轮流）。
   */
  evictionCandidates(opts: { limit?: number } = {}): RowRef[] {
    const limit = Math.max(1, opts.limit ?? 10);
    const merged = this.#existingEntries().flatMap((entry) =>
      (
        this.#db
          .prepare(
            `SELECT id, importance, last_referenced FROM ${entry.table}
             ORDER BY importance ASC, last_referenced ASC, id ASC LIMIT ?`,
          )
          .all(limit) as Array<{
          id: number;
          importance: number;
          last_referenced: number;
        }>
      ).map((row) => ({ entry, ...row })),
    );
    merged.sort(
      (a, b) =>
        a.importance - b.importance ||
        a.last_referenced - b.last_referenced ||
        a.id - b.id,
    );
    return merged
      .slice(0, limit)
      .map(({ entry, id }) => ({ kind: entry.kind, id: Number(id) }));
  }

  /**
   * 降级候选（设计 §8：**只对 S 层生效**，就地压缩保留可检索足迹）：
   * 跳过 `importance = 5`（它们仍参与硬淘汰），且**只取尚未压缩过的行**（`summary IS NULL`）
   * ——压缩是幂等的有限动作，重复挑同一批会让淘汰循环无法收敛。
   */
  demotionCandidates(opts: { limit?: number } = {}): RowRef[] {
    const limit = Math.max(1, opts.limit ?? 10);
    const merged = this.#existingEntries().flatMap((entry) =>
      (
        this.#db
          .prepare(
            `SELECT id, importance, last_referenced FROM ${entry.table}
             WHERE importance < 5 AND summary IS NULL
             ORDER BY importance ASC, last_referenced ASC, id ASC LIMIT ?`,
          )
          .all(limit) as Array<{
          id: number;
          importance: number;
          last_referenced: number;
        }>
      ).map((row) => ({ entry, ...row })),
    );
    merged.sort(
      (a, b) =>
        a.importance - b.importance ||
        a.last_referenced - b.last_referenced ||
        a.id - b.id,
    );
    return merged
      .slice(0, limit)
      .map(({ entry, id }) => ({ kind: entry.kind, id: Number(id) }));
  }

  /** 淘汰候选：last_referenced 早于 ttl 且 importance 不高于上限（§12.3 LRU+importance）。 */
  staleCandidates(opts: {
    project: string;
    ttlMs: number;
    maxImportance?: number;
    limit?: number;
    now?: number;
  }): RowRef[] {
    const now = opts.now ?? Date.now();
    const maxImportance = opts.maxImportance ?? 2;
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const merged = this.#existingEntries().flatMap((entry) =>
      (
        this.#db
          .prepare(
            `SELECT id, last_referenced FROM ${entry.table}
             WHERE project = ? AND last_referenced > 0 AND last_referenced < ? AND importance <= ?
             ORDER BY last_referenced ASC LIMIT ?`,
          )
          .all(opts.project, now - opts.ttlMs, maxImportance, limit) as Array<{
          id: number;
          last_referenced: number;
        }>
      ).map((row) => ({ entry, ...row })),
    );
    merged.sort((a, b) => a.last_referenced - b.last_referenced || a.id - b.id);
    return merged
      .slice(0, limit)
      .map(({ entry, id }) => ({ kind: entry.kind, id: Number(id) }));
  }

  /** 压缩为单行摘要（内容降为摘要行，保留可检索足迹，供淘汰前降级 §12.3）。 */
  compress(refs: readonly (number | RowRef)[]): number {
    let changed = 0;
    for (const [table, ids] of this.#groupByTable(refs)) {
      const select = this.#db.prepare(
        `SELECT content FROM ${table} WHERE id = ?`,
      );
      const update = this.#db.prepare(
        `UPDATE ${table} SET content = ?, summary = ? WHERE id = ?`,
      );
      for (const id of ids) {
        const row = select.get(id) as { content: string } | undefined;
        if (row === undefined) continue;
        const line = (
          row.content.split("\n").find((l) => l.trim().length > 0) ?? ""
        ).trim();
        const summaryLine = line.slice(0, 300);
        changed += Number(update.run(summaryLine, summaryLine, id).changes);
      }
    }
    return changed;
  }

  /** project 级内容体积估算（token，供超预算淘汰触发判断 §12.3）；跨分类表求和。 */
  tokenBudgetUsage(project: string): number {
    let tokens = 0;
    for (const entry of this.#existingEntries()) {
      const row = this.#db
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(content) / 3), 0) AS tokens FROM ${entry.table} WHERE project = ?`,
        )
        .get(project) as { tokens: number };
      tokens += Number(row.tokens);
    }
    return tokens;
  }

  /** 提升候选（巩固用）：被检索命中过（`last_referenced > created_at`）且还能提权（importance < 5）。 */
  boostCandidates(opts: {
    project: string;
    limit?: number;
    now?: number;
  }): Array<
    RowRef & {
      importance: number;
      lastReferenced: number;
      createdAt: number;
    }
  > {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    const merged = this.#existingEntries().flatMap((entry) =>
      (
        this.#db
          .prepare(
            `SELECT id, importance, last_referenced, created_at FROM ${entry.table}
             WHERE project = ? AND importance < 5 AND last_referenced > created_at
             ORDER BY importance DESC, last_referenced DESC, id ASC
             LIMIT ?`,
          )
          .all(opts.project, limit) as Array<{
          id: number;
          importance: number;
          last_referenced: number;
          created_at: number;
        }>
      ).map((row) => ({ entry, ...row })),
    );
    merged.sort(
      (a, b) =>
        b.importance - a.importance ||
        b.last_referenced - a.last_referenced ||
        a.id - b.id,
    );
    return merged.slice(0, limit).map(({ entry, id, ...row }) => ({
      kind: entry.kind,
      id: Number(id),
      importance: Number(row.importance),
      lastReferenced: Number(row.last_referenced),
      createdAt: Number(row.created_at),
    }));
  }

  /** 设置 importance（clamp 1..5）；返回是否有变更。 */
  setImportance(ref: number | RowRef, importance: number): boolean {
    const row = this.#asRef(ref);
    const table = this.#registry.resolve(row.kind)?.table;
    if (table === undefined) return false;
    const value = Math.max(1, Math.min(5, Math.trunc(importance)));
    const result = this.#db
      .prepare(`UPDATE ${table} SET importance = ? WHERE id = ?`)
      .run(value, row.id);
    return Number(result.changes) > 0;
  }

  /** 具名记忆条目（`target` 非空）快照，供合并判据分组（按 target / importance / 最近引用排序）。 */
  targetRows(opts: { project: string; limit?: number }): Array<
    RowRef & {
      target: string | null;
      content: string;
      importance: number;
      lastReferenced: number;
    }
  > {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    const merged = this.#existingEntries().flatMap((entry) =>
      (
        this.#db
          .prepare(
            `SELECT id, target, content, importance, last_referenced FROM ${entry.table}
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
        }>
      ).map((row) => ({ entry, ...row })),
    );
    merged.sort(
      (a, b) =>
        (a.target ?? "").localeCompare(b.target ?? "") ||
        b.importance - a.importance ||
        b.last_referenced - a.last_referenced ||
        a.id - b.id,
    );
    return merged.slice(0, limit).map(({ entry, id, ...row }) => ({
      kind: entry.kind,
      id: Number(id),
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
  budgetCandidates(opts: { project: string; limit?: number }): RowRef[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    const merged = this.#existingEntries().flatMap((entry) =>
      (
        this.#db
          .prepare(
            `SELECT id, importance,
                    CASE WHEN last_referenced > 0 THEN last_referenced ELSE created_at END AS recent
             FROM ${entry.table}
             WHERE project = ?
             ORDER BY importance ASC, recent ASC, id ASC
             LIMIT ?`,
          )
          .all(opts.project, limit) as Array<{
          id: number;
          importance: number;
          recent: number;
        }>
      ).map((row) => ({ entry, ...row })),
    );
    merged.sort(
      (a, b) =>
        a.importance - b.importance || a.recent - b.recent || a.id - b.id,
    );
    return merged
      .slice(0, limit)
      .map(({ entry, id }) => ({ kind: entry.kind, id: Number(id) }));
  }

  /** resume top-K 提升：last_referenced 倒序 × importance 加权（§12.4），供注入 L0/回填。 */
  promote(opts: {
    project: string;
    limit?: number;
    now?: number;
  }): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const now = opts.now ?? Date.now();
    const merged = this.#existingEntries().flatMap((entry) => {
      const rows = this.#db
        .prepare(
          `SELECT c.${SOURCE_COLUMNS.replaceAll(", ", ", c.")},
             c.importance * (1.0 / (1.0 + ((? - c.last_referenced) / 86400000.0))) AS score
           FROM ${entry.table} c
           WHERE c.project = ? AND c.last_referenced > 0
           ORDER BY score DESC, c.last_referenced DESC
           LIMIT ?`,
        )
        .all(now, opts.project, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        row: mapHit(row, Number(row.score), entry.kind),
        lastReferenced: Number(row.last_referenced),
      }));
    });
    merged.sort(
      (a, b) =>
        b.row.score - a.row.score || b.lastReferenced - a.lastReferenced,
    );
    return merged.slice(0, limit).map((item) => item.row);
  }
}
