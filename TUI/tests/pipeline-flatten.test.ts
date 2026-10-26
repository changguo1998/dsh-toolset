// tests/pipeline-flatten.test.ts — §6 摊平 整体模块测试（一次只测这一个阶段）
//
// 模块口径：`flatten` 对已量好的树产 Row[] —— 叶折行+prefix/suffix/tail、
// 代码/表格/工具网格、Gap 空行、h 补白合并、v 顺序拼接。
// 不混入 measure/compose（各有专属模块测试）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { flatten } from "../src/app/layout/pipeline/flatten.ts";
import { measure } from "../src/app/layout/pipeline/measure.ts";
import { buildTrees } from "../src/app/layout/pipeline/structure.ts";
import { parse } from "../src/app/layout/pipeline/parse.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
import type {
  Node,
  Leaf,
  Section,
  Paragraph,
} from "../src/app/layout/pipeline/ir.ts";

function sec(partial: Partial<Section> & { id: string }): Section {
  return { turn: 1, step: 1, seqs: [], ...partial };
}

function text(rows: ReturnType<typeof flatten>): string {
  return rows.map((r) => r.segments.map((s) => s.text).join("")).join("\n");
}

test("flatten：正文叶 prefix+body+suffix+tail 拼满 width", () => {
  const leaf: Leaf = {
    text: [{ text: "ab" }],
    prefix: { text: ">" },
    suffix: { text: "|" },
    tail: { char: "." },
  };
  const v: Node = { direction: "v", children: [leaf] };
  measure(v, 8, { vw: 8 });
  const rows = flatten(v, 8, { vw: 8 });
  assert.equal(text(rows), ">ab|....", "prefix+body+suffix+tail");
});

test("flatten：Gap 空叶 → 裸空行（空行唯一来源）", () => {
  const gap: Leaf = { text: [] };
  const v: Node = {
    direction: "v",
    children: [gap, { text: [{ text: "x" }] }],
  };
  measure(v, 10, { vw: 10 });
  const rows = flatten(v, 10, { vw: 10 });
  assert.equal(rows[0]!.segments.length, 0, "首个为空行");
  assert.equal(rows.length, 2);
});

test("flatten：代码网格含行号列 + 行号与代码之间的列分隔（单文件多行）", () => {
  const node: Node = {
    direction: "v",
    children: [],
    code: { lang: "", rows: ["a", "b"], closed: true },
  };
  measure(node, 24, { vw: 24 });
  const rows = flatten(node, 24, { vw: 24 });
  assert.equal(rows.length, 2, "两行原样两行");
  const first = rows[0]!.segments.map((s) => s.text).join("");
  // 代码块本身不画来源竖线（交外层会话盒）；┃ 是行号列与代码列之间的列分隔
  assert.ok(first.startsWith(" 1┃"), "行号列 + 列分隔 ┃");
  assert.ok(!first.startsWith("┃"), "无左缘竖线");
});

test("flatten：表格网格 → 表头行含列分隔（│）", () => {
  const para = (t: string): Paragraph => ({
    kind: "paragraph",
    source: "assistant",
    id: "p" + t,
    span: [0, 1],
    text: [{ text: t }],
  });
  const node: Node = {
    direction: "v",
    children: [],
    table: {
      aligns: ["left", "left"],
      header: [para("H1"), para("H2")],
      rows: [[para("a"), para("b")]],
    },
  };
  measure(node, 30, { vw: 30 });
  const rows = flatten(node, 30, { vw: 30 });
  const head = rows[0]!.segments.map((s) => s.text).join("");
  assert.ok(head.includes("│"), "列分隔");
  assert.ok(!head.startsWith("┃"), "无左缘竖线（交外层会话盒）");
  // grid pass 定列宽：表头、横线交叉字、数据行的列边界同列
  const rule = rows[1]!.segments.map((s) => s.text).join("");
  const body = rows[2]!.segments.map((s) => s.text).join("");
  assert.equal(rule.indexOf("╪"), head.indexOf("│"), "交叉字落在列边界");
  assert.equal(body.indexOf("│"), head.indexOf("│"), "数据行列边界对齐");
});

test("flatten：h 容器 fill 补白 → 行宽 = 容器宽（右对齐）", () => {
  const fill: Leaf = { text: [], widthStyle: "fill" };
  const body: Leaf = { text: [{ text: "z" }] };
  const h: Node = { direction: "h", children: [fill, body] };
  measure(h, 10, { vw: 10 });
  const rows = flatten(h, 10, { vw: 10 });
  const w = rows[0]!.segments.reduce((m, s) => m + displayWidth(s.text), 0);
  assert.equal(w, 10, "行宽 = 容器宽");
  assert.ok(text(rows).trimEnd().endsWith("z"), "body 在右");
});

test("flatten：v 容器顺序拼接保持 item 序", () => {
  const a: Node = { direction: "v", children: [{ text: [{ text: "A" }] }] };
  const b: Leaf = { text: [{ text: "B" }] };
  const v: Node = { direction: "v", children: [a, b] };
  measure(v, 10, { vw: 10 });
  assert.equal(text(flatten(v, 10, { vw: 10 })), "A\nB");
});

test("flatten：用户块（结构树）摊平 → 首行含符号 + 右缘竖线", () => {
  const u = parse(
    sec({ id: "1:1:0", user: {}, body: { source: "user", text: "问" } }),
  )[0] as Paragraph;
  const tree = buildTrees([u], [], { userSym: () => ({ text: "?" }) }).session;
  measure(tree, 20, { vw: 20 });
  const rows = flatten(tree, 20, { vw: 20 });
  const t = text(rows);
  assert.ok(t.includes("?"), "含符号");
  assert.ok(t.trimEnd().endsWith("┃"), "右缘竖线");
});

test("flatten：会话外壳 prefix ┃ + 右缘 suffix → 首行铺满视口宽", () => {
  const para = parse(
    sec({ id: "1:1:0", body: { source: "assistant", text: "0".repeat(40) } }),
  )[0] as Paragraph;
  const gutter = 4;
  const width = 18;
  const tree = buildTrees([para], [], { gutter }).session;
  measure(tree, width, { vw: width });
  const rows = flatten(tree, width, { vw: width });
  const first = text(rows).split("\n")[0]!;
  // 会话外壳 = prefix "┃"（1 列，竖线后直接接正文）+ 正文 + suffix（gutter − 1 = 3 空格）；
  // 正文宽 = width − 1 − (gutter − 1)
  assert.ok(first.startsWith("┃0"), "竖线后直接接正文（无空格）");
  assert.equal(displayWidth(first), width, "首行 = 视口宽");
});
