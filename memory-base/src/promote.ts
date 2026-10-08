/**
 * 提升链数据层（设计 §6 / §6.1，决策 D49-D54）：候选幂等入队、审阅动作与冲突裁定。
 *
 * 分工：本模块只做**单库数据面**（候选表 CRUD + 转换落库）；跨库编排（来源层标
 * `promoted_to` 的 best-effort 标记）与触发时机（session/disposed / 巩固链）归
 * `index.ts` 的 bundle 层；LLM 概括经 `caller` 注入（未注入 = 面不可用，候选照常
 * 入队但**不得转换落上层**——「失败不提升、不降级」的闸落在转换步，决策 D51/D52）。
 *
 * 事务纪律（D53）：本模块**不加外层 BEGIN**——转换①直接调 `kb.put()`（自带事务，
 * content_hash 去重使「①成功③失败」可安全重试：重试 approve → put 去重命中 →
 * 继续删候选）；③删候选单语句原子；②下层标记跨库 best-effort 由调用方做。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  checkContent,
  compileRules,
  type CompiledRules,
  type SkipReason,
} from "./rules.ts";
import type { KindRegistry } from "./router.ts";
import type { KnowledgeService } from "./knowledge.ts";
import { normalize, redundant } from "./consolidate.ts";

/** 候选行（`sources` / `projects` / `conflict_with` 已解码）。 */
export interface CandidateRow {
  id: number;
  targetTier: "session" | "project" | "user";
  kind: string;
  factKey: string;
  contentHash: string;
  title: string | null;
  content: string;
  sources: string[];
  projects: string[];
  state: "pending" | "approved" | "rejected";
  conflictWith: { kind: string; id: number } | null;
  reviewer: string | null;
  rejectReason: string | null;
  summarized: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PromoteItem {
  /** 目标层（候选写入该层的库）。 */
  targetTier: "session" | "project" | "user";
  kind: string;
  title?: string;
  content: string;
  /** 来源回指（来源 id / session_id 标记；I 层来源为不透明标记）。 */
  sources?: readonly string[];
  /** 跨项目票（U 候选：同一事实在不同项目的逐票累积）。 */
  projects?: readonly string[];
}

export type PromoteOutcome =
  | { status: "queued" | "merged"; id: number }
  | { status: "rejected-duplicate"; id: number }
  | {
      status: "rejected-gate";
      reason: SkipReason | "kind-unregistered" | "tier-unavailable";
    };

export interface LlmCaller {
  (prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

/** 一轮候选生产的汇总（可观测：§5 计数面）。 */
export interface PromotionStats {
  queued: number;
  merged: number;
  rejectedDuplicate: number;
  rejectedGate: number;
}

function accumulate(
  stats: PromotionStats,
  outcomes: readonly PromoteOutcome[],
): void {
  for (const outcome of outcomes) {
    if (outcome.status === "queued") stats.queued += 1;
    else if (outcome.status === "merged") stats.merged += 1;
    else if (outcome.status === "rejected-duplicate")
      stats.rejectedDuplicate += 1;
    else stats.rejectedGate += 1;
  }
}

/** 把一批入队结果折算成统计（供 bundle 层累计，§5 可观测）。 */
export function summarizeOutcomes(
  outcomes: readonly PromoteOutcome[],
): PromotionStats {
  const stats: PromotionStats = {
    queued: 0,
    merged: 0,
    rejectedDuplicate: 0,
    rejectedGate: 0,
  };
  accumulate(stats, outcomes);
  return stats;
}

/** 候选表独立上限（设计 §6：超限先清最旧；pending / conflict / rejected 全计入）。 */
export const CANDIDATES_MAX_BYTES = 5 * 1024 * 1024;

/** 候选表容量兜底：按估算字节（正文 + 标题 + 冲突引用 + 行开销）清最旧，返回删除行数。 */
export function pruneCandidates(
  db: DatabaseSync,
  maxBytes: number = CANDIDATES_MAX_BYTES,
): number {
  const totalOf = (): number =>
    Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(LENGTH(content) + LENGTH(COALESCE(title, '')) + LENGTH(COALESCE(conflict_with, '')) + 256), 0) AS bytes FROM candidates",
          )
          .get() as { bytes: number }
      ).bytes,
    );
  let deleted = 0;
  let total = totalOf();
  while (total > maxBytes) {
    const result = db
      .prepare(
        "DELETE FROM candidates WHERE id IN (SELECT id FROM candidates ORDER BY created_at ASC, id ASC LIMIT 10)",
      )
      .run();
    const changes = Number(result.changes);
    if (changes === 0) break;
    deleted += changes;
    total = totalOf();
  }
  return deleted;
}

