/**
 * 会话别名（可读寻址）单测：set / list / clear、冲突与保留字校验、
 * 寻址优先级（会话 id 精确 → 别名 → cwd:）、以及「经别名投递」。
 */

import assert from "node:assert/strict";

import {
  announcePresence,
  clearAlias,
  clearAliasesOf,
  listAliases,
  readInbox,
  resolveAlias,
  resolveTarget,
  sendMessage,
  setAlias,
} from "../src/broker.ts";
import {
  closeConnection,
  connectSessionChannel,
  type SessionChannelConnection,
} from "../src/client.ts";
import { aliasKey } from "../src/keys.ts";
import type { PeerInfo } from "../src/types.ts";
import { redisTest, startTempRedis } from "./helpers.ts";

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

redisTest("别名：set → resolve → list → clear（键无 TTL）", async () => {
  await withConnection(async (conn) => {
    const res = await setAlias(conn.main, "docs", "s1");
    assert.equal(res.ok, true);
    assert.equal(await resolveAlias(conn.main, "docs"), "s1");
    assert.equal(await conn.main.ttl(aliasKey("docs")), -1, "别名键无 TTL");
    assert.deepEqual(await listAliases(conn.main), [
      { alias: "docs", sessionId: "s1" },
    ]);

    assert.equal(await clearAlias(conn.main, "docs"), "s1");
    assert.equal(await resolveAlias(conn.main, "docs"), undefined);
    assert.equal(
      await clearAlias(conn.main, "docs"),
      undefined,
      "重复清除 → undefined",
    );
  });
});

redisTest("别名：一会话一别名（设新的顶掉旧的，回 replaced）", async () => {
  await withConnection(async (conn) => {
    await setAlias(conn.main, "old", "s1");
    const res = await setAlias(conn.main, "new", "s1");
    assert.equal(res.ok, true);
    assert.equal(res.ok === true ? res.replaced : undefined, "old");
    assert.deepEqual(await listAliases(conn.main), [
      { alias: "new", sessionId: "s1" },
    ]);
  });
});

redisTest("别名：被别人占用 → alias_taken；force 可覆盖", async () => {
  await withConnection(async (conn) => {
    await setAlias(conn.main, "shared", "s1");
    const taken = await setAlias(conn.main, "shared", "s2");
    assert.equal(taken.ok, false);
    assert.equal(taken.ok === false ? taken.error : "", "alias_taken");
    assert.equal(taken.ok === false ? taken.holder : "", "s1", "报出占用者");

    const forced = await setAlias(conn.main, "shared", "s2", { force: true });
    assert.equal(forced.ok, true);
    assert.equal(await resolveAlias(conn.main, "shared"), "s2");
  });
});

redisTest("别名：字符集与保留字校验", async () => {
  await withConnection(async (conn) => {
    for (const bad of ["中文别名", "有 空格", "a".repeat(33), "a.b"]) {
      const res = await setAlias(conn.main, bad, "s1");
      assert.equal(res.ok, false, `应拒绝：${bad}`);
      assert.equal(res.ok === false ? res.error : "", "alias_invalid");
    }
    for (const reserved of ["inbox", "alias", "meta", "status"]) {
      const res = await setAlias(conn.main, reserved, "s1");
      assert.equal(res.ok, false, `保留字应拒绝：${reserved}`);
      assert.equal(res.ok === false ? res.error : "", "alias_reserved");
    }
    assert.equal(await resolveAlias(conn.main, "inbox"), undefined, "未写入");
  });
});

redisTest("寻址优先级：会话 id 精确 > 别名 > cwd", async () => {
  await withConnection(async (conn) => {
    await announcePresence(conn.main, peer("tui-real"), 60);
    await announcePresence(conn.main, peer("s2", { cwd: "/tmp/other" }), 60);
    // 别名指向 s2，但 to 与在线会话 id 相同 → 精确匹配优先
    await setAlias(conn.main, "tui-real", "s2");
    await setAlias(conn.main, "pick", "s2");

    const exact = await resolveTarget(conn.main, "tui-real");
    assert.deepEqual(
      exact.map((p) => p.sessionId),
      ["tui-real"],
      "会话 id 精确匹配优先于同名别名",
    );
    assert.deepEqual(
      (await resolveTarget(conn.main, "pick")).map((p) => p.sessionId),
      ["s2"],
    );
    assert.deepEqual(
      (await resolveTarget(conn.main, "cwd:/tmp/other")).map(
        (p) => p.sessionId,
      ),
      ["s2"],
    );
    assert.deepEqual(
      await resolveTarget(conn.main, "不存在的目标"),
      [],
      "未知目标 → 空（上方报 target_offline）",
    );
  });
});

redisTest("投递：to 用别名可送达目标会话", async () => {
  await withConnection(async (conn) => {
    await announcePresence(conn.main, peer("s1"), 60);
    await setAlias(conn.main, "box", "s1");
    const res = await sendMessage(conn.main, { to: "box", text: "经别名送达" });
    assert.equal(res.ok, true);
    const messages = await readInbox(conn.main, "s1", 5);
    assert.equal(messages[0]?.text, "经别名送达");
  });
});

redisTest("clearAliasesOf：按会话清空其全部别名", async () => {
  await withConnection(async (conn) => {
    await setAlias(conn.main, "a1", "s1");
    await setAlias(conn.main, "a2", "s2");
    assert.deepEqual(await clearAliasesOf(conn.main, "s1"), ["a1"]);
    assert.deepEqual(await listAliases(conn.main), [
      { alias: "a2", sessionId: "s2" },
    ]);
  });
});
