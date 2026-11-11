/**
 * 插件入口单测：apply 接线（消费者注册 / provide 服务 / 生命周期注销）、
 * decide 链路（审查 → notice 事件 + 反馈内容）与缺面降级。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { apply } from "../src/index.ts";

/** 消费者注册记录。 */
interface ConsumerRecord {
  id: string;
  sources?: readonly string[];
  delivery?: string;
  dedupeInRecord?: number;
  directWrite?: readonly string[];
  decide(context: {
    sessionId: string;
    turn: number;
    text: string;
    trigger: string;
  }): { text: string; summary?: string; reset?: boolean } | null;
}

/** 静态保持 section 的注册记录。 */
interface SectionRecord {
  name: string;
  order: number;
  text: string;
  interpolate?: boolean;
}

/** 假 ctx：记录注册的消费者、section、provide 的服务与 effect 清理函数。 */
function fakeCtx(
  options: {
    noRuleEngine?: boolean;
    noSystemPrompt?: boolean;
  } = {},
): {
  consumers: ConsumerRecord[];
  sections: SectionRecord[];
  sectionDisposed: () => number;
  disposed: () => number;
  provided: Map<string, unknown>;
  effects: Array<() => unknown>;
  ctx: Record<string, unknown>;
} {
  const consumers: ConsumerRecord[] = [];
  let disposeCount = 0;
  const provided = new Map<string, unknown>();
  const effects: Array<() => unknown> = [];
  const sections: SectionRecord[] = [];
  let sectionDisposeCount = 0;
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
  if (options.noSystemPrompt !== true) {
    ctx["systemPrompt"] = {
      section: (section: SectionRecord) => {
        sections.push(section);
        return () => {
          sectionDisposeCount += 1;
        };
      },
    };
  }
  return {
    consumers,
    sections,
    sectionDisposed: () => sectionDisposeCount,
    disposed: () => disposeCount,
    provided,
    effects,
    ctx,
  };
}

test("apply：注册消费者 + provide 服务；decide 审查 → notice 事件 + 反馈内容", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx, { cooldownMs: 0, cooldownRuns: 0 });
  assert.equal(fake.consumers.length, 1, "只剩审查消费者");
  assert.deepEqual(
    fake.consumers.map((c) => c.id),
    ["symbol-normalizer"],
  );
  assert.equal(fake.sections.length, 1, "开局指南改走静态 section");
  assert.equal(fake.sections[0]?.name, "symbol-normalizer/guide");

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
  assert.equal(fake.disposed(), 1, "审查消费者注销");
  assert.equal(fake.sectionDisposed(), 1, "指南 section 注销");
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

test("apply：开局指南注册静态 section（固定 name / order / interpolate）", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx, { cooldownMs: 0, cooldownRuns: 0 });
  const section = fake.sections.find(
    (item) => item.name === "symbol-normalizer/guide",
  );
  assert.ok(section !== undefined);
  assert.equal(section.order, 4000);
  assert.equal(section.interpolate, false);
  assert.match(section.text, /推荐符号白名单/);
  assert.ok(section.text.startsWith("[符号规范]"));
});

test("apply：systemPrompt 缺席时只告警，审查与展示面仍可用", async () => {
  const fake = fakeCtx({ noSystemPrompt: true });
  await apply(fake.ctx, { cooldownMs: 0, cooldownRuns: 0 });
  assert.equal(fake.sections.length, 0);
  assert.equal(fake.consumers.length, 1);
});

test("apply：injectGuide=false 时不注册 section", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx, { injectGuide: false });
  assert.equal(fake.sections.length, 0, "关闭后不注册静态 section");
  assert.deepEqual(
    fake.consumers.map((c) => c.id),
    ["symbol-normalizer"],
    "审查消费者仍在",
  );
});
