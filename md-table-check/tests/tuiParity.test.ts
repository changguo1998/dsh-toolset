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
  parseTableAt(
    lines: readonly string[],
    start: number,
  ): { table: { header: string[]; rows: string[][] }; end: number } | null;
}

let tui: TuiTable | null = null;
try {
  tui = (await import(
    new URL("../../TUI/src/app/layout/table.ts", import.meta.url).href
  )) as TuiTable;
} catch {
  tui = null;
}

/**
 * 围栏守卫用的正则直接取 TUI 的**真实常量**（`TUI/src/app/layout/markdown.ts:775` 的 `FENCE_RE`；
 * `build-box.ts:696` 内联的是同一个正则但没有 export，无法 import，故取导出侧的真源）。
 * 仍走动态 `import`：静态 import 会把 TUI 源码拉进本包的 TS program（越出 rootDir）并在 build 时
 * 把产物落到 `TUI/src/`；这是「复刻守卫」能走到的最强形态 —— 正则与 TUI 同源，只有
 * `inFence = !inFence` 的翻转逻辑按 `build-box.ts:702-708` 的语义原样重述。
 */
let tuiFenceRe: RegExp | null = null;
try {
  const markdown = (await import(
    new URL("../../TUI/src/app/layout/markdown.ts", import.meta.url).href
  )) as { FENCE_RE?: RegExp };
  tuiFenceRe = markdown.FENCE_RE ?? null;
} catch {
  tuiFenceRe = null;
}

const skip: boolean | string =
  tui === null || tuiFenceRe === null
    ? "TUI 源码不在（独立分发场景），跳过互证"
    : false;

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
      "a\\",
      "| a\\",
      "\\",
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

// 2026-10-23：TUI 改为「分隔行列数只许少不许多、缺列按左对齐补齐」（TUI/docs/SPEC.md §3.2 / §15.6），
// 少列不再让整表退回纯文本——本互证的前提随之失效，这正是本插件下线的理由。此处按新口径断言，
// 留作「插件会为 TUI 本就能渲染的表格报噪音」的证据。
test(
  "互证 ②（新口径）：少列 TUI 认表但仍被本插件报出, 多列 TUI 仍不认",
  { skip },
  () => {
    const pairs: [string, string, boolean][] = [
      ["| a | b | c |", "| --- | --- |", true],
      ["| a | b |", "| --- | --- | --- |", false],
      ["| a | b |", "| --- |", true],
    ];
    for (const [header, delim, tuiRenders] of pairs) {
      assert.equal(
        tui!.isTableStart(header!, delim!),
        tuiRenders,
        `TUI 认表应为 ${tuiRenders}：${header} / ${delim}`,
      );
      const result = checkTables([header, delim].join("\n"));
      assert.equal(result.tableTotal, 1, `本插件应报出：${header} / ${delim}`);
      assert.equal(
        result.tables[0]!.expected,
        tui!.splitCells(header!)!.length,
      );
      assert.equal(
        result.tables[0]!.mismatches[0]!.actual,
        tui!.splitCells(delim!)!.length,
      );
    }
  },
);

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

test(
  "互证 ⑤：成表判据与不等时的走向（插件报出 ⇔ TUI 退回纯文本 / 丢格）",
  { skip },
  () => {
    // 围栏守卫按 TUI 渲染入口口径: build-box.ts 的 !inFence + isTableStart 预筛 + parseTableAt;
    // 栅栏判定用 TUI 的真实 `FENCE_RE`（正则同源）, 翻转为 `inFence = !inFence`（build-box.ts:702-708）
    const fenceRe = tuiFenceRe!;
    const rendersAsTable = (
      text: string,
    ): { table: unknown; lostCells: number } => {
      const lines = text.split("\n");
      let inFence = false;
      for (let i = 0; i + 1 < lines.length; i++) {
        const fence = fenceRe.exec(lines[i]!);
        if (fence !== null) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        if (!tui!.isTableStart(lines[i]!, lines[i + 1]!)) continue;
        const parsed = tui!.parseTableAt(lines, i);
        if (parsed === null) continue;
        let lostCells = 0;
        for (let j = i + 2; j < parsed.end; j++) {
          lostCells += Math.abs(
            (tui!.splitCells(lines[j]!) ?? []).length -
              parsed.table.header.length,
          );
        }
        return { table: parsed.table, lostCells };
      }
      return { table: null, lostCells: 0 };
    };
    const cases: [string, string, { reports: boolean; renders: boolean }][] = [
      [
        "列数一致",
        "| a | b |\n| --- | --- |\n| 1 | 2 |",
        { reports: false, renders: true },
      ],
      [
        "分隔行少 1 列（2026-10-23 起 TUI 容错：仍被本插件报出, 属噪音）",
        "| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |",
        { reports: true, renders: true },
      ],
      [
        "数据行多 1 格",
        "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |",
        { reports: true, renders: true },
      ],
      [
        "围栏内坏表",
        "```\n| a | b |\n| --- | --- |\n```",
        { reports: false, renders: false },
      ],
      [
        "围栏混用标记（``` 开 / ~~~ 闭）后的坏表（少列, 2026-10-23 起 TUI 认表）",
        "```\n| a | b |\n| --- |\n~~~\n| a | b |\n| --- |",
        { reports: true, renders: true },
      ],
      [
        "围栏混用标记后的好表（两侧都认闭栅已闭合）",
        "```\n| a | b |\n| --- |\n~~~\n| a | b |\n| --- | --- |",
        { reports: false, renders: true },
      ],
      [
        "引用块内表格",
        "> | a | b |\n> | --- | --- |\n> | 1 | 2 | 3 |",
        { reports: false, renders: false },
      ],
      [
        "表头与分隔行间空行",
        "| a | b |\n\n| --- | --- |\n| 1 | 2 | 3 |",
        { reports: false, renders: false },
      ],
      [
        "伪表格（缺分隔行）",
        "正文 | 带竖线\n| a | b |",
        { reports: false, renders: false },
      ],
    ];
    for (const [label, text, expected] of cases) {
      assert.equal(
        checkTables(text).tableTotal > 0,
        expected.reports,
        `插件应 ${expected.reports ? "报出" : "不报"}：${label}`,
      );
      assert.equal(
        rendersAsTable(text).table !== null,
        expected.renders,
        `TUI 应 ${expected.renders ? "认表" : "退回纯文本"}：${label}`,
      );
    }
    assert.equal(
      rendersAsTable("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |").lostCells,
      1,
      "TUI 丢格计数",
    );
  },
);
