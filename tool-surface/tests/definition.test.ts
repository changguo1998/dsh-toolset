/**
 * tool-surface 包装层单测: 换位 / 透传 / 严格校验 / catalog 隔离。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ToolArgsError } from "@deepseek-ai/dsh-tools";
import {
  isWrappedDefinition,
  listSurface,
  lookupSurface,
  resetSurfaceCatalog,
  wrapToolDefinition,
} from "../src/definition.ts";

/** 演示工具: 完整说明 + 完整参数（必填 value, 可选枚举 mode, 拒绝多余字段）。 */
function makeTool() {
  const calls: Array<{ args: unknown; exec: unknown }> = [];
  const tool = {
    name: "demo_tool",
    description:
      "用途: 演示包装层。\n用法: 给 value（必填）与可选 mode。\n边界: 只演示。",
    summary: "用途: 演示包装层, 完整说明与参数 schema 经 tool_consult 查询。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: {
        value: { type: "string" },
        mode: { type: "string", enum: ["a", "b"] },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: () => [],
    },
    timeoutMs: 3000,
    deferLoading: false,
    async execute(args: Record<string, unknown>, exec?: unknown) {
      calls.push({ args, exec });
      return { ok: true, value: args["value"] };
    },
  };
  return { tool, calls };
}

test("注册定义换位: 短说明 + 宽松占位, summary 不外泄", () => {
  resetSurfaceCatalog();
  const { tool } = makeTool();
  const wrapped = wrapToolDefinition(tool);

  assert.equal(wrapped.name, "demo_tool");
  assert.equal(
    wrapped.description,
    "用途: 演示包装层, 完整说明与参数 schema 经 tool_consult 查询。",
  );
  assert.deepEqual(wrapped.parameters, {
    type: "object",
    additionalProperties: true,
    properties: {},
    description: "完整参数 schema 经 tool_consult 查询",
  });
  assert.equal("summary" in wrapped, false);
});

test("其余字段原样透传: output / timeoutMs / deferLoading / execute", () => {
  resetSurfaceCatalog();
  const { tool } = makeTool();
  const wrapped = wrapToolDefinition(tool);

  assert.equal(wrapped.output, tool.output);
  assert.equal(wrapped.timeoutMs, 3000);
  assert.equal(wrapped.deferLoading, false);
  assert.equal(typeof wrapped.execute, "function");
  assert.notEqual(wrapped.execute, tool.execute);
});

test("catalog 保存完整说明与完整参数 schema", () => {
  resetSurfaceCatalog();
  const { tool } = makeTool();
  wrapToolDefinition(tool);

  const entry = lookupSurface("demo_tool");
  assert.ok(entry);
  assert.equal(entry.name, "demo_tool");
  assert.equal(entry.description, tool.description);
  assert.deepEqual(entry.parameters, tool.parameters);
  assert.equal(lookupSurface("missing_tool"), undefined);
});

test("显式 summary 缺省时取完整说明首行并补指向", () => {
  resetSurfaceCatalog();
  const { tool } = makeTool();
  const { summary: _drop, ...rest } = tool;
  const wrapped = wrapToolDefinition(rest);

  assert.equal(
    wrapped.description,
    "用途: 演示包装层。 完整说明与参数 schema 经 tool_consult 查询。",
  );
  assert.equal(lookupSurface("demo_tool")?.description, tool.description);
});

test("参数合法时透传原 execute 的入参与返回值", async () => {
  resetSurfaceCatalog();
  const { tool, calls } = makeTool();
  const wrapped = wrapToolDefinition(tool);
  const exec = { agent: { session: { id: "s1" } } };

  const result = await wrapped.execute({ value: "x", mode: "a" }, exec);

  assert.deepEqual(result, { ok: true, value: "x" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, { value: "x", mode: "a" });
  assert.equal(calls[0]?.exec, exec);
});

test("缺必填字段时抛 ToolArgsError 且不调原 execute", async () => {
  resetSurfaceCatalog();
  const { tool, calls } = makeTool();
  const wrapped = wrapToolDefinition(tool);

  await assert.rejects(
    () => wrapped.execute({}),
    (error: unknown) => {
      assert.ok(error instanceof ToolArgsError);
      assert.ok(error.violations.some((item) => item.includes("value")));
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("多余字段与枚举越界同样被拦下", async () => {
  resetSurfaceCatalog();
  const { tool, calls } = makeTool();
  const wrapped = wrapToolDefinition(tool);

  await assert.rejects(
    () => wrapped.execute({ value: "x", extra: 1 }),
    (error: unknown) => error instanceof ToolArgsError,
  );
  await assert.rejects(
    () => wrapped.execute({ value: "x", mode: "c" }),
    (error: unknown) => error instanceof ToolArgsError,
  );
  assert.equal(calls.length, 0);
});

test("catalog 与入参互不影响（两向深拷贝）", () => {
  resetSurfaceCatalog();
  const { tool } = makeTool();
  const wrapped = wrapToolDefinition(tool);

  tool.parameters.properties.value.type = "number";
  const properties = lookupSurface("demo_tool")?.parameters["properties"] as
    Record<string, { type?: string }> | undefined;
  assert.equal(properties?.["value"]?.type, "string");

  const entry = lookupSurface("demo_tool");
  assert.ok(entry);
  entry.parameters["type"] = "array";
  assert.equal(lookupSurface("demo_tool")?.parameters["type"], "object");
  assert.equal(wrapped.description.includes("tool_consult"), true);
});

test("重复包装不再改 catalog（占位不会被当成全文）", () => {
  resetSurfaceCatalog();
  const { tool } = makeTool();
  const once = wrapToolDefinition(tool);
  const twice = wrapToolDefinition(once);

  assert.equal(twice, once);
  assert.deepEqual(lookupSurface("demo_tool")?.parameters, tool.parameters);
});

test("listSurface 按注册顺序给出全部条目", () => {
  resetSurfaceCatalog();
  wrapToolDefinition({ ...makeTool().tool, name: "first_tool" });
  wrapToolDefinition({ ...makeTool().tool, name: "second_tool" });

  assert.deepEqual(
    listSurface().map((entry) => entry.name),
    ["first_tool", "second_tool"],
  );
});

test("isWrappedDefinition 只认包装层自身产出的定义", () => {
  resetSurfaceCatalog();
  const { tool } = makeTool();
  const wrapped = wrapToolDefinition(tool);

  assert.equal(isWrappedDefinition(tool), false);
  assert.equal(isWrappedDefinition(wrapped), true);
  assert.equal(isWrappedDefinition(wrapToolDefinition(wrapped)), true);
  assert.equal(isWrappedDefinition(null), false);
  assert.equal(isWrappedDefinition("demo_tool"), false);
  assert.equal(isWrappedDefinition(Object.create(wrapped)), false);
});
