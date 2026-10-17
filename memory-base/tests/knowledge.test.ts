/**
 * 存储层读写测试：put / search / listRows / evict。
 * 覆盖：porter 词干命中、去重、分块、项目过滤与 fuzzy 召回、按 kind 列举与分页、source 联动清理。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import { KindRegistry } from "../src/router.ts";

/** 内存库 + 注册一个 `note` 分类。 */
async function makeService(): Promise<{
  db: Awaited<ReturnType<typeof openKnowledgeDatabase>>;
  kb: KnowledgeService;
  registry: KindRegistry;
}> {
  const db = await openKnowledgeDatabase(":memory:");
  const registry = new KindRegistry();
  registry.register({ kind: "note" });
  return { db, kb: new KnowledgeService(db, { registry }), registry };
}

test("put + search：porter 词干命中，返回元数据", async () => {
  const { db, kb } = await makeService();
  try {
    await kb.put({
      kind: "note",
      project: "p1",
      title: "hello world",
      content: "foo bar baz",
      source: { kind: "session", label: "s1" },
    });
    const hits = kb.search({ query: "world", project: "p1" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.title, "hello world");
    assert.equal(hits[0]?.content, "foo bar baz");
    assert.equal(hits[0]?.project, "p1");
    assert.equal(hits[0]?.kind, "note");
    assert.equal(hits[0]?.tier, "session");
    assert.equal(typeof hits[0]?.score, "number");
  } finally {
    db.close();
  }
});

test("search 是只读：命中后不写任何列（last_referenced 已下线）", async () => {
  const { db, kb } = await makeService();
  try {
    await kb.put({ kind: "note", project: "p1", content: "alpha beta gamma" });
    const before = db.prepare("SELECT * FROM kind_note").all() as Array<
      Record<string, unknown>
    >;
    kb.search({ query: "alpha" });
    const after = db.prepare("SELECT * FROM kind_note").all() as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(after, before);
  } finally {
    db.close();
  }
});

test("put 去重：相同 content_hash 不重复写", async () => {
  const { db, kb } = await makeService();
  try {
    const first = await kb.put({
      kind: "note",
      project: "p1",
      content: "same content text",
    });
    const second = await kb.put({
      kind: "note",
      project: "p2",
      content: "same content text",
    });
    assert.deepEqual(second.ids, first.ids, "相同内容命中既有行，不新增");
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM kind_note").get() as { n: number }
    ).n;
    assert.equal(count, 1);
  } finally {
    db.close();
  }
});

test("未注册 kind 拒写（skipped=kind），不落库", async () => {
  const { db, kb } = await makeService();
  try {
    const result = await kb.put({
      kind: "nope",
      project: "p",
      content: "未注册分类内容",
    });
    assert.deepEqual(result.ids, []);
    assert.equal(result.skipped, "kind");
    assert.equal(kb.countAll(), 0);
  } finally {
    db.close();
  }
});

test("隐私闸：凭据形态整条拒写（skipped=pattern）", async () => {
  const { db, kb } = await makeService();
  try {
    const result = await kb.put({
      kind: "note",
      project: "p",
      content: "password: supersecretvalue",
    });
    assert.deepEqual(result.ids, []);
    assert.equal(result.skipped, "pattern");
  } finally {
    db.close();
  }
});

test("evict：删除行并联动清理 source", async () => {
  const { db, kb } = await makeService();
  try {
    const a = await kb.put({
      kind: "note",
      project: "p1",
      content: "evict me alpha",
    });
    const b = await kb.put({
      kind: "note",
      project: "p1",
      content: "evict me beta",
    });
    assert.equal(kb.evict([{ kind: "note", id: a.ids[0]! }]), 1);
    let sources = (
      db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }
    ).n;
    assert.equal(sources, 1, "删除一行后 source 仍保留");
    assert.equal(kb.search({ query: "alpha" }).length, 0);
    assert.equal(kb.search({ query: "beta" }).length, 1);
    kb.evict(a.ids.map((id) => ({ kind: "note", id })));
    kb.evict(b.ids.map((id) => ({ kind: "note", id })));
    sources = (
      db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }
    ).n;
    assert.equal(sources, 0, "chunk_count 归零的 source 被清理");
  } finally {
    db.close();
  }
});

