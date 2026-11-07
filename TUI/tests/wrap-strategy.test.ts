// TUI/tests/wrap-strategy.test.ts — 折行核（wrap-core.ts）的策略契约
//
// 覆盖 docs/archived/2026-11-06-wrap-strategy.md 任务表 A1-A5：
//  - A1/A3：逐字切分、宽字符不切半、显式换行、空输入、逐行宽回调
//  - A5：按词断点（拉丁长词 / URL / 路径 / 中英混排）
//  - A7：行数预算与四种隐藏提示
//  - A9：缓存隔离（同文本不同属性不得串味）

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fitRowWidth,
  resolveWrapSpec,
  truncateRows,
  wrapStyledChars,
  type StyledChar,
  type WrapSpec,
} from "../src/app/layout/wrap-core.ts";
import {
  clearLayoutCaches,
  setLayoutCacheEnabled,
} from "../src/app/layout/cache.ts";

/** 行文本（渲染后文本比较用） */
const txt = (rows: readonly (readonly { text: string }[])[]): string[] =>
  rows.map((row) => row.map((s) => s.text).join(""));

/** 便捷：纯文本 → 字符流 */
const chars = (text: string): StyledChar[] => [...text].map((ch) => ({ ch }));

/** 便捷：定宽折行 */
const wrap = (text: string, width: number, spec?: WrapSpec): string[] =>
  txt(
    wrapStyledChars({
      chars: chars(text),
      limit: () => width,
      ...(spec === undefined ? {} : { spec }),
    }),
  );

// ---------------- A1 / A3：逐字切分 ----------------

test("wrap-core：缺省属性 = char + 0 + tail", () => {
  assert.deepEqual(resolveWrapSpec(), {
    mode: "char",
    maxRows: 0,
    hint: "tail",
  });
  assert.deepEqual(resolveWrapSpec({ mode: "word", maxRows: 2 }), {
    mode: "word",
    maxRows: 2,
    hint: "tail",
  });
});

test("wrap-core：短文本单行", () => {
  assert.deepEqual(wrap("hello", 10), ["hello"]);
});

test("wrap-core：逐字贪心折行", () => {
  assert.deepEqual(wrap("abcdef", 3), ["abc", "def"]);
});

test("wrap-core：宽字符按列折行且不切半", () => {
  // "你好世界" = 8 列；宽 5 → 首行 4 列放 "你好"、续行 "世界"
  assert.deepEqual(wrap("你好世界", 5), ["你好", "世界"]);
});

test("wrap-core：空输入产出一行空段", () => {
  const rows = wrapStyledChars({ chars: [], limit: () => 10 });
  assert.deepEqual(txt(rows), [""]);
});

test("wrap-core：显式换行切物理行（末尾换行留空行）", () => {
  assert.deepEqual(wrap("a\nb", 10), ["a", "b"]);
  assert.deepEqual(wrap("a\n", 10), ["a", ""]);
});

test("wrap-core：逐行可用宽由 limit(rowIndex) 决定", () => {
  const rows = txt(
    wrapStyledChars({
      chars: chars("abcdef"),
      limit: (row) => (row === 0 ? 2 : 4),
    }),
  );
  assert.deepEqual(rows, ["ab", "cdef"]);
});

// ---------------- A5：按词断点 ----------------

test("wrap-core word：拉丁长文本在空白处断且吃掉断点空格", () => {
  assert.deepEqual(wrap("the quick brown fox", 10, { mode: "word" }), [
    "the quick",
    "brown fox",
  ]);
});

test("wrap-core word：URL 在斜线后可断，不在词中间切开", () => {
  const rows = wrap("see https://example.com/a/b", 12, { mode: "word" });
  assert.deepEqual(rows, ["see https://", "example.com/", "a/b"]);
});

test("wrap-core word：路径在斜线后可断，整段不被逐字切开", () => {
  const rows = wrap("/usr/local/lib/node_modules", 12, { mode: "word" });
  assert.deepEqual(rows, ["/usr/local/", "lib/", "node_modules"]);
});

test("wrap-core word：中英混排 CJK 任意断且不强制按空格断", () => {
  assert.deepEqual(wrap("中文 hello 世界", 6, { mode: "word" }), [
    "中文",
    "hello",
    "世界",
  ]);
});

test("wrap-core word：无任何断点的超长单元回落逐字符", () => {
  const rows = wrap("abcdefghijkl", 5, { mode: "word" });
  assert.deepEqual(rows, ["abcde", "fghij", "kl"]);
});

test("wrap-core word：行首不以空格开头、行尾不留空格", () => {
  for (const row of wrap("alpha beta gamma delta", 7, { mode: "word" })) {
    assert.equal(row.startsWith(" "), false);
    assert.equal(row.endsWith(" "), false);
  }
});

// ---------------- A7：行数预算 × 断点风格 × 提示风格 ----------------

test("wrap-core 预算：maxRows 0 不截断", () => {
  for (const mode of ["char", "word", "none"] as const) {
    const rows = wrap("abcdefghij", 2, { mode });
    assert.deepEqual(
      rows.some((r) => r.includes("…")),
      false,
    );
    assert.equal(rows.join("").includes("a"), true);
  }
});

