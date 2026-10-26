// tests/activity-bar.test.ts — #1 活动区正文左缘 `┃` 颜色条连续性
//
// 契约：同一 assistant 正文块内的空行（段间空行）也带 `┃` 竖线（与历史区同口径）；
// 块首/块尾的空行不挂竖线（保留 P5 对宿主每步补发 "\n\n" 锚点的抑制）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderBuffer } from "./helpers/renderBuffer.ts";
import { rowText } from "./helpers/rowText.ts";
import type { HistoryRow } from "../src/app/state.ts";

const a = (text: string, final = false): HistoryRow => ({
  text,
  kind: "assistant",
  final,
});

/** 活动区渲染行文本（新链：缓冲行 → 节缓存 → pipelineContent） */
function activityRows(buf: HistoryRow[], width = 40): string[] {
  return renderBuffer(buf, { dialogueTextW: width }).activity.map((r) =>
    rowText(r),
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
