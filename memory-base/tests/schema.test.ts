/**
 * schema 测试：分类表结构、双 FTS5 影子表（porter/trigram）经 TRIGGER 写直达同步一致、
 * 版本守护（不匹配拒绝打开，不整库重置）、文件库重复 open 幂等。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  openKnowledgeDatabase,
} from "../src/schema.ts";
import { ensureKindTable } from "../src/schema.ts";

type Db = Awaited<ReturnType<typeof openKnowledgeDatabase>>;

/** 插入一条 source + 一条分类行，返回行 id。 */
function seedChunk(db: Db): number {
  ensureKindTable(db, "kind_note");
  const sourceId = Number(
    db
      .prepare(
        "INSERT INTO sources (kind, label, content_hash, created_at) VALUES ('manual', 't', ?, ?)",
      )
      .run("h", Date.now()).lastInsertRowid,
  );
  return Number(
    db
      .prepare(
        "INSERT INTO kind_note (source_id, project, title, content, content_hash, importance, created_at) VALUES (?, ?, ?, ?, ?, 3, ?)",
      )
      .run(sourceId, "p1", "hello world", "foo bar baz", "h2", Date.now())
      .lastInsertRowid,
  );
}

test("分类表 + 双 FTS5 + TRIGGER：insert/update/delete 双索引一致", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    const id = seedChunk(db);

    // insert 后 porter（语义词干）与 trigram（子串）均可命中。
    let ids = (
      db
        .prepare(
          "SELECT rowid FROM kind_note_fts WHERE kind_note_fts MATCH 'world'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, [1]);
    ids = (
      db
        .prepare(
          "SELECT rowid FROM kind_note_trigram_fts WHERE kind_note_trigram_fts MATCH 'bar'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, [1]);

    // update 映射为 delete 旧行 + insert 新行：新词命中、旧词不再命中。
    db.prepare(
      "UPDATE kind_note SET title = 'new world', content = 'xyz quark' WHERE id = ?",
    ).run(id);
    ids = (
      db
        .prepare(
          "SELECT rowid FROM kind_note_fts WHERE kind_note_fts MATCH 'world'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, [1]);
    ids = (
      db
        .prepare(
          "SELECT rowid FROM kind_note_fts WHERE kind_note_fts MATCH 'bar'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, []);
    ids = (
      db
        .prepare(
          "SELECT rowid FROM kind_note_trigram_fts WHERE kind_note_trigram_fts MATCH 'quark'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, [1]);

    // delete 后两个 FTS 索引同步清空。
    db.prepare("DELETE FROM kind_note WHERE id = ?").run(id);
    ids = (
      db
        .prepare(
          "SELECT rowid FROM kind_note_trigram_fts WHERE kind_note_trigram_fts MATCH 'quark'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, []);
  } finally {
    db.close();
  }
});

test("分类表只含收窄后的列集，且无 candidates / doc_index 表", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    ensureKindTable(db, "kind_note");
    const columns = (
      db.prepare("PRAGMA table_info(kind_note)").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    assert.deepEqual(columns, [
      "id",
      "source_id",
      "project",
      "title",
      "content",
      "content_hash",
      "importance",
      "session_id",
      "created_at",
    ]);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    assert.ok(!tables.includes("candidates"), "候选表已删除");
    assert.ok(!tables.includes("doc_index"), "文档索引表已删除");
    assert.ok(tables.includes("sources"));
  } finally {
    db.close();
  }
});

test("索引与外部内容表建立：分类表有 project + created_at 与 source_id 索引", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    ensureKindTable(db, "kind_note");
    const idxNames = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kind_note'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    assert.ok(idxNames.includes("idx_kind_note_project"));
    assert.ok(idxNames.includes("idx_kind_note_source"));
  } finally {
    db.close();
  }
});

test("文件库打开：重复 open 幂等且保留数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-schema-"));
  try {
    const path = join(dir, "session.db");
    const db = await openKnowledgeDatabase(path);
    seedChunk(db);
    db.close();

    const again = await openKnowledgeDatabase(path);
    const count = (
      again.prepare("SELECT COUNT(*) AS n FROM kind_note").get() as {
        n: number;
      }
    ).n;
    assert.equal(count, 1);
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("版本不匹配：拒绝打开而不是整库重置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-schema-"));
  try {
    const path = join(dir, "session.db");
    const db = await openKnowledgeDatabase(path);
    seedChunk(db);
    db.exec("PRAGMA user_version = 99");
    db.close();

    // 拒绝打开：报版本不符，并指明显式迁移入口。
    await assert.rejects(
      () => openKnowledgeDatabase(path),
      new RegExp(`版本 99 与当前 ${KNOWLEDGE_SCHEMA_VERSION} 不符且无可用迁移`),
    );

    // 数据仍在（没有被 DROP 重建）。
    const reopened = new DatabaseSync(path);
    try {
      const count = (
        reopened.prepare("SELECT COUNT(*) AS n FROM kind_note").get() as {
          n: number;
        }
      ).n;
      assert.equal(count, 1);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
