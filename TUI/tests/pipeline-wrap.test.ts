// tests/pipeline-wrap.test.ts — §5/§6 唯一折行入口 wrapLeaf 的契约（阶段 0 R15/阶段 0 基建）
//
// 契约（追踪文档 T14/T15）：
//  - 折行只此一处：宽字符（EAW）按列计；prefixW 占首行；hanging 让续行缩进；
//  - balance 平衡折行（行数不变、列宽收窄，并入 fill.balancedWidth）；
//  - 返回行数组，length 即高度（measure 行数 = 折行结果长度，不变量）。
//  - styledToSegments：StyledStr → FrameSegment 的样式映射（color/bold/italic/code/link）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { wrapLeaf, styledToSegments } from "../src/app/layout/pipeline/wrap.ts";
import type { StyledText } from "../src/app/layout/pipeline/ir.ts";

/** 行文本（渲染后文本比较用：wrapLeaf 返回的行已是 FrameSegment[]） */
const txt = (rows: readonly (readonly { text: string }[])[]): string[] =>
  rows.map((row) => row.map((s) => s.text).join(""));

/** 便捷：无样式单行段 */
const one = (text: string): StyledText => [{ text }];

test("styledToSegments：无样式段不写 style 字段", () => {
  assert.deepEqual(styledToSegments([{ text: "a" }]), [{ text: "a" }]);
});

test("styledToSegments：color → fg；bold / italic", () => {
  assert.deepEqual(
    styledToSegments([{ text: "a", color: "red", bold: true }]),
    [{ text: "a", style: { fg: "red", bold: true } }],
  );
  assert.deepEqual(styledToSegments([{ text: "a", italic: true }]), [
    { text: "a", style: { italic: true } },
  ]);
});

test("styledToSegments：code → bg 主题语义色 code", () => {
  const segs = styledToSegments([{ text: "x", code: true }]);
  assert.equal(segs[0]!.style?.bg, "code");
});

test("styledToSegments：link → fg blue + underline", () => {
  const segs = styledToSegments([{ text: "url", link: "https://example.com" }]);
  assert.deepEqual(segs[0]!.style, { fg: "blue", underline: true });
});

test("wrapLeaf：短文本单行（行数 = 高度）", () => {
  const rows = wrapLeaf(one("hello"), 10, { prefixW: 0, hanging: 0 });
  assert.deepEqual(txt(rows), ["hello"]);
  assert.equal(rows.length, 1, "行数组长度 = 惯例高度");
});

test("wrapLeaf：宽字符（CJK 2 列）按列折行", () => {
  // "你好世界" = 8 列；宽 5 → 首行 4 列放 "你好"、续行 "世界"
  const rows = wrapLeaf(one("你好世界"), 5, { prefixW: 0, hanging: 0 });
  assert.deepEqual(txt(rows), ["你好", "世界"]);
  assert.equal(rows.length, 2);
});

test("wrapLeaf：prefixW 占首行（首行可用宽 = width - prefixW）", () => {
  // "abcdef" 6 字符；宽 6、prefixW 2 → 首行 4 列 "abcd"，续行（hanging 0）6 列 "ef"
  const rows = wrapLeaf(one("abcdef"), 6, { prefixW: 2, hanging: 0 });
  assert.deepEqual(txt(rows), ["abcd", "ef"]);
});

test("wrapLeaf：hanging 让续行可用宽收窄（缩进语义）", () => {
  // "abcdefghij" 10 字符；宽 8、hanging 2 → 首行 8 列、续行 6 列
  const rows = wrapLeaf(one("abcdefghij"), 8, { prefixW: 0, hanging: 2 });
  assert.deepEqual(txt(rows), ["abcdefgh", "ij"]);
});

