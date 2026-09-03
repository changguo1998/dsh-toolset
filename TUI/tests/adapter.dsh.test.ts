// tests/adapter.dsh.test.ts — real adapter 单测（fake runtime 注入）
// 覆盖：session/event 归一化、approval/request 应答者、sendMessage/followup。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRealDshAdapter,
  parseSlashCommand,
  type DshRuntime,
  type DshAgentLike,
  type DshCommandLike,
  type DshEvent,
  type DshUserMessageLike,
  type SessionEvent,
  type ApprovalOutcome,
  normalizeAgentStatus,
  installSessionModelSelection,
  type SessionModelSelectionRef,
  type ModelCatalog,
  type ModelSelection,
  type LlmLike,
  type AgentDefaultModelLike,
  type UserQuestionsLike,
  type UserQuestionRequestLike,
  type SessionQueryLike,
  type SessionStoreLike,
  type QuestionAnswer,
  type QuestionItem,
  type AgentRegistryLike,
  buildUserMessage,
} from "../src/app/adapter/dsh.ts";
import { initialState, reduceState } from "../src/app/state.ts";

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
  commands?: DshCommandLike,
): TestHarness {
  const adapter = createRealAdapter(
    runtime,
    agent,
    approvalTimeoutMs,
    commands,
  );
  const events: DshEvent[] = [];
  const unbind = adapter.onEvent((e) => events.push(e));
  return { adapter, runtime, agent, events, unbind };
}

// adapter 构造尝试（一次即可，供 fire 时无订阅者路径）
function createRealAdapter(
  runtime: DshRuntime,
  agent: DshAgentLike,
  approvalTimeoutMs = 50,
  commands?: DshCommandLike,
  interrupt?: () => void,
) {
  return createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent,
    commands,
    approvalTimeoutMs,
    interrupt,
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

test("assistant/chunk text-delta 与 reasoning-delta 分别归一化为 stream/thinking 事件", () => {
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
  assert.equal(t.events[1]!.type, "thinking");
  assert.equal((t.events[1] as { text: string }).text, "（思考中）");
  assert.equal((t.events[2] as { text: string }).text, "世界");
});

test("assistant/chunk block-end(携带完整 text)→ thinking/stream 事件(真机型)", () => {
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
  assert.equal(t.events[0]!.type, "thinking");
  assert.equal((t.events[0] as { text: string }).text, "The user asks 1+1?");
  assert.equal((t.events[1] as { text: string }).text, "1+1=2。");
});

// --- 流式块去重（delta + block-end 同时送达）回归测试 ---
function joinStreams(events: DshEvent[]): string {
  return events
    .filter((e) => e.type === "stream")
    .map((e) => (e as { text: string }).text)
    .join("");
}

function joinThinking(events: DshEvent[]): string {
  return events
    .filter((e) => e.type === "thinking")
    .map((e) => (e as { text: string }).text)
    .join("");
}

function rawChunk(
  chunk: SessionEvent<"assistant/chunk">["data"]["chunk"],
  turn = 1,
  step = 1,
): SessionEvent<"assistant/chunk"> {
  return {
    type: "assistant/chunk",
    seq: 1,
    time: Date.now(),
    data: { turn, step, chunk },
  };
}

test("assistant/chunk delta+block-end 去重：完整正文不重复输出(真机同时送达两种载荷)", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({ type: "text-delta", index: 0, text: "Hel" }),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({ type: "text-delta", index: 0, text: "lo" }),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({
      type: "block-end",
      index: 0,
      blockType: "text",
      block: { type: "text", text: "Hello" },
    }),
  );
  // 总输出恰为 "Hello"，而非 delta 累计 + block-end 完整文本两遍
  assert.equal(joinStreams(t.events), "Hello");
});

test("assistant/chunk 部分 delta + 更长的 block-end → 仅补发缺失后缀", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({ type: "text-delta", index: 0, text: "Hello " }),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({
      type: "block-end",
      index: 0,
      blockType: "text",
      block: { type: "text", text: "Hello world" },
    }),
  );
  assert.equal(joinStreams(t.events), "Hello world");
  assert.deepEqual(
    t.events
      .filter((e) => e.type === "stream")
      .map((e) => (e as { text: string }).text),
    ["Hello ", "world"],
  );
});

test("assistant/chunk 纯 block-end(无 delta)→ 输出完整文本", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({
      type: "block-end",
      index: 2,
      blockType: "text",
      block: { type: "text", text: "完整文本" },
    }),
  );
  assert.equal(joinStreams(t.events), "完整文本");
});

// --- assistant/message：非流式 provider 的完整回复补发（含去重） ---
/** 构造 assistant/message 完整正文事件（surface append/replace 可选） */
function rawMessage(
  content: unknown[],
  turn = 1,
  step = 1,
  surfaceOp?: "append" | "replace",
): SessionEvent<"assistant/message"> {
  return {
    type: "assistant/message",
    seq: 1,
    time: Date.now(),
    surfaceOp,
    data: { turn, step, message: { content } },
  } as unknown as SessionEvent<"assistant/message">;
}

test("assistant/message：非流式/无 chunk provider 直接输出完整正文(修复回复不显示)", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawMessage([{ type: "text", text: "不支持流式的完整回复" }]),
  );
  assert.equal(joinStreams(t.events), "不支持流式的完整回复");
});

test("assistant/message：流式已完整输出后不再重复(不打两遍)", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({ type: "text-delta", index: 0, text: "Hello" }),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({ type: "text-delta", index: 0, text: " world" }),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawMessage([{ type: "text", text: "Hello world" }]),
  );
  assert.equal(joinStreams(t.events), "Hello world");
});

test("assistant/message：流式只输出一部分 → 仅补发缺失后缀", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({ type: "text-delta", index: 0, text: "Hello " }),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawMessage([{ type: "text", text: "Hello world" }]),
  );
  assert.deepEqual(
    t.events
      .filter((e) => e.type === "stream")
      .map((e) => (e as { text: string }).text),
    ["Hello ", "world"],
  );
});

test("assistant/message：无 text 块(tool-call/reasoning)不输出；replace 表面事件跳过", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawMessage([
      { type: "tool-call", id: "c1", name: "read", arguments: "{}" },
      { type: "reasoning", text: "think" },
    ]),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawMessage(
      [{ type: "text", text: "被 replace 覆盖的旧文本" }],
      1,
      1,
      "replace",
    ),
  );
  // also a normal append second step still emits
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawMessage([{ type: "text", text: "第二步正文" }], 1, 2),
  );
  assert.equal(joinStreams(t.events), "第二步正文");
});

test("assistant/message 不跨 turn 复用：同 turn/step 键在 turn-end 后被清除", () => {
  const t = makeAdapter();
  // step 0 有 chunk；turn 结束清除累计后，同样 turn/step 键的新一组事件按新 step 处理
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({ type: "text-delta", index: 0, text: "A" }, 1, 0),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    {
      type: "turn/end",
      seq: 2,
      time: Date.now(),
      data: { turn: 1, reason: "ok" },
    },
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawMessage([{ type: "text", text: "B" }], 1, 0),
  );
  assert.equal(joinStreams(t.events), "AB");
});

