// tests/tool.test.ts — 工具面契约：注册形状 + `render` 形参顺序（args 第一、value 第二）。
//
// 为什么需要它：本包原先 `render` 写成单形参，宿主 `output.render(exec.arguments, value)`
// 于是把**入参**当成渲染值 → 模型只看到入参回显（`hash_read` 拿不到 `hashlines`），
// 而纯函数测试（edit / fs / hashline）覆盖不到这一层，bug 一直没被拦下。

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { apply } from "../src/main.ts";

/** 建临时文件（与 fs.test.ts 同款，自建不自引 helpers）。 */
async function makeTmp(
  content: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "hash-edit-tool-test-"));
  const path = join(dir, "sample.txt");
  await writeFile(path, content, "utf8");
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 工具定义的最小结构面（宿主侧结构式消费）。 */
interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(args: Record<string, unknown>): Promise<unknown>;
  output: {
    schema: { type: string; additionalProperties?: boolean };
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

/** 跑一次 `apply`，返回注册到的工具表。 */
async function registerTools(): Promise<Map<string, RegisteredTool>> {
  const tools = new Map<string, RegisteredTool>();
  await apply({
    tools: {
      register: (def: unknown) => {
        const tool = def as RegisteredTool;
        tools.set(tool.name, tool);
      },
    },
  });
  return tools;
}

test("apply 注册 hash_read / hash_edit，形状符合宿主契约", async () => {
  const tools = await registerTools();
  assert.deepEqual([...tools.keys()].sort(), ["hash_edit", "hash_read"]);
  for (const tool of tools.values()) {
    assert.equal(typeof tool.description, "string");
    assert.notEqual(tool.parameters, undefined);
    assert.equal(tool.output.schema.type, "object");
    assert.equal(typeof tool.output.render, "function");
  }
});

test("render(args, value)：渲染的是 value（含 hashlines），不是入参回显", async () => {
  const tools = await registerTools();
  const tool = tools.get("hash_read");
  assert.ok(tool !== undefined);
  const value = {
    ok: true,
    path: "a.txt",
    file_hash: "deadbeef",
    line_count: 2,
    hashlines: [{ line: 1, hash: "1234abcd", text: "alpha" }],
  };
  const text =
    tool.output.render({ path: "a.txt", offset: 1 }, value)[0]?.text ?? "";
  assert.match(text, /"hashlines"/);
  assert.match(text, /"1234abcd"/);
  assert.ok(!text.includes('"offset"'), "入参字段不该出现在渲染结果里");
});

test("render 形参顺序哨兵：渲染的必须是第二参（变异回单形参必失败）", async () => {
  const tools = await registerTools();
  const tool = tools.get("hash_read");
  assert.ok(tool !== undefined);
  // 有鉴别力的写法（审阅给出）：第一参传 value 形状、第二参传哨兵——
  // 单形参实现会把**第一参**当 value 渲染 → 文本含 hashlines 且不含哨兵 → 两条断言都失败。
  // 原先的 `render(args, value) !== render(value)` 无鉴别力：两种实现下两个文本本来就不同。
  const valueShaped = { ok: true, hashlines: [{ line: 1, hash: "abcd1234" }] };
  const SENTINEL = { sentinel: "SENTINEL_VALUE" };
  const text = tool.output.render(valueShaped, SENTINEL)[0]?.text ?? "";
  assert.match(text, /SENTINEL_VALUE/, "渲染的必须是第二参（value）");
  assert.ok(!text.includes("hashlines"), "第一参（args）不该被当成 value 渲染");
});

test("render 是全函数：畸形值不抛", async () => {
  const tools = await registerTools();
  const tool = tools.get("hash_edit");
  assert.ok(tool !== undefined);
  for (const bad of [
    undefined,
    null,
    42,
    "text",
    [],
    { ok: false, error: "x" },
  ]) {
    const blocks = tool.output.render({ probe: true }, bad);
    assert.equal(blocks[0]?.type, "text");
    assert.equal(typeof blocks[0]?.text, "string");
  }
});

test("端到端（工具面）：hash_edit 结果经 render 可见（同一适配器）", async () => {
  const { path: file, cleanup } = await makeTmp("alpha\nbeta\n");
  try {
    const tools = await registerTools();
    const edit = tools.get("hash_edit");
    const read = tools.get("hash_read");
    assert.ok(edit !== undefined && read !== undefined);
    const readValue = (await read.execute({ path: file })) as {
      hashlines: Array<{ line: number; hash: string }>;
    };
    const anchor = readValue.hashlines[1];
    assert.ok(anchor !== undefined);
    const value = await edit.execute({
      path: file,
      edits: [{ replace_lines: { start_anchor: `${anchor.line}:${anchor.hash}`, end_anchor: `${anchor.line}:${anchor.hash}`, new_text: "BETA" } }],
    });
    const text = edit.output.render({ path: file }, value)[0]?.text ?? "";
    assert.match(text, /"ok": true/);
    assert.ok(!text.includes('"edits"'), "渲染的是结果而不是入参");
  } finally {
    cleanup();
  }
});

test("value 形状过 output.schema（宿主 render 前会先校验值）", async () => {
  const tools = await registerTools();
  const tool = tools.get("hash_read");
  assert.ok(tool !== undefined);
  assert.equal(tool.output.schema.type, "object");
  assert.equal(tool.output.schema.additionalProperties, true);
});

test("端到端（工具面）：hash_read 真实结果经 render 到模型可见的锚点", async () => {
  const { path: file, cleanup } = await makeTmp("alpha\nbeta\n");
  try {
    const tools = await registerTools();
    const tool = tools.get("hash_read");
    assert.ok(tool !== undefined);
    const value = await tool.execute({ path: file });
    const text = tool.output.render({ path: file }, value)[0]?.text ?? "";
    assert.match(text, /"hashlines"/);
    assert.match(text, /"line": 1/);
    assert.match(text, /"text": "alpha"/);
  } finally {
    cleanup();
  }
});
