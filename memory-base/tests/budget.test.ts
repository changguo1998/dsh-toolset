/**
 * 容量守卫测试（BACKLOG「会话事件自动入知识库」的「容量边界」）：
 * 未超限恒等返回；超限先压缩降级，仍超预算再按「低重要度 → 最旧」硬淘汰。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import { enforceBudget } from "../src/budget.ts";

type Db = Awaited<ReturnType<typeof openKnowledgeDatabase>>;

async function makeKb(): Promise<{ kb: KnowledgeService; db: Db }> {
  const db = await openKnowledgeDatabase(":memory:");
  return { kb: new KnowledgeService(db), db };
}

const LONG = "这是一条用于占位的长内容，".repeat(30); // ≈ 450 字符 ≈ 150 token

const chunkCount = (db: Db): number =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!["n"]);

test("未超预算：恒等返回，不动库", async () => {
  const { kb, db } = await makeKb();
  kb.put({ project: "p", content: LONG });
  const before = kb.tokenBudgetUsage("p");
  const result = enforceBudget(kb, { project: "p", maxTokens: before + 100 });
  assert.equal(result.compressed, 0);
  assert.equal(result.evicted, 0);
  assert.equal(result.tokensBefore, before);
  assert.equal(result.tokensAfter, before);
  assert.equal(chunkCount(db), 1);
  db.close();
});

test("超预算：先压缩降级（保留条目）", async () => {
  const { kb, db } = await makeKb();
  kb.put({ project: "p", content: LONG, importance: 2 });
  const before = kb.tokenBudgetUsage("p");
  // 压缩后正文降为 ≤300 字符（≈100 token），取 120 让「压缩一轮即回落」
  const result = enforceBudget(kb, { project: "p", maxTokens: 120 });
  assert.ok(before > 120, `样本需先超预算（实际 ${before}）`);
  assert.ok(result.compressed >= 1, "应发生压缩");
  assert.equal(result.evicted, 0, "压缩后已回落，不必淘汰");
  assert.ok(result.tokensAfter <= 120, `回落失败：${result.tokensAfter}`);
  assert.equal(chunkCount(db), 1, "压缩不删条目");
  db.close();
});

test("压缩后仍超预算：按低重要度 → 最旧淘汰，高重要度留到最后", async () => {
  const { kb, db } = await makeKb();
  const low1 = kb.put({ project: "p", content: `${LONG} 甲`, importance: 1 })
    .ids[0]!;
  const low2 = kb.put({ project: "p", content: `${LONG} 乙`, importance: 1 })
    .ids[0]!;
  const high = kb.put({
    project: "p",
    content: `${LONG} 丙`,
    importance: 5,
  }).ids[0]!;
  // 让 low1 成为「最旧」（未引用过的按创建时间排序）
  db.prepare(
    "UPDATE chunks SET last_referenced = ?, created_at = ? WHERE id = ?",
  ).run(1, 1, low1);
  const result = enforceBudget(kb, {
    project: "p",
    maxTokens: 1,
    compressFirst: false,
    batch: 2,
  });
  assert.equal(result.evicted, 2, "应淘汰两条低重要度");
  const left = db.prepare("SELECT id FROM chunks").all() as Array<{
    id: number;
  }>;
  assert.deepEqual(
    left.map((row) => Number(row.id)),
    [high],
    "高重要度条目保留",
  );
  assert.ok(low2 > 0);
  db.close();
});
