// md-map 集成层: 经假宿主调 `apply`, 断言 md_map 的 canonical 值、`output.render` 投影、
// `mdMap` 服务面与失败路径. 装配器见 `tests/assemble.ts`; 文档集一律落 `os.tmpdir()` 的
// 临时目录, 用例结束删除.

import assert from "node:assert/strict";
import { test } from "node:test";

import { inject, name, provide } from "../../src/index.ts";
import { assemble, makeDocProject, makeWorkspace } from "../assemble.ts";

/** `index` 动作的 canonical 返回形状 */
interface IndexValue {
  action: string;
  index: {
    root: string;
    builtAt: string;
    elapsedMs: number;
    truncated: boolean;
    docs: Array<{
      path: string;
      lines: number;
      anchors: Array<{
        text: string;
        anchor: string;
        level: number;
        line: number;
      }>;
      edges: Array<Record<string, unknown>>;
      backlinks: number;
      entry?: boolean;
    }>;
    edges: number;
    externalEdges: number;
    fileEdges: number;
    refEdges: number;
    refUnresolved: number;
    refUnresolvedMd: number;
    broken: Array<{
      from: string;
      line: number;
      target: string;
      reason: string;
    }>;
  };
}

/** 失败返回的公共形状（工具不抛异常, 以 `error` 字段区分） */
interface FailureValue {
  error: string;
}

/** 取 render 投影的全文（投影只有一段 text） */
function textOf(blocks: Array<{ type: string; text: string }>): string {
  assert.equal(blocks.length, 1, "投影只出一段文本");
  assert.equal(blocks[0]?.type, "text");
  return blocks[0]?.text ?? "";
}

// ---------------------------------------------------------------------------
// 装配面
// ---------------------------------------------------------------------------

test("装配: 注册 md_map、provide mdMap、零事件订阅、ready 日志、无告警", async () => {
  const host = await assemble();
  assert.equal(name, "md-map");
  assert.deepEqual(inject, ["tools"]);
  assert.deepEqual(provide, ["mdMap"]);
  assert.deepEqual(host.tools.names(), ["md_map"]);
  assert.equal(host.events.listenerCount(), 0);
  assert.deepEqual(host.services.names(), ["mdMap"]);
  assert.deepEqual(host.stderr, []);
  assert.deepEqual(host.logs, ["md-map: md-map ready (tool=md_map)"]);
});

test("装配: 参数 schema 编译为顶层 object, 只声明真实必填项 action", async () => {
  const host = await assemble();
  const tool = host.tool();
  assert.equal(tool.name, "md_map");
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), [
    "action",
    "path",
    "anchor",
    "kind",
    "depth",
    "root",
  ]);
  assert.deepEqual(tool.parameters.properties["action"]?.enum, [
    "index",
    "refresh",
    "callers",
    "impact",
    "orphans",
    "report",
    "summary",
  ]);
  assert.equal(tool.output.schema.type, "object");
  assert.equal(tool.output.schema.additionalProperties, true);
});

test("装配: 宿主拒绝注册时只告警, apply 不抛, 仍 provide mdMap", async () => {
  const host = await assemble({ registerThrows: true });
  assert.deepEqual(host.tools.names(), []);
  assert.equal(host.stderr.length, 1);
  assert.match(
    host.stderr[0] ?? "",
    /^\[md-map\] md_map 工具注册失败：Error: tool registry rejected/,
  );
  assert.deepEqual(host.services.names(), ["mdMap"]);
  assert.ok(
    host.logs.includes("md-map: md-map ready (tool=md_map)"),
    "注册失败不拦 ready 日志",
  );
});

test("装配: 缺 ctx.tools 不注册也不抛; 缺 ctx.provide 不提供面也不抛", async () => {
  const noTools = await assemble({ shape: "no-tools" });
  assert.deepEqual(noTools.tools.names(), []);
  assert.deepEqual(noTools.services.names(), ["mdMap"]);
  assert.deepEqual(noTools.stderr, []);

  const noProvide = await assemble({ shape: "no-provide" });
  assert.deepEqual(noProvide.tools.names(), ["md_map"]);
  assert.deepEqual(noProvide.services.names(), []);
  assert.deepEqual(noProvide.stderr, []);
});

