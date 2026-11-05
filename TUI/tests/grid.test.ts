// TUI/tests/grid.test.ts — 框线网格（布局 #2 阶段 1）：行角色 → 框线字形
//   - 角色判定优先级：横线行 > 回合区行 > 回合分隔行 > 普通行
//   - 分隔竖线列：横线行 `├`（连接）/ 其余 `│`（竖线贯穿）
//   - 右缘框列：横线行 `─` / 其余行（回合分隔行、回合区行、普通行）**不落字形**（null）
//      —— 2026-11-05 起普通行与回合分隔行不再空白占位（上下排列时会话区右侧多余的
//     空白列被消除；该空白非框线字形、聚焦时本就无法被 focusFrame 变亮）
//   - 帧内取值口径（buildTopRegion 行内取字形）：D 列与右缘框列随角色变化、
//     回合区行不补白也不落右缘字形 —— 由帧断言（focus-frame / layout*）逐字节守住

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

test("右缘框列字形：横线行 ─，其余行不落字形（null）", () => {
  assert.equal(rightEdgeGlyph("border"), "─", "横线行铺到框列");
  assert.equal(
    rightEdgeGlyph("rule"),
    null,
    "回合分隔行只到正文右缘，不补 ╌ 也不占位到框列",
  );
  assert.equal(rightEdgeGlyph("activity"), null, "回合区行右缘不落字形");
  assert.equal(
    rightEdgeGlyph("body"),
    null,
    "普通行右缘不落字形（无空白占位）",
  );
});
