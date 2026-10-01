/**
 * 插件入口单测：apply 接线（消费者注册 / provide 服务 / 生命周期注销）、
 * decide 链路（审查 → notice 事件 + 反馈内容）与缺面降级。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { apply } from "../src/main.ts";

/** 消费者注册记录。 */
interface ConsumerRecord {
  id: string;
  sources?: readonly string[];
  dedupeInRecord?: number;
  decide(context: {
    sessionId: string;
    turn: number;
    text: string;
    trigger: string;
  }): { text: string; summary?: string; reset?: boolean } | null;
}

/** 假 ctx：记录注册的消费者、provide 的服务与 effect 清理函数。 */
function fakeCtx(
  options: {
    noRuleEngine?: boolean;
  } = {},
): {
  consumers: ConsumerRecord[];
  disposed: () => number;
  provided: Map<string, unknown>;
  effects: Array<() => unknown>;
  ctx: Record<string, unknown>;
} {
  const consumers: ConsumerRecord[] = [];
  let disposeCount = 0;
  const provided = new Map<string, unknown>();
  const effects: Array<() => unknown> = [];
  const ctx: Record<string, unknown> = {
    provide: (name: string, value: unknown) => provided.set(name, value),
    effect: (fn: () => unknown) => effects.push(fn),
  };
  if (options.noRuleEngine !== true) {
    ctx["ruleEngine"] = {
      registerConsumer: (input: ConsumerRecord) => {
        consumers.push(input);
        return () => {
          disposeCount += 1;
        };
      },
    };
  }
  return { consumers, disposed: () => disposeCount, provided, effects, ctx };
}

test("apply：注册消费者 + provide 服务；decide 审查 → notice 事件 + 反馈内容", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx, { cooldownMs: 0, cooldownRuns: 0 });
  assert.equal(fake.consumers.length, 2, "审查消费者 + 开局指南消费者");
  assert.deepEqual(
    fake.consumers.map((c) => c.id),
    ["symbol-normalizer", "symbol-normalizer-guide"],
  );

  const service = fake.provided.get("symbolNormalizer") as {
    normalize(text: string): { text: string; unrecommended: string[] };
    onReview(listener: (event: unknown) => void): () => void;
    status(): { warnModel: boolean; recommended: number; sessions: number };
  };
  // 展示层归一
  assert.equal(service.normalize("完成 ✔").text, "完成 ✓");
  // 订阅审查事件
  const events: Array<{ sessionId: string; notice: string }> = [];
  const unsubscribe = service.onReview((event) =>
    events.push(event as { sessionId: string; notice: string }),
  );
  // 消费者决定：返回反馈内容，并推 notice
  const feedback = fake.consumers[0]?.decide({
    sessionId: "s1",
    turn: 1,
    text: "失败 ❌。",
    trigger: "turn-end",
  });
  if (feedback === null || feedback === undefined) {
    throw new Error("审查消费者应返回反馈");
  }
  assert.match(feedback.text, /\[符号规范\]/);
  assert.equal(feedback.summary, "符号规范提醒");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.sessionId, "s1");
  assert.match(events[0]?.notice ?? "", /符号已替换/);
  unsubscribe();
  // 生命周期：effect 注册的清理函数被调用时注销消费者
  assert.equal(typeof fake.effects[0], "function");
  const cleanup = fake.effects[0]?.();
  assert.equal(typeof cleanup, "function");
  (cleanup as () => void)();
  assert.equal(fake.disposed(), 2, "两个消费者（审查 + 指南）都要注销");
  assert.equal(service.status().warnModel, true);
  assert.equal(service.status().sessions, 1);
});

test("apply：默认冷却生效（同会话第二次 decide 返回 null）", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx);
  const decide = fake.consumers[0]?.decide;
  assert.ok(decide !== undefined);
  const context = {
    sessionId: "s1",
    turn: 1,
    text: "失败 ❌。",
    trigger: "turn-end",
  };
  assert.ok(decide(context) !== null);
  assert.equal(decide({ ...context, turn: 2 }), null, "默认冷却期内 → null");
});

test("apply：rule-engine 缺席时只告警不抛，展示服务仍可用", async () => {
  const fake = fakeCtx({ noRuleEngine: true });
  await apply(fake.ctx);
  assert.equal(fake.consumers.length, 0);
  const service = fake.provided.get("symbolNormalizer") as {
    normalize(text: string): { text: string };
  };
  assert.equal(service.normalize("失败 ❌").text, "失败 ✗");
});

test("apply：开局指南消费者按统一标准注册（sources + dedupeInRecord），decide 恒返回指南内容", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx, { cooldownMs: 0, cooldownRuns: 0 });
  const guide = fake.consumers.find((c) => c.id === "symbol-normalizer-guide");
  assert.ok(guide !== undefined);
  // 去重/补注入由 rule-engine 统一负责：投影里最多 1 条，被压缩挤出后由 compaction 节点补一次
  assert.deepEqual(guide.sources, ["turn-end", "compaction"]);
  assert.equal(guide.dedupeInRecord, 1);
  const context = { sessionId: "s1", turn: 1, text: "", trigger: "turn-end" };
  const content = guide.decide(context);
  assert.ok(content !== null);
  assert.match(content.text, /推荐符号白名单/);
  assert.equal(content.summary, "符号规范（会话开局指南）");
  assert.ok(
    guide.decide({ ...context, trigger: "compaction" }) !== null,
    "压缩节点同样返回内容（是否注入由 rule-engine 按投影判定）",
  );
});

test("apply：injectGuide=false 时不注册指南消费者", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx, { injectGuide: false });
  assert.deepEqual(
    fake.consumers.map((c) => c.id),
    ["symbol-normalizer"],
    "关闭后只剩审查消费者",
  );
});
