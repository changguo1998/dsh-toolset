// tests/tool.test.ts — 模型侧工具面：注册 / 契约 / 参数校验 / 端到端流程 / 渲染。

import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, inject, mdMapTool, name, provide } from "../src/index.ts";
import { createMdMapService } from "../src/service.ts";
import { withTempDir, writeFile, writeFixture } from "./helpers.ts";

/** 工具定义的最小结构面。 */
interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: string;
    required?: string[];
    properties: Record<string, unknown>;
  };
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>;
  output: {
    schema: { type: string };
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

const tool = mdMapTool(createMdMapService()) as ToolDef;

/** 渲染工具返回值（render 契约：args 第一、value 第二）。 */
function textOf(value: unknown): string {
  return tool.output.render({ probe: true }, value)[0]?.text ?? "";
}

test("apply 注册 md_map 并提供 mdMap 服务面", () => {
  const registered: unknown[] = [];
  const provided: Array<[string, unknown]> = [];
  const logs: string[] = [];
  apply(
    {
      tools: { register: (def) => registered.push(def) },
      provide: (key, value) => provided.push([key, value]),
      logger: (ns) => ({
        info: (message: string) => logs.push(`${ns}: ${message}`),
      }),
    },
    {},
  );
  assert.deepEqual(
    registered.map((def) => (def as ToolDef).name),
    ["md_map"],
  );
  assert.equal(name, "md-map");
  assert.deepEqual(inject, ["tools"]);
  assert.deepEqual(provide, ["mdMap"]);
  assert.equal(provided[0]?.[0], "mdMap");
  assert.ok(logs.some((log) => log.includes("md-map ready")));
  assert.equal(tool.output.schema.type, "object");
  assert.equal(typeof tool.output.render, "function");
  assert.deepEqual(tool.parameters.required, ["action"]);
});

test("参数校验：返回 {error} 不抛", async () => {
  const cases: Array<[unknown, string]> = [
    ["not-an-object", "入参必须是对象"],
    [{}, "未知 action"],
    [{ action: "nope" }, "未知 action"],
    [{ action: "callers" }, "需要 path"],
    [{ action: "impact" }, "需要 path"],
    [{ action: "impact", path: "a.md", depth: 0 }, "depth"],
    [{ action: "callers", path: "a.md", kind: "ref" }, "kind 须为非空数组"],
    [{ action: "callers", path: "a.md", kind: [] }, "kind 须为非空数组"],
    [{ action: "callers", path: "a.md", kind: ["bogus"] }, "未知边种类"],
    [{ action: "callers", path: "a.md" }, "未索引"],
    [{ action: "report" }, "未索引"],
  ];
  for (const [args, needle] of cases) {
    const value = (await tool.execute(args as Record<string, unknown>)) as {
      error?: string;
    };
    assert.ok(
      typeof value.error === "string" && value.error.includes(needle),
      `args=${JSON.stringify(args)} 应报含「${needle}」的错误，实际：${JSON.stringify(value)}`,
    );
    assert.ok(textOf(value).includes("md_map 失败"));
  }
});

test("端到端：index → callers → impact → orphans → report → summary", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFixture(dir);
    const exec = { agent: { session: { header: { cwd: dir } } } };

    const indexed = textOf(await tool.execute({ action: "index" }, exec));
    assert.match(
      indexed,
      /^已索引：4 个文档 \/ 5 个锚点 \/ 6 条内部边 \/ 2 条断链/m,
    );
    assert.ok(indexed.includes(dir));

    const callersText = textOf(
      await tool.execute({ action: "callers", path: "docs/a.md" }, exec),
    );
    assert.match(callersText, /^引用 docs\/a\.md 共 3 处：$/m);
    assert.match(callersText, /^README\.md:4 → internal#小节 “A 的锚点”$/m);

    const callersAnchor = textOf(
      await tool.execute(
        { action: "callers", path: "docs/a.md", anchor: "小节" },
        exec,
      ),
    );
    assert.match(callersAnchor, /共 2 处/);

    const impactText = textOf(
      await tool.execute({ action: "impact", path: "docs/a.md" }, exec),
    );
    assert.match(impactText, /^改动 docs\/a\.md 的上游影响（1 个文档）：$/m);
    assert.match(impactText, /^ {2}L1（1）：README\.md$/m);

    const orphansText = textOf(await tool.execute({ action: "orphans" }, exec));
    assert.match(orphansText, /^零入边文档 1 个：$/m);
    assert.match(orphansText, /^docs\/sub\/c\.md$/m);

    const reportText = textOf(await tool.execute({ action: "report" }, exec));
    assert.match(reportText, /文档地图报告/);
    assert.match(
      reportText,
      /^孤儿文档 1 个（按路径字典序取前 1 个；入口文档已排除）：$/m,
    );
    assert.match(reportText, /^ {2}docs\/sub\/c\.md$/m);
    assert.match(reportText, /docs\/a\.md ← 2 处/);
    assert.match(reportText, /断链 2 条：/);
    assert.match(reportText, /docs\/missing\.md（目标不存在）/);

    const summaryText = textOf(await tool.execute({ action: "summary" }, exec));
    assert.match(
      summaryText,
      /^索引就绪：4 个文档 \/ 5 个锚点 \/ 6 条内部边 \/ 2 条断链$/m,
    );

    const refreshed = textOf(await tool.execute({ action: "refresh" }, exec));
    assert.match(refreshed, /^已刷新：4 个文档/m);
  } finally {
    cleanup();
  }
});

