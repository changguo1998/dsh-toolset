/**
 * 会话别名（可读寻址）单测：set / list / clear、冲突与保留字校验、
 * 寻址优先级（会话 id 精确 → 别名 → cwd:）、以及「经别名投递」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

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
import {
  aliasPrefixFor,
  apply,
  AUTO_ALIAS_WORDS,
  getSessionChannelService,
  pickAutoAlias,
} from "../src/index.ts";
import { aliasKey } from "../src/keys.ts";
import type { PeerInfo } from "../src/types.ts";
import {
  makeFakeHost,
  redisTest,
  sleep,
  startTempRedis,
  waitUntil,
} from "./helpers.ts";

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

// ---------- F1：会话别名自动生成（≤8 字符名词 / 名字 + 类型前缀） ----------

test("F1 词表：≤8 字符 ASCII 名词 / 名字，无重复、不与保留字冲突", () => {
  assert.ok(
    AUTO_ALIAS_WORDS.length >= 64,
    `词表规模: ${AUTO_ALIAS_WORDS.length}`,
  );
  // 与 broker 的 RESERVED_ALIASES 同口径（该表未导出，此处硬编码校验）
  const reserved = new Set([
    "inbox",
    "alive",
    "ack",
    "cursor",
    "alias",
    "meta",
    "peers",
    "send",
    "status",
  ]);
  const seen = new Set<string>();
  for (const word of AUTO_ALIAS_WORDS) {
    assert.match(word, /^[A-Za-z]{2,8}$/, `词不合法: ${word}`);
    assert.ok(!seen.has(word), `词重复: ${word}`);
    assert.ok(!reserved.has(word), `与保留字冲突: ${word}`);
    seen.add(word);
  }
});

test("F1 前缀：子代理会话 sub-，其余（用户启动）ui-", () => {
  assert.equal(aliasPrefixFor({ id: "u" }), "ui-");
  assert.equal(aliasPrefixFor({ id: "u", header: { cwd: "/x" } }), "ui-");
  assert.equal(aliasPrefixFor({ id: "u", header: { origin: "user" } }), "ui-");
  assert.equal(
    aliasPrefixFor({ id: "s", header: { origin: "subagent" } }),
    "sub-",
  );
  assert.equal(
    aliasPrefixFor({ id: "s", header: { delegationDepth: 1 } }),
    "sub-",
  );
  assert.equal(
    aliasPrefixFor({ id: "s", header: { delegationDepth: 0 } }),
    "ui-",
  );
  assert.equal(aliasPrefixFor(null), "ui-");
});

test("F1 取词：前缀 + 词表随机项（随机源注入；越界 clamp）", () => {
  assert.equal(
    pickAutoAlias("ui-", () => 0),
    `ui-${AUTO_ALIAS_WORDS[0]}`,
  );
  assert.equal(
    pickAutoAlias("sub-", () => 0.999999),
    `sub-${AUTO_ALIAS_WORDS.at(-1)}`,
  );
  assert.equal(
    pickAutoAlias("ui-", () => 1),
    `ui-${AUTO_ALIAS_WORDS.at(-1)}`,
    "随机源返回 1 不越界",
  );
});

redisTest(
  "F1：会话首见自动生成别名（ui- / sub-；既有别名不动、不重复写）",
  async () => {
    const redis = await startTempRedis();
    const conn = await connectSessionChannel({ url: redis.socketPath });
    const fake = makeFakeHost();
    apply(fake.host, {
      url: redis.socketPath,
      heartbeatMs: 60_000,
      presenceTtlSec: 60,
    });
    try {
      await waitUntil(
        () => getSessionChannelService()?.status().connected === true,
        5000,
      );
      fake.emitSession({ id: "s-user", header: { cwd: "/tmp/x" } });
      fake.emitSession({
        id: "s-sub",
        header: { origin: "subagent", delegationDepth: 1 },
      });
      await waitUntil(async () => (await listAliases(conn.main)).length >= 2);
      const byId = new Map(
        (await listAliases(conn.main)).map((a) => [a.sessionId, a.alias]),
      );
      const userAlias = byId.get("s-user") ?? "";
      const subAlias = byId.get("s-sub") ?? "";
      assert.match(userAlias, /^ui-[a-z]+$/, `用户会话别名: ${userAlias}`);
      assert.match(subAlias, /^sub-[a-z]+$/, `子代理别名: ${subAlias}`);
      assert.ok(
        (AUTO_ALIAS_WORDS as readonly string[]).includes(userAlias.slice(3)),
        `词来自内置词表: ${userAlias}`,
      );
      // 既有显式别名不被自动覆盖
      await setAlias(conn.main, "docs", "s-pre");
      fake.emitSession({ id: "s-pre" });
      await sleep(60);
      assert.equal(await resolveAlias(conn.main, "docs"), "s-pre");
      // 重复见到同一会话不重复写
      fake.emitSession({ id: "s-user", header: { cwd: "/tmp/x" } });
      await sleep(60);
      assert.equal(
        (await listAliases(conn.main)).length,
        3,
        "docs + 两条自动别名",
      );
    } finally {
      await getSessionChannelService()?.stop();
      await closeConnection(conn);
      await redis.stop();
    }
  },
);
