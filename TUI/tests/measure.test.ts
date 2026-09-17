// tests/measure.test.ts — Box 排版 measure/allocate 纯函数契约测试（SPEC.md §6）
//
// 覆盖：分配优先级（fixed/ratio/fill）、auto 无 fill 留白、多 fill 余数、
// min 保底与退化宽度、prefix/indent 首行 + hanging 续行、v Box 高度求和
// 与 separator、allocate 矩形映射与节点对象身份。

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, v, text, spacer, type Node } from "../src/app/layout/box.ts";
import { measure, allocate } from "../src/app/layout/measure.ts";

/** 按段落文本取分配矩形（正文文本在本测试内互异） */
function rectOf(
  map: Map<Node, { x: number; y: number; w: number; h: number }>,
  needle: string,
) {
  for (const [k, r] of map) {
    if (k.kind === "text" && k.text === needle) return r;
  }
  throw new Error(`未找到文本 ${needle}`);
}

// ---- 分配优先级：fixed + ratio + fill ----

test("h 排布：fixed 定值 → ratio(value=1/3) 按分数 → fill 吃剩余", () => {
  const root = h([
    text("xx", { width: { mode: "fixed", cols: 2 } }),
    text("BBB", { width: { mode: "ratio", value: 1 / 3 } }),
    text("CC", { width: { mode: "fill" } }),
  ]);
  const st = measure(root, { maxW: 20 });
  assert.equal(st.w, 20);
  const rects = allocate(st, { x: 0, y: 0, w: 20, h: 3 });
  const fix = rectOf(rects, "xx");
  const r = rectOf(rects, "BBB");
  const f = rectOf(rects, "CC");
  // fixed 2；ratio 1/3 × 20 = 6（floor）；fill = 12（剩余）
  assert.equal(fix.w, 2);
  assert.equal(r.w, 6);
  assert.equal(f.w, 12);
  assert.equal(r.x, 2);
  assert.equal(f.x, 8);
});

test("ratio 基数受可分配剩余封顶（min 保底仍生效）", () => {
  const root = h([
    text("a", { width: { mode: "ratio", value: 1 / 3, min: 8 } }),
    text("b", { width: { mode: "fill" } }),
  ]);
  const st = measure(root, { maxW: 20 });
  const rects = allocate(st, { x: 0, y: 0, w: 20, h: 1 });
  // ratio 1/3×20≈6 → min 8 保底 → a=8；fill=12
  assert.equal(rectOf(rects, "a").w, 8);
  assert.equal(rectOf(rects, "b").w, 12);
});

test("无声明子项 ≡ auto：按内容宽，不摊开剩余（余量留白）", () => {
  const root = h([text("ab"), text("cde")]); // 均为 auto（无 width）
  const st = measure(root, { maxW: 20 });
  assert.equal(st.w, 5); // 2+3 内容宽，不占满 20
  const rects = allocate(st, { x: 0, y: 0, w: 20, h: 1 });
  assert.equal(rectOf(rects, "ab").w, 2);
  assert.equal(rectOf(rects, "cde").w, 3);
  assert.equal(rectOf(rects, "ab").x + 2 + 3, 5); // 尾部留白
});

test("多 fill 平分剩余，余数从左到右（内容宽为自然上限）", () => {
  const root = h([
    text("a", { width: { mode: "fill" } }),
    text("b", { width: { mode: "fill" } }),
    text("c", { width: { mode: "fill" } }),
  ]);
  const st = measure(root, { maxW: 10 });
  const rects = allocate(st, { x: 0, y: 0, w: 10, h: 1 });
  // 10/3 = 3 余 1 → a=4,b=3,c=3
  assert.equal(rectOf(rects, "a").w, 4);
  assert.equal(rectOf(rects, "b").w, 3);
  assert.equal(rectOf(rects, "c").w, 3);
  assert.equal(rectOf(rects, "a").x + rectOf(rects, "a").w, 4);
  assert.equal(rectOf(rects, "b").x + rectOf(rects, "b").w, 7);
  assert.equal(rectOf(rects, "c").x + rectOf(rects, "c").w, 10);
});

// ---- min 保底与退化宽度 ----

test("auto + min：min 保底夹取", () => {
  const root = h([
    text("ab", { width: { mode: "auto", min: 8 } }),
    text("cd", { width: { mode: "fill" } }),
  ]);
  const st = measure(root, { maxW: 20 });
  const rects = allocate(st, { x: 0, y: 0, w: 20, h: 1 });
  assert.equal(rectOf(rects, "ab").w, 8); // min 保底
  assert.equal(rectOf(rects, "cd").w, 12);
});

