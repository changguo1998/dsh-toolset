/**
 * 传输适配单测：把假 session-channel 服务面（`peers` / `aliasList` / `delegate` /
 * `send` / `taskStatus` / `statusOf`）包成 `GroupTransport` 后，逐条钉住寻址歧义与离线、
 * 投递失败与缺任务 id、发完即走回执、任务状态归一，以及「服务面缺方法」的降级。
 *
 * 全部走结构面，不连 Redis、不起宿主。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSessionChannelTransport,
  isSessionChannelFace,
  type SessionChannelFace,
} from "../src/transport.ts";
import type { GroupFailure } from "../src/types.ts";

/** 假服务面：各方法的返回体与抛错都可注入。 */
function fakeFace() {
  const state = {
    peers: {
      ok: true,
      peers: [] as Array<{ sessionId: string; cwd?: string }>,
    } as Awaited<ReturnType<SessionChannelFace["peers"]>>,
    aliases: {
      ok: true,
      aliases: [] as Array<{
        alias: string;
        sessionId: string;
        online: boolean;
      }>,
    } as Awaited<ReturnType<SessionChannelFace["aliasList"]>>,
    delegate: {
      ok: true,
      task: { id: "task-1" },
    } as Awaited<ReturnType<SessionChannelFace["delegate"]>>,
    send: {
      ok: true,
      delivered: true,
    } as Awaited<ReturnType<SessionChannelFace["send"]>>,
    taskStatus: {
      ok: true,
      task: { status: "running" },
    } as Awaited<ReturnType<SessionChannelFace["taskStatus"]>>,
    statusOf: {
      ok: true,
      state: { status: "running", at: 10 },
    } as Awaited<ReturnType<NonNullable<SessionChannelFace["statusOf"]>>>,
    peersThrows: undefined as Error | undefined,
    aliasThrows: undefined as Error | undefined,
  };
  const calls = {
    delegate: [] as Array<Record<string, unknown>>,
    send: [] as Array<Record<string, unknown>>,
    taskStatus: [] as string[],
    statusOf: [] as string[],
  };
  const face: SessionChannelFace = {
    async peers() {
      if (state.peersThrows !== undefined) throw state.peersThrows;
      return state.peers;
    },
    async aliasList() {
      if (state.aliasThrows !== undefined) throw state.aliasThrows;
      return state.aliases;
    },
    async delegate(request) {
      calls.delegate.push({ ...request });
      return state.delegate;
    },
    async send(request) {
      calls.send.push({ ...request });
      return state.send;
    },
    async taskStatus(taskId) {
      calls.taskStatus.push(taskId);
      return state.taskStatus;
    },
    async statusOf(sessionId) {
      calls.statusOf.push(sessionId);
      return state.statusOf;
    },
  };
  return { face, state, calls };
}

function expectFailure(value: unknown): GroupFailure {
  const failed = value as GroupFailure;
  assert.equal(failed.ok, false, `应为拒绝：${JSON.stringify(failed)}`);
  assert.equal(typeof failed.error, "string");
  assert.notEqual(failed.reason, "");
  assert.notEqual(failed.next, "");
  return failed;
}

test("服务面判据: isSessionChannelFace 只认 delegate + taskStatus 两个方法", () => {
  const { face } = fakeFace();
  assert.equal(isSessionChannelFace(face), true);
  assert.equal(isSessionChannelFace({ delegate: () => {} }), false);
  assert.equal(isSessionChannelFace({ taskStatus: () => {} }), false);
  assert.equal(isSessionChannelFace(null), false);
  assert.equal(isSessionChannelFace("session-channel"), false);
});

test("寻址: 会话 id 精确命中优先于别名表", async () => {
  const { face, state, calls } = fakeFace();
  state.peers = { ok: true, peers: [{ sessionId: "sess-a" }] };
  // 别名表里放一条同名的别名，精确命中时不应被读到
  state.aliases = {
    ok: true,
    aliases: [{ alias: "sess-a", sessionId: "sess-b", online: true }],
  };
  const resolved = await createSessionChannelTransport(face).resolve("sess-a");
  assert.deepEqual(resolved, { ok: true, sessionId: "sess-a" });
  assert.deepEqual(calls.delegate, []);
});

test("寻址: 别名唯一命中且在线 → 解析成会话 id", async () => {
  const { face, state } = fakeFace();
  state.peers = { ok: true, peers: [{ sessionId: "sess-a" }] };
  state.aliases = {
    ok: true,
    aliases: [{ alias: "alice", sessionId: "sess-a", online: true }],
  };
  const resolved = await createSessionChannelTransport(face).resolve("alice");
  assert.deepEqual(resolved, { ok: true, sessionId: "sess-a" });
});

