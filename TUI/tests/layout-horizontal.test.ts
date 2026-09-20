// tests/layout-horizontal.test.ts — 活动区排列方式（上下/左右，黄金比自动选择）回归
//
// 覆盖：topPaneSplit 在帧内的落地（内部分隔列 + 下划线行 ┬ / 状态区分隔行 ┴）、
// 两 pane 独立宽度（各自补齐、活动 pane 按自身宽度换行）、滚动口径与帧一致
// （dialogueScrollMetrics/inputPanelHeights）、焦点框落到内部分隔列。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame,
  dialogueScrollMetrics,
  displayWidth,
  inputPanelHeights,
  leftColumnWidth,
  metricsFor,
  topPaneSplit,
  FRAME_LEFT_COLS,
} from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import type { Buffer } from "../src/app/state.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { AppState } from "../src/app/state.ts";
import { rowText } from "./helpers/rowText.ts";

/** 一段典型回合内容：用户提问 + 思考 + 工具调用 + 最终回复 */
function turnState(placement: "auto" | "vertical" | "horizontal"): AppState {
  let s = initialState(undefined, {
    activityDivisor: 2,
    activityPlacement: placement,
  });
  for (let i = 1; i <= 4; i++) {
    s = reduceState(s, {
      type: "user-line",
      text: `用户问题 ${i}：请检查第 ${i} 项`,
    });
    s = reduceState(s, { type: "turn-begin" });
    s = reduceState(s, {
      type: "thinking",
      text: `思考 ${i}：这是一段较长的思考内容，用来观察活动 pane 自身宽度下的换行结果。`,
    });
    s = reduceState(s, {
      type: "tool-call",
      sessionId: "",
      name: "bash",
      summary: "sed -n '1,20p' src/app/layout.ts",
    });
    s = reduceState(s, {
      type: "append",
      text: `回复 ${i}：这是一段较长的回复内容，用来观察对话 pane 自身宽度下的换行结果。`,
    });
    s = reduceState(s, { type: "turn-end" });
  }
  return s;
}

/** 按显示列取一行文本的 [from, to) 区间（CJK 安全） */
function cols(line: string, from: number, to: number): string {
  let out = "";
  let w = 0;
  for (const ch of line) {
    const cw = displayWidth(ch);
    if (w >= to) break;
    if (w >= from && w + cw <= to) out += ch;
    w += cw;
  }
  return out;
}

const SIZE = { rows: 18, cols: 140 };
/** 主分隔竖线列（历史区右缘/状态列左缘） */
const D = metricsFor(SIZE, false, 1, 1, {}).historyWidth;
const CONTENT_W = leftColumnWidth(D);
const SPLIT = topPaneSplit(12, CONTENT_W, 2, undefined, "auto");
/** 内部分隔竖线帧列（左缘框格 + 活动 pane 宽；活动区在左、历史区在右） */
const DIV_COL = FRAME_LEFT_COLS + SPLIT.activityW;

test("横向排列：宽而矮终端 auto 选左右并落地内部分隔列与交汇字形", () => {
  assert.equal(SPLIT.mode, "horizontal", "宽 93 / 可用 10 行 → 比 φ 扁");
  assert.equal(SPLIT.dialogueH, 10, "两 pane 等高 = 可用行数");
  assert.equal(SPLIT.activityH, 10);
  const rows = buildFrame(turnState("auto"), SIZE).map(rowText);
  assert.equal(rows.length, SIZE.rows);
  // 标题行仍是整列标题；下划线行在内部分隔列让位 ┬（竖线自此下行）
  assert.ok(rows[0]!.startsWith(" <title>") || rows[0]!.includes("<title>"));
  assert.equal(cols(rows[1]!, DIV_COL, DIV_COL + 1), "┬");
  // 内容行（标题栏之后到状态区分隔行之前）内部分隔列为竖线
  for (let r = 2; r < 12; r++)
    assert.equal(cols(rows[r]!, DIV_COL, DIV_COL + 1), "│", `rc=${r}`);
  // 状态区上方分隔行：内部分隔列收束为 ┴（与 D 列 ┴ 并存）
  assert.equal(cols(rows[12]!, DIV_COL, DIV_COL + 1), "┴");
  assert.equal(cols(rows[12]!, D, D + 1), "┴", "D 列交点不变");
  // 两个 pane 都不越界：活动 pane（左）右缘紧邻分隔列、对话 pane（右）右缘紧邻 D 列
  for (let r = 2; r < 12; r++) {
    assert.equal(cols(rows[r]!, D, D + 1), "│", `D 列竖线 rc=${r}`);
    const act = cols(rows[r]!, FRAME_LEFT_COLS, DIV_COL);
    assert.equal(displayWidth(act), SPLIT.activityW, `活动 pane 定宽 rc=${r}`);
    const dia = cols(rows[r]!, DIV_COL + 1, D);
    assert.equal(displayWidth(dia), SPLIT.dialogueW, `对话 pane 定宽 rc=${r}`);
  }
});

