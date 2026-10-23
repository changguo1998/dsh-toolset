/**
 * 管理面测试（决策 A / A1，2026-10-23）：`forget` / `update` / `remember` 三个写入口。
 *
 * 覆盖：就地更新成功（内容 / 标题 / 重要度 + FTS 同步）、内容闸门与 preWrite 拒绝后原行不动、
 * 同表内容重复拒绝、行不存在 / 未注册 kind 的定位失败、删除计数与幂等、S 层与非法 id 抛错、
 * 用户直写（含绕过 writableTiers 的口径）与直写闸门。
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
  type KnowledgeConfig,
} from "../src/index.ts";
import type { SessionPathsLike } from "../src/tiers.ts";

async function workspace(): Promise<{
  dir: string;
  sessionPaths: SessionPathsLike;
  config: KnowledgeConfig;
}> {
  const dir = await mkdtemp(join(tmpdir(), "kb-admin-"));
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

test("update：就地改内容并同步 FTS（旧内容不再命中）", async () => {
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
        writableTiers: ["project", "user"],
      });
      const put = await kind.put({
        content: "原始内容：闸门在库核心",
        tier: "project",
      });
      const id = put.ids[0]!;

      const updated = await memory.update(
        { tier: "project", kind: "note", id },
        {
          content: "修订内容：闸门仍在库核心",
          title: "修订标题",
          importance: 5,
        },
      );
      assert.deepEqual(updated, { ok: true, id });

      const rows = await memory.list({ kind: "note", tier: "project" });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.content, "修订内容：闸门仍在库核心");
      assert.equal(rows[0]?.title, "修订标题");
      assert.equal(rows[0]?.importance, 5);

      assert.equal((await memory.search({ query: "原始内容" })).length, 0);
      const hits = await memory.search({ query: "修订内容" });
      assert.equal(hits[0]?.id, id);
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("update：内容闸门 / preWrite 拒绝后原行不动", async () => {
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
            : { accept: true },
      });
      const put = await kind.put({ content: "这条保持原样", tier: "user" });
      const id = put.ids[0]!;
      const ref = { tier: "user" as const, kind: "guarded", id };

      const privacy = await memory.update(ref, {
        content: "password: supersecretvalue",
      });
      assert.deepEqual(privacy, { ok: false, skipped: "pattern" });

      const denied = await memory.update(ref, { content: "deny 这条" });
      assert.deepEqual(denied, { ok: false, skipped: "hook" });

      const rows = await memory.list({ kind: "guarded", tier: "user" });
      assert.equal(rows[0]?.content, "这条保持原样");
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("update：行不存在 / 未注册 kind / 内容与同表他行重复 → skipped", async () => {
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
      const first = await kind.put({ content: "第一条内容", tier: "project" });
      await kind.put({ content: "第二条内容", tier: "project" });
      const id = first.ids[0]!;

      const missing = await memory.update(
        { tier: "project", kind: "note", id: 999 },
        { content: "改不存在的行" },
      );
      assert.deepEqual(missing, { ok: false, skipped: "missing" });

      await assert.rejects(
        () =>
          memory.update(
            { tier: "project", kind: "nope", id },
            { content: "改未注册分类" },
          ),
        /未注册/,
      );

      const duplicate = await memory.update(
        { tier: "project", kind: "note", id },
        { content: "第二条内容" },
      );
      assert.deepEqual(duplicate, { ok: false, skipped: "duplicate" });
      const rows = await memory.list({ kind: "note", tier: "project" });
      assert.equal(
        rows.find((row) => row.id === id)?.content,
        "第一条内容",
        "重复拒绝后原行不动",
      );
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("forget：真删并返回条数，重复删除返回 0，摘要计数同步", async () => {
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
      const first = await kind.put({ content: "待删除一", tier: "project" });
      await kind.put({ content: "待删除二", tier: "project" });
      const ref = {
        tier: "project" as const,
        kind: "note",
        id: first.ids[0]!,
      };
      assert.equal(await memory.forget([ref]), 1);
      assert.equal((await memory.list({ kind: "note" })).length, 1);
      assert.equal(await memory.forget([ref]), 0);
      assert.equal(memory.getSummary().chunkCount, 1);
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("管理面：S 层 / 非法 id / 未注册 kind 一律抛错", async () => {
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
        writableTiers: ["session", "project"],
      });
      await assert.rejects(
        () =>
          memory.forget([{ tier: "session" as never, kind: "note", id: 1 }]),
        /不处理会话层/,
      );
      await assert.rejects(
        () => memory.forget([{ tier: "project", kind: "note", id: 0 }]),
        /正整数/,
      );
      await assert.rejects(
        () => memory.forget([{ tier: "project", kind: "nope", id: 1 }]),
        /未注册/,
      );
      await assert.rejects(
        () =>
          memory.update(
            { tier: "session" as never, kind: "note", id: 1 },
            { content: "改会话层" },
          ),
        /不处理会话层/,
      );
      assert.equal(kind.writableTiers.length, 2, "注册本身不受影响");
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("remember：用户直写 U / P 层，S 层拒绝，内容闸门与 writableTiers 口径", async () => {
  const ws = await workspace();
  try {
    const bundle = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const memory = createGlobalService(bundle, ws.config);
    try {
      // 只声明 session 可写的 kind：管理面直写不受 writableTiers 限制（用户直写口径）。
      memory.registerKind({ kind: "pref" });
      const toUser = await memory.remember({
        tier: "user",
        kind: "pref",
        content: "用户偏好：提交信息用中文",
      });
      assert.equal(toUser.created, 1);
      const toProject = await memory.remember({
        tier: "project",
        kind: "pref",
        content: "项目结论：管理面只做删改与用户直写",
      });
      assert.equal(toProject.created, 1);
      assert.ok(
        (await memory.search({ query: "提交信息用中文" })).some(
          (hit) => hit.tier === "user",
        ),
      );

      const privacy = await memory.remember({
        tier: "user",
        kind: "pref",
        content: "password: supersecretvalue",
      });
      assert.deepEqual(privacy.ids, []);
      assert.equal(privacy.skipped, "pattern");

      await assert.rejects(
        () =>
          memory.remember({
            tier: "session" as never,
            kind: "pref",
            content: "写会话层",
          }),
        /不处理会话层/,
      );
      await assert.rejects(
        () =>
          memory.remember({
            tier: "user",
            kind: "nope",
            content: "写未注册分类",
          }),
        /未注册/,
      );
    } finally {
      bundle.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("list：冷启动按需打开既有 U / P 库（openExisting 只开不建）", async () => {
  const ws = await workspace();
  try {
    const first = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const firstMemory = createGlobalService(first, ws.config);
    const kind = firstMemory.registerKind({
      kind: "pref",
      writableTiers: ["user"],
    });
    await kind.put({ content: "持久化的用户偏好", tier: "user" });
    first.dispose();

    const second = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const secondMemory = createGlobalService(second, ws.config);
    try {
      // 新进程里分类由各插件重新注册（注册不写库）。
      secondMemory.registerKind({ kind: "pref", writableTiers: ["user"] });
      const rows = await secondMemory.list({ tier: "user" });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.content, "持久化的用户偏好");
      assert.equal(
        second.tiers.opened("project"),
        undefined,
        "只列 user 层时不打开 P 库",
      );
      assert.equal(
        existsSync(join(ws.dir, "repo", ".dsh", "project.db")),
        false,
        "list 不创建未初始化的库",
      );
    } finally {
      second.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});

test("冷启动：forget / update 经 openExisting 作用于既有库", async () => {
  const ws = await workspace();
  try {
    const first = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const firstMemory = createGlobalService(first, ws.config);
    const kind = firstMemory.registerKind({
      kind: "note",
      writableTiers: ["project"],
    });
    const put = await kind.put({ content: "原始内容", tier: "project" });
    const id = put.ids[0]!;
    first.dispose();

    const second = createMemoryBundle({
      config: ws.config,
      sessionPaths: ws.sessionPaths,
    });
    const secondMemory = createGlobalService(second, ws.config);
    try {
      secondMemory.registerKind({ kind: "note", writableTiers: ["project"] });
      const updated = await secondMemory.update(
        { tier: "project", kind: "note", id },
        { content: "冷启动修订" },
      );
      assert.deepEqual(updated, { ok: true, id });
      assert.equal(
        (await secondMemory.list({ tier: "project" }))[0]?.content,
        "冷启动修订",
      );
      assert.equal(
        await secondMemory.forget([{ tier: "project", kind: "note", id }]),
        1,
      );
      assert.equal((await secondMemory.list({ tier: "project" })).length, 0);
    } finally {
      second.dispose();
    }
  } finally {
    await rm(ws.dir, { recursive: true, force: true });
  }
});
