// tests/pane-text-margin.test.ts — 历史区/活动区「文字右缘留白」（PANE_TEXT_MARGIN_COLS）
//
// 覆盖：**只有文字排版宽度收窄**（P3：留白是行尾属性，只给右缘贴外框列的 pane）——
// 横向历史 pane 不留白（`┃` 紧贴内部分隔竖线）、横向活动 pane 让 1 列、纵向两 pane 同列各让 1 列；
// **边框/分隔线一概不动**：
// 标题栏下划线、活动区分隔线仍铺满整行到区域外缘框列，顶区帧行宽恒 = cols，
// 焦点框矩形也不变。文字不落在留白列（字形宽度算错时多出的列落在留白里，不整行溢出）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame,
  frameGeometry,
  displayWidth,
  metricsFor,
  regionColumnWidth,
  paneTextWidth,
  PANE_TEXT_MARGIN_COLS,
} from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { rowText } from "./helpers/rowText.ts";

/** 典型回合（长文本铺满两个 pane）+ 指定排列方式 */
function state(placement: "vertical" | "horizontal") {
  let s = initialState(undefined, { activityPlacement: placement });
  s = reduceState(s, {
    type: "status",
    status: { time: "12:00:00", cwd: "/home/u/work", git: "main" },
  });
  s = reduceState(s, { type: "user-line", text: "检查文字右缘留白" });
  s = reduceState(s, {
    type: "append",
    text: "回复正文：这是一段足够长的中文内容，用来把历史 pane 的文字行铺满到排版右缘，看最右可见字符落在哪一列（末尾还有 ABCdef）。",
  });
  s = reduceState(s, { type: "turn-end" });
  // 第二个回合 → buffer 里产生一条回合分隔线（kind=separator，渲染为 ╌ 横线）
  s = reduceState(s, { type: "user-line", text: "第二轮" });
  s = reduceState(s, { type: "turn-begin" });
  s = reduceState(s, {
    type: "thinking",
    text: "活动区内容：同样需要铺满一行来观察最右可见列，中文与 ASCII 混排 mixed-content-tail。",
  });
  return s;
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

/** 两 pane 的行范围与列范围（按排列方式推导，供留白断言使用） */
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

test("文字右缘留白：横向历史不留白 / 横向活动让 1 列 / 纵向两 pane 各让 1 列", () => {
  for (const size of SIZES) {
    for (const placement of ["vertical", "horizontal"] as const) {
      const g = frameGeometry(state(placement), size);
      const contentW = regionColumnWidth(metricsFor(size, false).historyWidth);
      const tag = `${size.rows}x${size.cols}/${placement}`;
      // 区域正文宽（边框口径）不受影响
      assert.equal(g.contentW, contentW, `${tag}: 区域正文宽不变`);
      if (g.mode === "horizontal") {
        assert.equal(
          g.dialogueTextW,
          g.dialogueW,
          `${tag}: 横向历史 pane 不留白（┃ 紧贴内部分隔竖线）`,
        );
        assert.equal(
          g.activityTextW,
          g.activityW - PANE_TEXT_MARGIN_COLS,
          `${tag}: 活动 pane 文字让 1 列`,
        );
        assert.equal(
          g.dialogueW + 1 + g.activityW,
          contentW,
          `${tag}: 两 pane + 内部分隔 = 区域正文宽（边框不变）`,
        );
      } else {
        assert.equal(
          g.dialogueW,
          contentW,
          `${tag}: 纵向两 pane 共占区域正文宽`,
        );
        assert.equal(
          g.dialogueTextW,
          paneTextWidth(g.dialogueW, true),
          `${tag}: 纵向两 pane 文字同宽，各让 1 列`,
        );
        assert.equal(g.activityTextW, g.dialogueTextW);
      }
    }
  }
});

test("文字右缘留白：横线（边框 + 回合分隔线）一律铺到屏幕最右列", () => {
  for (const size of SIZES) {
    for (const placement of ["vertical", "horizontal"] as const) {
      const g = frameGeometry(state(placement), size);
      const rows = buildFrame(state(placement), size).map(rowText);
      const top = rows.slice(0, g.contentTopH);
      const tag = `${size.rows}x${size.cols}/${placement}`;
      const r = paneRanges(g);
      // 标题栏/边框行满宽；内容行不超宽（活动区行尾不补空格）
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
      // 纵向：活动区分隔线同样铺满整行
      if (g.mode === "vertical") {
        assert.equal(
          rightMostInk(rows[g.activitySepRow]!, 0, size.cols),
          size.cols - 1,
          `${tag}: 活动区分隔线铺满到屏幕最右列`,
        );
      }
      // 回合分隔线（╌）：横线铺满 pane（纵向含外缘框列 → 顶到屏幕最右列；
      // 横向到历史 pane 右缘 = 内部分隔竖线前一列）
      const ruleRow = rows.find((t) => t.includes("╌"))!;
      assert.ok(ruleRow !== undefined, `${tag}: 回合分隔线可见`);
      const ruleTarget =
        g.mode === "vertical" ? size.cols - 1 : (g.innerDividerCol ?? 0) - 1;
      const ruleInk = rightMostInk(
        ruleRow.replace(/[^╌]/gu, " "),
        0,
        size.cols,
      );
      assert.equal(ruleInk, ruleTarget, `${tag}: 回合分隔线铺满 pane`);
    }
  }
});

test("文字右缘留白：文字不落在留白列（长文本铺满到排版右缘为止）", () => {
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
      // 文字恰好铺到「文字排版宽」的右缘（证明宽口径按文字宽，而不是 pane 宽）
      assert.equal(
        Math.max(...histRows.map((t) => rightMostInk(t, r.histFrom, r.histTo))),
        r.histFrom + g.dialogueTextW - 1,
        `${tag}: 历史文字铺到排版右缘`,
      );
      // 活动区按可视高截取尾部（且常被截断），只要求不越界、且有内容可见
      const actMax = Math.max(
        ...actRows.map((t) => rightMostInk(t, r.actFrom, r.actTo)),
      );
      assert.ok(
        actMax <= r.actFrom + g.activityTextW - 1,
        `${tag}: 活动文字不越排版右缘（实际 ${actMax}）`,
      );
      assert.ok(actMax > r.actFrom, `${tag}: 活动区有可见文本`);
      // 留白列（文字宽之后的区域正文列）不得有任何字符
      const reserved = [
        ...histRows.flatMap((t) =>
          inkCols(t, r.histFrom + g.dialogueTextW, r.histTo),
        ),
        ...actRows.flatMap((t) =>
          inkCols(t, r.actFrom + g.activityTextW, r.actTo),
        ),
      ];
      assert.deepEqual(reserved, [], `${tag}: 留白列无字符（防整行溢出）`);
    }
  }
});

test("文字右缘留白：窄终端下文字宽至少 1 列（不出现负宽）", () => {
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
