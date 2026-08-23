// tests/layout.test.ts — layout 视口/换行纯函数单测
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  charWidth,
  displayWidth,
  wrapLine,
  wrapLines,
  computeViewport,
} from "../src/app/layout.ts";

// ---- charWidth / displayWidth ----

test("charWidth：ASCII=1，CJK/全角=2", () => {
  assert.equal(charWidth("a"), 1);
  assert.equal(charWidth("中"), 2);
  assert.equal(charWidth("。"), 2);
  assert.equal(charWidth("…"), 1); // 水平省略号 U+2026 不在宽字符区间
});

test("displayWidth 累加", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文a"), 5);
});

// ---- wrapLine ----

test("wrapLine：短行不换行", () => {
  assert.deepEqual(wrapLine("hello", 10), ["hello"]);
});

test("wrapLine：超宽按列软换行", () => {
  assert.deepEqual(wrapLine("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("wrapLine：CJK 字符按 2 列宽换行", () => {
  assert.deepEqual(wrapLine("中文abc", 4), ["中文", "abc"]);
  assert.deepEqual(wrapLine("中文字符串测试", 6), ["中文字", "符串测", "试"]);
});

test("wrapLine：宽度<=0 视为无穷宽", () => {
  assert.deepEqual(wrapLine("hello", 0), ["hello"]);
});

test("wrapLine：空串返回单空行", () => {
  assert.deepEqual(wrapLine("", 5), [""]);
});

test("wrapLine：单个宽字符大于宽度也能放下（不丢字符）", () => {
  const out = wrapLine("中", 1);
  assert.deepEqual(out, ["中"]); // 字符无法切分时强制放下
});

// ---- wrapLines ----

test("wrapLines：多条原始行各自换行并拼接", () => {
  assert.deepEqual(wrapLines(["ab", "cdefghi", ""], 3), [
    "ab",
    "cde",
    "fgh",
    "i",
    "",
  ]);
});

// ---- computeViewport ----

test("跟随底部：内容不足一屏时 start=0", () => {
  assert.deepEqual(
    computeViewport({
      totalRows: 3,
      height: 10,
      followBottom: true,
      scrollOffset: 0,
    }),
    { start: 0, end: 3, followBottom: true, scrollOffset: 0 },
  );
});

test("跟随底部：超一屏时显示末尾 height 行", () => {
  assert.deepEqual(
    computeViewport({
      totalRows: 20,
      height: 5,
      followBottom: true,
      scrollOffset: 0,
    }),
    { start: 15, end: 20, followBottom: true, scrollOffset: 0 },
  );
});

test("上滚暂停跟随：有 offset 时 start 上移", () => {
  assert.deepEqual(
    computeViewport({
      totalRows: 20,
      height: 5,
      followBottom: false,
      scrollOffset: 3,
    }),
    { start: 12, end: 17, followBottom: false, scrollOffset: 3 },
  );
});

test("上滚 offset 上限收敛到顶部（不能滚过头）", () => {
  assert.deepEqual(
    computeViewport({
      totalRows: 20,
      height: 5,
      followBottom: false,
      scrollOffset: 999,
    }),
    { start: 0, end: 5, followBottom: false, scrollOffset: 15 },
  );
});

test("滚回底部（offset=0, follow=false）恢复跟随", () => {
  assert.deepEqual(
    computeViewport({
      totalRows: 20,
      height: 5,
      followBottom: false,
      scrollOffset: 0,
    }),
    { start: 15, end: 20, followBottom: true, scrollOffset: 0 },
  );
});
