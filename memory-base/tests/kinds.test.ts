/**
 * 分类注册机制测试：注册即按需建表、未注册拒写、`writableTiers` 归一与校验、
 * `preWrite`（同步 / 异步）拒写与建议 importance、跨分类检索并集、代码里不出现具体分类名。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openTierDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import { KindRegistry } from "../src/router.ts";

/** 内存库 + 注册一个带 `preWrite` 的分类（可选附带第二个分类）。 */
async function makeService(): Promise<{
  db: Awaited<ReturnType<typeof openTierDatabase>>;
  kb: KnowledgeService;
  registry: KindRegistry;
}> {
  const db = await openTierDatabase(":memory:", "session");
  const registry = new KindRegistry();
  registry.register({
    kind: "alpha",
    preWrite: (input) =>
      input.content.includes("hook-deny")
        ? { accept: false, reason: "not allowed" }
        : {
            accept: true,
            importance: input.content.includes("hook-boost") ? 5 : undefined,
          },
  });
  registry.register({ kind: "default" });
  return { db, kb: new KnowledgeService(db, { registry }), registry };
}

test("未注册 kind 拒写并回报 skipped=kind，不落库", async () => {
  const { db, kb } = await makeService();
  try {
    const result = await kb.put({
      project: "p",
      content: "未注册分类内容",
      kind: "nope",
    });
    assert.deepEqual(result.ids, []);
    assert.equal(result.skipped, "kind");
    assert.equal(kb.countAll(), 0);
  } finally {
    db.close();
  }
});

test("注册分类按需建表：写入后才建表，检索命中且带 kind 标签", async () => {
  const { db, kb } = await makeService();
  try {
    const result = await kb.put({
      project: "p",
      title: "alpha title",
      content: "alpha body unique",
      kind: "alpha",
    });
    assert.equal(result.created, 1);
    // 「空表不建」：写入前表不存在，写入后才有（排除 FTS 影子表）。
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kind_%' AND name NOT LIKE '%\\_fts%' ESCAPE '\\'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    assert.deepEqual(tables, ["kind_alpha"]);

    const hits = kb.search({ query: "alpha body" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.kind, "alpha");
    // kind 过滤：指定其他分类时查不到。
    assert.equal(kb.search({ query: "alpha body", kind: "default" }).length, 0);
  } finally {
    db.close();
  }
});

test("写前钩子：拒绝 → skipped=hook；importance 建议生效", async () => {
  const { db, kb } = await makeService();
  try {
    const denied = await kb.put({
      project: "p",
      content: "hook-deny 这条被钩子拒绝",
      kind: "alpha",
    });
    assert.deepEqual(denied.ids, []);
    assert.equal(denied.skipped, "hook");

    const boosted = await kb.put({
      project: "p",
      content: "hook-boost 建议最高重要度",
      kind: "alpha",
      importance: 1,
    });
    assert.equal(boosted.created, 1);
    const hit = kb.search({ query: "hook-boost" })[0];
    assert.equal(hit?.importance, 5);
  } finally {
    db.close();
  }
});

test("写前钩子可为异步：Promise 判定同样生效", async () => {
  const db = await openTierDatabase(":memory:", "session");
  try {
    const registry = new KindRegistry();
    registry.register({
      kind: "async_kind",
      preWrite: async (input) =>
        input.content.includes("deny")
          ? { accept: false }
          : { accept: true, importance: 4 },
    });
    const kb = new KnowledgeService(db, { registry });
    assert.equal(
      (await kb.put({ kind: "async_kind", project: "p", content: "deny me" }))
        .skipped,
      "hook",
    );
    const ok = await kb.put({
      kind: "async_kind",
      project: "p",
      content: "accept me",
    });
    assert.equal(ok.created, 1);
    assert.equal(kb.search({ query: "accept" })[0]?.importance, 4);
  } finally {
    db.close();
  }
});

test("跨分类检索并集：两个分类都命中，结果各带 kind", async () => {
  const { db, kb } = await makeService();
  try {
    await kb.put({
      project: "p",
      content: "union target 兜底侧",
      kind: "default",
    });
    await kb.put({
      project: "p",
      content: "union target alpha 侧",
      kind: "alpha",
    });
    const hits = kb.search({ query: "union target" });
    assert.deepEqual(hits.map((hit) => hit.kind).sort(), ["alpha", "default"]);
    // LIKE 兜底路径同样跨分类（CJK 短词）。
    await kb.put({ project: "p", content: "并集检索甲", kind: "default" });
    await kb.put({ project: "p", content: "并集检索乙", kind: "alpha" });
    const cjk = kb.search({ query: "并集检索" });
    assert.deepEqual(cjk.map((hit) => hit.kind).sort(), ["alpha", "default"]);
  } finally {
    db.close();
  }
});

test("跨表删除：sources.chunk_count 跨分类聚合（同源两表只删一行仍保留来源）", async () => {
  const { db, kb } = await makeService();
  try {
    // 同内容落两个分类 → 共享同一 source；chunk_count = 两表行数之和。
    const alpha = await kb.put({
      project: "p",
      content: "共享来源的正文",
      kind: "alpha",
      source: { kind: "manual", label: "s" },
    });
    const beta = await kb.put({
      project: "p",
      content: "共享来源的正文",
      kind: "default",
      source: { kind: "manual", label: "s" },
    });
    assert.equal(beta.sourceId, alpha.sourceId);

    kb.evict([{ kind: "alpha", id: alpha.ids[0]! }]);
    const afterEvict = db
      .prepare("SELECT chunk_count FROM sources WHERE id = ?")
      .get(alpha.sourceId) as { chunk_count: number };
    assert.equal(afterEvict.chunk_count, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number })
        .n,
      1,
    );

    kb.evict([{ kind: "default", id: beta.ids[0]! }]);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number })
        .n,
      0,
    );
  } finally {
    db.close();
  }
});

test("注册表约束：同名 / 同表重复注册抛错；非法 writableTiers 抛错", async () => {
  const registry = new KindRegistry();
  const entry = registry.register({ kind: "alpha" });
  assert.deepEqual(entry.writableTiers, ["session"], "缺省只可写会话层");
  assert.throws(() => registry.register({ kind: "alpha" }), /已注册/);
  assert.throws(
    () => registry.register({ kind: "beta", table: "kind_alpha" }),
    /已属于/,
  );
  assert.throws(
    () => registry.register({ kind: "beta", table: "sources" }),
    /不合法/,
  );
  assert.throws(
    () =>
      registry.register({
        kind: "gamma",
        writableTiers: ["session", "bogus" as never],
      }),
    /非法层/,
  );
  assert.throws(
    () => registry.register({ kind: "delta", writableTiers: [] }),
    /不能为空/,
  );
  assert.deepEqual(
    registry.register({
      kind: "eps",
      writableTiers: ["project", "project", "user"],
    }).writableTiers,
    ["project", "user"],
    "重复层被归一",
  );
  assert.equal(registry.resolve("nope"), undefined);
});

test("代码里不出现具体分类名（分类语义归上层插件，本包只提供机制）", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const banned = /\b(preference|skill|convention)s?\b/i;
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(srcDir, file), "utf8");
    assert.ok(
      !banned.test(text),
      `${file} 出现具体分类名（分类语义归上层插件，本包只提供机制）`,
    );
  }
});
