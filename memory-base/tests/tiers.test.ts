/**
 * 分层库测试：一库一指纹、惰性建库（只解析落点不落盘）、S 层按会话解析与缓存、
 * 写入直落目标层、跨层检索加权、用量只报已创建的库。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TierSet, TIER_WEIGHT, type SessionPathsLike } from "../src/tiers.ts";
import { LEGACY_V1_APPLICATION_ID, openTierDatabase } from "../src/schema.ts";
import { KindRegistry } from "../src/router.ts";

/** 临时工作区：会话目录按 sessionId 分桶（假 sessionPaths 只做这一件事）。 */
async function workspace(): Promise<{
  dir: string;
  dshHome: string;
  projectRoot: string;
  sessionPaths: SessionPathsLike;
  sessionDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "kb-tiers-"));
  const sessionDir = join(dir, "sessions", "proj", "s1");
  return {
    dir,
    dshHome: join(dir, "dsh"),
    projectRoot: join(dir, "repo"),
    sessionPaths: {
      sessionDirFor: (id: string) => join(dir, "sessions", "proj", id),
    },
    sessionDir,
  };
}

/** 注册表：三个 kind，其中 `note` 缺省（只可写会话层）、`proj` 可写项目层、`usr` 可写用户层。 */
function registry(): KindRegistry {
  const r = new KindRegistry();
  r.register({ kind: "note" });
  r.register({ kind: "proj", writableTiers: ["project"] });
  r.register({ kind: "usr", writableTiers: ["user"] });
  return r;
}

