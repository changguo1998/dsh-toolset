// tests/fill.test.ts — fill 通用摊平引擎测试（SPEC §6.5/§6.7）
//
// Paragraph 折行/prefix/suffix/tail/对齐/valign + Box v/h 递归 + separator。
// 单段落单元测试用固定 rect（fillFixed，不涉 allocate）；Box 集成测试用
// measure+allocate 取子项矩形（render）。行内 markdown 复用 markdown.ts。

import { test } from "node:test";
import assert from "node:assert/strict";
import { v, h, text, spacer, type Node } from "../src/app/layout/box.ts";
import { measure, allocate } from "../src/app/layout/measure.ts";
import { fillToList, type ContentRow } from "../src/app/layout/fill.ts";
import { rowText } from "./helpers/rowText.ts";

const ctx = { themeId: "dark" as const };
const rowsText = (rows: ContentRow[]): string[] => rows.map(rowText);

/** 便捷 1：直接固定 rect 摊平（单段落单元测试，不涉 allocate） */
function fillFixed(node: Node, w: number, hgt: number): ContentRow[] {
  return fillToList(ctx, node, { x: 0, y: 0, w, h: hgt });
}

/** 便捷 2：measure+allocate+fill 一步到行（Box 集成测试） */
function render(node: Node, w: number, hgt: number): ContentRow[] {
  const st = measure(node, { maxW: w });
  const rects = allocate(st, { x: 0, y: 0, w, h: hgt });
  return fillToList(ctx, node, { x: 0, y: 0, w, h: hgt }, rects);
}

test("fill Paragraph：短文本单行", () => {
  const rows = fillFixed(text("hello"), 10, 1);
  assert.deepEqual(rowsText(rows), ["hello"]);
});

test("fill Paragraph：长文本 token 折行（wrapAssistantLine 语义）", () => {
  const rows = fillFixed(text("aaa bbb ccc"), 6, 2);
  assert.deepEqual(rowsText(rows), ["aaa bb", "b ccc"]);
});

test("fill Paragraph：assistant 正文 \n 为普通字符（对齐旧 wrapAssistantLine 语义）", () => {
  // 旧 wrapBufferLines：assistant 整串交 wrapAssistantLine，\n 非零宽字符，
  // 不预拆物理行（与 plain 走 wrapLine 一致）；StyledText（user）才拆 \n
  const rows = fillFixed(text("a\n\nb"), 10, 1);
  assert.deepEqual(rowsText(rows), ["a\n\nb"]);
});

test("fill Paragraph：valign center 显式声明高度时上下补白", () => {
  // valign 仅在声明 height（矮格）时补白；纯内容自然高不补（SPECH §6.5）
  const rows = fillFixed(
    text("x", { valign: "center", height: { mode: "fill" } }),
    5,
    3,
  );
  assert.deepEqual(rowsText(rows), ["", "x", ""]);
});

test("fill Paragraph：valign bottom 显式声明高度时补白在上", () => {
  const rows = fillFixed(
    text("x", { valign: "bottom", height: { mode: "fill" } }),
    5,
    3,
  );
  assert.deepEqual(rowsText(rows), ["", "", "x"]);
});

test("fill Paragraph：align right 行内右对齐", () => {
  // width fixed → 右对齐 pad
  const node = text("ab", {
    align: "right",
    width: { mode: "fixed", cols: 5 },
  });
  const rows = fillFixed(node, 5, 1);
  assert.deepEqual(rowsText(rows), ["   ab"]);
});

test("fill Paragraph：prefix 逐行重复占列", () => {
  const p = text("abc", { prefix: { text: "┃" } });
  const rows = fillFixed(p, 10, 1);
  assert.deepEqual(rowsText(rows), ["┃abc"]);
});

test("fill Paragraph：suffix 逐行重复占列（空行不补白：rect=h=1）", () => {
  const p = text("aaaa", { suffix: { text: "┃" } });
  const rows = fillFixed(p, 5, 1);
  assert.deepEqual(rowsText(rows), ["aaaa┃"]);
});

test("fill Paragraph：tail 空文本整行铺满", () => {
  const p = text("", { tail: { char: "╌" } });
  const rows = fillFixed(p, 6, 1);
  assert.deepEqual(rowsText(rows), ["╌╌╌╌╌╌"]);
});

test("fill Paragraph：tail 非空正文补尾到分配宽", () => {
  const p = text("步", { tail: { char: "╌" } });
  const rows = fillFixed(p, 5, 1);
  assert.deepEqual(rowsText(rows), ["步╌╌╌"]); // 步=CJK 2 列
});

test("fill Box v：子项按序接续（allocate 子项矩形）", () => {
  const box = v([text("a"), text("b")]);
  const rows = render(box, 10, 2);
  assert.deepEqual(rowsText(rows), ["a", "b"]);
});

test("fill Box v：separator 在子项间产横线", () => {
  const box = v([text("a"), text("b")], {
    separator: { char: "╌", color: "border" },
  });
  const rows = render(box, 8, 3);
  assert.deepEqual(rowsText(rows), ["a", "╌╌╌╌╌╌╌╌", "b"]);
});

test("fill Box h：spacer(fill) 吃剩余推位（用户块右对齐雏形）", () => {
  const box = h([spacer({ width: { mode: "fill" } }), text("u")]);
  const rows = render(box, 8, 1);
  // spacer 吃 7 列 → 文本在第 7 列开始
  assert.deepEqual(rowsText(rows), ["       u"]);
});

test("fill Box h：相邻子项按 allocate 切的可宽（右缘留白雏形）", () => {
  const box = h([text("x"), spacer({ width: { mode: "fixed", cols: 2 } })]);
  const rows = render(box, 6, 1);
  assert.deepEqual(rowsText(rows), ["x  "]);
});

test("fill Paragraph：fillBg 代码块灰底补齐（wrapCodeLine 语义）", () => {
  const p = text("code", { fillBg: true });
  const rows = fillFixed(p, 8, 1);
  // wrapCodeLine 会把行补齐到分配宽 → 正文宽 4 + 空格补 4
  assert.deepEqual(rowsText(rows), ["code    "]);
  assert.equal(rows[0]!.segments[0]!.style?.bg, "code");
});

test("fill：rect 超高时 fill 产出内容行（裁剪由上层负责）", () => {
  const box = v([text("a"), text("b")]);
  const rows = render(box, 10, 2);
  assert.equal(rows.length, 2);
});
