import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_SUMMARY,
  checkTables,
  hasCellPipe,
  renderFeedback,
  splitCells,
} from "../src/checker.ts";

/** 组多行文本（避免模板字符串里的竖线干扰可读性） */
const lines = (...items: string[]): string => items.join("\n");

test("splitCells / hasCellPipe：口径同 TUI（转义不切、剥除首尾空单元格）", () => {
  assert.deepEqual(splitCells("| a | b |"), ["a", "b"]);
  assert.deepEqual(splitCells("a | b"), ["a", "b"]);
  assert.deepEqual(splitCells("| a \\| b | c |"), ["a \\| b", "c"]);
  assert.equal(splitCells("no pipes here"), null);
  assert.equal(splitCells(""), null);
  assert.equal(hasCellPipe("| a |"), true);
  assert.equal(hasCellPipe("a \\| b"), false);
  assert.equal(hasCellPipe("plain"), false);
});

test("分隔行列数少于表头 → 报出（表头行号 / 角色 / 期望与实际列数）", () => {
  const result = checkTables(
    lines("说明：", "| a | b | c |", "| --- | --- |", "| 1 | 2 | 3 |"),
  );
  assert.equal(result.tableTotal, 1);
  assert.equal(result.lineTotal, 1);
  const table = result.tables[0]!;
  assert.equal(table.headerLine, 2, "表头行号 = 1 基");
  assert.equal(table.expected, 3);
  assert.equal(table.mismatchTotal, 1);
  assert.deepEqual(table.mismatches, [{ line: 3, role: "delim", actual: 2 }]);
});

test("分隔行列数多于表头 → 报出", () => {
  const result = checkTables(
    lines("| a | b |", "| --- | --- | --- |", "| 1 | 2 |"),
  );
  assert.equal(result.tableTotal, 1);
  assert.deepEqual(result.tables[0]!.mismatches, [
    { line: 2, role: "delim", actual: 3 },
  ]);
});

test("数据行多格 / 缺格 → 都报出", () => {
  const result = checkTables(
    lines("| a | b |", "| --- | --- |", "| 1 | 2 | 3 |", "| 4 |", "| 5 | 6 |"),
  );
  const table = result.tables[0]!;
  assert.equal(table.mismatchTotal, 2);
  assert.deepEqual(table.mismatches, [
    { line: 3, role: "row", actual: 3 },
    { line: 4, role: "row", actual: 1 },
  ]);
  assert.equal(result.lineTotal, 2);
});

test("列数一致的表格 → 不报（含对齐冒号与无外框竖线写法）", () => {
  assert.equal(
    checkTables(
      lines(
        "| a | b | c |",
        "| :-- | :-: | --: |",
        "| 1 | 2 | 3 |",
        "| 4 | 5 | 6 |",
      ),
    ).tableTotal,
    0,
  );
  assert.equal(checkTables(lines("a | b", "--- | ---", "1 | 2")).tableTotal, 0);
});

test("`\\|` 转义不切分 → 不报", () => {
  assert.equal(
    checkTables(lines("| a \\| b | c |", "| --- | --- |", "| 1 | 2 |"))
      .tableTotal,
    0,
  );
});

test("行首尾空单元格剥除：`| a | b |` 与 `a | b` 同判 → 不报", () => {
  assert.equal(
    checkTables(lines("| a | b |", "--- | ---", "| 1 | 2 |")).tableTotal,
    0,
  );
});

test("围栏代码块内的表格 → 不报（反引号与波浪号两种栅，闭栅后的真表格仍报）", () => {
  const fence = "```";
  const fenceTilde = "~~~";
  assert.equal(
    checkTables(lines("示例：", fence, "| a | b | c |", "| --- | --- |", fence))
      .tableTotal,
    0,
  );
  assert.equal(
    checkTables(lines(fenceTilde, "| a | b |", "| --- |", fenceTilde))
      .tableTotal,
    0,
  );
  const after = checkTables(
    lines(fence, "| a | b |", "| --- |", fence, "| a | b |", "| --- |"),
  );
  assert.equal(after.tableTotal, 1, "闭栅后的表格照常检查");
  assert.equal(after.tables[0]!.headerLine, 5);
});

test("无竖线文本 / 空文本 / 只有 `|` 的行 → 不报", () => {
  assert.equal(checkTables("").tableTotal, 0);
  assert.equal(checkTables("普通段落，没有表格。").tableTotal, 0);
  assert.equal(checkTables(lines("|", "| --- |")).tableTotal, 0);
});

