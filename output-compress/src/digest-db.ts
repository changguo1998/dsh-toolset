/**
 * 自持索引库 digest.db（设计 §3.1 I 层契约，决策 D60 修订）：
 * 指纹 0x44494745（'DIGE'）+ user_version 1；表 digests 一张（结构化列 + FTS5 挂
 * headings_text / preview 纯文本，**不索引 JSON 串**）。
 *
 * 落点（D60-b）：config.sessionDir（会话目录，宿主必已建）——打开前 `existsSync`
 * 且**不 mkdir**；缺失 = 解析失败：告警 + 计数 `skipped.sessionDirMissing` + 跳过
 * （= 该会话 I→S 判据整体失效）。**不静默换路径、不自建旁路目录**（§12 #10）。
 *
 * 底线闸（D61）：写入前过六类形态模式（deny-patterns.ts），命中 → 拒写 + 计数。
 * 去重：库内单列 `content_hash`（= sha256(spill 源字节，截断后实际读取的字节)，
 * 对齐 DESIGN §5 I 行）。容量：100 MB 上限，启动后 + 写后自查（超限清最旧，属主自管）。
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DENY_PATTERNS } from "./deny-patterns.ts";
import type {
  HeadingEntry,
  KeyLineEntry,
  SliceEntry,
} from "./summary-program.ts";

/** I 层库指纹（'DIGE'）：本包自管，与 memory-base 层指纹互不相干。 */
export const DIGEST_APPLICATION_ID = 0x44494745;
export const DIGEST_SCHEMA_VERSION = 1;
/** 索引库字节上限（设计 §3.1：100 MB）。 */
export const DIGEST_MAX_BYTES = 100 * 1024 * 1024;

/** digest.db 打开失败（父目录缺失等）。 */
export class DigestUnavailableError extends Error {}

export interface DigestRecord {
  sessionId: string;
  tool: string;
  /** spill 文件定位（阈值触发无 spill 时为 null：区间悬空，指向事件文本，仅供审计）。 */
  locator: string | null;
  seq: number | null;
  headings: readonly HeadingEntry[];
  keyLines: readonly KeyLineEntry[];
  slices: readonly SliceEntry[];
  /** 摘要级指纹（summary-program textFnv，§3.1 四件套之一）。 */
  fingerprint: string;
  /** 固定上限的截断预览（属概括，不是正文）。 */
  preview: string;
  isError: boolean;
  /** sha256(spill 源字节)（去重键）。 */
  contentHash: string;
  now?: number;
}

export type DigestPutOutcome =
  | { status: "stored" | "duplicate"; id: number }
  | { status: "rejected"; reason: "deny-pattern" };

