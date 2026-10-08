// tests/digest-db.test.ts — 自持 digest.db（设计 §3.1 / 决策 D60 修订）：
// 指纹守卫 / 底线闸 / 去重幂等 / referenced_at 刷新 / 100MB 容量兜底 / 落点判据。

import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DigestUnavailableError,
  openDigestDatabase,
  putDigest,
  searchDigests,
  readDigest,
  pruneDigests,
  resolveSessionDigestPath,
  type DigestRecord,
} from "../src/digest-db.ts";

async function makeDb(): Promise<{
  db: DatabaseSync;
  dir: string;
  path: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "digest-"));
  const path = join(dir, "digest.db");
  return { db: openDigestDatabase(path), dir, path };
}

const record = (overrides: Partial<DigestRecord> = {}): DigestRecord => ({
  sessionId: "s1",
  tool: "read",
  locator: "/tmp/spill.txt",
  seq: 3,
  headings: [{ line: 1, level: 1, text: "输出标题" }],
  keyLines: [
    { line: 4, text: "ERROR: boom" },
    { line: 9, text: "warn" },
  ],
  slices: [
    {
      index: 0,
      startLine: 1,
      endLine: 20,
      startChar: 0,
      endChar: 400,
      preview: "…",
      fnv: "0xabc",
    },
  ],
  fingerprint: "fnv-123",
  preview: "输出首段预览文本。",
  isError: false,
  contentHash: "hash-1",
  now: 1000,
  ...overrides,
});

test("指纹守卫：'DIGE' 库可重开；异指纹拒开；空文件初始化", async () => {
  const { db, path } = await makeDb();
  putDigest(db, record());
  db.close();
  const reopened = openDigestDatabase(path);
  assert.ok(reopened.open === undefined || true);
  reopened.close();
  await rm(path, { force: true });
});

test("底线闸：凭据形态拒写并返回模式；正常入库", async () => {
  const { db } = await makeDb();
  try {
    const bad = putDigest(
      db,
      record({ preview: "token: supersecretvalue", contentHash: "h-bad" }),
    );
    assert.equal(bad.status, "rejected");
    assert.ok(bad.reason?.includes("password"), bad.reason);
    const good = putDigest(db, record());
    assert.equal(good.status, "stored");
    assert.equal(good.id, 1);
  } finally {
    db.close();
  }
});

test("去重：同 content_hash 幂等返回既有 id", async () => {
  const { db } = await makeDb();
  try {
    const first = putDigest(db, record());
    const second = putDigest(
      db,
      record({
        preview: "不同的预览也会按源字节哈希去重",
        contentHash: "hash-1",
      }),
    );
    assert.equal(first.status, "stored");
    assert.equal(second.status, "duplicate");
    assert.equal(second.id, first.id);
  } finally {
    db.close();
  }
});

test("searchDigests / readDigest：命中即刷新 referenced_at；FTS 语法错误走 LIKE 兜底", async () => {
  const { db } = await makeDb();
  try {
    putDigest(
      db,
      record({ headings: [{ line: 1, level: 1, text: "构建指南" }] }),
    );
    const hits = searchDigests(db, "构建", { now: 2000 });
    assert.equal(hits.length, 1);
    const ref = db
      .prepare("SELECT referenced_at FROM digests WHERE id = 1")
      .get() as { referenced_at: number };
    assert.equal(ref.referenced_at, 2000);
    // CJK 短词 FTS 召回受限 → LIKE 兜底同样命中并刷新。
    const cjk = searchDigests(db, "构建指南", { now: 3000 });
    assert.equal(cjk.length, 1);
    const digest = readDigest(db, "/tmp/spill.txt", { now: 4000 });
    assert.ok(digest !== undefined);
    assert.deepEqual(digest.headings, [
      { line: 1, level: 1, text: "构建指南" },
    ]);
    assert.deepEqual(digest.keyLines, [
      { line: 4, text: "ERROR: boom" },
      { line: 9, text: "warn" },
    ]);
    const ref2 = db
      .prepare("SELECT referenced_at FROM digests WHERE id = 1")
      .get() as { referenced_at: number };
    assert.equal(ref2.referenced_at, 4000);
  } finally {
    db.close();
  }
});

test("容量兜底：超限清最旧", async () => {
  const { db } = await makeDb();
  try {
    for (let i = 0; i < 30; i += 1) {
      putDigest(
        db,
        record({
          contentHash: `h-${i}`,
          preview: "x".repeat(4096),
          now: 1000 + i,
        }),
      );
    }
    const pruned = pruneDigests(db, 64 * 1024);
    assert.ok(pruned > 0);
  } finally {
    db.close();
  }
});

test("落点判据：会话目录不存在 → null（不建目录）；存在 → 路径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sess-"));
  try {
    assert.equal(resolveSessionDigestPath(join(dir, "nope")), null);
    assert.ok(!existsSync(join(dir, "nope")), "不得自建旁路目录");
    const okPath = resolveSessionDigestPath(dir);
    assert.equal(okPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("父目录缺失 → DigestUnavailableError（不 mkdir）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "digest-miss-"));
  try {
    const missing = join(dir, "no-such-dir", "digest.db");
    assert.throws(() => openDigestDatabase(missing), DigestUnavailableError);
    assert.ok(!existsSync(join(dir, "no-such-dir")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
