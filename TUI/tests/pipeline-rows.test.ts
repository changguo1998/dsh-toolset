// tests/pipeline-rows.test.ts — 六步流水线第 4 步「行数表 + 位置模型」的契约
//
// 契约（追踪文档「行数表」「滚动位置模型」）：
// ① 前缀和与二分定位：总行数、第 N 行在哪段、段内第几行；
// ② 段内容变只改该段；宽度变 = 全量重算（调用方重建表）；
// ③ 偏移 = 0（贴底）→ 新增行后重算索引；偏移 ≠ 0 → 索引不动；
// ④ 上方插入行 / 宽度变化 → 按「段 + 段内偏移」换算，换算不出退回贴底。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  afterContentChange,
  appendSegment,
  atBottom,
  createLineTable,
  offsetOf,
  remap,
  rowInSegment,
  segmentAt,
  topIndex,
  totalLines,
  withSegmentCount,
} from "../src/app/layout/pipeline/rows.ts";

test("① 前缀和与定位：总行数、段定位、段内偏移", () => {
  const table = createLineTable([3, 0, 4, 1]);
  assert.equal(totalLines(table), 8);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map((index) => segmentAt(table, index)),
    [0, 0, 0, 2, 2, 2, 2, 3],
    "空段不占行（段 1 被跳过）",
  );
  assert.deepEqual(
    [0, 2, 3, 7].map((index) => rowInSegment(table, index)),
    [0, 2, 0, 0],
  );
  assert.equal(segmentAt(table, -1), -1);
  assert.equal(segmentAt(table, 8), 4, "越界上界 = 段数");
  assert.equal(rowInSegment(table, 8), -1);
});

test("② 段内容变只改该段；追加段只增前缀和", () => {
  const table = createLineTable([2, 5]);
  assert.equal(totalLines(withSegmentCount(table, 0, 4)), 9);
  assert.equal(totalLines(withSegmentCount(table, 5, 3)), 7, "越界段不改");
  assert.equal(totalLines(appendSegment(table, 3)), 10);
});

test("③ 位置模型：贴底重算索引，非贴底索引不动", () => {
  const table = createLineTable([10, 10]);
  // 可视 5 行：总 20 → 贴底索引 15
  assert.deepEqual(atBottom(table, 5), { offset: 0, index: 15 });
  assert.equal(topIndex(table, 5, 3), 12);
  assert.equal(offsetOf(table, 5, 12), 3);
  assert.equal(offsetOf(table, 5, topIndex(table, 5, 3)), 3, "互换一致");

  // 贴底时新增 4 行 → 仍贴底（索引跟着新总行数走）
  const taller = appendSegment(table, 4);
  assert.deepEqual(afterContentChange(taller, 5, { offset: 0, index: 15 }), {
    offset: 0,
    index: 19,
  });

  // 非贴底：总行数变大，索引不动（画面内容不动），偏移随之变大
  const shifted = afterContentChange(taller, 5, { offset: 5, index: 10 });
  assert.equal(shifted.index, 10, "索引不动");
  assert.equal(shifted.offset, 9, "偏移随总行数一起变大");
});

test("③ 行数变少时索引与偏移都 clamp 到可视范围", () => {
  const table = createLineTable([3]);
  const position = afterContentChange(table, 5, { offset: 0, index: 40 });
  assert.deepEqual(
    position,
    { offset: 0, index: 0 },
    "总行数少于可视行 → 索引 0",
  );
  assert.equal(topIndex(table, 5, 99), 0);
});

test("④ 上方插入行 / 宽度变化：按「段 + 段内偏移」换算一次", () => {
  const before = createLineTable([4, 4, 4]);
  const after = createLineTable([7, 4, 4]); // 第一段变高（上方插入 3 行）
  const previous = { offset: 3, index: 8 }; // 旧索引 8 → 段 2 内第 1 行
  const remapped = remap(
    after,
    3,
    previous,
    (index) => ({
      segment: segmentAt(before, index),
      row: rowInSegment(before, index),
    }),
    (segment, row) => (after.prefix[segment] ?? 0) + row,
  );
  assert.equal(
    remapped.index,
    11,
    "同一内容行在新表里的索引（段 2 起点 11 + 0）",
  );
  assert.equal(remapped.offset, offsetOf(after, 3, 11));
  // 换算超出可视范围 → clamp 到最大索引（不能滚过结尾）
  assert.equal(
    remap(
      after,
      5,
      previous,
      () => ({ segment: 2, row: 0 }),
      () => 11,
    ).index,
    10,
  );

  // 换算不出 → 退回贴底
  assert.deepEqual(
    remap(
      after,
      3,
      previous,
      () => undefined,
      () => 0,
    ),
    atBottom(after, 3),
  );
  assert.deepEqual(
    remap(
      after,
      3,
      previous,
      () => ({ segment: 9, row: 0 }),
      () => undefined,
    ),
    atBottom(after, 3),
  );
});
