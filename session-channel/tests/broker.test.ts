/**
 * 消息层测试：在线状态与懒清理、寻址解析、发送（离线/歧义/超限/成功）、回执、阻塞读。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ackMessage,
  announcePresence,
  cwdOf,
  isAcked,
  isProcessAlive,
  listPeers,
  normalizeDir,
  parsePeer,
  readInbox,
  readNew,
  resolveTarget,
  sendMessage,
  waitForAck,
} from "../src/broker.ts";
import {
  closeConnection,
  connectIntercom,
  type SessionChannelConnection,
} from "../src/client.ts";
import { aliveKey, inboxKey } from "../src/keys.ts";
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
  const conn = await connectIntercom({ url: redis.socketPath });
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
      assert.equal(await isAcked(conn.main, msgId), false);
      await ackMessage(conn.main, msgId);
      assert.equal(await isAcked(conn.main, msgId), true);
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
