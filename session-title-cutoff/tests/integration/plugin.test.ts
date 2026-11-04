// session-title-cutoff 集成层：经假宿主调 `apply`，断言唯一标题 provider 的注册契约、
// `all-prompts` 触发不变、参考窗口取最近一次 `git commit` 之后、无提交回退与失败路径。
// 装配器见 `session-title-cutoff/tests/assemble.ts`。

import assert from "node:assert/strict";
import { test } from "node:test";

import { assemble } from "../assemble.ts";

/** 构造一条提交类工具调用事件（假 git 提交面投递用）。 */
function commitEvent(seq: number, command = "git commit -m x") {
  return {
    seq,
    type: "tool/call",
    data: { arguments: JSON.stringify({ command }) },
  };
}

/** 三步人类消息（序号故意不连续，模拟工具调用占号）。 */
const MESSAGES = [
  { seq: 1, text: "第一条" },
  { seq: 5, text: "提交前" },
  { seq: 7, text: "提交本身" },
  { seq: 9, text: "提交后" },
];

// ---------------------------------------------------------------------------
// 服务面注册
// ---------------------------------------------------------------------------

test("apply: 向 sessionTitle 注册唯一 provider，id 与触发策略为契约值", async () => {
  const host = await assemble();
  const provider = host.provider();
  assert.equal(provider.id, "session-title-cutoff");
  assert.equal(provider.automatic, "all-prompts");
  assert.equal(typeof provider.generate, "function");
  assert.equal(
    host.events.listenerCount("session/event"),
    1,
    "订阅一次提交记账",
  );
  assert.deepEqual(host.tools.names(), [], "本包不注册工具");
  assert.deepEqual(host.warnings, []);
  assert.deepEqual(host.stderr, []);
});

test("apply: 已有 provider 占位时告警且不覆盖", async () => {
  const host = await assemble({ registerFails: true });
  assert.equal(host.providerOrUndefined(), undefined);
  assert.match(host.warnings.join("\n"), /注册失败.*exists/);
});

test("apply: 无 sessionTitle 服务时告警、不抛、不订阅事件", async () => {
  const host = await assemble({ noTitleService: true });
  assert.equal(host.providerOrUndefined(), undefined);
  assert.match(host.warnings.join("\n"), /ctx\.sessionTitle 不可用/);
  assert.equal(host.events.listenerCount(), 0);
});

test("apply: helper 不可用（缺 execute 形态）时告警且不注册", async () => {
  const host = await assemble({
    helper: {
      resolveSessionTitleLlmConfig: () => ({}),
      generateSessionTitleWithLlm: async () => ({}),
    },
  });
  assert.equal(host.providerOrUndefined(), undefined);
  assert.match(host.warnings.join("\n"), /executeSessionTitleLlm/);
});

// ---------------------------------------------------------------------------
// 参考窗口
// ---------------------------------------------------------------------------

test("generate: 无提交记录时窗口回退全量", async () => {
  const host = await assemble();
  await host.provider().generate({ session: { id: "s1" }, messages: MESSAGES });
  assert.deepEqual(host.calls[0]?.prepared.messageSeqs, [1, 5, 7, 9]);
  assert.deepEqual(host.git.reads(), ["s1"], "缓存为空时读一次会话事件");
});

test("generate: 窗口只取最近一次 git commit 之后的人类消息", async () => {
  const host = await assemble();
  host.emitSessionEvent("s1", commitEvent(6));
  host.emitSessionEvent("s1", {
    seq: 8,
    type: "tool/call",
    data: { arguments: '{"command":"git log --oneline"}' },
  });
  await host.provider().generate({ session: { id: "s1" }, messages: MESSAGES });
  assert.deepEqual(host.calls[0]?.prepared.messageSeqs, [7, 9]);
  assert.deepEqual(host.git.reads(), [], "已有实时记账，不读会话事件");

  // 再次提交后窗口继续推进，旧消息不再入模
  host.emitSessionEvent("s1", commitEvent(7));
  await host.provider().generate({ session: { id: "s1" }, messages: MESSAGES });
  assert.deepEqual(host.calls[1]?.prepared.messageSeqs, [9]);
});

test("generate: 提交之后没有新消息时回退全量", async () => {
  const host = await assemble();
  host.emitSessionEvent("s1", commitEvent(9));
  await host.provider().generate({ session: { id: "s1" }, messages: MESSAGES });
  assert.deepEqual(host.calls[0]?.prepared.messageSeqs, [1, 5, 7, 9]);
});

test("generate: 命令里只是提到 git commit 不算提交", async () => {
  const host = await assemble();
  host.emitSessionEvent("s1", {
    seq: 6,
    type: "tool/call",
    data: {
      arguments: JSON.stringify({ command: 'zstdcat log | grep "git commit"' }),
    },
  });
  await host.provider().generate({ session: { id: "s1" }, messages: MESSAGES });
  assert.deepEqual(host.calls[0]?.prepared.messageSeqs, [1, 5, 7, 9]);
});

test("generate: 记账按会话隔离，别的会话提交不影响本会话", async () => {
  const host = await assemble();
  host.emitSessionEvent("other", commitEvent(8));
  await host.provider().generate({ session: { id: "s1" }, messages: MESSAGES });
  assert.deepEqual(host.calls[0]?.prepared.messageSeqs, [1, 5, 7, 9]);
});

