import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig, type Config, type RevealScope } from "../src/config.ts";
import { createMatcher, type ToolDoc } from "../src/matcher.ts";
import { AgentGrants } from "../src/state.ts";
import { createConsultTool, type ConsultRuntime } from "../src/tool.ts";

const DOCS: ToolDoc[] = [
  { name: "read", description: "读取文件内容。" },
  { name: "write", description: "写入文件内容。" },
  { name: "task_status", description: "查看任务状态。" },
  { name: "session_channel", description: "跨会话发消息。" },
];

/** 工具级运行时替身: 检索器 / 真授权状态机 / 当前回合都可控。 */
function makeRuntime(
  options: {
    config?: Config;
    turn?: number;
    visible?: string[];
  } = {},
): {
  runtime: ConsultRuntime;
  grants: AgentGrants;
  advance: (turn: number) => void;
} {
  const config = resolveConfig(options.config);
  const grants = new AgentGrants(config.revealScope);
  const visible = new Set(options.visible ?? ["read", "consult_tools"]);
  let turn = options.turn ?? 0;
  const runtime: ConsultRuntime = {
    matcher: createMatcher(DOCS),
    config,
    grants,
    currentTurn: () => turn,
    isVisible: (name) => visible.has(name) || grants.has(name),
    grantedNames: () => grants.allowedNames(),
    reveal: (names, scope: RevealScope, pin) =>
      names.map((name) => ({
        name,
        result: grants.grant(name, scope, pin, turn, {
          maxRevealed: config.maxRevealed,
          ttlTurns: config.ttlTurns,
          maxPinned: config.maxPinned,
        }),
      })),
  };
  return {
    runtime,
    grants,
    advance: (next) => {
      turn = next;
    },
  };
}

test("缺省无参数: 名称分组回退 + session 配额", async () => {
  const { runtime } = makeRuntime();
  const tool = createConsultTool(runtime);
  const result = (await tool.execute({})) as { text: string };
  assert.ok(result.text.includes("没有匹配的工具。可用的工具分组："));
  assert.ok(result.text.includes("- task_*（1）：task_status"), result.text);
  assert.ok(result.text.includes("- read_*（1）：read"), result.text);
  assert.ok(result.text.includes("session 档已揭示 0 项"), result.text);
});

test("空工具面: 检索与回退都给出空目录文案", async () => {
  const { runtime } = makeRuntime();
  const tool = createConsultTool({ ...runtime, matcher: createMatcher([]) });
  const result = (await tool.execute({ query: "任意" })) as { text: string };
  assert.ok(result.text.includes("当前没有可咨询的工具（工具面为空）。"));
  assert.ok(result.text.includes("session 档已揭示 0 项"));
});

test("查询命中: limit 下限 1 / 字符串 limit 回退配置 / scope 非法回退缺省", async () => {
  const lower = makeRuntime();
  const toolLower = createConsultTool(lower.runtime);
  const one = (await toolLower.execute({ query: "写入", limit: 0 })) as {
    text: string;
  };
  assert.equal(
    one.text.split("\n").filter((line) => line.startsWith("- ")).length,
    1,
  );
  assert.ok(one.text.includes("已揭示（本会话内持续可见"), one.text);

  const fallback = makeRuntime({
    config: { maxResults: 1 },
    visible: ["consult_tools"],
  });
  const toolFallback = createConsultTool(fallback.runtime);
  const both = (await toolFallback.execute({
    query: "文件",
    limit: "9",
    scope: "weird",
  })) as { text: string };
  assert.equal(fallback.grants.allowedNames().length, 1, "limit 应按配置回退");
  assert.ok(both.text.includes("已揭示（本会话内持续可见"), both.text);
});

test("names 分支: 已可见 / 预览 / 未知 / 入口自身", async () => {
  const { runtime } = makeRuntime();
  const tool = createConsultTool(runtime);
  const result = (await tool.execute({
    names: ["read", "write", "ghost", "consult_tools"],
    reveal: false,
  })) as { text: string };
  assert.ok(
    result.text.includes("- read：读取文件内容。（已在可见集，直接调用即可）"),
  );
  assert.ok(result.text.includes("- write：写入文件内容。（预览，未揭示）"));
  assert.ok(result.text.includes("- ghost：未知工具（不在当前工具面里）"));
  assert.ok(
    result.text.includes("- consult_tools（已在可见集，直接调用即可）"),
  );
  assert.equal(runtime.grants.allowedNames().length, 0);
});

