// tests/table.test.ts — markdown 表格解析与构建期降级（SPEC.md §3.2）
//
// 覆盖：单元格切分/转义、表头+分隔行成对判定、列宽求解（自然宽 / 压缩 / 省略号
// 截断 / 过窄放弃）、列对齐三态、表头加粗与 ═ 横线、左缘回复竖线逐行连续 + 1 空格
// 间隔（横线不与其连接、左缘无交叉字）、折行续行的列分隔逐行重复、
// 行高与 valign 居中，以及 buildContentRows 集成（kind 传播 / fence 保护 / 窄宽回退）。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Buffer } from "../src/app/state.ts";
import {
  hasCellPipe,
  isTableStart,
  parseTableAt,
  splitCells,
  tableBox,
} from "../src/app/layout/table.ts";
import type { TableSpec } from "../src/app/layout/table.ts";
import { fillBoxTree } from "../src/app/layout/fill.ts";
import { buildBox, buildContentRows } from "../src/app/layout/build-box.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
import { rowAnsi, rowText } from "./helpers/rowText.ts";

const THEME = "dark" as const;

/** assistant buffer 行（缺省 final，即历史区展示） */
function a(text: string, final = true) {
  return { text, kind: "assistant" as const, final };
}

const parse = (table: readonly string[]): TableSpec => {
  const parsed = parseTableAt(table, 0);
  assert.ok(parsed, "应识别为表格：" + JSON.stringify(table));
  return parsed.table;
};

/** 无 wrapper 摊平表格 Box（rect 宽 = 可用宽） */
function rows(spec: TableSpec, budget: number): string[] {
  const box = tableBox(spec, budget, THEME);
  assert.ok(box, "表格应可构建（budget=" + budget + "）");
  return fillBoxTree(box, 200, budget, THEME).map(rowText);
}

/** 行内 `│` 所在的显示列（列分隔对齐不变量） */
function sepCols(line: string): number[] {
  return glyphCols(line, "│");
}

/** 行内指定字形所在的显示列 */
function glyphCols(line: string, glyph: string): number[] {
  const cols: number[] = [];
  let w = 0;
  for (const ch of line) {
    if (ch === glyph) cols.push(w);
    w += displayWidth(ch);
  }
  return cols;
}

/** 数据/表头行与折行续行（排除横线行：`┃ ═` / `┃ ─` 起头） */
const dataLines = (out: string[]): string[] =>
  out.filter((l) => !/^┃?\s*[═─]/.test(l) && l.trim() !== "");

/** 行的显示宽度 */
const widthOf = (line: string): number => displayWidth(line);

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

test("hasCellPipe: 转义竖线不算（表格行预筛）", () => {
  assert.equal(hasCellPipe("| a | b |"), true);
  assert.equal(hasCellPipe("a \\| b"), false);
  assert.equal(hasCellPipe("普通一行"), false);
});

