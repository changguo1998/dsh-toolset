// TUI/tests/pane-text-margin.test.ts — 会话区/回合区「无文字右缘留白」（2026-11-05 取消）
//
// 覆盖：两 pane 的**文字排版宽 = 正文宽**（横向会话区 = dialogueW、回合区 = activityW；
// 纵向两 pane 各 = contentW），文字可铺到正文右缘、行尾不再多出 1 列空白；
// **边框/分隔线保持不变**：标题栏下划线、回合区分隔线仍铺满整行到区域外缘框列，
// 顶区帧行宽恒 = cols，回合分隔线（╌）右端与正文右缘对齐；文字不超宽。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame,
  frameGeometry,
  displayWidth,
  metricsFor,
  regionColumnWidth,
} from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { rowText } from "./helpers/rowText.ts";
import {
  sectionsFromScript,
  turnScript,
  type ScriptStep,
} from "./helpers/deliveriesFromScript.ts";

/** 典型回合（长文本铺满两个 pane）+ 指定排列方式
 *  条目 16 段 A：内容不再写 `state.local`（旧路径靠 `sectionsOf` 回退重放），改为显式
 *  造交付流塞进 `state.pipeline`——帧只认节模型 */
function state(placement: "vertical" | "horizontal") {
  let s = initialState(undefined, { activityPlacement: placement });
  s = reduceState(s, {
    type: "status",
    status: { time: "12:00:00", cwd: "/home/u/work", git: "main" },
  });
  const T = 1_700_000_000_000;
  const steps: ScriptStep[] = [
    // 回合 1：用户块 + 最终正文（finalize + turn-end → 进会话区）
    ...turnScript({
      turn: 1,
      time: T,
      user: "检查文字右缘",
      assistant:
        "回复正文：这是一段足够长的中文内容，用来把会话区 的文字行铺满到排版右缘，看最右可见字符落在哪一列（末尾还有 ABCdef）。",
      reason: "completed",
    }),
    // 回合 2：用户块 + 思考（回合区内容，铺满一行观察最右可见列）
    ...turnScript({
      turn: 2,
      time: T + 60_000,
      user: "第二轮",
      reasoning:
        "回合区内容：同样需要铺满一行来观察最右可见列，中文与 ASCII 混排 mixed-content-tail。",
    }),
  ];
  return { ...s, pipeline: sectionsFromScript(steps) };
}

/** 行内 [from, to) 列区间里所有非空白字符的显示列 */
function inkCols(text: string, from: number, to: number): number[] {
  const out: number[] = [];
  let w = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w >= to) break;
    if (ch !== " " && w >= from) out.push(w);
    w += cw;
  }
  return out;
}

/** 行内 [from, to) 里最右的非空白列（无内容返回 -1） */
function rightMostInk(text: string, from: number, to: number): number {
  return inkCols(text, from, to).at(-1) ?? -1;
}

const SIZES = [
  { rows: 40, cols: 120 },
  { rows: 24, cols: 80 },
  { rows: 30, cols: 100 },
];

/** 两 pane 的行范围与列范围（按排列方式推导） */
function paneRanges(g: ReturnType<typeof frameGeometry>) {
  const horizontal = g.mode === "horizontal";
  const bodyEnd = g.contentStartCol + g.contentW;
  return {
    histRows: [
      g.titleRows,
      horizontal ? g.contentTopH : g.activitySepRow,
    ] as const,
    actRows: [
      horizontal ? g.titleRows : g.activitySepRow + 1,
      g.contentTopH,
    ] as const,
    histFrom: g.contentStartCol,
    histTo: horizontal ? (g.innerDividerCol ?? bodyEnd) : bodyEnd,
    actFrom: horizontal
      ? (g.innerDividerCol ?? g.contentStartCol) + 1
      : g.contentStartCol,
    actTo: bodyEnd,
  };
}

test("无文字右缘留白：两 pane 文字宽 = 正文宽（横向与纵向都不再让 1 列）", () => {
  for (const size of SIZES) {
    for (const placement of ["vertical", "horizontal"] as const) {
      const g = frameGeometry(state(placement), size);
      const contentW = regionColumnWidth(metricsFor(size).historyWidth);
      const tag = `${size.rows}x${size.cols}/${placement}`;
      // 区域正文宽（边框口径）不变
      assert.equal(g.contentW, contentW, `${tag}: 区域正文宽不变`);
      assert.equal(
        g.dialogueTextW,
        g.dialogueW,
        `${tag}: 会话区文字宽 = 正文宽`,
      );
      assert.equal(
        g.activityTextW,
        g.activityW,
        `${tag}: 回合区文字宽 = 正文宽`,
      );
      if (g.mode === "horizontal") {
        assert.equal(
          g.dialogueW + 1 + g.activityW,
          contentW,
          `${tag}: 两 pane + 内部分隔 = 区域正文宽（边框不变）`,
        );
      } else {
        assert.equal(g.dialogueW, contentW, `${tag}: 纵向两 pane 共占正文宽`);
        assert.equal(g.activityW, contentW, `${tag}: 纵向两 pane 同宽`);
      }
    }
  }
});

