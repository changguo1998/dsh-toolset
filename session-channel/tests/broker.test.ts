/**
 * 消息层测试：在线状态与懒清理、寻址解析、发送（离线/歧义/超限/成功）、回执、阻塞读。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ackMessage,
  announcePresence,
  cwdOf,
  deleteKv,
  getKv,
  isProcessAlive,
  listKv,
  listPeers,
  normalizeDir,
  parsePeer,
  cleanupCursors,
  putKv,
  readCursor,
  readInbox,
  readNew,
  resolveTarget,
  sendMessage,
  waitForAck,
  writeCursor,
} from "../src/broker.ts";
import {
  closeConnection,
  connectSessionChannel,
  type SessionChannelConnection,
} from "../src/client.ts";
import {
  ackKey,
  aliveKey,
  cursorKey,
  inboxKey,
  kvVersionKey,
} from "../src/keys.ts";
import { SessionChannelError, type PeerInfo } from "../src/types.ts";
import { redisTest, startTempRedis, sleep } from "./helpers.ts";

/** 造一个在线项（可覆盖字段）。 */
function peer(sessionId: string, over: Partial<PeerInfo> = {}): PeerInfo {
  return {
    sessionId,
    pid: process.pid,
    instanceId: "inst-test",
    cwd: "/tmp/proj",
    profile: "test",
    startedAt: 1,
    ...over,
  };
}

/** 起临时实例并连接（自动清理）。 */
async function withConnection(
  fn: (conn: SessionChannelConnection) => Promise<void>,
): Promise<void> {
  const redis = await startTempRedis();
  const conn = await connectSessionChannel({ url: redis.socketPath });
  try {
    await fn(conn);
  } finally {
    await closeConnection(conn);
    await redis.stop();
  }
}

test("parsePeer / normalizeDir / isProcessAlive：边界输入不抛", () => {
  assert.equal(parsePeer(null), undefined);
  assert.equal(parsePeer("not-json"), undefined);
  assert.equal(parsePeer(JSON.stringify({ sessionId: "", pid: 1 })), undefined);
  assert.deepEqual(parsePeer(JSON.stringify(peer("s1"))), peer("s1"));
  assert.equal(normalizeDir("/a/b/"), "/a/b");
  assert.equal(normalizeDir("/"), "/");
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999_999), false);
  assert.equal(isProcessAlive(-1), false);
});

redisTest(
  "在线状态：announcePresence → listPeers；死 pid 残留被懒清理",
  async () => {
    await withConnection(async (conn) => {
      await announcePresence(conn.main, peer("s1"), 60);
      await announcePresence(conn.main, peer("s2", { cwd: "/tmp/other" }), 60);
      await announcePresence(conn.main, peer("dead", { pid: 999_999 }), 60);
      const peers = await listPeers(conn.main);
      assert.deepEqual(
        peers.map((p) => p.sessionId),
        ["s1", "s2"],
        "死 pid 的残留应被剔除",
      );
      assert.equal(
        await conn.main.get(aliveKey("dead")),
        null,
        "残留键应被删除",
      );
      assert.equal(await cwdOf(conn.main, "s2"), "/tmp/other");
      assert.equal(await cwdOf(conn.main, "unknown"), "");
    });
  },
);

redisTest("寻址：会话 id 精确 / cwd 前缀匹配（多命中与零命中）", async () => {
  await withConnection(async (conn) => {
    await announcePresence(conn.main, peer("s1", { cwd: "/tmp/proj/" }), 60);
    await announcePresence(conn.main, peer("s2", { cwd: "/tmp/proj" }), 60);
    await announcePresence(conn.main, peer("s3", { cwd: "/tmp/other" }), 60);
    assert.deepEqual(
      (await resolveTarget(conn.main, "s3")).map((p) => p.sessionId),
      ["s3"],
    );
    assert.deepEqual(
      (await resolveTarget(conn.main, "cwd:/tmp/proj")).map((p) => p.sessionId),
      ["s1", "s2"],
      "尾部斜杠归一后应命中两个会话",
    );
    assert.deepEqual(await resolveTarget(conn.main, "cwd:/tmp/none"), []);
    assert.deepEqual(await resolveTarget(conn.main, "nobody"), []);
  });
});