test("装配: 无 ctx.logger 时不抛, 注册失败的告警仍落 stderr", async () => {
  const quiet = await assemble({ shape: "no-logger" });
  assert.deepEqual(quiet.logs, []);
  assert.deepEqual(quiet.stderr, []);
  assert.deepEqual(quiet.tools.names(), ["md_map"]);

  const failing = await assemble({ shape: "no-logger", registerThrows: true });
  assert.equal(failing.stderr.length, 1);
  assert.match(failing.stderr[0] ?? "", /md_map 工具注册失败/);
});

// ---------------------------------------------------------------------------
// index canonical 值
// ---------------------------------------------------------------------------

test("md_map index: 六类边 / 锚点 / 断链 / 入口与入边计数", async () => {
  const ws = await makeDocProject();
  try {
    const host = await assemble();
    const value = (await host.execute(
      { action: "index" },
      { agent: { session: { header: { cwd: ws.dir } } } },
    )) as IndexValue;
    const { index } = value;
    assert.equal(value.action, "index");
    assert.equal(index.root, ws.dir);
    assert.equal(index.truncated, false);
    assert.ok(index.elapsedMs >= 0);
    assert.match(index.builtAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.deepEqual(
      index.docs.map((doc) => doc.path),
      ["docs/a.md", "docs/b.md", "docs/orphan.md", "README.md"],
    );
    assert.deepEqual(
      index.docs.map((doc) => [
        doc.path,
        doc.lines,
        doc.backlinks,
        doc.entry === true,
      ]),
      [
        ["docs/a.md", 7, 3, false],
        ["docs/b.md", 2, 2, false],
        ["docs/orphan.md", 2, 0, false],
        ["README.md", 11, 1, true],
      ],
    );

    const readme = index.docs[3];
    const a = index.docs[0];
    assert.deepEqual(readme?.anchors, [
      { text: "项目", anchor: "项目", level: 1, line: 1 },
    ]);
    assert.deepEqual(a?.anchors, [
      { text: "A", anchor: "a", level: 1, line: 1 },
      { text: "小节", anchor: "小节", level: 2, line: 3 },
    ]);
    assert.deepEqual(readme?.edges, [
      {
        kind: "internal",
        target: "docs/a.md",
        to: "docs/a.md",
        text: "A",
        line: 3,
      },
      {
        kind: "internal",
        target: "docs/a.md#小节",
        to: "docs/a.md",
        anchor: "小节",
        text: "A 锚点",
        line: 4,
        anchorOk: true,
      },
      {
        kind: "wiki",
        target: "docs/b",
        to: "docs/b.md",
        text: "B 文档",
        line: 5,
      },
      {
        kind: "file",
        target: "src/x.ts",
        to: "src/x.ts",
        text: "代码",
        line: 6,
      },
      {
        kind: "external",
        target: "https://example.com",
        text: "外链",
        line: 7,
      },
      { kind: "broken", target: "docs/missing.md", text: "断链", line: 8 },
      { kind: "broken", target: "../outside.md", line: 9 },
      { kind: "ref", target: "docs/a.md", to: "docs/a.md", line: 10 },
    ]);
    assert.deepEqual(a?.edges, [
      {
        kind: "internal",
        target: "b.md#不存在",
        to: "docs/b.md",
        anchor: "不存在",
        text: "B 坏锚点",
        line: 5,
        anchorOk: false,
      },
      {
        kind: "internal",
        target: "../README.md",
        to: "README.md",
        text: "回 README",
        line: 6,
      },
    ]);

    assert.equal(index.edges, 6, "internal 4 + wiki 1 + ref 1");
    assert.equal(index.externalEdges, 1);
    assert.equal(index.fileEdges, 1);
    assert.equal(index.refEdges, 1);
    assert.equal(index.refUnresolved, 0);
    assert.equal(index.refUnresolvedMd, 0);
    assert.deepEqual(index.broken, [
      {
        from: "docs/a.md",
        line: 5,
        target: "b.md#不存在",
        reason: "missing-anchor",
      },
      {
        from: "README.md",
        line: 8,
        target: "docs/missing.md",
        reason: "missing-file",
      },
      {
        from: "README.md",
        line: 9,
        target: "../outside.md",
        reason: "outside-root",
      },
    ]);
  } finally {
    await ws.cleanup();
  }
});

test("md_map index: render 投影成一段文本, 计数与 root 与 canonical 值一致", async () => {
  const ws = await makeDocProject();
  try {
    const host = await assemble();
    const exec = { agent: { session: { header: { cwd: ws.dir } } } };
    const value = (await host.execute({ action: "index" }, exec)) as IndexValue;
    const text = textOf(host.render(value, { action: "index" }));
    assert.match(
      text,
      /^已索引：4 个文档 \/ 5 个锚点 \/ 6 条内部边 \/ 3 条断链（\d+ ms）$/m,
    );
    assert.equal(text.split("\n")[1], `root：${ws.dir}`);
    // 刷新是同一份索引的另一种标注
    const refreshed = (await host.execute(
      { action: "refresh" },
      exec,
    )) as IndexValue;
    assert.equal(refreshed.action, "refresh");
    assert.match(textOf(host.render(refreshed)), /^已刷新：4 个文档/m);
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// callers / impact canonical 值
// ---------------------------------------------------------------------------

test("md_map callers: 入边 canonical 值, anchor 与 kind 过滤回显", async () => {
  const ws = await makeDocProject();
  try {
    const host = await assemble();
    const exec = { agent: { session: { header: { cwd: ws.dir } } } };
    await host.execute({ action: "index" }, exec);

    const all = (await host.execute(
      { action: "callers", path: "docs/a.md" },
      exec,
    )) as Record<string, unknown>;
    assert.equal(all["action"], "callers");
    assert.equal(all["path"], "docs/a.md");
    assert.equal(all["anchor"], undefined, "未传 anchor 不回显");
    assert.equal(all["kind"], undefined, "未传 kind 不回显");
    assert.deepEqual(all["callers"], [
      { from: "README.md", line: 3, kind: "internal", text: "A" },
      {
        from: "README.md",
        line: 4,
        kind: "internal",
        anchor: "小节",
        text: "A 锚点",
      },
      { from: "README.md", line: 10, kind: "ref" },
    ]);
    assert.match(
      textOf(host.render(all)),
      /^引用 docs\/a\.md 共 3 处：\nREADME\.md:3 → internal “A”\nREADME\.md:4 → internal#小节 “A 锚点”\nREADME\.md:10 → ref$/m,
    );

    const anchored = (await host.execute(
      { action: "callers", path: "docs/a.md", anchor: "小节" },
      exec,
    )) as Record<string, unknown>;
    assert.equal(anchored["anchor"], "小节");
    assert.deepEqual(anchored["callers"], [
      {
        from: "README.md",
        line: 4,
        kind: "internal",
        anchor: "小节",
        text: "A 锚点",
      },
    ]);
    assert.match(
      textOf(host.render(anchored)),
      /^引用 docs\/a\.md#小节 共 1 处：$/m,
    );

    const refOnly = (await host.execute(
      { action: "callers", path: "docs/a.md", kind: ["ref"] },
      exec,
    )) as Record<string, unknown>;
    assert.deepEqual(refOnly["kind"], ["ref"]);
    assert.deepEqual(refOnly["callers"], [
      { from: "README.md", line: 10, kind: "ref" },
    ]);
    assert.match(
      textOf(host.render(refOnly)),
      /^引用 docs\/a\.md 共 1 处（kind 过滤：ref）：$/m,
    );
  } finally {
    await ws.cleanup();
  }
});

test("md_map impact: 反向闭包分层, depth 缺省 2 并回显", async () => {
  const ws = await makeDocProject();
  try {
    const host = await assemble();
    const exec = { agent: { session: { header: { cwd: ws.dir } } } };
    await host.execute({ action: "index" }, exec);

    const value = (await host.execute(
      { action: "impact", path: "docs/a.md" },
      exec,
    )) as Record<string, unknown>;
    assert.equal(value["depth"], 2);
    assert.deepEqual(value["layers"], [{ depth: 1, docs: ["README.md"] }]);
    assert.match(
      textOf(host.render(value)),
      /^改动 docs\/a\.md 的上游影响（1 个文档）：\n {2}L1（1）：README\.md$/m,
    );

    const shallow = (await host.execute(
      { action: "impact", path: "docs/b.md", depth: 1, kind: ["wiki"] },
      exec,
    )) as Record<string, unknown>;
    assert.equal(shallow["depth"], 1);
    assert.deepEqual(shallow["kind"], ["wiki"]);
    assert.deepEqual(shallow["layers"], [{ depth: 1, docs: ["README.md"] }]);
    const text = textOf(host.render(shallow));
    assert.match(
      text,
      /^改动 docs\/b\.md 的上游影响（1 个文档）（kind 过滤：wiki）：$/m,
    );
    assert.ok(!text.includes("docs/a.md"), "坏锚点那条 internal 边被过滤");
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// orphans / report / summary canonical 值
// ---------------------------------------------------------------------------

test("md_map orphans / report / summary: canonical 值与投影", async () => {
  const ws = await makeDocProject();
  try {
    const host = await assemble();
    const exec = { agent: { session: { header: { cwd: ws.dir } } } };
    await host.execute({ action: "index" }, exec);

    const orphans = (await host.execute({ action: "orphans" }, exec)) as Record<
      string,
      unknown
    >;
    assert.deepEqual(orphans, {
      action: "orphans",
      orphans: ["docs/orphan.md"],
    });
    assert.match(
      textOf(host.render(orphans)),
      /^零入边文档 1 个：\ndocs\/orphan\.md$/m,
    );

    const report = (await host.execute({ action: "report" }, exec)) as {
      action: string;
      report: Record<string, unknown>;
    };
    assert.equal(report.action, "report");
    const data = report.report;
    assert.equal(data["root"], ws.dir);
    assert.equal(data["docs"], 4);
    assert.equal(data["anchors"], 5);
    assert.equal(data["edges"], 6);
    assert.equal(data["externalEdges"], 1);
    assert.equal(data["fileEdges"], 1);
    assert.equal(data["refEdges"], 1);
    assert.equal(data["refUnresolved"], 0);
    assert.deepEqual(data["orphans"], ["docs/orphan.md"]);
    assert.deepEqual(data["topBacklinks"], [
      { path: "docs/a.md", backlinks: 3 },
      { path: "docs/b.md", backlinks: 2 },
      { path: "README.md", backlinks: 1 },
    ]);
    const reportText = textOf(host.render(report));
    assert.match(reportText, /^文档地图报告（root：.+，\d+ ms）$/m);
    assert.match(reportText, /^ {2}docs\/a\.md ← 3 处$/m);
    assert.match(reportText, /^ {2}docs\/orphan\.md$/m);
    assert.match(
      reportText,
      /^断链 3 条：\ndocs\/a\.md:5 → b\.md#不存在（锚点不存在）\nREADME\.md:8 → docs\/missing\.md（目标不存在）\nREADME\.md:9 → \.\.\/outside\.md（指向仓库外）$/m,
    );

    const summary = (await host.execute({ action: "summary" }, exec)) as {
      action: string;
      summary: Record<string, unknown>;
    };
    assert.equal(summary.summary["ready"], true);
    assert.equal(summary.summary["docs"], 4);
    assert.equal(summary.summary["anchors"], 5);
    assert.equal(summary.summary["edges"], 6);
    assert.equal(summary.summary["broken"], 3);
    assert.equal(summary.summary["truncated"], false);
    assert.equal(summary.summary["root"], ws.dir);
    assert.match(
      textOf(host.render(summary)),
      /^索引就绪：4 个文档 \/ 5 个锚点 \/ 6 条内部边 \/ 3 条断链$/m,
    );
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 失败路径与 root 解析
// ---------------------------------------------------------------------------

test("失败路径: 未索引时非 index 动作一律报未索引, 投影带 md_map 失败前缀", async () => {
  const host = await assemble();
  for (const args of [
    { action: "callers", path: "docs/a.md" },
    { action: "impact", path: "docs/a.md" },
    { action: "orphans" },
    { action: "report" },
    { action: "summary" },
  ]) {
    const value = (await host.execute(args)) as
      FailureValue | Record<string, unknown>;
    assert.match(
      String((value as FailureValue).error),
      /^未索引（先调用 action=index）$/,
    );
    assert.equal(
      textOf(host.render(value)),
      "md_map 失败：未索引（先调用 action=index）",
    );
  }
});

test("失败路径: 索引内没有该文档 / 入参非法时不抛, error 进投影", async () => {
  const ws = await makeDocProject();
  try {
    const host = await assemble();
    const exec = { agent: { session: { header: { cwd: ws.dir } } } };
    await host.execute({ action: "index" }, exec);

    const missing = (await host.execute(
      { action: "callers", path: "docs/nope.md" },
      exec,
    )) as FailureValue;
    assert.match(
      missing.error,
      /^索引内没有该文档：docs\/nope\.md（先用 action=index）$/,
    );
    const unknownAction = (await host.execute({
      action: "bogus",
    })) as FailureValue;
    assert.match(unknownAction.error, /^未知 action：bogus/);
    const badDepth = (await host.execute(
      { action: "impact", path: "docs/a.md", depth: 0 },
      exec,
    )) as FailureValue;
    assert.match(badDepth.error, /^depth 须为 >=1 的整数，收到：0$/);
    const badKind = (await host.execute(
      { action: "callers", path: "docs/a.md", kind: ["bogus"] },
      exec,
    )) as FailureValue;
    assert.match(badKind.error, /^未知边种类：bogus/);
  } finally {
    await ws.cleanup();
  }
});

test("root: 相对路径以会话 cwd 为基准, 不存在或不是目录时报错", async () => {
  const ws = await makeWorkspace({
    "docs/a.md": "# A\n",
    "file.md": "# 不是目录\n",
  });
  try {
    const host = await assemble();
    const exec = { agent: { session: { header: { cwd: ws.dir } } } };
    const relative = (await host.execute(
      { action: "index", root: "docs" },
      exec,
    )) as IndexValue;
    assert.equal(relative.index.root, ws.path("docs"));
    assert.deepEqual(
      relative.index.docs.map((doc) => doc.path),
      ["a.md"],
    );

    const missing = (await host.execute(
      { action: "index", root: "nope" },
      exec,
    )) as FailureValue;
    assert.equal(missing.error, `root 不存在或不是目录：${ws.path("nope")}`);
    const notDir = (await host.execute(
      { action: "index", root: "file.md" },
      exec,
    )) as FailureValue;
    assert.equal(notDir.error, `root 不存在或不是目录：${ws.path("file.md")}`);
  } finally {
    await ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 服务面与投影契约
// ---------------------------------------------------------------------------

test("服务面 mdMap: getSummary 随索引变化, getService 与工具共用同一实例", async () => {
  const ws = await makeDocProject();
  try {
    const host = await assemble();
    const facade = host.facade();
    assert.deepEqual(facade.getSummary(), { ready: false });

    const exec = { agent: { session: { header: { cwd: ws.dir } } } };
    await host.execute({ action: "index" }, exec);
    const summary = facade.getSummary();
    assert.equal(summary.ready, true);
    assert.equal(summary["docs"], 4);

    const service = facade.getService() as {
      hasDoc(path: string): boolean;
      summary(): { ready: boolean };
    };
    assert.equal(service.hasDoc("docs/a.md"), true);
    assert.equal(service.summary().ready, true);

    // 工具面的 summary 与服务面读到的是同一份索引
    const viaTool = (await host.execute({ action: "summary" }, exec)) as {
      summary: unknown;
    };
    assert.deepEqual(viaTool.summary, facade.getSummary());
  } finally {
    await ws.cleanup();
  }
});

test("output.render: 畸形值不抛, 未知 action 落空结果文本", async () => {
  const host = await assemble();
  for (const bad of [undefined, null, {}, 42, "text", []]) {
    const blocks = host.render(bad);
    assert.equal(blocks[0]?.type, "text");
    assert.equal(typeof blocks[0]?.text, "string");
  }
  assert.equal(textOf(host.render({})), "(空结果)");
  assert.equal(
    textOf(host.render({ error: "boom", action: "index" })),
    "md_map 失败：boom",
  );
});