/**
 * S → P 候选生产（设计 §6 触发表）：扫本会话够格行（被检索命中过，或决策类事件
 * `plan/mode` / `goal/change` / `approval/decided`；失败教训分支待注册方事件绑定，
 * 未注册不成立）→ 推入当前项目 P 库 candidates。每轮 ≤ 20（防审阅疲劳，§8.1）。
 */
export async function promoteSessionToProject(
  sourceDb: DatabaseSync,
  targetDb: DatabaseSync,
  registry: KindRegistry,
  opts: {
    sessionId: string;
    llm?: LlmCaller;
    rules?: CompiledRules;
    now?: number;
    limit?: number;
  },
): Promise<PromotionStats> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const decisionCategories = ["plan/mode", "goal/change", "approval/decided"];
  const placeholders = decisionCategories.map(() => "?").join(", ");
  const stats: PromotionStats = {
    queued: 0,
    merged: 0,
    rejectedDuplicate: 0,
    rejectedGate: 0,
  };
  const items: PromoteItem[] = [];
  for (const entry of registry.list()) {
    const exists = sourceDb
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(entry.table);
    if (exists === undefined) continue;
    const rows = sourceDb
      .prepare(
        `SELECT id, title, content FROM ${entry.table}
         WHERE session_id = ? AND (last_referenced > created_at OR category IN (${placeholders}))
         ORDER BY last_referenced DESC, id ASC LIMIT ?`,
      )
      .all(opts.sessionId, ...decisionCategories, limit) as Array<{
      id: number;
      title: string | null;
      content: string;
    }>;
    for (const row of rows) {
      items.push({
        targetTier: "project",
        kind: entry.kind,
        title: row.title ?? undefined,
        content: row.content,
        sources: [`session:${entry.kind}:${row.id}`],
      });
    }
  }
  const outcomes = await promoteCandidates(targetDb, registry, items, {
    llm: opts.llm,
    rules: opts.rules,
    now: opts.now,
  });
  accumulate(stats, outcomes);
  return stats;
}

/**
 * P → U 候选生产（设计 §6 触发表）：把当前项目的 P 层行作为 U 候选推送（每项目一票，
 * 跨项目合并靠 promote 幂等键 + 子串合并；≥2 项目即「跨项目事实」优先提审）。
 * 排序 = importance 降序 → last_referenced 降序（近期有用的先推）；每轮 ≤ 10（§8.1）。
 */
