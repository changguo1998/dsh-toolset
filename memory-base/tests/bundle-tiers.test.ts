/**
 * bundle 级测试：`createMemoryBundle` + `createGlobalService` 的装配、八键服务面、
 * 作用域句柄写入（指定层 / 越权层 / 内容级拒写）、跨层查询。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGlobalService,
  createMemoryBundle,
  type BundleHost,
  type KnowledgeConfig,
} from "../src/index.ts";
import type { SessionPathsLike } from "../src/tiers.ts";

/** 临时工作区：会话目录按 id 分桶。 */
async function workspace(): Promise<{
  dir: string;
  sessionPaths: SessionPathsLike;
  config: KnowledgeConfig;
}> {
  const dir = await mkdtemp(join(tmpdir(), "kb-bundle-"));
  return {
    dir,
    sessionPaths: {
      sessionDirFor: (id: string) => join(dir, "sessions", "proj", id),
    },
    config: {
      dshHome: join(dir, "dsh"),
      projectRoot: join(dir, "repo"),
      project: "proj-a",
    },
  };
}

test("bundle：库惰性创建，摘要报落点与未建状态", async () => {
  const ws = await workspace();
  try {
    const bundle = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    try {
      const summary = bundle.summary();
      assert.equal(summary.ready, true);
      assert.equal(summary.chunkCount, 0);
      assert.equal(summary.sourceCount, 0);
      assert.deepEqual(
        summary.tiers.map((entry) => entry.tier),
        ["project", "user"],
        "S 层缺 sessionId，落点不进摘要",
      );
      assert.ok(summary.tiers.every((entry) => entry.created === false));
      assert.equal(
        existsSync(join(ws.dir, "dsh", "memory-base", "user.db")),
        false,
      );
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("句柄：指定层写入、越权层抛错、S 层缺 sessionId 抛错", async () => {
  const ws = await workspace();
  try {
    const bundle = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const memory = createGlobalService(bundle, ws.config);
    try {
      const user = memory.registerKind({
        kind: "pref",
        writableTiers: ["user", "project"],
      });
      assert.deepEqual(user.writableTiers, ["user", "project"]);

      const toUser = await user.put({
        content: "用户偏好：提交信息用中文",
        tier: "user",
      });
      assert.equal(toUser.created, 1);
      assert.ok(existsSync(join(ws.dir, "dsh", "memory-base", "user.db")));
      assert.equal(
        bundle.tiers.opened("user")?.path,
        join(ws.dir, "dsh", "memory-base", "user.db"),
      );

      const toProject = await user.put({
        content: "项目结论：闸门在库核心",
        tier: "project",
      });
      assert.equal(toProject.created, 1);
      assert.ok(existsSync(join(ws.dir, "repo", ".dsh", "project.db")));

      await assert.rejects(
        () => user.put({ content: "越权写会话层" }),
        /不可写 session 层/,
      );
      await assert.rejects(
        () => user.put({ content: "越权删会话层", tier: "session" }),
        /不可写 session 层/,
      );
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("句柄：S 层缺 sessionId 抛错，给了就落该会话库", async () => {
  const ws = await workspace();
  try {
    const bundle = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const memory = createGlobalService(bundle, ws.config);
    try {
      const note = memory.registerKind({ kind: "note" });
      await assert.rejects(
        () => note.put({ content: "缺 sessionId 的会话写入" }),
        /写会话层需要 sessionId/,
      );
      const ok = await note.put({ content: "会话要点写入", sessionId: "s1" });
      assert.equal(ok.created, 1);
      const path = join(ws.dir, "sessions", "proj", "s1", "session.db");
      assert.ok(existsSync(path));
      assert.equal(bundle.tiers.opened("session", "s1")?.path, path);
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("句柄：内容级闸门走 skipped（隐私闸 / preWrite），不抛错", async () => {
  const ws = await workspace();
  try {
    const bundle = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const memory = createGlobalService(bundle, ws.config);
    try {
      const kind = memory.registerKind({
        kind: "guarded",
        writableTiers: ["user"],
        preWrite: (input) =>
          input.content.includes("deny")
            ? { accept: false, reason: "被拒绝" }
            : { accept: true, importance: 4 },
      });
      const privacy = await kind.put({
        content: "password: supersecretvalue",
        tier: "user",
      });
      assert.equal(privacy.skipped, "pattern");
      assert.deepEqual(privacy.ids, []);

      const denied = await kind.put({ content: "deny 这条", tier: "user" });
      assert.equal(denied.skipped, "hook");

      const ok = await kind.put({ content: "这条可以写入", tier: "user" });
      assert.equal(ok.created, 1);
      const hits = await memory.search({ query: "这条可以写入" });
      assert.equal(hits[0]?.importance, 4, "preWrite 的 importance 建议生效");
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("句柄：forget 真删并返回条数（不再恒返 0）", async () => {
  const ws = await workspace();
  try {
    const bundle = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const memory = createGlobalService(bundle, ws.config);
    try {
      const kind = memory.registerKind({
        kind: "note",
        writableTiers: ["project"],
      });
      const put = await kind.put({
        content: "待删除的项目行",
        tier: "project",
      });
      assert.equal(put.created, 1);
      assert.equal(
        await kind.forget([{ tier: "project", ids: put.ids }]),
        1,
        "真删返回条数",
      );
      assert.equal(await kind.forget([{ tier: "project", ids: put.ids }]), 0);
      assert.equal((await memory.search({ query: "待删除" })).length, 0);
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("全局面：八读 + 三管理写齐备（写入口是管理面，不是旧 remember 形态）", async () => {
  const ws = await workspace();
  try {
    const bundle = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    try {
      const memory = createGlobalService(bundle, ws.config);
      assert.deepEqual(
        Object.keys(memory).sort(),
        [
          "checkPrivacy",
          "forget",
          "getSummary",
          "list",
          "migrate",
          "registerKind",
          "remember",
          "search",
          "update",
          "usage",
          "whenReady",
        ],
        "八读 + 三管理写（forget / update / remember；无 promote / candidates）",
      );
      assert.equal(
        memory.checkPrivacy("password: supersecretvalue") !== null,
        true,
      );
      assert.equal(memory.checkPrivacy("普通文本"), null);
      assert.equal(await memory.whenReady(), bundle);
      assert.deepEqual(await memory.usage(), []);
      assert.deepEqual(await memory.list(), []);
      assert.deepEqual(await memory.search({ query: "任意" }), []);
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("全局面 list / search：跨层合并并按 kind 与层过滤", async () => {
  const ws = await workspace();
  try {
    const bundle = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const memory = createGlobalService(bundle, ws.config);
    try {
      const pref = memory.registerKind({
        kind: "pref",
        writableTiers: ["user"],
      });
      const note = memory.registerKind({
        kind: "note",
        writableTiers: ["session", "project"],
      });
      await pref.put({ content: "用户偏好条目", tier: "user" });
      await note.put({ content: "项目条目", tier: "project" });
      await note.put({ content: "会话条目", sessionId: "s1" });

      const all = await memory.list();
      assert.deepEqual(
        all.map((row) => row.content).sort(),
        ["会话条目", "项目条目", "用户偏好条目"].sort(),
      );
      assert.deepEqual(
        (await memory.list({ kind: "note" })).map((row) => row.kind),
        ["note", "note"],
      );
      assert.deepEqual(
        (await memory.list({ tier: "user" })).map((row) => row.tier),
        ["user"],
      );
      assert.equal((await memory.list({ limit: 1 })).length, 1);

      const hits = await memory.search({ query: "条目" });
      assert.equal(hits.length, 3);
      assert.deepEqual(
        hits.map((hit) => hit.tier),
        ["user", "project", "session"],
      );
      assert.equal(
        (await memory.search({ query: "条目", kind: "pref" })).length,
        1,
      );
      assert.equal(
        (await memory.search({ query: "条目", tier: "project" })).length,
        1,
      );
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("apply：暴露 memory 面并注册 memory_query，日志报 session-paths 是否挂载", async () => {
  const ws = await workspace();
  const logs: string[] = [];
  const provided: Array<{ name: string; value: unknown }> = [];
  const tools: unknown[] = [];
  const host: BundleHost = {
    logger: () => ({ info: (message: string) => void logs.push(message) }),
    provide: (nextName, value) => void provided.push({ name: nextName, value }),
    get: (nextName) =>
      nextName === "sessionPaths" ? ws.sessionPaths : undefined,
    tools: { register: (def) => void tools.push(def) },
  };
  const { apply } = await import("../src/index.ts");
  try {
    apply(host, ws.config);
    assert.equal(provided.length, 1);
    assert.equal(provided[0]?.name, "memory");
    assert.equal(tools.length, 1);
    const tool = tools[0] as { name: string };
    assert.equal(tool.name, "memory_query");
    assert.ok(logs.some((line) => line.includes("已就绪")));
    assert.ok(logs.some((line) => line.includes("session-paths=已挂载")));
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("apply：无 tools / provide / get 时不崩，只记降级日志", async () => {
  const logs: string[] = [];
  const host: BundleHost = {
    logger: () => ({ info: (message: string) => void logs.push(message) }),
  };
  const { apply } = await import("../src/index.ts");
  apply(host, {
    dshHome: "/tmp/kb-apply-none",
    projectRoot: "/tmp/kb-apply-none",
  });
  assert.ok(logs.some((line) => line.includes("未注册 memory_query")));
  assert.ok(logs.some((line) => line.includes("session-paths=未挂载")));
});