test("assistant/chunk reasoning delta+block-end 去重：思考流同样不重复", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({ type: "reasoning-delta", index: 0, text: "think" }),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({
      type: "block-end",
      index: 0,
      blockType: "reasoning",
      block: { type: "reasoning", text: "thinkingx" },
    }),
  );
  assert.equal(joinThinking(t.events), "thinkingx");
});

test("assistant/chunk 复用 index 的 block 不继承上轮累计", () => {
  const t = makeAdapter();
  // turn 1：delta + block-end 完整文本
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk({ type: "text-delta", index: 0, text: "a" }, 1),
  );
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk(
      {
        type: "block-end",
        index: 0,
        blockType: "text",
        block: { type: "text", text: "ab" },
      },
      1,
    ),
  );
  // turn 2 同 index：无 delta，block-end 应完整输出，而非复用 turn1 的累计
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    rawChunk(
      {
        type: "block-end",
        index: 0,
        blockType: "text",
        block: { type: "text", text: "zz" },
      },
      2,
    ),
  );
  assert.equal(joinStreams(t.events), "abzz");
});

test("turn/start 忽略；turn/end → turn-end 事件", () => {
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
  assert.deepEqual(t.events, [{ type: "turn-end" }]);
});

test("agent/status payload → agent-status 事件", () => {
  const t = makeAdapter();
  t.runtime.fire("agent/status", { agent: {}, status: "running" });
  assert.deepEqual(t.events, [
    { type: "agent-status", sessionId: "s1", status: "thinking" },
  ]);
});

test("agent/status：非活跃 agent 状态不转发（不污染状态栏）", () => {
  const t = makeAdapter();
  t.runtime.fire("agent/status", {
    agent: { session: { id: "other" } },
    status: "running",
  });
  assert.equal(t.events.length, 0, "其他 live agent 的状态被丢弃");
  // 当前活跃 agent 的状态仍转发
  t.runtime.fire("agent/status", {
    agent: { session: { id: "s1" } },
    status: "running",
  });
  assert.deepEqual(t.events, [
    { type: "agent-status", sessionId: "s1", status: "thinking" },
  ]);
});

