// tests/focus-draw.test.ts — focus-frame.ts 模块单测（setCell + 焦点覆写规则）
//
// setCell：显示列定位、CJK 不切、多段行拆分、幂等。
// focusFrame：四焦点态在合成矩形上的覆写（history/activity/status）、
// null 不覆写、行数/行序不变。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setCell,
  focusFrame,
  rowPlain,
} from "../src/app/layout/focus-frame.ts";
import type { FrameRow } from "../src/renderer/screen.ts";
import type { PaneId, Rect } from "../src/app/layout/box.ts";

const row = (text: string): FrameRow => ({ segments: [{ text }] });

/** 构造 N 行 × cols 纯文本帧 */
function frameOf(rows: number, cols: number): FrameRow[] {
  return Array.from({ length: rows }, () => row(" ".repeat(cols)));
}

/**
 * 构造标准三区 rects（status 最左窄列 + history/activity 区域宽列）。
 * 区域左缘 = 分隔竖线列 D（= statusW-1，与状态列右缘共用该框线）、右缘 = R 列
 * （cols-1，区域外缘框列）——与 buildFrame 的矩形口径一致。
 */
function stdRects(
  cols: number,
  sepRow: number, // 活动区分隔行（history 底边 = activity 顶边）
  statusRow: number, // 状态区上方分隔行（activity/status 底边）
): Map<PaneId, Rect> {
  const statusW = Math.floor(cols / 3);
  const D = statusW - 1;
  const regionW = cols - D;
  const m = new Map<PaneId, Rect>();
  // h 含边界行：bottom = y + h - 1（history 底=分隔行、activity 底=状态分隔、status 底=状态分隔）
  m.set("history", { x: D, y: 1, w: regionW, h: sepRow }); // bottom = 1+h-1 = sepRow
  m.set("activity", {
    x: D,
    y: sepRow,
    w: regionW,
    h: statusRow - sepRow + 1,
  }); // bottom = statusRow
  m.set("status", { x: 0, y: 0, w: statusW, h: statusRow + 1 }); // right = D
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
  focusFrame({ themeId: "dark", focusedPanel: null }, stdRects(10, 3, 4), rows);
  assert.deepEqual(rows.map(rowPlain), before);
});

test("focusFrame：history 焦点覆写（顶边/左右缘竖线/底边）", () => {
  const cols = 12;
  const sepRow = 3; // 活动区分隔行
  const statusRow = 5; // 状态区上方分隔
  const rows = frameOf(7, cols);
  const rects = stdRects(cols, sepRow, statusRow);
  focusFrame({ themeId: "dark", focusedPanel: "history" }, rects, rows);
  const r = rects.get("history")!;
  const left = r.x; // 分隔竖线列 D（区域左缘，与状态列共用）
  const right = r.x + r.w - 1; // 区域外缘框列
  // 顶边（行 1=rect.top）：├ 左（竖线贯穿 + 横线接入）、─ 中、┐ 右
  const top = rowPlain(rows[1]!);
  assert.equal(top[left], "├");
  assert.equal(top[right], "┐");
  // 历史区行（2）：左右缘竖线
  const mid = rowPlain(rows[2]!);
  assert.equal(mid[left], "│");
  assert.equal(mid[right], "│");
  // 底边（行 3=sepRow，活动区分隔行）：├（竖线贯穿）/ ┘
  const bot = rowPlain(rows[3]!);
  assert.equal(bot[left], "├");
  assert.equal(bot[right], "┘");
  // 行数与行序不变
  assert.equal(rows.length, 7);
});

