/**
 * 集成层: 本包 `apply` 与宿主接线的验收 —— 工具注册名与参数面、`execute` 的 canonical 值、
 * `output.render` 的投影文本、事件消费者的注入内容、`sessionChannel` 服务面的 provide / get,
 * 以及消息通道 (broker) 与委托任务管理路径.
 *
 * 装配见上一级 `session-channel/tests/assemble.ts` (三个假面: 工具 / 事件 / 服务); 全程不连 Redis、不建
 * socket: 连接态由 `createFakeRedis()` 的内存 broker 经 `SessionChannelDeps.connect` 注入,
 * 再用 `wireLive()` 把 apply 注册的工具与服务面接到这份真服务上. 本包不落盘, 故不建临时目录.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  SERVICE_FACE_METHODS,
  inject,
  name,
  provide,
} from "../../src/index.ts";
import type { Assembly, AssemblyOptions, Live } from "../assemble.ts";
import { assemble, registerAgent, waitFor, wireLive } from "../assemble.ts";

/** 每个用例装配后登记清理, 避免心跳定时器与 reader 循环跨用例累积. */
function open(t: TestContext, options: AssemblyOptions = {}): Assembly {
  const assembly = assemble(options);
  t.after(async () => {
    await assembly.stop();
  });
  return assembly;
}

/** 装配 + 连接态 (假 broker). */
async function openLive(
  t: TestContext,
  options: AssemblyOptions = {},
): Promise<{ assembly: Assembly; live: Live }> {
  const assembly = open(t, options);
  const live = await wireLive(assembly);
  return { assembly, live };
}

/** `sessionChannel` 服务面 (provide 值). */
interface ServiceFace {
  peers(): Promise<{ ok: boolean; peers?: Array<{ sessionId: string }> }>;
  kvSet(
    key: string,
    value: unknown,
    opts?: { expectedVersion?: number; ttlSec?: number },
  ): Promise<{
    ok: boolean;
    entry?: { key: string; value: unknown; version: number };
    error?: string;
    current?: { version: number };
  }>;
  kvGet(key: string): Promise<{ ok: boolean; entry?: { version: number } }>;
  kvList(): Promise<{ ok: boolean; entries?: Array<{ key: string }> }>;
  kvDelete(key: string): Promise<{ ok: boolean; deleted?: boolean }>;
  send(req: {
    to: string;
    text: string;
    from?: string;
    waitMs?: number;
  }): Promise<Record<string, unknown>>;
  status(): { enabled: boolean; connected: boolean };
}

/** 取已提供服务的某方法 (未提供即抛). */
function faceOf(assembly: Assembly): ServiceFace {
  const face = assembly.provided.get("sessionChannel");
  if (face === undefined) throw new Error("未 provide sessionChannel");
  return face as ServiceFace;
}

/** 注入消息 (假 agent 收到的 user 消息) 的文本. */
function injectedText(message: unknown): string {
  const content = (message as { content?: Array<{ text?: unknown }> }).content;
  return String(content?.[0]?.text ?? "");
}

/** 取注入消息的来源标签 (正文形如 `[CHANNEL](来源) 正文`). */
function originOf(text: string): string {
  return /^\[CHANNEL\]\(([^)]*)\)/.exec(text)?.[1] ?? "";
}

test("注册面: apply 注册四个工具、provide 十七个服务方法, 禁用态不订阅事件", (t) => {
  const assembly = open(t);

  assert.equal(name, "session-channel");
  assert.deepEqual(inject, ["tools", "agents", "sessions"]);
  assert.deepEqual(provide, ["sessionChannel"]);

  assert.deepEqual(assembly.tools, [
    "session_channel",
    "channel_delegate",
    "channel_task",
    "channel_task_result",
  ]);
  for (const def of assembly.registered) {
    const parameters = def.parameters as { type?: string; required?: string[] };
    assert.equal(parameters.type, "object", `${def.name} 参数面是对象`);
    assert.ok((parameters.required ?? []).length > 0, `${def.name} 必填项`);
    assert.equal(
      def.output.schema?.["type"],
      "object",
      `${def.name} 出口 schema`,
    );
    assert.equal(
      def.output.schema?.["additionalProperties"],
      true,
      `${def.name} 出口允许附加字段`,
    );
    assert.equal(typeof def.output.render, "function", `${def.name} render`);
  }

  assert.deepEqual(
    [...assembly.provided.keys()],
    ["sessionChannel"],
    "服务面名",
  );
  assert.deepEqual(
    Object.keys(assembly.provided.get("sessionChannel") as object).sort(),
    [...SERVICE_FACE_METHODS].sort(),
    "服务面键集合与 SERVICE_FACE_METHODS 一致",
  );

  assert.deepEqual(assembly.subscriptions, [], "禁用态不连接、不订阅事件");
  assert.deepEqual(assembly.logs, [], "全服务在场时不该有告警");
});