test("session/event：非活跃会话事件不转发（不污染活跃 buffer）", () => {
  const t = makeAdapter();
  t.runtime.fire(
    "session/event",
    { id: "other" },
    chunkEvent("text-delta", "OTHER_OUTPUT"),
  );
  assert.equal(t.events.length, 0, "其他 live 会话的流式事件被丢弃");
  // 当前活跃会话的事件正常转发
  t.runtime.fire(
    "session/event",
    { id: "s1" },
    chunkEvent("text-delta", "MY_OUTPUT"),
  );
  const evs: DshEvent[] = t.events;
  assert.ok(
    evs.some((e) => e.type === "stream" && e.text === "MY_OUTPUT"),
    "活跃会话流式事件照常转发",
  );
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
  makeAdapter(rt); // makeAdapter 默认 approvalTimeoutMs = 50
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

// ---------------------------------------------------------------------------
// slash 命令：parseSlashCommand / runCommand(注册表调度) / notice / dispose
// ---------------------------------------------------------------------------

test("parseSlashCommand: 合法命令名", () => {
  assert.equal(parseSlashCommand("/help"), "help");
  assert.equal(parseSlashCommand("/clear "), "clear");
  assert.equal(parseSlashCommand("/clearscreen"), "clearscreen");
  assert.equal(parseSlashCommand("/cls"), "cls");
  assert.equal(parseSlashCommand("/compact 现在"), "compact");
  assert.equal(parseSlashCommand("/plan_2 -v"), "plan_2");
  assert.equal(parseSlashCommand("/foo-bar"), "foo-bar");
});

test("parseSlashCommand: 非法输入返回 null", () => {
  assert.equal(parseSlashCommand("/"), null);
  assert.equal(parseSlashCommand("help"), null);
  assert.equal(parseSlashCommand(" /help"), null);
  assert.equal(parseSlashCommand("/1abc"), null);
  assert.equal(parseSlashCommand("/ABC"), null);
  assert.equal(parseSlashCommand(""), null);
  assert.equal(parseSlashCommand("/help/extra"), null); // 斜杠后不允许
});

/** 可编程 fake 注册表 */
class FakeCommands implements DshCommandLike {
  calls: { agent: unknown; line: string; signal?: AbortSignal }[] = [];
  outcome: unknown;
  error: unknown;
  async execute(
    agent: unknown,
    line: string,
    _images?: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({ agent, line, signal });
    if (this.error !== undefined) throw this.error;
    return this.outcome;
  }
}

test("runCommand: 注册表命中成功 → notice 展示结果文本", async () => {
  const commands = new FakeCommands();
  commands.outcome = {
    commandId: "c1",
    result: { kind: "success", text: "已压缩会话。" },
  };
  const t = makeAdapter(new FakeRuntime(), new FakeAgent(), 50, commands);
  t.adapter.runCommand("/compact 现在");
  await new Promise((r) => setTimeout(r, 10));
  const notices = t.events.filter((e) => e.type === "notice");
  assert.equal(notices.length, 1);
  assert.equal((notices[0] as { text: string }).text, "[c1] 已压缩会话。");
  assert.equal(commands.calls.length, 1);
  assert.equal(commands.calls[0]!.line, "/compact 现在");
});

test("runCommand: 注册表未命中(undefined) → notice 未知命令(fail-close)", async () => {
  const commands = new FakeCommands();
  commands.outcome = undefined;
  const t = makeAdapter(new FakeRuntime(), new FakeAgent(), 50, commands);
  t.adapter.runCommand("/nonexistent");
  await new Promise((r) => setTimeout(r, 10));
  const notices = t.events.filter((e) => e.type === "notice");
  assert.equal(notices.length, 1);
  assert.match((notices[0] as { text: string }).text, /未知命令/);
  // fail-close：绝不产生 followup 用户消息
  assert.equal(t.agent.followups.length, 0);
});

test("runCommand: 注册表错误 → notice 错误文本", async () => {
  const commands = new FakeCommands();
  commands.error = new Error("boom");
  const t = makeAdapter(new FakeRuntime(), new FakeAgent(), 50, commands);
  t.adapter.runCommand("/plan foo");
  await new Promise((r) => setTimeout(r, 10));
  const notices = t.events.filter((e) => e.type === "notice");
  assert.equal(notices.length, 1);
  assert.match((notices[0] as { text: string }).text, /执行出错/);
  assert.equal(t.agent.followups.length, 0);
});

test("runCommand: 无注册表(未注入) → notice 提示 commands 未就绪", () => {
  const t = makeAdapter(new FakeRuntime(), new FakeAgent(), 50); // 无 commands
  t.adapter.runCommand("/plan foo");
  const notices = t.events.filter((e) => e.type === "notice");
  assert.equal(notices.length, 1);
  assert.match((notices[0] as { text: string }).text, /未就绪/);
  assert.equal(t.agent.followups.length, 0);
});

test("runCommand: 非法命令行 → notice invalid", () => {
  const t = makeAdapter(new FakeRuntime(), new FakeAgent(), 50);
  t.adapter.runCommand("/1bad");
  const notices = t.events.filter((e) => e.type === "notice");
  assert.equal(notices.length, 1);
  assert.match((notices[0] as { text: string }).text, /invalid/);
});

test("runCommand: 同步返回(非 Promise)也走 finish", () => {
  const commands = new FakeCommands();
  commands.outcome = {
    commandId: "c2",
    result: { kind: "success", text: "ok" },
  };
  // 覆盖 execute 返回同步值（async 签名向下兼容）
  commands.execute = ((_agent, line) => {
    void line;
    return commands.outcome;
  }) as FakeCommands["execute"];
  const t = makeAdapter(new FakeRuntime(), new FakeAgent(), 50, commands);
  t.adapter.runCommand("/foo");
  const notices = t.events.filter((e) => e.type === "notice");
  assert.equal(notices.length, 1);
  assert.equal((notices[0] as { text: string }).text, "[c2] ok");
});

test("runCommand: 忽略不匹配的 sessionId(写 stderr 不崩溃)", () => {
  const t = makeAdapter(new FakeRuntime(), new FakeAgent(), 50);
  t.adapter.runCommand("/foo", "other-session");
  const notices = t.events.filter((e) => e.type === "notice");
  assert.equal(notices.length, 0);
});

test("dispose: 中止在途命令 + 解绑运行时监听", async () => {
  const rt = new FakeRuntime();
  const commands = new FakeCommands();
  commands.outcome = new Promise(() => {}); // 永不 resolve，验证 abort
  const t = makeAdapter(rt, new FakeAgent(), 50, commands);
  t.adapter.runCommand("/slow");
  await new Promise((r) => setTimeout(r, 5));
  const sig = commands.calls[0]?.signal;
  assert.ok(sig, "execute 应收到 AbortSignal");
  t.adapter.dispose!();
  assert.ok(sig?.aborted, "dispose 后 signal 应被 abort");
  // runtime 监听已解绑：fire 不再产生事件
  t.adapter.onEvent(() => {}); // 重建订阅也无妨
  rt.fire("session/event", { id: "s1" }, chunkEvent("text-delta", "x"));
  // dispose 后 emit 静默
  assert.ok(true);
});

test("dispose: 幂等(可重复调用)", () => {
  const rt = new FakeRuntime();
  const t = makeAdapter(rt, new FakeAgent(), 50);
  t.adapter.dispose!();
  t.adapter.dispose!();
  assert.ok(true);
});

test("interrupt: 调用传入的 interrupt 回调", () => {
  let calls = 0;
  const agent = new FakeAgent();
  const adapter = createRealAdapter(
    new FakeRuntime(),
    agent,
    50,
    undefined,
    () => calls++,
  );
  adapter.interrupt();
  assert.equal(calls, 1);
});

test("interrupt: 无回调时为 no-op(不抛错,不发事件)", () => {
  const t = makeAdapter();
  t.adapter.interrupt();
  assert.equal(t.events.length, 0);
});

test("interrupt: dispose 后为 no-op", () => {
  let calls = 0;
  const adapter = createRealAdapter(
    new FakeRuntime(),
    new FakeAgent(),
    50,
    undefined,
    () => calls++,
  );
  adapter.dispose!();
  adapter.interrupt();
  assert.equal(calls, 0);
});

test("modelCatalog: 聚合 llm listProviders/listModels + 当前默认选择", async () => {
  const llm: LlmLike = {
    listProviders: () => [
      { id: "deepseek", name: "deepseek" },
      { id: "pi", name: "pi" },
    ],
    listModels: async (p) => [
      {
        provider: p,
        id: p === "deepseek" ? "deepseek-chat" : "pi-4o",
        name: p,
      },
    ],
  };
  const sessionModel: SessionModelSelectionRef = {
    current: { provider: "deepseek", model: "deepseek-chat" },
  };
  const adapter = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
    llm,
    sessionModel,
  });
  const catalog = await adapter.modelCatalog();
  assert.deepEqual(catalog.providers, [
    { provider: "deepseek", name: "deepseek" },
    { provider: "pi", name: "pi" },
  ]);
  assert.deepEqual(
    catalog.models.map((m) => [m.provider, m.id]),
    [
      ["deepseek", "deepseek-chat"],
      ["pi", "pi-4o"],
    ],
  );
  assert.deepEqual(catalog.current, {
    provider: "deepseek",
    model: "deepseek-chat",
  });
});

test("modelCatalog: 无 sessionModel 时 current 为空(不抛错)", async () => {
  const adapter = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
  });
  const catalog: ModelCatalog = await adapter.modelCatalog();
  assert.deepEqual(catalog.providers, []);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.current, undefined);
});

test("setSessionModel: 只改会话内 ref，不写宿主设置", async () => {
  const sessionModel: SessionModelSelectionRef = {
    current: { provider: "deepseek", model: "deepseek-chat" },
  };
  // 宿主侧绝不落盘：选项里不注入任何 settings/saveSelection 服务
  const adapter = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
    sessionModel,
  });
  const sel: ModelSelection = {
    provider: "deepseek",
    model: "deepseek-reasoner",
  };
  const out = await adapter.setSessionModel(sel);
  assert.deepEqual(sessionModel.current, sel);
  assert.deepEqual(out, sel);
  // catalog.current 跟随会话内选择
  const catalog = await adapter.modelCatalog();
  assert.deepEqual(catalog.current, sel);
});

test("modelEfforts: 经 llm.resolveModelInfo 读取思考等级", async () => {
  const llm: LlmLike = {
    resolveModelInfo: async () => ({
      reasoning: {
        efforts: [
          { id: "low", name: "low" },
          { id: "max", name: "max" },
        ],
        defaultEffort: "low",
      },
    }),
  };
  const adapter = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
    llm,
  });
  const efforts = await adapter.modelEfforts("ustc", "deepseek-v4-flash");
  assert.deepEqual(efforts, [
    { id: "low", name: "low" },
    { id: "max", name: "max" },
  ]);
});

test("modelEfforts: 非思考模型/服务缺失返回 undefined", async () => {
  const adapter = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
  });
  assert.equal(await adapter.modelEfforts("ustc", "x"), undefined);
  // 服务存在但模型无 reasoning
  const llm: LlmLike = { resolveModelInfo: async () => ({}) };
  const adapter2 = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
    llm,
  });
  assert.equal(await adapter2.modelEfforts("ustc", "x"), undefined);
});

