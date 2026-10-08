/**
 * schema 测试：四表结构、双 FTS5 影子表（porter/trigram）经 TRIGGER 写直达同步一致。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKnowledgeDatabase } from "../src/schema.ts";

/** 插入一条 source + 一条 chunk，返回 chunk 行 id。 */
function seedChunk(
  db: Awaited<ReturnType<typeof openKnowledgeDatabase>>,
): number {
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
        "INSERT INTO chunks (source_id, project, category, title, content, content_hash, importance, last_referenced, created_at) VALUES (?, ?, ?, ?, ?, ?, 3, 0, ?)",
      )
      .run(sourceId, "p1", "c1", "hello world", "foo bar baz", "h2", Date.now())
      .lastInsertRowid,
  );
}

test("四表 + 双 FTS5 + TRIGGER：insert/update/delete 双索引一致", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    const id = seedChunk(db);

    // insert 后 porter（语义词干）与 trigram（子串）均可命中。
    let ids = (
      db
        .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'world'")
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, [1]);
    ids = (
      db
        .prepare(
          "SELECT rowid FROM chunks_trigram_fts WHERE chunks_trigram_fts MATCH 'bar'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, [1]);

    // update 映射为 delete 旧行 + insert 新行：新词命中、旧词不再命中。
    db.prepare(
      "UPDATE chunks SET title = 'new world', content = 'xyz quark' WHERE id = ?",
    ).run(id);
    ids = (
      db
        .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'world'")
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, [1]);
    ids = (
      db
        .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'bar'")
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, []);
    ids = (
      db
        .prepare(
          "SELECT rowid FROM chunks_trigram_fts WHERE chunks_trigram_fts MATCH 'quark'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, [1]);
    ids = (
      db
        .prepare(
          "SELECT rowid FROM chunks_trigram_fts WHERE chunks_trigram_fts MATCH 'baz'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, []);

    // delete 后两个 FTS 索引同步清空。
    db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
    ids = (
      db
        .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'world'")
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, []);
    ids = (
      db
        .prepare(
          "SELECT rowid FROM chunks_trigram_fts WHERE chunks_trigram_fts MATCH 'quark'",
        )
        .all() as Array<{ rowid: number }>
    ).map((r) => r.rowid);
    assert.deepEqual(ids, []);
  } finally {
    db.close();
  }
});

test("索引与外部内容表建立：chunks 有 project+last_referenced 与 source_id 索引", async () => {
  const db = await openKnowledgeDatabase(":memory:");
  try {
    const idxNames = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chunks'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    assert.ok(idxNames.includes("idx_chunks_project_lr"));
    assert.ok(idxNames.includes("idx_chunks_source"));
  } finally {
    db.close();
  }
});

test("文件库打开：重复 open 幂等且保留数据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-schema-"));
  try {
    const path = join(dir, "kb.db");
    const db = await openKnowledgeDatabase(path);
    seedChunk(db);
    db.close();

    const again = await openKnowledgeDatabase(path);
    const count = (
      again.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    assert.equal(count, 1);
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