test("generate: 重启后按会话事件重建 cutoff，之后不再重复读", async () => {
  const host = await assemble();
  host.git.seed("s9", [commitEvent(7)]);
  await host.provider().generate({ session: { id: "s9" }, messages: MESSAGES });
  assert.deepEqual(host.calls[0]?.prepared.messageSeqs, [9]);
  assert.deepEqual(host.git.reads(), ["s9"]);

  await host.provider().generate({ session: { id: "s9" }, messages: MESSAGES });
  assert.deepEqual(host.git.reads(), ["s9"], "cutoff 已入缓存，第二次不再读");
});

test("generate: 会话事件不可读或快照畸形时回退全量", async () => {
  const failing = await assemble();
  failing.git.failWith();
  await failing.provider().generate({
    session: { id: "s1" },
    messages: MESSAGES,
  });
  assert.deepEqual(failing.calls[0]?.prepared.messageSeqs, [1, 5, 7, 9]);

  const malformed = await assemble();
  malformed.git.malformed("s1");
  await malformed.provider().generate({
    session: { id: "s1" },
    messages: MESSAGES,
  });
  assert.deepEqual(malformed.calls[0]?.prepared.messageSeqs, [1, 5, 7, 9]);
});

test("generate: 请求缺 session id 时不读会话事件，走全量", async () => {
  const host = await assemble();
  await host.provider().generate({ messages: MESSAGES });
  assert.deepEqual(host.calls[0]?.prepared.messageSeqs, [1, 5, 7, 9]);
  assert.deepEqual(host.git.reads(), []);
});

// ---------------------------------------------------------------------------
// 生成契约
// ---------------------------------------------------------------------------

test("generate: 返回 canonical 值（标题 / 源消息 seq / 模型）", async () => {
  const host = await assemble();
  host.setResponse({
    blocks: [{ type: "text", text: "**真机标题**\n附带说明" }],
    finish: { kind: "stop" },
    model: { id: "deepseek-flash", reasoning: { efforts: [{ id: "high" }] } },
  });
  const result = await host.provider().generate({
    session: { id: "s1" },
    messages: MESSAGES,
  });
  assert.equal(result.title, "真机标题", "走 titleFromResponse 的清洗口径");
  assert.deepEqual(result.messageSeqs, [1, 5, 7, 9]);
  assert.deepEqual(result.model, {
    id: "deepseek-flash",
    reasoning: { efforts: [{ id: "high" }] },
  });
});

test("generate: helper 收到本包 id、执行控制键与原始请求", async () => {
  const host = await assemble({
    config: { targetWords: 9, provider: "tollgate", model: "ds4f" },
  });
  const request = { session: { id: "s1" }, messages: MESSAGES };
  await host.provider().generate(request);
  const call = host.calls[0];
  assert.equal(call?.titleProvider, "session-title-cutoff");
  assert.equal(call?.request, request, "请求对象原样交给 helper");
  assert.deepEqual(Object.keys(call?.config ?? {}).sort(), [
    "maxInputBytes",
    "maxOutputTokens",
    "model",
    "provider",
    "timeoutMs",
  ]);
  assert.ok(Object.isFrozen(call?.config), "helper 返回冻结配置");
  assert.match(
    call?.prepared.system ?? "",
    /9 words in non-CJK languages or 15/,
  );
  assert.match(
    call?.prepared.input ?? "",
    /^Generate the session title from this JSON array of human messages:/,
  );
  assert.match(call?.prepared.input ?? "", /提交后/);
});

test("generate: 触发策略为 all-prompts, 每次调用都产出标题", async () => {
  const host = await assemble();
  const provider = host.provider();
  assert.equal(provider.automatic, "all-prompts");
  await provider.generate({ session: { id: "s1" }, messages: MESSAGES });
  await provider.generate({
    session: { id: "s1" },
    messages: [...MESSAGES, { seq: 11, text: "又来一条" }],
  });
  assert.equal(host.calls.length, 2);
  assert.deepEqual(host.calls[1]?.prepared.messageSeqs, [1, 5, 7, 9, 11]);
});

// ---------------------------------------------------------------------------
// 失败路径
// ---------------------------------------------------------------------------

test("generate: helper 执行失败时原样 reject", async () => {
  const failure = new Error("llm unavailable");
  const host = await assemble({ executeFails: failure });
  await assert.rejects(
    host.provider().generate({ session: { id: "s1" }, messages: MESSAGES }),
    (error: unknown) => error === failure,
  );
});

test("generate: 标题形态非法（tool-calls / max-tokens）时 reject", async () => {
  const toolCalls = await assemble();
  toolCalls.setResponse({
    blocks: [{ type: "text", text: "x" }],
    finish: { kind: "tool-calls" },
  });
  await assert.rejects(
    toolCalls
      .provider()
      .generate({ session: { id: "s1" }, messages: MESSAGES }),
    /must contain text only/,
  );

  const maxTokens = await assemble();
  maxTokens.setResponse({
    blocks: [{ type: "text", text: "x" }],
    finish: { kind: "max-tokens" },
  });
  await assert.rejects(
    maxTokens
      .provider()
      .generate({ session: { id: "s1" }, messages: MESSAGES }),
    /maxOutputTokens/,
  );
});

test("apply: 无 logger 时告警回落 stderr", async () => {
  const host = await assemble({ noLogger: true, noTitleService: true });
  assert.deepEqual(host.warnings, []);
  assert.match(
    host.stderr.join(""),
    /\[session-title-cutoff\] warn: ctx\.sessionTitle 不可用/,
  );
});