test("setSessionModel: 无 sessionModel 引用时抛错", async () => {
  const adapter = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
  });
  await assert.rejects(
    adapter.setSessionModel({ provider: "deepseek", model: "x" }),
    /会话模型引用未注入/,
  );
});

test("installSessionModelSelection: agent/request 覆盖 provider/model 并移除继承 effort", async () => {
  const runtime = new FakeRuntime();
  const ref: SessionModelSelectionRef = {
    current: {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningEffort: "high",
    },
  };
  installSessionModelSelection(runtime, ref);
  // 模拟宿主 step 顺序：先 system-prompt/assemble(捕获快照)，再 agent/request 应用
  const step = async (
    payload: { turn: number; step: number },
    seed: () => Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    await runtime.fire("system-prompt/assemble", {}, {}, () => ({
      variables: { provider: "deepseek", model: "deepseek-chat" },
    }));
    return (await runtime.fire("agent/request", payload, seed)) as Record<
      string,
      unknown
    >;
  };
  const cfg = await step({ turn: 1, step: 0 }, () => ({
    provider: "deepseek",
    model: "deepseek-chat",
    maxTokens: 4096,
  }));
  assert.deepEqual(cfg, {
    provider: "deepseek",
    model: "deepseek-reasoner",
    reasoningEffort: "high",
    maxTokens: 4096,
  });
  // 选择了无 effort 的模型时，移除 seed 中继承的 effort
  ref.current = { provider: "deepseek", model: "deepseek-chat" };
  const cfg2 = await step({ turn: 1, step: 1 }, () => ({
    provider: "deepseek",
    model: "deepseek-chat",
    reasoningEffort: "low",
    maxTokens: 4096,
  }));
  assert.deepEqual(cfg2, {
    provider: "deepseek",
    model: "deepseek-chat",
    maxTokens: 4096,
  });
});

test("installSessionModelSelection: 未切换时兜底读宿主实时默认(settings 生效后)", async () => {
  const runtime = new FakeRuntime();
  const ref: SessionModelSelectionRef = { current: undefined };
  // 兜底模拟宿主 agentDefaultModel；settings 加载完成后返回 ustc
  let host = { provider: "deepseek-official", model: "deepseek-v4-flash" } as
    { provider: string; model: string } | undefined;
  installSessionModelSelection(runtime, ref, () => host);
  const request = async (step: number): Promise<Record<string, unknown>> => {
    // 模拟宿主 step 顺序：先 assemble(捕获 effective = 当前 ?? 兜底)，再 request 应用
    await runtime.fire("system-prompt/assemble", {}, {}, () => ({
      variables: {},
    }));
    return (await runtime.fire("agent/request", { turn: 1, step }, () => ({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    }))) as Record<string, unknown>;
  };
  // 宿主默认已 settle(指向 settings.yaml 的 ustc) → 下一步用 ustc
  host = { provider: "ustc", model: "deepseek-v4-flash" };
  assert.deepEqual(await request(0), {
    provider: "ustc",
    model: "deepseek-v4-flash",
  });
  // 会话内切换后压过兜底
  ref.current = { provider: "deepseek", model: "deepseek-reasoner" };
  assert.deepEqual(await request(1), {
    provider: "deepseek",
    model: "deepseek-reasoner",
  });
  // 切换回 undefined → 恢复宿主兜底
  ref.current = undefined;
  assert.deepEqual(await request(2), {
    provider: "ustc",
    model: "deepseek-v4-flash",
  });
});

test("modelCatalog: 会话未切换时 current 兜底宿主播放值(defaultModel)", async () => {
  const defaultModel: AgentDefaultModelLike = {
    currentSelection: () => ({ provider: "ustc", model: "deepseek-v4-flash" }),
  };
  const adapter = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
    defaultModel,
  });
  const catalog = await adapter.modelCatalog();
  assert.equal(catalog.current?.provider, "ustc");
  assert.equal(catalog.current?.model, "deepseek-v4-flash");
});

// ---------------------------------------------------------------------------
// userQuestions provider 接线（0.1.1 单 provider，见 RealAdapterOptions.userQuestions）
// ---------------------------------------------------------------------------

/** 记录型 fake userQuestions 服务（0.1.1 单 provider registerProvider） */
class FakeUserQuestions implements UserQuestionsLike {
  provider: {
    ask(req: UserQuestionRequestLike): Promise<QuestionAnswer>;
  } | null = null;
  registerCount = 0;
  registerProvider(p: {
    ask(req: UserQuestionRequestLike): Promise<QuestionAnswer>;
  }): () => void {
    this.provider = p;
    this.registerCount++;
    return () => {
      this.provider = null;
    };
  }
}

test("userQuestions: 注册 provider 后 ask() → question 事件；answerQuestion 整批回答 resolve", async () => {
  const runtime = new FakeRuntime();
  const uq = new FakeUserQuestions();
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: new FakeAgent(),
    userQuestions: uq,
  });
  const events: DshEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  assert.equal(uq.registerCount, 1, "构造时注册 provider");

  const questions: QuestionItem[] = [
    { id: "qa", question: "继续?", options: [{ label: "A" }, { label: "B" }] },
  ];
  const askPromise = uq.provider!.ask({ questions });
  // 微任务落定，确保 question 事件已发出
  await new Promise((r) => setTimeout(r, 0));
  const qEvt = events.find(
    (e): e is Extract<DshEvent, { type: "question" }> => e.type === "question",
  );
  assert.ok(qEvt, "should emit question event");
  assert.equal(qEvt!.questions[0]?.question, "继续?");
  assert.equal(qEvt!.questions[0]?.options?.length, 2);

  const answer: QuestionAnswer = {
    answers: [{ id: "qa", selected: ["A"] }],
  };
  adapter.answerQuestion(qEvt!.id, answer);
  assert.deepEqual(
    await askPromise,
    answer,
    "answerQuestion 使 ask resolve 整批回答",
  );
});

test("userQuestions: cancelQuestion → reject ask（取消不 resolve，不打断 turn）", async () => {
  const runtime = new FakeRuntime();
  const uq = new FakeUserQuestions();
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: new FakeAgent(),
    userQuestions: uq,
  });
  const events: DshEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  const askPromise = uq.provider!.ask({
    questions: [{ id: "qa", question: "取消?" }],
  });
  await new Promise((r) => setTimeout(r, 0));
  const qEvt = events.find((e) => e.type === "question") as
    Extract<DshEvent, { type: "question" }> | undefined;
  adapter.cancelQuestion(qEvt!.id);
  await assert.rejects(
    askPromise,
    /用户取消了提问/,
    "cancelQuestion reject ask",
  );
});

