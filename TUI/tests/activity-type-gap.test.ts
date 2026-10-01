// tests/activity-type-gap.test.ts — 活动区类型间隔（#5）：
//   思考 / 正文 / 工具 三类相邻互切时插 1 行空行；notice / step 头 / shell / 空行不算类型边界；
//   同类连续只在边界插一次；活动区开头（无前一类）不插。

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
  buildContentRows(buf, { themeId: "dark" }, W, W).activity.map(rowText);

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

test("#5 工具块与正文互切：各插一处，工具 run 内部不插", () => {
  const rows = act([
    L("正文一", "assistant"),
    L("○ bash ls", "tool"),
    L("✓ 输出", "tool"),
    L("正文二", "assistant"),
  ]);
  assert.deepEqual(blanks(rows), [1, 4]);
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
  // 实时 step 头是 tool-kind 行（文本 `hh:mm:ss #N`）→ 归「工具」类；
  // 且 step 分割行的「吸收拖尾空行」不得吞掉类型间隔空行
  const withStep = act([
    L("思考一", "thinking"),
    L("22:31:05 #1", "tool"),
    L("○ bash ls", "tool"),
    L("✓ 输出", "tool"),
  ]);
  assert.deepEqual(
    blanks(withStep),
    [1],
    "空行留在 step 头之前（不被分割行吸收）",
  );
});

test("#5 活动区开头（无前一类）不插空行", () => {
  const rows = act([L("提示行", "notice"), L("思考一", "thinking")]);
  assert.deepEqual(blanks(rows), []);
});
