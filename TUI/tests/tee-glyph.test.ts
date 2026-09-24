// tests/tee-glyph.test.ts — 横线交点字形（上下行笔画取并集）
//
// 场景：状态列右边框（上竖线）与状态栏首行的段分隔竖线（下竖线）落在**同一列**时，
// 只按一侧选字会把另一侧切断（水平线上方出现空白、交线断开）→ 必须写 ┼。
// 覆盖基线与焦点两条路径：buildStatusSeparator（灰线基线）与 focusFrame 的
// statusSepRow 段分隔恢复。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusSeparator, frameGeometry } from "../src/app/layout.ts";
import {
  focusFrame,
  rowPlain,
  setCell,
} from "../src/app/layout/focus-frame.ts";
import {
  teeGlyph,
  strokeDown,
  strokeUp,
} from "../src/app/layout/content-rules.ts";
import { initialState } from "../src/app/state.ts";
import type { FrameRow } from "../src/renderer/screen.ts";
import type { PaneId, Rect } from "../src/app/layout/box.ts";

const SIZE = { rows: 24, cols: 80 };
const geom = frameGeometry(initialState(undefined), SIZE);

test("teeGlyph / strokeUp / strokeDown：按上下笔画取并集字形", () => {
  assert.equal(teeGlyph(false, true), "┬", "仅下 → ┬");
  assert.equal(teeGlyph(true, false), "┴", "仅上 → ┴");
  assert.equal(teeGlyph(true, true), "┼", "上下都有 → ┼");
  assert.ok(strokeUp("│") && strokeUp("┴") && strokeUp("┘") && strokeUp("├"));
  assert.ok(
    !strokeUp("┬") && !strokeUp("─") && !strokeUp(" ") && !strokeUp("┌"),
  );
  assert.ok(
    strokeDown("│") && strokeDown("┬") && strokeDown("┌") && strokeDown("┤"),
  );
  assert.ok(
    !strokeDown("┴") &&
      !strokeDown("─") &&
      !strokeDown(" ") &&
      !strokeDown("┘"),
  );
});

test("buildStatusSeparator：段分隔竖线落在 D 列时写 ┼（不切断状态列右边框）", () => {
  const D = geom.dividerCol;
  const other = Math.max(2, D - 4);
  const plain = rowPlain(
    buildStatusSeparator(geom, "dark", "none", [other, D]),
  );
  assert.equal(plain[D], "┼", "D 列同时有上方状态列边框与下方段分隔竖线 → ┼");
  assert.equal(plain[other], "┬", "普通段分隔列 → ┬");
  assert.equal(plain[0], "─", "其余列为横线");
});

test("focusFrame：焦点态恢复段分隔时同样按上下行取并集（D 列 → ┼）", () => {
  const D = geom.dividerCol;
  const rows: FrameRow[] = Array.from({ length: 8 }, () => ({
    segments: [{ text: " ".repeat(SIZE.cols) }],
  }));
  // activity 矩形底行 = 状态区上方分隔行（statusSepRow）：上一行在 D 列有状态列右边框
  // 竖线，下一行（状态栏首行）在 D 列有段分隔竖线
  const bottom = 5;
  setCell(rows[bottom - 1]!, D, "│");
  setCell(rows[bottom + 1]!, D, "│");
  const rect = { x: D, y: 1, w: SIZE.cols - D, h: 5 };
  const rects = new Map<PaneId, Rect>([
    ["history", { ...rect, h: 3 }],
    ["activity", rect],
    ["status", { x: 0, y: 0, w: D, h: 7 }],
  ]);
  focusFrame(
    {
      themeId: "dark",
      focusedPanel: "activity",
      statusSepRow: bottom,
      statusSeamCols: [D],
    },
    rects,
    rows,
  );
  assert.equal(
    rowPlain(rows[bottom]!)[D],
    "┼",
    "焦点态 D 列 → ┼（不断开上方竖线）",
  );
});