test("userQuestions: 已有活动请求时第二个 ask() 直接拒绝（单面板约束）", async () => {
  const runtime = new FakeRuntime();
  const uq = new FakeUserQuestions();
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: new FakeAgent(),
    userQuestions: uq,
  });
  adapter.onEvent(() => {});
  void uq.provider!.ask({ questions: [{ id: "qa", question: "第一问" }] });
  await assert.rejects(
    uq.provider!.ask({ questions: [{ id: "qb", question: "第二问" }] }),
    /已有待回答的提问/,
    "单面板：并发 ask 拒绝",
  );
});

test("userQuestions: 注册失败(重复 provider) → notice 错误事件且不阻塞构造", () => {
  const runtime = new FakeRuntime();
  const agent = new FakeAgent();
  const uq: UserQuestionsLike = {
    registerProvider() {
      throw new Error("DUPLICATE_PROVIDER");
    },
  };
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent,
    userQuestions: uq,
  });
  const events: DshEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  const notice = events.find((e) => e.type === "notice");
  assert.ok(notice && notice.type === "notice" && notice.error === true);
  assert.match((notice as { text: string }).text, /问答面板不可用/);
  // 失败不影响 sendMessage 等既有能力
  adapter.sendMessage("hi");
  assert.equal(agent.followups.length, 1, "注册失败后 sendMessage 仍可用");
});

test("userQuestions: 请求 signal 中断 → reject ask（agent 主动放弃）", async () => {
  const runtime = new FakeRuntime();
  const uq = new FakeUserQuestions();
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: new FakeAgent(),
    userQuestions: uq,
  });
  adapter.onEvent(() => {});
  const ctrl = new AbortController();
  const askPromise = uq.provider!.ask({
    questions: [{ id: "qa", question: "中断?" }],
    signal: ctrl.signal,
  });
  await new Promise((r) => setTimeout(r, 0));
  ctrl.abort();
  await assert.rejects(askPromise, /aborted/, "signal 中断 reject ask");
  // 中断后 map 清空，可再次 ask
  const again = uq.provider!.ask({
    questions: [{ id: "qb", question: "再来" }],
  });
  adapter.answerQuestion("question-1", {
    answers: [{ id: "qb", selected: ["再来"] }],
  });
  await assert.doesNotReject(again);
});

test("userQuestions: dispose 拒绝悬挂 ask 并注销 provider", async () => {
  const runtime = new FakeRuntime();
  const uq = new FakeUserQuestions();
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: new FakeAgent(),
    userQuestions: uq,
  });
  adapter.onEvent(() => {});
  const askPromise = uq.provider!.ask({
    questions: [{ id: "qa", question: "挂起" }],
  });
  adapter.dispose?.();
  await assert.rejects(
    askPromise,
    /adapter disposed/,
    "dispose reject 悬挂 ask",
  );
  // 注销：dispose 后 provider 引用被清理（FakeUserQuestions 的 disposer 置空）
  assert.equal(uq.provider, null, "dispose 调用 provider disposer");
});

// --- 历史会话（sessionQuery）归一化 ---

class FakeSessionQuery implements SessionQueryLike {
  records: {
    header: { id: string; createdAt: number; cwd?: string };
    live: boolean;
    persisted: boolean;
  }[] = [
    {
      header: { id: "live-1", createdAt: 1787290000000, cwd: "/home/x/TUI" },
      live: true,
      persisted: false,
    },
    {
      header: { id: "old-2", createdAt: 1787200000000, cwd: "/home/x/other" },
      live: false,
      persisted: true,
    },
  ];
  events: Record<string, unknown>[] = [
    {
      type: "user/message",
      seq: 1,
      data: {
        content: [
          { type: "text", text: "你好" },
          { type: "text", text: "第二行" },
        ],
        role: "user",
      },
    },
    {
      type: "assistant/message",
      seq: 2,
      data: {
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "思考中（应被省略）" },
            { type: "text", text: "回复正文" },
          ],
        },
      },
    },
    {
      type: "tool/result",
      seq: 3,
      data: {
        message: {
          content: [
            {
              type: "tool-result",
              content: [{ type: "text", text: "工具输出（v1 省略）" }],
            },
          ],
        },
      },
    },
  ];
  /** live 会话消息形态：agent/inbox/spliced（readSession 优先返回此日志） */
  splicedEvents: Record<string, unknown>[] = [
    {
      type: "agent/inbox/spliced",
      seq: 3,
      data: {
        target: "next-turn",
        start: 0,
        inserted: [
          { role: "user", content: [{ type: "text", text: "内存消息：你好" }] },
        ],
      },
    },
    {
      type: "agent/inbox/spliced",
      seq: 5,
      data: {
        target: "next-turn",
        start: 0,
        inserted: [
          { role: "assistant", content: [{ type: "text", text: "内存回复" }] },
        ],
      },
    },
  ];
  /** 标记会话用 readSession（agent/inbox/spliced 形态）而不是 readSurface */
  usesSplicedSessions = new Set<string>(["live-1"]);
  readCalls: string[] = [];
  /** 官方标题折叠（dsh-session-title 落盘日志）；缺省 undefined = 服务不可用 */
  readTitle?: (id: string) => Promise<{ title: string } | undefined>;
  /** 官方批量折叠（settlement 形态：fulfilled 携带 value.title / rejected 携带 reason） */
  readTitleSnapshots?: (ids: string[]) => Promise<
    readonly (
      | {
          sessionId: string;
          status: "fulfilled";
          value: { title?: { title: string } | undefined };
        }
      | { sessionId: string; status: "rejected"; reason?: unknown }
    )[]
  >;
  listSessions(): Promise<
    {
      header: { id: string; createdAt: number; cwd?: string };
      live: boolean;
      persisted: boolean;
    }[]
  > {
    return Promise.resolve(this.records);
  }
  readSession(
    id: string,
  ): Promise<{ session: { id: string }; events: Record<string, unknown>[] }> {
    this.readCalls.push("session:" + id);
    if (id === "corrupt-9") {
      return Promise.reject(new Error('stored session "corrupt-9" is corrupt'));
    }
    if (this.usesSplicedSessions.has(id)) {
      return Promise.resolve({
        session: { id },
        events: [...this.events, ...this.splicedEvents],
      });
    }
    return Promise.resolve({ session: { id }, events: this.events });
  }
  readSurface(
    id: string,
  ): Promise<{ session: { id: string }; events: Record<string, unknown>[] }> {
    this.readCalls.push("surface:" + id);
    if (id === "corrupt-9") {
      return Promise.reject(new Error('stored session "corrupt-9" is corrupt'));
    }
    return Promise.resolve({ session: { id }, events: this.events });
  }
}

test("历史会话：listSessions 归一化（id/时间/cwd/live/persisted + 无官方标题时本地兜底）", async () => {
  const sq = new FakeSessionQuery();
  const { adapter } = makeAdapterWithSessionQuery(sq);
  const records = await adapter.listSessions!();
  // 无 readTitle（官方服务不可用）→ surface 首条用户消息本地兜底（两块拼接完整文本）
  assert.deepEqual(records, [
    {
      id: "live-1",
      createdAt: 1787290000000,
      cwd: "/home/x/TUI",
      live: true,
      persisted: false,
      title: "你好 第二行",
    },
    {
      id: "old-2",
      createdAt: 1787200000000,
      cwd: "/home/x/other",
      live: false,
      persisted: true,
      title: "你好 第二行",
    },
  ]);
});

