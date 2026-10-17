/**
 * `memory_query` 工具测试：两种 action、参数缺省与 clamp、截断标注、错误值渲染、只读边界。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIMIT,
  memoryQueryTool,
  renderQueryResult,
  type MemoryQueryExecutor,
} from "../src/tools.ts";
import type { SearchHit, StoreRow } from "../src/knowledge.ts";

/** 造一行（只填测试关心的字段）。 */
function row(
  id: number,
  content: string,
  kind = "note",
  tier = "session",
): StoreRow {
  return {
    id,
    kind,
    tier: tier as StoreRow["tier"],
    project: "p",
    title: null,
    content,
    importance: 3,
    sessionId: null,
    createdAt: 1_700_000_000_000 + id,
  };
}

/** 替身执行面：记录入参并返回固定行。 */
function makeExecutor(rows: StoreRow[]): {
  executor: MemoryQueryExecutor;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    executor: {
      list: async (opts) => {
        calls.push({ action: "list", ...opts });
        return rows;
      },
      search: async (opts) => {
        calls.push({ action: "search", ...opts });
        return rows.map((item): SearchHit => ({ ...item, score: 0 }));
      },
    },
  };
}

type ToolDef = {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
  execute(args: Record<string, unknown>): Promise<{
    action: string;
    count: number;
    limit: number;
    truncated: boolean;
    items: StoreRow[];
    error?: string;
  }>;
  output: {
    schema: Record<string, unknown>;
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
};

test("工具定义：名称、只读描述、action 枚举与参数面", () => {
  const { executor } = makeExecutor([]);
  const tool = memoryQueryTool(executor) as ToolDef;
  assert.equal(tool.name, "memory_query");
  assert.match(tool.description, /只读/);
  assert.match(tool.description, /action=search/);
  const action = tool.parameters.properties.action as { enum: string[] };
  assert.deepEqual(action.enum, ["search", "list"]);
  const limit = tool.parameters.properties.limit as { maximum: number };
  assert.equal(limit.maximum, 100);
  assert.equal(tool.output.schema.type, "object");
});

test("action 缺省为 search：query 必填、缺 query 返回 error 且不调执行面", async () => {
  const { executor, calls } = makeExecutor([row(1, "命中内容")]);
  const tool = memoryQueryTool(executor) as ToolDef;

  const missing = await tool.execute({});
  assert.equal(missing.action, "search");
  assert.equal(missing.count, 0);
  assert.match(missing.error ?? "", /需要 query/);
  assert.equal(calls.length, 0);

  const ok = await tool.execute({ query: "命中" });
  assert.equal(ok.count, 1);
  assert.deepEqual(calls[0], {
    action: "search",
    query: "命中",
    limit: DEFAULT_LIMIT,
  });
});

test("action=list：按 kind / tier / project 收窄，offset 透传", async () => {
  const { executor, calls } = makeExecutor([row(1, "条目")]);
  const tool = memoryQueryTool(executor) as ToolDef;
  const result = await tool.execute({
    action: "list",
    kind: "note",
    tier: "project",
    project: "p1",
    limit: 5,
    offset: 10,
  });
  assert.equal(result.action, "list");
  assert.deepEqual(calls[0], {
    action: "list",
    kind: "note",
    tier: "project",
    project: "p1",
    limit: 5,
    offset: 10,
  });
  // 非法 tier 被忽略（不当作过滤条件）。
  await tool.execute({ action: "list", tier: "bogus" });
  assert.equal(calls[1]?.tier, undefined);
  // query 对 list 无意义，不要求。
  assert.equal(result.count, 1);
});

test("limit clamp 1..100，非法值回落缺省", async () => {
  const { executor, calls } = makeExecutor([]);
  const tool = memoryQueryTool(executor) as ToolDef;
  assert.equal((await tool.execute({ action: "list", limit: 0 })).limit, 1);
  assert.equal((await tool.execute({ action: "list", limit: 999 })).limit, 100);
  assert.equal(
    (await tool.execute({ action: "list", limit: "abc" })).limit,
    DEFAULT_LIMIT,
  );
  assert.equal((await tool.execute({ action: "list", limit: "7" })).limit, 7);
  assert.deepEqual(
    calls.map((call) => call.limit),
    [1, 100, DEFAULT_LIMIT, 7],
  );
});

test("fuzzy 只在显式 true 时透传（仅 search）", async () => {
  const { executor, calls } = makeExecutor([]);
  const tool = memoryQueryTool(executor) as ToolDef;
  await tool.execute({ query: "x" });
  await tool.execute({ query: "x", fuzzy: true });
  await tool.execute({ action: "list", fuzzy: true });
  assert.equal(calls[0]?.fuzzy, undefined);
  assert.equal(calls[1]?.fuzzy, true);
  assert.equal(calls[2]?.action, "list");
});

test("truncated：行数达到 limit 即标注截断", async () => {
  const { executor } = makeExecutor([row(1, "a"), row(2, "b")]);
  const tool = memoryQueryTool(executor) as ToolDef;
  const truncated = await tool.execute({ action: "list", limit: 2 });
  assert.equal(truncated.truncated, true);
  const notTruncated = await tool.execute({ action: "list", limit: 10 });
  assert.equal(notTruncated.truncated, false);
});

test("render：空结果 / 截断 / 长正文截断 / 错误值都有明确标注", () => {
  const empty = renderQueryResult({
    action: "search",
    count: 0,
    limit: 10,
    truncated: false,
    items: [],
  });
  assert.equal(empty, "(无命中)");
  assert.equal(
    renderQueryResult({
      action: "list",
      count: 0,
      limit: 10,
      truncated: false,
      items: [],
    }),
    "(无条目)",
  );

  const long = "x".repeat(400);
  const text = renderQueryResult({
    action: "search",
    count: 1,
    limit: 1,
    truncated: true,
    items: [row(7, long, "note", "user")],
  });
  assert.match(text, /已截断/);
  assert.match(text, /正文已截断/);
  assert.match(text, /\[note@user\]/);
  assert.match(text, /importance=3 id=7/);

  assert.match(
    renderQueryResult({
      action: "search",
      count: 0,
      limit: 10,
      truncated: false,
      items: [],
      error: "boom",
    }),
    /memory_query 失败：boom/,
  );
});

test("output.render：畸形值也能渲染出文本（不抛）", () => {
  const { executor } = makeExecutor([]);
  const tool = memoryQueryTool(executor) as ToolDef;
  for (const value of [null, undefined, 42, "text", {}]) {
    const blocks = tool.output.render({}, value);
    assert.equal(blocks.length, 1);
    assert.equal(typeof blocks[0]?.text, "string");
    assert.ok((blocks[0]?.text.length ?? 0) > 0);
  }
});
