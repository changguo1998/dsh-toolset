/**
 * 集成层用例（`tests/integration/plugin.test.ts`）：
 * 用 `tests/assemble.ts` 的假工具面 / 假事件面 / 假服务面拼宿主并调用 `apply`，
 * 断言工具注册名、`execute` 的 canonical 值、`output.render` 投影、事件与服务面接线。
 *
 * Markdown 一律落盘在 `os.tmpdir()` 的临时目录，用例结束统一删除；不连宿主运行时。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { assemble, createTempWorkspace, renderText } from "../assemble.ts";
import type { AssembledHost, TempWorkspace } from "../assemble.ts";
import { SAMPLE } from "../helpers.ts";

/** 每个用例一份临时工作区，结束后统一删除。 */
const workspaces: TempWorkspace[] = [];
function workspace(): TempWorkspace {
  const created = createTempWorkspace();
  workspaces.push(created);
  return created;
}
after(() => {
  for (const created of workspaces.splice(0)) created.cleanup();
});

/** 取已装配宿主里的 md_logic 工具。 */
function tool(host: AssembledHost) {
  return host.tools.require("md_logic");
}

/** 调用方会话 cwd（相对路径基准）。 */
function execAt(dir: string): {
  agent: { session: { header: { cwd: string } } };
} {
  return { agent: { session: { header: { cwd: dir } } } };
}

/** 从 structure 结果里取某节的 hash（模拟模型抄 `·#xxxxxxxx`）。 */
async function sectionHashOf(
  host: AssembledHost,
  absolutePath: string,
  heading: string,
): Promise<{ hash: string; line: number; endLine: number }> {
  const value = await tool(host).execute({
    action: "structure",
    path: absolutePath,
  });
  const sections = value["sections"] as Array<{
    title: string;
    line: number;
    endLine: number;
    hash: string;
  }>;
  const found = sections.find((row) => row.title === heading);
  assert.ok(
    found,
    `structure 应含节「${heading}」：${JSON.stringify(sections)}`,
  );
  return found;
}

test("apply 接线: 注册唯一工具 md_logic, 契约面齐全且无事件 / 服务面", () => {
  const host = assemble();

  assert.deepEqual(host.tools.names(), ["md_logic"]);
  const def = tool(host);
  assert.equal(def.parameters.type, "object");
  assert.deepEqual(def.parameters.required, ["action", "path"]);
  assert.equal(def.output.schema.type, "object");
  assert.equal(typeof def.output.render, "function");
  // 服务面: apply 不 provide 任何服务（解析零宿主依赖）
  assert.deepEqual(host.services.names(), []);
  assert.equal(host.services.get("tools"), undefined);
  // 事件面: 本包无事件消费者, 装配后零订阅
  assert.equal(host.events.listenerCount(), 0);
  assert.equal(host.events.emit("session/event", { probe: true }), 0);
  // 日志面: ready 行只报一次
  assert.deepEqual(
    host.logs.info.filter((line) => line.includes("md-logic ready")),
    ["md-logic: md-logic ready (tool=md_logic)"],
  );
});

test("apply 降级: 缺工具面 / 日志面不抛, 工具面缺席时无注册", () => {
  const noTools = assemble({ tools: false });
  assert.deepEqual(noTools.tools.names(), []);
  assert.deepEqual(noTools.logs.info, [
    "md-logic: md-logic ready (tool=md_logic)",
  ]);

  const noLogger = assemble({ logger: false });
  assert.deepEqual(noLogger.tools.names(), ["md_logic"]);
  assert.deepEqual(noLogger.logs.info, []);
});