test("寻址: 离线 / 不存在 → target_offline，带在线目标提示", async () => {
  const { face, state } = fakeFace();
  state.peers = { ok: true, peers: [{ sessionId: "sess-a" }] };
  state.aliases = { ok: true, aliases: [] };
  const failed = expectFailure(
    await createSessionChannelTransport(face).resolve("nobody"),
  );
  assert.equal(failed.error, "target_offline");
  assert.match(failed.reason, /nobody/);
});

test("寻址: 别名命中多个会话 → target_ambiguous 并列出会话 id", async () => {
  const { face, state } = fakeFace();
  state.peers = {
    ok: true,
    peers: [{ sessionId: "sess-a" }, { sessionId: "sess-b" }],
  };
  state.aliases = {
    ok: true,
    aliases: [
      { alias: "dup", sessionId: "sess-a", online: true },
      { alias: "dup", sessionId: "sess-b", online: true },
    ],
  };
  const failed = expectFailure(
    await createSessionChannelTransport(face).resolve("dup"),
  );
  assert.equal(failed.error, "target_ambiguous");
  assert.match(failed.reason, /sess-a/);
  assert.match(failed.reason, /sess-b/);
});

test("寻址: 别名指向的会话不在在线集 → target_offline（离线不排队）", async () => {
  const { face, state } = fakeFace();
  state.peers = { ok: true, peers: [] as Array<{ sessionId: string }> };
  state.aliases = {
    ok: true,
    aliases: [{ alias: "alice", sessionId: "sess-a", online: false }],
  };
  const failed = expectFailure(
    await createSessionChannelTransport(face).resolve("alice"),
  );
  assert.equal(failed.error, "target_offline");
  assert.match(failed.reason, /sess-a/);
});

test("寻址: peers 或 aliasList 读失败 → transport_error（带未知原因兜底）", async () => {
  const first = fakeFace();
  first.state.peers = { ok: false };
  const peersFailure = expectFailure(
    await createSessionChannelTransport(first.face).resolve("alice"),
  );
  assert.equal(peersFailure.error, "transport_error");
  assert.match(peersFailure.reason, /未知原因/);

  const second = fakeFace();
  second.state.aliases = { ok: false, error: "redis 断连" };
  const aliasFailure = expectFailure(
    await createSessionChannelTransport(second.face).resolve("alice"),
  );
  assert.equal(aliasFailure.error, "transport_error");
  assert.match(aliasFailure.reason, /redis 断连/);
});

test("寻址: 服务面抛错原样冒泡（端口层不吞异常，由动作层 #guard 兜）", async () => {
  const { face, state } = fakeFace();
  state.peersThrows = new Error("连接被重置");
  await assert.rejects(
    () => createSessionChannelTransport(face).resolve("alice"),
    /连接被重置/,
  );
});

test("投递: 透传 from / to / text / timeoutSec 并回任务 id", async () => {
  const { face, calls } = fakeFace();
  const sent = await createSessionChannelTransport(face).delegate({
    from: "sess-manager",
    to: "sess-alice",
    text: "写一份设计",
    timeoutSec: 600,
  });
  assert.deepEqual(sent, { ok: true, taskId: "task-1" });
  assert.deepEqual(calls.delegate, [
    {
      from: "sess-manager",
      to: "sess-alice",
      text: "写一份设计",
      timeoutSec: 600,
    },
  ]);
});

test("投递: 失败信封原样带过，candidates 只在给出时附上", async () => {
  const withCandidates = fakeFace();
  withCandidates.state.delegate = {
    ok: false,
    error: "target_ambiguous",
    message: "别名命中多个会话",
    candidates: [{ sessionId: "sess-a" }],
  };
  const failed = expectFailure(
    await createSessionChannelTransport(withCandidates.face).delegate({
      from: "sess-manager",
      to: "alice",
      text: "x",
      timeoutSec: 60,
    }),
  );
  assert.equal(failed.error, "target_ambiguous");
  assert.equal(failed.reason, "别名命中多个会话");
  assert.deepEqual(failed["candidates"], [{ sessionId: "sess-a" }]);

  const withoutMessage = fakeFace();
  withoutMessage.state.delegate = { ok: false };
  const minimal = expectFailure(
    await createSessionChannelTransport(withoutMessage.face).delegate({
      from: "sess-manager",
      to: "alice",
      text: "x",
      timeoutSec: 60,
    }),
  );
  assert.equal(minimal.error, "transport_error");
  assert.equal("candidates" in minimal, false);
});

test("投递: 返回体缺 task.id → transport_error（不把空 id 当成功）", async () => {
  const { face, state } = fakeFace();
  state.delegate = { ok: true };
  const failed = expectFailure(
    await createSessionChannelTransport(face).delegate({
      from: "sess-manager",
      to: "sess-alice",
      text: "x",
      timeoutSec: 60,
    }),
  );
  assert.equal(failed.error, "transport_error");
  assert.match(failed.reason, /任务 id/);
});

