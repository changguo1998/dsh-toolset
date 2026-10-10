// tests/activity-type-gap.test.ts — 回合区类型间隔（#5；2026-10-02 收窄）：
//   仅「思考 ↔ 正文」互切时插 1 行空行；工具类（step 头 / 调用行 / 结果行）与任何类型相邻
//   都不插，step 分割线与内容之间亦不留空行；notice / shell / 空行不算类型边界；
//   同类连续只在边界插一次；回合区开头（无前一类）不插。

import { test } from "node:test";
import assert from "node:assert/strict";

import { rowText } from "../src/app/layout.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import type { Buffer, BufferLine } from "../src/app/state.ts";

const W = 80;
const L = (text: string, kind: BufferLine["kind"]): BufferLine => ({
  text,
  kind,
});

/** 活动区渲染文本行 */
const act = (buf: Buffer): string[] =>
  buildContentRows(buf, {}, W, W).activity.map(rowText);

/** 空行所在行号 */
const blanks = (rows: string[]): number[] =>
  rows.map((t, i) => (t.trim() === "" ? i : -1)).filter((i) => i >= 0);

test("#5 思考 → 正文：中间插 1 行空行（reasoning / assistant 切换）", () => {
  const rows = act([L("思考一", "thinking"), L("正文一", "assistant")]);
  assert.equal(
    rows.length,
    3,
    `3 行 = 思考 + 空行 + 正文（实际 ${rows.length}）`,
  );
  assert.deepEqual(blanks(rows), [1]);
});

test("#5 正文 → 思考：双向同样插 1 行空行", () => {
  const rows = act([L("正文一", "assistant"), L("思考一", "thinking")]);
  assert.deepEqual(blanks(rows), [1]);
});

test("#5 同类连续：只在边界插一次", () => {
  const rows = act([
    L("思考一", "thinking"),
    L("思考二", "thinking"),
    L("正文一", "assistant"),
    L("正文二", "assistant"),
  ]);
  assert.equal(rows.length, 5, "4 条内容 + 1 行空行");
  assert.deepEqual(blanks(rows), [2], "两块之间只有 1 行空行");
});

test("#5 工具块与正文互切：不插空行（工具 run 内部同样不插）", () => {
  const rows = act([
    L("正文一", "assistant"),
    L("○ bash ls", "tool"),
    L("✓ 输出", "tool"),
    L("正文二", "assistant"),
  ]);
  assert.deepEqual(blanks(rows), [], "正文→工具→正文全程紧排");
});

test("#5 思考→工具→正文：工具类打断思考/正文成对关系，全程不插空行", () => {
  const rows = act([
    L("思考一", "thinking"),
    L("○ bash ls", "tool"),
    L("✓ 输出", "tool"),
    L("正文一", "assistant"),
  ]);
  assert.deepEqual(blanks(rows), []);
});

test("#5 notice / step 概要行不算类型边界（不新增空行）", () => {
  const withNotice = act([
    L("思考一", "thinking"),
    L("提示行", "notice"),
    L("正文一", "assistant"),
  ]);
  assert.deepEqual(
    blanks(withNotice),
    [2],
    "只有思考→正文那一处，notice 不新增",
  );
  // 实时 step 头是 tool-kind 行（文本 `hh:mm:ss ⇆N #M`）→ 归「工具」类：
  // 与思考相邻不插类型间隔空行，且分割行的「吸收拖尾空行」照常生效 → 分割行与内容紧排
  const withStep = act([
    L("思考一", "thinking"),
    L("22:31:05 #1", "tool"),
    L("○ bash ls", "tool"),
    L("✓ 输出", "tool"),
  ]);
  assert.deepEqual(
    blanks(withStep),
    [],
    "思考→step 头不留空行，分割行前也紧排",
  );
});

