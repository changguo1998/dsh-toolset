/**
 * 插件入口单测：apply 接线（消费者注册 / provide 服务 / 生命周期注销）、
 * decide 链路（审查 → notice 事件 + 反馈内容）与缺面降级。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { apply } from "../src/main.ts";
import { GUIDE_SUMMARY } from "../src/guide.ts";

/** 消费者注册记录。 */
interface ConsumerRecord {
  id: string;
  decide(context: {
    sessionId: string;
    turn: number;
    text: string;
    trigger: string;
  }): { text: string; summary?: string } | null;
}

/** 假 ctx：记录注册的消费者、provide 的服务与 effect 清理函数。 */
function fakeCtx(
  options: {
    noRuleEngine?: boolean;
    /** 会话存储替身：id → 会话对象（F3 历史判定用；缺省 = 无 sessions 面）。 */
    sessions?: Record<string, unknown>;
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
  if (options.sessions !== undefined) {
    ctx["sessions"] = {
      get: (id: string) => options.sessions?.[id],
    };
  }
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

test("apply：开局指南消费者每会话只注入一次（内容含白名单与使用标准）", async () => {
  const fake = fakeCtx();
  await apply(fake.ctx, { cooldownMs: 0, cooldownRuns: 0 });
  const guide = fake.consumers.find((c) => c.id === "symbol-normalizer-guide");
  assert.ok(guide !== undefined);
  const context = { sessionId: "s1", turn: 1, text: "", trigger: "turn-end" };
  const first = guide.decide(context);
  assert.ok(first !== null, "首回合应注入");
  assert.match(first.text, /推荐符号白名单/);
  assert.equal(first.summary, "符号规范（会话开局指南）");
  assert.equal(guide.decide(context), null, "同会话第二次 → 跳过");
  assert.ok(
    guide.decide({ ...context, sessionId: "s2" }) !== null,
    "另一会话不受影响",
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

test("F3：历史已有指南（重启/resume）→ 跳过注入；未注入过的会话仍注入", async () => {
  const fake = fakeCtx({
    sessions: {
      s1: {
        deriveMessages: () => [
          { role: "user" },
          {
            role: "user",
            source: { kind: "rule-engine", summary: GUIDE_SUMMARY },
          },
        ],
      },
    },
  });
  await apply(fake.ctx, { cooldownMs: 0, cooldownRuns: 0 });
  const guide = fake.consumers.find((c) => c.id === "symbol-normalizer-guide");
  assert.ok(guide !== undefined);
  assert.equal(
    guide.decide({ sessionId: "s1", turn: 1, text: "", trigger: "turn-end" }),
    null,
    "历史已有 → 不重复注入",
  );
  assert.ok(
    guide.decide({
      sessionId: "s2",
      turn: 1,
      text: "",
      trigger: "turn-end",
    }) !== null,
    "不同会话各自一次",
  );
  assert.equal(
    guide.decide({ sessionId: "s1", turn: 2, text: "", trigger: "turn-end" }),
    null,
    "记账后同会话仍跳过",
  );
});

test("F3：历史读取抛错 → fail-open 仍注入（退回进程内记账）", async () => {
  const fake = fakeCtx({
    sessions: {
      s1: {
        deriveMessages: () => {
          throw new Error("boom");
        },
      },
    },
  });
  await apply(fake.ctx, { cooldownMs: 0, cooldownRuns: 0 });
  const guide = fake.consumers.find((c) => c.id === "symbol-normalizer-guide");
  assert.ok(guide !== undefined);
  assert.ok(
    guide.decide({
      sessionId: "s1",
      turn: 1,
      text: "",
      trigger: "turn-end",
    }) !== null,
    "读不到历史时不阻断指南",
  );
  assert.equal(
    guide.decide({ sessionId: "s1", turn: 2, text: "", trigger: "turn-end" }),
    null,
    "进程内记账仍生效",
  );
});