test("wrapLeaf：balance 平衡折行（行数不变、列宽收窄）", () => {
  // 16 字符全宽 10 → 2 行（10 + 6）；平衡后两行各 8 列
  const rows = wrapLeaf(one("abcdefghijklmnop"), 10, {
    prefixW: 0,
    hanging: 0,
    balance: true,
  });
  assert.deepEqual(txt(rows), ["abcdefgh", "ijklmnop"]);
  assert.equal(rows.length, 2);
});

test("wrapLeaf：balance 与 hanging 叠加（续行再减 hanging）", () => {
  // 10 字符全宽 8（hanging 2）→ 2 行（8 + 2）。平衡候选 C = ceil(10/2) = 5，
  // 但续行可用宽 = 5 - 2 = 3 会多折出第 3 行 → 右移到 C = 6（首行 6、续行 4）保持 2 行
  const rows = wrapLeaf(one("abcdefghij"), 8, {
    prefixW: 0,
    hanging: 2,
    balance: true,
  });
  assert.deepEqual(txt(rows), ["abcdef", "ghij"]);
  assert.equal(rows.length, 2, "行数不变（同全宽 2 行）");
});

test("wrapLeaf：\\n 切物理行（空物理行保留为空行）", () => {
  assert.deepEqual(
    txt(wrapLeaf(one("ab\ncd"), 10, { prefixW: 0, hanging: 0 })),
    ["ab", "cd"],
  );
  assert.deepEqual(txt(wrapLeaf(one("a\n"), 10, { prefixW: 0, hanging: 0 })), [
    "a",
    "",
  ]);
  assert.deepEqual(txt(wrapLeaf(one("\nb"), 10, { prefixW: 0, hanging: 0 })), [
    "",
    "b",
  ]);
});

test("wrapLeaf：后续物理行基宽含 hanging 减法（不双重减宽）", () => {
  // 第二物理行首行只减一次 hanging：宽 8、hanging 2 → "ab\ndefgh" → "ab" + "defgh"(可放 6)
  const rows = wrapLeaf(one("ab\ndefgh"), 8, { prefixW: 0, hanging: 2 });
  assert.deepEqual(txt(rows), ["ab", "defgh"]);
});

test("wrapLeaf：空输入与空段（产出一行空段）", () => {
  assert.deepEqual(txt(wrapLeaf([], 10, { prefixW: 0, hanging: 0 })), [""]);
  assert.deepEqual(
    txt(wrapLeaf([{ text: "" }], 10, { prefixW: 0, hanging: 0 })),
    [""],
  );
});

test("wrapLeaf：超宽单字符强制放下（不丢字符、不切半个 CJK）", () => {
  const rows = wrapLeaf(one("界"), 1, { prefixW: 0, hanging: 0 });
  assert.deepEqual(txt(rows), ["界"]);
});

test("wrapLeaf：多段样式折行（样式跨行保留）", () => {
  const rows = wrapLeaf([{ text: "ab", bold: true }, { text: "cd" }], 3, {
    prefixW: 0,
    hanging: 0,
  });
  // "ab"(2 列 bold) + "c"(1 列) 填满 3 → 换行；"d" 落续行
  assert.deepEqual(txt(rows), ["abc", "d"]);
  assert.equal(rows[0]![0]!.style?.bold, true, "首行 bold 段保留");
  assert.equal(rows[1]![0]!.style, undefined, "续行 d 是无样式段");
});

test("wrapLeaf：相邻同样式段合并（样式不拆散）", () => {
  const rows = wrapLeaf(
    [
      { text: "aa", bold: true },
      { text: "bb", bold: true },
    ],
    10,
    {
      prefixW: 0,
      hanging: 0,
    },
  );
  assert.deepEqual(txt(rows), ["aabb"]);
  assert.equal(rows[0]!.length, 1, "相邻同样式段合并为一段");
});

test("wrapLeaf：单元格宽下不折行（内容放得下）", () => {
  const rows = wrapLeaf(one("cell"), 6, { prefixW: 0, hanging: 0 });
  assert.deepEqual(txt(rows), ["cell"]);
  assert.equal(rows.length, 1);
});
