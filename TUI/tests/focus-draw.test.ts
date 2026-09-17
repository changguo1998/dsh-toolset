// tests/focus-draw.test.ts — focus-frame.ts 模块单测（setCell + 焦点覆写规则）
//
// setCell：显示列定位、CJK 不切、多段行拆分、幂等。
// focusFrame：四焦点态在合成矩形上的覆写（history/activity/status）、
// null 不覆写、行数/行序不变。

import { test } from "node:test";
import assert from "node:assert/strict";
import { setCell, focusFrame, rowPlain } from "../src/app/layout/focus-frame.ts";
import type { FrameRow } from "../src/renderer/screen.ts";
import type { PaneId, Rect } from "../src/app/layout/box.ts";

const row = (text: string): FrameRow => ({ segments: [{ text }] });
const bright = "brightWhite";

/** 构造 N 行 × cols 纯文本帧 */
function frameOf(rows: number, cols: number): FrameRow[] {
  return Array.from({ length: rows }, () => row(" ".repeat(cols)));
}

/** 构造标准三区 rects（history/activity 左列 + status 右列） */
function stdRects(
  cols: number,
  sepRow: number, // 活动区分隔行（history 底边 = activity 顶边）
  statusRow: number, // 状态区上方分隔行（activity/status 底边）
): Map<PaneId, Rect> {
  const historyW = Math.floor(cols * 2 / 3);
  const statusW = cols - historyW;
  const m = new Map<PaneId, Rect>();
  // h 含边界行：bottom = y + h - 1（history 底=分隔行、activity 底=状态分隔、status 底=状态分隔）
  m.set("history", { x: 0, y: 1, w: historyW, h: sepRow }); // bottom = 1+h-1 = sepRow
  m.set("activity", { x: 0, y: sepRow, w: historyW, h: statusRow - sepRow + 1 }); // bottom = statusRow
  m.set("status", { x: historyW, y: 0, w: statusW, h: statusRow + 1 }); // bottom = statusRow
  void m;
  return m;
}

test("setCell：无样式段替换单字符（段拆分）", () => {
  const r = row("  ab cd  ");
  setCell(r, 2, "X", { fg: "red" });
  assert.equal(rowPlain(r), "  Xb cd  ");
  assert.equal(r.segments.length, 3, "拆为 前段/X/后段");
  assert.equal(r.segments[1]!.text, "X");
  assert.deepEqual(r.segments[1]!.style, { fg: "red" });
});

test("setCell：跨段定位（多段行）", () => {
  const r: FrameRow = {
    segments: [
      { text: "ab" },
      { text: "cd", style: { fg: "green" } },
      { text: "ef" },
    ],
  };
  setCell(r, 3, "Y"); // col3 = 「cd」段第 2 字形 → 替换 d（tail 为空删除）
  assert.equal(rowPlain(r), "abcYef");
  // 段结构：ab + cd 的 head「c」+ Y + ef（tail 空不产段）
  const texts = r.segments.map((s) => s.text);
  assert.deepEqual(texts, ["ab", "c", "Y", "ef"]);
});

test("setCell：CJK 字形内部 no-op（不切 2 列字形）", () => {
  const r = row(" 中文x");
  // 「中」占 2 列（col 1 起）；col 1=中 起始、col 2=中的第 2 列（内部）
  setCell(r, 1, "│"); // 命中「中」整字 → CJK 不覆写
  assert.equal(rowPlain(r), " 中文x");
  setCell(r, 2, "│"); // 命中「中」内部第 2 列 → no-op
  assert.equal(rowPlain(r), " 中文x");
  setCell(r, 5, "│"); // 「x」1 列覆盖 col 5
  assert.equal(rowPlain(r), " 中文│");
});

test("setCell：幂等（同字形同样式不重复拆分）", () => {
  const r = row("ab");
  setCell(r, 0, "a", { fg: "red" });
  const before = r.segments.length;
  setCell(r, 0, "a", { fg: "red" });
  assert.equal(r.segments.length, before, "幂等不新增段");
  // 但样式不同的相同字形会替换为带样式
  const r2 = row("ab");
  setCell(r2, 0, "a", { fg: "red" });
  assert.equal(r2.segments[0]!.style?.fg, "red");
});

test("setCell：越界 col no-op", () => {
  const r = row("ab");
  setCell(r, 9, "X");
  assert.equal(rowPlain(r), "ab");
});

test("focusFrame：null 不覆写", () => {
  const rows = frameOf(5, 10);
  const before = rows.map(rowPlain);
  focusFrame(
    { themeId: "dark", focusedPanel: null },
    stdRects(10, 3, 4),
    rows,
  );
  assert.deepEqual(rows.map(rowPlain), before);
});

test("focusFrame：history 焦点覆写（顶边/左缘/D 列竖线/底边）", () => {
  const cols = 12;
  const sepRow = 3; // 活动区分隔行
  const statusRow = 5; // 状态区上方分隔
  const rows = frameOf(7, cols);
  focusFrame(
    { themeId: "dark", focusedPanel: "history" },
    stdRects(cols, sepRow, statusRow),
    rows,
  );
  // 顶边（行 1=rect.top）：┌ 左边、─ 中、┐ D 列
  const top = rowPlain(rows[1]!);
  assert.equal(top[0], "┌");
  assert.equal(top[5 - 1 + 4], "┐"); // D 列 = historyW-? 见下
  // 对话区行（2）：左缘 + D 列竖线
  const mid = rowPlain(rows[2]!);
  assert.equal(mid[0], "│");
  // 底边（行 3=sepRow）：┘ 两端
  const bot = rowPlain(rows[3]!);
  assert.equal(bot[0], "┘");
  // 行数与行序不变
  assert.equal(rows.length, 7);
});

test("focusFrame：activity 焦点覆写（顶边 ┌/┐、左缘/D 竖线、底边 └/┴）", () => {
  const cols = 12;
  const rows = frameOf(7, cols);
  focusFrame(
    { themeId: "dark", focusedPanel: "activity" },
    stdRects(cols, 3, 5),
    rows,
  );
  const top = rowPlain(rows[3]!); // 活动区分隔行 = activity 顶边
  assert.equal(top[0], "┌");
  const bot = rowPlain(rows[5]!); // 状态区上方分隔行 = activity 底边
  assert.equal(bot[0], "└");
});

test("focusFrame：status 焦点覆写（顶边 ┐、右缘竖线、底边 ┘/┴）", () => {
  const cols = 12;
  const rows = frameOf(7, cols);
  focusFrame(
    { themeId: "dark", focusedPanel: "status" },
    stdRects(cols, 3, 5),
    rows,
  );
  const top = rowPlain(rows[0]!); // statusRect.top=0
  assert.equal(top[cols - 1], "┐", "状态列顶边右缘 ┐");
  const bot = rowPlain(rows[5]!); // 状态区上方分隔行（status 底边）
  assert.equal(bot[cols - 1], "┘", "状态列底边右缘 ┘");
});
