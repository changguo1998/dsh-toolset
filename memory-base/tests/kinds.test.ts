/**
 * 分类注册机制测试（设计 §4 / §5，BACKLOG §12 #11）：
 * 未注册 kind 拒写；按需建表（加表即扩展，无数据迁移）；检索带 kind 标签 + 跨分类并集；
 * 事件类型认领；写前钩子；U 层禁止兜底；跨表删除与 sources 聚合；代码无具体分类名（D43）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openTierDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import { fallbackSpec, KindRegistry } from "../src/router.ts";
import { SessionHooks } from "../src/hooks.ts";
import { WritePolicy } from "../src/writepolicy.ts";
import { MemoryService } from "../src/memory.ts";

/** 注册表 + 服务：兜底分类 + 一个带扩展列与事件认领的分类。 */
async function makeService(options?: { allowFallback?: boolean }) {
  const db = await openTierDatabase(":memory:", "session");
  const registry = new KindRegistry();
  registry.register(fallbackSpec(registry.fallbackKind));
  registry.register({
    kind: "alpha",
    columns: [{ name: "extra_note", type: "TEXT" }],
    eventTypes: ["alpha/event"],
    preWrite: (input) =>
      input.content.includes("hook-deny")
        ? { accept: false, reason: "not allowed" }
        : {
            accept: true,
            importance: input.content.includes("hook-boost") ? 5 : undefined,
          },
  });
  const kb = new KnowledgeService(db, {
    registry,
    ...(options ?? {}),
  });
  return { db, kb, registry };
}

