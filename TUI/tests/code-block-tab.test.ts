// tests/code-block-tab.test.ts — 代码块制表符展开（BACKLOG「代码块排版：\t 展开为 4 个
//   空格并保证底色填满整行」）：
//   - 围栏代码块内的 \t 出行前固定展开为 4 个空格（不按终端 tab stop 8 列推进）；
//   - 三条出行路径口径一致：预折路径（宽已知）、宽未知退化路径（交 fill 折行）、
//     紧凑模式 fence 行；思考区代码块同一构建器，同样生效；
//   - 展开后宽度计算、折行、行号列与底色补齐都按 4 列算：每行（含补白）显示宽恰为
//     内容宽，灰底到右缘连续，输出不再残留 \t。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBox, buildContentRows } from "../src/app/layout/build-box.ts";
import { fillBoxTree } from "../src/app/layout/fill.ts";
import type { ContentRow } from "../src/app/layout/fill.ts";
import { displayWidth, expandCodeTabs } from "../src/app/layout/markdown.ts";
import { USER_MIN_LEFT_GUTTER } from "../src/app/layout/content-rules.ts";
import type { HistoryRow } from "../src/app/state.ts";

const W = 40;
const A = (text: string, final = true): HistoryRow => ({
  text,
  kind: "assistant",
  final,
});
const TH = (text: string): HistoryRow => ({ text, kind: "thinking" });
const rowText = (row: ContentRow): string =>
  row.segments.map((s) => s.text).join("");
/** 行尾是否以代码底色段收尾（灰底铺到右缘） */
const endsWithCodeBg = (row: ContentRow): boolean =>
  row.segments.at(-1)?.style?.bg === "code";

test("expandCodeTabs 纯函数：\\t → 固定 4 空格，无 tab 原样返回", () => {
  assert.equal(expandCodeTabs(""), "");
  assert.equal(expandCodeTabs("plain"), "plain");
  assert.equal(expandCodeTabs("\tif (x) {"), "    if (x) {");
  assert.equal(expandCodeTabs("a\tb\tc"), "a    b    c");
});

test("预折路径：\\t 展开 4 空格，行宽恰为内容宽、灰底铺到右缘", () => {
  const { dialogue } = buildContentRows(
    [A("```"), A("\tindent();"), A("```")],
    {},
    W,
  );
  const row = dialogue.find((r) => rowText(r).includes("indent();"));
  assert.ok(
    row !== undefined,
    `代码行存在：${JSON.stringify(dialogue.map(rowText))}`,
  );
  const text = rowText(row);
  assert.ok(!text.includes("\t"), `不残留 \\t：${JSON.stringify(text)}`);
  assert.match(text, /^┃ 1 {5}indent\(\);/, "行号列后是 4 空格 + 代码");
  assert.equal(displayWidth(text), W, "行宽恰为内容宽（底色填满）");
  assert.ok(endsWithCodeBg(row), "行尾是代码底色段");
});

test("预折路径：含 \\t 的长行按展开后的宽度折行，↩ / ↪ 与右缘对齐", () => {
  const long = "\tfoo(a, b, c) + bar(d, e, f) + baz(g, h, i);";
  const { dialogue } = buildContentRows([A("```"), A(long), A("```")], {}, W);
  const code = dialogue.filter((r) => rowText(r).trim() !== "");
  const first = code[0]!;
  assert.match(rowText(first), /^┃ 1 {5}foo\(/, "首行：4 空格缩进生效");
  assert.ok(rowText(first).endsWith("↩"), "断行处行尾带 ↩");
  const cont = code[1]!;
  assert.ok(rowText(cont).includes("↪"), "续行行首带 ↪");
  for (const row of code) {
    assert.ok(
      !rowText(row).includes("\t"),
      `不残留 \\t：${JSON.stringify(rowText(row))}`,
    );
    assert.equal(displayWidth(rowText(row)), W, "每行恰为内容宽");
    assert.ok(endsWithCodeBg(row), "每行灰底铺到右缘");
  }
  // 折行点按展开后（4 列）算：首行正文放得下 4 空格 + 33 列，即 "foo...b"
  assert.match(rowText(first), /b↩$/, "首行按展开后的列宽折在 b 后");
});

test("宽未知路径（buildBox 无 width）：交 fill 折行时同样展开", () => {
  const built = buildBox([A("```"), A("\tindent();"), A("```")], {});
  const rows = fillBoxTree(built.panes.dialogue, 10, W);
  const text = rows.map((r) => r.segments.map((s) => s.text).join(""));
  const row = text.find((t) => t.includes("indent();"));
  assert.ok(row !== undefined, `代码行存在：${JSON.stringify(text)}`);
  assert.ok(!row.includes("\t"), `不残留 \\t：${JSON.stringify(row)}`);
  assert.match(row, /^┃ 1 {5}indent\(\);/, "行号列后是 4 空格 + 代码");
  assert.equal(displayWidth(row), W, "行宽恰为内容宽（底色填满）");
});

test("紧凑模式 fence 行：展开 4 空格且行宽恰为内容宽", () => {
  const { dialogue } = buildContentRows(
    [A("```"), A("\tindent();"), A("```")],
    { activityCompact: { reply: true } },
    W,
  );
  const row = dialogue.find((r) => rowText(r).includes("indent();"));
  assert.ok(
    row !== undefined,
    `代码行存在：${JSON.stringify(dialogue.map(rowText))}`,
  );
  const text = rowText(row);
  assert.ok(!text.includes("\t"), `不残留 \\t：${JSON.stringify(text)}`);
  assert.match(
    text,
    /^┃ {4}indent\(\);/,
    "竖线后是 4 空格 + 代码（紧凑模式无行号列）",
  );
  assert.equal(displayWidth(text), W, "行宽恰为内容宽");
  // 紧凑 fence 行走 finalSpace（右缘留白 gutter - 1 列），灰底只铺到正文右缘
  const codeBg = row.segments.filter((s) => s.style?.bg === "code");
  assert.ok(codeBg.length > 0, "有代码底色段");
  const codeW = codeBg.reduce((n, s) => n + displayWidth(s.text), 0);
  assert.equal(
    codeW,
    W - USER_MIN_LEFT_GUTTER,
    "灰底铺到正文右缘（右缘留白 gutter - 1 列 + 竖线 1 列）",
  );
  assert.ok(
    endsWithCodeBg(row) || row.segments.at(-1)?.style === undefined,
    "行尾是代码底色段或右缘留白",
  );
});

test("思考区代码块：同一构建器同样展开 \\t", () => {
  const { activity } = buildContentRows(
    [TH("```"), TH("\tthink();"), TH("```")],
    {},
    W,
  );
  const row = activity.find((r) => rowText(r).includes("think();"));
  assert.ok(
    row !== undefined,
    `思考代码行存在：${JSON.stringify(activity.map(rowText))}`,
  );
  const text = rowText(row);
  assert.ok(!text.includes("\t"), `不残留 \\t：${JSON.stringify(text)}`);
  assert.match(text, /^┃ 1 {5}think\(\);/, "行号列后是 4 空格 + 代码");
  assert.equal(displayWidth(text), W, "行宽恰为内容宽（底色填满）");
});