test("三库各自独立指纹：拿 session 库当 project 库打开被拒", async () => {
  const ws = await workspace();
  try {
    const sessionPath = join(ws.sessionDir, "session.db");
    const session = await openTierDatabase(sessionPath, "session");
    session.close();
    await assert.rejects(
      () => openTierDatabase(sessionPath, "project"),
      /指纹 .* 与该层（.*）不符，拒绝打开/,
    );
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("旧 v1 库（'KNOW' 指纹）不会被任一层自动读取", async () => {
  const ws = await workspace();
  try {
    const legacy = join(ws.dir, "knowledge.db");
    const db = new DatabaseSync(legacy);
    db.exec(`PRAGMA application_id = ${LEGACY_V1_APPLICATION_ID}`);
    db.close();
    for (const tier of ["session", "project", "user"] as const) {
      await assert.rejects(
        () => openTierDatabase(legacy, tier),
        /不符，拒绝打开/,
      );
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("惰性建库：open 只解析落点，首次写入才创建文件", async () => {
  const ws = await workspace();
  const tiers = TierSet.open({
    dshHome: ws.dshHome,
    projectRoot: ws.projectRoot,
    sessionPaths: ws.sessionPaths,
    registry: registry(),
  });
  try {
    assert.equal(
      tiers.pathFor("user"),
      join(ws.dshHome, "memory-base", "user.db"),
    );
    assert.equal(
      tiers.pathFor("project"),
      join(ws.projectRoot, ".dsh", "project.db"),
    );
    assert.equal(
      tiers.pathFor("session", "s1"),
      join(ws.sessionDir, "session.db"),
    );
    assert.equal(
      tiers.pathFor("session"),
      undefined,
      "S 层缺 sessionId 无落点",
    );
    assert.equal(tiers.all().length, 0, "open 不打开任何库");
    assert.equal(existsSync(join(ws.dshHome, "memory-base", "user.db")), false);

    await tiers.write("user", {
      kind: "usr",
      project: "p",
      content: "用户偏好 A",
    });
    assert.ok(existsSync(join(ws.dshHome, "memory-base", "user.db")));
    assert.equal(tiers.all().length, 1);
    assert.equal(
      existsSync(join(ws.projectRoot, ".dsh", "project.db")),
      false,
      "没写的层不建库",
    );
  } finally {
    tiers.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("S 层按会话解析：不同会话各落各库", async () => {
  const ws = await workspace();
  const tiers = TierSet.open({
    dshHome: ws.dshHome,
    sessionPaths: ws.sessionPaths,
    registry: registry(),
  });
  try {
    await tiers.write(
      "session",
      { kind: "note", project: "p", content: "会话一的要点" },
      "s1",
    );
    await tiers.write(
      "session",
      { kind: "note", project: "p", content: "会话二的要点" },
      "s2",
    );
    const s1 = join(ws.dir, "sessions", "proj", "s1", "session.db");
    const s2 = join(ws.dir, "sessions", "proj", "s2", "session.db");
    assert.ok(existsSync(s1));
    assert.ok(existsSync(s2));
    assert.equal(
      tiers.opened("session", "s1")?.kb.search({ query: "会话一" }).length,
      1,
    );
    assert.equal(
      tiers.opened("session", "s2")?.kb.search({ query: "会话一" }).length,
      0,
    );
    // 缓存：同一会话第二次写入复用同一连接。
    await tiers.write(
      "session",
      { kind: "note", project: "p", content: "会话一第二条" },
      "s1",
    );
    assert.equal(tiers.all().length, 2);
  } finally {
    tiers.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("S 层降级：缺 sessionPaths / 缺 sessionId / 目录解析失败均抛明示例外", async () => {
  const ws = await workspace();
  try {
    const noPaths = TierSet.open({ dshHome: ws.dshHome, registry: registry() });
    await assert.rejects(
      () =>
        noPaths.write(
          "session",
          { kind: "note", project: "p", content: "x" },
          "s1",
        ),
      /需要 session-paths 服务/,
    );
    noPaths.close();

    const withPaths = TierSet.open({
      dshHome: ws.dshHome,
      sessionPaths: ws.sessionPaths,
      registry: registry(),
    });
    await assert.rejects(
      () =>
        withPaths.write("session", {
          kind: "note",
          project: "p",
          content: "x",
        }),
      /需要 sessionId/,
    );
    withPaths.close();

    const failing = TierSet.open({
      dshHome: ws.dshHome,
      sessionPaths: {
        sessionDirFor: () => {
          throw new Error("sessions 服务缺失");
        },
      },
      registry: registry(),
    });
    await assert.rejects(
      () =>
        failing.write(
          "session",
          { kind: "note", project: "p", content: "x" },
          "s1",
        ),
      /sessions 服务缺失/,
    );
    failing.close();
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("跨层检索：命中三层并按 U > P > S 加权排序", async () => {
  const ws = await workspace();
  const tiers = TierSet.open({
    dshHome: ws.dshHome,
    projectRoot: ws.projectRoot,
    sessionPaths: ws.sessionPaths,
    registry: registry(),
  });
  try {
    await tiers.write(
      "session",
      { kind: "note", project: "p", content: "检索排序验证 payload" },
      "s1",
    );
    await tiers.write("project", {
      kind: "proj",
      project: "p",
      content: "检索排序验证 payload（项目级结论）",
    });
    await tiers.write("user", {
      kind: "usr",
      project: "p",
      content: "检索排序验证 payload（用户偏好）",
    });

    const hits = tiers.search({ query: "payload" });
    assert.equal(hits.length, 3);
    assert.deepEqual(
      hits.map((hit) => hit.tier),
      ["user", "project", "session"],
    );
    assert.deepEqual(
      hits.map((hit) => TIER_WEIGHT[hit.tier]),
      [TIER_WEIGHT.user, TIER_WEIGHT.project, TIER_WEIGHT.session],
    );
    assert.equal(tiers.search({ query: "payload", tier: "session" }).length, 1);
    assert.equal(tiers.search({ query: "payload", limit: 2 }).length, 2);
  } finally {
    tiers.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("跨层列举：按 kind 合并各层，按创建时间倒序并支持分页", async () => {
  const ws = await workspace();
  const tiers = TierSet.open({
    dshHome: ws.dshHome,
    projectRoot: ws.projectRoot,
    sessionPaths: ws.sessionPaths,
    registry: registry(),
  });
  try {
    await tiers.write(
      "session",
      { kind: "note", project: "p", content: "会话条目" },
      "s1",
    );
    await new Promise((resolve) => setTimeout(resolve, 3));
    await tiers.write("project", {
      kind: "note",
      project: "p",
      content: "项目条目",
    });
    const all = tiers.list({ kind: "note" });
    assert.deepEqual(
      all.map((row) => row.content),
      ["项目条目", "会话条目"],
    );
    assert.equal(
      tiers.list({ kind: "note", limit: 1 })[0]?.content,
      "项目条目",
    );
    assert.equal(
      tiers.list({ kind: "note", limit: 1, offset: 1 })[0]?.content,
      "会话条目",
    );
    assert.deepEqual(
      tiers.list({ kind: "note", tier: "session" }).map((r) => r.tier),
      ["session"],
    );
  } finally {
    tiers.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("删除：真删并返回条数；未创建的层视为无行", async () => {
  const ws = await workspace();
  const tiers = TierSet.open({
    dshHome: ws.dshHome,
    projectRoot: ws.projectRoot,
    sessionPaths: ws.sessionPaths,
    registry: registry(),
  });
  try {
    const put = await tiers.write("project", {
      kind: "proj",
      project: "p",
      content: "待删除的项目条目",
    });
    assert.equal(
      await tiers.forget([
        { tier: "project", ids: put.ids.map((id) => ({ kind: "proj", id })) },
      ]),
      1,
    );
    assert.equal(tiers.search({ query: "待删除" }).length, 0);
    assert.equal(
      await tiers.forget([
        { tier: "user", ids: [{ kind: "usr", id: 1 }], sessionId: undefined },
      ]),
      0,
      "未创建的层不算删除",
    );
  } finally {
    tiers.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("用量：只报已创建的库，未创建的层不出现", async () => {
  const ws = await workspace();
  const tiers = TierSet.open({
    dshHome: ws.dshHome,
    projectRoot: ws.projectRoot,
    sessionPaths: ws.sessionPaths,
    registry: registry(),
  });
  try {
    assert.deepEqual(await tiers.usage(), []);
    await tiers.write("user", {
      kind: "usr",
      project: "p",
      content: "用户层条目",
    });
    const usage = await tiers.usage();
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.tier, "user");
    assert.ok((usage[0]?.bytes ?? 0) > 0);
  } finally {
    tiers.close();
    await rm(ws.dir, { recursive: true, force: true });
  }
});