test("canonical 值 (禁用态): 四个工具的失败回执与参数校验", async (t) => {
  const assembly = open(t);
  const asAgent = { agent: { session: { id: "sess-a" } } };

  assert.deepEqual(
    await assembly.call("session_channel", { action: "status" }),
    {
      enabled: false,
      connected: false,
      address: "",
      version: "",
      sessions: [],
      aliasesAuto: 0,
      aliasesFailed: 0,
      error: "已禁用（config.disabled）",
    },
  );

  const disabled = "session-channel 已禁用（config.disabled）";
  for (const args of [
    { action: "peers" },
    { action: "send", to: "sess-b", text: "x" },
    { action: "inbox", sessionId: "sess-b" },
    { action: "state", sessionId: "sess-b" },
    { action: "alias", op: "list" },
  ]) {
    const out = await assembly.call("session_channel", args);
    assert.equal(out["ok"], false, JSON.stringify(args));
    assert.equal(out["error"], disabled, JSON.stringify(args));
  }

  assert.deepEqual(
    await assembly.call("session_channel", { action: "send", to: "sess-b" }),
    { ok: false, error: "send 需要 to 与 text" },
  );
  assert.deepEqual(
    await assembly.call("session_channel", { action: "inbox" }),
    {
      ok: false,
      error: "inbox 需要 sessionId",
    },
  );
  assert.deepEqual(
    await assembly.call("session_channel", { action: "state" }),
    {
      ok: false,
      error: "state 需要 sessionId",
    },
  );
  assert.deepEqual(
    await assembly.call("session_channel", { action: "alias", op: "set" }),
    {
      ok: false,
      error:
        "alias set 需要 name；to 缺省为调用方会话（非 agent 调用方须显式传 to）",
    },
  );
  assert.deepEqual(
    await assembly.call(
      "session_channel",
      { action: "alias", op: "nope" },
      asAgent,
    ),
    { ok: false, error: "未知 alias op: nope（须为 set|list|clear）" },
  );
  assert.deepEqual(await assembly.call("session_channel", { action: "nope" }), {
    error: "未知 action: nope",
  });

  const delegated = await assembly.call(
    "channel_delegate",
    { to: "sess-b", task: "做点事" },
    asAgent,
  );
  assert.deepEqual(delegated, { ok: false, error: disabled });
  assert.deepEqual(
    await assembly.call("channel_task", {
      action: "status",
      taskId: "task-0001",
    }),
    { ok: false, error: disabled },
  );
  assert.deepEqual(await assembly.call("channel_task", { action: "list" }), {
    ok: false,
    error: disabled,
  });
  assert.deepEqual(
    await assembly.call("channel_task", {
      action: "cancel",
      taskId: "task-0001",
    }),
    { ok: false, error: disabled },
  );
  assert.deepEqual(
    await assembly.call("channel_task_result", {
      taskId: "task-0001",
      text: "结果",
    }),
    { ok: false, error: disabled },
  );
});

