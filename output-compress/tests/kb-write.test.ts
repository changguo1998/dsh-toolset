/**
 * 共享库写入测试：去重、指纹拒写、FTS 召回、dbPath 解析链、chunk 切分。
 *
 * 测试库按 knowledge-base 的 DDL 复刻（sources/chunks + 双 FTS5 + 触发器 + 指纹），
 * 保证列名与真实共享库一致。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  chunkContent,
  KbNotMountedError,
  resolveDbPath,
  SharedKbWriter,
} from "../src/kb-write.ts";

/** 按 knowledge-base 的 DDL 建测试库（可指定错误指纹用于拒写用例）。 */
function makeKbDb(
  dbPath: string,
  opts: { appId?: number; version?: number; dropChunks?: boolean } = {},
): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  const appId = opts.appId ?? 0x4b4e4f57; // 'KNOW'
  db.exec(`PRAGMA application_id = ${appId}`);
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
  if (!opts.dropChunks) {
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
      "CREATE VIRTUAL TABLE chunks_fts USING fts5(title, content, content='chunks', content_rowid='id', tokenize='porter')",
    );
    db.exec(
      "CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END",
    );
  }
  db.exec(`PRAGMA user_version = ${opts.version ?? 1}`);
  return db;
}

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-kbtest-"));
}

const PUT_INPUT = {
  project: "test-project",
  title: "output-compress test",
  content: "# 摘要\n\n段落一。\n\n段落二，包含检索关键词 unique-marker-xyz。",
  category: "output-compress",
  target: "output-compress",
  importance: 2,
  sessionId: "sess-test-1",
  source: { kind: "tool_result", label: "bash", ref: "test-ref" },
} as const;

test("写入 chunk 并经 FTS 触发器召回", () => {
  const dir = makeTmpDir();
  const dbPath = path.join(dir, "kb.db");
  makeKbDb(dbPath);
  const writer = new SharedKbWriter(dbPath);
  try {
    const r = writer.put(PUT_INPUT);
    assert.equal(r.created, 1);
    const fts = new DatabaseSync(dbPath);
    const row = fts
      .prepare(
        `SELECT c.category, c.content FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH '"unique-marker-xyz"'`,
      )
      .get() as { category: string; content: string } | undefined;
    fts.close();
    assert.ok(row !== undefined);
    assert.equal(row.category, "output-compress");
    assert.ok(row.content.includes("unique-marker-xyz"));
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("去重：同内容二次 put → created=0 且复用 source", () => {
  const dir = makeTmpDir();
  const dbPath = path.join(dir, "kb.db");
  makeKbDb(dbPath);
  const writer = new SharedKbWriter(dbPath);
  try {
    const r1 = writer.put(PUT_INPUT);
    const r2 = writer.put(PUT_INPUT);
    assert.equal(r1.created, 1);
    assert.equal(r2.created, 0);
    assert.equal(r2.sourceId, r1.sourceId);
    assert.deepEqual(r2.ids, r1.ids);
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多 chunk 内容按预算切分（每块 ≤ 6000 字符）", () => {
  const dir = makeTmpDir();
  const dbPath = path.join(dir, "kb.db");
  makeKbDb(dbPath);
  const writer = new SharedKbWriter(dbPath);
  try {
    const big = "段A。".repeat(2000) + "\n\n" + "段B。".repeat(2000);
    const r = writer.put({ ...PUT_INPUT, content: big });
    assert.ok(r.created >= 2);
    assert.ok(chunkContent(big).every((c) => c.length <= 6000));
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("指纹不符 → KbNotMountedError 拒写", () => {
  const dir = makeTmpDir();
  const dbPath = path.join(dir, "kb.db");
  makeKbDb(dbPath, { appId: 0xdeadbeef });
  const writer = new SharedKbWriter(dbPath);
  assert.throws(() => writer.put(PUT_INPUT), KbNotMountedError);
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

test("必备表缺失（仅指纹对）→ KbNotMountedError 拒写", () => {
  const dir = makeTmpDir();
  const dbPath = path.join(dir, "kb.db");
  makeKbDb(dbPath, { dropChunks: true });
  const writer = new SharedKbWriter(dbPath);
  assert.throws(() => writer.put(PUT_INPUT), KbNotMountedError);
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

test("库文件不存在 → KbNotMountedError", () => {
  const dir = makeTmpDir();
  const writer = new SharedKbWriter(path.join(dir, "missing.db"));
  assert.throws(() => writer.open(), KbNotMountedError);
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

test("resolveDbPath 解析链：config > OUTPUT_COMPRESS_DB_PATH > KNOWLEDGE_DB_PATH > 默认", () => {
  const prev = {
    oc: process.env.OUTPUT_COMPRESS_DB_PATH,
    kb: process.env.KNOWLEDGE_DB_PATH,
  };
  try {
    delete process.env.OUTPUT_COMPRESS_DB_PATH;
    delete process.env.KNOWLEDGE_DB_PATH;
    assert.ok(
      resolveDbPath(undefined).endsWith(
        path.join("knowledge-base", "knowledge.db"),
      ),
    );
    process.env.KNOWLEDGE_DB_PATH = "/tmp/kb-env.db";
    assert.equal(resolveDbPath(undefined), "/tmp/kb-env.db");
    process.env.OUTPUT_COMPRESS_DB_PATH = "/tmp/oc-env.db";
    assert.equal(resolveDbPath(undefined), "/tmp/oc-env.db");
    assert.equal(resolveDbPath("/tmp/explicit.db"), "/tmp/explicit.db");
    assert.equal(resolveDbPath(""), "/tmp/oc-env.db"); // 空串走 env 链
  } finally {
    if (prev.oc === undefined) delete process.env.OUTPUT_COMPRESS_DB_PATH;
    else process.env.OUTPUT_COMPRESS_DB_PATH = prev.oc;
    if (prev.kb === undefined) delete process.env.KNOWLEDGE_DB_PATH;
    else process.env.KNOWLEDGE_DB_PATH = prev.kb;
  }
});

test("chunkContent：段落边界优先，超预算段落硬切", () => {
  const para = "字".repeat(3000);
  const chunks = chunkContent(`${para}\n\n${para}`);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], para);
  const huge = "硬".repeat(15000);
  const hardChunks = chunkContent(huge);
  assert.equal(hardChunks.length, 3); // 6000+6000+3000
  assert.ok(hardChunks.every((c) => c.length <= 6000));
});

test("mkdir 子目录的库路径可写（profile dbPath 指向新目录场景）", () => {
  const dir = makeTmpDir();
  const dbPath = path.join(dir, "nested", "kb.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  makeKbDb(dbPath);
  const writer = new SharedKbWriter(dbPath);
  const r = writer.put(PUT_INPUT);
  assert.equal(r.created, 1);
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});