test("#5 正文 / 思考的拖尾空行 → 工具：吸收后紧排（不靠 step 头也吸收）", () => {
  // 宿主补发 "\n\n" 后 buffer 里的正文空段（同 kind 空白分片不丢弃）→ 正文与工具紧排
  const withBlankLine = act([
    L("正文一", "assistant"),
    L("", "assistant"),
    L("○ bash ls", "tool"),
    L("✓ 输出", "tool"),
  ]);
  assert.deepEqual(blanks(withBlankLine), [], "正文后的空段被吸收");
  // 拖尾换行锚点（thinking 以 \n 结尾）同理：剥掉尾随换行后不留空行
  const withTrailingNewline = act([
    L("思考一\n", "thinking"),
    L("○ bash ls", "tool"),
    L("✓ 输出", "tool"),
  ]);
  assert.deepEqual(blanks(withTrailingNewline), [], "思考拖尾换行被吸收");
  // 但正文内部的段落空行（其后还有正文）不算拖尾 → 保留
  // （该行可能带「块内空行竖线连排」的 ┃，故按剥掉竖线与空白后是否为空判断）
  const innerBlank = act([
    L("正文一", "assistant"),
    L("", "assistant"),
    L("正文二", "assistant"),
  ]);
  assert.equal(innerBlank.length, 3, "段内空行保留为 1 行");
  assert.equal(
    (innerBlank[1] ?? "").replace(/[┃│\s]/g, ""),
    "",
    "段内空行属内容，保留（实际第 2 行：" +
      JSON.stringify(innerBlank[1]) +
      "）",
  );
});

test("#5 活动区开头（无前一类）不插空行", () => {
  const rows = act([L("提示行", "notice"), L("思考一", "thinking")]);
  assert.deepEqual(blanks(rows), []);
});

test("正文合并（BACKLOG）：正文 → 思考 → 正文 并成一段（直接相接、只留 1 行间隔）", () => {
  const rows = act([
    L("正文一", "assistant"),
    L("思考一", "thinking"),
    L("正文二", "assistant"),
  ]);
  // 思考块在前、合并后的正文段在后；两处切点的空行收敛为 1 行（5 行 → 3 行）
  assert.equal(
    rows.length,
    3,
    `3 行 = 思考 + 空行 + 合并正文（实际 ${rows.length}）: ` +
      JSON.stringify(rows),
  );
  assert.deepEqual(blanks(rows), [1], "间隔空行恰 1 行且在合并叶正前方");
  assert.ok(
    rows[2]!.includes("正文一正文二"),
    "两片直接相接（不插换行 / 空格）: " + JSON.stringify(rows),
  );
});

test("正文合并：notice 是穿透行，工具 / 结构分片是硬边界", () => {
  // notice 穿透（条目原文「只被 thinking / notice 行隔开」）
  const withNotice = act([
    L("正文一", "assistant"),
    L("提示行", "notice"),
    L("正文二", "assistant"),
  ]);
  assert.ok(
    withNotice.some((t) => t.includes("正文一正文二")),
    "notice 不打断合并: " + JSON.stringify(withNotice),
  );
  // 工具是硬边界
  const withTool = act([
    L("正文一", "assistant"),
    L("○ bash ls", "tool"),
    L("正文二", "assistant"),
  ]);
  assert.ok(
    !withTool.some((t) => t.includes("正文一正文二")),
    "工具边界不合并: " + JSON.stringify(withTool),
  );
  // 直接相邻的正文分片不合并（同一 delta 含 \n 时本就产相邻行：列表 / 代码块分片）
  const adjacent = act([L("第一片", "assistant"), L("第二片", "assistant")]);
  assert.ok(
    !adjacent.some((t) => t.includes("第一片第二片")),
    "直接相邻不合并: " + JSON.stringify(adjacent),
  );
  // 含内部换行的结构分片：不参与合并，且是边界
  const multi = act([
    L("正文一", "assistant"),
    L("思考一", "thinking"),
    L("1. 甲\n2. 乙", "assistant"),
  ]);
  assert.ok(
    !multi.some((t) => t.includes("正文一1. 甲")),
    "结构分片不参与合并: " + JSON.stringify(multi),
  );
});

test("正文合并：二次合并不丢间隔空行（run 记账收敛为 1 行）", () => {
  const rows = act([
    L("正文一", "assistant"),
    L("思考一", "thinking"),
    L("正文二", "assistant"),
    L("提示行", "notice"),
    L("正文三", "assistant"),
  ]);
  assert.ok(
    rows.some((t) => t.includes("正文一正文二正文三")),
    "三片合并为一段: " + JSON.stringify(rows),
  );
  assert.deepEqual(
    blanks(rows),
    [rows.length - 2],
    "间隔空行恰 1 行、紧邻合并叶之前: " + JSON.stringify(rows),
  );
});
