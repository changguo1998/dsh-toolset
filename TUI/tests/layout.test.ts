// tests/layout.test.ts — layout 视口/换行纯函数单测
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  charWidth,
  displayWidth,
  wrapLine,
  wrapLines,
  computeViewport,
  parseInlineMarkdown,
  wrapInlineMarkdown,
  truncateToWidth,
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
  // prompt="> "(2 列) + "hel"(3 列) = caret 列 5(0 基)
  assert.equal(line.caret, 2 + 3);
  assert.equal(line.text, "> hello");
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
  assert.equal(line.text, "> Type a message…");
  assert.equal(line.caret, 2);
});

test("renderTextInput: 宽度不足时水平滚动仍保持光标可见", () => {
  const text = "abcdefghij";
  // avail = 10-2 = 8，文本 10 列超宽，光标在末尾(cursor=5)应滚到可见区
  const line = renderTextInput(text, 5, "...", 10)[0]!;
  const caret = line.caret!;
  assert.ok(caret >= 2 && caret < 2 + 8, "光标列应在可视窗口内");
});

// ---- 行内 markdown（粗体 / 斜体 / 行内代码）----

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("行内 markdown：单独粗体 / 斜体 / 行内 code 均渲染且带样式", () => {
  const bold = wrapInlineMarkdown("**加粗**", 60, "dark")[0]!;
  assert.ok(bold.includes("\x1b[1m") && bold.includes("\x1b[22m"), "bold SGR");
  assert.equal(strip(bold), "加粗");
  const italic = wrapInlineMarkdown("*斜体*", 60, "dark")[0]!;
  assert.ok(
    italic.includes("\x1b[3m") && italic.includes("\x1b[23m"),
    "italic SGR",
  );
  assert.equal(strip(italic), "斜体");
  const code = wrapInlineMarkdown("`代码`", 60, "dark")[0]!;
  assert.ok(
    (code.match(/\x1b\[48;2;/g) ?? []).length >= 2,
    "code 用主题背景色打开/关闭(48;2)",
  );
  assert.equal(strip(code), "代码");
});

test("行内 markdown：三种样式混排顺序保留", () => {
  const out = wrapInlineMarkdown("前**粗**中`码`后*斜*尾", 60, "dark")[0]!;
  assert.equal(strip(out), "前粗中码后斜尾");
  assert.ok(out.includes("\x1b[1m") && out.includes("\x1b[3m"));
});

test("行内 markdown：样式跨软换行后每行 ANSI 成对且不超宽", () => {
  const rows = wrapInlineMarkdown(
    "alpha**boldbeta boldbeta**gamma",
    10,
    "dark",
  );
  assert.ok(rows.length >= 2, "宽 10 内应软换行");
  for (const row of rows) {
    const on = (row.match(/\x1b\[1m/g) ?? []).length;
    const off = (row.match(/\x1b\[22m/g) ?? []).length;
    assert.equal(on, off, `每行 1m/22m 成对: ${JSON.stringify(row)}`);
    assert.ok(
      displayWidth(strip(row)) <= 10,
      `行不超宽: ${JSON.stringify(row)}`,
    );
  }
});

test("行内 markdown：CJK 按 2 列精确换行，粗体跨行不丢字", () => {
  const rows = wrapInlineMarkdown("一二**三四五六**七八", 6, "dark");
  assert.deepEqual(rows.map(strip), ["一二三", "四五六", "七八"]);
  for (const r of rows) assert.ok(displayWidth(strip(r)) <= 6);
});

test("行内 markdown：未闭合或嵌套时字符不丢失且约定输出稳定", () => {
  const cases: Array<[string, string]> = [
    ["**未闭合*尾", "**未闭合*尾"],
    ["*未闭合", "*未闭合"],
    ["a `未闭合", "a `未闭合"],
    ["**bold**", "bold"],
    ["**外*内*外**", "**外内外**"],
  ];
  for (const [src, expect] of cases) {
    const out = wrapInlineMarkdown(src, 60, "dark")[0]!;
    assert.equal(strip(out), expect, `输入: ${src}`);
  }
});

test("ANSI 感知：displayWidth 不计转义；truncateToWidth 透传转义不切断", () => {
  const colored = "\x1b[38;2;216;216;216mhello\x1b[38;2;237;237;237m";
  assert.equal(displayWidth(colored), 5);
  assert.equal(displayWidth("\x1b[1mabc\x1b[22m"), 3);
  const cut = truncateToWidth("\x1b[1mabcdef\x1b[22m", 3);
  assert.equal(cut, "\x1b[1mabc\x1b[22m");
  assert.equal(displayWidth(cut), 3);
  // 转义序列整体透传：截断点落在序列内时序列完整保留、字符不计数
  const mid = truncateToWidth("ab\x1b[38;2;1;2;3mcd", 2);
  assert.equal(mid, "ab\x1b[38;2;1;2;3m");
});

test("行内 code 颜色随主题：dark / light 使用各自 gray 背景色板", () => {
  const bgSgr = (s: string): string =>
    /\x1b\[48;2;\d+;\d+;\d+m/.exec(s)?.[0] ?? "";
  const d = wrapInlineMarkdown("`x`", 60, "dark")[0]!;
  const l = wrapInlineMarkdown("`x`", 60, "light")[0]!;
  assert.ok(bgSgr(d) && bgSgr(l), "两主题代码均有背景色");
  assert.notEqual(bgSgr(d), bgSgr(l), "深浅主题 code 背景色不同");
});

test("无 markdown 标记时 wrapInlineMarkdown 与 wrapLine 输出一致", () => {
  const text = "一二三四五六七八九十";
  assert.deepEqual(wrapInlineMarkdown(text, 10, "dark"), wrapLine(text, 10));
  assert.equal(parseInlineMarkdown("纯文本").length, 1);
});

test("行内 markdown：粗斜/删除线/下划线/转义/自动链接/图片（扩展子集）", () => {
  const cases: Array<[string, string]> = [
    ["***粗斜***", "粗斜"],
    ["~~删除~~", "删除"],
    ["__下划线__", "下划线"],
    ["\\*不斜*", "*不斜*"],
    ["H~2~O", "H~2~O"],
    ["x^2^", "x^2^"],
    ["_单_", "_单_"],
    ["<https://a.b/x>", "https://a.b/x"],
    ["![a](https://x/i.png)", "[a] https://x/i.png"],
  ];
  for (const [src, expect] of cases) {
    assert.equal(strip(wrapInlineMarkdown(src, 60, "dark")[0]!), expect, src);
  }
  const bi = wrapInlineMarkdown("***粗斜***", 60, "dark")[0]!;
  assert.ok(bi.includes("\x1b[1m") && bi.includes("\x1b[3m"), "*** 同段粗斜");
  const st = wrapInlineMarkdown("~~删除~~", 60, "dark")[0]!;
  assert.ok(st.includes("\x1b[9m") && st.includes("\x1b[29m"), "删除线 SGR");
  const ul = wrapInlineMarkdown("__下划线__", 60, "dark")[0]!;
  assert.ok(ul.includes("\x1b[4m") && ul.includes("\x1b[24m"), "下划线 SGR");
  const esc = wrapInlineMarkdown("\\*不斜*", 60, "dark")[0]!;
  assert.ok(!esc.includes("\x1b[3m"), "\\* 不触发斜体");
  const al = wrapInlineMarkdown("<https://a.b>", 60, "dark")[0]!;
  assert.ok(al.includes("\x1b[4m"), "自动链接下划线");
});