redisTest("发送：离线 / 歧义 / 超限报稳定错误码；成功写入邮箱流", async () => {
  await withConnection(async (conn) => {
    await assert.rejects(
      () => sendMessage(conn.main, { to: "nobody", text: "hi" }),
      (err: unknown) =>
        err instanceof SessionChannelError && err.code === "target_offline",
    );
    await assert.rejects(
      () =>
        sendMessage(
          conn.main,
          { to: "nobody", text: "x".repeat(20) },
          { maxTextBytes: 8 },
        ),
      (err: unknown) =>
        err instanceof SessionChannelError && err.code === "text_too_large",
    );
    await announcePresence(conn.main, peer("s1"), 60);
    await announcePresence(conn.main, peer("s2"), 60);
    await assert.rejects(
      () => sendMessage(conn.main, { to: "cwd:/tmp/proj", text: "hi" }),
      (err: unknown) =>
        err instanceof SessionChannelError && err.code === "target_ambiguous",
    );
    const res = await sendMessage(conn.main, {
      to: "s1",
      text: "hello",
      from: "s2",
    });
    assert.equal(res.ok, true);
    assert.equal(typeof res.messageId, "string");
    assert.equal(res.target?.sessionId, "s1");
    const inbox = await readInbox(conn.main, "s1", 10);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.text, "hello");
    assert.equal(inbox[0]?.from, "s2");
    assert.equal(
      inbox[0]?.fromCwd,
      "/tmp/proj",
      "fromCwd 取发送方在线键里的 cwd",
    );
    assert.equal((inbox[0]?.ts ?? 0) > 0, true);
  });
});

redisTest(
  "回执：ackMessage → waitForAck 命中；未确认则超时返回 false",
  async () => {
    await withConnection(async (conn) => {
      await announcePresence(conn.main, peer("s1"), 60);
      const res = await sendMessage(conn.main, { to: "s1", text: "need-ack" });
      assert.equal(res.ok, true);
      const msgId = res.messageId ?? "";
      assert.equal(await conn.main.get(ackKey(msgId)), null);
      await ackMessage(conn.main, msgId);
      assert.equal(await conn.main.get(ackKey(msgId)), "injected");
      assert.equal(await waitForAck(conn.main, msgId, 200), true);

      const res2 = await sendMessage(conn.main, {
        to: "s1",
        text: "no-ack",
        waitMs: 150,
      });
      assert.equal(res2.delivered, false, "等待窗口内无回执 → delivered=false");
    });
  },
);

redisTest(
  "阻塞读：XREAD 从游标起读；无新消息按 BLOCK 超时返回 null",
  async () => {
    await withConnection(async (conn) => {
      await conn.main.xAdd(inboxKey("s1"), "*", {
        id: "x",
        from: "s0",
        fromCwd: "",
        text: "m1",
        ts: "1",
      });
      const first = await readNew(
        conn.reader,
        [{ key: inboxKey("s1"), id: "0" }],
        500,
      );
      assert.equal(first?.length, 1);
      assert.equal(first?.[0]?.messages[0]?.text, "m1");
      const lastId = first?.[0]?.messages[0]?.id ?? "0";
      const empty = await readNew(
        conn.reader,
        [{ key: inboxKey("s1"), id: lastId }],
        200,
      );
      assert.equal(empty, null);
      await conn.main.xAdd(inboxKey("s1"), "*", {
        id: "y",
        from: "s0",
        fromCwd: "",
        text: "m2",
        ts: "2",
      });
      await sleep(50);
      const second = await readNew(
        conn.reader,
        [{ key: inboxKey("s1"), id: lastId }],
        500,
      );
      assert.equal(second?.[0]?.messages[0]?.text, "m2");
    });
  },
);

