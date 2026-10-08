/**
 * 写直达接入的规则 / 容量集成测试（BACKLOG「会话事件自动入知识库」）：
 * 规则闸门与计数、隐私边界不入库、容量守卫在写入路径生效、去重计数、persistTypes 兼容。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openKnowledgeDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";
import {
  SessionHooks,
  type HookHost,
  type SessionEventLike,
} from "../src/hooks.ts";

type Db = Awaited<ReturnType<typeof openKnowledgeDatabase>>;

async function setup(options?: {
  minChars?: number;
  maxTokens?: number;
  persistTypes?: ReadonlySet<string> | null;
}): Promise<{ db: Db; kb: KnowledgeService; hooks: SessionHooks }> {
  const db = await openKnowledgeDatabase(":memory:");
  const kb = new KnowledgeService(db);
  const hooks = new SessionHooks(kb, {
    project: "p",
    ...(options?.persistTypes === undefined
      ? {}
      : { persistTypes: options.persistTypes }),
    ...(options?.minChars === undefined
      ? {}
      : { rules: { minChars: options.minChars } }),
    ...(options?.maxTokens === undefined
      ? {}
      : { budget: { maxTokens: options.maxTokens } }),
  });
  const host: HookHost = { on: () => () => {} };
  hooks.attach(host);
  return { db, kb, hooks };
}

const toolResult = (text: string): SessionEventLike => ({
  type: "tool/result",
  data: { message: { content: text } },
});

const count = (db: Db): number =>
  Number(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()!["n"]);

test("规则闸门：过短内容跳过并计数，正常内容入库", async () => {
  const { db, hooks } = await setup({ minChars: 10 });
  assert.deepEqual(hooks.handle("s1", toolResult("太短")), {
    accepted: false,
    reason: "short",
  });
  assert.equal(
    hooks.handle("s1", toolResult("这条内容足够长，会被沉淀")).accepted,
    true,
  );
  assert.equal(count(db), 1);
  assert.equal(hooks.stats.skipped.short, 1);
  assert.equal(hooks.stats.accepted, 1);
  db.close();
});

test("隐私边界：内置模式命中即整条不入库", async () => {
  const { db, hooks } = await setup();
  const outcome = hooks.handle(
    "s1",
    toolResult(
      "导出环境变量：OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123",
    ),
  );
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, "pattern");
  assert.equal(count(db), 0, "敏感内容不落库");
  assert.equal(hooks.stats.skipped.pattern, 1);
  db.close();
});

test("类型闸门沿用 persistTypes（兼容路径）+ 非白名单计数", async () => {
  const { db, hooks } = await setup({
    persistTypes: new Set(["feedback/record"]),
  });
  const skipped = hooks.handle(
    "s1",
    toolResult("这是一条足够长的工具输出内容"),
  );
  assert.equal(skipped.reason, "type");
  const accepted = hooks.handle("s1", {
    type: "feedback/record",
    data: { content: "用户修正：提交前必须跑类型检查" },
  });
  assert.equal(accepted.accepted, true);
  assert.equal(hooks.stats.skipped.type, 1);
  db.close();
});

test("去重：同内容第二次计入 deduped，不重复建条", async () => {
  const { db, hooks } = await setup();
  assert.equal(
    hooks.handle("s1", toolResult("同一条内容被重复上报")).accepted,
    true,
  );
  const again = hooks.handle("s1", toolResult("同一条内容被重复上报"));
  assert.equal(again.accepted, false);
  assert.equal(again.deduped, true);
  assert.equal(again.created, 0);
  assert.equal(count(db), 1);
  assert.equal(hooks.stats.deduped, 1);
  db.close();
});

test("容量守卫：写入路径超预算即压缩 / 淘汰，计数入 stats", async () => {
  const { db, hooks } = await setup({ maxTokens: 20 });
  const outcome = hooks.handle("s1", toolResult("占位内容".repeat(300)));
  assert.equal(outcome.accepted, true);
  assert.ok(outcome.budget !== undefined, "应返回容量守卫结果");
  assert.ok(
    outcome.budget.compressed + outcome.budget.evicted > 0,
    "超预算必须降级或淘汰",
  );
  assert.ok(hooks.stats.compressed + hooks.stats.evicted > 0, "stats 同步计数");
  db.close();
});

test("resetStats：计数清零（规则与预算配置不变）", async () => {
  const { db, hooks } = await setup({ minChars: 100 });
  hooks.handle("s1", toolResult("短"));
  assert.equal(hooks.stats.skipped.short, 1);
  hooks.resetStats();
  assert.equal(hooks.stats.skipped.short, 0);
  hooks.handle("s1", toolResult("仍然很短"));
  assert.equal(hooks.stats.skipped.short, 1);
  db.close();
});
