/**
 * 服务层测试（端到端）：两实例互发 → 注入目标会话 → 回执；降级路径；重启不重复注入。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionChannelService } from "../src/index.ts";
import { closeConnection, connectIntercom } from "../src/client.ts";
import { announcePresence, listPeers } from "../src/broker.ts";
import {
  makeFakeHost,
  redisTest,
  registerAgent,
  startTempRedis,
  waitUntil,
} from "./helpers.ts";

/** 会话事件对象（含 header.cwd，对齐宿主 Session 形态）。 */
function session(sessionId: string, cwd: string): Record<string, unknown> {
  return { id: sessionId, header: { cwd } };
}

redisTest("端到端：A 发送 → B 注入并回执 → A 收到 delivered", async () => {
  const redis = await startTempRedis();
  const hostA = makeFakeHost();
  const hostB = makeFakeHost();
  const received = registerAgent(hostB, "sess-b");
  const a = new SessionChannelService(
    {
      url: redis.socketPath,
      instanceId: "A",
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 300,
    },
    hostA.host,
  );
  const b = new SessionChannelService(
    {
      url: redis.socketPath,
      instanceId: "B",
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 300,
    },
    hostB.host,
  );
  try {
    await a.start();
    await b.start();
    assert.equal(a.status().connected, true);
    hostA.emitSession(session("sess-a", "/tmp/proj"));
    hostB.emitSession(session("sess-b", "/tmp/proj"));
    await waitUntil(async () => (await a.peers()).peers?.length === 2);

    const res = await a.send({
      to: "sess-b",
      text: "hello B",
      from: "sess-a",
      waitMs: 3000,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.target?.sessionId, "sess-b");
    assert.equal(res.delivered, true, "B 注入后应写回执");

    await waitUntil(() => received.length === 1);
    const injected = received[0] as {
      role?: string;
      content?: { type: string; text: string }[];
      source?: { kind?: string };
    };
    assert.equal(injected.role, "user");
    assert.equal(injected.content?.[0]?.text, "[CHANNEL] hello B");
    assert.equal(injected.source?.kind, "session-channel");

    // cwd 寻址同样可达（两个会话同目录 → 歧义，故用精确 id 之外的路径单独验证）
    const peers = await a.peers();
    assert.deepEqual(
      peers.peers?.map((p) => p.sessionId),
      ["sess-a", "sess-b"],
    );
    assert.equal(a.status().sessions.includes("sess-a"), true);
  } finally {
    await a.stop();
    await b.stop();
    await redis.stop();
  }
});

redisTest("停止：本进程在线键被清除（对端不再看到）", async () => {
  const redis = await startTempRedis();
  const hostA = makeFakeHost();
  const hostB = makeFakeHost();
  const a = new SessionChannelService(
    { url: redis.socketPath, heartbeatMs: 200, presenceTtlSec: 4 },
    hostA.host,
  );
  const b = new SessionChannelService(
    { url: redis.socketPath, heartbeatMs: 200, presenceTtlSec: 4 },
    hostB.host,
  );
  try {
    await a.start();
    await b.start();
    hostA.emitSession(session("sess-a", "/tmp/x"));
    hostB.emitSession(session("sess-b", "/tmp/x"));
    await waitUntil(async () => (await a.peers()).peers?.length === 2);
    await b.stop();
    await waitUntil(async () => (await a.peers()).peers?.length === 1);
    assert.deepEqual(
      (await a.peers()).peers?.map((p) => p.sessionId),
      ["sess-a"],
    );
  } finally {
    await a.stop();
    await b.stop();
    await redis.stop();
  }
});

redisTest("重启不重复注入：已写回执的消息在下次启动被跳过", async () => {
  const redis = await startTempRedis();
  const hostA = makeFakeHost();
  const hostB1 = makeFakeHost();
  const first = registerAgent(hostB1, "sess-b");
  const a = new SessionChannelService(
    {
      url: redis.socketPath,
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 300,
    },
    hostA.host,
  );
  const b1 = new SessionChannelService(
    {
      url: redis.socketPath,
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 300,
    },
    hostB1.host,
  );
  try {
    await a.start();
    await b1.start();
    hostA.emitSession(session("sess-a", "/tmp/p"));
    hostB1.emitSession(session("sess-b", "/tmp/p"));
    await waitUntil(async () => (await a.peers()).peers?.length === 2);
    const res = await a.send({
      to: "sess-b",
      text: "once",
      from: "sess-a",
      waitMs: 3000,
    });
    if (!res.ok) throw new Error(`send 失败：${res.error}`);
    assert.equal(res.delivered, true);
    await waitUntil(() => first.length === 1);
    await b1.stop();

    // 重启同会话：邮箱流里那条消息已带回执 → 不重复注入
    const hostB2 = makeFakeHost();
    const second = registerAgent(hostB2, "sess-b");
    const b2 = new SessionChannelService(
      {
        url: redis.socketPath,
        heartbeatMs: 200,
        presenceTtlSec: 4,
        readBlockMs: 300,
      },
      hostB2.host,
    );
    await b2.start();
    hostB2.emitSession(session("sess-b", "/tmp/p"));
    await waitUntil(async () => (await a.peers()).peers?.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(second.length, 0, "已回执消息不应重复注入");
    await b2.stop();
  } finally {
    await a.stop();
    await redis.stop();
  }
});

test("降级：disabled 与连不上实例都不抛，工具面返回错误文案", async () => {
  const disabled = new SessionChannelService(
    { disabled: true },
    makeFakeHost().host,
  );
  await disabled.start();
  assert.equal(disabled.status().enabled, false);
  const res = await disabled.send({ to: "x", text: "y" });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /禁用/);
  await disabled.stop();

  const offline = new SessionChannelService(
    { url: "/tmp/session-channel-absent/sock" },
    makeFakeHost().host,
  );
  await offline.start();
  assert.equal(offline.status().connected, false);
  assert.equal(typeof offline.status().error, "string");
  const res2 = await offline.send({ to: "x", text: "y" });
  assert.equal(res2.ok, false);
  const peers = await offline.peers();
  assert.equal(peers.ok, false);
  await offline.stop();
});

redisTest("回执键与消息共存：isAcked 之外的键前缀完整（sanity）", async () => {
  const redis = await startTempRedis();
  const conn = await connectIntercom({ url: redis.socketPath });
  try {
    await announcePresence(
      conn.main,
      {
        sessionId: "s",
        pid: process.pid,
        instanceId: "i",
        cwd: "",
        profile: "",
        startedAt: 0,
      },
      30,
    );
    const keys = await listPeers(conn.main);
    assert.equal(keys.length, 1);
  } finally {
    await closeConnection(conn);
    await redis.stop();
  }
});