redisTest(
  "投递游标：写入 / 读取 / 懒清理（无 TTL，按 ts 过期删除）",
  async () => {
    await withConnection(async (conn) => {
      assert.equal(
        await readCursor(conn.main, "s1"),
        undefined,
        "未写入时无游标",
      );
      await writeCursor(conn.main, "s1", "100-0");
      assert.equal(await readCursor(conn.main, "s1"), "100-0");
      assert.equal(await conn.main.ttl(cursorKey("s1")), -1, "游标键无 TTL");

      await writeCursor(
        conn.main,
        "old",
        "1-0",
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      );
      await conn.main.set(cursorKey("broken"), "not-json");
      const removed = await cleanupCursors(conn.main, 7 * 24 * 60 * 60 * 1000);
      assert.equal(removed, 2, "过期与形状不符的游标都应清理");
      assert.equal(await readCursor(conn.main, "s1"), "100-0", "新游标保留");
      assert.equal(await conn.main.get(cursorKey("old")), null);
      assert.equal(await conn.main.get(cursorKey("broken")), null);
    });
  },
);

redisTest("共享 KV：写入/读取/版本自增/CAS 冲突（#55）", async () => {
  await withConnection(async (conn) => {
    assert.equal(
      await getKv(conn.main, "nope"),
      undefined,
      "未写入 → undefined",
    );
    const first = await putKv(conn.main, "app.state", { step: 1 });
    assert.equal(first.ok, true);
    assert.equal(first.entry?.version, 1);
    assert.equal(first.entry?.key, "app.state");
    assert.deepEqual(await getKv(conn.main, "app.state"), first.entry);
    // last-value：后写覆盖 + 版本自增
    const second = await putKv(conn.main, "app.state", { step: 2 });
    assert.equal(second.entry?.version, 2);
    assert.deepEqual(
      (await getKv(conn.main, "app.state"))?.value,
      { step: 2 },
      "last-value 语义",
    );
    // CAS：期望版本不匹配 → kv_conflict 且带当前值
    const conflict = await putKv(
      conn.main,
      "app.state",
      { step: 3 },
      {
        expectedVersion: 1,
      },
    );
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "kv_conflict");
    assert.equal(conflict.current?.version, 2);
    // CAS：匹配 → 成功
    const cas = await putKv(
      conn.main,
      "app.state",
      { step: 3 },
      {
        expectedVersion: 2,
      },
    );
    assert.equal(cas.ok, true);
    assert.equal(cas.entry?.version, 3);
    // 版本键独立命名空间：listKv 不会把版本键当条目
    assert.equal(await conn.main.exists(kvVersionKey("app.state")), 1);
    const list = await listKv(conn.main);
    assert.deepEqual(
      list.map((e) => e.key),
      ["app.state"],
      "版本键不混入列表",
    );
  });
});

redisTest("共享 KV：校验与 TTL、删除（#55）", async () => {
  await withConnection(async (conn) => {
    const badKey = await putKv(conn.main, "bad key!", 1);
    assert.equal(badKey.error, "kv_key_invalid");
    const badValue = await putKv(conn.main, "k1", undefined);
    assert.equal(badValue.error, "kv_value_invalid");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    assert.equal(
      (await putKv(conn.main, "k1", cyclic)).error,
      "kv_value_invalid",
    );
    const big = await putKv(conn.main, "k1", "x".repeat(64), { maxBytes: 8 });
    assert.equal(big.error, "kv_value_too_large");
    // TTL：>0 时写入过期
    const ttl = await putKv(conn.main, "ttl.key", 1, { ttlSec: 60 });
    assert.equal(ttl.ok, true);
    assert.ok((await conn.main.ttl("dsh:session-channel:kv:ttl.key")) > 0);
    // 删除：payload 与版本键一并清理
    const deleted = await deleteKv(conn.main, "ttl.key");
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted, true);
    assert.equal(await getKv(conn.main, "ttl.key"), undefined);
    assert.equal(await conn.main.exists(kvVersionKey("ttl.key")), 0);
    assert.equal((await deleteKv(conn.main, "ttl.key")).deleted, false);
    assert.equal(
      (await deleteKv(conn.main, "bad key!")).error,
      "kv_key_invalid",
    );
  });
});
