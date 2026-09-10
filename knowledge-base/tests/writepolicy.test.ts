/**
 * #9 写回/淘汰/提升测试：writeBack、backfill、ConsolidationLock、staleCandidates、
 * compress、promote、evictStale、tokenBudgetUsage。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openKnowledgeDatabase } from "../src/schema.ts";
import {
  KnowledgeService,
  type PutInput,
  type PutResult,
} from "../src/knowledge.ts";
import { ConsolidationLock, WritePolicy } from "../src/writepolicy.ts";

async function makeHarness() {
  const db = await openKnowledgeDatabase(":memory:");
  const kb = new KnowledgeService(db);
  return { db, kb, policy: new WritePolicy(kb) };
}

/** 直接把某 chunk 的 last_referenced 改旧，滚动替代 touch。 */
function backdate(
  db: Awaited<ReturnType<typeof openKnowledgeDatabase>>,
  id: number,
  msAgo: number,
): void {
  db.prepare("UPDATE chunks SET last_referenced = ? WHERE id = ?").run(
    Date.now() - msAgo,
    id,
  );
}

test("writeBack：正常全部写入", async () => {
  const { db, policy } = await makeHarness();
  try {
    const result = await policy.writeBack([
      { project: "p1", content: "a" },
      { project: "p1", content: "b" },
    ]);
    assert.deepEqual(result, { written: 2, remaining: 0 });
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    assert.equal(count, 2);
  } finally {
    db.close();
  }
});

test("writeBack + backfill：失败项入 pending，恢复后重试清空", async () => {
  const { db, kb, policy } = await makeHarness();
  try {
    const originalPut = kb.put;
    let failContent = "boom";
    (
      kb as unknown as {
        put: (this: KnowledgeService, input: PutInput) => PutResult;
      }
    ).put = function (input) {
      if (input.content === failContent) throw new Error("模拟写入失败");
      return originalPut.call(this, input);
    };
    const result = await policy.writeBack([
      { project: "p1", content: "ok" },
      { project: "p1", content: "boom" },
    ]);
    assert.deepEqual(result, { written: 1, remaining: 1 });
    // 修复写路径后 backfill 兜底成功。
    failContent = "__never__";
    const retry = await policy.backfill();
    assert.deepEqual(retry, { written: 1, remaining: 0 });
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    assert.equal(count, 2);
  } finally {
    db.close();
  }
});

test("ConsolidationLock：同 key 串行化", async () => {
  const lock = new ConsolidationLock();
  const order: string[] = [];
  const run = async (name: string) =>
    lock.withLock("k", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(name);
    });
  await Promise.all([run("a"), run("b"), run("c")]);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("staleCandidates：LRU+importance 阈值过滤", async () => {
  const { db, kb } = await makeHarness();
  try {
    const old = kb.put({ project: "p1", content: "old low", importance: 1 })
      .ids[0]!;
    backdate(db, old, 100 * 24 * 3600 * 1000); // 100 天前
    const oldHi = kb.put({ project: "p1", content: "old high", importance: 4 })
      .ids[0]!;
    backdate(db, oldHi, 100 * 24 * 3600 * 1000);
    kb.put({
      project: "p1",
      content: "fresh low",
      importance: 1,
    });
    // fresh 保持 last_referenced=now
    const ids = kb.staleCandidates({
      project: "p1",
      ttlMs: 90 * 24 * 3600 * 1000,
    });
    assert.deepEqual(
      ids,
      [old],
      "仅 100 天前 + importance≤2 命中；high importance 与 fresh 排除",
    );
  } finally {
    db.close();
  }
});

test("compress：内容降为单行摘要且 summary 填充", async () => {
  const { db, kb } = await makeHarness();
  try {
    const { ids } = kb.put({
      project: "p1",
      content: "第一行很长的摘要内容\n第二行细节\n第三行",
    });
    assert.equal(kb.compress(ids), 1);
    const row = db
      .prepare("SELECT content, summary FROM chunks WHERE id = ?")
      .get(ids[0]!) as {
      content: string;
      summary: string;
    };
    assert.equal(row.content, "第一行很长的摘要内容");
    assert.equal(row.summary, "第一行很长的摘要内容");
  } finally {
    db.close();
  }
});

test("promote：resume top-K 按近期引用 × importance 排序", async () => {
  const { db, kb } = await makeHarness();
  try {
    const a = kb.put({ project: "p1", content: "alpha", importance: 3 })
      .ids[0]!;
    const b = kb.put({ project: "p1", content: "beta", importance: 5 }).ids[0]!;
    backdate(db, a, 200 * 24 * 3600 * 1000); // a 很久未引用
    const top = kb.promote({ project: "p1", now: Date.now() });
    assert.ok(top.length > 0);
    assert.equal(top[0]?.id, b, "importance 高且近期引用的排前");
    assert.equal(kb.search({ query: "alpha" }).length, 1);
  } finally {
    db.close();
  }
});

test("evictStale：先压缩降级再硬淘汰，source 联动清理", async () => {
  const { db, kb, policy } = await makeHarness();
  try {
    const old = kb.put({ project: "p1", content: "evict-stale", importance: 1 })
      .ids[0]!;
    backdate(db, old, 100 * 24 * 3600 * 1000);
    const result = await policy.evictStale({
      project: "p1",
      ttlMs: 90 * 24 * 3600 * 1000,
    });
    assert.equal(result.compressed, 1);
    assert.equal(result.evicted, 1);
    const chunks = (
      db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }
    ).n;
    const sources = (
      db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }
    ).n;
    assert.equal(chunks, 0);
    assert.equal(sources, 0, "chunk_count 归零的 source 被清理");
  } finally {
    db.close();
  }
});

test("tokenBudgetUsage：project 级体积估算 > 0", async () => {
  const { db, kb } = await makeHarness();
  try {
    kb.put({ project: "p1", content: "word ".repeat(300) });
    assert.ok(kb.tokenBudgetUsage("p1") > 300);
    assert.equal(kb.tokenBudgetUsage("nope"), 0);
  } finally {
    db.close();
  }
});
