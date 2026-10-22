/**
 * 存储层读写：`put` / `search` / `listRows` / `evict`。
 *
 * 口径（2026-10-17 接口重设）：本文件只做**存储**，不承载管理逻辑——
 * - `put`：隐私底线 → 注册方 `preWrite` → content_hash 去重、~2K token 按 markdown 边界分块、
 *   source 记账（chunk_count）、按需建表；分类必须由注册表解析（未注册 = `skipped.kind`，不抛错）；
 * - `search`：跨已注册分类的只读并集检索。按 `mode` 分流：缺省 `bm25`（porter 语义 BM25，可叠加
 *   trigram 模糊召回，CJK 走 LIKE 兜底）与 `hybrid`（四路召回 + RRF 融合）。结果带 `kind` 标签、
 *   按分数取 Top-N，**不再有任何写副作用**（`last_referenced` 与淘汰族已取消）；
 * - `listRows`：按 kind 的结构化列举（可按项目过滤、分页），供全局面 `list` 与模型侧工具复用；
 * - `evict`：删除行并联动 sources.chunk_count，归零清理 source（句柄 `forget` 的底层实现）。
 * 仅依赖 node:sqlite + node:crypto，无新增依赖。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  hybridPoolSize,
  proximitySpan,
  PROXIMITY_MAX_SPAN,
  PROXIMITY_MIN_TERMS,
  queryTerms,
  rrfFuse,
  trigramQuery,
  type SearchMode,
} from "./hybrid.ts";
import {
  checkContent,
  compileRules,
  type CompiledRules,
  type SkipReason,
} from "./rules.ts";
import { KindRegistry, type RegisteredKind, type Tier } from "./router.ts";
import { ensureKindTable } from "./schema.ts";

/** 单块 token 预算上限（~2K token）。 */
const MAX_TOKENS = 2000;
// ponytail: 粗略估算 1 token ≈ 3 字符（ASCII/CJK 平均）。精确 tokenizer 需要时再引入。

export type SourceKind = "session" | "file" | "url" | "tool_result" | "manual";

export interface SourceRef {
  kind: SourceKind;
  label?: string;
  ref?: string;
}

/** 一条存储行（跨库跨表合并时带 `kind` 与 `tier` 标签）。 */
export interface StoreRow {
  id: number;
  kind: string;
  tier: Tier;
  project: string;
  title: string | null;
  content: string;
  importance: number;
  sessionId: string | null;
  createdAt: number;
}

/** 检索命中（= 存储行 + BM25 分数；分数越小越相关）。 */
export interface SearchHit extends StoreRow {
  score: number;
}

/** `put` 入参（本层内部形态；对外写入经 `MemoryScope.put`）。 */
export interface PutInput {
  /** 分类：必须已注册（由句柄保证；直接调用时未注册 → `skipped.kind`）。 */
  kind: string;
  /** 归属项目（跨会话检索的作用域）。 */
  project: string;
  content: string;
  title?: string;
  importance?: number;
  sessionId?: string;
  source?: SourceRef;
}

export interface PutResult {
  ids: number[];
  sourceId: number;
  created: number;
  /** 被库核心闸门拒绝的原因（拒绝时 `ids` 为空、不写库）。 */
  skipped?: SkipReason;
}

/** 检索入参（单库；跨层由 `TierSet` 聚合）。 */
export interface SearchOptions {
  query: string;
  project?: string;
  /** 限定单个分类；缺省查全部已注册分类。 */
  kind?: string;
  limit?: number;
  /** true 时叠加 trigram 子串召回（无法召回 <3 字符的串）；hybrid 下 trigram 恒开、本字段不再改变召回。 */
  fuzzy?: boolean;
  /** 检索策略：缺省 `bm25`（改造前的单词面行为）；`hybrid` = 多路召回 + RRF 融合。 */
  mode?: SearchMode;
}

