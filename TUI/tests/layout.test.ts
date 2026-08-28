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
import { initialState, reduceState } from "../src/app/state.ts";
import { renderTextInput } from "../src/app/components/TextInput.ts";

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

// ---- 修复回归：多行 notice 拆分（REGRESSION: /help 在 "quit" 中间折行） ----

test("appendNotice: 多行 notice 文本拆成多行 buffer（不再整块折行导致词内断行）", () => {
  const s = _stateWith({
    type: "notice",
    text: "本地命令：\n  /quit   退出\n其他 /name 走注册表。",
  });
  assert.deepEqual(s.buffer, [
    { text: "本地命令：", kind: "notice" },
    { text: "  /quit   退出", kind: "notice" },
    { text: "其他 /name 走注册表。", kind: "notice" },
  ]);
});

test("appendNotice: 多行拆分不改变已有 buffer 末行语义", () => {
  let s = _stateWith({ type: "append", text: "第1行" });
  s = _stateWith({ type: "notice", text: "A\nB" }, s);
  assert.deepEqual(s.buffer, [
    { text: "第1行", kind: "assistant" },
    { text: "A", kind: "notice" },
    { text: "B", kind: "notice" },
  ]);
});

function _stateWith(
  action: { type: "notice"; text: string } | { type: "append"; text: string },
  s = initialState(),
) {
  return reduceState(s, action);
}

// ---- 修复回归：光标列 = 显示列（含 CJK），不再是 code unit 下标 ----

test("renderTextInput: 光标列按显示宽度计算（ASCII）", () => {
  const line = renderTextInput("hello", 3, "...", 40)[0]!;
  // prompt="❯ "(2 列) + "hel"(3 列) = caret 列 5(0 基)
  assert.equal(line.caret, 2 + 3);
  assert.equal(line.text, "❯ hello");
});

test("renderTextInput: 光标列按显示宽度计算（CJK 占 2 列）", () => {
  const line = renderTextInput("中文a", 3, "...", 40)[0]!;
  // prompt(2) + 中(2)+文(2)+a(1) = 7(0 基)
  assert.equal(line.caret, 7);
});

test("renderTextInput: 光标在行尾也能给出列（不在文本中间画块）", () => {
  const line = renderTextInput("中文", 2, "...", 40)[0]!;
  assert.equal(line.caret, 6); // prompt(2)+中(2)+文(2)
});

test("renderTextInput: 空文本按 placeholder 渲染且光标在 prompt 之后", () => {
  const line = renderTextInput("", 0, "Type a message…", 40)[0]!;
  assert.equal(line.text, "❯ Type a message…");
  assert.equal(line.caret, 2);
});

test("renderTextInput: 宽度不足时水平滚动仍保持光标可见", () => {
  const text = "abcdefghij";
  // avail = 10-2 = 8，文本 10 列超宽，光标在末尾(cursor=5)应滚到可见区
  const line = renderTextInput(text, 5, "...", 10)[0]!;
  const caret = line.caret!;
  assert.ok(caret >= 2 && caret < 2 + 8, "光标列应在可视窗口内");
});
