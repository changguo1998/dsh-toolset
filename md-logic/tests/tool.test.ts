// tests/tool.test.ts — 模型侧工具面：注册、契约面、参数校验、渲染、路径与读取守卫。

import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, inject, mdLogicTool, name } from "../src/index.ts";
import { SAMPLE, withTempDir, writeFixture } from "./helpers.ts";

/** 工具定义的最小结构面（与 tools.ts 产出一致）。 */
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
    schema: { type: string; additionalProperties?: boolean };
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

/** 捕获注册的宿主桩。 */
function mockHost(): {
  defs: unknown[];
  logs: string[];
  host: {
    tools: { register(def: unknown): void };
    logger(ns: string): { info(message: string): void };
  };
} {
  const defs: unknown[] = [];
  const logs: string[] = [];
  return {
    defs,
    logs,
    host: {
      tools: { register: (def) => defs.push(def) },
      logger: (ns) => ({
        info: (message: string) => logs.push(`${ns}: ${message}`),
      }),
    },
  };
}

const tool = mdLogicTool() as ToolDef;

/** 渲染工具返回值（render 契约：args 第一、value 第二）。 */
function textOf(value: unknown): string {
  return tool.output.render({ probe: true }, value)[0]?.text ?? "";
}

test("apply 注册 md_logic，契约面完整", () => {
  const { defs, logs, host } = mockHost();
  apply(host);
  assert.deepEqual(
    defs.map((def) => (def as ToolDef).name),
    ["md_logic"],
  );
  assert.equal(name, "md-logic");
  assert.deepEqual(inject, ["tools"]);
  assert.equal(tool.output.schema.type, "object");
  assert.equal(typeof tool.output.render, "function");
  assert.deepEqual(tool.parameters.required, ["action", "path"]);
  assert.ok(logs.some((log) => log.includes("md-logic ready")));
});

test("参数校验：返回 {error} 不抛", async () => {
  const cases: Array<[unknown, string]> = [
    ["not-an-object", "入参必须是对象"],
    [{ path: "a.md" }, "未知 action"],
    [{ action: "whatever", path: "a.md" }, "未知 action"],
    [{ action: "structure" }, "需要 path"],
    [{ action: "structure", path: "a.md", depth: 0 }, "depth"],
    [{ action: "structure", path: "a.md", depth: 1.5 }, "depth"],
    [{ action: "blocks", path: "a.md", kind: ["paragraph"] }, "未知块类型"],
    [{ action: "links", path: "a.md", linkKind: ["anchor"] }, "未知链接类型"],
    [{ action: "structure", path: "/nonexistent/x.md" }, "文件不存在"],
  ];
  for (const [args, needle] of cases) {
    const value = (await tool.execute(args as Record<string, unknown>)) as {
      error?: string;
    };
    assert.ok(
      typeof value.error === "string" && value.error.includes(needle),
      `args=${JSON.stringify(args)} 应报含「${needle}」的错误，实际：${JSON.stringify(value)}`,
    );
    assert.ok(textOf(value).includes("md_logic 失败"));
  }
});

test("读取守卫：超限与二进制报错", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFixture(dir, "big.md", "# A\n" + "x".repeat(64) + "\n");
    const small = mdLogicTool(32) as ToolDef;
    const tooLarge = (await small.execute({
      action: "structure",
      path: `${dir}/big.md`,
    })) as { error?: string };
    assert.ok(tooLarge.error?.includes("超过上限"), JSON.stringify(tooLarge));

    writeFixture(dir, "bin.md", "# A\n\u0000\u0001\n");
    const binary = (await tool.execute({
      action: "structure",
      path: `${dir}/bin.md`,
    })) as { error?: string };
    assert.ok(binary.error?.includes("二进制"), JSON.stringify(binary));
  } finally {
    cleanup();
  }
});

test("structure：节树带行范围，depth 控制层数", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "s.md", SAMPLE);
    const value = await tool.execute({ action: "structure", path: file });
    const text = textOf(value);
    assert.match(text, /^Markdown 结构：35 行 \/ 3 节 \/ 7 块 \/ 3 链接$/m);
    assert.match(text, /^L6-34 h1 标题一$/m);
    assert.match(text, /^ {2}L10-28 h2 小节 1\.1$/m);

    const shallow = await tool.execute({
      action: "structure",
      path: file,
      depth: 1,
    });
    const shallowText = textOf(shallow);
    assert.ok(shallowText.includes("L6-34 h1 标题一"));
    assert.ok(!shallowText.includes("小节 1.1"), shallowText);
  } finally {
    cleanup();
  }
});

test("blocks：清单带节归属与计数，kind 过滤生效", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "s.md", SAMPLE);
    const text = textOf(await tool.execute({ action: "blocks", path: file }));
    assert.match(text, /^§L10 L12-14 list·3项·d2$/m);
    assert.match(text, /^§L10 L16-18 code·ts$/m);
    assert.match(text, /^§L10 L20-23 table·2行×2列$/m);
    assert.match(text, /^§L10 L25-26 quote·2行·d1$/m);

    const only = textOf(
      await tool.execute({ action: "blocks", path: file, kind: ["hr"] }),
    );
    assert.equal(only.trim(), "§L30 L34 hr");

    const none = textOf(
      await tool.execute({ action: "blocks", path: file, line: 5 }),
    );
    assert.equal(none, "(无块)");
  } finally {
    cleanup();
  }
});

test("links：链接 / 图片 / 定义清单", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    const file = writeFixture(dir, "s.md", SAMPLE);
    const text = textOf(await tool.execute({ action: "links", path: file }));
    assert.match(text, /^§L6 L8 link "链接" → http:\/\/example\.com$/m);
    assert.match(text, /^§L6 L8 image "图" → img\.png$/m);
    assert.match(
      text,
      /^§L10 L28 definition \[ref\] → http:\/\/ref\.example "\(标题\)"$/m,
    );
    const filtered = textOf(
      await tool.execute({ action: "links", path: file, pattern: "img" }),
    );
    assert.equal(filtered.trim(), '§L6 L8 image "图" → img.png');
  } finally {
    cleanup();
  }
});

test("相对路径按调用方会话 cwd 解析", async () => {
  const { dir, cleanup } = withTempDir();
  try {
    writeFixture(dir, "rel.md", "# A\n");
    const exec = { agent: { session: { header: { cwd: dir } } } };
    const ok = (await tool.execute(
      { action: "structure", path: "rel.md" },
      exec,
    )) as { doc?: unknown };
    assert.ok(ok.doc !== undefined, JSON.stringify(ok));
    const missing = (await tool.execute(
      { action: "structure", path: "rel.md" },
      { agent: { session: { header: { cwd: "/nonexistent" } } } },
    )) as { error?: string };
    assert.ok(missing.error?.includes("文件不存在"));
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
  // args 形状与 value **同形**，标记放在渲染器会回显的字段里
  const argsShaped = {
    action: "links",
    links: [
      { kind: "inline", line: 1, text: "t", href: "ARGS_MARKER_NOT_RENDERED" },
    ],
  };
  const valueShaped = {
    action: "links",
    links: [
      { kind: "inline", line: 1, text: "t", href: "SENTINEL_VALUE_MARKER" },
    ],
  };
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
