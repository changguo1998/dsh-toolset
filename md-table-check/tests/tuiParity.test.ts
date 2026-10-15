/**
 * 与 TUI 判定口径的互证（条目验收 ②）：同一文本在 TUI 退回纯文本（或丢格），本插件同时报出。
 *
 * TUI 源码经动态 `import` 加载 —— 本包不依赖 TUI（包边界干净），源码不在时（独立分发）跳过本文件
 * 的用例；`node --experimental-transform-types` 下可直接加载 `.ts`（本 worktree 实测）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTables, splitCells } from "../src/checker.ts";

/** TUI 表格模块的结构面（只声明互证用到的两个函数）。 */
interface TuiTable {
  splitCells(line: string): string[] | null;
  isTableStart(header: string, delimiter: string): boolean;
}

let tui: TuiTable | null = null;
try {
  tui = (await import(
    new URL("../../TUI/src/app/layout/table.ts", import.meta.url).href
  )) as TuiTable;
} catch {
  tui = null;
}

const skip: boolean | string =
  tui === null ? "TUI 源码不在（独立分发场景），跳过互证" : false;

test(
  "互证 ①：splitCells 逐条同口径（转义 / 首尾空单元格 / 无竖线）",
  { skip },
  () => {
    const fixtures = [
      "| a | b | c |",
      "| --- | --- | --- |",
      "a | b",
      "| a \\| b | c |",
      "|  |  |",
      "|",
      "no pipes here",
      "",
    ];
    for (const line of fixtures) {
      assert.deepEqual(
        splitCells(line),
        tui!.splitCells(line),
        `切分口径应一致：${JSON.stringify(line)}`,
      );
    }
  },
);

test("互证 ②：TUI 不认作表格（整表退回纯文本）⇔ 本插件报出", { skip }, () => {
  const brokenPairs = [
    ["| a | b | c |", "| --- | --- |"],
    ["| a | b |", "| --- | --- | --- |"],
    ["| a | b |", "| --- |"],
  ];
  for (const [header, delim] of brokenPairs) {
    assert.equal(
      tui!.isTableStart(header!, delim!),
      false,
      `TUI 应不认作表格：${header} / ${delim}`,
    );
    const result = checkTables([header, delim].join("\n"));
    assert.equal(result.tableTotal, 1, `本插件应报出：${header} / ${delim}`);
    assert.equal(result.tables[0]!.expected, tui!.splitCells(header!)!.length);
    assert.equal(
      result.tables[0]!.mismatches[0]!.actual,
      tui!.splitCells(delim!)!.length,
    );
  }
});

test("互证 ③：列数一致 → TUI 认表且本插件不报", { skip }, () => {
  const pairs = [
    ["| a | b |", "| --- | --- |"],
    ["| a | b | c |", "| :-- | :-: | --: |"],
    ["a | b", "--- | ---"],
  ];
  for (const [header, delim] of pairs) {
    assert.equal(
      tui!.isTableStart(header!, delim!),
      true,
      `TUI 应认表：${header}`,
    );
    // 数据行按表头列数生成，保证列数一致
    const cols = tui!.splitCells(header!)!.length;
    const row = `| ${Array.from({ length: cols }, (_, j) => String(j + 1)).join(" | ")} |`;
    assert.equal(
      checkTables([header, delim, row].join("\n")).tableTotal,
      0,
      `本插件不应报出：${header}`,
    );
  }
});

test(
  "互证 ④：TUI 容忍但丢格的数据行（多格 / 缺格）→ 本插件报出",
  { skip },
  () => {
    const text = ["| a | b |", "| --- | --- |", "| 1 | 2 | 3 |", "| 4 |"].join(
      "\n",
    );
    assert.equal(
      tui!.isTableStart("| a | b |", "| --- | --- |"),
      true,
      "TUI 仍认表",
    );
    const result = checkTables(text);
    assert.equal(result.tableTotal, 1);
    assert.deepEqual(
      result.tables[0]!.mismatches.map((item) => item.actual),
      [3, 1],
    );
  },
);