test("发完即走: send 固定 waitMs 1200，回执按 delivered 归一", async () => {
  const { face, state, calls } = fakeFace();
  const delivered = await createSessionChannelTransport(face).sendMessage({
    to: "sess-bob",
    text: "下午同步",
  });
  assert.deepEqual(delivered, { ok: true, delivered: true });
  assert.deepEqual(calls.send, [
    { to: "sess-bob", text: "下午同步", waitMs: 1200 },
  ]);

  state.send = { ok: true };
  const notDelivered = await createSessionChannelTransport(face).sendMessage({
    to: "sess-bob",
    text: "下午同步",
  });
  assert.deepEqual(notDelivered, { ok: true, delivered: false });
});

test("发完即走: 失败信封带原因与 candidates", async () => {
  const { face, state } = fakeFace();
  state.send = { ok: false, error: "target_offline", candidates: ["sess-x"] };
  const failed = expectFailure(
    await createSessionChannelTransport(face).sendMessage({
      to: "sess-bob",
      text: "x",
    }),
  );
  assert.equal(failed.error, "target_offline");
  assert.match(failed.reason, /target_offline/);
  assert.deepEqual(failed["candidates"], ["sess-x"]);
});

test("任务读取: 状态原样归一，可选字段只在给出时保留", async () => {
  const { face, state, calls } = fakeFace();
  state.taskStatus = {
    ok: true,
    task: {
      status: "done",
      result: "设计在这",
      error: "ignored",
      resultTruncated: true,
    },
  };
  const snapshot = await createSessionChannelTransport(face).taskStatus("t-1");
  assert.deepEqual(snapshot, {
    ok: true,
    task: {
      status: "done",
      result: "设计在这",
      error: "ignored",
      resultTruncated: true,
    },
  });
  assert.deepEqual(calls.taskStatus, ["t-1"]);

  state.taskStatus = { ok: true, task: { status: "running" } };
  const minimal = await createSessionChannelTransport(face).taskStatus("t-1");
  assert.deepEqual(minimal, { ok: true, task: { status: "running" } });
});

test("任务读取: task_not_found / 通用失败 / 未知状态各有稳定错误码", async () => {
  const notFound = fakeFace();
  notFound.state.taskStatus = { ok: false, error: "task_not_found" };
  const missing = expectFailure(
    await createSessionChannelTransport(notFound.face).taskStatus("t-1"),
  );
  assert.equal(missing.error, "task_not_found");
  assert.match(missing.next, /TTL 7 天/);

  const broken = fakeFace();
  broken.state.taskStatus = { ok: false };
  const generic = expectFailure(
    await createSessionChannelTransport(broken.face).taskStatus("t-1"),
  );
  assert.equal(generic.error, "transport_error");
  assert.match(generic.reason, /未知原因/);

  const unknown = fakeFace();
  unknown.state.taskStatus = { ok: true, task: { status: "weird" } };
  const invalid = expectFailure(
    await createSessionChannelTransport(unknown.face).taskStatus("t-1"),
  );
  assert.equal(invalid.error, "transport_error");
  assert.match(invalid.reason, /weird/);
});

test("在线集: peers 归成 sessionId 列表；读失败 → transport_error", async () => {
  const { face, state } = fakeFace();
  state.peers = {
    ok: true,
    peers: [{ sessionId: "sess-a" }, { sessionId: "sess-b", cwd: "/x" }],
  };
  const online = await createSessionChannelTransport(face).peers();
  assert.deepEqual(online, { ok: true, sessionIds: ["sess-a", "sess-b"] });

  state.peers = { ok: false, error: "redis 断连" };
  const failed = expectFailure(
    await createSessionChannelTransport(face).peers(),
  );
  assert.equal(failed.error, "transport_error");
  assert.match(failed.reason, /redis 断连/);
});

test("状态牌: 有牌读牌、无牌按缺省（缺 state 字段）", async () => {
  const { face, state, calls } = fakeFace();
  const withState =
    await createSessionChannelTransport(face).statusOf("sess-a");
  assert.deepEqual(withState, {
    ok: true,
    state: { status: "running", at: 10 },
  });
  assert.deepEqual(calls.statusOf, ["sess-a"]);

  state.statusOf = { ok: true };
  const bare = await createSessionChannelTransport(face).statusOf("sess-b");
  assert.deepEqual(bare, { ok: true });
});

test("状态牌: 旧版服务面没有 statusOf → transport_error 并提示升版本", async () => {
  const { face } = fakeFace();
  delete face.statusOf;
  const failed = expectFailure(
    await createSessionChannelTransport(face).statusOf("sess-a"),
  );
  assert.equal(failed.error, "transport_error");
  assert.match(failed.reason, /statusOf/);
});

test("状态牌: 读失败 → transport_error（带原因）", async () => {
  const { face, state } = fakeFace();
  state.statusOf = { ok: false, error: "读超时" };
  const failed = expectFailure(
    await createSessionChannelTransport(face).statusOf("sess-a"),
  );
  assert.equal(failed.error, "transport_error");
  assert.match(failed.reason, /读超时/);
});
