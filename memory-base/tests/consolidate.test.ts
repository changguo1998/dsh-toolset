/**
 * 记忆 auto-consolidation 测试（BACKLOG「记忆 auto-consolidation」）：
 * `plan()` 零副作用、三段策略（提升 / 合并 / 淘汰）、自动触发与节流。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import { MemoryService } from "../src/memory.ts";
import { ConsolidationService } from "../src/consolidate.ts";
import { createKnowledgeBundle, type BundleHost } from "../src/index.ts";

const DAY = 24 * 60 * 60 * 1000;

type Db = Awaited<ReturnType<typeof openKnowledgeDatabase>>;

async function setup(): Promise<{
  db: Db;
  kb: KnowledgeService;
  memory: MemoryService;
  consolidate: ConsolidationService;
}> {
  const db = await openKnowledgeDatabase(":memory:");
  const kb = new KnowledgeService(db);
  const memory = new MemoryService(db);
  const consolidate = new ConsolidationService(kb);
  return { db, kb, memory, consolidate };
}

/** mock 宿主：可 on/emit/dispose，记录 logger 输出。 */
function makeHost(): {
  host: BundleHost;
  logs: string[];
  emit: (type: string) => void;
} {
  const handlers: Array<
    (session: { id: string }, event: { type: string }) => void
  > = [];
  const logs: string[] = [];
  const host: BundleHost = {
    on: (_event, callback) => {
      handlers.push(callback);
      return () => {
        const index = handlers.indexOf(callback);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    logger: () => ({ info: (message: string) => logs.push(message) }),
  };
  return {
    host,
    logs,
    emit: (type: string) => {
      for (const handler of [...handlers]) handler({ id: "s1" }, { type });
    },
  };
}

test("plan() 只读预演：报告有候选但库不变", async () => {
  const { db, kb, memory, consolidate } = await setup();
  const kept = memory.add({
    target: "project",
    project: "p",
    content: "提交前先跑 npm run check 做类型检查",
    importance: 4,
  });
  memory.add({
    target: "project",
    project: "p",
    content: "提交前先跑 npm run check 做类型",
    importance: 2,
  });
  const before = db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!["n"];
  const report = consolidate.plan({ project: "p" });
  assert.equal(report.dryRun, true);
  assert.equal(report.merged.length, 1, "应识别出一组重复");
  assert.equal(report.merged[0]!.kept, kept.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!["n"],
    before,
  );
  assert.equal(consolidate.last, undefined, "plan() 不记最近报告");
  db.close();
});

test("run() 提升：被检索命中过的条目 importance +1（clamp 5）", async () => {
  const { db, kb, consolidate } = await setup();
  const hit = kb.put({
    project: "p",
    content: "被引用过的条目",
    importance: 3,
  });
  const idle = kb.put({
    project: "p",
    content: "从未被引用的条目",
    importance: 3,
  });
  // 模拟「被 search 命中过」：last_referenced 晚于 created_at
  db.prepare(
    "UPDATE chunks SET last_referenced = created_at + 1000 WHERE id = ?",
  ).run(hit.ids[0]!);
  const report = consolidate.run({
    project: "p",
    merge: false,
    evict: false,
  });
  assert.deepEqual(report.promoted, [{ id: hit.ids[0]!, from: 3, to: 4 }]);
  const rows = db
    .prepare("SELECT id, importance FROM chunks ORDER BY id")
    .all() as Array<{ id: number; importance: number }>;
  assert.equal(Number(rows[0]!.importance), 4, "命中的条目已提权");
  assert.equal(Number(rows[1]!.importance), 3, "未命中的条目不动");
  assert.equal(consolidate.last, report, "run() 记最近报告");
  assert.equal(kb.tokenBudgetUsage("p") >= 0, true);
  assert.ok(idle.ids.length === 1);
  db.close();
});

test("run() 合并：同 target 近似重复保留高重要度，删重复项", async () => {
  const { db, memory, consolidate } = await setup();
  const kept = memory.add({
    target: "memory",
    project: "p",
    content: "规则：提交前先跑 npm run check 做类型检查",
    importance: 5,
  });
  const dropped = memory.add({
    target: "memory",
    project: "p",
    content: "规则：提交前先跑 npm run check 做类型",
    importance: 2,
  });
  const report = consolidate.run({
    project: "p",
    promote: false,
    evict: false,
  });
  assert.equal(report.merged.length, 1);
  assert.equal(report.merged[0]!.kept, kept.id);
  assert.deepEqual(report.merged[0]!.dropped, [dropped.id]);
  assert.equal(report.merged[0]!.target, "memory");
  const left = db.prepare("SELECT id FROM chunks").all() as Array<{
    id: number;
  }>;
  assert.deepEqual(
    left.map((row) => Number(row.id)),
    [kept.id],
  );
  db.close();
});

test("run() 淘汰陈旧：TTL 外的低重要度条目先压缩再删除", async () => {
  const { db, kb, consolidate } = await setup();
  const stale = kb.put({
    project: "p",
    content: "很久以前的低价值记录",
    importance: 1,
  });
  const old = Date.now() - 40 * DAY;
  db.prepare(
    "UPDATE chunks SET created_at = ?, last_referenced = ? WHERE id = ?",
  ).run(old, old, stale.ids[0]!);
  const report = consolidate.run({
    project: "p",
    promote: false,
    merge: false,
    ttlMs: 30 * DAY,
  });
  assert.equal(report.evicted, 1);
  assert.equal(report.compressed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!["n"], 0);
  db.close();
});

test("自动巩固：启动后一次 + compaction 后触发，受 minIntervalMs 节流", async () => {
  const { host, logs, emit } = makeHost();
  const bundle = await createKnowledgeBundle(host, {
    dbPath: ":memory:",
    project: "p",
    autoConsolidate: { minIntervalMs: 0 },
  });
  const started = bundle.consolidate.last;
  assert.ok(started !== undefined, "启动后应跑一次");
  emit("compaction/end");
  const afterCompaction = bundle.consolidate.last;
  assert.ok(afterCompaction !== undefined);
  assert.ok(afterCompaction.at >= started.at);
  assert.ok(
    logs.some((line) => line.includes("自动巩固")),
    "应记录巩固日志",
  );
  bundle.dispose();

  // 节流：窗口内再次触发不覆盖最近报告
  const throttled = makeHost();
  const bundle2 = await createKnowledgeBundle(throttled.host, {
    dbPath: ":memory:",
    project: "p",
    autoConsolidate: { minIntervalMs: 60_000 },
  });
  const first = bundle2.consolidate.last;
  throttled.emit("compaction/end");
  assert.equal(bundle2.consolidate.last, first, "节流窗口内跳过");
  bundle2.dispose();

  // 关闭总开关：连启动那次也不跑
  const off = makeHost();
  const bundle3 = await createKnowledgeBundle(off.host, {
    dbPath: ":memory:",
    autoConsolidate: { enabled: false },
  });
  assert.equal(bundle3.consolidate.last, undefined);
  bundle3.dispose();
});