test("无文字右缘留白：横线与边框仍满宽，回合分隔线右端与正文右缘对齐", () => {
  for (const size of SIZES) {
    for (const placement of ["vertical", "horizontal"] as const) {
      const g = frameGeometry(state(placement), size);
      const rows = buildFrame(state(placement), size).map(rowText);
      const top = rows.slice(0, g.contentTopH);
      const tag = `${size.rows}x${size.cols}/${placement}`;
      const r = paneRanges(g);
      // 标题栏/边框行满宽；内容行不超宽（回合区行尾不补空格）
      assert.ok(
        top.slice(0, r.actRows[0]).every((t) => displayWidth(t) === size.cols),
        `${tag}: 标题与边框行满宽`,
      );
      assert.ok(
        top.every((t) => displayWidth(t) <= size.cols),
        `${tag}: 顶区行不超宽`,
      );
      assert.equal(displayWidth(top[0]!), size.cols, `${tag}: 顶区行宽 = cols`);
      // 标题栏下划线：铺满整行到屏幕最右列（含区域外缘框列，边框不留缺口）
      const underline = rows[g.titleRows - 1]!;
      assert.equal(
        rightMostInk(underline, 0, size.cols),
        size.cols - 1,
        `${tag}: 标题下划线铺满到屏幕最右列`,
      );
      // 纵向：回合区分隔线同样铺满整行
      if (g.mode === "vertical") {
        assert.equal(
          rightMostInk(rows[g.activitySepRow]!, 0, size.cols),
          size.cols - 1,
          `${tag}: 回合区分隔线铺满到屏幕最右列`,
        );
      }
      // 回合分隔线（╌）：与正文同宽——右端停在正文排版右缘（= 正文右缘）
      const ruleRow = rows.find((t) => t.includes("╌"))!;
      assert.ok(ruleRow !== undefined, `${tag}: 回合分隔线可见`);
      const ruleInk = rightMostInk(
        ruleRow.replace(/[^╌]/gu, " "),
        0,
        size.cols,
      );
      assert.equal(
        ruleInk,
        r.histFrom + g.dialogueTextW - 1,
        `${tag}: 回合分隔线右端与正文右缘对齐`,
      );
    }
  }
});

test("无文字右缘留白：文字铺到正文右缘，且不越过外框列", () => {
  for (const size of SIZES) {
    for (const placement of ["vertical", "horizontal"] as const) {
      const st = state(placement);
      const g = frameGeometry(st, size);
      const rows = buildFrame(st, size).map(rowText);
      const r = paneRanges(g);
      const tag = `${size.rows}x${size.cols}/${placement}`;
      // 横线行（回合分隔线 ╌）不参与文字右缘测量（横线铺满 pane）
      const histRows = rows
        .slice(r.histRows[0], r.histRows[1])
        .filter((t) => !t.includes("╌"));
      const actRows = rows.slice(r.actRows[0], r.actRows[1]);
      // 文字恰好铺到「文字排版宽」的右缘（= 正文宽，不再让 1 列）
      assert.equal(
        Math.max(...histRows.map((t) => rightMostInk(t, r.histFrom, r.histTo))),
        r.histFrom + g.dialogueTextW - 1,
        `${tag}: 历史文字铺到正文右缘`,
      );
      // 回合区按可视高截取尾部（且常被截断），只要求不越界、且有内容可见
      const actMax = Math.max(
        ...actRows.map((t) => rightMostInk(t, r.actFrom, r.actTo)),
      );
      assert.ok(
        actMax <= r.actFrom + g.activityTextW - 1,
        `${tag}: 活动文字不越正文右缘（实际 ${actMax}）`,
      );
      assert.ok(actMax > r.actFrom, `${tag}: 回合区有可见文本`);
    }
  }
});

test("无文字右缘留白：窄终端下文字宽至少 1 列（不出现负宽）", () => {
  for (const cols of [16, 22, 30, 40]) {
    const g = frameGeometry(state("vertical"), { rows: 24, cols });
    assert.ok(g.dialogueTextW >= 1, `cols=${cols} 历史文字宽 ≥ 1`);
    assert.ok(g.activityTextW >= 1, `cols=${cols} 活动文字宽 ≥ 1`);
    assert.ok(
      g.activityTextW <= g.contentW,
      `cols=${cols} 文字宽不超区域正文宽`,
    );
  }
});