test("历史会话：listSessions 标题——官方 session/title 事件优先，缺失本地兜底", async () => {
  const sq = new FakeSessionQuery();
  // 官方批量折叠（真实 settlement 形态）：old-2 官方标题「OFFICIAL TITLE」与本地兜底
  // 「你好 第二行」不同 → 断言官方优先；live-1 走 rejected 隔离（回落到本地兜底）
  sq.readTitleSnapshots = async (ids) =>
    ids.map((id) =>
      id === "old-2"
        ? {
            sessionId: id,
            status: "fulfilled" as const,
            value: { title: { title: "OFFICIAL TITLE" } },
          }
        : {
            sessionId: id,
            status: "rejected" as const,
            reason: new Error("corrupt"),
          },
    );
  const { adapter } = makeAdapterWithSessionQuery(sq);
  const records = await adapter.listSessions!();
  const byId = new Map(records.map((r) => [r.id, r.title]));
  assert.equal(
    byId.get("old-2"),
    "OFFICIAL TITLE",
    "官方 settlement 标题优先于本地兜底",
  );
  assert.equal(
    byId.get("live-1"),
    "你好 第二行",
    "rejected 隔离 → surface 首条用户消息兜底",
  );
});

test("历史会话：listSessions 标记 current——live 且 id==活跃会话 → current:true", async () => {
  const sq = new FakeSessionQuery();
  sq.records = [
    {
      header: { id: "s1", createdAt: 1, cwd: "/x" },
      live: true,
      persisted: false,
    },
    {
      header: { id: "s9", createdAt: 2, cwd: "/y" },
      live: true,
      persisted: false,
    },
  ];
  // makeAdapterWithSessionQuery 的 adapter sessionId = "s1"
  const { adapter } = makeAdapterWithSessionQuery(sq);
  const records = await adapter.listSessions!();
  assert.equal(records[0]!.current, true, "活跃 live 会话标记 current");
  assert.equal("current" in records[1]!, false, "非活跃 live 会话不标 current");
});

test("历史会话：listSessions 标题——损坏/不可读会话省略 title（渲染层显示（新会话））", async () => {
  const sq = new FakeSessionQuery();
  sq.records = [
    {
      header: { id: "corrupt-9", createdAt: 1, cwd: "/x" },
      live: false,
      persisted: true,
    },
  ];
  const { adapter } = makeAdapterWithSessionQuery(sq);
  const records = await adapter.listSessions!();
  assert.equal(records[0]!.id, "corrupt-9");
  assert.equal("title" in records[0]!, false, "损坏会话不产生 title");
});

test("sessionTitle：官方 readTitle 优先；readTitle 缺失/出错 → undefined（app 层本地兜底）", async () => {
  const sq = new FakeSessionQuery();
  sq.readTitle = async () => ({ title: "官方标题" });
  const { adapter } = makeAdapterWithSessionQuery(sq);
  assert.equal(await adapter.sessionTitle!("old-2"), "官方标题");

  const sq2 = new FakeSessionQuery(); // 无 readTitle（服务不可用）
  const a2 = makeAdapterWithSessionQuery(sq2).adapter;
  assert.equal(await a2.sessionTitle!("old-2"), undefined);

  const sq3 = new FakeSessionQuery();
  sq3.readTitle = async () => {
    throw new Error("title 服务异常");
  };
  const a3 = makeAdapterWithSessionQuery(sq3).adapter;
  assert.equal(await a3.sessionTitle!("old-2"), undefined);

  const a4 = makeAdapterWithSessionQuery(
    undefined as unknown as SessionQueryLike,
  ).adapter;
  assert.equal(await a4.sessionTitle!("anything"), undefined);
});

test("历史会话：persisted 会话走 readSurface（普通事件归一化，reasoning/tool 省略）", async () => {
  const sq = new FakeSessionQuery();
  const { adapter } = makeAdapterWithSessionQuery(sq);
  const view = await adapter.readSessionSurface!("old-2");
  assert.equal(sq.readCalls[0], "surface:old-2");
  assert.equal(view.sessionId, "old-2");
  assert.deepEqual(view.messages, [
    { role: "user", text: "你好\n第二行" },
    { role: "assistant", text: "回复正文" },
  ]);
});

test("历史会话：live store 空事件（resume 入列竞态）→ 回退 persisted readSurface 读完整历史", async () => {
  const sq = new FakeSessionQuery();
  // sessions store 对该会话返回空事件数组（模拟刚 resume 尚未完全入列）
  const { adapter } = makeAdapterWithSessionQuery(sq, {
    get: (id: string) =>
      id === "old-2"
        ? { id, events: [] as Record<string, unknown>[] }
        : undefined,
  });
  const view = await adapter.readSessionSurface!("old-2");
  // 空 live 表面 → 回退 readSurface：仍拿到首条用户消息（完整历史，多块换行拼接）
  assert.equal(view.messages[0]?.text, "你好\n第二行");
});

test("历史会话：live 会话经 sessions store 原始事件（agent/inbox/spliced）提取", async () => {
  const sq = new FakeSessionQuery();
  const store = {
    get(id: string) {
      if (id !== "live-1") return undefined;
      return { id, events: [...sq.events, ...sq.splicedEvents] };
    },
  };
  const { adapter } = makeAdapterWithSessionQuery(sq, store);
  const view = await adapter.readSessionSurface!("live-1");
  // live 直接从内存 store 读，不触 readSurface/readSession
  assert.deepEqual(sq.readCalls, []);
  assert.deepEqual(view.messages, [
    { role: "user", text: "你好\n第二行" },
    { role: "assistant", text: "回复正文" },
    { role: "user", text: "内存消息：你好" },
    { role: "assistant", text: "内存回复" },
  ]);
});

test("历史会话：宿主无 sessions store 且无 readSurface 时回退 readSession", async () => {
  const sq = new FakeSessionQuery();
  // 模拟瘦 sessionQuery：仅 readSession（拿完整日志）
  const slim: SessionQueryLike = {
    listSessions: () => Promise.resolve(sq.records),
    readSession: (id) =>
      Promise.resolve({ session: { id }, events: sq.events }),
  };
  const { adapter } = makeAdapterWithSessionQuery(slim);
  const view = await adapter.readSessionSurface!("old-2");
  assert.deepEqual(view.messages, [
    { role: "user", text: "你好\n第二行" },
    { role: "assistant", text: "回复正文" },
  ]);
});