test("未注册 kind 拒写并回报 skipped=kind，不落库", async () => {
  const { db, kb } = await makeService();
  try {
    const result = kb.put({
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

test("注册分类按需建表：写入后检索命中且带 kind 标签", async () => {
  const { db, kb } = await makeService();
  try {
    const result = kb.put({
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

test("事件类型认领：未给 kind 的写入按注册的 eventTypes 路由", async () => {
  const { kb } = await makeService();
  const result = kb.put({
    project: "p",
    content: "事件认领内容",
    category: "alpha/event",
  });
  assert.equal(result.created, 1);
  const hits = kb.search({ query: "事件认领" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.kind, "alpha");
});

test("写前钩子：拒绝 → skipped=hook；importance 建议生效", async () => {
  const { db, kb } = await makeService();
  try {
    const denied = kb.put({
      project: "p",
      content: "hook-deny 这条被钩子拒绝",
      kind: "alpha",
    });
    assert.deepEqual(denied.ids, []);
    assert.equal(denied.skipped, "hook");

    const boosted = kb.put({
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

test("U 层禁止兜底：未给 kind 拒写，显式 kind 放行", async () => {
  const { db, kb } = await makeService({ allowFallback: false });
  try {
    const noKind = kb.put({ project: "p", content: "没给 kind" });
    assert.equal(noKind.skipped, "kind");
    const explicit = kb.put({
      project: "p",
      content: "显式兜底分类",
      kind: "default",
    });
    assert.equal(explicit.created, 1);
  } finally {
    db.close();
  }
});

test("跨分类检索并集：两个分类都命中，结果各带 kind", async () => {
  const { kb } = await makeService();
  kb.put({ project: "p", content: "union target 兜底侧", kind: "default" });
  kb.put({ project: "p", content: "union target alpha 侧", kind: "alpha" });
  const hits = kb.search({ query: "union target" });
  assert.deepEqual(hits.map((hit) => hit.kind).sort(), ["alpha", "default"]);
  // LIKE 兜底路径同样跨分类（CJK 短词）。
  kb.put({ project: "p", content: "并集检索甲", kind: "default" });
  kb.put({ project: "p", content: "并集检索乙", kind: "alpha" });
  const cjk = kb.search({ query: "并集检索" });
  assert.deepEqual(cjk.map((hit) => hit.kind).sort(), ["alpha", "default"]);
});

test("跨表删除：(kind, id) 精确删除；sources.chunk_count 跨分类聚合（D40）", async () => {
  const { db, kb } = await makeService();
  try {
    // 同内容落两个分类 → 共享同一 source；chunk_count = 两表行数之和。
    const alpha = kb.put({
      project: "p",
      content: "共享来源的正文",
      kind: "alpha",
      source: { kind: "manual", label: "s" },
    });
    const beta = kb.put({
      project: "p",
      content: "共享来源的正文",
      kind: "default",
      source: { kind: "manual", label: "s" },
    });
    const sourceId = alpha.sourceId;
    assert.equal(beta.sourceId, sourceId);

    kb.evict([{ kind: "alpha", id: alpha.ids[0]! }]);
    const afterEvict = db
      .prepare("SELECT chunk_count FROM sources WHERE id = ?")
      .get(sourceId) as { chunk_count: number };
    // 只算本表会把 default 表的行误判为孤儿并删掉来源（D40 回归）。
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

test("扩展 = 加表：既有库打开后注册新分类即可写入，旧数据与版本不动", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-kinds-"));
  const path = join(dir, "session.db");
  try {
    const first = await openTierDatabase(path, "session");
    const before = new KnowledgeService(first);
    before.put({ project: "p", content: "存量兜底内容" });
    first.close();

    const second = await openTierDatabase(path, "session");
    const registry = new KindRegistry();
    registry.register(fallbackSpec(registry.fallbackKind));
    registry.register({ kind: "late_kind" });
    const kb = new KnowledgeService(second, { registry });
    const result = kb.put({
      project: "p",
      content: "后注册分类的内容",
      kind: "late_kind",
    });
    assert.equal(result.created, 1);
    // 存量数据照常可检索，分类标签正确。
    const old = kb.search({ query: "存量兜底内容" });
    assert.equal(old.length, 1);
    assert.equal(old[0]?.kind, "default");
    assert.equal(
      (second.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      1,
    );
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("调用方对拒写结果的处理：writeBack 不计数、memory.add 抛错、hooks 计 skipped", async () => {
  // 没有兜底分类的注册表：未认领事件一律拒写（skipped=kind）。
  const db = await openTierDatabase(":memory:", "session");
  try {
    const registry = new KindRegistry();
    registry.register({ kind: "alpha" });
    const kb = new KnowledgeService(db, { registry });

    const policy = new WritePolicy(kb);
    const writeBack = await policy.writeBack([
      { project: "p", content: "writeback 内容", kind: "alpha" },
      { project: "p", content: "writeback 被拒", kind: "unknown" },
    ]);
    assert.equal(writeBack.written, 1);
    assert.equal(writeBack.remaining, 0);

    // memory 域固定落兜底分类（本服务自带缺省注册表）；触发它的隐私闸 → 拒写必须显式失败。
    const memory = new MemoryService(db);
    assert.throws(
      () =>
        memory.add({ target: "user", content: "password: supersecretvalue" }),
      /被拒绝/,
    );

    const hooks = new SessionHooks(kb, { project: "p" });
    // feedback/record 会被 summarize 成摘要，但没有任何分类认领该事件类型 → 分类闸门拒写。
    const outcome = hooks.handle("s1", {
      type: "feedback/record",
      data: { text: "未认领事件内容" },
    });
    assert.equal(outcome.accepted, false);
    assert.equal(hooks.stats.skipped.kind, 1);
  } finally {
    db.close();
  }
});

test("注册表约束：同名 / 同表重复注册抛错；未注册分类检索为空", async () => {
  const registry = new KindRegistry();
  registry.register({ kind: "alpha" });
  assert.throws(() => registry.register({ kind: "alpha" }), /已注册/);
  assert.throws(
    () => registry.register({ kind: "beta", table: "kind_alpha" }),
    /已属于/,
  );
  assert.throws(
    () => registry.register({ kind: "beta", table: "sources" }),
    /不合法/,
  );

  const db = await openTierDatabase(":memory:", "session");
  try {
    const kb = new KnowledgeService(db, { registry });
    assert.deepEqual(kb.search({ query: "任意", kind: "nope" }), []);
  } finally {
    db.close();
  }
});

test("代码里不出现具体分类名（D43，grep 断言）", () => {
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