test("isTableStart: 表头与分隔行须成对（列数一致且全为 :?-+:?）", () => {
  assert.equal(isTableStart("| a | b |", "| --- | --- |"), true);
  assert.equal(isTableStart("| a | b |", "| --- |"), false, "列数不一致");
  assert.equal(isTableStart("| a | b |", "| --- | -- |"), true, "两列都合法");
  assert.equal(isTableStart("| a | b |", "| --- | :: |"), false, "非法分隔格");
  assert.equal(isTableStart("普通行", "| --- |"), false, "表头无竖线");
  assert.equal(isTableStart("| a | b |", "---"), false, "分隔行无竖线");
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

test("列宽 = 该列所有格（渲染文本）自然宽；CJK 按 2 列计", () => {
  const spec = parse(["| 名称 | 说明 |", "| --- | --- |", "| a | 中文 |"]);
  const out = rows(spec, 40);
  // 左缘回复竖线 1 + 间隔 1 空格 + 每列自然宽 4/4 + 留白与列分隔；表头下 ══╪══
  assert.deepEqual(out, [
    "┃  名称 │ 说明 ",
    "┃ ══════╪══════",
    "┃  a    │ 中文 ",
  ]);
});

test("列对齐三态（:--- 左 / :--: 中 / ---: 右）+ 表头加粗 + 网格线", () => {
  const spec = parse([
    "| Lxx | Cxx | Rxx |",
    "| :--- | :---: | ---: |",
    "| a | b | 1 |",
    "| 中文 | c | 250 |",
  ]);
  const box = tableBox(spec, 30, THEME)!;
  const out = fillBoxTree(box, 200, 30, THEME);
  const texts = out.map(rowText);
  assert.deepEqual(texts, [
    "┃  Lxx  │ Cxx │ Rxx ",
    "┃ ══════╪═════╪═════",
    "┃  a    │  b  │   1 ",
    "┃ ──────┼─────┼─────",
    "┃  中文 │  c  │ 250 ",
  ]);
  // 表头加粗；网格线一律不着色（默认前景色，不用语义色）
  const bold = out[0]!.segments.filter((s) => s.style?.bold);
  assert.equal(bold.length, 3, "表头三格均加粗");
  assert.ok(
    bold.every((s) => s.text === "Lxx" || s.text === "Cxx" || s.text === "Rxx"),
  );
  assert.ok(
    out[1]!.segments
      .filter((s) => /[═╪]/.test(s.text))
      .every((s) => s.style === undefined),
    "表头下横线与交叉字不着色",
  );
  assert.ok(
    out[2]!.segments
      .filter((s) => s.text.includes("│"))
      .every((s) => s.style === undefined),
    "列分隔不着色",
  );
  assert.ok(
    out[3]!.segments
      .filter((s) => /[─┼]/.test(s.text))
      .every((s) => s.style === undefined),
    "行间横线与交叉字不着色",
  );
  // 左缘回复竖线保留：每行以 `┃` 起（与正文同列同色），其后 1 空格 prefix 再排表格
  assert.ok(
    texts.every((t) => t.startsWith("┃ ")),
    "表格各行首列为回复竖线 + 间隔空格：" + JSON.stringify(texts),
  );
  const bar = out[0]!.segments[0]!;
  assert.equal(bar.text, "┃", "首段即左缘竖线");
  assert.equal(bar.style?.fg, "brightBlue", "左缘竖线与正文同色");
  assert.ok(
    out.every((r) => r.segments[0]!.style?.fg === "brightBlue"),
    "含横线行在内整表竖线连续",
  );
  // 横线不与竖线连接：横线上首列 `┃`、第二列空格，横线自第三列起
  for (const r of out) {
    const t = rowText(r);
    if (/[═─]/.test(t))
      assert.ok(
        t.startsWith("┃ ") && /[═─]/.test(t[2]!),
        "横线与竖线之间留 1 空格：" + JSON.stringify(t),
      );
  }
});

test("网格：左缘回复竖线逐行连续、横线隔 1 空格不与其连接、各行等宽", () => {
  const spec = parse([
    "| 名称 | 说明 |",
    "| --- | --- |",
    "| a | 较长内容需要折行 |",
    "| b | 短 |",
  ]);
  const out = rows(spec, 24);
  // 1) 每行以 `┃ ` 起（左缘回复竖线 + 间隔空格；含折行续行、横线行）
  for (const line of out)
    assert.ok(line.startsWith("┃ "), "表格行首须为回复竖线 + 空格：" + line);
  // 2) 表头下横线：`┃ ═` 起（竖线与横线之间有空格，不连接），╪ 与列分隔同列
  const headRule = out[1]!;
  assert.ok(headRule.startsWith("┃ ══════"));
  assert.deepEqual(glyphCols(headRule, "╪"), sepCols(out[0]!));
  // 3) 数据行之间以 ─ 分隔（折行时区分行），`┃ ─` 起、┼ 与列分隔同列
  const rowRule = out.find((l) => l.startsWith("┃ ─"))!;
  assert.ok(rowRule, "数据行之间应有横线：" + JSON.stringify(out));
  assert.ok(rowRule.includes("─"));
  assert.deepEqual(glyphCols(rowRule, "┼"), sepCols(out[0]!));
  // 4) 所有行等宽（列分隔逐行同列）
  const w = widthOf(out[0]!);
  for (const line of out) {
    assert.equal(widthOf(line), w, "行宽不一致：" + line);
    if (!line.startsWith("┃ ═") && !line.startsWith("┃ ─"))
      assert.deepEqual(sepCols(line), sepCols(out[0]!));
  }
  // 5) 左缘竖线后必为空格（横线不以交叉字与竖线相接）
  assert.ok(
    out.every((l) => !/^┃\S/.test(l)),
    "左缘竖线后不得紧邻非空格字符：" + JSON.stringify(out),
  );
  // 6) 折行续行同样带列分隔
  const wrapped = dataLines(out).slice(1, 4);
  assert.ok(
    wrapped.some((l) => sepCols(l).length === 1),
    "折行续行保留网格：" + JSON.stringify(wrapped),
  );
});

test("格内行内 markdown 生效（粗体/行内代码），且列宽按渲染文本（不计标记）", () => {
  const spec = parse(["| a | b |", "| --- | --- |", "| **粗** | `code` |"]);
  const box = tableBox(spec, 30, THEME)!;
  const out = fillBoxTree(box, 200, 30, THEME);
  // 自然宽：a=1、粗=2（去掉 ** ）；b=1、code=4
  assert.equal(rowText(out[2]!), "┃  粗 │ code ");
  assert.ok(
    out[2]!.segments.some((s) => s.style?.bold === true && s.text === "粗"),
  );
  assert.ok(
    out[2]!.segments.some((s) => s.style?.bg === "code" && s.text === "code"),
  );
});

// ---------------- 构建：超宽 / 极窄降级 ----------------

test("超宽：压缩列宽 + 格内折行，总宽不超可用宽、列分隔逐行同列", () => {
  const spec = parse([
    "| 甲 | 乙 |",
    "| --- | --- |",
    `| ${"甲".repeat(20)} | ${"乙".repeat(20)} |`,
  ]);
  const budget = 30;
  const out = rows(spec, budget);
  for (const line of out) assert.ok(widthOf(line) <= budget, "行宽不超可用宽");
  // 表头行与所有数据行（含折行续行）的列分隔同列
  const expect = sepCols(out[0]!);
  assert.equal(expect.length, 1);
  for (const line of dataLines(out))
    assert.deepEqual(sepCols(line), expect, "列分隔逐行同列：" + line);
  assert.ok(dataLines(out).length > 4, "长格折成多行");
});

test("极窄：minW 也放不下 → 格内省略号截断（不溢出、不折行）", () => {
  const spec = parse([
    "| 名称 | 说明 | 数量 |",
    "| --- | --- | --- |",
    "| a | 中文说明 | 12 |",
  ]);
  const budget = 15; // overhead 10 → 可用 5 < ΣminW 9
  const out = rows(spec, budget);
  for (const line of out) assert.ok(widthOf(line) <= budget);
  assert.ok(
    out.some((l) => l.includes("…")),
    "超宽格以省略号截断：" + JSON.stringify(out),
  );
});

test("过窄：连每列 1 列都放不下 → tableBox 返回 null（调用方退回普通文本）", () => {
  const spec = parse(["| a | b |", "| --- | --- |"]);
  // 两列最小占宽 = 左竖线 1 + 间隔 1 + 每列 1 + 左右留白 4 + 列分隔 1 = 9
  assert.equal(tableBox(spec, 8, THEME), null);
  assert.ok(tableBox(spec, 9, THEME), "9 列起可构建");
});

test("行高不一致：矮格垂直居中补白（valign center）", () => {
  const spec = parse([
    "| a | b |",
    "| --- | --- |",
    `| 高 | ${"长".repeat(20)} |`,
  ]);
  const out = rows(spec, 24);
  const group = dataLines(out).slice(1); // 表头之外的数据行
  assert.equal(group.length, 3, "长格折成 3 行：" + JSON.stringify(out));
  assert.ok(
    group[1]!.includes("高"),
    "矮格落在行组中间：" + JSON.stringify(group),
  );
  assert.ok(
    !group[0]!.includes("高") && !group[2]!.includes("高"),
    "上下均为补白行：" + JSON.stringify(group),
  );
  assert.ok(
    out.some((l) => l.includes("长")),
    "长格内容分行渲染",
  );
});

test("压缩优先保住窄列自然宽（水位法）：只压超宽列，窄列表头不折行", () => {
  const spec = parse([
    "| 名称 | 描述 |",
    "| --- | --- |",
    `| ${"甲".repeat(40)} | ab |`,
  ]);
  const budget = 35; // 左竖线 1 + 间隔 1 + overhead 5 → 可用 28：超宽列 24、窄列保 4
  const out = rows(spec, budget);
  const header = out[0]!;
  assert.ok(
    header.includes("描述"),
    "窄列保持自然宽：" + JSON.stringify(header),
  );
  const sepAt = sepCols(header);
  assert.equal(sepAt.length, 1);
  for (const line of dataLines(out))
    assert.deepEqual(sepCols(line), sepAt, "列分隔逐行同列：" + line);
  const group = dataLines(out).slice(1);
  assert.equal(group.length, 4, "超宽列折 4 行：" + JSON.stringify(out));
  assert.ok(
    group.some((l) => l.includes("ab")),
    "窄列内容正常渲染（居中补白）",
  );
});

test("数字列自动右对齐（分隔行未显式标注时）；显式 :--- 则保持左对齐", () => {
  const auto = parse([
    "| 名称 | 数量 |",
    "| --- | --- |",
    "| aaa | 1 |",
    "| b | 1288 |",
  ]);
  assert.deepEqual(auto.aligns, ["left", "right"]);
  const out = rows(auto, 30);
  assert.equal(out[2], "┃  aaa  │    1 ");
  assert.equal(out[4], "┃  b    │ 1288 ");

  const explicitLeft = parse([
    "| 名称 | 数量 |",
    "| --- | :--- |",
    "| aaa | 1 |",
  ]);
  assert.deepEqual(explicitLeft.aligns, ["left", "left"], "显式左对齐优先");

  const mixed = parse([
    "| 名称 | 数量 |",
    "| --- | --- |",
    "| aaa | 1 |",
    "| b | 待定 |",
  ]);
  assert.deepEqual(mixed.aligns, ["left", "left"], "含非数字格 → 不自动右对齐");
});

// ---------------- 集成：buildContentRows ----------------

test("buildContentRows: 表格成块渲染，各行 kind 均为 assistant（回复组折叠依据）", () => {
  const buffer: Buffer = [
    a("说明："),
    a("| 名称 | 数量 |"),
    a("| --- | ---: |"),
    a("| a | 1 |"),
    a("结束。"),
  ];
  const { dialogue } = buildContentRows(
    buffer,
    { themeId: THEME, gutter: 4 },
    40,
  );
  const texts = dialogue.map(rowText);
  assert.ok(
    texts.some((t) => t.includes("名称")),
    "表头行",
  );
  assert.ok(
    texts.some((t) => t.includes("数量")),
    "数据行",
  );
  assert.ok(
    texts.some((t) => t.includes("═")),
    "表头下横线",
  );
  assert.equal(
    dialogue.filter((r) => r.segments.some((s) => s.text.includes("│"))).length,
    2,
    "表头 + 数据行各一行列分隔",
  );
  assert.ok(
    dialogue.some((r) => r.segments.some((s) => s.text.includes("│"))),
    "表格带列分隔",
  );
  assert.ok(
    dialogue.every((r) => r.kind === "assistant"),
    "表格各行 kind 与回复一致（回复组折叠依据）",
  );
});

test("集成：表格行保留回复左缘竖线，横线与其之间隔 1 空格（不连接）", () => {
  const buffer: Buffer = [
    a("说明："),
    a("| 名称 | 说明 |"),
    a("| --- | --- |"),
    a("| a | 较长的一段中文说明 |"),
    a("结尾。"),
  ];
  const { dialogue } = buildContentRows(
    buffer,
    { themeId: THEME, gutter: 4 },
    26,
  );
  // 表格各行（含横线行）以 `┃ ` 起：回复左缘竖线保留，其后 1 空格间隔
  const tableRows = dialogue.filter((r) =>
    r.segments.some((s) => s.text.includes("│") || s.text.includes("═")),
  );
  assert.ok(
    tableRows.length > 0,
    "有表格行：" + JSON.stringify(dialogue.map(rowText)),
  );
  for (const r of tableRows) {
    const t = rowText(r);
    assert.ok(
      t.startsWith("┃ "),
      "表格行以回复竖线 + 空格起：" + JSON.stringify(t),
    );
    assert.equal(r.segments[0]!.style?.fg, "brightBlue", "竖线与正文同色");
  }
  // 横线行：竖线后隔 1 空格才是横线（左缘不设交叉字，两条线不连接）
  const ruleRows = tableRows.filter((r) => rowText(r).includes("═"));
  assert.ok(ruleRows.length > 0, "有表头横线行");
  for (const r of ruleRows) {
    const t = rowText(r);
    assert.equal(t[1], " ", "竖线与横线之间为空隔：" + JSON.stringify(t));
    assert.equal(t[2], "═", "横线自间隔后起：" + JSON.stringify(t));
    assert.ok(
      !t.includes("╢") && !t.includes("├"),
      "左缘无交叉字：" + JSON.stringify(t),
    );
  }
});

test("buildContentRows: 管道符不再原样渲染；非 final 表格进活动区", () => {
  const finalBuf: Buffer = [a("| a | b |"), a("| --- | --- |"), a("| 1 | 2 |")];
  const { dialogue, activity } = buildContentRows(
    finalBuf,
    { themeId: THEME, gutter: 4 },
    40,
  );
  assert.equal(activity.length, 0);
  assert.ok(!dialogue.some((r) => rowText(r).includes("|")), "无残留 `|`");
  const streamBuf: Buffer = [
    a("| a | b |", false),
    a("| --- | --- |", false),
    a("| 1 | 2 |", false),
  ];
  const streamed = buildContentRows(
    streamBuf,
    { themeId: THEME, gutter: 4 },
    40,
  );
  assert.equal(streamed.dialogue.length, 0);
  assert.ok(streamed.activity.length === 3, "流式表格在活动区成块");
});

test("fence 内不识别表格（代码块原样保留管道符）", () => {
  const buffer: Buffer = [
    a("```md"),
    a("| 名称 | 数量 |"),
    a("| --- | ---: |"),
    a("```"),
  ];
  const { dialogue } = buildContentRows(
    buffer,
    { themeId: THEME, gutter: 4 },
    40,
  );
  const texts = dialogue.map(rowText);
  assert.ok(
    texts.some((t) => t.includes("| 名称 | 数量 |")),
    "代码块内原样",
  );
  assert.ok(!texts.some((t) => t.includes("═")), "无表头横线");
});

test("可用宽未知（buildBox 直调，无 width）→ 表格按普通文本行渲染", () => {
  const buffer: Buffer = [a("| a | b |"), a("| --- | --- |")];
  const built = buildBox(buffer, { themeId: THEME });
  const out = fillBoxTree(built.panes.dialogue, 50, 40, THEME).map(rowText);
  assert.equal(out.length, 2, "每行一个文本节点（未合成表格）");
  assert.ok(out[0]!.includes("| a | b |"));
});

test("窄宽回退：可用宽过窄时退回普通文本（不抛错、不溢出）", () => {
  const buffer: Buffer = [
    a("| 名称 | 数量 |"),
    a("| --- | --- |"),
    a("| a | 1 |"),
  ];
  // 宽 10 → 预算 = 10 - 1(缩进) - 3(final gutter) = 6 < 两列最小占宽 9 → 放弃表格
  const { dialogue } = buildContentRows(
    buffer,
    { themeId: THEME, gutter: 4 },
    10,
  );
  const texts = dialogue.map(rowText);
  assert.ok(
    texts.some((t) => t.includes("|")),
    "退回原样管道符文本",
  );
  for (const t of texts) assert.ok(widthOf(t) <= 10, "不溢出：" + t);
});
