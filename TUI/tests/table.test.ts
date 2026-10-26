// tests/table.test.ts — markdown 表格解析与列宽算法（SPEC.md §3.2）
//
// 口径：本文件只测**解析与算法**（`splitCells` / `isTableStart` / `parseTableAt` /
// `fitCols`）——表格渲染（拼盒、列对齐、网格线、窄宽回退）已全部落在新流水线的
// §5 measure（`grid` pass + `fitCols`）与 §6 flatten，由 `pipeline-measure` /
// `pipeline-flatten` / `pipeline-parse` 覆盖。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitCols,
  isTableStart,
  parseTableAt,
  splitCells,
} from "../src/app/layout/table.ts";
import type { TableSpec } from "../src/app/layout/table.ts";

const parse = (table: readonly string[]): TableSpec => {
  const parsed = parseTableAt(table, 0);
  assert.ok(parsed, "应识别为表格：" + JSON.stringify(table));
  return parsed.table;
};

// ---------------- 解析 ----------------

test("splitCells: 剥外框、去空白、保留转义竖线、无竖线返回 null", () => {
  assert.deepEqual(splitCells("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitCells("a | b"), ["a", "b"]);
  assert.deepEqual(splitCells("  | 甲 | 乙  |  "), ["甲", "乙"]);
  assert.deepEqual(splitCells("| a \\| b | c |"), ["a \\| b", "c"]);
  assert.deepEqual(splitCells("| a | | c |"), ["a", "", "c"]);
  assert.equal(splitCells("没有竖线"), null);
  assert.equal(splitCells(""), null);
});

test("isTableStart: 分隔行每格 :?-+:?；列数只许少（容错）、不许多", () => {
  assert.equal(isTableStart("| a | b |", "| --- | --- |"), true);
  assert.equal(
    isTableStart("| a | b |", "| --- |"),
    true,
    "分隔行短于表头 → 仍判为表格（缺列左对齐，2026-10-23 容错）",
  );
  assert.equal(
    isTableStart("| a | b |", "| --- | --- | --- |"),
    false,
    "分隔行多于表头 → 表头缺格、语义不明，拒绝",
  );
  assert.equal(isTableStart("| a | b |", "| --- | -- |"), true, "两列都合法");
  assert.equal(isTableStart("| a | b |", "| --- | :: |"), false, "非法分隔格");
  assert.equal(isTableStart("普通行", "| --- |"), false, "表头无竖线");
  assert.equal(isTableStart("| a | b |", "---"), false, "分隔行无竖线");
});

test("parseTableAt: 分隔行短于表头 → 按表头列数成表，缺列左对齐", () => {
  const { table } = parseTableAt(
    [
      "| 阶段 | 现象 | 结论 | 备注 |",
      "| --- | --- |",
      "| 解析 | 切分 | 一致 | 无 |",
    ],
    0,
  )!;
  assert.equal(table.header.length, 4);
  assert.deepEqual(table.aligns, ["left", "left", "left", "left"]);
  assert.deepEqual(table.rows[0], ["解析", "切分", "一致", "无"]);
});

test("parseTableAt: 表头/对齐/数据行，缺格补空、多格忽略，遇非表格行终止", () => {
  const { table, end } = parseTableAt(
    [
      "| 名称 | 说明 | 数量 |",
      "| :--- | :---: | ---: |",
      "| a | 甲 | 1 |",
      "| b | 乙 |",
      "| c | 丙 | 3 | 多余 |",
      "",
      "| x | y |",
    ],
    0,
  )!;
  assert.deepEqual(table.header, ["名称", "说明", "数量"]);
  assert.deepEqual(table.aligns, ["left", "center", "right"]);
  assert.deepEqual(table.rows, [
    ["a", "甲", "1"],
    ["b", "乙", ""],
    ["c", "丙", "3"],
  ]);
  assert.equal(end, 5, "空行终止表格（后续行不消费）");
});

test("parseTableAt: 非表格返回 null（普通文本 / 单行分隔线 / 缺行）", () => {
  assert.equal(parseTableAt(["普通文本", "| --- |"], 0), null);
  assert.equal(parseTableAt(["| a |"], 0), null, "缺分隔行");
  assert.equal(
    parseTableAt(["| a |", "| --- |"], 0) !== null,
    true,
    "单列表格合法",
  );
  assert.equal(parseTableAt(["---", "---"], 0), null, "纯分隔线非表格");
});

// ---------------- 构建：列宽与对齐 ----------------

// ---------------- 列宽算法（新链 measure 的 grid pass 复用） ----------------

test("fitCols：自然宽合计放得下 → 原样返回（不压缩）", () => {
  assert.deepEqual(fitCols([4, 6, 3], 20), [4, 6, 3]);
});

test("fitCols：放不下 → 水位法只压超宽列，窄列保住自然宽", () => {
  // 自然宽 [3, 20, 3]、可用 14：3+3=6 保底，剩余 8 给中间列（水位 ≥ 8）
  const out = fitCols([3, 20, 3], 14);
  assert.ok(out !== null, "可压出结果");
  assert.equal(out![0], 3, "窄列不压");
  assert.equal(out![2], 3, "窄列不压");
  assert.equal(out![1], 8, "超宽列压到余量");
  assert.equal(
    out!.reduce((a, b) => a + b, 0),
    14,
    "合计 = 可用宽",
  );
});

test("fitCols：连每列最小宽都放不下 → null（调用方退回普通文本行）", () => {
  assert.equal(fitCols([10, 10, 10], 5), null);
});