/** 底线闸：命中任一模式 → 拒写（拒绝原因区分 deny-pattern，纳入可观测）。 */
export function matchDenyPattern(text: string): string | null {
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

export function openDigestDatabase(path: string): DatabaseSync {
  const actual = resolve(path);
  // D60-b：会话目录必须已存在（宿主建的），不 mkdir——缺失即解析失败。
  if (!existsSync(dirname(actual))) {
    throw new DigestUnavailableError(
      `digest.db 父目录不存在（会话目录缺失）："${dirname(actual)}"`,
    );
  }
  const db = new DatabaseSync(actual);
  try {
    const { application_id: appId } = db
      .prepare("PRAGMA application_id")
      .get() as { application_id: number };
    const { user_version: version } = db
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    if (appId !== 0 && appId !== DIGEST_APPLICATION_ID) {
      throw new Error(
        `digest.db "${actual}" 指纹 ${appId} 与本包（${DIGEST_APPLICATION_ID}）不符，拒绝打开`,
      );
    }
    if (appId === 0) {
      if (version !== 0) {
        throw new Error(
          `digest.db "${actual}" 版本异常（user_version=${version}）`,
        );
      }
      createDigestSchema(db);
    } else if (version !== DIGEST_SCHEMA_VERSION) {
      throw new Error(
        `digest.db "${actual}" 版本 ${version} 与当前 ${DIGEST_SCHEMA_VERSION} 不符且无迁移链`,
      );
    }
    db.exec("PRAGMA journal_mode = WAL");
    return db;
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

function createDigestSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${DIGEST_APPLICATION_ID}`);
  db.exec(`
    CREATE TABLE digests (
      id                  INTEGER PRIMARY KEY,
      session_id          TEXT NOT NULL,
      tool                TEXT NOT NULL,
      locator             TEXT,
      seq                 INTEGER,
      headings            TEXT NOT NULL DEFAULT '[]',
      key_lines           TEXT NOT NULL DEFAULT '[]',
      slices              TEXT NOT NULL DEFAULT '[]',
      fingerprint         TEXT NOT NULL,
      headings_text       TEXT NOT NULL DEFAULT '',
      preview             TEXT NOT NULL,
      is_error            INTEGER NOT NULL DEFAULT 0,
      content_hash        TEXT NOT NULL,
      push_state          TEXT NOT NULL DEFAULT 'none' CHECK (push_state IN ('none', 'queued', 'merged', 'rejected')),
      pushed_at           INTEGER,
      pushed_content_hash TEXT,
      referenced_at       INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL
    ) STRICT
  `);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_digests_hash ON digests (content_hash)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_digests_push ON digests (push_state, is_error, created_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_digests_referenced ON digests (referenced_at, created_at)",
  );
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS digests_fts USING fts5(headings_text, preview, content='digests', content_rowid='id', tokenize='porter')",
  );
  db.exec(`
    CREATE TRIGGER digests_ai AFTER INSERT ON digests BEGIN
      INSERT INTO digests_fts(rowid, headings_text, preview) VALUES (new.id, new.headings_text, new.preview);
    END
  `);
  db.exec(`
    CREATE TRIGGER digests_ad AFTER DELETE ON digests BEGIN
      INSERT INTO digests_fts(digests_fts, rowid, headings_text, preview) VALUES ('delete', old.id, old.headings_text, old.preview);
    END
  `);
  db.exec(`
    CREATE TRIGGER digests_au AFTER UPDATE ON digests BEGIN
      INSERT INTO digests_fts(digests_fts, rowid, headings_text, preview) VALUES ('delete', old.id, old.headings_text, old.preview);
      INSERT INTO digests_fts(rowid, headings_text, preview) VALUES (new.id, new.headings_text, new.preview);
    END
  `);
  db.exec(`PRAGMA user_version = ${DIGEST_SCHEMA_VERSION}`);
}

export interface DigestPutResult {
  status: "stored" | "duplicate" | "rejected";
  /** 拒写原因（deny-pattern 的模式源串）。 */
  reason?: string;
  id?: number;
}

/** 写入一条摘要索引（底线闸 → 去重 → 插入）。去重命中返回既有 id（幂等）。 */
export function putDigest(
  db: DatabaseSync,
  record: DigestRecord,
): DigestPutResult {
  const now = record.now ?? Date.now();
  const headingsText = record.headings.map((h) => h.text).join("\n");
  const gateText = `${headingsText}\n${record.preview}`;
  const pattern = matchDenyPattern(gateText);
  if (pattern !== null) return { status: "rejected", reason: pattern };
  const existing = db
    .prepare("SELECT id FROM digests WHERE content_hash = ? LIMIT 1")
    .get(record.contentHash) as { id: number } | undefined;
  if (existing !== undefined) return { status: "duplicate", id: existing.id };
  const result = db
    .prepare(
      `INSERT INTO digests
         (session_id, tool, locator, seq, headings, key_lines, slices, fingerprint,
          headings_text, preview, is_error, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.sessionId,
      record.tool,
      record.locator,
      record.seq,
      JSON.stringify(record.headings),
      JSON.stringify(record.keyLines),
      JSON.stringify(record.slices),
      record.fingerprint,
      headingsText,
      record.preview,
      record.isError ? 1 : 0,
      record.contentHash,
      now,
    );
  return { status: "stored", id: Number(result.lastInsertRowid) };
}

/** 检索（属主自有入口，不经 memory 检索面——§7「I 层走单独入口」）；命中即刷 referenced_at。 */
export function searchDigests(
  db: DatabaseSync,
  query: string,
  opts: { limit?: number; now?: number } = {},
): Array<{
  id: number;
  sessionId: string;
  tool: string;
  locator: string | null;
  preview: string;
}> {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
  const now = opts.now ?? Date.now();
  const likeOf = (): string =>
    `%${query
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_")}%`;
  let ids: number[] = [];
  let needLike = false;
  try {
    ids = (
      db
        .prepare(
          `SELECT rowid FROM digests_fts WHERE digests_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(query, limit) as Array<{ rowid: number }>
    ).map((row) => row.rowid);
  } catch {
    needLike = true; // FTS 语法错误 → LIKE 兜底。
  }
  // CJK 短词 porter/trigram 召回受限 → LIKE 兜底（与 memory-base 同策略）。
  if ((ids.length === 0 && /[\u4e00-\u9fff]/u.test(query)) || needLike) {
    const like = likeOf();
    ids = (
      db
        .prepare(
          `SELECT id FROM digests WHERE headings_text LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\' LIMIT ?`,
        )
        .all(like, like, limit) as Array<{ id: number }>
    ).map((row) => row.id);
  }
  const out: Array<{
    id: number;
    sessionId: string;
    tool: string;
    locator: string | null;
    preview: string;
  }> = [];
  for (const id of ids) {
    const row = db
      .prepare(
        "SELECT id, session_id, tool, locator, preview FROM digests WHERE id = ?",
      )
      .get(id) as
      | {
          id: number;
          session_id: string;
          tool: string;
          locator: string | null;
          preview: string;
        }
      | undefined;
    if (row === undefined) continue;
    db.prepare("UPDATE digests SET referenced_at = ? WHERE id = ?").run(
      now,
      id,
    );
    out.push({
      id: row.id,
      sessionId: row.session_id,
      tool: row.tool,
      locator: row.locator,
      preview: row.preview,
    });
  }
  return out;
}

/** 按 locator 回读（headings / keyLines / slices 全量 + referenced_at 刷新）。 */
export function readDigest(
  db: DatabaseSync,
  locator: string,
  opts: { now?: number } = {},
):
  | {
      id: number;
      sessionId: string;
      tool: string;
      headings: string[];
      keyLines: number[];
      slices: Array<{ start: number; end: number; fnv: string }>;
    }
  | undefined {
  const now = opts.now ?? Date.now();
  const row = db
    .prepare(
      "SELECT id, session_id, tool, headings, key_lines, slices FROM digests WHERE locator = ? ORDER BY id ASC LIMIT 1",
    )
    .get(locator) as
    | {
        id: number;
        session_id: string;
        tool: string;
        headings: string;
        key_lines: string;
        slices: string;
      }
    | undefined;
  if (row === undefined) return undefined;
  db.prepare("UPDATE digests SET referenced_at = ? WHERE id = ?").run(
    now,
    row.id,
  );
  return {
    id: row.id,
    sessionId: row.session_id,
    tool: row.tool,
    headings: JSON.parse(row.headings) as string[],
    keyLines: JSON.parse(row.key_lines) as number[],
    slices: JSON.parse(row.slices) as Array<{
      start: number;
      end: number;
      fnv: string;
    }>,
  };
}

/** 容量自查（属主自管：启动后 + 每次写入后；超限清最旧）。返回删除行数。 */
export function pruneDigests(
  db: DatabaseSync,
  maxBytes: number = DIGEST_MAX_BYTES,
): number {
  const totalOf = (): number =>
    Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(LENGTH(preview) + LENGTH(headings_text) + LENGTH(locator) + 512), 0) AS bytes FROM digests",
          )
          .get() as { bytes: number }
      ).bytes,
    );
  let deleted = 0;
  let total = totalOf();
  while (total > maxBytes) {
    const result = db
      .prepare(
        "DELETE FROM digests WHERE id IN (SELECT id FROM digests ORDER BY created_at ASC, id ASC LIMIT 10)",
      )
      .run();
    const changes = Number(result.changes);
    if (changes === 0) break;
    deleted += changes;
    total = totalOf();
  }
  return deleted;
}

/** 会话目录解析（D60-b）：existsSync 且不 mkdir；返回 null = 解析失败（调用方告警跳过）。 */
export function resolveSessionDigestPath(
  sessionDir: string | undefined,
): string | null {
  if (sessionDir === undefined || sessionDir === "") return null;
  const dir = resolve(sessionDir);
  if (!existsSync(dir)) return null;
  return dir;
}