export async function promoteProjectToUser(
  sourceDb: DatabaseSync,
  targetDb: DatabaseSync,
  registry: KindRegistry,
  opts: {
    project: string;
    llm?: LlmCaller;
    rules?: CompiledRules;
    now?: number;
    limit?: number;
  },
): Promise<PromotionStats> {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
  const stats: PromotionStats = {
    queued: 0,
    merged: 0,
    rejectedDuplicate: 0,
    rejectedGate: 0,
  };
  const rows: Array<{
    id: number;
    kind: string;
    title: string | null;
    content: string;
    importance: number;
    last_referenced: number;
  }> = [];
  for (const entry of registry.list()) {
    const exists = sourceDb
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(entry.table);
    if (exists === undefined) continue;
    const found = sourceDb
      .prepare(
        `SELECT id, title, content, importance, last_referenced FROM ${entry.table}
         WHERE project = ?
         ORDER BY importance DESC, last_referenced DESC, id ASC LIMIT ?`,
      )
      .all(opts.project, limit) as Array<{
      id: number;
      title: string | null;
      content: string;
      importance: number;
      last_referenced: number;
    }>;
    for (const row of found) {
      rows.push({
        id: row.id,
        kind: entry.kind,
        title: row.title,
        content: row.content,
        importance: row.importance,
        last_referenced: row.last_referenced,
      });
    }
  }
  rows.sort(
    (a, b) =>
      b.importance - a.importance ||
      b.last_referenced - a.last_referenced ||
      a.id - b.id,
  );
  const items: PromoteItem[] = rows.slice(0, limit).map((row) => ({
    targetTier: "user",
    kind: row.kind,
    title: row.title ?? undefined,
    content: row.content,
    sources: [`project:${row.kind}:${row.id}`],
    projects: [opts.project],
  }));
  const outcomes = await promoteCandidates(targetDb, registry, items, {
    llm: opts.llm,
    rules: opts.rules,
    now: opts.now,
  });
  accumulate(stats, outcomes);
  return stats;
}

/**
 * ② 下层来源标记（跨库 best-effort，决策 D53）：`sources` 形如 `<tier>:<kind>:<id>`
 * （本包生产路径的格式；I 层等外部标记不认识就跳过——回指链允许自然悬空，§6.1）。
 * 失败只计数不抛（approve 已提交，重扫靠墓碑 / 人工 reject 兜底重复提审）。
 */
export function markSourcesPromoted(
  tiersLike: {
    get(tier: "session" | "project" | "user"): { db: DatabaseSync } | undefined;
  },
  sources: readonly string[],
  target: { kind: string; id: number },
  registry: KindRegistry,
): number {
  let marked = 0;
  for (const source of sources) {
    const parts = source.split(":");
    if (parts.length !== 3) continue;
    const tier = parts[0];
    const kind = parts[1];
    const rawId = parts[2];
    if (tier === undefined || kind === undefined || rawId === undefined)
      continue;
    const store = tiersLike.get(tier as "session" | "project" | "user");
    if (store === undefined) continue;
    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;
    // kind → 物理表名经注册表解析（kind 不是表名：兜底分类 default 的表是 chunks）。
    const table = registry.resolve(kind)?.table;
    if (table === undefined) continue;
    try {
      const result = store.db
        .prepare(`UPDATE ${table} SET promoted_to = ? WHERE id = ?`)
        .run(JSON.stringify(target), id);
      marked += Number(result.changes);
    } catch {
      // 表不存在 / 行不存在：回指悬空，计数即可（调用方日志）。
    }
  }
  return marked;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `fact_key` = 来源内容按 §3.4 归一化后的哈希（决策 D50）。 */
export function factKeyOf(content: string): string {
  return sha256(normalize(content));
}

function parseJsonArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseConflict(
  text: string | null,
): { kind: string; id: number } | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      "id" in parsed
    ) {
      const record = parsed as { kind: unknown; id: unknown };
      if (typeof record.kind === "string" && typeof record.id === "number") {
        return { kind: record.kind, id: record.id };
      }
    }
  } catch {
    // 落库前由本模块编码，坏 JSON 只可能来自外部直写——按无冲突处理。
  }
  return null;
}