test("退化宽度：总宽 2，两个 fill 各保 ≥1，超出截断（底线≥1）", () => {
  const root = h([
    text("a", { width: { mode: "fill" } }),
    text("b", { width: { mode: "fill" } }),
  ]);
  const st = measure(root, { maxW: 2 });
  const rects = allocate(st, { x: 0, y: 0, w: 2, h: 1 });
  assert.equal(rectOf(rects, "a").w, 1);
  assert.equal(rectOf(rects, "b").w, 1);
});

test("fill 池为 0 时 fill 得 0（无剩余可吃，吃剩余不主张底线）", () => {
  const root = h([
    text("abcd", { width: { mode: "fixed", cols: 4 } }),
    text("e", { width: { mode: "fill" } }),
  ]);
  const st = measure(root, { maxW: 4 });
  const rects = allocate(st, { x: 0, y: 0, w: 4, h: 1 });
  assert.equal(rectOf(rects, "abcd").w, 4);
  assert.equal(rectOf(rects, "e").w, 0);
});

// ---- prefix / indent / hanging ----

test("Paragraph：indent+prefix 占列；首行扣 indent+prefix，续行扣 hanging", () => {
  const p = text("abcdefghijklmnop", {
    indent: 1,
    hanging: 0,
    prefix: { text: ">" },
  });
  const st = measure(p, { maxW: 6 });
  // 首行正文宽 = 6-1-1 = 4；续行正文宽 = 6-0 = 6；文本 16 → 4+6+6 → 高 3
  assert.equal(st.h, 3);
  // 节点总宽 = indent 1 + prefix 1 + 最宽正文行 6 = 8
  assert.equal(st.w, 8);
});

test("Paragraph：无 hanging 时缺省 = indent（整段同缩进）", () => {
  const p = text("abcdefghij", { indent: 2, prefix: { text: "•" } });
  const st = measure(p, { maxW: 6 });
  // 首行 6-2-1=3；续行 6-2=4；10 字 → 3+4+3 → 高 3
  assert.equal(st.h, 3);
});

test("Paragraph：wrap=false 单行截断不换行", () => {
  const p = text("abcdefghij", { wrap: false });
  const st = measure(p, { maxW: 4 });
  assert.equal(st.h, 1);
  assert.equal(st.w, 4); // 截断后总宽 = 可用宽
});

// ---- v Box：高度求和 + separator ----

test("v 排布：高度为子项和；separator 占 1 行且仅子项间", () => {
  const root = v([text("ab"), text("cde"), text("f")], {
    separator: { char: "─" },
  });
  const st = measure(root, { maxW: 20 });
  assert.equal(st.h, 3 + 2); // 3 子各 1 行 + 2 条分隔线
  const rects = allocate(st, { x: 0, y: 0, w: 20, h: 5 });
  assert.equal(rectOf(rects, "ab").y, 0);
  assert.equal(rectOf(rects, "cde").y, 2); // 空一行
  assert.equal(rectOf(rects, "f").y, 4);
});

test("v 排布：无 separator 时紧挨", () => {
  const root = v([text("a"), text("b")]);
  const st = measure(root, { maxW: 10 });
  assert.equal(st.h, 2);
  const rects = allocate(st, { x: 0, y: 0, w: 10, h: 2 });
  assert.equal(rectOf(rects, "a").y, 0);
  assert.equal(rectOf(rects, "b").y, 1);
});

// ---- allocate 矩形映射与节点对象身份 ----

test("allocate：矩形按节点对象身份映射（Map 键 = 同一对象）", () => {
  const child = text("hello");
  const root = h([child, text("world")]);
  const st = measure(root, { maxW: 12 });
  const rects = allocate(st, { x: 1, y: 2, w: 12, h: 1 });
  assert.equal(rects.get(child)!.x, 1); // 对象身份命中
  assert.equal(rects.get(root)!.w, 12);
  assert.equal(rects.get(root)!.y, 2);
});

test("spacer(fixed) 在 h 中占固定列、内容为空不产出行", () => {
  const s = spacer({ mode: "fixed", cols: 3 });
  const root = h([s, text("ab")]);
  const st = measure(root, { maxW: 20 });
  const rects = allocate(st, { x: 0, y: 0, w: 20, h: 1 });
  assert.equal(rects.get(s)!.w, 3); // 身份命中，spacer 占 3 列
  assert.equal(rectOf(rects, "ab").x, 3);
});

test("h 排布：高度取最高子项", () => {
  const root = h([
    text("aaaa", { width: { mode: "fixed", cols: 4 } }),
    text("bbbbbbbbbbbbbb", { width: { mode: "fill" } }),
  ]);
  const st = measure(root, { maxW: 12 });
  // 第二子 contentW=12 → "bbbbbbbbbbbbbb"(14) 折成 12+2 → 高 2
  assert.equal(st.h, 2);
});