test("wrap-core 预算：char 模式 1 行与 3 行的四种提示", () => {
  const one = (hint: NonNullable<WrapSpec["hint"]>): string[] =>
    wrap("abcdefghij", 2, { mode: "char", maxRows: 1, hint });
  assert.deepEqual(one("none"), ["ab"]);
  assert.deepEqual(one("tail"), ["ab…"]);
  assert.deepEqual(one("head"), ["…ij"]);
  assert.deepEqual(one("middle"), ["ab…"]);

  const three = (hint: NonNullable<WrapSpec["hint"]>): string[] =>
    wrap("abcdefghij", 2, { mode: "char", maxRows: 3, hint });
  assert.deepEqual(three("none"), ["ab", "cd", "ef"]);
  assert.deepEqual(three("tail"), ["ab", "cd", "ef…"]);
  assert.deepEqual(three("head"), ["…ef", "gh", "ij"]);
  // 前 ceil(3/2)=2 行 + 后 floor(3/2)=1 行，`…` 贴前段末行行尾
  assert.deepEqual(three("middle"), ["ab", "cd…", "ij"]);
});

test("wrap-core 预算：word 模式与 char 模式同口径（无空格文本）", () => {
  assert.deepEqual(
    wrap("abcdefghij", 2, { mode: "word", maxRows: 3, hint: "middle" }),
    wrap("abcdefghij", 2, { mode: "char", maxRows: 3, hint: "middle" }),
  );
});

test("wrap-core 预算：提示符不额外占行（行数 = min(预算, 原行数)）", () => {
  for (const hint of ["none", "head", "middle", "tail"] as const) {
    for (const maxRows of [1, 3] as const) {
      const rows = wrap("abcdefghij", 2, { mode: "char", maxRows, hint });
      assert.equal(rows.length, maxRows);
    }
  }
});

test("wrap-core 预算：none 模式单行 + 提示", () => {
  assert.deepEqual(wrap("abcdefghij", 2, { mode: "none", maxRows: 1 }), [
    "abcdefghij",
  ]);
  assert.deepEqual(
    wrap("abcdefghij", 2, { mode: "none", maxRows: 1, hint: "tail" }),
    ["abcdefghij"],
  );
});

// ---------------- A8：已摊平行集的预算入口 ----------------

test("truncateRows：已摊平行集按四种提示取窗口", () => {
  const rows = ["r1", "r2", "r3", "r4", "r5"].map((t) => [{ text: t }]);
  const at = (spec: WrapSpec): string[] =>
    truncateRows(rows, spec).map((r) => r.map((s) => s.text).join(""));
  assert.deepEqual(at({ maxRows: 0 }), ["r1", "r2", "r3", "r4", "r5"]);
  assert.deepEqual(at({ maxRows: 1, hint: "none" }), ["r1"]);
  assert.deepEqual(at({ maxRows: 1, hint: "tail" }), ["r1…"]);
  assert.deepEqual(at({ maxRows: 1, hint: "head" }), ["…r5"]);
  assert.deepEqual(at({ maxRows: 3, hint: "none" }), ["r1", "r2", "r3"]);
  assert.deepEqual(at({ maxRows: 3, hint: "tail" }), ["r1", "r2", "r3…"]);
  assert.deepEqual(at({ maxRows: 3, hint: "head" }), ["…r3", "r4", "r5"]);
  assert.deepEqual(at({ maxRows: 3, hint: "middle" }), ["r1", "r2…", "r5"]);
});

// ---------------- A9：缓存键含折行属性 ----------------

test("wrap-core 缓存：同文本两种属性不串味", () => {
  const run = (spec: WrapSpec): string[] =>
    txt(
      wrapStyledChars({
        chars: chars("the quick"),
        limit: () => 6,
        spec,
        cacheKey: "w=6|h=0|p=0",
      }),
    );
  const charRows = run({ mode: "char" });
  const wordRows = run({ mode: "word" });
  assert.deepEqual(charRows, ["the qu", "ick"]);
  assert.deepEqual(wordRows, ["the", "quick"]);
  assert.deepEqual(run({ mode: "char" }), charRows);
  assert.deepEqual(run({ mode: "word" }), wordRows);
});

test("wrap-core 缓存：关闭缓存结果一致", () => {
  const run = (): string[] =>
    txt(
      wrapStyledChars({
        chars: chars("the quick"),
        limit: () => 6,
        spec: { mode: "word" },
        cacheKey: "w=6|h=0|p=0",
      }),
    );
  const cached = run();
  setLayoutCacheEnabled(false);
  try {
    clearLayoutCaches();
    assert.deepEqual(run(), cached);
  } finally {
    setLayoutCacheEnabled(true);
    clearLayoutCaches();
  }
});

// ---------------- E3：单行宽度贴合（拼帧兜底贴符） ----------------

test("fitRowWidth：超宽单行按提示贴符（tail 贴行尾 / head 贴行首）", () => {
  const row = [{ text: "abcdefghij" }];
  const at = (hint: "none" | "head" | "tail" | "middle"): string =>
    fitRowWidth(row, 5, hint)
      .map((s) => s.text)
      .join("");
  assert.equal(at("none"), "abcde");
  assert.equal(at("tail"), "abcd…");
  assert.equal(at("head"), "…ghij");
  assert.equal(at("middle"), "ab…ij");
});

test("fitRowWidth：未超宽时不截断也不贴符", () => {
  const row = [{ text: "abc" }];
  assert.equal(
    fitRowWidth(row, 5, "tail")
      .map((s) => s.text)
      .join(""),
    "abc",
  );
});
