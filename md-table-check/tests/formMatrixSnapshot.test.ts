/**
 * 形态矩阵快照（任务 B「漏检形态筛查」的逐形态结论, 由一次性核对矩阵转正, 2026-10-16）:
 * 一次性跑完 19 个形态, 把 `checkTables` 的判定结果整体固定下来 —— 任何形态的报 / 不报结论或
 * 行号 / 列数发生漂移, 本文件的断言就会变红并直接显示差异。
 *
 * 快照格式（每行一条）: `表N 行M | L{表头行}:期望{列数}[L{行号}/{角色}={实际列数}…]`;
 * 无问题表时为 `表0 行0 | —`。角色 `delim` = 分隔行、`row` = 数据行。
 *
 * 形态编号沿用 `md-table-check/docs/BACKLOG.md` 的「待查形态」; 裁定与证据见追踪文档
 * `docs/implementation/2026-10-16-three-surface-text-consistency.md` 任务 B 的 S2–S4 与「决策」。
 * 快照含义: 「已裁定不修」的两项（行内代码竖线多报一处、表头与分隔行间空行不报）也在其中, 属有意固定。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTables, renderFeedback } from "../src/checker.ts";

/** 判定结果 → 快照串 */
function snapshot(text: string): string {
  const result = checkTables(text);
  if (result.tables.length === 0) return "表0 行0 | —";
  const tables = result.tables
    .map((table) => {
      const mismatches =
        table.mismatches.length === 0
          ? "—"
          : table.mismatches
              .map((item) => `L${item.line}/${item.role}=${item.actual}`)
              .join(",");
      return `L${table.headerLine}:期望${table.expected}[${mismatches}]`;
    })
    .join(" ");
  return `表${result.tableTotal} 行${result.lineTotal} | ${tables}`;
}

const cases: [string, string, string][] = [
  [
    "① 仅数据行列数不符",
    "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |",
    "表1 行1 | L1:期望2[L3/row=3]",
  ],
  [
    "①+② 分隔行与数据行同时不符",
    "| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 | 4 |",
    "表1 行2 | L1:期望3[L2/delim=2,L3/row=4]",
  ],
  [
    "② 同一回复多张表（隔行）",
    "| a | b |\n| --- | --- |\n| 1 |\n中间说明\n| x | y | z |\n| --- |\n| 1 | 2 | 3 |",
    "表2 行2 | L1:期望2[L3/row=1] L5:期望3[L6/delim=1]",
  ],
  [
    "② 相邻两表（无间隔）",
    "| a | b |\n| --- | --- |\n| 1 |\n| x | y |\n| --- | ---\n| 2 |",
    "表1 行2 | L1:期望2[L3/row=1,L6/row=1]",
  ],
  [
    "③ 表格在回复末尾（无尾随空行）",
    "说明在前。\n| a | b |\n| --- | --- |\n| 1 |",
    "表1 行1 | L2:期望2[L4/row=1]",
  ],
  [
    "④ 转义竖线（列数一致）",
    "| a \\| b | c |\n| --- | --- |\n| 1 | 2 |",
    "表0 行0 | —",
  ],
  [
    "④ 行内代码含竖线（已裁定: 多报一处）",
    "| `a | b` | c | d |\n| --- | --- | --- |\n| 1 | 2 | 3 |",
    "表1 行2 | L1:期望4[L2/delim=3,L3/row=3]",
  ],
  [
    "⑤ 围栏代码块内（应不报）",
    "```\n| a | b |\n| --- | --- |\n```",
    "表0 行0 | —",
  ],
  [
    "⑤ 闭栅后的真表格仍检查",
    "```\n| a | b |\n| --- |\n```\n| a | b |\n| --- |",
    "表1 行1 | L5:期望2[L6/delim=1]",
  ],
  [
    "⑥ 分隔行带对齐标记（列数一致）",
    "| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |",
    "表0 行0 | —",
  ],
  [
    "⑦ 表头与分隔行一致但少于数据行",
    "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |",
    "表1 行1 | L1:期望2[L3/row=3]",
  ],
  [
    "⑧ 分隔行不足 2 单元格",
    "| a | b |\n| --- |\n| 1 | 2 |",
    "表1 行1 | L1:期望2[L2/delim=1]",
  ],
  [
    "⑧ 单列表三态之一（列数一致, 不报）",
    "| a |\n| --- |\n| 1 |",
    "表0 行0 | —",
  ],
  [
    "⑧ 单列表数据行多格",
    "| a |\n| --- |\n| 1 | 2 |",
    "表1 行1 | L1:期望1[L3/row=2]",
  ],
  [
    "附 表头与分隔行之间有空行（不报）",
    "| a | b |\n\n| --- | --- |\n| 1 | 2 | 3 |",
    "表0 行0 | —",
  ],
  [
    "附 引用块内表格（不报）",
    "> | a | b |\n> | --- | --- |\n> | 1 | 2 | 3 |",
    "表0 行0 | —",
  ],
  [
    "附 列表项内缩进表格（报）",
    "- 项:\n  | a | b |\n  | --- | --- |\n  | 1 | 2 | 3 |",
    "表1 行1 | L2:期望2[L4/row=3]",
  ],
  [
    "附 表格位于回复首行",
    "| a | b |\n| --- | --- |\n| 1 |",
    "表1 行1 | L1:期望2[L3/row=1]",
  ],
  [
    "附加: 提示文案的期望与实际列数",
    "| 包 | 作用 | 状态 |\n| --- | --- |\n| md-logic | 节树 | 已建 | 备注 |",
    "表1 行2 | L1:期望3[L2/delim=2,L3/row=4]",
  ],
];

test("形态矩阵快照: 19 个形态的判定结果与裁定一致", () => {
  for (const [label, text, expected] of cases) {
    assert.equal(snapshot(text), expected, `形态「${label}」的判定发生漂移`);
  }
});

test("形态矩阵快照: 注入提示文案", () => {
  const feedback = renderFeedback(
    "| 包 | 作用 | 状态 |\n| --- | --- |\n| md-logic | 节树 | 已建 | 备注 |",
  );
  assert.equal(
    feedback!.text,
    [
      "[md-table-check] 上一条回复正文里的 markdown 表格列数不一致（本提示只针对回复正文，与仓库文件无关）：",
      "- 表 1（表头在第 1 行）：`| 包 | 作用 | 状态 |` 期望 3 列",
      "  - 第 2 行（分隔行）：2 列",
      "  - 第 3 行（数据行）：4 列",
      "请修正这些表格后，把上一条回复完整重发一次；不要修改仓库里的任何文件或文档。",
    ].join("\n"),
  );
});
