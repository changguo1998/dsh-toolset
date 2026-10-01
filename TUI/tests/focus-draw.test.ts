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

test("focusFrame：空白帧上不落字形（#4：焦点不新增边框）", () => {
  const cols = 12;
  const rows = frameOf(7, cols);
  const before = rows.map(rowPlain);
  const rects = stdRects(cols, 3, 5);
  for (const panel of ["history", "activity", "status"] as const) {
    focusFrame({ themeId: "dark", focusedPanel: panel }, rects, rows);
  }
  assert.deepEqual(rows.map(rowPlain), before, "空白帧保持空白（不画新框）");
});

test("focusFrame：history 焦点只给既有框线上色（字形不变）", () => {
  const cols = 12;
  const rows = frameOf(7, cols);
  const rects = stdRects(cols, 3, 5);
  const r = rects.get("history")!;
  const left = r.x; // 分隔竖线列 D（区域左缘）
  const right = r.x + r.w - 1; // 区域外缘框列
  // 既有框线（模拟布局层的中性基线）：左右缘竖线 + 顶/底横线
  for (let i = 1; i <= 3; i++) {
    setCell(rows[i]!, left, "│");
    setCell(rows[i]!, right, "│");
  }
  for (let c = left; c <= right; c++) {
    setCell(rows[1]!, c, "─");
    setCell(rows[3]!, c, "─");
  }
  const before = rows.map(rowPlain);
  focusFrame({ themeId: "dark", focusedPanel: "history" }, rects, rows);
  assert.deepEqual(rows.map(rowPlain), before, "字形不变（只改颜色）");
  for (const [row, why] of [
    [rows[1]!, "顶边（标题栏下划线行）"],
    [rows[2]!, "左缘竖线"],
    [rows[3]!, "底边（活动区分隔行）"],
  ] as const) {
    assert.ok(
      row.segments.some((s) => s.style?.fg === "focus"),
      `${why} 转焦点色`,
    );
  }
  // 顶边**整行**都要转色（曾只染标签/角字，线体仍是边框色）
  {
    const plain = rowPlain(rows[1]!);
    assert.ok(plain.includes("─"), "顶边有横线字形");
    // 逐字形核对：每个 ─ 所在段都应是 focus 样式
    let w = 0;
    for (const seg of rows[1]!.segments) {
      for (const ch of seg.text) {
        if (ch === "─") {
          assert.equal(
            seg.style?.fg,
            "focus",
            `顶边第 ${w} 列的 ─ 应为焦点色（实际 ${seg.style?.fg}）`,
          );
        }
        w += 1;
      }
    }
  }
  // 内容列（中段空白列）不受影响
  assert.equal(rowPlain(rows[2]!).at(left + 3), " ", "内容列不被覆写");
});

test("focusFrame：activity 焦点只给既有框线上色（不画右边框）", () => {
  const cols = 12;
  const rows = frameOf(7, cols);
  const rects = stdRects(cols, 3, 5);
  const r = rects.get("activity")!;
  const lEdge = r.x; // 纵向排列：左缘 = D 列
  // 既有框线：左缘竖线（活动区行）+ 顶/底横线；右边框本就不存在（留白）
  for (let i = 4; i < 5; i++) setCell(rows[i]!, lEdge, "│");
  for (let c = lEdge; c <= r.x + r.w - 1; c++) {
    setCell(rows[3]!, c, "─");
    setCell(rows[5]!, c, "─");
  }
  const before = rows.map(rowPlain);
  focusFrame({ themeId: "dark", focusedPanel: "activity" }, rects, rows);
  assert.deepEqual(rows.map(rowPlain), before, "字形不变");
  assert.ok(
    rows[3]!.segments.some((s) => s.style?.fg === "focus"),
    "顶边既有横线转焦点色",
  );
  assert.equal(
    rowPlain(rows[4]!).at(r.x + r.w - 1),
    " ",
    "不画右边框（右缘保持留白）",
  );
});

test("focusFrame：status 焦点只给既有框线上色（不新增左缘/顶边）", () => {
  const cols = 12;
  const rows = frameOf(7, cols);
  const rects = stdRects(cols, 3, 5);
  const r = rects.get("status")!;
  const left = r.x; // 0：屏幕最左（本无框线）
  const right = r.x + r.w - 1; // 状态列右缘 = 分隔竖线列
  // 既有框线：右缘竖线 + 状态区分隔横线（底边）
  for (let i = 0; i <= 5; i++) setCell(rows[i]!, right, "│");
  for (let c = left; c <= right; c++) setCell(rows[5]!, c, "─");
  const before = rows.map(rowPlain);
  focusFrame({ themeId: "dark", focusedPanel: "status" }, rects, rows);
  assert.deepEqual(rows.map(rowPlain), before, "字形不变");
  assert.ok(
    rows[2]!.segments.some((s) => s.style?.fg === "focus"),
    "右缘既有竖线转焦点色",
  );
  assert.equal(rowPlain(rows[2]!).at(left), " ", "左缘不新增竖线（#4）");
  assert.equal(rowPlain(rows[0]!).at(left), " ", "顶边不新增横线（#4）");
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