/** 列举入参（单库；按 kind 走一张物理表）。 */
export interface ListOptions {
  kind: string;
  project?: string;
  limit?: number;
  offset?: number;
}

/**
 * 跨分类行句柄（决策 D39）：各分类表 id 独立自增，裸 id 只在单表内有意义；
 * 跨表维护方法一律以 `(kind, id)` 定位行。
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

/** 行查询的列集（单表；`tier` 在聚合层补）。 */
const ROW_COLUMNS =
  "id, project, title, content, importance, session_id, created_at";

function mapRow(
  row: Record<string, unknown>,
  kind: string,
  tier: Tier,
): StoreRow {
  return {
    id: Number(row.id),
    kind,
    tier,
    project: String(row.project),
    title: row.title == null ? null : String(row.title),
    content: String(row.content),
    importance: Number(row.importance),
    sessionId: row.session_id == null ? null : String(row.session_id),
    createdAt: Number(row.created_at),
  };
}

/** LIKE 子串模式的转义（`%` / `_` / `\` 在用户内容里是普通字符）。 */
function likePattern(text: string): string {
  return `%${text
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

export class KnowledgeService {
  readonly #db: DatabaseSync;
  readonly #rules: CompiledRules;
  readonly #registry: KindRegistry;
  readonly #tier: Tier;
  /** 本连接已建过表的分类（「空表不建」，首次写入时才建；连接内缓存避免重复 DDL）。 */
  readonly #ensured = new Set<string>();
  readonly #tableExistsStmt: StatementSync;

  /**
   * @param db 已打开的层库连接。
   * @param options.tier 该连接所属层（结果行带 `tier` 标签；缺省 `session`）。
   * @param options.rules 该层的内容闸门（**闸门在库核心**，设计 §5）：缺省只用内置隐私底线。
   * @param options.registry 分类注册表（设计 §4）：缺省空表（任何写入都因未注册被拒）。
   */
  constructor(
    db: DatabaseSync,
    options: {
      tier?: Tier;
      rules?: CompiledRules;
      registry?: KindRegistry;
    } = {},
  ) {
    this.#db = db;
    this.#tier = options.tier ?? "session";
    this.#rules = options.rules ?? compileRules();
    this.#registry = options.registry ?? new KindRegistry();
    this.#tableExistsStmt = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    );
  }

  /** 本连接的层身份。 */
  get tier(): Tier {
    return this.#tier;
  }

  /** 该表是否已存在（「空表不建」：未写入过的分类表不存在）。 */
  #tableExists(table: string): boolean {
    return this.#tableExistsStmt.get(table) !== undefined;
  }

  /** 已注册且已建表的分类（跨表读写的遍历面；未建表 = 空分类，无可读行）。 */
  #existingEntries(): RegisteredKind[] {
    return this.#registry
      .list()
      .filter((entry) => this.#tableExists(entry.table));
  }

  /** 本次读写涉及的分类：显式 `kind` 只取该表；缺省取全部已注册分类。 */
  #entries(kind?: string): RegisteredKind[] {
    if (kind === undefined) return this.#existingEntries();
    const one = this.#registry.resolve(kind);
    if (one === undefined || !this.#tableExists(one.table)) return [];
    return [one];
  }

  /** 已注册分类的 kind 名（跨库列举的遍历面；未建表的分类由 `listRows` 返回空）。 */
  kinds(): readonly string[] {
    return this.#registry.list().map((entry) => entry.kind);
  }

  /** kind 的物理表名（未注册返回 `undefined`）。 */
  tableFor(kind: string): string | undefined {
    return this.#registry.resolve(kind)?.table;
  }

  /** 全部分类表的行数合计（摘要统计用）。 */
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
   * 检索入口（设计 §4）：按 `mode` 分流——缺省 `bm25` 走改造前的单词面实现，`hybrid` 走多路融合。
   * 两条分支都**只读**：不刷新任何列。
   */
  search(opts: SearchOptions): SearchHit[] {
    return (opts.mode ?? "bm25") === "hybrid"
      ? this.#searchHybrid(opts)
      : this.#searchBm25(opts);
  }

  /** 项目过滤片段（前缀 `AND`，与既有 `where` 拼接约定一致；不过滤时为空串）。 */
  #projectFilter(project: string | undefined): {
    where: string;
    params: Array<string | number>;
  } {
    return project === undefined
      ? { where: "", params: [] }
      : { where: " AND c.project = ?", params: [project] };
  }

  /**
   * 单词面分支（= 改造前的 `search` 实现，行为逐行保留）：对命中分类取并集；porter 语义 BM25
   * （fuzzy 时叠加 trigram 子串召回），CJK 短词或 FTS 语法错误时走 LIKE 兜底。
   */
  #searchBm25(opts: SearchOptions): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const { where, params } = this.#projectFilter(opts.project);
    const entries = this.#entries(opts.kind);

    const runQuery = (entry: RegisteredKind, fts: string): SearchHit[] => {
      const rows = this.#db
        .prepare(
          `SELECT c.${ROW_COLUMNS.replaceAll(", ", ", c.")}, bm25(${fts}) AS score
           FROM ${fts} JOIN ${entry.table} c ON c.id = ${fts}.rowid
           WHERE ${fts} MATCH ?${where}
           ORDER BY score LIMIT ?`,
        )
        .all(opts.query, ...params, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        ...mapRow(row, entry.kind, this.#tier),
        score: Number(row.score),
      }));
    };

    // 并集去重键 = (kind, id)：各分类表 id 独立自增，裸 id 会跨表相撞（决策 D39）。
    const hits = new Map<string, SearchHit>();
    const add = (hit: SearchHit): void => {
      const key = `${hit.kind}\u0000${hit.id}`;
      if (!hits.has(key)) hits.set(key, hit);
    };

    // FTS5 对自由输入语法错误（如 '-' 排除符）容错：失败退回 LIKE 兜底。
    let ftsFailed = false;
    for (const entry of entries) {
      try {
        for (const hit of runQuery(entry, entry.fts)) add(hit);
      } catch {
        ftsFailed = true;
      }
      if (opts.fuzzy === true) {
        try {
          for (const hit of runQuery(entry, entry.trigram)) add(hit);
        } catch {
          ftsFailed = true;
        }
      }
    }

    // LIKE 子串兜底：仅在 FTS 语法错误或 CJK 短词（≤2 字符 porter/trigram 无法召回）时启用。
    if (
      hits.size < limit &&
      (ftsFailed || /[\u4e00-\u9fff]/u.test(opts.query))
    ) {
      const like = likePattern(opts.query);
      for (const entry of entries) {
        if (hits.size >= limit) break;
        const rows = this.#db
          .prepare(
            `SELECT c.${ROW_COLUMNS.replaceAll(", ", ", c.")} FROM ${entry.table} c
             WHERE (c.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')${where}
             LIMIT ?`,
          )
          .all(like, like, ...params, limit - hits.size) as Array<
          Record<string, unknown>
        >;
        for (const row of rows) {
          add({ ...mapRow(row, entry.kind, this.#tier), score: 0 });
        }
      }
    }

    return [...hits.values()]
      .sort((a, b) => a.score - b.score || a.id - b.id)
      .slice(0, limit);
  }

  /**
   * 混合分支：每张分类表四路召回，RRF 融合后取 Top-N。
   * - `bm25`：porter 路，列权重 title 2 / content 1（标题命中优先）；
   * - `trigram`：≥3 字符词项作为 phrase 的 OR 查询，hybrid 下恒开（不再依赖 `fuzzy`）；
   * - `like`：逐词项子串（CJK 短词的主力召回），`ORDER BY c.id` 保证确定序；
   * - `proximity`：复用 `like` 候选行，只收「≥2 个词项共现于同一小窗口」的行，按覆盖词项数
   *   降序、窗口跨度升序、id 升序排名。
   * 候选池按 `hybridPoolSize(limit)` 有界，故耗时与语料规模无关（不随行数线性增长）。
   */
  #searchHybrid(opts: SearchOptions): SearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const pool = hybridPoolSize(limit);
    const { where, params } = this.#projectFilter(opts.project);
    const entries = this.#entries(opts.kind);
    const terms = queryTerms(opts.query);
    const tri = trigramQuery(terms);
    const columns = ROW_COLUMNS.replaceAll(", ", ", c.");

    // 并集去重键 = (kind, id)（决策 D39）；每路的键序单独收集，交给 RRF 融合。
    const hits = new Map<string, SearchHit>();
    const paths: string[][] = [];
    const keyOf = (hit: SearchHit): string => `${hit.kind}\u0000${hit.id}`;
    const remember = (hit: SearchHit): SearchHit => {
      const key = keyOf(hit);
      if (!hits.has(key)) hits.set(key, hit);
      return hit;
    };

    for (const entry of entries) {
      // 路 1：porter BM25（列权重 = title 2 / content 1）。
      try {
        const rows = this.#db
          .prepare(
            `SELECT c.${columns}, bm25(${entry.fts}, 2.0, 1.0) AS score
             FROM ${entry.fts} JOIN ${entry.table} c ON c.id = ${entry.fts}.rowid
             WHERE ${entry.fts} MATCH ?${where}
             ORDER BY score, c.id LIMIT ?`,
          )
          .all(opts.query, ...params, pool) as Array<Record<string, unknown>>;
        const path = rows.map((row) =>
          keyOf(
            remember({
              ...mapRow(row, entry.kind, this.#tier),
              score: Number(row.score),
            }),
          ),
        );
        if (path.length > 0) paths.push(path);
      } catch {
        // FTS5 语法错误（如 '-' 排除符）：该路跳过，其余路照常。
      }

      // 路 2：trigram（≥3 字符词项的 phrase OR）。
      if (tri !== undefined) {
        try {
          const rows = this.#db
            .prepare(
              `SELECT c.${columns}, bm25(${entry.trigram}) AS score
               FROM ${entry.trigram} JOIN ${entry.table} c ON c.id = ${entry.trigram}.rowid
               WHERE ${entry.trigram} MATCH ?${where}
               ORDER BY score, c.id LIMIT ?`,
            )
            .all(tri, ...params, pool) as Array<Record<string, unknown>>;
          const path = rows.map((row) =>
            keyOf(
              remember({
                ...mapRow(row, entry.kind, this.#tier),
                score: Number(row.score),
              }),
            ),
          );
          if (path.length > 0) paths.push(path);
        } catch {
          // trigram 路失败不影响其余路。
        }
      }

      // 路 3 / 4：LIKE 候选行（一次 SQL）→ 子串路与邻近路。
      if (terms.length > 0) {
        const groups = terms
          .map(
            () =>
              "(c.content LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')",
          )
          .join(" OR ");
        const likeArgs = terms.flatMap((term) => {
          const pattern = likePattern(term);
          return [pattern, pattern];
        });
        const rows = this.#db
          .prepare(
            `SELECT c.${columns} FROM ${entry.table} c
             WHERE (${groups})${where} ORDER BY c.id LIMIT ?`,
          )
          .all(...likeArgs, ...params, pool) as Array<Record<string, unknown>>;
        const candidates = rows.map((row) =>
          remember({ ...mapRow(row, entry.kind, this.#tier), score: 0 }),
        );
        if (candidates.length > 0) paths.push(candidates.map(keyOf));

        // 邻近路：一行至少命中 2 个词项、且这些词项共现于同一小窗口（≤ 跨度上限）才算邻近；
        // 窗口越紧越靠前（覆盖词项数优先，其次跨度，最后 id）。
        const near = candidates
          .map((hit) => ({
            hit,
            ...proximitySpan(`${hit.title ?? ""}\n${hit.content}`, terms),
          }))
          .filter(
            (item) =>
              item.covered >= PROXIMITY_MIN_TERMS &&
              item.span >= 0 &&
              item.span <= PROXIMITY_MAX_SPAN,
          )
          .sort(
            (a, b) =>
              b.covered - a.covered || a.span - b.span || a.hit.id - b.hit.id,
          );
        if (near.length > 0) paths.push(near.map((item) => keyOf(item.hit)));
      }
    }

    // RRF 融合：分值为各路 1/(K+rank+1) 之和，取负以保持「分数越小越相关」。
    const fused = rrfFuse(paths);
    // 取负以保持「分数越小越相关」（跨层排序与既有调用方都按升序读）。
    const out: SearchHit[] = [];
    for (const [key, hit] of hits) {
      const score = fused.get(key);
      if (score !== undefined) out.push({ ...hit, score: -score });
    }
    return out.sort((a, b) => a.score - b.score || a.id - b.id).slice(0, limit);
  }

  /**
   * 按 kind 列举（结构化读面）：缺省 `created_at` 倒序，支持项目过滤与分页。
   * 未注册 / 未建表的 kind 返回空数组（不抛错，读侧宽松）。
   */
  listRows(opts: ListOptions): StoreRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
    const offset = Math.max(0, opts.offset ?? 0);
    const entry = this.#registry.resolve(opts.kind);
    if (entry === undefined || !this.#tableExists(entry.table)) return [];
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (opts.project !== undefined) {
      filters.push("c.project = ?");
      params.push(opts.project);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.#db
      .prepare(
        `SELECT c.${ROW_COLUMNS.replaceAll(", ", ", c.")} FROM ${entry.table} c${where}
         ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return rows.map((row) => mapRow(row, entry.kind, this.#tier));
  }

  /** 写入：**先过库核心闸门**（隐私 → 注册方钩子），再去重 + 分块 + source 记账。 */
  async put(input: PutInput): Promise<PutResult> {
    // 闸门 1：隐私底线（六类形态 + 调用方扩展）。
    const verdict = checkContent(this.#rules, input.content);
    if (!verdict.accept) {
      return {
        ids: [],
        sourceId: 0,
        created: 0,
        skipped: verdict.reason ?? "pattern",
      };
    }
    // 闸门 2：分类必须已注册（句柄保证；直接调用时可能是任意串）。
    const entry = this.#registry.resolve(input.kind);
    if (entry === undefined) {
      return { ids: [], sourceId: 0, created: 0, skipped: "kind" };
    }
    // 闸门 3：注册方写前钩子（隐私闸之后、INSERT 之前）；可建议 importance（可异步）。
    const hook = await entry.preWrite?.({
      content: input.content,
      ...(input.title === undefined ? {} : { title: input.title }),
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
      ensureKindTable(this.#db, entry.table);
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
           (source_id, project, title, content, content_hash, importance, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
            input.title ?? null,
            chunk,
            sha256(chunk),
            importance,
            input.sessionId ?? null,
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

  /**
   * 删除行（句柄 `forget` 的底层实现），联动 sources.chunk_count，归零清理 source。
   * 跨表删除后 chunk_count 聚合**全部分类表**重算（决策 D40：只算本表会把其他表的行
   * 误判为孤儿并连带删掉来源）。
   */
  evict(refs: readonly RowRef[]): number {
    const byTable = new Map<string, number[]>();
    for (const ref of refs) {
      const table = this.#registry.resolve(ref.kind)?.table;
      if (table === undefined) continue;
      const ids = byTable.get(table) ?? [];
      ids.push(ref.id);
      byTable.set(table, ids);
    }
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
      } else {
        this.#db.exec("UPDATE sources SET chunk_count = 0");
      }
      this.#db.exec("DELETE FROM sources WHERE chunk_count = 0");
      this.#db.exec("COMMIT");
      return deleted;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
