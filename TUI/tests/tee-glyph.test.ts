// tests/tee-glyph.test.ts — 横线交点字形（上下行笔画取并集）
//
// 场景：状态列右边框（上竖线）与状态栏首行的段分隔竖线（下竖线）落在**同一列**时，
// 只按一侧选字会把另一侧切断（水平线上方出现空白、交线断开）→ 必须写 ┼。
// 覆盖：teeGlyph/strokeUp/strokeDown 纯函数 + buildStatusSeparator 的基线路径。
// （#4 起焦点框只强调既有框线、不再覆写字形，原先的"焦点态恢复段分隔"路径已删除。）

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusSeparator, frameGeometry } from "../src/app/layout.ts";
import { rowPlain } from "../src/app/layout/focus-frame.ts";
import {
  teeGlyph,
  strokeDown,
  strokeUp,
} from "../src/app/layout/content-rules.ts";
import { initialState } from "../src/app/state.ts";

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
    buildStatusSeparator(geom, [other, D]),
  );
  assert.equal(plain[D], "┼", "D 列同时有上方状态列边框与下方段分隔竖线 → ┼");
  assert.equal(plain[other], "┬", "普通段分隔列 → ┬");
  assert.equal(plain[0], "─", "其余列为横线");
});