test("query 分支: 全可见抬头, 部分可见时先列新增再列已见", async () => {
  const allVisible = makeRuntime();
  const toolVisible = createConsultTool(allVisible.runtime);
  const onlyVisible = (await toolVisible.execute({
    query: "读取",
    limit: 1,
  })) as { text: string };
  assert.ok(
    onlyVisible.text.startsWith("命中的工具都已在可见集中，直接调用即可。"),
    onlyVisible.text,
  );

  const mixed = makeRuntime();
  const toolMixed = createConsultTool(mixed.runtime);
  const result = (await toolMixed.execute({ query: "文件" })) as {
    text: string;
  };
  assert.equal(result.text.includes("都已在可见集中"), false);
  const grantedIndex = result.text.indexOf("- write：");
  const visibleIndex = result.text.indexOf("- read：");
  assert.ok(grantedIndex >= 0 && visibleIndex > grantedIndex, result.text);
  assert.ok(result.text.includes("（已在可见集，直接调用即可）"));
  assert.deepEqual(mixed.grants.allowedNames(), ["write"]);

  const preview = makeRuntime();
  const toolPreview = createConsultTool(preview.runtime);
  const previewResult = (await toolPreview.execute({
    query: "文件",
    reveal: false,
  })) as { text: string };
  assert.ok(previewResult.text.includes("（预览，未揭示）"));
  assert.equal(preview.grants.allowedNames().length, 0);
});

test("query 无命中: 分组索引 + 配额", async () => {
  const { runtime } = makeRuntime();
  const tool = createConsultTool(runtime);
  const result = (await tool.execute({ query: "量子纠缠" })) as {
    text: string;
  };
  assert.ok(result.text.includes("没有匹配的工具。可用的工具分组："));
  assert.ok(result.text.includes("请换更宽泛的词，或用 names 精确指定。"));
  assert.ok(result.text.includes("session 档已揭示 0 项"));
});

test("pin 三态: session 忽略 / turn 名额满 / turn 已钉住", async () => {
  const session = makeRuntime();
  const sessionText = (await createConsultTool(session.runtime).execute({
    names: ["write"],
    pin: true,
  })) as { text: string };
  assert.ok(
    sessionText.text.includes("[pin 仅 turn 档生效，本次忽略]"),
    sessionText.text,
  );

  const full = makeRuntime({
    config: { revealScope: "turn", maxPinned: 0 },
  });
  const fullText = (await createConsultTool(full.runtime).execute({
    names: ["write"],
    pin: true,
  })) as { text: string };
  assert.ok(
    fullText.text.includes("[钉住名额已满，按普通揭示处理]"),
    fullText.text,
  );

  const pinned = makeRuntime({
    config: { revealScope: "turn", maxPinned: 2 },
  });
  const pinnedText = (await createConsultTool(pinned.runtime).execute({
    names: ["write"],
    pin: true,
  })) as { text: string };
  assert.ok(pinnedText.text.includes("[已钉住]"), pinnedText.text);
  assert.ok(pinnedText.text.includes("已揭示（仅本回合有效"), pinnedText.text);
});

test("turn 配额: 只报计数与钉住数, 不写成新增上限", async () => {
  const { runtime } = makeRuntime({ config: { revealScope: "turn" } });
  const tool = createConsultTool(runtime);
  await tool.execute({ names: ["write"], pin: true });
  const result = (await tool.execute({ names: ["task_status"] })) as {
    text: string;
  };
  assert.ok(
    result.text.includes("turn 档已揭示 2 项（钉住 1 / 3）"),
    result.text,
  );
  assert.ok(result.text.includes("turn 档不设新增上限"));
});

test("重复揭示: 第二次按已可见处理, 授权不重复累加", async () => {
  const { runtime } = makeRuntime();
  const tool = createConsultTool(runtime);
  const first = (await tool.execute({ names: ["write"] })) as { text: string };
  assert.ok(first.text.includes("已揭示"));
  const second = (await tool.execute({ names: ["write"] })) as { text: string };
  assert.ok(
    second.text.includes("- write：写入文件内容。（已在可见集，直接调用即可）"),
    second.text,
  );
  assert.deepEqual(runtime.grants.allowedNames(), ["write"]);
});

test("output.render: 取 text, 缺 text 时按字符串投影; schema 与参数面稳定", () => {
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
  assert.deepEqual(tool.output.schema, {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  });
  assert.equal(tool.name, "consult_tools");
  assert.equal(
    (tool.parameters as { additionalProperties?: boolean })
      .additionalProperties,
    false,
  );
});
