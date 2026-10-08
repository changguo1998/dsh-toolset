/**
 * 逐库容量测试（设计 §8）：字节口径、按缺口淘汰、S 层先降级再淘汰、U 层软上限、淘汰顺序。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TierSet, tierUsageBytes } from "../src/tiers.ts";
import { resolveTierPaths } from "../src/router.ts";
import { openTierDatabase } from "../src/schema.ts";
import { KnowledgeService } from "../src/knowledge.ts";

/** 写入大内容（每条都不同 hash，避免去重）。 */
function fill(
  tiers: TierSet,
  tier: "session" | "project" | "user",
  count: number,
  importance: number,
  offset = 0,
): void {
  for (let i = 0; i < count; i += 1) {
    tiers.remember({
      content: `${tier}-${importance}-${offset + i} `.repeat(200),
      project: "p",
      importance,
      source: { kind: "manual" },
      // U 层禁止落兜底（设计 §5）：非 S 层写入必须显式给已注册 kind。
      ...(tier === "session"
        ? {}
        : { origin: "user" as const, tier, kind: "default" }),
    });
  }
}

async function setup(): Promise<{ dir: string; tiers: TierSet }> {
  const dir = await mkdtemp(join(tmpdir(), "kb-cap-"));
  const tiers = await TierSet.open({
    paths: resolveTierPaths({
      sessionDir: join(dir, "sessions"),
      projectRoot: join(dir, "repo"),
      dshHome: join(dir, "dsh"),
    }),
    projectKey: "p",
  });
  return { dir, tiers };
}

/** 库内 chunks 行数。 */
function chunkCount(store: { db: import("node:sqlite").DatabaseSync }): number {
  return Number(
    (
      store.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
        n: number;
      }
    ).n,
  );
}

test("容量：超限触发淘汰（按缺口删，不再“每轮固定 50 条”）", async () => {
  const { dir, tiers } = await setup();
  try {
    fill(tiers, "session", 6, 2);
    fill(tiers, "session", 6, 5);
    const store = tiers.all().find((item) => item.tier === "session");
    assert.ok(store);
    const limit = Math.floor(tierUsageBytes(store.db) / 2);

    const report = tiers.enforceLimits({ limitBytes: { session: limit } });
    const entry = report.find((item) => item.tier === "session");
    assert.ok(entry);
    assert.ok(entry.evicted > 0, "超限应淘汰");
    assert.ok(chunkCount(store) < 12);
    // 未超限的层不动。
    assert.equal(report.find((item) => item.tier === "project")?.evicted, 0);
  } finally {
    tiers.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("容量：S 层超限先就地压缩降级（demoted > 0）", async () => {
  const { dir, tiers } = await setup();
  try {
    fill(tiers, "session", 4, 3);
    const store = tiers.all().find((item) => item.tier === "session");
    assert.ok(store);
    const limit = Math.floor(tierUsageBytes(store.db) * 0.9);
    const report = tiers.enforceLimits({ limitBytes: { session: limit } });
    const entry = report.find((item) => item.tier === "session");
    assert.ok(entry);
    assert.ok(entry.demoted > 0, "S 层应先把正文压成单行摘要");
    // 降级只对 S 层：P 层没有这一段。
    assert.equal(report.find((item) => item.tier === "project")?.demoted, 0);
  } finally {
    tiers.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("容量：U 层是软上限——只告警，不降级、不淘汰、不拒写", async () => {
  const { dir, tiers } = await setup();
  try {
    fill(tiers, "user", 3, 3);
    const store = tiers.all().find((item) => item.tier === "user");
    assert.ok(store);
    const before = chunkCount(store);

    const report = tiers.enforceLimits({ limitBytes: { user: 1 } });
    const user = report.find((item) => item.tier === "user");
    assert.equal(user?.soft, true);
    assert.equal(user?.over, true, "应报告超限（告警）");
    assert.equal(user?.demoted, 0);
    assert.equal(user?.evicted, 0, "U 层不自动淘汰");
    assert.equal(chunkCount(store), before);

    fill(tiers, "user", 1, 3, before);
    assert.equal(chunkCount(store), before + 1, "超限后仍可继续写入");
  } finally {
    tiers.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("淘汰顺序与降级候选（设计 §8）：importance → last_referenced → id；已压缩不再入选", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-cap-"));
  try {
    const db = await openTierDatabase(join(dir, "session.db"), "session");
    try {
      const kb = new KnowledgeService(db);
      const high = kb.put({
        content: "importance 5 的内容",
        project: "p",
        importance: 5,
        source: { kind: "manual" },
      }).ids[0];
      const low = kb.put({
        content: "importance 1 的内容",
        project: "p",
        importance: 1,
        source: { kind: "manual" },
      }).ids[0];
      const mid = kb.put({
        content: "importance 3 的内容",
        project: "p",
        importance: 3,
        source: { kind: "manual" },
      }).ids[0];
      assert.ok(high !== undefined && low !== undefined && mid !== undefined);

      // 淘汰顺序：低 importance 在前（候选是 (kind, id) 句柄，缺省落兜底分类）。
      assert.deepEqual(
        kb.evictionCandidates({ limit: 3 }).map((ref) => ref.id),
        [low, mid, high],
      );
      // 降级候选：排除 importance = 5。
      assert.deepEqual(
        kb.demotionCandidates({ limit: 3 }).map((ref) => ref.id),
        [low, mid],
      );
      // 压缩后该行不再入选（幂等，不会反复挑同一批）。
      kb.compress([low]);
      assert.deepEqual(
        kb.demotionCandidates({ limit: 3 }).map((ref) => ref.id),
        [mid],
      );
      assert.equal(
        (
          db.prepare("SELECT summary FROM chunks WHERE id = ?").get(low) as {
            summary: string | null;
          }
        ).summary,
        "importance 1 的内容",
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
