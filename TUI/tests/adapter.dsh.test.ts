// tests/adapter.dsh.test.ts — real adapter 单测（fake runtime 注入）
// 覆盖：session/event 归一化、approval/request 应答者、sendMessage/followup。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRealDshAdapter,
  type DshRuntime,
  type DshAgentLike,
  type DshEvent,
  type DshUserMessageLike,
  type SessionEvent,
  type ApprovalOutcome,
  normalizeAgentStatus,
} from "../src/app/adapter/dsh.ts";

/** 可编程 fake 宿主 */
class FakeRuntime implements DshRuntime {
  listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  on(event: string, listener: (...args: unknown[]) => unknown): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
  fire(event: string, ...args: unknown[]): unknown {
    const set = this.listeners.get(event);
    if (!set) return undefined;
    let last: unknown;
    for (const cb of [...set]) {
      const r = cb(...args);
      if (r !== undefined) last = r;
    }
    return last;
  }
}

class FakeAgent implements DshAgentLike {
  session = { id: "s1" };
  followups: DshUserMessageLike[] = [];
  followup(msg: DshUserMessageLike): void {
    this.followups.push(msg);
  }
}

interface TestHarness {
  adapter: ReturnType<typeof createRealDshAdapter>;
  runtime: FakeRuntime;
  agent: FakeAgent;
  events: DshEvent[];
  unbind: () => void;
}

function makeAdapter(
  runtime = new FakeRuntime(),
  agent = new FakeAgent(),
  approvalTimeoutMs = 50,
): TestHarness {
  const adapter = createRealAdapter(runtime, agent, approvalTimeoutMs);
  const events: DshEvent[] = [];
  const unbind = adapter.onEvent((e) => events.push(e));
  return { adapter, runtime, agent, events, unbind };
}

// adapter 构造尝试（一次即可，供 fire 时无订阅者路径）
function createRealAdapter(
  runtime: DshRuntime,
  agent: DshAgentLike,
  approvalTimeoutMs = 50,
) {
  return createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent,
    approvalTimeoutMs,
  });
}

function chunkEvent(
  type: "text-delta" | "reasoning-delta",
  text: string,
  index = 0,
): SessionEvent<"assistant/chunk"> {
  return {
    type: "assistant/chunk",
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, chunk: { type, index, text } },
  };
}

test("assistant/chunk text-delta + reasoning-delta 归一化为 stream 事件", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    chunkEvent("text-delta", "你好"),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    chunkEvent("reasoning-delta", "（思考中）"),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    chunkEvent("text-delta", "世界"),
  );
  assert.equal(t.events[0]!.type, "stream");
  assert.equal((t.events[0] as { text: string }).text, "你好");
  assert.equal((t.events[1] as { text: string }).text, "（思考中）");
  assert.equal((t.events[2] as { text: string }).text, "世界");
});

test("assistant/chunk block-end(携带完整 text)→ stream 事件(真机型)", () => {
  const t = makeAdapter();
  // 真机实测 payload：deepseek adapter 以 block-end 的 block.text 携带完整块文本送达
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    {
      type: "assistant/chunk",
      seq: 1,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        chunk: { type: "block-start", index: 0, blockType: "reasoning" },
      },
    },
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    {
      type: "assistant/chunk",
      seq: 2,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: "block-end",
          index: 0,
          blockType: "reasoning",
          block: { type: "reasoning", text: "The user asks 1+1?" },
        },
      },
    },
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    {
      type: "assistant/chunk",
      seq: 3,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: "block-end",
          index: 1,
          blockType: "text",
          block: { type: "text", text: "1+1=2。" },
        },
      },
    },
  );
  assert.equal(t.events.length, 2);
  assert.equal((t.events[0] as { text: string }).text, "The user asks 1+1?");
  assert.equal((t.events[1] as { text: string }).text, "1+1=2。");
});

test("turn/start | turn/end → turn-end 事件", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    { type: "turn/start", seq: 2, time: Date.now(), data: { turn: 1 } },
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    {
      type: "turn/end",
      seq: 3,
      time: Date.now(),
      data: { turn: 1, reason: "completed" },
    },
  );
  assert.deepEqual(t.events, [{ type: "turn-end" }, { type: "turn-end" }]);
});

test("agent/status payload → agent-status 事件", () => {
  const t = makeAdapter();
  t.runtime.fire("agent/status", { agent: {}, status: "running" });
  assert.deepEqual(t.events, [
    { type: "agent-status", sessionId: "s1", status: "thinking" },
  ]);
});

