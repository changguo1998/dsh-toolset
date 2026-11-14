import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/index.ts";
import type { CacheHitMonitorService } from "../src/index.ts";

const msg = (id: string, text = "x") => ({
  id,
  role: "user",
  content: [{ type: "text", text }],
});

/** 可编程假宿主：捕获事件订阅、服务面, 可手动触发 pre-step / session-event / dispose。 */
function makeContext() {
  const events = new Map<
    string,
    (payload: unknown, next?: unknown) => unknown
  >();
  const provided: Array<{ name: string; value: unknown }> = [];
  const ctx = {
    on(name: string, handler: (payload: unknown, next?: unknown) => unknown) {
      events.set(name, handler);
      return () => {};
    },
    provide(name: string, value: unknown): void {
      provided.push({ name, value });
    },
  };
  return { ctx, events, provided };
}

type PreStepH = (p: unknown, next?: unknown) => Promise<unknown>;
type SessionH = (s: unknown, e: unknown) => void;

test("A4: 提供 cacheHitMonitor 服务面", () => {
  const { ctx, provided } = makeContext();
  apply(ctx);
  const face = provided.find((p) => p.name === "cacheHitMonitor")?.value;
  assert.ok(face, "应提供 cacheHitMonitor 服务面");
  assert.equal(typeof (face as CacheHitMonitorService).summary, "function");
});

test("A4: 首次 step（无 usage）→ summary state=undefined（渲染层占位）", async () => {
  const { ctx, events, provided } = makeContext();
  apply(ctx);
  const prestep = events.get("agent/pre-step") as PreStepH;
  const session = events.get("session/event") as SessionH;
  const face = provided.find((p) => p.name === "cacheHitMonitor")!
    .value as CacheHitMonitorService;

  const snapshot = [msg("a1")];
  const payload = {
    agent: { sessionId: "s1", session: { deriveMessages: () => snapshot } },
    messages: [],
  };
  await prestep(payload, async () => ({ kind: "enter", messages: [] }));
  // 无 assistant/message.usage → 状态未定
  session({ id: "s1" }, { type: "other" });
  assert.equal(face.summary("s1").state, undefined);
  assert.equal(face.summary("nope").state, undefined);
});

test("A4: 首步 + usage → first 状态, 命中率按 0（无基线）, runMin 由真实值接管", async () => {
  const { ctx, events, provided } = makeContext();
  apply(ctx);
  const prestep = events.get("agent/pre-step") as PreStepH;
  const session = events.get("session/event") as SessionH;
  const face = provided.find((p) => p.name === "cacheHitMonitor")!
    .value as CacheHitMonitorService;

  const payload = {
    agent: {
      sessionId: "s1",
      session: { deriveMessages: () => [msg("a1"), msg("a2")] },
    },
    messages: [],
  };
  await prestep(payload, async () => ({ kind: "enter", messages: [] }));
  session(
    { id: "s1" },
    {
      type: "assistant/message",
      data: { usage: { inputTokens: 8, outputTokens: 0, cacheReadTokens: 2 } },
    },
  );
  const summary = face.summary("s1");
  assert.equal(summary.state, "first"); // 无预估基线 → first, 显示黄
  assert.equal(summary.lastHitRate, 0.2); // 2/(8+2)
  assert.equal(summary.runMinHitRate, 0.2); // 首个真实值接管
});

test("A4: 第二步完全重合→预估 1.0, 实际偏差小→normal", async () => {
  const { ctx, events, provided } = makeContext();
  apply(ctx);
  const prestep = events.get("agent/pre-step") as PreStepH;
  const session = events.get("session/event") as SessionH;
  const face = provided.find((p) => p.name === "cacheHitMonitor")!
    .value as CacheHitMonitorService;

  const snap = [msg("a1"), msg("a2")];
  await prestep(
    {
      agent: { sessionId: "s1", session: { deriveMessages: () => snap } },
      messages: [],
    },
    async () => ({ kind: "enter", messages: [] }),
  );
  session(
    { id: "s1" },
    {
      type: "assistant/message",
      data: { usage: { inputTokens: 8, outputTokens: 0, cacheReadTokens: 2 } },
    },
  );
  const faceAfterFirst = face.summary("s1");
  assert.equal(faceAfterFirst.state, "first");

  // 第二步：同内容 → 前缀完全重合 → 预估 1.0; 实际 0.9 → 偏差 0.1 < 0.3 → normal
  const snap2 = [msg("b1"), msg("b2")];
  await prestep(
    {
      agent: { sessionId: "s1", session: { deriveMessages: () => snap2 } },
      messages: [],
    },
    async () => ({ kind: "enter", messages: [] }),
  );
  session(
    { id: "s1" },
    {
      type: "assistant/message",
      data: { usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 9 } },
    },
  );
  const summary = face.summary("s1");
  assert.equal(summary.state, "normal");
  assert.equal(summary.lastHitRate, 0.9);
  assert.equal(summary.runMinHitRate, 0.2); // 首步 0.2 仍是运行最低（更低值接管）
});

test("A4: 第二步偏差超阈值→stale", async () => {
  const { ctx, events, provided } = makeContext();
  apply(ctx);
  const prestep = events.get("agent/pre-step") as PreStepH;
  const session = events.get("session/event") as SessionH;
  const face = provided.find((p) => p.name === "cacheHitMonitor")!
    .value as CacheHitMonitorService;

  // 第一步: 预估基线建立
  await prestep(
    {
      agent: {
        sessionId: "s1",
        session: { deriveMessages: () => [msg("a1"), msg("a2")] },
      },
      messages: [],
    },
    async () => ({ kind: "enter", messages: [] }),
  );
  session(
    { id: "s1" },
    {
      type: "assistant/message",
      data: { usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 5 } },
    },
  );
  // 第二步: 同内容 → 预估 1.0; 实际 0 → 偏差 1.0 > 0.3 → stale
  await prestep(
    {
      agent: {
        sessionId: "s1",
        session: { deriveMessages: () => [msg("b1"), msg("b2")] },
      },
      messages: [],
    },
    async () => ({ kind: "enter", messages: [] }),
  );
  session(
    { id: "s1" },
    {
      type: "assistant/message",
      data: {
        usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0 },
      },
    },
  );
  const summary = face.summary("s1");
  assert.equal(summary.state, "stale");
  assert.equal(summary.lastHitRate, 0);
});

test("A4: 会话销毁后 summary 回落 undefined", async () => {
  const { ctx, events, provided } = makeContext();
  apply(ctx);
  const session = events.get("session/event") as SessionH;
  const dispose = events.get("session/disposed") as
    ((s: unknown) => void) | undefined;
  const face = provided.find((p) => p.name === "cacheHitMonitor")!
    .value as CacheHitMonitorService;
  session(
    { id: "s1" },
    {
      type: "assistant/message",
      data: { usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 5 } },
    },
  );
  assert.ok(dispose, "应订阅 session/disposed");
  dispose({ id: "s1" });
  assert.equal(face.summary("s1").state, undefined);
});
