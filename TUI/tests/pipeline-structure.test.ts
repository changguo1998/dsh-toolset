// tests/pipeline-structure.test.ts — §4 结构 整体模块测试（一次只测这一个阶段）
//
// 模块口径：PaneItem[]（parse 产的 Block + 手搓 头/Gap）→ `buildTrees` → Node/Leaf 树，
// 断言段落/思考前缀、用户块 toUser（符号+fill）、代码/表格/工具载荷、头 tail、Gap 空叶。
// 不混入 measure/flatten/router。

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/app/layout/pipeline/parse.ts";
import { buildTrees } from "../src/app/layout/pipeline/structure.ts";
import type {
  PaneItem,
  Section,
  TurnHeader,
  Gap,
  Node,
  Leaf,
  Paragraph,
} from "../src/app/layout/pipeline/ir.ts";
import { isNode } from "../src/app/layout/pipeline/ir.ts";

const ROOT = { direction: "v", id: undefined } as const;

function sec(partial: Partial<Section> & { id: string }): Section {
  return { turn: 1, step: 1, seqs: [], ...partial };
}

function sessTree(items: PaneItem[], opts?: Parameters<typeof buildTrees>[2]) {
  return buildTrees(items, [], opts).session as Node;
}

test("structure：正文段落 → 叶带左缘竖线前缀（蓝）", () => {
  const b = parse(
    sec({
      id: "1:1:0",
      final: true,
      body: { source: "assistant", text: "hi" },
    }),
  )[0]!;
  const root = sessTree([b]);
  assert.equal(root.direction, "v");
  const child = root.children[0]!;
  assert.ok(isNode(child) === false, "段落为叶");
  const leaf = child as Leaf;
  assert.ok(leaf.prefix, "带前缀");
  assert.equal(leaf.prefix!.style?.fg, "brightBlue");
});

test("structure：思考段落 → 紫前缀", () => {
  const r = parse(sec({ id: "1:1:0", reasoning: "想" }))[0]!;
  const root = sessTree([r]);
  const leaf = root.children[0] as Leaf;
  assert.equal(leaf.prefix!.style?.fg, "brightMagenta");
});

test("structure：用户块 → h [fill spacer, content]（toUser + userSym）", () => {
  const u = parse(
    sec({ id: "1:1:0", user: {}, body: { source: "user", text: "问" } }),
  )[0] as Paragraph;
  const root = buildTrees([u], [], { userSym: () => ({ text: "?" }) })
    .session as Node;
  const block = root.children[0] as Node;
  assert.equal(block.direction, "h");
  assert.equal(block.children[0]!.widthStyle, "fill", "左 fill spacer");
  const content = block.children[1] as Node;
  assert.equal(content.direction, "h");
  assert.equal(content.children[0]!.widthStyle, "fixed", "符号格 fixed");
});

test("structure：回合头 → 叶带 tail（分隔线铺满）", () => {
  const th: TurnHeader = { kind: "turn-header", key: "sep@1", turn: 1 };
  const root = sessTree([th]);
  const leaf = root.children[0] as Leaf;
  assert.equal(leaf.tail?.char, "╌", "回合头 tail ╌");
});

test("structure：Gap → 空 Leaf（空行唯一来源）", () => {
  const gap: Gap = { kind: "gap", key: "blank@x" };
  const root = sessTree([gap]);
  const leaf = root.children[0] as Leaf;
  assert.deepEqual(leaf.text, [], "Gap 为空文本叶");
});

test("structure：代码块 → v 节点带 code 载荷", () => {
  const code = parse(
    sec({
      id: "1:1:0",
      body: { source: "assistant", text: "```ts\nlet a=1;\n```" },
    }),
  )[0]!;
  const root = sessTree([code]);
  const node = root.children[0] as Node;
  assert.equal(node.code !== undefined, true);
  assert.deepEqual(node.code!.rows, ["let a=1;"]);
});

test("structure：工具批 → 节点带 tool 载荷（名字单元）", () => {
  const s = sec({
    id: "1:1:0",
    calls: [{ callId: "c1", name: "bash", args: "{}" }],
  });
  const batch: PaneItem = {
    kind: "tool-batch",
    key: "1:1:0:calls",
    calls: s.calls!,
    results: [],
  };
  const root = sessTree([batch]);
  const node = root.children[0] as Node;
  assert.equal(node.tool !== undefined, true, "tool 载荷");
  assert.equal(node.tool![0]!.role, "name", "名字单元");
});
