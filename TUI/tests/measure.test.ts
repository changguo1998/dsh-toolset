// tests/measure.test.ts — Box 布局契约测试（SPEC.md §6；2026-10 起节点自持尺寸 + 多轮收敛）
//
// 覆盖：分配优先级（fixed > ratio > auto > fill）、ratio 归一与让路、
// auto 平摊与 min/max、fill 均分与余数、prefix/indent/hanging 折行、
// v 高度求和与 separator、高度 fixed/fill、锁定语义与矩形映射。

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, v, text, spacer, type Node } from "../src/app/layout/box.ts";
import { layout } from "../src/app/layout/measure.ts";

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

test("h 排布：fixed 定值 → ratio(1/3) 按分数 → fill 吃剩余", () => {
  const root = h([
    text("xx", { widthStyle: "fixed", widthFixed: 2 }),
    text("BBB", { widthStyle: "ratio", widthRatio: 1 / 3 }),
    text("CC", { widthStyle: "fill" }),
  ]);
  const rects = layout(root, 20);
  assert.equal(rectOf(rects, "xx").w, 2);
  assert.equal(rectOf(rects, "BBB").w, 6);
  assert.equal(rectOf(rects, "CC").w, 12);
  assert.equal(rectOf(rects, "BBB").x, 2);
  assert.equal(rectOf(rects, "CC").x, 8);
});

test("ratio：value 是容器分数，单个 ratio 不吃满", () => {
  const root = h([text("a", { widthStyle: "ratio", widthRatio: 1 / 3 })]);
  const rects = layout(root, 21);
  assert.equal(rectOf(rects, "a").w, 7);
});

test("ratio：多个 ratio 之和 ≤1 时各自按分数、不归一", () => {
  const root = h([
    text("a", { widthStyle: "ratio", widthRatio: 1 / 3 }),
    text("b", { widthStyle: "ratio", widthRatio: 1 / 6 }),
    text("c", { widthStyle: "fill" }),
  ]);
  const rects = layout(root, 18);
  assert.equal(rectOf(rects, "a").w, 6);
  assert.equal(rectOf(rects, "b").w, 3);
  assert.equal(rectOf(rects, "c").w, 9);
});

test("ratio：多个 ratio 之和 >1 时按比例归一", () => {
  const root = h([
    text("a", { widthStyle: "ratio", widthRatio: 2 / 3 }),
    text("b", { widthStyle: "ratio", widthRatio: 2 / 3 }),
  ]);
  const rects = layout(root, 12);
  assert.equal(rectOf(rects, "a").w, 6);
  assert.equal(rectOf(rects, "b").w, 6);
});

test("ratio min：保底下不破 min，剩余归 fill", () => {
  const root = h([
    text("a", { widthStyle: "ratio", widthRatio: 1 / 3, widthMin: 8 }),
    text("b", { widthStyle: "fill" }),
  ]);
  const rects = layout(root, 20);
  assert.equal(rectOf(rects, "a").w, 8);
  assert.equal(rectOf(rects, "b").w, 12);
});

test("ratio 让路：ratio 0.8 + auto min:4，宽 10 → 6 / 4", () => {
  const root = h([
    text("a", { widthStyle: "ratio", widthRatio: 0.8 }),
    text("bbbbb", { widthStyle: "auto", widthMin: 4 }),
  ]);
  const rects = layout(root, 10);
  assert.equal(rectOf(rects, "a").w, 6);
  assert.equal(rectOf(rects, "bbbbb").w, 4);
});

test("ratio 让路：ratio 0.8 + fill min:4，宽 10 → 6 / 4", () => {
  const root = h([
    text("a", { widthStyle: "ratio", widthRatio: 0.8 }),
    text("b", { widthStyle: "fill", widthMin: 4 }),
  ]);
  const rects = layout(root, 10);
  assert.equal(rectOf(rects, "a").w, 6);
  assert.equal(rectOf(rects, "b").w, 4);
});

test("auto：按内容宽，单子项不摊开剩余", () => {
  const root = h([text("ab"), text("cde")]);
  const rects = layout(root, 20);
  assert.equal(rectOf(rects, "ab").w, 2);
  assert.equal(rectOf(rects, "cde").w, 3);
});

test("auto：各子项按自然宽，剩余留白不摊满", () => {
  const root = h([text("a"), text("b")]);
  const rects = layout(root, 10);
  assert.equal(rectOf(rects, "a").w, 1);
  assert.equal(rectOf(rects, "b").w, 1);
  assert.equal(rectOf(rects, "a").w + rectOf(rects, "b").w, 2);
});

