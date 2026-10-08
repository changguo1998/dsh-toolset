/**
 * bundle 级分层三库测试（设计 §2 / §5 / §7）：`tiers.enabled` 建三库、写入落 S、跨层检索可用。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeBundle, type BundleHost } from "../src/index.ts";

/** 最小宿主：收集日志 + 可手动 emit 事件。 */
function makeHost(): {
  host: BundleHost;
  logs: string[];
  emit: (type: string, data?: unknown) => void;
} {
  const logs: string[] = [];
  const listeners = new Set<
    (session: { id: string }, event: { type: string; data?: unknown }) => void
  >();
  const host: BundleHost = {
    on: (_event, callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    logger: () => ({ info: (message: string) => void logs.push(message) }),
  };
  const emit = (type: string, data?: unknown): void => {
    for (const listener of listeners) listener({ id: "s1" }, { type, data });
  };
  return { host, logs, emit };
}

test("bundle：tiers 开启 → 三库落位、摘要可用、写入落 S、跨层检索", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-bundle-"));
  try {
    const { host, logs } = makeHost();
    const sessionPath = join(dir, "sessions", "proj", "s1", "session.db");
    const bundle = await createKnowledgeBundle(host, {
      dbPath: sessionPath,
      project: "proj-a",
      autoConsolidate: { enabled: false },
      tiers: {
        enabled: true,
        projectRoot: join(dir, "repo"),
        dshHome: join(dir, "dsh"),
      },
    });
    try {
      assert.ok(bundle.tiers, "tiers 应已开启");
      assert.equal(bundle.tiers.all().length, 3);
      assert.equal(bundle.tiers.get("session")?.path, sessionPath);
      assert.ok(existsSync(sessionPath));
      assert.ok(existsSync(join(dir, "repo", ".dsh", "project.db")));
      assert.ok(existsSync(join(dir, "dsh", "memory-base", "user.db")));
      assert.ok(
        logs.some((line) => line.includes("分层三库已开启")),
        "应记录三库落位",
      );

      // 自动路径落 S；用户直写直达 U。
      bundle.tiers.remember({
        content: "会话要点 A",
        project: "proj-a",
        source: { kind: "manual" },
      });
      bundle.tiers.remember({
        content: "用户偏好 B",
        project: "proj-a",
        source: { kind: "manual" },
        origin: "user",
        tier: "user",
      });
      const hits = bundle.tiers.search({ query: "会话要点 OR 用户偏好" });
      assert.deepEqual(
        hits.map((hit) => hit.tier),
        ["user", "session"],
      );

      // 容量可观测：三层各有字节用量与上限。
      const usage = bundle.tiers.usage();
      assert.equal(usage.length, 3);
      assert.ok(usage.every((entry) => entry.limitBytes > 0));
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bundle：未开启 tiers 时保持单库（不静默创建 P / U）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-bundle-"));
  try {
    const { host } = makeHost();
    const bundle = await createKnowledgeBundle(host, {
      dbPath: join(dir, "memory.db"),
      autoConsolidate: { enabled: false },
    });
    try {
      assert.equal(bundle.tiers, undefined);
      assert.equal(existsSync(join(dir, ".dsh")), false);
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
