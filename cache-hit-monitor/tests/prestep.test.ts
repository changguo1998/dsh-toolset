import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/index.ts";
import type { PreStepPayload } from "../src/index.ts";
import {
  createMonitorState,
  recordSnapshot,
  dropState,
} from "../src/monitor.ts";

/** 假宿主：捕获事件订阅, 可手动触发 pre-step。 */
function makeContext() {
  const events = new Map<
    string,
    (payload: unknown, next?: unknown) => Promise<unknown>
  >();
  const offs: string[] = [];
  const off = (name: string): (() => void) => {
    offs.push(name);
    return () => {};
  };
  const ctx = {
    on: (
      name: string,
      handler: (payload: unknown, next?: unknown) => Promise<unknown>,
    ) => {
      events.set(name, handler);
      return off(name);
    },
    provide: () => {},
  };
  return { ctx, events };
}

/** 构造一个 pre-step 载荷（agent 带 deriveMessages）。 */
function preStepPayload(opts: {
  sessionId?: string;
  snapshot?: unknown[];
  messages?: unknown[];
}): { payload: PreStepPayload; deriveCalls: () => number } {
  let calls = 0;
  const payload: PreStepPayload = {
    agent: {
      sessionId: opts.sessionId ?? "s1",
      session: {
        deriveMessages: () => {
          calls += 1;
          return opts.snapshot ?? [];
        },
      },
    },
    messages: opts.messages ?? [{ id: "u1" }],
  };
  return { payload, deriveCalls: () => calls };
}

test("A2: 订阅 agent/pre-step 与 session/disposed", () => {
  const { ctx, events } = makeContext();
  apply(ctx);
  assert.ok(events.has("agent/pre-step"), "应订阅 agent/pre-step");
  assert.ok(events.has("session/disposed"), "应订阅 session/disposed");
});

test("A2: 只读订阅——取快照后原样透传 next() 的决策", async () => {
  const { ctx, events } = makeContext();
  apply(ctx);
  const handler = events.get("agent/pre-step")!;
  const { payload, deriveCalls } = preStepPayload({
    snapshot: [{ id: "a" }, { id: "b" }],
  });
  const decision = { kind: "enter", messages: [{ id: "u1" }] };
  const out = await handler(payload, async () => decision);
  assert.equal(deriveCalls(), 1, "应调用 deriveMessages() 取快照");
  assert.equal(out, decision, "应原样透传 next() 的决策（不注入、不替换）");
});

test("A2: next 不存在时按 kind=enter 原消息回落", async () => {
  const { ctx, events } = makeContext();
  apply(ctx);
  const handler = events.get("agent/pre-step")!;
  const { payload } = preStepPayload({ messages: [{ id: "m1" }] });
  const out = await handler(payload, undefined);
  assert.deepEqual(out, { kind: "enter", messages: [{ id: "m1" }] });
});

test("A2: 取快照失败不干扰决策", async () => {
  const { ctx, events } = makeContext();
  apply(ctx);
  const handler = events.get("agent/pre-step")!;
  const payload: PreStepPayload = {
    agent: {
      sessionId: "s1",
      session: {
        deriveMessages: () => {
          throw new Error("boom");
        },
      },
    },
    messages: [],
  };
  const decision = { kind: "reject" };
  const out = await handler(payload, async () => decision);
  assert.equal(out, decision, "快照异常应吞掉并透传决策");
});

test("A2: enabled=false 时订阅 agent/pre-step", () => {
  // enabled=false 目前仍订阅（采集关闭由内部跳过）。此处仅验证不抛。
  const { ctx } = makeContext();
  apply(ctx, { enabled: false });
});

test("monitor: recordSnapshot 维护 per-session pending 快照", () => {
  const states = new Map<string, ReturnType<typeof createMonitorState>>();
  recordSnapshot(states, "s1", [{ id: "a" }]);
  assert.equal(states.get("s1")!.pendingSnapshot!.length, 1);
  recordSnapshot(states, "s1", [{ id: "b" }]);
  assert.deepEqual(states.get("s1")!.pendingSnapshot![0], { id: "b" });
  assert.equal(dropState(states, "s1"), true);
  assert.equal(dropState(states, "s1"), false);
});