test("output.render 投影: 四个工具同口径 (对象 JSON / 字符串原样 / undefined 占位)", (t) => {
  const assembly = open(t);
  for (const def of assembly.registered) {
    const blocks = def.output.render({}, { ok: true, value: 1 });
    assert.equal(blocks[0]?.type, "text", `${def.name} 产出 text 块`);
    assert.match(
      String(blocks[0]?.text),
      /"ok": true/,
      `${def.name} 对象 JSON`,
    );
    assert.equal(
      def.output.render({}, "s")[0]?.text,
      "s",
      `${def.name} 字符串原样`,
    );
    assert.equal(
      def.output.render({}, undefined)[0]?.text,
      "undefined",
      `${def.name} undefined 占位`,
    );
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    assert.equal(
      def.output.render({}, circular)[0]?.text,
      "[object Object]",
      `${def.name} 序列化失败兜底 String`,
    );
  }
});

test("事件面: 连接后订阅四类事件, 会话发现与 agent 状态牌可查", async (t) => {
  const { assembly, live } = await openLive(t);
  assert.equal(live.service.status().connected, true);
  assert.deepEqual(assembly.subscriptions.map((item) => item.event).sort(), [
    "agent/created",
    "agent/disposed",
    "agent/status",
    "session/event",
  ]);

  registerAgent(assembly, "sess-a");
  registerAgent(assembly, "sess-b");
  assembly.emit(
    "session/event",
    { id: "sess-a", header: { cwd: "/tmp/a" } },
    { type: "turn-begin" },
  );
  assembly.emit(
    "session/event",
    { id: "sess-b", header: { cwd: "/tmp/b" } },
    { type: "turn-begin" },
  );

  await waitFor(async () => {
    const peers = (await assembly.call("session_channel", {
      action: "peers",
    })) as { peers?: Array<{ sessionId: string }> };
    return peers.peers?.length === 2;
  });
  const status = await assembly.call("session_channel", { action: "status" });
  assert.deepEqual(
    {
      enabled: status["enabled"],
      connected: status["connected"],
      address: status["address"],
      version: status["version"],
      sessions: status["sessions"],
    },
    {
      enabled: true,
      connected: true,
      address: "fake:integration",
      version: "7.0.0-fake",
      sessions: ["sess-a", "sess-b"],
    },
  );

  // agent/status: 状态转换写牌, 同态事件不更新 at
  assembly.emit("agent/status", {
    agent: { session: { id: "sess-b" } },
    status: "running",
  });
  let state: { status?: string; at?: number } | undefined;
  await waitFor(async () => {
    const out = await assembly.call("session_channel", {
      action: "state",
      sessionId: "sess-b",
    });
    state = out["state"] as { status?: string; at?: number } | undefined;
    return state !== undefined;
  });
  assert.equal(state?.status, "running");
  const at = state?.at;
  assert.equal(typeof at, "number");
  assembly.emit("agent/status", {
    agent: { session: { id: "sess-b" } },
    status: "running",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = await assembly.call("session_channel", {
    action: "state",
    sessionId: "sess-b",
  });
  assert.equal((again["state"] as { at?: number }).at, at, "同态不刷 at");

  // agent/created: 初始态; agent/disposed: 删牌
  assembly.emit("agent/created", {
    agent: { session: { id: "sess-c" }, status: "idle" },
  });
  await waitFor(async () => {
    const out = await assembly.call("session_channel", {
      action: "state",
      sessionId: "sess-c",
    });
    return (out["state"] as { status?: string } | undefined)?.status === "idle";
  });
  assembly.emit("agent/disposed", { agent: { session: { id: "sess-c" } } });
  await waitFor(async () => {
    const out = await assembly.call("session_channel", {
      action: "state",
      sessionId: "sess-c",
    });
    return out["state"] === undefined;
  });
});

test("消息通道: send 注入 canonical 正文 + 回执, inbox / alias 可查", async (t) => {
  const { assembly } = await openLive(t);
  registerAgent(assembly, "sess-a");
  registerAgent(assembly, "sess-b");
  const asA = { agent: { session: { id: "sess-a" } } };
  for (const sessionId of ["sess-a", "sess-b"]) {
    assembly.emit(
      "session/event",
      { id: sessionId, header: { cwd: `/tmp/${sessionId}` } },
      { type: "turn-begin" },
    );
  }
  await waitFor(async () => {
    const peers = (await assembly.call("session_channel", {
      action: "peers",
    })) as { peers?: Array<{ sessionId: string }> };
    return peers.peers?.length === 2;
  });

  const sent = (await assembly.call(
    "session_channel",
    { action: "send", to: "sess-b", text: "hello", waitMs: 2000 },
    asA,
  )) as {
    ok: boolean;
    messageId?: string;
    delivered?: boolean;
    target?: { sessionId?: string };
  };
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.delivered, true, JSON.stringify(sent));
  assert.equal(sent.target?.sessionId, "sess-b");
  assert.match(String(sent.messageId), /^\d+-\d+$/);

  await waitFor(() => assembly.injected.length === 1);
  const injected = assembly.injected[0] as {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    source?: { kind?: string };
  };
  assert.equal(injected.role, "user");
  assert.equal(injected.content?.[0]?.type, "text");
  assert.equal(injected.source?.kind, "session-channel");
  assert.match(
    injectedText(injected),
    /^\[CHANNEL\]\((ui-[a-z]{2,8}|sess-a)\) hello$/,
  );
  assert.deepEqual(assembly.flushed, [{ id: "sess-b" }], "注入后 flush 落盘");

  const inbox = (await assembly.call("session_channel", {
    action: "inbox",
    sessionId: "sess-b",
  })) as { ok: boolean; messages?: Array<{ text?: string; from?: string }> };
  assert.equal(inbox.ok, true);
  assert.equal(inbox.messages?.[0]?.text, "hello");
  assert.equal(inbox.messages?.[0]?.from, "sess-a");

  // 别名: set → list → 用别名寻址送达 → clear
  const aliasSet = await assembly.call(
    "session_channel",
    { action: "alias", op: "set", name: "worker", to: "sess-b" },
    asA,
  );
  assert.equal(aliasSet["ok"], true, JSON.stringify(aliasSet));
  const aliasList = (await assembly.call("session_channel", {
    action: "alias",
    op: "list",
  })) as {
    aliases?: Array<{ alias: string; sessionId: string; online: boolean }>;
  };
  assert.deepEqual(
    aliasList.aliases?.find((item) => item.alias === "worker"),
    { alias: "worker", sessionId: "sess-b", online: true },
  );

  const byAlias = (await assembly.call(
    "session_channel",
    { action: "send", to: "worker", text: "别名送达", waitMs: 2000 },
    asA,
  )) as { ok: boolean; delivered?: boolean };
  assert.equal(byAlias.ok, true);
  assert.equal(byAlias.delivered, true);
  await waitFor(() => assembly.injected.length === 2);
  assert.match(
    injectedText(assembly.injected[1]),
    /^\[CHANNEL\]\((ui-[a-z]{2,8}|sess-a)\) 别名送达$/,
  );

  const cleared = await assembly.call("session_channel", {
    action: "alias",
    op: "clear",
    name: "worker",
  });
  assert.deepEqual(cleared, { ok: true, cleared: ["worker"] });
});

test("委托任务: delegate → 注入对位 → 显式回传 → 通知委托方 → 取消", async (t) => {
  const { assembly } = await openLive(t);
  registerAgent(assembly, "sess-a");
  registerAgent(assembly, "sess-b");
  const asA = { agent: { session: { id: "sess-a" } } };
  for (const sessionId of ["sess-a", "sess-b"]) {
    assembly.emit(
      "session/event",
      { id: sessionId, header: { cwd: `/tmp/${sessionId}` } },
      { type: "turn-begin" },
    );
  }
  await waitFor(async () => {
    const peers = (await assembly.call("session_channel", {
      action: "peers",
    })) as { peers?: Array<{ sessionId: string }> };
    return peers.peers?.length === 2;
  });

  const delegated = (await assembly.call(
    "channel_delegate",
    { to: "sess-b", task: "把 X 做掉" },
    asA,
  )) as {
    ok: boolean;
    task?: {
      id: string;
      from: string;
      to: string;
      status: string;
      text: string;
      deadline?: number;
    };
    messageId?: string;
  };
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  const taskId = delegated.task?.id ?? "";
  assert.match(taskId, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(delegated.task?.from, "sess-a");
  assert.equal(delegated.task?.to, "sess-b");
  assert.equal(delegated.task?.status, "pending");
  assert.equal(delegated.task?.text, "把 X 做掉");
  assert.equal(typeof delegated.task?.deadline, "number", "默认超时截止时刻");

  await waitFor(() => assembly.injected.length === 1);
  const taskText = injectedText(assembly.injected[0]);
  assert.match(
    taskText,
    new RegExp(`^\\[CHANNEL\\]\\([^)]*\\) TASK ${taskId}: 把 X 做掉`),
  );

  // user/message: 注入对位 → running + triggerSeq
  assembly.emit(
    "session/event",
    { id: "sess-b" },
    {
      type: "user/message",
      seq: 7,
      data: { content: [{ type: "text", text: taskText }] },
    },
  );
  await waitFor(async () => {
    const out = await assembly.call("channel_task", {
      action: "status",
      taskId,
    });
    return (
      (out["task"] as { status?: string } | undefined)?.status === "running"
    );
  });
  const running = (await assembly.call("channel_task", {
    action: "status",
    taskId,
  })) as { ok: boolean; task?: { triggerSeq?: number } };
  assert.equal(running.ok, true);
  assert.equal(running.task?.triggerSeq, 7);

  const listed = (await assembly.call("channel_task", {
    action: "list",
    sessionId: "sess-a",
  })) as { ok: boolean; tasks?: Array<{ id: string }> };
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.tasks?.map((task) => task.id),
    [taskId],
  );

  // 显式回传优先, 结果通知经消息通道回到委托方
  const result = (await assembly.call("channel_task_result", {
    taskId,
    text: "结果正文",
  })) as { ok: boolean; task?: { status?: string; result?: string } };
  assert.equal(result.ok, true);
  assert.equal(result.task?.status, "done");
  await waitFor(() => assembly.injected.length === 2);
  assert.match(
    injectedText(assembly.injected[1]),
    new RegExp(`^\\[CHANNEL\\]\\([^)]*\\) RESULT ${taskId}: 结果正文$`),
  );
  const finalStatus = (await assembly.call("channel_task", {
    action: "status",
    taskId,
  })) as { task?: { resultSource?: string } };
  assert.equal(finalStatus.task?.resultSource, "tool");

  // 终态不可取消: cancel 原样返回
  const cancelDone = (await assembly.call("channel_task", {
    action: "cancel",
    taskId,
  })) as { ok: boolean; task?: { status?: string } };
  assert.equal(cancelDone.ok, true);
  assert.equal(cancelDone.task?.status, "done");

  // 非终态可取消
  const second = (await assembly.call(
    "channel_delegate",
    { to: "sess-b", task: "第二件事" },
    asA,
  )) as { ok: boolean; task?: { id: string } };
  assert.equal(second.ok, true);
  const canceled = (await assembly.call("channel_task", {
    action: "cancel",
    taskId: second.task?.id,
  })) as { ok: boolean; task?: { status?: string; error?: string } };
  assert.equal(canceled.ok, true);
  assert.equal(canceled.task?.status, "canceled");
  assert.equal(canceled.task?.error, "已被委托方取消");
});

test("委托任务: worker 轮末自动回收结果并通知委托方", async (t) => {
  const { assembly } = await openLive(t);
  registerAgent(assembly, "sess-a");
  registerAgent(assembly, "sess-b");
  const asA = { agent: { session: { id: "sess-a" } } };
  for (const sessionId of ["sess-a", "sess-b"]) {
    assembly.emit(
      "session/event",
      { id: sessionId, header: { cwd: `/tmp/${sessionId}` } },
      { type: "turn-begin" },
    );
  }
  await waitFor(async () => {
    const peers = (await assembly.call("session_channel", {
      action: "peers",
    })) as { peers?: Array<{ sessionId: string }> };
    return peers.peers?.length === 2;
  });

  const delegated = (await assembly.call(
    "channel_delegate",
    { to: "sess-b", task: "自动回收这件事" },
    asA,
  )) as { ok: boolean; task?: { id: string } };
  assert.equal(delegated.ok, true);
  const taskId = delegated.task?.id ?? "";
  await waitFor(() => assembly.injected.length === 1);
  const taskText = injectedText(assembly.injected[0]);

  assembly.emit(
    "session/event",
    { id: "sess-b" },
    {
      type: "user/message",
      seq: 11,
      data: { content: [{ type: "text", text: taskText }] },
    },
  );
  await waitFor(async () => {
    const out = await assembly.call("channel_task", {
      action: "status",
      taskId,
    });
    return (
      (out["task"] as { status?: string } | undefined)?.status === "running"
    );
  });

  assembly.emit(
    "session/event",
    {
      id: "sess-b",
      deriveMessages: () => [
        { role: "user", content: [{ type: "text", text: "忽略" }] },
        { role: "assistant", content: [{ type: "text", text: "自动回答" }] },
      ],
    },
    { type: "turn/end" },
  );
  await waitFor(async () => {
    const out = await assembly.call("channel_task", {
      action: "status",
      taskId,
    });
    return (out["task"] as { status?: string } | undefined)?.status === "done";
  });
  const done = (await assembly.call("channel_task", {
    action: "status",
    taskId,
  })) as { task?: { result?: string; resultSource?: string } };
  assert.equal(done.task?.result, "自动回答");
  assert.equal(done.task?.resultSource, "auto");

  await waitFor(() => assembly.injected.length === 2);
  assert.match(
    injectedText(assembly.injected[1]),
    new RegExp(`^\\[CHANNEL\\]\\([^)]*\\) RESULT ${taskId}: 自动回答$`),
  );
});

test("服务面: provide 面经 get 注入生效, KV 版本 / CAS / 删除 canonical", async (t) => {
  const { assembly } = await openLive(t);
  const face = faceOf(assembly);
  assert.equal(face.status().connected, true);

  registerAgent(assembly, "sess-a");
  assembly.emit(
    "session/event",
    { id: "sess-a", header: { cwd: "/tmp/session-face" } },
    { type: "turn-begin" },
  );
  await waitFor(async () => (await face.peers()).peers?.length === 1);

  // 服务面 send: 与工具面同一份实现 (canonical 回执)
  const sent = await face.send({
    to: "sess-a",
    text: "经服务面",
    from: "sess-a",
    waitMs: 2000,
  });
  assert.equal(sent["ok"], true);
  assert.equal(sent["delivered"], true);
  await waitFor(() => assembly.injected.length === 1);
  assert.match(injectedText(assembly.injected[0]), /经服务面$/);

  // 共享 KV: 写入 → 版本自增 → CAS 冲突 → 读取 / 列举 / 删除
  const first = await face.kvSet("demo.key", { a: 1 });
  assert.deepEqual(
    { ok: first.ok, key: first.entry?.key, version: first.entry?.version },
    { ok: true, key: "demo.key", version: 1 },
  );
  assert.deepEqual(first.entry?.value, { a: 1 });
  const second = await face.kvSet("demo.key", { a: 2 }, { expectedVersion: 1 });
  assert.equal(second.entry?.version, 2);
  const conflict = await face.kvSet(
    "demo.key",
    { a: 3 },
    { expectedVersion: 1 },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "kv_conflict");
  assert.equal(conflict.current?.version, 2);

  assert.equal((await face.kvGet("demo.key")).entry?.version, 2);
  assert.deepEqual(
    (await face.kvList()).entries?.map((entry) => entry.key),
    ["demo.key"],
  );
  assert.deepEqual(await face.kvDelete("demo.key"), {
    ok: true,
    deleted: true,
  });
  assert.equal((await face.kvGet("demo.key")).entry, undefined);
});

test("降级: 无工具面只告警且服务面仍提供, 无 provide 面不抛", async (t) => {
  const assembly = open(t, { tools: false });
  assert.deepEqual(assembly.tools, []);
  assert.equal(
    assembly.logs.some((line) => line.includes("tools 未挂载")),
    true,
  );
  assert.equal(assembly.provided.has("sessionChannel"), true);

  const bare = open(t, { tools: false, provide: false });
  assert.deepEqual(bare.tools, []);
  assert.deepEqual([...bare.provided.keys()], []);
});