test("put 分块：超预算内容按 markdown 边界切多块", async () => {
  const { db, kb } = await makeService();
  try {
    // ~6000 字符 = ~2000 token 预算，单段落超限触发拆块。
    const para = "word ".repeat(800); // 4000 字符
    const big = `${para}\n\n${"second ".repeat(800)}`;
    const { created } = await kb.put({
      kind: "note",
      project: "p1",
      content: big,
    });
    assert.ok(created > 1, "大内容应拆成多块");
    assert.ok(kb.search({ query: "word" }).length > 0);
    assert.ok(kb.search({ query: "second" }).length > 0);
  } finally {
    db.close();
  }
});

test("search 过滤：project / kind", async () => {
  const { db, kb, registry } = await makeService();
  try {
    registry.register({ kind: "other" });
    const kb2 = new KnowledgeService(db, { registry });
    await kb2.put({ kind: "note", project: "p1", content: "alpha unique one" });
    await kb2.put({ kind: "note", project: "p2", content: "beta unique two" });
    await kb2.put({
      kind: "other",
      project: "p1",
      content: "gamma unique three",
    });
    assert.equal(kb2.search({ query: "unique" }).length, 3);
    assert.equal(kb2.search({ query: "unique", project: "p1" }).length, 2);
    assert.equal(kb2.search({ query: "unique", kind: "note" }).length, 2);
    assert.equal(
      kb2.search({ query: "unique", kind: "note", project: "p2" }).length,
      1,
    );
    assert.equal(kb2.search({ query: "unique", kind: "nope" }).length, 0);
  } finally {
    db.close();
  }
});

test("search fuzzy：trigram 子串召回", async () => {
  const { db, kb } = await makeService();
  try {
    await kb.put({
      kind: "note",
      project: "p1",
      content: "the quick brown fox jumps",
    });
    // 'bro' 为 3 字符子串，porter 不命中，trigram 命中。
    assert.equal(kb.search({ query: "bro", fuzzy: false }).length, 0);
    assert.equal(kb.search({ query: "bro", fuzzy: true }).length, 1);
  } finally {
    db.close();
  }
});

test("search CJK 兜底：两字查询经 LIKE 召回", async () => {
  const { db, kb } = await makeService();
  try {
    await kb.put({ kind: "note", project: "p1", content: "构建通过并提交" });
    assert.equal(kb.search({ query: "构建" }).length, 1);
  } finally {
    db.close();
  }
});

test("listRows：按 kind 列举（created_at 倒序）+ 项目过滤 + 分页", async () => {
  const { db, kb } = await makeService();
  try {
    const first = await kb.put({
      kind: "note",
      project: "p1",
      content: "第一条",
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = await kb.put({
      kind: "note",
      project: "p1",
      content: "第二条",
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const third = await kb.put({
      kind: "note",
      project: "p2",
      content: "第三条",
    });

    const all = kb.listRows({ kind: "note" });
    assert.deepEqual(
      all.map((row) => row.content),
      ["第三条", "第二条", "第一条"],
      "缺省按 created_at 倒序",
    );
    const p1 = kb.listRows({ kind: "note", project: "p1" });
    assert.deepEqual(
      p1.map((row) => row.id),
      [second.ids[0], first.ids[0]],
    );
    const page = kb.listRows({ kind: "note", limit: 1, offset: 2 });
    assert.deepEqual(
      page.map((row) => row.id),
      [first.ids[0]],
    );
    assert.equal(kb.listRows({ kind: "note", limit: 1 })[0]?.id, third.ids[0]);
    assert.deepEqual(kb.listRows({ kind: "nope" }), [], "未注册 kind 列举为空");
  } finally {
    db.close();
  }
});

test("kinds / tableFor：只报已注册分类与物理表名", async () => {
  const { db, kb, registry } = await makeService();
  try {
    registry.register({ kind: "other", table: "kind_other_custom" });
    assert.deepEqual(kb.kinds(), ["note", "other"]);
    assert.equal(kb.tableFor("note"), "kind_note");
    assert.equal(kb.tableFor("other"), "kind_other_custom");
    assert.equal(kb.tableFor("nope"), undefined);
  } finally {
    db.close();
  }
});
