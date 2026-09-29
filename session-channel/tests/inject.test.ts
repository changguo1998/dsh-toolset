/**
 * 注入面回归测试：
 *  - 受保护读取（真实 cordis ctx 直读服务属性会抛，须走 `ctx.get`）；
 *  - 注入后 flush 落盘（与 rule-engine 同口径）；
 *  - 服务级端到端：宿主为「直读抛错 + get 可用」的代理形态时仍能注入。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  injectUserMessage,
  readService,
  type AgentLike,
} from "../src/inject.ts";
import { SessionChannelService } from "../src/index.ts";
import { announcePresence, sendMessage } from "../src/broker.ts";
import { closeConnection, connectSessionChannel } from "../src/client.ts";
import { redisTest, startTempRedis, waitUntil } from "./helpers.ts";

/** 代理型宿主：直读 `agents`/`sessions` 抛错（cordis 未 inject 语义），`get()` 正常。 */
function proxyHost(services: Record<string, unknown>): Record<string, unknown> {
  const host: Record<string, unknown> = {
    logger: () => ({ info: () => {} }),
    get: (name: string) => services[name],
    on: () => () => {},
  };
  for (const name of Object.keys(services)) {
    Object.defineProperty(host, name, {
      get() {
        throw new Error(`cannot get property "${name}" without inject`);
      },
    });
  }
  return host;
}

test("readService：get 优先、直读兜底、两路不可用返回 undefined", () => {
  assert.equal(readService({ get: () => 42 }, "x"), 42);
  assert.equal(readService({ x: 7 }, "x"), 7);
  const throwing = {
    get get() {
      throw new Error('cannot get property "get" without inject');
    },
  };
  assert.equal(readService(throwing, "x"), undefined);
  assert.equal(readService(null, "x"), undefined);
  assert.equal(readService("string", "x"), undefined);
  // 直读抛错但 get 有值（真实宿主形态）
  const agentsSvc = { get: () => undefined };
  const proxied = proxyHost({ agents: agentsSvc });
  assert.equal(
    readService(proxied, "agents"),
    agentsSvc,
    "直读抛错时仍应经 get 取到服务",
  );
});

test("injectUserMessage：推宏任务投递 + 调 flush；无 agent 返回 false", async () => {
  const received: unknown[] = [];
  const flushed: unknown[] = [];
  const agent: AgentLike = {
    session: { id: "s-1" },
    followup: (message) => void received.push(message),
  };
  const host = {
    agents: { get: (id: string) => (id === "s-1" ? agent : undefined) },
    sessions: { flush: (session: unknown) => void flushed.push(session) },
  };
  const ok = injectUserMessage(host, "s-1", {
    id: "m-1",
    role: "user",
    content: [],
  });
  assert.equal(ok, true);
  assert.equal(received.length, 0, "注入应推迟到宏任务");
  await waitUntil(() => received.length === 1);
  assert.deepEqual(flushed, [{ id: "s-1" }], "flush 应带 agent.session");
  assert.equal(injectUserMessage(host, "nope", { id: "m-2" }), false);
});

redisTest("服务级回归：代理宿主（直读抛错）仍能注入并回执", async () => {
  const redis = await startTempRedis();
  const received: unknown[] = [];
  const flushed: unknown[] = [];
  const sessions = new Map<string, AgentLike>();
  sessions.set("sess-p", {
    session: { id: "sess-p" },
    followup: (message) => void received.push(message),
  });
  const host = proxyHost({
    agents: { get: (id: string) => sessions.get(id) },
    sessions: { flush: (session: unknown) => void flushed.push(session) },
  });
  const service = new SessionChannelService(
    {
      url: redis.socketPath,
      heartbeatMs: 200,
      presenceTtlSec: 4,
      readBlockMs: 300,
    },
    host,
  );
  const raw = await connectSessionChannel({ url: redis.socketPath });
  try {
    await service.start();
    assert.equal(service.status().connected, true, "代理宿主不应影响连接");
    // 直接注入在线项 + 触发投递（不经 events，聚焦注入路径）
    await announcePresence(
      raw.main,
      {
        sessionId: "sess-p",
        pid: process.pid,
        instanceId: "raw",
        cwd: "/tmp/p",
        profile: "",
        startedAt: 0,
      },
      60,
    );
    (service as unknown as { noteSession(session: unknown): void }).noteSession(
      {
        id: "sess-p",
        header: { cwd: "/tmp/p" },
      },
    );
    await waitUntil(async () => (await service.peers()).peers?.length === 1);
    const sent = await sendMessage(raw.main, {
      to: "sess-p",
      text: "代理注入",
    });
    assert.equal(sent.ok, true);
    await waitUntil(() => received.length === 1, 5000);
    const msg = received[0] as { content?: { text: string }[] };
    assert.equal(msg.content?.[0]?.text, "[CHANNEL] 代理注入");
    await waitUntil(() => flushed.length === 1);
  } finally {
    await service.stop();
    await closeConnection(raw);
    await redis.stop();
  }
});
