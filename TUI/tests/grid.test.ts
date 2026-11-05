// TUI/tests/grid.test.ts — 框线网格（布局 #2 阶段 1）：行角色 → 框线字形
//   - 角色判定优先级：横线行 > 回合区行 > 回合分隔行 > 普通行
//   - 分隔竖线列：横线行 `├`（连接）/ 其余 `│`（竖线贯穿）
//   - 右缘框列：**一律不落字形**（null）——2026-11-05 起 `FRAME_RIGHT_COLS = 0`，
//     区域右缘不再保留列、内容铺到屏幕最右列；横线行满宽由 contentSegs 铺满，无需右缘补

//   - 帧内取值口径（buildTopRegion 行内取字形）：D 列随角色变化、右缘框列恒不落字形
//     —— 由帧断言（focus-frame / layout*）逐字节守住

import assert from "node:assert/strict";
import test from "node:test";

import {
  dividerGlyph,
  gridRole,
  rightEdgeGlyph,
  type GridRole,
} from "../src/app/layout/grid.ts";

test("角色判定：横线行 > 回合区行 > 回合分隔行 > 普通行", () => {
  assert.equal(
    gridRole({ borderRow: true, actRow: true, ruleRow: true }),
    "border",
    "横线行优先（回合区分隔行同时是回合区行）",
  );
  assert.equal(
    gridRole({ borderRow: false, actRow: true, ruleRow: true }),
    "activity",
    "回合区行优先于分隔行",
  );
  assert.equal(
    gridRole({ borderRow: false, actRow: false, ruleRow: true }),
    "rule",
  );
  assert.equal(
    gridRole({ borderRow: false, actRow: false, ruleRow: false }),
    "body",
  );
});

test("分隔竖线列字形：横线行 ├（连接），其余 │（竖线贯穿）", () => {
  const glyphs = (["border", "rule", "activity", "body"] as GridRole[]).map(
    dividerGlyph,
  );
  assert.deepEqual(glyphs, ["├", "│", "│", "│"]);
});

test("右缘框列字形：所有行一律不落字形（null）", () => {
  for (const role of ["border", "rule", "activity", "body"] as GridRole[]) {
    assert.equal(rightEdgeGlyph(role), null, `${role} 行右缘不落字形`);
  }
});
