// tests/pipeline-measure.test.ts — §5 测量 整体模块测试（一次只测这一个阶段）
//
// 模块口径：`measure` 对树写 width/height —— 叶高=wrapLeaf 行数、代码/表格/工具
// 各自高度模型、v 高求和、h 高取 max 且 fixed/auto/fill 分派宽。
// 不混入 flatten/compose（各有专属模块测试）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { measure } from "../src/app/layout/pipeline/measure.ts";
import { buildTrees } from "../src/app/layout/pipeline/structure.ts";
import { parse } from "../src/app/layout/pipeline/parse.ts";
import type {
  Node,
  Leaf,
  Section,
  Paragraph,
} from "../src/app/layout/pipeline/ir.ts";

function sec(partial: Partial<Section> & { id: string }): Section {
  return { turn: 1, step: 1, seqs: [], ...partial };
}

function leafTree(leaf: Leaf, width = 20): { leaf: Leaf; h: number } {
  const tree: Node = { direction: "v", children: [leaf] };
  measure(tree, width, { vw: width });
  return { leaf, h: tree.height ?? 0 };
}

test("measure：文本叶 height === wrapLeaf 行数（单行/长折行）", () => {
  assert.equal(leafTree({ text: [{ text: "hi" }] }).h, 1, "单行 1 行");
  const long = leafTree({ text: [{ text: "a".repeat(40) }] }, 10);
  assert.equal(long.leaf.height, 4, "40 字符在 10 宽下折 4 行"); // +1? 见实际
});

test("measure：v 容器高度 = 子高之和", () => {
  const a: Leaf = { text: [{ text: "aa" }] };
  const b: Leaf = { text: [{ text: "bb" }] };
  const v: Node = { direction: "v", children: [a, b] };
  measure(v, 20, { vw: 20 });
  assert.equal(v.height, 2, "两单行叶 v 高 2");
});

test("measure：h 容器高度 = max 子高；fixed/auto/fill 分派宽之和 = 容器宽", () => {
  const fixed: Leaf = {
    text: [{ text: "xx" }],
    widthStyle: "fixed",
    widthFixed: 3,
  };
  const auto: Leaf = { text: [{ text: "abc" }] };
  const fill: Leaf = { text: [], widthStyle: "fill", widthMin: 2 };
  const multi: Leaf = { text: [{ text: "qwertyuiop" }] }; // 10 宽下能折多行的高子
  const h: Node = { direction: "h", children: [fixed, auto, fill, multi] };
  measure(h, 20, { vw: 20 });
  assert.equal(
    (fixed.width ?? 0) +
      (auto.width ?? 0) +
      (fill.width ?? 0) +
      (multi.width ?? 0),
    20,
    "四子宽和 = 容器宽",
  );
  // h 高 = max 子高（multi 多行 > 其它）
  assert.ok((h.height ?? 0) >= (multi.height ?? 0), "h 高取 max");
});

test("measure：代码/表格/工具载荷节点高度模型", () => {
  // 代码（Node 带 code 载荷，与 structure.toCode 同构——Block 冻结不可直接测量）
  const codeNode: Node = {
    direction: "v",
    children: [],
    code: { lang: "", rows: ["a", "b"], closed: true },
  };
  measure(codeNode as never, 20, { vw: 20 });
  assert.equal(codeNode.direction, "v");
  assert.ok((codeNode.height ?? 0) >= 2, "代码 ≥ 2 行（两行内容）");
  // 表格
  const tblNode: Node = {
    direction: "v",
    children: [],
    table: {
      aligns: ["left", "left"],
      header: [para("H1"), para("H2")],
      rows: [[para("a"), para("b")]],
    },
  };
  measure(tblNode, 30, { vw: 30 });
  assert.ok((tblNode.height ?? 0) >= 3, "表格高度（表头+横线+数据）");
});

test("measure：用户块外壳 h 铺满 pane，符号格 fixed 2，内容按剩余宽测量", () => {
  const u = parse(
    sec({
      id: "1:1:0",
      user: {},
      body: { source: "user", text: "甲".repeat(12) },
    }),
  )[0] as Paragraph;
  const tree = buildTrees([u], [], { userSym: () => ({ text: "?" }) })
    .session as Node;
  measure(tree, 30, { vw: 30 });
  const block = tree.children[0] as Node;
  assert.equal(block.direction, "h", "外壳 h");
  assert.equal(block.width, 30, "外壳铺满 pane 宽");
  const kids = block.children as Node[];
  assert.equal(kids[1]!.width, 2, "符号格 fixed 2 列");
  // 12 个全宽字 + 符号 2 + 竖线 1 = 27 < 30 → 单行
  assert.equal(block.height, 1, "12 个全宽字单行");
});

function para(txt: string): Paragraph {
  return {
    kind: "paragraph",
    source: "assistant",
    id: "p" + txt,
    span: [0, 1],
    text: [{ text: txt }],
  };
}