test("kind 过滤端到端：值回显 + 渲染标注（ref 与文档链接语义分离）", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFile(dir, "README.md", "# 项目\n\n[A](docs/a.md)\n");
    writeFile(dir, "docs/a.md", "# A\n");
    writeFile(dir, "docs/refs.md", "# refs\n\n行内引用：`docs/a.md`\n");
    const exec = { agent: { session: { header: { cwd: dir } } } };
    await tool.execute({ action: "index" }, exec);
    const all = textOf(
      await tool.execute({ action: "callers", path: "docs/a.md" }, exec),
    );
    assert.match(all, /^引用 docs\/a\.md 共 2 处：$/m);
    const internal = textOf(
      await tool.execute(
        { action: "callers", path: "docs/a.md", kind: ["internal"] },
        exec,
      ),
    );
    assert.match(
      internal,
      /^引用 docs\/a\.md 共 1 处（kind 过滤：internal）：$/m,
    );
    const refsOnly = textOf(
      await tool.execute(
        { action: "callers", path: "docs/a.md", kind: ["ref"] },
        exec,
      ),
    );
    assert.match(refsOnly, /^引用 docs\/a\.md 共 1 处（kind 过滤：ref）：$/m);
    const impactAll = textOf(
      await tool.execute({ action: "impact", path: "docs/a.md" }, exec),
    );
    assert.match(impactAll, /^改动 docs\/a\.md 的上游影响（2 个文档）：$/m);
    const impactInternal = textOf(
      await tool.execute(
        { action: "impact", path: "docs/a.md", kind: ["internal"] },
        exec,
      ),
    );
    assert.match(
      impactInternal,
      /^改动 docs\/a\.md 的上游影响（1 个文档）（kind 过滤：internal）：$/m,
    );
    assert.ok(!impactInternal.includes("docs/refs.md"), "ref-only 上游被滤除");
  } finally {
    cleanup();
  }
});

test("root 参数显式指定（绝对路径）优先于会话 cwd", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFixture(dir);
    const text = textOf(
      await tool.execute(
        { action: "index", root: dir },
        { agent: { session: { header: { cwd: "/nonexistent" } } } },
      ),
    );
    assert.ok(text.includes(dir), text);
  } finally {
    cleanup();
  }
});

test("render 全函数且形参顺序为 (args, value)", () => {
  for (const bad of [undefined, null, {}, 42, "text", []]) {
    const blocks = tool.output.render({}, bad);
    assert.equal(blocks[0]?.type, "text");
    assert.equal(typeof blocks[0]?.text, "string");
  }
  // 哨兵探针（有鉴别力）：第一参是 args、第二参是 value，渲染文本只由第二参决定。
  // 哨兵放 **value 形状的第二参**，第一参用 args 形状并带一个「不该被渲染」的标记：
  // 形参写反 / 少参（单形参实现）时渲染器拿到的是第一参 → 文本不含哨兵 → 断言必失败。
  // （本包 render 签名是 `(_args, value)`：args 不参与输出，故哨兵只有放 value 位才可能出现。）
  // 原先的 `textOf(value) !== render(value)` 无鉴别力：两种实现下两个文本本来就不同。
  // args 形状与 value **同形**，标记放在渲染器会回显的字段里（放 `path` 这类不读的字段会变死断言）
  const argsShaped = {
    action: "orphans",
    orphans: ["ARGS_MARKER_NOT_RENDERED"],
  };
  const valueShaped = { action: "orphans", orphans: ["SENTINEL_VALUE_MARKER"] };
  const text = tool.output.render(argsShaped, valueShaped)[0]?.text ?? "";
  assert.equal(typeof text, "string");
  assert.ok(
    text.includes("SENTINEL_VALUE_MARKER"),
    "渲染的必须是第二参（value）",
  );
  assert.ok(
    !text.includes("ARGS_MARKER_NOT_RENDERED"),
    "第一参（args）不该被当成 value 渲染",
  );
});