test("focusFrame：activity 焦点覆写（顶边 ├/─、左缘竖线、底边 ┴；不画右边框）", () => {
  const cols = 12;
  const rows = frameOf(7, cols);
  const rects = stdRects(cols, 3, 5);
  focusFrame({ themeId: "dark", focusedPanel: "activity" }, rects, rows);
  const r = rects.get("activity")!;
  const right = r.x + r.w - 1;
  const top = rowPlain(rows[3]!); // 活动区分隔行 = activity 顶边
  assert.equal(top[r.x], "├", "左缘 D 列竖线贯穿（横线右接入）");
  assert.equal(top[right], "─", "顶边亮线铺到最右列，不画右角 ┐");
  const mid = rowPlain(rows[4]!); // 活动区行：只有左缘竖线
  assert.equal(mid[r.x], "│", "活动区行左缘竖线");
  assert.equal(mid[right], " ", "活动区不画右边框（右缘无竖线）");
  const bot = rowPlain(rows[5]!); // 状态区上方分隔行 = activity 底边
  assert.equal(bot[r.x], "┴", "左缘 D 列竖线收束");
  assert.equal(bot[right], "─", "底边亮线铺到最右列，不画右角 ┘");
});

test("focusFrame：status 焦点覆写（顶边 ┌/┐、左缘竖线、底边 └/┴）", () => {
  const cols = 12;
  const rows = frameOf(7, cols);
  const rects = stdRects(cols, 3, 5);
  focusFrame({ themeId: "dark", focusedPanel: "status" }, rects, rows);
  const r = rects.get("status")!;
  const left = r.x; // 0：屏幕最左 = 状态列外缘框列
  const right = r.x + r.w - 1; // 状态列右缘 = 分隔竖线列
  const top = rowPlain(rows[0]!); // statusRect.top=0
  assert.equal(top[left], "┌", "状态列顶边左缘 ┌");
  assert.equal(top[right], "┐", "状态列顶边右缘 ┐");
  const mid = rowPlain(rows[2]!);
  assert.equal(mid[left], "│", "状态列左缘竖线");
  assert.equal(mid[right], "│", "分隔竖线（status 焦点全列亮）");
  const bot = rowPlain(rows[5]!); // 状态区上方分隔行（status 底边）
  assert.equal(bot[left], "└", "状态列底边左缘 └");
  assert.equal(bot[right], "┴", "状态列底边右缘与分隔竖线相接 ┴");
});

test("setCell：surrogate pair emoji 不切两半（code point 安全）", () => {
  // 1F600 = 高位 + 低位代理对，占 2 UTF-16 单元 / 2 显示列（col0-1）
  const r: FrameRow = { segments: [{ text: "😀x" }] };
  // col0 = emoji 起点（宽 2 字形）→ 不覆写
  setCell(r, 0, "│");
  assert.equal(rowPlain(r), "😀x");
  // col1 = emoji 内部第 2 显示列 → no-op（我的循环以「col < cw+chW」定位到
  // 宽字形段内但不越过其 code point 边界，故 col1 命中 emoji 内部 no-op）
  setCell(r, 1, "│");
  assert.equal(rowPlain(r), "😀x", "emoji 内部列 no-op");
  // col2 = x（code point 边界）→ 覆写；x 与 emoji 同为 1/2 列交错
  setCell(r, 2, "Y");
  assert.equal(rowPlain(r), "😀Y");
});

test("setCell：非颜色样式差异不算幂等（bold/italic/underline/strike 参与比较）", () => {
  const r: FrameRow = { segments: [{ text: "ab" }] };
  // 同字形不同 bold → 替换为带 bold 样式（head 空不产段 → [bold a, b] 两段）
  setCell(r, 0, "a", { bold: true });
  assert.deepEqual(r.segments, [
    { text: "a", style: { bold: true } },
    { text: "b" },
  ]);
  // 再同字形同样式 → 幂等不拆
  const n = r.segments.length;
  setCell(r, 0, "a", { bold: true });
  assert.equal(r.segments.length, n);
  // 同字形仅 fg 不同 → 替换（新字符段在替换后的首段位置）
  setCell(r, 0, "a", { fg: "red" });
  assert.deepEqual(r.segments[0]!.style, { fg: "red" });
});