test("横向排列：固定 placement 不受黄金比影响（vertical 仍纵向、horizontal 强制左右）", () => {
  const vert = buildFrame(turnState("vertical"), SIZE).map(rowText);
  // 纵向：内部分隔列位置是正文（不是竖线），状态区分隔行也不该出现额外 ┴
  assert.notEqual(cols(vert[12]!, DIV_COL, DIV_COL + 1), "┴");
  // 纵向仍有活动区分隔行（历史底边）：第 12-2-1=9 行左右为 ─ 全横线
  const horz = buildFrame(turnState("horizontal"), SIZE).map(rowText);
  assert.equal(cols(horz[1]!, DIV_COL, DIV_COL + 1), "┬");
});

test("横向排列：滚动口径与帧内 pane 宽高一致（半屏/翻页/跳转坐标）", () => {
  const s = turnState("auto");
  const m = dialogueScrollMetrics(s, SIZE);
  assert.equal(m.contentW, SPLIT.dialogueW, "跳转坐标按对话 pane 宽度换算");
  assert.equal(m.dialogueH, SPLIT.dialogueH);
  const page = inputPanelHeights(s, SIZE);
  assert.equal(page.dialogueH, SPLIT.dialogueH);
  assert.equal(
    page.activityH,
    SPLIT.activityH,
    "活动 pane 满高（翻页页高随之变大）",
  );
});

test("横向排列：焦点框落在内部分隔列（activity 右缘 / history 左缘）", () => {
  let s = turnState("auto");
  // 焦点循环：null → history → activity → status
  s = reduceState(s, { type: "focus-panel-cycle" });
  const hist = buildFrame(s, SIZE).map(rowText);
  assert.equal(cols(hist[1]!, 0, 1), " ", "history 在右：左缘框格不属它");
  assert.equal(
    cols(hist[1]!, DIV_COL, DIV_COL + 1),
    "┬",
    "history 顶边左角 = 内部分隔列",
  );
  assert.equal(cols(hist[1]!, D, D + 1), "┐", "history 顶边右角 = D 列");
  assert.equal(
    cols(hist[12]!, DIV_COL, DIV_COL + 1),
    "┴",
    "history 底边左角竖线收束",
  );
  s = reduceState(s, { type: "focus-panel-cycle" });
  const act = buildFrame(s, SIZE).map(rowText);
  assert.equal(cols(act[1]!, 0, 1), "┌", "activity 在左：顶边左角 = 左缘框格");
  assert.equal(
    cols(act[1]!, DIV_COL, DIV_COL + 1),
    "┬",
    "activity 顶边右角 = 内部分隔列",
  );
  assert.equal(cols(act[12]!, 0, 1), "└");
  assert.equal(cols(act[12]!, DIV_COL, DIV_COL + 1), "┴");
});

test("横向排列：两 pane 各自宽度换行（buildContentRows 独立宽度）", () => {
  const buffer: Buffer = [
    {
      kind: "thinking",
      text: "思考：".repeat(1) + "很长的思考内容".repeat(12),
    },
    { kind: "assistant", text: "最终回复内容".repeat(12), final: true },
  ];
  const narrow = buildContentRows(buffer, { themeId: "dark" }, 20, 20);
  const wide = buildContentRows(buffer, { themeId: "dark" }, 60, 60);
  const actWidth = (rows: { segments: { text: string }[] }[]): number =>
    Math.max(
      ...rows.map((r) => displayWidth(r.segments.map((s) => s.text).join(""))),
    );
  assert.ok(
    actWidth(narrow.activity) <= 20,
    "活动 pane 按自身宽度换行（窄 pane 不溢出）",
  );
  assert.ok(
    wide.activity.length < narrow.activity.length,
    "宽 pane 行数更少：换行宽度确实生效",
  );
  assert.ok(
    actWidth(narrow.dialogue) <= 20 && actWidth(wide.dialogue) <= 60,
    "对话 pane 同样受自身宽度约束",
  );
});

test("横向排列：内部分隔列与下划线行 ┬ / 状态区分隔行 ┴ 同列（两 pane 不等宽时也不偏）", () => {
  // 100 列（状态列 33）→ 左列正文宽 66 → 活动 pane 33 / 对话 pane 32：两 pane
  // 不等宽，正是「交汇字形取 dialogueW 而非 activityW」会偏一列的情形
  const size = { rows: 18, cols: 100 };
  const m = metricsFor(size, false, 1, 1, {});
  const contentW = leftColumnWidth(m.historyWidth);
  const split = topPaneSplit(m.topHeight, contentW, 2, undefined, "auto");
  assert.equal(split.mode, "horizontal");
  assert.notEqual(split.activityW, split.dialogueW, "本用例要求两 pane 不等宽");
  const divCol = m.historyWidth - contentW + split.activityW;
  const rows = buildFrame(turnState("auto"), size).map(rowText);
  assert.equal(cols(rows[1]!, divCol, divCol + 1), "┬", "下划线行交汇");
  for (let r = 2; r < m.topHeight; r++)
    assert.equal(cols(rows[r]!, divCol, divCol + 1), "│", `竖线 rc=${r}`);
  assert.equal(
    cols(rows[m.topHeight]!, divCol, divCol + 1),
    "┴",
    "状态区分隔行交汇（与竖线同列）",
  );
});
