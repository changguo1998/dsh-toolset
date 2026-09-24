// tests/tool-call-wrap.test.ts — 活动区工具调用行折行宽度回归
//
// 回归点：工具调用长参数软折行时，续行统一 2 空格缩进，折行宽度必须按缩进扣除，
// 缩进后每行总宽 ≤ 窗口宽（修复前续行仍按全宽折行，缩进后超出 2 列、溢出右边框）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame,
  displayWidth,
  wrapToolCallText,
  TOOL_CONT_INDENT,
} from "../src/app/layout.ts";
import { appendToolLine, initialState } from "../src/app/state.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import { rowText } from "./helpers/rowText.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = " ".repeat(TOOL_CONT_INDENT);

test("wrapToolCallText：首行全宽，续行缩进且总宽不超 width", () => {
  const width = 20;
  const rows = wrapToolCallText("bash command=" + "a".repeat(60), width);
  assert.ok(rows.length > 1, "长参数应折成多行");
  assert.ok(rows[0]!.startsWith("bash command="), "首行保留原文起点");
  for (const r of rows) assert.ok(displayWidth(r) <= width, `溢出: ${r}`);
  for (const r of rows.slice(1)) assert.ok(r.startsWith(pad), `续行缩进: ${r}`);
});

test("wrapToolCallText：CJK 参数按显示宽度折行不溢出", () => {
  const width = 21;
  const rows = wrapToolCallText(
    "bash echo " + "中文参数内容".repeat(10),
    width,
  );
  for (const r of rows) assert.ok(displayWidth(r) <= width, `溢出: ${r}`);
});

test("wrapToolCallText：参数内显式换行后的各行同样缩进", () => {
  assert.deepEqual(wrapToolCallText("a\nb\nc", 20).map(stripAnsi), [
    "a",
    pad + "b",
    pad + "c",
  ]);
  // 空文本保留单空行（与旧行为一致）
  assert.deepEqual(wrapToolCallText("", 20), [""]);
});

test("wrapToolCallText：窄窗口（width ≤ 缩进）降级不缩进，仍不溢出", () => {
  // 宽度 = 缩进量时不缩进（缩进本身会溢出），仅按宽度硬折
  const rows = wrapToolCallText("abcdefgh", TOOL_CONT_INDENT);
  assert.ok(
    rows.every((r) => !r.startsWith(" ")),
    "不得带缩进空格",
  );
  assert.equal(rows.join(""), "abcdefgh");
});

test("buildFrame：活动区工具调用长参数折行后不溢出边框", () => {
  const cols = 60;
  const cases = [
    "bash command=" + "a".repeat(140),
    "bash command=echo " + "中文参数内容".repeat(15),
    "bash command=line1-" + "x".repeat(90) + "\nline2-" + "y".repeat(90),
  ];
  for (const text of cases) {
    const state = appendToolLine(initialState(), text, undefined, {
      keepLineBreaks: true,
    });
    const frame = buildFrame(state, { rows: 24, cols });
    for (const line of frame) {
      const w = displayWidth(rowText(line));
      assert.ok(w <= cols, `行宽 ${w} > ${cols}: ${stripAnsi(rowText(line))}`);
    }
  }
});

test("buildFrame：工具结果行长 detail 折行后续行同样缩进且不溢出", () => {
  const cols = 60;
  const cases = ["✓ " + "r".repeat(150), "✗ " + "失败原因".repeat(15)];
  for (const text of cases) {
    const state = appendToolLine(initialState(), text);
    const frame = buildFrame(state, { rows: 24, cols });
    for (const line of frame) {
      const w = displayWidth(rowText(line));
      assert.ok(w <= cols, `行宽 ${w} > ${cols}: ${stripAnsi(rowText(line))}`);
    }
    const grid = frame.map((l) => stripAnsi(rowText(l)));
    // 长 detail 必然折行：结果行首行之后应存在缩进 ≥4 列的续行
    // （行首可能有左框格/占位空格，故 `/^[│ ]* {4,}\S/` 兼容）
    const headIdx = grid.findIndex((l) => /^[│ ]*[✓✗] /.test(l));
    assert.ok(headIdx >= 0, "应渲染出结果行首行");
    const cont = grid.slice(headIdx + 1).find((l) => /^[│ ]* {4,}\S/.test(l));
    assert.ok(cont, "结果行续行应以 ≥4 空格缩进");
  }
});

test("新增管线与 wrapToolCallText 逐行一致：显式换行 + 第二物理行也软折行", () => {
  // 回归 advisor 复核 Bug 1：splitAndWrapSegments 曾对首/续物理行双重减宽
  // （width - 2*hanging）。此处对照 buildContentRows 与旧 wrapToolCallText
  // 的逐行文本，确保持平语义一致（首物理行全宽折、续行/软续行均 4 空格
  // 悬挂缩进且宽度扣除缩进）。
  const width = 40;
  const text =
    "bash command=longarg-" + "x".repeat(80) + "\nline2-" + "y".repeat(80);
  const built = buildContentRows(
    [{ text, kind: "tool" }],
    { themeId: "dark" as const, gutter: 4 },
    width,
  );
  const newText = built.activity.map((r) =>
    r.segments.map((s) => s.text).join(""),
  );
  assert.deepEqual(newText, wrapToolCallText(text, width));
});