test("多 fill 平分剩余，余数从左到右", () => {
  const root = h([
    text("a", { widthStyle: "fill" }),
    text("b", { widthStyle: "fill" }),
    text("c", { widthStyle: "fill" }),
  ]);
  const rects = layout(root, 10);
  assert.equal(rectOf(rects, "a").w, 4);
  assert.equal(rectOf(rects, "b").w, 3);
  assert.equal(rectOf(rects, "c").w, 3);
});

// ---- min 保底 / min>max / 退化宽度 ----

test("auto + min：min 保底", () => {
  const root = h([
    text("ab", { widthStyle: "auto", widthMin: 8 }),
    text("cd", { widthStyle: "fill" }),
  ]);
  const rects = layout(root, 20);
  assert.equal(rectOf(rects, "ab").w, 8);
  assert.equal(rectOf(rects, "cd").w, 12);
});

test("min > max 时 min 赢", () => {
  const root = h([
    text("a", {
      widthStyle: "ratio",
      widthRatio: 1,
      widthMin: 10,
      widthMax: 5,
    }),
  ]);
  const rects = layout(root, 12);
  assert.equal(rectOf(rects, "a").w, 10);
});

test("退化宽度：总宽 2，两个 fill 各保 ≥1", () => {
  const root = h([
    text("a", { widthStyle: "fill" }),
    text("b", { widthStyle: "fill" }),
  ]);
  const rects = layout(root, 2);
  assert.equal(rectOf(rects, "a").w, 1);
  assert.equal(rectOf(rects, "b").w, 1);
});

test("fill 池为 0 时 fill 得 0", () => {
  const root = h([
    text("abcd", { widthStyle: "fixed", widthFixed: 4 }),
    text("e", { widthStyle: "fill" }),
  ]);
  const rects = layout(root, 4);
  assert.equal(rectOf(rects, "abcd").w, 4);
  assert.equal(rectOf(rects, "e").w, 0);
});

// ---- prefix / indent / hanging ----

test("Paragraph：indent+prefix 占列；行宽 = 正文宽扣缩进与前缀", () => {
  const p = text("abcdefghijklmnop", {
    indent: 1,
    hanging: 0,
    prefix: { text: ">" },
  });
  layout(p, 6);
  // 正文宽 6 - indent 1 - prefix 1 = 4 列 → 16 字折 4 行
  assert.equal(p.height, 4);
  assert.equal(p.width, 6);
});

test("Paragraph：无 hanging 时缺省 = indent", () => {
  const p = text("abcdefghij", { indent: 2, prefix: { text: "•" } });
  layout(p, 6);
  // 正文宽 6 - indent 2 - prefix 1 = 3 列 → 10 字折 4 行
  assert.equal(p.height, 4);
  assert.equal(p.width, 6);
});

test("Paragraph：hanging 小于 indent 时总宽按最长行计", () => {
  const p = text("abcdefghijklmnop", { indent: 4, hanging: 0 });
  layout(p, 8);
  assert.equal(p.width, 8);
});

test("Paragraph：wrap=false 单行截断不换行", () => {
  const p = text("abcdefghij", { wrap: false });
  layout(p, 4);
  assert.equal(p.height, 1);
  assert.equal(p.width, 4);
});

test("固定宽长段落：宽度锁定后按固定宽折行", () => {
  const root = h([
    text("abcdefghijklmnop", { widthStyle: "fixed", widthFixed: 4 }),
  ]);
  layout(root, 20);
  assert.equal(root.height, 4);
});

// ---- v Box：高度求和 + separator ----

test("v 排布：高度为子项和；separator 占 1 行且仅子项间", () => {
  const root = v([text("ab"), text("cde"), text("f")], {
    separator: { char: "─" },
  });
  const rects = layout(root, 20);
  assert.equal(root.height, 5);
  assert.equal(rectOf(rects, "ab").y, 0);
  assert.equal(rectOf(rects, "cde").y, 2);
  assert.equal(rectOf(rects, "f").y, 4);
});

test("v 排布：无 separator 时紧挨", () => {
  const root = v([text("a"), text("b")]);
  const rects = layout(root, 10);
  assert.equal(root.height, 2);
  assert.equal(rectOf(rects, "a").y, 0);
  assert.equal(rectOf(rects, "b").y, 1);
});

test("v 高度 fixed：声明行高覆盖内容高", () => {
  const root = v([
    text("F", { heightStyle: "fixed", heightFixed: 3 }),
    text("A"),
  ]);
  const rects = layout(root, 10);
  assert.equal(rectOf(rects, "F").h, 3);
  assert.equal(root.height, 4);
});

