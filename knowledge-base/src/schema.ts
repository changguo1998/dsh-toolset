/**
 * knowledge-base SQLite schema：四表结构（sources/chunks）+ 双 FTS5 影子表 + TRIGGER 写直达。
 *
 * 设计对照 docs/AGENT-ARCHITECTURE-ANALOGY.md §12.1：
 * - sources / chunks 为内容主体（普通 SQL 做过滤/排序/淘汰）；
 * - chunks_fts（porter 语义词干 BM25）与 chunks_trigram_fts（trigram 子串/模糊检索）
 *   以 external content 模式挂靠 chunks（免双份存储），由 TRIGGER 在 insert/update/delete
 *   写直达同步（update = delete 旧行 + insert 新行）。
 *
 * open 流程仿 packages/session-query/session-query-sqlite/src/schema.ts：
 * application_id / user_version 守护、0o600 文件创建、journal_mode（默认 WAL）、
 * 版本不匹配时整库重置后重建，避免跨代 schema 漂移。
 * PRAGMA 不支持参数绑定，故各 PRAGMA SQL 以常量/映射形式预计算，不做运行时插值。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** 当前 schema 版本。不兼容变更时 +1，open 时整库重置。 */
export const KNOWLEDGE_SCHEMA_VERSION = 1;

/** SQLite application id（'KNOW'），防止误开其他应用的中立数据库。 */
export const KNOWLEDGE_APPLICATION_ID = 0x4b4e4f57;

/** 支持的 SQLite journal 模式。 */
export type JournalMode = "wal" | "delete" | "truncate" | "persist";

const PRAGMA_APP_ID_SQL = `PRAGMA application_id = ${KNOWLEDGE_APPLICATION_ID}`;
const PRAGMA_VERSION_SQL = `PRAGMA user_version = ${KNOWLEDGE_SCHEMA_VERSION}`;

/** 各 journal 模式对应的静态 PRAGMA SQL（封闭枚举，映射到字面量）。 */
/** 各 journal 模式对应的静态 PRAGMA SQL（封闭枚举，映射到字面量）。 */
const JOURNAL_MODE_SQL = {
  wal: "PRAGMA journal_mode = WAL",
  delete: "PRAGMA journal_mode = DELETE",
  truncate: "PRAGMA journal_mode = TRUNCATE",
  persist: "PRAGMA journal_mode = PERSIST",
} satisfies Record<JournalMode, string>;

/** 仅创建缺失的数据库文件，权限 0o600；已存在则保留原权限。 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function listUserTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * 版本不匹配或外部污染时整库重建。
 * FTS 影子表随虚拟表 DROP 自动清理，base 表 DROP 连带其 TRIGGER。
 */
function resetSchema(db: DatabaseSync): void {
  db.exec("DROP TABLE IF EXISTS chunks_trigram_fts");
  db.exec("DROP TABLE IF EXISTS chunks_fts");
  db.exec("DROP TABLE IF EXISTS chunks");
  db.exec("DROP TABLE IF EXISTS sources");
  db.exec("PRAGMA user_version = 0");
}

/** 建表 + 索引 + 双 FTS5 影子表 + 写直达 TRIGGER。仅应在空库/已重置库上调用。 */
function ensureSchema(db: DatabaseSync): void {
  db.exec(PRAGMA_APP_ID_SQL);
  db.exec(`
    CREATE TABLE sources (
      id           INTEGER PRIMARY KEY,
      kind         TEXT NOT NULL,
      label        TEXT,
      ref          TEXT,
      content_hash TEXT,
      chunk_count  INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE chunks (
      id              INTEGER PRIMARY KEY,
      source_id       INTEGER NOT NULL REFERENCES sources(id),
      project         TEXT NOT NULL,
      target          TEXT,
      category        TEXT,
      title           TEXT,
      content         TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      importance      INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
      session_id      TEXT,
      last_referenced INTEGER NOT NULL DEFAULT 0,
      summary         TEXT,
      created_at      INTEGER NOT NULL
    ) STRICT
  `);
  db.exec(
    "CREATE INDEX idx_chunks_project_lr ON chunks (project, last_referenced)",
  );
  db.exec("CREATE INDEX idx_chunks_source ON chunks (source_id)");
  db.exec(
    "CREATE VIRTUAL TABLE chunks_fts USING fts5(title, content, content='chunks', content_rowid='id', tokenize='porter')",
  );
  db.exec(
    "CREATE VIRTUAL TABLE chunks_trigram_fts USING fts5(title, content, content='chunks', content_rowid='id', tokenize='trigram')",
  );
  // TRIGGER 写直达：insert 双写、update 先删旧行再插新行、delete 删除 FTS 行。
  db.exec(`
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
      INSERT INTO chunks_trigram_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO chunks_trigram_fts(chunks_trigram_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO chunks_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
      INSERT INTO chunks_trigram_fts(chunks_trigram_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO chunks_trigram_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END
  `);
  db.exec(PRAGMA_VERSION_SQL);
}

/**
 * 打开并初始化知识库连接。
 * @param path 独立 SQLite 库路径或 `:memory:`；文件路径父目录自动创建（0o700）。
 * @param journalMode 校验过的 journal 模式（默认 wal）。
 */
export async function openKnowledgeDatabase(
  path: string,
  journalMode: JournalMode = "wal",
): Promise<DatabaseSync> {
  const actual = path === ":memory:" ? path : resolve(path);
  if (actual !== ":memory:") {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 });
    await createDatabaseFile(actual);
  }
  const db = new DatabaseSync(actual);
  try {
    const { application_id: appId } = db
      .prepare("PRAGMA application_id")
      .get() as {
      application_id: number;
    };
    const { user_version: version } = db
      .prepare("PRAGMA user_version")
      .get() as {
      user_version: number;
    };
    if (appId !== 0 && appId !== KNOWLEDGE_APPLICATION_ID) {
      throw new Error(
        `knowledge-base 数据库 "${actual}" 属于其他应用，拒绝打开`,
      );
    }
    if (appId === 0) {
      if (listUserTables(db).length > 0) {
        throw new Error(
          `knowledge-base 数据库 "${actual}" 非空且非本应用库，拒绝打开`,
        );
      }
      resetSchema(db);
      ensureSchema(db);
    } else if (version !== KNOWLEDGE_SCHEMA_VERSION) {
      resetSchema(db);
      ensureSchema(db);
    }
    db.exec(JOURNAL_MODE_SQL[journalMode]);
    return db;
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}