test("分隔行不是分隔格（`| --- | x |`）→ 不构成候选（伪表格不做）", () => {
  assert.equal(
    checkTables(lines("| a | b |", "| --- | x |", "| 1 | 2 |")).tableTotal,
    0,
  );
  assert.equal(
    checkTables(lines("正文 | 带竖线的普通行", "| a | b |")).tableTotal,
    0,
  );
});

test("多表汇总：两张问题表格都在结果里", () => {
  const result = checkTables(
    lines(
      "| a | b |",
      "| --- | --- | --- |",
      "| 1 |",
      "中间说明",
      "| x | y | z |",
      "| --- |",
      "| 1 | 2 | 3 |",
    ),
  );
  assert.equal(result.tableTotal, 2);
  assert.equal(result.tables.length, 2);
  assert.deepEqual(
    result.tables.map((table) => table.headerLine),
    [1, 5],
  );
  assert.equal(result.lineTotal, 3);
});

test("maxTables 裁剪：只列前 N 张，其余进「另有 N 处未列出」", () => {
  const text = lines(
    "| a | b |",
    "| --- | --- |",
    "| 1 |",
    "中间说明",
    "| x | y |",
    "| --- |",
    "| 1 | 2 |",
  );
  const result = checkTables(text, { maxTables: 1 });
  assert.equal(result.tableTotal, 2);
  assert.equal(result.tables.length, 1);
  const feedback = renderFeedback(text, { maxTables: 1 });
  assert.match(feedback!.text, /另有 1 处不一致未列出。/);
});

test("maxRowsPerTable 裁剪：只列前 N 行，mismatchTotal 记全量", () => {
  const text = lines(
    "| a | b |",
    "| --- | --- | --- |",
    "| 1 |",
    "| 2 | 3 | 4 |",
    "| 5 |",
  );
  const result = checkTables(text, { maxRowsPerTable: 1 });
  const table = result.tables[0]!;
  assert.equal(table.mismatches.length, 1);
  assert.equal(table.mismatchTotal, 4);
  assert.equal(result.lineTotal, 4);
  const feedback = renderFeedback(text, { maxRowsPerTable: 1 });
  assert.match(feedback!.text, /另有 3 处不一致未列出。/);
});

test("表头行号：前置文本再多也按 1 基计数", () => {
  const result = checkTables(
    lines("1", "2", "3", "4", "5", "| a | b |", "| --- |"),
  );
  assert.equal(result.tables[0]!.headerLine, 6);
});

test("renderFeedback：无问题 → null；有问题 → 汇总提示 + 三条硬口径文案", () => {
  assert.equal(renderFeedback(lines("| a | b |", "| --- | --- |")), null);
  const feedback = renderFeedback(
    lines(
      "| 包 | 作用 | 状态 |",
      "| --- | --- |",
      "| md-logic | 节树 | 已建 | 备注 |",
    ),
  );
  assert.notEqual(feedback, null);
  assert.equal(feedback!.summary, FEEDBACK_SUMMARY);
  const text = feedback!.text;
  assert.match(text, /只针对回复正文/, "声明范围");
  assert.match(text, /表头在第 1 行/, "表头行号");
  assert.match(text, /期望 3 列/, "期望列数");
  assert.match(text, /第 2 行（分隔行）：2 列/);
  assert.match(text, /第 3 行（数据行）：4 列/);
  assert.match(text, /完整重发一次/, "要求更正后重新回复");
  assert.match(text, /不要修改仓库里的任何文件或文档/, "不要改仓库文件");
  assert.doesNotMatch(text, /另有/, "未超上限时不出「另有」行");
});

test("表头摘录：超长截断并加省略号", () => {
  const header = `| ${"长".repeat(80)} | b |`;
  const feedback = renderFeedback(lines(header, "| --- |"), {
    headerExcerptLimit: 12,
  });
  assert.match(feedback!.text, /长{10}…/);
});

test("选项非法值回退缺省（负数 / NaN 不抛）", () => {
  const text = lines("| a | b |", "| --- |");
  assert.equal(checkTables(text, { maxTables: -1 }).tables.length, 1);
  assert.equal(
    checkTables(text, { maxRowsPerTable: Number.NaN }).tables[0]!.mismatches
      .length,
    1,
  );
  assert.equal(renderFeedback(text, { headerExcerptLimit: -5 }) !== null, true);
});
