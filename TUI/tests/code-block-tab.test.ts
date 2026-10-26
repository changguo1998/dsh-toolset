// tests/code-block-tab.test.ts — 代码块制表符展开（BACKLOG「代码块排版：\t 展开为 4 个空格」）
//
// 契约：围栏代码块内的 `\t` 出行前固定展开为 4 个空格（不按终端 tab stop 8 列推进），
// 展开后宽度计算、折行与底色补齐都按 4 列算，输出不残留 `\t`；思考区代码块同口径。
//
// 渲染口径：内容渲染已全部走新流水线——代码块在 §5 measure 期展开成
// `v[行盒(separator ┃)[行号列, 代码列]]`，故本文件同时核对「行号列 + 列分隔」形制。

import { test } from "node:test";
import assert from "node:assert/strict";

import { displayWidth, expandCodeTabs } from "../src/app/layout/markdown.ts";
import { renderBuffer } from "./helpers/renderBuffer.ts";
import { rowText } from "./helpers/rowText.ts";
import type { ContentRow } from "../src/app/layout/fill.ts";
import type { HistoryRow } from "../src/app/state.ts";

const W = 40;
const A = (text: string): HistoryRow => ({
  text,
  kind: "assistant",
  final: true,
});
const TH = (text: string): HistoryRow => ({ text, kind: "thinking" });
/** 行尾是否含代码底色段（灰底铺到右缘） */
const hasCodeBg = (row: ContentRow): boolean =>
  row.segments.some((s) => s.style?.bg === "code");

test("expandCodeTabs 纯函数：\\t → 固定 4 空格，无 tab 原样返回", () => {
  assert.equal(expandCodeTabs(""), "");
  assert.equal(expandCodeTabs("plain"), "plain");
  assert.equal(expandCodeTabs("\tif (x) {"), "    if (x) {");
  assert.equal(expandCodeTabs("a\tb\tc"), "a    b    c");
});

test("代码块：\\t 展开 4 空格，行号列 + 列分隔，行宽恰为内容宽", () => {
  const { dialogue } = renderBuffer([A("```"), A("\tindent();"), A("```")], {
    dialogueTextW: W,
  });
  const rows = dialogue.map((r) => rowText(r));
  const text = rows.find((t) => t.includes("indent();"));
  assert.ok(text !== undefined, `代码行存在：${JSON.stringify(rows)}`);
  assert.ok(!text.includes("\t"), `不残留 \\t：${JSON.stringify(text)}`);
  assert.match(text, /^┃ 1┃ {4}indent\(\);/, "行号列 + 列分隔 + 4 空格缩进");
  assert.equal(displayWidth(text), W, "行宽恰为内容宽（底色填满）");
  const row = dialogue.find((r) => rowText(r).includes("indent();"))!;
  assert.ok(hasCodeBg(row), "代码行带代码底色段");
});

test("思考区代码块：同一口径展开 \\t", () => {
  const { activity } = renderBuffer([TH("```"), TH("\tthink();"), TH("```")], {
    dialogueTextW: W,
    activityTextW: W,
  });
  const rows = activity.map((r) => rowText(r));
  const text = rows.find((t) => t.includes("think();"));
  assert.ok(text !== undefined, `思考代码行存在：${JSON.stringify(rows)}`);
  assert.ok(!text.includes("\t"), `不残留 \\t：${JSON.stringify(text)}`);
  assert.match(text, /^┃ 1┃ {4}think\(\);/, "行号列 + 列分隔 + 4 空格缩进");
  assert.equal(displayWidth(text), W, "行宽恰为内容宽（底色填满）");
});
