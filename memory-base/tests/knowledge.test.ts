/**
 * ctx_knowledge 四接口测试：search/put/touch/evict。
 * 验收覆盖：检索命中更新 last_referenced；去重；分块；过滤；source 联动清理。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";

async function makeService() {
  const db = await openKnowledgeDatabase(":memory:");
  return { db, kb: new KnowledgeService(db) };
}

test("put + search：porter 词干命中，返回元数据", async () => {
  const { db, kb } = await makeService();
  try {
    kb.put({
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
    assert.equal(typeof hits[0]?.score, "number");
  } finally {
    db.close();
  }
});

test("search 命中即更新 last_referenced（提升规则）", async () => {
  const { db, kb } = await makeService();
  try {
    const { ids } = kb.put({ project: "p1", content: "alpha beta gamma" });
    const before = (
      db
        .prepare("SELECT last_referenced FROM chunks WHERE id = ?")
        .get(ids[0]!) as { last_referenced: number }
    ).last_referenced;
    await new Promise((resolve) => setTimeout(resolve, 5));
    kb.search({ query: "alpha" });
    const after = (
      db
        .prepare("SELECT last_referenced FROM chunks WHERE id = ?")
        .get(ids[0]!) as { last_referenced: number }
    ).last_referenced;
    assert.ok(after > before, "检索命中后 last_referenced 应增大");
  } finally {
    db.close();
  }
});

test("put 去重：相同 content_hash 不重复写", async () => {
  const { db, kb } = await makeService();
  try {
    const first = kb.put({ project: "p1", content: "same content text" });
    const second = kb.put({ project: "p2", content: "same content text" });
    assert.deepEqual(second.ids, first.ids, "相同内容命中既有 chunk，不新增");
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    assert.equal(count, 1);
  } finally {
    db.close();
  }
});

test("touch：手动刷新 last_referenced", async () => {
  const { db, kb } = await makeService();
  try {
    const { ids } = kb.put({ project: "p1", content: "touch me now" });
    const before = (
      db
        .prepare("SELECT last_referenced FROM chunks WHERE id = ?")
        .get(ids[0]!) as { last_referenced: number }
    ).last_referenced;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(kb.touch(ids[0]!));
    const after = (
      db
        .prepare("SELECT last_referenced FROM chunks WHERE id = ?")
        .get(ids[0]!) as { last_referenced: number }
    ).last_referenced;
    assert.ok(after > before);
    assert.ok(!kb.touch(99999), "不存在的 id 返回 false");
  } finally {
    db.close();
  }
});

test("evict：删除 chunk 并联动清理 source", async () => {
  const { db, kb } = await makeService();
  try {
    const a = kb.put({ project: "p1", content: "evict me alpha" });
    const b = kb.put({ project: "p1", content: "evict me beta" });
    assert.equal(kb.evict(a.ids), 1);
    let sources = (
      db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }
    ).n;
    assert.equal(sources, 1, "删除一个 chunk 后 source 仍保留");
    assert.ok(kb.search({ query: "alpha" }).length === 0);
    assert.ok(kb.search({ query: "beta" }).length === 1);
    kb.evict(b.ids);
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
    const { created } = kb.put({ project: "p1", content: big });
    assert.ok(created > 1, "大内容应拆成多块");
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    assert.ok(count > 1);
    // 拆出的每块都能被检索命中。
    assert.ok(kb.search({ query: "word" }).length > 0);
    assert.ok(kb.search({ query: "second" }).length > 0);
  } finally {
    db.close();
  }
});

test("search 过滤：project/target/category", async () => {
  const { db, kb } = await makeService();
  try {
    kb.put({
      project: "p1",
      target: "t1",
      category: "c1",
      content: "alpha unique one",
    });
    kb.put({
      project: "p1",
      target: "t2",
      category: "c1",
      content: "beta unique two",
    });
    kb.put({
      project: "p2",
      target: "t1",
      category: "c2",
      content: "gamma unique three",
    });
    kb.put({
      project: "p2",
      target: "t2",
      category: "c2",
      content: "delta unique four",
    });
    assert.equal(kb.search({ query: "unique" }).length, 4);
    assert.equal(
      kb.search({ query: "unique", project: "p1", target: "t1" }).length,
      1,
    );
    assert.equal(kb.search({ query: "unique", category: "c2" }).length, 2);
    assert.equal(
      kb.search({ query: "unique", project: "p2", category: "c2" }).length,
      2,
    );
    assert.equal(
      kb.search({ query: "unique", project: "p1", category: "c2" }).length,
      0,
    );
  } finally {
    db.close();
  }
});

test("search fuzzy：trigram 子串召回", async () => {
  const { db, kb } = await makeService();
  try {
    kb.put({ project: "p1", content: "the quick brown fox jumps" });
    // 'bro' 为 3 字符子串，porter 不命中，trigram 命中。
    assert.equal(kb.search({ query: "bro", fuzzy: false }).length, 0);
    assert.equal(kb.search({ query: "bro", fuzzy: true }).length, 1);
  } finally {
    db.close();
  }
});