function mapRow(row: Record<string, unknown>): CandidateRow {
  return {
    id: Number(row.id),
    targetTier: String(row.target_tier) as CandidateRow["targetTier"],
    kind: String(row.kind),
    factKey: String(row.fact_key),
    contentHash: String(row.content_hash),
    title: row.title == null ? null : String(row.title),
    content: String(row.content),
    sources: parseJsonArray(String(row.sources ?? "[]")),
    projects: parseJsonArray(String(row.projects ?? "[]")),
    state: String(row.promotion_state) as CandidateRow["state"],
    conflictWith: parseConflict(
      row.conflict_with == null ? null : String(row.conflict_with),
    ),
    reviewer: row.reviewer == null ? null : String(row.reviewer),
    rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
    summarized: Number(row.summarized) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const CANDIDATE_SELECT =
  "SELECT id, target_tier, kind, fact_key, content_hash, title, content, sources, projects, promotion_state, conflict_with, reviewer, reject_reason, summarized, created_at, updated_at FROM candidates";

/** 合并语义（决策 D50）：projects 并集、sources 合并、content / title 以最新为准。 */
function mergeInto(
  db: DatabaseSync,
  anchor: CandidateRow,
  incoming: PromoteItem,
  now: number,
): number {
  const projects = [
    ...new Set([...anchor.projects, ...(incoming.projects ?? [])]),
  ];
  const sources = [
    ...new Set([...anchor.sources, ...(incoming.sources ?? [])]),
  ];
  const factKey = factKeyOf(incoming.content);
  db.prepare(
    `UPDATE candidates SET content = ?, content_hash = ?, fact_key = ?, title = ?,
       sources = ?, projects = ?, summarized = summarized, updated_at = ?
     WHERE id = ?`,
  ).run(
    incoming.content,
    sha256(incoming.content),
    factKey,
    incoming.title ?? anchor.title,
    JSON.stringify(sources),
    JSON.stringify(projects),
    now,
    anchor.id,
  );
  return anchor.id;
}

/**
 * 幂等入队（决策 D50）：闸门（隐私底线 + kind 已注册）→ fact_key 精确命中 →
 * 同 kind pending 候选的 `redundant()` 子串合并（§3.4 机械判据的第二个分支）→ 新行。
 * `rejected` 墓碑占住 fact_key：同源重推计 `rejected-duplicate`，不复活。
 */
export async function promoteCandidates(
  db: DatabaseSync,
  registry: KindRegistry,
  items: readonly PromoteItem[],
  opts: {
    rules?: CompiledRules;
    llm?: LlmCaller;
    now?: number;
  } = {},
): Promise<PromoteOutcome[]> {
  const now = opts.now ?? Date.now();
  const outcomes: PromoteOutcome[] = [];
  for (const item of items) {
    // 闸门 1：kind 必须已注册（§5「死候选」防线；U 层候选尤其必须显式分类）。
    if (registry.resolve(item.kind) === undefined) {
      outcomes.push({ status: "rejected-gate", reason: "kind-unregistered" });
      continue;
    }
    // 闸门 2：隐私底线（候选表也不留未过滤正文——写库前最后一道闸在入库这步生效）。
    const verdict = checkContent(
      opts.rules ?? compileRules(undefined, null),
      item.content,
    );
    if (!verdict.accept) {
      outcomes.push({
        status: "rejected-gate",
        reason: verdict.reason ?? "empty",
      });
      continue;
    }
    const factKey = factKeyOf(item.content);
    const existing = db
      .prepare(
        "SELECT id, promotion_state FROM candidates WHERE kind = ? AND fact_key = ? LIMIT 1",
      )
      .get(item.kind, factKey) as
      { id: number; promotion_state: string } | undefined;
    if (existing !== undefined) {
      if (existing.promotion_state === "rejected") {
        outcomes.push({ status: "rejected-duplicate", id: existing.id });
        continue;
      }
      // pending 精确命中 → 并入（content 以最新为准）。
      const anchor = getPendingCandidate(db, existing.id);
      if (anchor !== undefined) {
        const id = mergeInto(db, anchor, item, now);
        outcomes.push({ status: "merged", id });
        continue;
      }
    }
    // 子串合并分支：同 kind 的 pending 候选内，归一化相同或短者为长者子串且占比 ≥ 0.8。
    const pendingRows = (
      db
        .prepare(
          `${CANDIDATE_SELECT} WHERE kind = ? AND promotion_state = 'pending' ORDER BY created_at ASC`,
        )
        .all(item.kind) as Array<Record<string, unknown>>
    ).map(mapRow);
    const normalizedNew = normalize(item.content);
    const anchor = pendingRows.find(
      (row) =>
        redundant(normalizedNew, normalize(row.content)) ||
        redundant(normalize(row.content), normalizedNew),
    );
    if (anchor !== undefined) {
      const id = mergeInto(db, anchor, item, now);
      outcomes.push({ status: "merged", id });
      continue;
    }
    // LLM 概括（决策 D52）：caller 存在 → 入队时改写；失败 → 保留原文、summarized = 0
    //（转换闸会挡住未概括候选——「失败不提升、不降级」）。
    let content = item.content;
    let summarized = 0;
    if (opts.llm !== undefined) {
      try {
        const prompt = [
          "把下面的项目事实压缩为一句可长期成立的结论（保留关键命令与路径，不要解释）：",
          item.title === undefined ? "" : `标题：${item.title}`,
          `内容：${item.content}`,
        ]
          .filter((line) => line.length > 0)
          .join("\n");
        const summarizedText = (
          await opts.llm(prompt, { maxTokens: 200 })
        ).trim();
        if (summarizedText.length > 0) {
          content = summarizedText;
          summarized = 1;
        }
      } catch {
        summarized = 0;
      }
    }
    const result = db
      .prepare(
        `INSERT INTO candidates
           (target_tier, kind, fact_key, content_hash, title, content, sources, projects, promotion_state, summarized, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        item.targetTier,
        item.kind,
        factKey,
        sha256(content),
        item.title ?? null,
        content,
        JSON.stringify([...(item.sources ?? [])]),
        JSON.stringify([...(item.projects ?? [])]),
        summarized,
        now,
        now,
      );
    outcomes.push({ status: "queued", id: Number(result.lastInsertRowid) });
  }
  return outcomes;
}

function getPendingCandidate(
  db: DatabaseSync,
  id: number,
): CandidateRow | undefined {
  const row = db
    .prepare(`${CANDIDATE_SELECT} WHERE id = ? AND promotion_state = 'pending'`)
    .get(id) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : mapRow(row);
}

/** 候选清单（决策 D49：缺省只出 pending）。 */
export function listCandidates(
  db: DatabaseSync,
  opts: {
    tier?: "session" | "project" | "user";
    state?: CandidateRow["state"];
  } = {},
): CandidateRow[] {
  const filters: string[] = [];
  const params: Array<string> = [];
  if (opts.tier !== undefined) {
    filters.push("target_tier = ?");
    params.push(opts.tier);
  }
  filters.push("promotion_state = ?");
  params.push(opts.state ?? "pending");
  const rows = db
    .prepare(
      `${CANDIDATE_SELECT} WHERE ${filters.join(" AND ")} ORDER BY created_at ASC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

export type ReviewVerdict =
  | { ok: true; id: number }
  | {
      ok: false;
      reason:
        | "not-found"
        | "not-pending"
        | "forbidden"
        | "llm-unavailable"
        | "duplicate-fact";
    };

/** 审阅权限（决策 D53）：U 候选与冲突候选一律 user-only（agent 的 approve / reject 无效）。 */
function reviewerAllowed(row: CandidateRow, reviewer: string): boolean {
  if (row.targetTier === "user" || row.conflictWith !== null) {
    return reviewer === "user";
  }
  return reviewer.length > 0;
}

/**
 * 审阅通过 → 转换落上层（决策 D53）：① `kb.put()` 写正式行（origin = "auto"；
 * 自带事务，去重保证重试安全）→ 留痕（promoted_from / reviewer / reviewed_at /
 * projects）→ ③ 删候选。前置闸：未概括（summarized = 0）且无 caller → 拒绝并
 * 保持 pending（「失败不提升、不降级」，D52）。
 */
export async function approveCandidate(
  db: DatabaseSync,
  kb: KnowledgeService,
  registry: KindRegistry,
  id: number,
  opts: {
    reviewer: string;
    project: string;
    llm?: LlmCaller;
    now?: number;
  },
): Promise<
  ReviewVerdict & { kind?: string; sources?: string[]; projects?: string[] }
> {
  const row = getPendingCandidate(db, id);
  if (row === undefined) return { ok: false, reason: "not-found" };
  if (!reviewerAllowed(row, opts.reviewer))
    return { ok: false, reason: "forbidden" };
  const now = opts.now ?? Date.now();
  let content = row.content;
  if (!row.summarized) {
    // 转换闸（D51/D52）：无概括且无 caller → 不提升，保持 pending（下次巩固重概括）。
    if (opts.llm === undefined) return { ok: false, reason: "llm-unavailable" };
    try {
      const prompt = [
        "把下面的项目事实压缩为一句可长期成立的结论（保留关键命令与路径，不要解释）：",
        row.title === null ? "" : `标题：${row.title}`,
        `内容：${row.content}`,
      ]
        .filter((line) => line.length > 0)
        .join("\n");
      const summarizedText = (
        await opts.llm(prompt, { maxTokens: 200 })
      ).trim();
      if (summarizedText.length === 0)
        return { ok: false, reason: "llm-unavailable" };
      content = summarizedText;
      db.prepare(
        "UPDATE candidates SET content = ?, content_hash = ?, fact_key = ?, summarized = 1, updated_at = ? WHERE id = ?",
      ).run(content, sha256(content), factKeyOf(content), now, id);
    } catch {
      return { ok: false, reason: "llm-unavailable" };
    }
  }
  // ① 写上层正式行（put 自带事务；content_hash 去重使重试安全）。
  const put = kb.put({
    project: opts.project,
    kind: row.kind,
    title: row.title ?? undefined,
    content,
    origin: "auto",
  });
  if (put.ids.length === 0) return { ok: false, reason: "not-pending" };
  const formalId = put.ids[0]!;
  // 留痕：正式行记审阅人与来源回指（③候选即删，这里是唯一留痕点）。
  const table = registry.resolve(row.kind)?.table;
  if (table !== undefined) {
    db.prepare(
      `UPDATE ${table} SET promoted_from = ?, reviewer = ?, reviewed_at = ?, projects = ? WHERE id = ?`,
    ).run(
      JSON.stringify(row.sources),
      opts.reviewer,
      now,
      JSON.stringify(row.projects),
      formalId,
    );
  }
  // ③ 候选终态即删行（approved 不留行）。
  db.prepare("DELETE FROM candidates WHERE id = ?").run(id);
  return {
    ok: true,
    id: formalId,
    sources: row.sources,
    projects: row.projects,
  };
}

/** 驳回（终态留痕 = fact_key 墓碑）：状态 `rejected` + 原因；同源重推计 `rejected-duplicate`。 */
export function rejectCandidate(
  db: DatabaseSync,
  id: number,
  opts: { reviewer: string; reason: string; now?: number },
): ReviewVerdict {
  const row = getPendingCandidate(db, id);
  if (row === undefined) return { ok: false, reason: "not-found" };
  if (!reviewerAllowed(row, opts.reviewer))
    return { ok: false, reason: "forbidden" };
  const now = opts.now ?? Date.now();
  db.prepare(
    "UPDATE candidates SET promotion_state = 'rejected', reviewer = ?, reject_reason = ?, updated_at = ? WHERE id = ?",
  ).run(opts.reviewer, opts.reason, now, id);
  return { ok: true, id };
}

/**
 * 改写候选内容（决策 D53）：重算 content_hash / fact_key（新 key 撞 pending 行 →
 * 把撞行并入本行后删除撞行，同 D50 合并语义）；状态保持 pending（未获审阅）。
 */
export function editCandidate(
  db: DatabaseSync,
  id: number,
  content: string,
  opts: { now?: number } = {},
): ReviewVerdict {
  const row = getPendingCandidate(db, id);
  if (row === undefined) return { ok: false, reason: "not-found" };
  const now = opts.now ?? Date.now();
  const factKey = factKeyOf(content);
  const collision = db
    .prepare(
      "SELECT id, sources, projects FROM candidates WHERE kind = ? AND fact_key = ? AND id != ? AND promotion_state = 'pending' LIMIT 1",
    )
    .get(row.kind, factKey, id) as
    { id: number; sources: string; projects: string } | undefined;
  db.prepare(
    "UPDATE candidates SET content = ?, content_hash = ?, fact_key = ?, summarized = 0, updated_at = ? WHERE id = ?",
  ).run(content, sha256(content), factKey, now, id);
  if (collision !== undefined) {
    // 撞行并入本行（projects / sources 并集）后删除，保持唯一索引可用。
    const sources = [
      ...new Set([...parseJsonArray(collision.sources), ...row.sources]),
    ];
    const projects = [
      ...new Set([...parseJsonArray(collision.projects), ...row.projects]),
    ];
    db.prepare(
      "UPDATE candidates SET sources = ?, projects = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(sources), JSON.stringify(projects), now, id);
    db.prepare("DELETE FROM candidates WHERE id = ?").run(collision.id);
  }
  return { ok: true, id };
}

/** 把 pending 候选标记为冲突候选（决策 D54：人工标记的唯一入口；自动检测依赖 LLM，不做）。 */
export function markConflict(
  db: DatabaseSync,
  id: number,
  opts: { conflictWith: { kind: string; id: number }; now?: number },
): ReviewVerdict {
  const row = getPendingCandidate(db, id);
  if (row === undefined) return { ok: false, reason: "not-found" };
  const now = opts.now ?? Date.now();
  db.prepare(
    "UPDATE candidates SET conflict_with = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(opts.conflictWith), now, id);
  return { ok: true, id };
}

export type ConflictDecision = "accept-new" | "keep-old" | "merge" | "edit";

/**
 * 冲突裁定（设计 §6.1 / L188，决策 D54）：user-only；两条路径在数据面合流为
 * 「目标行承载一致结论，候选清理，不留新旧并存」——
 * - `keep-old`：旧行不动，候选删除；
 * - `accept-new` / `merge` / `edit`：目标行 UPDATE 为最终结论（merge / edit 必须带
 *   `content`），有下层来源行时候选的 `sources` 照常返回给调用方做 ② 标记。
 */
export async function resolveConflict(
  db: DatabaseSync,
  kb: KnowledgeService,
  registry: KindRegistry,
  id: number,
  decision: ConflictDecision,
  opts: {
    reviewer: string;
    content?: string;
    llm?: LlmCaller;
    now?: number;
  },
): Promise<ReviewVerdict & { sources?: string[] }> {
  const row = getPendingCandidate(db, id);
  if (row === undefined) return { ok: false, reason: "not-found" };
  // 冲突裁定一律用户本人（设计 §6：conflict 一律交用户；agent 裁定无效）。
  if (opts.reviewer !== "user") return { ok: false, reason: "forbidden" };
  if (row.conflictWith === null) return { ok: false, reason: "not-pending" };
  const now = opts.now ?? Date.now();
  if (decision === "keep-old") {
    db.prepare("DELETE FROM candidates WHERE id = ?").run(id);
    return { ok: true, id };
  }
  const content = opts.content ?? row.content;
  if (decision !== "accept-new" && content === row.content) {
    return { ok: false, reason: "duplicate-fact" };
  }
  const table = registry.resolve(row.conflictWith.kind)?.table;
  if (table === undefined) return { ok: false, reason: "forbidden" };
  db.prepare(
    `UPDATE ${table} SET content = ?, content_hash = ?, reviewer = ?, reviewed_at = ? WHERE id = ?`,
  ).run(content, sha256(content), "user", now, row.conflictWith.id);
  // 结论由用户裁定落地，候选清掉（不留新旧并存）。
  db.prepare("DELETE FROM candidates WHERE id = ?").run(id);
  return { ok: true, id, sources: row.sources };
}
