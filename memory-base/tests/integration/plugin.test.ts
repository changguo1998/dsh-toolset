/**
 * 集成层：装配本包 `apply` 与宿主接线（阶段 2 规范 4.2）。
 *
 * 覆盖四条线：
 * - 工具注册与 `execute` 的 canonical 值、`output.render` 的投影文本；
 * - 服务提供（`ctx.provide("memory")`）与消费（`ctx.get("sessionPaths")`）；
 * - 落盘只在 `os.tmpdir()` 的临时库里断言（U / P / S 三个落点），用后删除；
 * - 失败路径：工具面缺失 / 注册抛错 / 暴露抛错 / 服务读取抛错都只记日志，不崩装配。
 *
 * 本包不订阅宿主事件，集成用例顺带锁住「事件面为空」这一契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assemble } from "../assemble.ts";

test("装配：暴露 memory 面、注册单个 memory_query、不订阅事件、日志报落点", () => {
  const assembly = assemble();
  try {
    assert.ok(assembly.bundle(), "apply 持有 bundle");
    assert.deepEqual([...assembly.provided.keys()], ["memory"]);
    assert.deepEqual(
      assembly.tools.map((tool) => tool.name),
      ["memory_query"],
    );
    assert.equal(assembly.subscriptions.length, 0, "本包不订阅宿主事件");
    assert.ok(assembly.logs.some((line) => line.includes("已就绪")));
    assert.ok(
      assembly.logs.some((line) => line.includes("session-paths=已挂载")),
    );
    assert.ok(
      assembly.logs.some((line) =>
        line.includes(join(assembly.dir, "dsh", "memory-base", "user.db")),
      ),
      "启动日志报 U 库落点",
    );
  } finally {
    assembly.cleanup();
  }
});

test("服务面：句柄写入的 PutResult canonical 值与读面投影", async () => {
  const assembly = assemble();
  try {
    const memory = assembly.memory();
    assert.equal(await memory.whenReady(), assembly.bundle());
    assert.equal(
      memory.checkPrivacy("password: supersecretvalue") !== null,
      true,
    );
    assert.equal(memory.checkPrivacy("普通文本"), null);

    const scope = memory.registerKind({
      kind: "note",
      writableTiers: ["session", "project", "user"],
    });
    const put = await scope.put({
      content: "集成层写入的用户条目",
      title: "集成标题",
      importance: 5,
      tier: "user",
    });
    assert.deepEqual(put, { ids: [1], sourceId: 1, created: 1 });

    const summary = memory.getSummary();
    assert.equal(summary.ready, true);
    assert.deepEqual(summary.kinds, [
      {
        kind: "note",
        table: "kind_note",
        writableTiers: ["session", "project", "user"],
        rows: 1,
      },
    ]);
    assert.equal(summary.chunkCount, 1);
    assert.equal(summary.sourceCount, 1);
    assert.deepEqual(
      summary.tiers.find((entry) => entry.tier === "user"),
      {
        tier: "user",
        path: join(assembly.dir, "dsh", "memory-base", "user.db"),
        created: true,
      },
    );

    const rows = await memory.list({ kind: "note" });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      id: 1,
      kind: "note",
      tier: "user",
      project: "it-proj",
      title: "集成标题",
      content: "集成层写入的用户条目",
      importance: 5,
      sessionId: null,
      createdAt: rows[0]?.createdAt,
    });

    const hits = await memory.search({ query: "集成层", kind: "note" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.kind, "note");
    assert.equal(hits[0]?.tier, "user");
    assert.equal(typeof hits[0]?.score, "number");

    const usage = await memory.usage();
    assert.deepEqual(
      usage.map((entry) => entry.tier),
      ["user"],
    );
    assert.ok((usage[0]?.bytes ?? 0) > 0, "已创建的库报出字节数");
  } finally {
    assembly.cleanup();
  }
});

test("管理面：remember / update / forget 经服务面的 canonical 返回", async () => {
  const assembly = assemble();
  try {
    const memory = assembly.memory();
    memory.registerKind({ kind: "pref" });

    const written = await memory.remember({
      tier: "user",
      kind: "pref",
      content: "用户偏好：回答用中文",
    });
    assert.deepEqual(written, { ids: [1], sourceId: 1, created: 1 });

    assert.deepEqual(
      await memory.update(
        { tier: "user", kind: "pref", id: 1 },
        { content: "用户偏好：回答用中文, 结论先行" },
      ),
      { ok: true, id: 1 },
    );
    assert.equal(
      await memory.forget([{ tier: "user", kind: "pref", id: 1 }]),
      1,
    );
    assert.deepEqual(await memory.list({ kind: "pref" }), []);
  } finally {
    assembly.cleanup();
  }
});

test("memory_query：execute 的 canonical 值与 output.render 投影", async () => {
  const assembly = assemble();
  try {
    const memory = assembly.memory();
    const scope = memory.registerKind({
      kind: "note",
      writableTiers: ["user"],
    });
    await scope.put({ content: "第一条集成条目", tier: "user" });
    await scope.put({ content: "第二条集成条目", tier: "user" });

    const listed = await assembly.call("memory_query", {
      action: "list",
      kind: "note",
    });
    assert.equal(listed.action, "list");
    assert.equal(listed.count, 2);
    assert.equal(listed.limit, 10);
    assert.equal(listed.truncated, false);
    assert.equal((listed.items as Array<{ content: string }>).length, 2);
    const listText = assembly.render("memory_query", listed, {
      action: "list",
      kind: "note",
    });
    assert.ok(listText.startsWith("list：2 条（limit=10）"), listText);
    assert.ok(listText.includes("[note@user]"));
    assert.ok(listText.includes("importance=3 id=1 "));

    const searched = await assembly.call("memory_query", {
      action: "search",
      query: "集成条目",
      limit: 1,
    });
    assert.equal(searched.action, "search");
    assert.equal(searched.count, 1);
    assert.equal(searched.limit, 1);
    assert.equal(searched.truncated, true);
    const searchText = assembly.render("memory_query", searched, {});
    assert.ok(
      searchText.startsWith("search：1 条（limit=1，已截断）"),
      searchText,
    );

    const missingQuery = await assembly.call("memory_query", {
      action: "search",
    });
    assert.deepEqual(missingQuery, {
      action: "search",
      count: 0,
      limit: 10,
      truncated: false,
      items: [],
      error: "action=search 需要 query",
    });
    assert.equal(
      assembly.render("memory_query", missingQuery, {}),
      "memory_query 失败：action=search 需要 query",
    );
  } finally {
    assembly.cleanup();
  }
});

test("失败路径：工具面缺失 / 注册抛错 / 暴露抛错 / 服务读取抛错都只记日志", () => {
  const noTools = assemble({ tools: "missing" });
  try {
    assert.ok(
      noTools.logs.some((line) => line.includes("未注册 memory_query")),
    );
    assert.ok(noTools.provided.has("memory"), "工具面缺失不影响服务面");
  } finally {
    noTools.cleanup();
  }

  const toolThrows = assemble({ tools: "throws" });
  try {
    assert.deepEqual(toolThrows.tools, []);
    assert.ok(
      toolThrows.logs.some((line) => line.includes("注册 memory_query 失败")),
    );
  } finally {
    toolThrows.cleanup();
  }

  const noProvide = assemble({ provide: "missing" });
  try {
    assert.equal(noProvide.provided.size, 0);
    assert.equal(noProvide.tools.length, 1, "服务面缺失不影响工具注册");
    assert.throws(() => noProvide.memory(), /未 provide memory/);
  } finally {
    noProvide.cleanup();
  }

  const provideThrows = assemble({ provide: "throws" });
  try {
    assert.equal(provideThrows.provided.size, 0);
    assert.equal(provideThrows.tools.length, 1);
    assert.ok(
      provideThrows.logs.some((line) => line.includes("服务面暴露失败")),
    );
  } finally {
    provideThrows.cleanup();
  }

  const getThrows = assemble({ get: "throws" });
  try {
    assert.ok(
      getThrows.logs.some((line) => line.includes("启动失败")),
      "服务读取抛错被 apply 兜住并记账",
    );
  } finally {
    getThrows.cleanup();
  }

  const noLogger = assemble({ logger: false });
  try {
    assert.deepEqual(noLogger.logs, []);
    assert.ok(noLogger.provided.has("memory"), "缺 logger 不影响装配");
  } finally {
    noLogger.cleanup();
  }
});

test("落盘：S 层按会话分库；缺 sessionPaths / 解析失败时写入抛明示例外", async () => {
  const sessioned = assemble();
  try {
    const scope = sessioned.memory().registerKind({ kind: "snote" });
    const put = await scope.put({
      content: "会话层集成条目",
      sessionId: "s1",
    });
    assert.equal(put.created, 1);
    assert.ok(
      existsSync(join(sessioned.dir, "sessions", "s1", "session.db")),
      "S 库落在会话目录",
    );
  } finally {
    sessioned.cleanup();
  }

  const noPaths = assemble({ sessionPaths: "none" });
  try {
    const scope = noPaths.memory().registerKind({ kind: "snote" });
    await assert.rejects(
      () => scope.put({ content: "无会话服务写入", sessionId: "s1" }),
      /需要 session-paths 服务/,
    );
  } finally {
    noPaths.cleanup();
  }

  const brokenPaths = assemble({
    sessionPaths: {
      sessionDirFor: () => {
        throw new Error("sessions 服务取不到");
      },
    },
  });
  try {
    const scope = brokenPaths.memory().registerKind({ kind: "snote" });
    await assert.rejects(
      () => scope.put({ content: "解析失败写入", sessionId: "s1" }),
      /sessions 服务取不到/,
    );
  } finally {
    brokenPaths.cleanup();
  }
});
