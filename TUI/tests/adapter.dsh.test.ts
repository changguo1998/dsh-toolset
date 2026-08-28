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
