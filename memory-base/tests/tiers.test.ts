/**
 * 分层三库测试（设计 §2 / §7 / §8）：
 * 一库一指纹、写入路由（auto → S / user 直达）、跨层检索加权、字节容量、旧 v1 库不被自动读取。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TierSet, TIER_LIMIT_BYTES, tierUsageBytes } from "../src/tiers.ts";
import { LEGACY_V1_APPLICATION_ID, openTierDatabase } from "../src/schema.ts";
import { resolveTierPaths } from "../src/router.ts";

/** 建一个临时工作区：会话目录 + 项目根 + dshHome。 */
async function workspace(): Promise<{
  dir: string;
  sessionDir: string;
  projectRoot: string;
  dshHome: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "kb-tiers-"));
  return {
    dir,
    sessionDir: join(dir, "sessions", "proj", "s1"),
    projectRoot: join(dir, "repo"),
    dshHome: join(dir, "dsh"),
  };
}

test("三库各自独立指纹：拿 session 库当 project 库打开被拒", async () => {
  const ws = await workspace();
  try {
    const paths = resolveTierPaths(ws);
    const sessionPath = paths.session;
    assert.ok(sessionPath);
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

test("写入路由：自动路径落 S，origin=user 直达 U", async () => {
  const ws = await workspace();
  try {
    const tiers = await TierSet.open({
      paths: resolveTierPaths(ws),
      projectKey: "proj-a",
    });
    try {
      const auto = tiers.remember({
        content: "自动写入的会话要点",
        project: "proj-a",
        source: { kind: "manual" },
      });
      assert.equal(auto.ids.length, 1);
      assert.equal(
        tiers.get("user")?.kb.search({ query: "自动写入" }).length,
        0,
      );
      assert.equal(
        tiers.get("session")?.kb.search({ query: "自动写入" }).length,
        1,
      );

      tiers.remember({
        content: "用户偏好：提交信息用中文",
        project: "proj-a",
        source: { kind: "manual" },
        origin: "user",
        tier: "user",
        // U 层禁止落兜底（设计 §5）：显式给已注册 kind。
        kind: "default",
      });
      assert.equal(
        tiers.get("user")?.kb.search({ query: "提交信息" }).length,
        1,
      );
      assert.equal(
        tiers.get("session")?.kb.search({ query: "提交信息" }).length,
        0,
      );
    } finally {
      tiers.close();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("跨层检索：命中三层并按 U > P > S 加权排序", async () => {
  const ws = await workspace();
  try {
    const tiers = await TierSet.open({
      paths: resolveTierPaths(ws),
      projectKey: "proj-a",
    });
    try {
      const base = {
        content: "检索排序验证 payload",
        project: "proj-a",
        source: { kind: "manual" as const },
      };
      tiers.remember({ ...base });
      tiers.remember({
        ...base,
        content: "检索排序验证 payload（项目级结论）",
        origin: "user",
        tier: "project",
      });
      tiers.remember({
        ...base,
        content: "检索排序验证 payload（用户偏好）",
        origin: "user",
        tier: "user",
        kind: "default",
      });

      const hits = tiers.search({ query: "payload" });
      assert.equal(hits.length, 3);
      assert.deepEqual(
        hits.map((hit) => hit.tier),
        ["user", "project", "session"],
      );

      const scoped = tiers.search({ query: "payload", tier: "session" });
      assert.equal(scoped.length, 1);
      assert.equal(scoped[0]?.tier, "session");

      const limited = tiers.search({ query: "payload", limit: 2 });
      assert.equal(limited.length, 2);
    } finally {
      tiers.close();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("容量：逐库字节口径与上限（U 为软上限）", async () => {
  const ws = await workspace();
  try {
    const tiers = await TierSet.open({ paths: resolveTierPaths(ws) });
    try {
      const usage = tiers.usage();
      assert.equal(usage.length, 3);
      for (const entry of usage) {
        assert.equal(entry.limitBytes, TIER_LIMIT_BYTES[entry.tier]);
        assert.equal(entry.over, false);
        assert.ok(entry.bytes > 0, "空库也有页");
        assert.equal(entry.soft, entry.tier === "user");
      }
      const user = tiers.get("user");
      assert.ok(user);
      assert.equal(tierUsageBytes(user.db), usage[2]?.bytes);
    } finally {
      tiers.close();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("跨项目 P：只有显式给出项目根才打开，且标记为非当前", async () => {
  const ws = await workspace();
  try {
    const otherRoot = join(ws.dir, "other-repo");
    const tiers = await TierSet.open({
      paths: resolveTierPaths(ws),
      projectKey: "proj-a",
      otherProjectRoots: [otherRoot],
    });
    try {
      const projects = tiers.all().filter((store) => store.tier === "project");
      assert.equal(projects.length, 2);
      assert.equal(projects.filter((store) => store.current).length, 1);
      const other = projects.find((store) => !store.current);
      assert.equal(other?.project, otherRoot);
    } finally {
      tiers.close();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});
