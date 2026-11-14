import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig, type Config } from "../src/config.ts";
import { createMatcher, type ToolDoc } from "../src/matcher.ts";
import { RevealSet } from "../src/state.ts";
import { createConsultTool, type ConsultRuntime } from "../src/tool.ts";

const DOCS: ToolDoc[] = [
  { name: "read", description: "读取文件内容。" },
  { name: "write", description: "写入文件内容。" },
  { name: "task_status", description: "查看任务状态。" },
  { name: "session_channel", description: "跨会话发消息。" },
];

/** 工具级运行时替身: 检索器 / 真授权集合 / 初始集都可控。 */
function makeRuntime(
  options: {
    config?: Config;
    initial?: string[];
    denied?: string[];
  } = {},
): {
  runtime: ConsultRuntime;
  grants: RevealSet;
} {
  const config = resolveConfig(options.config);
  const grants = new RevealSet();
  const initial = new Set(options.initial ?? ["read"]);
  const denied = new Set(options.denied ?? []);
  const docs = DOCS.filter((doc) => !denied.has(doc.name));
  const matcher = createMatcher(docs);
  const runtime: ConsultRuntime = {
    matcher,
    config,
    isCallable: (name) =>
      name === "consult_tools" ||
      (!denied.has(name) && (initial.has(name) || grants.has(name))),
    isInitial: (name) => initial.has(name),
    grantedNames: () => grants.names(),
    reveal: (names) =>
      names
        .filter(
          (name) =>
            name !== "consult_tools" &&
            !denied.has(name) &&
            matcher.get(name) !== undefined,
        )
        .map((name) => ({ name, result: grants.grant(name) })),
  };
  return { runtime, grants };
}

test("缺省无参数: 名称分组回退 + 已揭示计数", async () => {
  const { runtime } = makeRuntime();
  const tool = createConsultTool(runtime);
  const result = (await tool.execute({})) as { text: string };
  assert.ok(result.text.includes("没有匹配的工具。可用的工具分组："));
  assert.ok(result.text.includes("- task_*（1）：task_status"), result.text);
  assert.ok(result.text.includes("- read_*（1）：read"), result.text);
  assert.ok(result.text.includes("本会话已揭示 0 项"), result.text);
});

test("空工具面: 检索与回退都给出空目录文案", async () => {
  const { runtime } = makeRuntime();
  const tool = createConsultTool({ ...runtime, matcher: createMatcher([]) });
  const result = (await tool.execute({ query: "任意" })) as { text: string };
  assert.ok(result.text.includes("当前没有可咨询的工具（工具面为空）。"));
  assert.ok(result.text.includes("本会话已揭示 0 项"));
});

test("names 分支: 初始 / 预览 / 未知 / 入口自身", async () => {
  const { runtime, grants } = makeRuntime();
  const tool = createConsultTool(runtime);
  const result = (await tool.execute({
    names: ["read", "write", "ghost", "consult_tools"],
    reveal: false,
  })) as { text: string };
  assert.ok(
    result.text.includes(
      "- read：读取文件内容。（已在初始工具面，直接调用即可）",
    ),
  );
  assert.ok(result.text.includes("- write：写入文件内容。（预览，未揭示）"));
  assert.ok(result.text.includes("- ghost：未知工具（不在当前工具面里）"));
  assert.ok(result.text.includes("- consult_tools（查询入口，直接调用即可）"));
  assert.equal(grants.size(), 0);
});

test("query 分支: 全可调用抬头, 新增揭示与预览分开", async () => {
  const allVisible = makeRuntime({ initial: ["read"] });
  const onlyVisible = (await createConsultTool(allVisible.runtime).execute({
    query: "读取",
    limit: 1,
  })) as { text: string };
  assert.ok(
    onlyVisible.text.startsWith("命中的工具都已在工具面中，直接调用即可。"),
    onlyVisible.text,
  );

  const mixed = makeRuntime();
  const result = (await createConsultTool(mixed.runtime).execute({
    query: "文件",
  })) as { text: string };
  assert.equal(result.text.includes("都已在工具面中"), false);
  assert.ok(result.text.includes("已揭示（本会话内有效"));

  const preview = makeRuntime();
  const previewResult = (await createConsultTool(preview.runtime).execute({
    query: "文件",
    reveal: false,
  })) as { text: string };
  assert.ok(previewResult.text.includes("（预览，未揭示）"));
  assert.equal(preview.grants.size(), 0);
});

test("query 无命中: 分组索引 + 计数", async () => {
  const { runtime } = makeRuntime();
  const result = (await createConsultTool(runtime).execute({
    query: "量子纠缠",
  })) as { text: string };
  assert.ok(result.text.includes("没有匹配的工具。可用的工具分组："));
  assert.ok(result.text.includes("请换更宽泛的词，或用 names 精确指定。"));
  assert.ok(result.text.includes("本会话已揭示 0 项"));
});

test("denied 工具不可见: 不在索引、按名报未知、reveal 不写授权", async () => {
  const { runtime, grants } = makeRuntime({ denied: ["write"] });
  const byName = (await createConsultTool(runtime).execute({
    names: ["write"],
  })) as { text: string };
  assert.ok(byName.text.includes("未知工具"));
  const byQuery = (await createConsultTool(runtime).execute({
    query: "写入",
  })) as { text: string };
  assert.equal(byQuery.text.includes("- write"), false);
  assert.equal(grants.has("write"), false);
});

test("重复揭示: 第二次按已揭示处理, 授权不重复累加", async () => {
  const { runtime, grants } = makeRuntime();
  const tool = createConsultTool(runtime);
  const first = (await tool.execute({ names: ["write"] })) as { text: string };
  assert.ok(first.text.includes("已揭示"));
  const second = (await tool.execute({ names: ["write"] })) as { text: string };
  assert.ok(
    second.text.includes(
      "- write：写入文件内容。（已在本会话揭示，直接调用即可）",
    ),
    second.text,
  );
  assert.deepEqual(grants.names(), ["write"]);
});

test("参数面: 无 scope / pin, 保留 query / names / limit / reveal", () => {
  const { runtime } = makeRuntime();
  const tool = createConsultTool(runtime);
  const properties = (
    tool.parameters as { properties?: Record<string, unknown> }
  ).properties;
  assert.ok(properties);
  assert.deepEqual(Object.keys(properties).sort(), [
    "limit",
    "names",
    "query",
    "reveal",
  ]);
  assert.equal(
    (tool.parameters as { additionalProperties?: boolean })
      .additionalProperties,
    false,
  );
});

test("output.render: 取 text, 缺 text 时按字符串投影; schema 稳定", () => {
  const { runtime } = makeRuntime();
  const tool = createConsultTool(runtime);
  assert.deepEqual(tool.output.render({}, { text: "正文" }), [
    { type: "text", text: "正文" },
  ]);
  assert.deepEqual(tool.output.render({}, { other: 1 }), [
    { type: "text", text: "[object Object]" },
  ]);
  assert.deepEqual(tool.output.render({}, undefined), [
    { type: "text", text: "undefined" },
  ]);
  assert.equal(tool.name, "consult_tools");
});