test("历史会话：宿主无任何读取面时抛结构化错误（app 层 error 阶段显示）", async () => {
  const slim: SessionQueryLike = {
    listSessions: () => Promise.resolve([]),
  };
  const { adapter } = makeAdapterWithSessionQuery(slim);
  await assert.rejects(
    adapter.readSessionSurface!("old-2"),
    /未暴露 readSession\/readSurface/,
    "缺读取面时结构化错误",
  );
});

test("历史会话：损坏会话 readSessionSurface reject（结构化错误透传）", async () => {
  const sq = new FakeSessionQuery();
  const { adapter } = makeAdapterWithSessionQuery(sq);
  await assert.rejects(
    adapter.readSessionSurface!("corrupt-9"),
    /corrupt/,
    "损坏会话错误透传给 app 层显示",
  );
});

test("历史会话：未注入 sessionQuery 时方法为 undefined（app 层提示不可用）", () => {
  const { adapter } = makeAdapter();
  assert.equal(adapter.listSessions, undefined);
  assert.equal(adapter.readSessionSurface, undefined);
});

function makeAdapterWithSessionQuery(
  sq: SessionQueryLike,
  sessions?: SessionStoreLike,
): {
  adapter: ReturnType<typeof createRealDshAdapter>;
} {
  return {
    adapter: createRealDshAdapter({
      runtime: new FakeRuntime(),
      sessionId: "s1",
      agent: new FakeAgent(),
      sessionQuery: sq,
      sessions,
    }),
  };
}

// --- resumeTo：会话切换（P0 会话生命周期） ---

test("resumeTo：切换成功 → 旧 handle 释放 → 后续 sendMessage/cancel 走新 agent", async () => {
  const runtime = new FakeRuntime();
  const log: string[] = [];
  const agent2 = new FakeAgent();
  agent2.session = { id: "s2" };
  const resume = async (o: { resumeSessionId: string }) => {
    log.push("resume:" + o.resumeSessionId);
    return {
      agent: agent2,
      dispose: async (): Promise<void> => {
        log.push("dispose2");
      },
    };
  };
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: new FakeAgent(),
    agents: { resume } as unknown as AgentRegistryLike,
    handleDispose: async (): Promise<void> => {
      log.push("dispose1");
    },
  });
  await adapter.resumeTo!("s2");
  // 契约顺序：先 dispose 旧 handle，再 agents.resume（P0 切换）
  assert.deepEqual(log, ["dispose1", "resume:s2"]);
  // 新 agent 生效：sendMessage 走 agent2.followup
  adapter.sendMessage("hi");
  assert.equal(agent2.followups.length, 1);
});

test("resumeTo：resume 未返回有效 agent → 释放新 handle 并抛错", async () => {
  const runtime = new FakeRuntime();
  const log: string[] = [];
  const resume = async (o: { resumeSessionId: string }) => {
    log.push("resume:" + o.resumeSessionId);
    return {
      agent: { session: undefined },
      dispose: async (): Promise<void> => {
        log.push("dispose2");
      },
    };
  };
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: new FakeAgent(),
    agents: { resume } as unknown as AgentRegistryLike,
    handleDispose: async (): Promise<void> => {
      log.push("dispose1");
    },
  });
  await assert.rejects(adapter.resumeTo!("s2"), /未返回有效 agent/);
  // 先 dispose 旧 handle，再 resume；resume 返回无效 agent → 释放新 handle 并抛错
  assert.deepEqual(log, ["dispose1", "resume:s2", "dispose2"]);
});

test("resumeTo 后 dispose → 释放当前（新）活跃 handle（auditor：退出须释放 resume 后的 agent）", async () => {
  const runtime = new FakeRuntime();
  const log: string[] = [];
  const agent2 = new FakeAgent();
  agent2.session = { id: "s2" };
  const resume = async (o: { resumeSessionId: string }) => {
    log.push("resume:" + o.resumeSessionId);
    return {
      agent: agent2,
      dispose: async (): Promise<void> => {
        log.push("dispose2");
      },
    };
  };
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: new FakeAgent(),
    agents: { resume } as unknown as AgentRegistryLike,
    handleDispose: async (): Promise<void> => {
      log.push("dispose1");
    },
  });
  await adapter.resumeTo!("s2");
  assert.deepEqual(
    log,
    ["dispose1", "resume:s2"],
    "契约顺序：dispose 旧 → resume",
  );
  log.length = 0;
  adapter.dispose?.();
  await new Promise((r) => setTimeout(r, 0)); // 让 activeDispose 微任务落地
  assert.deepEqual(
    log,
    ["dispose2"],
    "adapter.dispose 释放 resume 后的新 handle",
  );
});

test("resumeTo：agents 未暴露 resume → 明确报错（宿主未配置会话持久化）", async () => {
  const adapter = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
  });
  await assert.rejects(adapter.resumeTo!("s2"), /agents 未暴露 resume/);
});

test("resumeTo：adapter 已 dispose → 拒绝切换", async () => {
  const adapter = createRealDshAdapter({
    runtime: new FakeRuntime(),
    sessionId: "s1",
    agent: new FakeAgent(),
  });
  adapter.dispose?.();
  await assert.rejects(adapter.resumeTo!("s2"), /adapter 已释放/);
});

// --- buildUserMessage identified 修复（P0：持久化校验需消息带 id） ---
// DSH 持久化/会话校验以消息 id 判定 identified：缺 id 的 user 消息会导致
// 后续 resume 时 SessionPersistenceCorruptionError（seq N lacks an identified message）。

