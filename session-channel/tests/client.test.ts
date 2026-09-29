/**
 * 连接层测试：地址解析、健康自检（版本 / 命名空间标记键）、失败降级错误码。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  closeConnection,
  connectSessionChannel,
  parseAddress,
  resolveAddress,
} from "../src/client.ts";
import { SessionChannelError } from "../src/types.ts";
import { META_KEY } from "../src/keys.ts";
import { redisTest, startTempRedis } from "./helpers.ts";

test("resolveAddress：config.url → 环境变量 → $XDG_RUNTIME_DIR 默认 socket", () => {
  assert.equal(
    resolveAddress(
      { url: "redis://127.0.0.1:6399" },
      { XDG_RUNTIME_DIR: "/run/u" },
    ).label,
    "redis://127.0.0.1:6399",
  );
  assert.equal(
    resolveAddress(
      {},
      {
        DSH_SESSION_CHANNEL_REDIS_URL: "/tmp/a.sock",
        XDG_RUNTIME_DIR: "/run/u",
      },
    ).socketPath,
    "/tmp/a.sock",
  );
  assert.equal(
    resolveAddress({}, { XDG_RUNTIME_DIR: "/run/u" }).label,
    "unix:/run/u/dsh-session-channel.sock",
  );
  assert.throws(
    () => resolveAddress({}, {}),
    (err: unknown) =>
      err instanceof SessionChannelError && err.code === "bad_config",
  );
});

test("parseAddress：redis:// = URL，其余按 unix socket 路径（支持 unix:// 前缀）", () => {
  assert.deepEqual(parseAddress("redis://h:1"), {
    label: "redis://h:1",
    url: "redis://h:1",
  });
  assert.deepEqual(parseAddress("/tmp/x.sock"), {
    label: "unix:/tmp/x.sock",
    socketPath: "/tmp/x.sock",
  });
  assert.deepEqual(parseAddress("unix:///tmp/y.sock"), {
    label: "unix:/tmp/y.sock",
    socketPath: "/tmp/y.sock",
  });
});

redisTest(
  "connectSessionChannel：连通并自检（写入命名空间标记键）",
  async () => {
    const redis = await startTempRedis();
    const conn = await connectSessionChannel({ url: redis.socketPath });
    try {
      assert.equal(conn.address.label, `unix:${redis.socketPath}`);
      assert.match(conn.version, /^\d+\./);
      assert.equal(
        Number.parseInt(conn.version.split(".")[0] ?? "0", 10) >= 5,
        true,
      );
      assert.equal(
        await conn.main.get(META_KEY),
        "1",
        "标记键应被写入 schema 版本",
      );
    } finally {
      await closeConnection(conn);
      await redis.stop();
    }
  },
);

redisTest("healthCheck：命名空间 schema 不兼容 → schema_mismatch", async () => {
  const redis = await startTempRedis();
  const first = await connectSessionChannel({ url: redis.socketPath });
  await first.main.set(META_KEY, "99");
  await closeConnection(first);
  await assert.rejects(
    () => connectSessionChannel({ url: redis.socketPath }),
    (err: unknown) =>
      err instanceof SessionChannelError && err.code === "schema_mismatch",
  );
  await redis.stop();
});

test("connectSessionChannel：实例连不上 → unavailable（快速失败，不无限重连）", async () => {
  const missing = join(
    "/tmp",
    `session-channel-absent-${Date.now()}`,
    "redis.sock",
  );
  await assert.rejects(
    () => connectSessionChannel({ url: missing }),
    (err: unknown) =>
      err instanceof SessionChannelError && err.code === "unavailable",
  );
});