test("structure: execute canonical 值与 render 投影（含节内容 hash）", async () => {
  const ws = workspace();
  const host = assemble();
  const file = ws.write("doc.md", SAMPLE);

  const value = await tool(host).execute(
    { action: "structure", path: "doc.md" },
    execAt(ws.dir),
  );
  assert.equal(value["action"], "structure");
  assert.equal(value["path"], file);
  assert.equal(value["depth"], 3);
  assert.equal(value["lines"], 35);
  const sections = value["sections"] as Array<Record<string, unknown>>;
  assert.deepEqual(
    sections.map((row) => [
      row["level"],
      row["title"],
      row["line"],
      row["endLine"],
    ]),
    [
      [1, "标题一", 6, 34],
      [2, "小节 1.1", 10, 28],
      [2, "小节 1.2", 30, 34],
    ],
  );
  for (const row of sections)
    assert.match(String(row["hash"]), /^[0-9a-f]{8}$/);
  const doc = value["doc"] as Record<string, unknown>;
  assert.equal(doc["lines"], 35);
  assert.equal((doc["blocks"] as unknown[]).length, 7);

  const text = renderText(tool(host), value);
  assert.match(text, /^Markdown 结构：35 行 \/ 3 节 \/ 7 块 \/ 3 链接$/m);
  assert.match(text, /^L6-34 h1 标题一 ·#[0-9a-f]{8}$/m);
  assert.match(text, /^ {2}L10-28 h2 小节 1\.1 ·#[0-9a-f]{8}$/m);

  // config.maxBytes 经 apply 透传到工具面: 16B 上限拒绝 SAMPLE
  const capped = assemble({ config: { maxBytes: 16 } });
  const refused = await tool(capped).execute({
    action: "structure",
    path: file,
  });
  assert.match(String(refused["error"]), /超过上限 16B/);
});

test("blocks: canonical 清单与 kind / section / from / to 过滤及空结果投影", async () => {
  const ws = workspace();
  const host = assemble();
  const file = ws.write("doc.md", SAMPLE);

  const all = await tool(host).execute({
    action: "blocks",
    path: file,
    kind: ["frontmatter", "list", "code", "table", "quote", "html", "hr"],
  });
  assert.equal(all["totalBlocks"], 7);
  assert.deepEqual(
    (all["blocks"] as Array<Record<string, unknown>>).map((block) => [
      block["kind"],
      block["line"],
      block["endLine"],
      block["section"] ?? null,
    ]),
    [
      ["frontmatter", 1, 4, null],
      ["list", 12, 14, 10],
      ["code", 16, 18, 10],
      ["table", 20, 23, 10],
      ["quote", 25, 26, 10],
      ["html", 32, 32, 30],
      ["hr", 34, 34, 30],
    ],
  );
  const text = renderText(tool(host), all);
  assert.match(text, /^L1-4 frontmatter·2键$/m);
  assert.match(text, /^§L10 L12-14 list·3项·d2$/m);
  assert.match(text, /^§L10 L20-23 table·2行×2列$/m);
  assert.match(text, /^§L30 L34 hr$/m);

  const scoped = await tool(host).execute({
    action: "blocks",
    path: file,
    section: 30,
  });
  assert.deepEqual(
    (scoped["blocks"] as Array<Record<string, unknown>>).map(
      (block) => block["kind"],
    ),
    ["html", "hr"],
  );

  const ranged = await tool(host).execute({
    action: "blocks",
    path: file,
    from: 20,
    to: 26,
  });
  assert.deepEqual(
    (ranged["blocks"] as Array<Record<string, unknown>>).map(
      (block) => block["kind"],
    ),
    ["table", "quote"],
  );

  const empty = await tool(host).execute({
    action: "blocks",
    path: file,
    line: 5,
  });
  assert.deepEqual(empty["blocks"], []);
  assert.equal(renderText(tool(host), empty), "(无块)");
});

test("links: canonical 清单与 linkKind / pattern 过滤及空结果投影", async () => {
  const ws = workspace();
  const host = assemble();
  const file = ws.write("doc.md", SAMPLE);

  const all = await tool(host).execute({ action: "links", path: file });
  assert.equal(all["totalLinks"], 3);
  assert.deepEqual(
    (all["links"] as Array<Record<string, unknown>>).map((link) => [
      link["kind"],
      link["text"],
      link["href"],
      link["line"],
      link["section"] ?? null,
    ]),
    [
      ["link", "链接", "http://example.com", 8, 6],
      ["image", "图", "img.png", 8, 6],
      ["definition", "ref", "http://ref.example", 28, 10],
    ],
  );
  const text = renderText(tool(host), all);
  assert.match(text, /^§L6 L8 link "链接" → http:\/\/example\.com$/m);
  assert.match(
    text,
    /^§L10 L28 definition \[ref\] → http:\/\/ref\.example "\(标题\)"$/m,
  );

  const images = await tool(host).execute({
    action: "links",
    path: file,
    linkKind: ["image"],
  });
  assert.deepEqual(
    (images["links"] as Array<Record<string, unknown>>).map(
      (link) => link["href"],
    ),
    ["img.png"],
  );

  // pattern 大小写不敏感
  const matched = await tool(host).execute({
    action: "links",
    path: file,
    pattern: "REF.EXAMPLE",
  });
  assert.deepEqual(
    (matched["links"] as Array<Record<string, unknown>>).map(
      (link) => link["kind"],
    ),
    ["definition"],
  );

  const empty = await tool(host).execute({
    action: "links",
    path: file,
    linkKind: ["image"],
    pattern: "不存在",
  });
  assert.deepEqual(empty["links"], []);
  assert.equal(renderText(tool(host), empty), "(无链接)");
});

test("replace: execute canonical 值与落盘 / render 投影", async () => {
  const ws = workspace();
  const host = assemble();
  const file = ws.write("doc.md", SAMPLE);

  const target = await sectionHashOf(host, file, "小节 1.1");
  const value = await tool(host).execute(
    {
      action: "replace",
      path: "doc.md",
      edits: [
        {
          heading: "小节 1.1",
          start_line: target.line,
          end_line: target.endLine,
          content: `## 小节 1.1\n\n替换后的正文。\n`,
          section_hash: `\`${target.hash}\``,
        },
      ],
    },
    execAt(ws.dir),
  );
  assert.deepEqual(value, {
    action: "replace",
    path: file,
    ok: true,
    applied: 1,
  });
  const after = readFileSync(file, "utf8");
  assert.match(after, /替换后的正文。/);
  assert.ok(!after.includes("- 项一"), "整节替换后旧节体不应残留");
  assert.match(
    renderText(tool(host), value),
    /^已按节替换：.*doc\.md（1 处，整批原子写）\n注意：结构可能已变/,
  );
});

test("replace 失败路径: edits_invalid / section_stale / content_invalid 的 canonical 值与投影", async () => {
  const ws = workspace();
  const host = assemble();
  const mdTool = tool(host);
  const file = ws.write("doc.md", SAMPLE);

  // 入参结构非法: 先校验, 不触盘
  const noEdits = await mdTool.execute({
    action: "replace",
    path: "doc.md",
    edits: [],
  });
  assert.equal(noEdits["action"], "replace");
  assert.equal(noEdits["path"], "doc.md");
  assert.equal(noEdits["code"], "edits_invalid");
  assert.match(String(noEdits["error"]), /edits 非法：需非空数组/);
  assert.match(
    renderText(mdTool, noEdits),
    /^md_logic replace 失败（edits_invalid）：.*\n下一步：先 action=structure/,
  );
  assert.equal(readFileSync(file, "utf8"), SAMPLE, "非法入参不得写盘");

  // 抄错位数的 section_hash: edits_invalid（不报 section_stale）
  const badHash = await mdTool.execute({
    action: "replace",
    path: "doc.md",
    edits: [
      {
        heading: "小节 1.1",
        start_line: 10,
        end_line: 28,
        content: "x",
        section_hash: "not-hex",
      },
    ],
  });
  assert.equal(badHash["code"], "edits_invalid");
  assert.match(String(badHash["error"]), /8 位 hex/);

  // 陈旧 hash: section_stale + details
  const target = await sectionHashOf(host, file, "小节 1.1");
  ws.write("doc.md", SAMPLE.replace("- 项一", "- 项甲"));
  const stale = await mdTool.execute(
    {
      action: "replace",
      path: "doc.md",
      edits: [
        {
          heading: "小节 1.1",
          start_line: target.line,
          end_line: target.endLine,
          content: "## 小节 1.1\n\n新正文。",
          section_hash: target.hash,
        },
      ],
    },
    execAt(ws.dir),
  );
  assert.equal(stale["ok"], false);
  assert.equal(stale["code"], "section_stale");
  const details = stale["details"] as Array<Record<string, unknown>>;
  assert.equal(details.length, 1);
  assert.match(String(details[0]?.["hash"]), /^[0-9a-f]{8}$/);
  assert.match(
    renderText(mdTool, stale),
    /^md_logic replace 失败（section_stale）：.*\n下一步：文件 \/ 节内容已被外部改动/,
  );

  // content 不带标题行: content_invalid + 「补首行标题」下一步
  const noHeading = await mdTool.execute(
    {
      action: "replace",
      path: "doc.md",
      edits: [
        {
          heading: "小节 1.1",
          start_line: target.line,
          end_line: target.endLine,
          content: "没有标题开头。",
        },
      ],
    },
    execAt(ws.dir),
  );
  assert.equal(noHeading["code"], "content_invalid");
  assert.match(renderText(mdTool, noHeading), /补首行标题/);
});

test("replace 读盘失败: 目录 / 不存在的目标返回 read_failed 且走通用下一步", async () => {
  const ws = workspace();
  const host = assemble();
  const mdTool = tool(host);

  const dirTarget = await mdTool.execute({
    action: "replace",
    path: ws.dir,
    edits: [{ heading: "A", start_line: 1, end_line: 1, content: "# A\n" }],
  });
  assert.equal(dirTarget["code"], "read_failed");
  assert.match(
    renderText(mdTool, dirTarget),
    /replace 失败（read_failed）：目标不是常规文件.*\n下一步：先 action=structure 取最新节范围/,
  );

  const missing = await mdTool.execute({
    action: "replace",
    path: ws.path("missing.md"),
    edits: [{ heading: "A", start_line: 1, end_line: 1, content: "# A\n" }],
  });
  assert.equal(missing["code"], "read_failed");
  assert.match(String(missing["error"]), /读取失败/);
});

test("参数校验与读盘守卫: 未知 action / 缺 path / 目录 / 文件不存在", async () => {
  const ws = workspace();
  const host = assemble();
  const mdTool = tool(host);

  const unknown = await mdTool.execute({ action: "render", path: "a.md" });
  assert.match(String(unknown["error"]), /未知 action：render/);
  assert.match(renderText(mdTool, unknown), /^md_logic 失败：未知 action/);

  const noPath = await mdTool.execute({ action: "blocks" });
  assert.match(String(noPath["error"]), /blocks 需要 path 参数/);

  const directory = await mdTool.execute({ action: "blocks", path: ws.dir });
  assert.match(String(directory["error"]), /非常规文件/);

  const missing = await mdTool.execute({
    action: "links",
    path: ws.path("nope.md"),
  });
  assert.match(String(missing["error"]), /文件不存在/);

  const badDepth = await mdTool.execute({
    action: "structure",
    path: ws.dir,
    depth: 0,
  });
  assert.match(String(badDepth["error"]), /depth 须为 >=1 的整数/);

  const badKind = await mdTool.execute({
    action: "blocks",
    path: ws.path("nope.md"),
    kind: ["paragraph"],
  });
  assert.equal(badKind["error"], "未知块类型：paragraph");

  const badLinkKind = await mdTool.execute({
    action: "links",
    path: ws.path("nope.md"),
    linkKind: ["anchor"],
  });
  assert.equal(badLinkKind["error"], "未知链接类型：anchor");
});

test("相对路径按调用方会话 cwd 解析, 绝对路径原样", async () => {
  const ws = workspace();
  const host = assemble();
  const absolute = ws.write("abs.md", "# 绝对\n");

  const relative = await tool(host).execute(
    { action: "structure", path: "abs.md" },
    execAt(ws.dir),
  );
  assert.equal(relative["path"], absolute);
  assert.equal(
    renderText(tool(host), relative).split("\n")[0],
    "Markdown 结构：2 行 / 1 节 / 0 块 / 0 链接",
  );

  const direct = await tool(host).execute({
    action: "structure",
    path: absolute,
  });
  assert.equal(direct["path"], absolute);

  // 期望 cwd 下找不到相对文件时给「文件不存在」
  const elsewhere = await tool(host).execute(
    { action: "structure", path: "abs.md" },
    { agent: { session: { header: { cwd: ws.path("nonexistent") } } } },
  );
  assert.match(String(elsewhere["error"]), /文件不存在/);
});