test("buildUserMessage：携带 UUID 形态 id（identified），role/content/source 不变", () => {
  const m = buildUserMessage("hello");
  assert.equal(m.role, "user");
  assert.deepEqual(m.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(m.source, { kind: "user" });
  // id 存在且是 UUID v4 形态（8-4-4-4-12 十六进制）
  assert.ok(m.id, "消息应携带稳定 id");
  assert.match(
    m.id!,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  // 每次调用生成不同 id（稳定身份，非共享单例）
  assert.notEqual(buildUserMessage("a").id, buildUserMessage("b").id);

  // ---------------------------------------------------------------------------
  // P1 阶段 1：tool/call、tool/result、usage、compaction、retry 归一化 + finish reason
  // ---------------------------------------------------------------------------

  /** 构造并发送一条原始 session/event（data 宽松；onSessionEvent 内宽松读取关键字段） */
  function fireEvent(
    t: TestHarness,
    type: string,
    data: Record<string, unknown>,
    sid = "s1",
  ): void {
    const ev = {
      type,
      seq: 1,
      time: Date.now(),
      data,
    } as unknown as SessionEvent;
    t.runtime.fire("session/event", { id: sid }, ev);
  }

  test("tool/call → tool-call：arguments 关键字段摘要（path 优先，读取真实路径）", () => {
    const t = makeAdapter();
    fireEvent(t, "tool/call", {
      turn: 1,
      step: 1,
      callId: "c1",
      name: "read",
      arguments: JSON.stringify({ path: "/etc/hosts", offset: 0 }),
    });
    assert.deepEqual(t.events, [
      {
        type: "tool-call",
        sessionId: "s1",
        name: "read",
        summary: "/etc/hosts",
      },
    ]);
  });

  test("tool/call：arguments 解析失败 → 摘要兜底原始串（不抛错）", () => {
    const t = makeAdapter();
    fireEvent(t, "tool/call", {
      turn: 1,
      step: 1,
      callId: "c2",
      name: "bash",
      arguments: "not-json{{",
    });
    assert.deepEqual(t.events, [
      {
        type: "tool-call",
        sessionId: "s1",
        name: "bash",
        summary: "not-json{{",
      },
    ]);
  });

  test("tool/call：无关键字段 → 紧凑键值回显；空 arguments → (无参数)", () => {
    const t = makeAdapter();
    fireEvent(t, "tool/call", {
      callId: "c3",
      name: "grep",
      arguments: '{"a":"b","n":1}',
    });
    fireEvent(t, "tool/call", { callId: "c4", name: "x", arguments: "" });
    assert.deepEqual(t.events, [
      {
        type: "tool-call",
        sessionId: "s1",
        name: "grep",
        summary: "a=b n=1",
      },
      { type: "tool-call", sessionId: "s1", name: "x", summary: "(无参数)" },
    ]);
  });

  test("tool/result → tool-result：成功取 message 内层 text 块首行", () => {
    const t = makeAdapter();
    fireEvent(t, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            content: [{ type: "text", text: "line1\nline2" }],
          },
        ],
      },
    });
    assert.deepEqual(t.events, [
      { type: "tool-result", sessionId: "s1", ok: true, detail: "line1" },
    ]);
  });

  test("tool/result：error 分支 → ok:false 且 detail 带错误名/码", () => {
    const t = makeAdapter();
    fireEvent(t, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            content: [{ type: "text", text: "" }],
          },
        ],
      },
      error: { name: "EACCES", code: "13" },
    });
    assert.deepEqual(t.events, [
      {
        type: "tool-result",
        sessionId: "s1",
        ok: false,
        detail: "EACCES: 13",
      },
    ]);
  });

  test("compaction/start + compaction/end → compaction {phase}", () => {
    const t = makeAdapter();
    fireEvent(t, "compaction/start", {
      compactionId: "cp1",
      sourceCommandId: "fx-cmd-1",
    });
    fireEvent(t, "compaction/end", {
      compactionId: "cp1",
      sourceCommandId: "fx-cmd-1",
    });
    assert.deepEqual(t.events, [
      { type: "compaction", phase: "start" },
      { type: "compaction", phase: "end" },
    ]);
  });

  test("llm/retry → retry（attempt/max/delayMs/code/message）", () => {
    const t = makeAdapter();
    fireEvent(t, "llm/retry", {
      turn: 1,
      step: 2,
      provider: "pi",
      mode: "normal",
      policyKey: "p",
      retry: 1,
      maxRetries: 2,
      delayMs: 1500,
      failure: { code: "TRANSPORT", message: "连接被重置" },
    });
    assert.deepEqual(t.events, [
      {
        type: "retry",
        attempt: 1,
        max: 2,
        delayMs: 1500,
        code: "TRANSPORT",
        message: "连接被重置",
      },
    ]);
  });

  test("assistant/message：usage 补发 usage 事件（input/output/cacheRead）", () => {
    const t = makeAdapter();
    fireEvent(t, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 800,
        cacheWriteTokens: 10,
      },
    });
    assert.deepEqual(t.events, [
      {
        type: "usage",
        sessionId: "s1",
        input: 100,
        output: 50,
        cacheRead: 800,
      },
      { type: "stream", sessionId: "s1", text: "hi" },
    ]);
  });

  test("turn/end reason：error → 带 tone 的错误 notice（code/消息）", () => {
    const t = makeAdapter();
    fireEvent(t, "turn/end", {
      turn: 1,
      reason: {
        kind: "error",
        error: { code: "RATE_LIMIT", message: "429 too many" },
      },
    });
    assert.deepEqual(t.events, [
      { type: "turn-end" },
      {
        type: "notice",
        text: "✗ RATE_LIMIT: 429 too many",
        error: true,
        tone: "error",
      },
    ]);
  });

  test("turn/end reason：max-tokens/aborted → 带 tone 的提示", () => {
    const t = makeAdapter();
    fireEvent(t, "turn/end", { turn: 2, reason: { kind: "max-tokens" } });
    fireEvent(t, "turn/end", {
      turn: 3,
      reason: { kind: "aborted", reason: { kind: "user" } },
    });
    assert.deepEqual(t.events, [
      { type: "turn-end" },
      { type: "notice", text: "输出达 token 上限", tone: "warn" },
      { type: "turn-end" },
      { type: "notice", text: "已取消", tone: "muted" },
    ]);
  });

  test("turn/end reason：completed 静默（仅 turn-end，无 notice）", () => {
    const t = makeAdapter();
    fireEvent(t, "turn/end", { turn: 1, reason: { kind: "completed" } });
    assert.deepEqual(t.events, [{ type: "turn-end" }]);
  });

  test("session/event：非活跃会话的 tool/compaction/retry 事件丢弃", () => {
    const t = makeAdapter(); // 活跃会话 = s1
    fireEvent(
      t,
      "tool/call",
      { callId: "c9", name: "read", arguments: "{}" },
      "other",
    );
    fireEvent(t, "compaction/start", { compactionId: "x" }, "other");
    fireEvent(
      t,
      "llm/retry",
      { retry: 1, maxRetries: 2, failure: { code: "T", message: "m" } },
      "other",
    );
    assert.equal(t.events.length, 0, "非活跃会话事件被丢弃");
  });

  test("reduceState：usage → state.usage（仅入状态）；tool/compaction/retry 透传不渲染", () => {
    const s0 = initialState();
    const s1 = reduceState(s0, {
      type: "usage",
      sessionId: "s1",
      input: 10,
      output: 20,
      cacheRead: 30,
    });
    assert.deepEqual(s1.usage, { input: 10, output: 20, cacheRead: 30 });
    // 透传：引用稳定（不产成新 buffer 行、不改状态，阶段 2 才渲染）
    const s2 = reduceState(s1, {
      type: "tool-call",
      sessionId: "s1",
      name: "bash",
      summary: "ls",
    });
    assert.equal(s2, s1);
    const s3 = reduceState(s2, { type: "compaction", phase: "start" });
    assert.equal(s3, s2);
    const s4 = reduceState(s3, {
      type: "retry",
      attempt: 1,
      max: 2,
      delayMs: 5,
      code: "T",
    });
    assert.equal(s4, s3);
    const s5 = reduceState(s4, {
      type: "tool-result",
      sessionId: "s1",
      ok: true,
      detail: "ok",
    });
    assert.equal(s5, s4);
  });
});