test("normalizeAgentStatus 映射", () => {
  assert.equal(normalizeAgentStatus("running"), "thinking");
  assert.equal(normalizeAgentStatus("idle"), "idle");
  assert.equal(normalizeAgentStatus("bogus"), "idle");
});

test("approve(true) → allowed-once", async () => {
  const rt = new FakeRuntime();
  const t = makeAdapter(rt);
  const p = rt.fire(
    "approval/request",
    { agent: {}, toolName: "bash", reason: "执行命令" },
    () => Promise.resolve<ApprovalOutcome>("unavailable"),
  ) as unknown as Promise<ApprovalOutcome>;
  const id = (t.events.find((e) => e.type === "approval")! as { id: string })
    .id;
  t.adapter.approve(id, true);
  assert.equal(await p, "allowed-once");
});

test("approve(false) → rejected", async () => {
  const rt = new FakeRuntime();
  const t = makeAdapter(rt);
  const p = rt.fire("approval/request", { agent: {}, toolName: "bash" }, () =>
    Promise.resolve<ApprovalOutcome>("unavailable"),
  ) as unknown as Promise<ApprovalOutcome>;
  const id = (t.events.find((e) => e.type === "approval")! as { id: string })
    .id;
  t.adapter.approve(id, false);
  assert.equal(await p, "rejected");
});

test("approval 无订阅者 → next() fail-closed unavailable", async () => {
  const rt = new FakeRuntime();
  const adapter = createRealAdapter(rt, new FakeAgent());
  const p = rt.fire("approval/request", { agent: {}, toolName: "bash" }, () =>
    Promise.resolve<ApprovalOutcome>("unavailable"),
  ) as unknown as Promise<ApprovalOutcome>;
  assert.equal(await p, "unavailable");
  void adapter;
});

test("审批超时(approvalTimeoutMs 到期) → cancelled", async () => {
  const rt = new FakeRuntime();
  const t = makeAdapter(rt); // makeAdapter 默认 approvalTimeoutMs = 50
  const p = rt.fire("approval/request", { agent: {}, toolName: "bash" }, () =>
    Promise.resolve<ApprovalOutcome>("unavailable"),
  ) as unknown as Promise<ApprovalOutcome>;
  assert.equal(await p, "cancelled"); // timer ~50ms 到期 settle
});

test("审批 signal 中断 → cancelled", async () => {
  const ab = new AbortController();
  const rt = new FakeRuntime();
  makeAdapter(rt);
  const p = rt.fire(
    "approval/request",
    { agent: {}, toolName: "bash", signal: ab.signal },
    () => Promise.resolve<ApprovalOutcome>("unavailable"),
  ) as unknown as Promise<ApprovalOutcome>;

  // abort 触发应答者 settling
  await new Promise<void>((resolve) => {
    void p.then((o) => {
      assert.equal(o, "cancelled");
      resolve();
    });
    ab.abort();
  });
});

test("sendMessage → agent.followup 参数（文本 + source）", () => {
  const agent = new FakeAgent();
  const rt = new FakeRuntime();
  const t = makeAdapter(rt, agent);
  t.adapter.sendMessage("你好 DSH", "s1");
  assert.equal(agent.followups.length, 1);
  const msg = agent.followups[0]!;
  assert.equal(msg.role, "user");
  assert.deepEqual(msg.content, [{ type: "text", text: "你好 DSH" }]);
  assert.deepEqual(msg.source, { kind: "user" });
});

test("sendMessage without sessionId targets active session", () => {
  const agent = new FakeAgent();
  const rt = new FakeRuntime();
  const t = makeAdapter(rt, agent);
  t.adapter.sendMessage("hi", "s1");
  assert.equal(agent.followups.length, 1);
  const msg = agent.followups[0]!;
  assert.ok(Array.isArray(msg.content));
  assert.deepEqual(msg.source, { kind: "user" });
});

test("sendMessage 忽略不匹配的 sessionId（写 stderr 不崩溃）", () => {
  const agent = new FakeAgent();
  const t = makeAdapter(new FakeRuntime(), agent);
  t.adapter.sendMessage("x", "other-session");
  assert.equal(agent.followups.length, 0);
});

test("onEvent 返回解绑函数；unbind 后不再收到事件", () => {
  const t = makeAdapter();
  t.unbind();
  t.runtime.fire("session/event", { id: "s1" }, chunkEvent("text-delta", "x"));
  assert.equal(t.events.length, 0);
});
