// tests/activity-bar.test.ts — #1 活动区正文左缘 `┃` 颜色条连续性
//
// 契约：同一 assistant 正文块内的空行（段间空行）也带 `┃` 竖线（与历史区同口径）；
// 块首/块尾的空行不挂竖线（保留 P5 对宿主每步补发 "\n\n" 锚点的抑制）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBox } from "../src/app/layout/build-box.ts";
import { fillBoxTree } from "../src/app/layout/fill.ts";
import type { BufferLine } from "../src/app/state.ts";

const a = (text: string, final = false): BufferLine => ({
  text,
  kind: "assistant",
  final,
});

function activityRows(buf: BufferLine[], width = 40): string[] {
  const built = buildBox(buf, {});
  return fillBoxTree(built.panes.activity, 20, width).map((r) =>
    r.segments.map((g) => g.text).join(""),
  );
}

test("#1 活动区：块内空行也带 `┃`（颜色条不断口）", () => {
  const rows = activityRows([a("第一段"), a(""), a("第二段")]);
  assert.ok(
    rows.some((r) => r.trim() === "┃"),
    `块内空行应带 ┃：${JSON.stringify(rows)}`,
  );
  // 有内容的两行同样带竖线（连续性成立）
  for (const text of ["第一段", "第二段"]) {
    const row = rows.find((r) => r.includes(text));
    assert.ok(row !== undefined && row.includes("┃"), `${text} 行带 ┃`);
  }
});

test("#1 活动区：块尾空行不挂竖线（不回归 P5 锚点抑制）", () => {
  const rows = activityRows([a("第一段"), a("")]);
  assert.ok(
    !rows.some((r) => r.trim() === "┃"),
    `块尾空行不应带 ┃：${JSON.stringify(rows)}`,
  );
});