test("v 高度 fill：父高固定时吃剩余", () => {
  const root = v([text("aaa"), spacer({ heightStyle: "fill" })], {
    heightStyle: "fixed",
    heightFixed: 5,
  });
  layout(root, 20);
  assert.equal(root.height, 5);
  assert.equal(root.children[1]!.height, 4);
});

// ---- 矩形映射与节点身份 ----

test("layout：矩形按节点对象身份映射", () => {
  const child = text("hello");
  const root = h([child, text("world")]);
  const rects = layout(root, 12);
  assert.equal(rects.get(child)!.x, 0);
  assert.equal(rects.get(root)!.w, 12);
  assert.equal(rects.get(root)!.x, 0);
});

// ---- spacer 横/纵轴 ----

test("spacer(width) 在 h 中占固定列", () => {
  const s = spacer({ widthStyle: "fixed", widthFixed: 3 });
  const root = h([s, text("ab")]);
  const rects = layout(root, 20);
  assert.equal(rects.get(s)!.w, 3);
  assert.equal(rectOf(rects, "ab").x, 3);
});

test("spacer(height) 在 v 中占固定行", () => {
  const s = spacer({ heightStyle: "fixed", heightFixed: 2 });
  const root = v([s, text("ab")]);
  const rects = layout(root, 20);
  assert.equal(root.height, 3);
  assert.equal(rects.get(s)!.h, 2);
  assert.equal(rectOf(rects, "ab").y, 2);
});

test("spacer(fill) 按所在容器取向：h 吃列、v 吃行", () => {
  const hroot = h([
    text("x", { widthStyle: "fixed", widthFixed: 1 }),
    spacer({ widthStyle: "fill" }),
  ]);
  const hrects = layout(hroot, 5);
  assert.equal(hrects.get(hroot.children[1]!)!.w, 4);

  const vroot = v([text("x"), spacer({ heightStyle: "fill" })], {
    heightStyle: "fixed",
    heightFixed: 4,
  });
  const vrects = layout(vroot, 5);
  assert.equal(vrects.get(vroot.children[1]!)!.h, 3);
});

test("spacer 类型契约：空/双轴编译期拒绝", () => {
  const typeguard = (): void => {
    // @ts-expect-error spacer 必须至少给一个轴
    const bad1 = spacer({});
    // @ts-expect-error 宽/高两轴互斥
    const bad2 = spacer({ widthStyle: "fill", heightStyle: "fill" });
    void bad1;
    void bad2;
  };
  void typeguard;
  assert.ok(spacer({ widthStyle: "fill" }).kind === "text");
});

// ---- suffix / tail ----

test("Paragraph suffix：占列并入总宽、正文折行扣 suffix 宽", () => {
  const p = text("AAAAAAAA", { suffix: { text: "┃" } });
  layout(p, 8);
  assert.equal(p.height, 2);
  assert.equal(p.width, 8);
});

test("Paragraph suffix：空文本 = prefix/suffix 宽", () => {
  const p = text("", { suffix: { text: "┃" } });
  layout(p, 10);
  assert.equal(p.height, 1);
  // 空段不主张列：宽度由分配决定（父容器给满），suffix 只在 fill 阶段补挂
  assert.equal(p.width, 10);
});

test("Paragraph tail：不主张宽度、不增加行数", () => {
  const p = text("", { tail: { char: "╌" } });
  layout(p, 12);
  assert.equal(p.height, 1);
  // tail 是铺满装饰（fill 阶段按矩形宽补），不参与宽度主张；节点宽由分配决定
  assert.equal(p.width, 12);
});

// ---- 锁定语义与用户块右缘 ----

test("锁定：根宽锁定、fixed 子项宽高锁定", () => {
  const fixed = text("xx", { widthStyle: "fixed", widthFixed: 2 });
  const root = h([fixed, text("abc")]);
  layout(root, 20);
  assert.equal(root.widthLocked, true);
  assert.equal(fixed.widthLocked, true);
  assert.equal(fixed.heightLocked, true);
});

test("用户块右缘：fill.min 预留 + balance 后竖线贴右（空隙 0）", () => {
  const body = text("汉汉汉汉汉 abc abc abc abc abc abc", {
    balance: true,
    suffix: { text: "┃" },
  });
  const content = h([text("▶ ", { widthStyle: "fixed", widthFixed: 2 }), body]);
  const gutterSpacer = spacer({ widthStyle: "fill", widthMin: 3 });
  const block = h([gutterSpacer, content]);
  layout(v([block]), 38);
  assert.equal(block.width, 38);
  assert.equal((content.width ?? 0) + (gutterSpacer.width ?? 0), 38);
});
