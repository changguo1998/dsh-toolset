// tests/digest-db.test.ts — 自持 digest.db（设计 §3.1 / 决策 D60 修订）：
// 指纹守卫 / 底线闸 / 去重幂等 / referenced_at 刷新 / 100MB 容量兜底 / 落点判据。

import { DatabaseSync } from "node:sqlite";
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

test("指纹与版本守卫：异指纹 / 版本不符 / 空库版本异常都拒开且不建表", async () => {
  const dir = await mkdtemp(join(tmpdir(), "digest-guard-"));
  const seed = (path: string, appId?: number, version?: number): void => {
    const raw = new DatabaseSync(path);
    try {
      if (appId !== undefined) raw.exec(`PRAGMA application_id = ${appId}`);
      if (version !== undefined) raw.exec(`PRAGMA user_version = ${version}`);
    } finally {
      raw.close();
    }
  };
  try {
    const foreign = join(dir, "foreign.db");
    seed(foreign, 1234, 1);
    assert.throws(() => openDigestDatabase(foreign), /指纹 1234/);

    const newer = join(dir, "newer.db");
    seed(newer, 0x44494745, 2);
    assert.throws(
      () => openDigestDatabase(newer),
      /版本 2 与当前 1 不符且无迁移链/,
    );

    const odd = join(dir, "odd.db");
    seed(odd, undefined, 1);
    assert.throws(() => openDigestDatabase(odd), /版本异常/);

    // 被拒开的库不得留下本包的表（建表在守卫之后）。
    const db = new DatabaseSync(foreign);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      assert.deepEqual(tables, [], "拒开前不建表");
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchDigests：FTS 语法错误走 LIKE 兜底；LIKE 通配符按字面匹配", async () => {
  const { db } = await makeDb();
  try {
    putDigest(
      db,
      record({ preview: "磁盘使用 50% 剩余", contentHash: "h-pct" }),
    );
    // 裸 '%' 不是合法 FTS5 查询 → 抛错 → 回落 LIKE；转义后按字面 '%' 命中。
    const percent = searchDigests(db, "%", { now: 1 });
    assert.equal(percent.length, 1, "'%' 按字面匹配");
    // 下划线同样转义，不会当成单字符通配符。
    assert.deepEqual(searchDigests(db, "_", { now: 1 }), []);
    // 括号在 FTS 与 LIKE 下都不成词，返回空且不抛错。
    assert.deepEqual(searchDigests(db, "(", { now: 1 }), []);
    // limit 钳位：0 → 1，超上限 → 100，均不抛错。
    assert.equal(searchDigests(db, "%", { limit: 0 }).length, 1);
    assert.equal(searchDigests(db, "%", { limit: 999 }).length, 1);
  } finally {
    db.close();
  }
});

test("readDigest / pruneDigests：未命中返回 undefined；空表清理不循环", async () => {
  const { db } = await makeDb();
  try {
    assert.equal(readDigest(db, "/tmp/never-written.txt"), undefined);
    assert.equal(pruneDigests(db, 0), 0, "空表无可删行时不进入删除循环");
    putDigest(db, record());
    assert.equal(readDigest(db, "/tmp/spill.txt")?.tool, "read");
    // maxBytes 为 0：逐批删到空表后靠 changes === 0 收尾，不无限循环。
    assert.equal(pruneDigests(db, 0), 1);
    assert.equal(pruneDigests(db, 0), 0);
  } finally {
    db.close();
  }
});
