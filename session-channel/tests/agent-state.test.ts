/**
 * agent 状态牌测试（BACKLOG #1）：broker 层（写/续期/读/清/解析）+ 服务层（`agent/created`
 * 初始态、`agent/status` 转换驱动更新、同态与心跳**不刷 at**、`statusOf` 跨实例读取）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  announceAgentState,
  clearAgentState,
  parseAgentState,
  readAgentState,
  touchAgentState,
} from "../src/broker.ts";
import { closeConnection, connectSessionChannel } from "../src/client.ts";
import { SessionChannelService, toToolDef } from "../src/index.ts";
import type { AgentState } from "../src/types.ts";
import { redisTest, sleep, startTempRedis, waitUntil } from "./helpers.ts";

test("parseAgentState：边界输入不抛、形状不符返回 undefined", () => {
  assert.equal(parseAgentState(null), undefined);
  assert.equal(parseAgentState("not-json"), undefined);
  assert.equal(
    parseAgentState(JSON.stringify({ status: "running" })),
    undefined,
  );
  assert.equal(
    parseAgentState(JSON.stringify({ status: "bogus", at: 1 })),
    undefined,
  );
  assert.equal(
    parseAgentState(JSON.stringify({ status: "idle", at: "x" })),
    undefined,
  );
  assert.deepEqual(
    parseAgentState(JSON.stringify({ status: "running", at: 42 })),
    { status: "running", at: 42 },
  );
});

redisTest(
  "broker：announce → read → touch 续期不改值 → clear 清空",
  async () => {
    const redis = await startTempRedis();
    const conn = await connectSessionChannel({ url: redis.socketPath });
    try {
      const sessionId = "sess-a";
      const state: AgentState = { status: "running", at: 100 };
      await announceAgentState(conn.main, sessionId, state, 2);
      assert.deepEqual(await readAgentState(conn.main, sessionId), state);

      // touch 只续 TTL：值不变（含 at）
      await touchAgentState(conn.main, sessionId, 2);
      assert.deepEqual(await readAgentState(conn.main, sessionId), state);

      // touch 对不存在的键幂等（不创建）
      await touchAgentState(conn.main, "ghost", 2);
      assert.equal(await readAgentState(conn.main, "ghost"), undefined);

      await clearAgentState(conn.main, sessionId);
      assert.equal(await readAgentState(conn.main, sessionId), undefined);
    } finally {
      await closeConnection(conn);
      await redis.stop();
    }
  },
);

redisTest(
  "broker：touch 续期让牌熬过原 TTL（不刷 at 的存活证明）",
  async () => {
    const redis = await startTempRedis();
    const conn = await connectSessionChannel({ url: redis.socketPath });
    try {
      const sessionId = "sess-live";
      const state: AgentState = { status: "running", at: 100 };
      await announceAgentState(conn.main, sessionId, state, 1);
      // 等足原 TTL（1s）之前续一次 → 之后仍可读且 at 不变
      await sleep(600);
      await touchAgentState(conn.main, sessionId, 1);
      await sleep(600);
      const after = await readAgentState(conn.main, sessionId);
      assert.deepEqual(after, state, "续期后仍可读且 at 不变");
    } finally {
      await closeConnection(conn);
      await redis.stop();
    }
  },
);

/** 最小假宿主：只收集事件监听器，agent/status 与 agent/created 可分事件触发。 */
function makeAgentHost(): {
  host: Record<string, unknown>;
  fire: (event: string, payload: unknown) => void;
} {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const host: Record<string, unknown> = {
    logger: () => ({ info: () => {} }),
    agents: {} as unknown,
    sessions: {} as unknown,
    on: (event: string, listener: (payload: unknown) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
  };
  return {
    host,
    fire: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

redisTest(
  "服务：agent/created 初始态 → agent/status 转换更新 at → 同态与心跳不刷 at",
  async () => {
    const redis = await startTempRedis();
    const fh = makeAgentHost();
    const a = new SessionChannelService(
      {
        url: redis.socketPath,
        instanceId: "A",
        heartbeatMs: 100,
        presenceTtlSec: 4,
      },
      fh.host,
    );
    try {
      await a.start();
      assert.equal(a.status().connected, true);
      const none = await a.statusOf("sess-a");
      assert.equal(none.ok, true, "无事件前 ok");
      assert.equal(none.state, undefined, "无事件前无牌");

      // agent/created：读 agent.status 作初始态
      fh.fire("agent/created", {
        agent: { session: { id: "sess-a" }, status: "idle" },
      });
      await waitUntil(
        async () => (await a.statusOf("sess-a"))?.state?.status === "idle",
      );
      const created = await a.statusOf("sess-a");
      assert.equal(created.state?.status, "idle");
      const atCreated = created.state!.at;

      // 转换 → running，at 刷新
      fh.fire("agent/status", {
        agent: { session: { id: "sess-a" } },
        status: "running",
      });
      await waitUntil(
        async () => (await a.statusOf("sess-a"))?.state?.status === "running",
      );
      const running = await a.statusOf("sess-a");
      assert.ok((running.state?.at ?? 0) >= atCreated, "转换后 at 更新");

      // 同态事件不刷 at
      const atRunning = running.state!.at;
      await sleep(30);
      fh.fire("agent/status", {
        agent: { session: { id: "sess-a" } },
        status: "running",
      });
      await sleep(30);
      const sameStatus = await a.statusOf("sess-a");
      assert.equal(sameStatus.state?.at, atRunning, "同态事件不刷 at");

      // 心跳（100ms 间隔已多次跑）不刷 at
      await sleep(250);
      const afterHeartbeats = await a.statusOf("sess-a");
      assert.equal(afterHeartbeats.state?.at, atRunning, "心跳不刷 at");

      // 形状不符 / 不存在会话 → state 缺省
      assert.equal((await a.statusOf("ghost")).state, undefined);
      assert.equal((await a.statusOf("")).state, undefined);
    } finally {
      await a.stop();
      await redis.stop();
    }
  },
);

redisTest("服务：关闭清理清除状态牌（stop 后 statusOf 无牌）", async () => {
  const redis = await startTempRedis();
  const fh = makeAgentHost();
  const a = new SessionChannelService(
    {
      url: redis.socketPath,
      instanceId: "A",
      heartbeatMs: 100,
      presenceTtlSec: 4,
    },
    fh.host,
  );
  await a.start();
  fh.fire("agent/created", {
    agent: { session: { id: "sess-a" }, status: "idle" },
  });
  await waitUntil(
    async () => (await a.statusOf("sess-a"))?.state !== undefined,
  );
  await a.stop();
  // stop 后牌被清除：同一 Redis 换新连接核对（无牌 = undefined）
  const conn = await connectSessionChannel({ url: redis.socketPath });
  try {
    assert.equal(await readAgentState(conn.main, "sess-a"), undefined);
  } finally {
    await closeConnection(conn);
    await redis.stop();
  }
});

redisTest(
  "跨实例：A 发布（agent 事件）→ B 经 statusOf 读到（同键共存）",
  async () => {
    const redis = await startTempRedis();
    const fhA = makeAgentHost();
    const fhB = makeAgentHost();
    const a = new SessionChannelService(
      {
        url: redis.socketPath,
        instanceId: "A",
        heartbeatMs: 200,
        presenceTtlSec: 4,
      },
      fhA.host,
    );
    const b = new SessionChannelService(
      {
        url: redis.socketPath,
        instanceId: "B",
        heartbeatMs: 200,
        presenceTtlSec: 4,
      },
      fhB.host,
    );
    try {
      await a.start();
      await b.start();
      fhA.fire("agent/created", {
        agent: { session: { id: "sess-a" }, status: "idle" },
      });
      await waitUntil(
        async () => (await b.statusOf("sess-a"))?.state?.status === "idle",
      );
      const seen = await b.statusOf("sess-a");
      assert.equal(seen.state?.status, "idle");
      assert.equal(typeof seen.state?.at, "number");
    } finally {
      await a.stop();
      await b.stop();
      await redis.stop();
    }
  },
);

redisTest(
  "服务：agent/disposed 清状态牌（已死代理不留牌、心跳不复活）",
  async () => {
    const redis = await startTempRedis();
    const fh = makeAgentHost();
    const a = new SessionChannelService(
      {
        url: redis.socketPath,
        instanceId: "A",
        heartbeatMs: 100,
        presenceTtlSec: 4,
      },
      fh.host,
    );
    try {
      await a.start();
      fh.fire("agent/created", {
        agent: { session: { id: "sess-a" }, status: "idle" },
      });
      await waitUntil(
        async () => (await a.statusOf("sess-a"))?.state !== undefined,
      );
      fh.fire("agent/disposed", { agent: { session: { id: "sess-a" } } });
      await waitUntil(
        async () => (await a.statusOf("sess-a"))?.state === undefined,
      );
      // 心跳（100ms 已多次跑）不得把已删的牌续回来
      await sleep(250);
      assert.equal((await a.statusOf("sess-a")).state, undefined);
    } finally {
      await a.stop();
      await redis.stop();
    }
  },
);

redisTest("工具：session_channel action=state 可查忙闲牌", async () => {
  const redis = await startTempRedis();
  const fh = makeAgentHost();
  const a = new SessionChannelService(
    {
      url: redis.socketPath,
      instanceId: "A",
      heartbeatMs: 100,
      presenceTtlSec: 4,
    },
    fh.host,
  );
  const tool = toToolDef(a);
  try {
    await a.start();
    // 无牌：ok + state 缺省
    const before = (await tool.execute({
      action: "state",
      sessionId: "sess-a",
    })) as {
      ok: boolean;
      state?: unknown;
    };
    assert.equal(before.ok, true);
    assert.equal(before.state, undefined);
    assert.deepEqual(
      await tool.execute({ action: "state" }),
      { ok: false, error: "state 需要 sessionId" },
      "缺 sessionId 报错",
    );
    // 有牌：状态可见
    fh.fire("agent/status", {
      agent: { session: { id: "sess-a" } },
      status: "running",
    });
    await waitUntil(async () => {
      const res = (await tool.execute({
        action: "state",
        sessionId: "sess-a",
      })) as {
        state?: { status?: string };
      };
      return res.state?.status === "running";
    });
  } finally {
    await a.stop();
    await redis.stop();
  }
});
