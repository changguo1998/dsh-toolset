// tests/content-rules.test.ts — 内容规则共享层（buildBox 与 layout.ts 共用）
//
// 规则搬移等价验证：wrapToolCallText / userMaxBodyWidth / 分组判定 /
// tone 映射。与原 layout.ts 定义逐一对应（双轨共用一套避免漂移）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_MAX_GROUPS,
  TOOL_CONT_INDENT,
  TOOL_MORE,
  TOOL_STATUS_PREFIXES,
  TURN_SEPARATOR_CHAR,
  ACTIVITY_SEPARATOR,
  SEPARATOR,
  isToolCall,
  isToolResult,
  NOTICE_TONE_COLOR,
  renderToolText,
  renderToolNameLine,
  userMaxBodyWidth,
  wrapToolCallText,
  USER_MIN_LEFT_GUTTER,
} from "../src/app/layout/content-rules.ts";

test("content-rules：工具折行首行全宽、续行缩进", () => {
  const width = 20;
  const rows = wrapToolCallText("bash command=" + "a".repeat(60), width);
  assert.ok(rows.length > 1, "长参数应折成多行");
  assert.ok(rows[0]!.startsWith("bash command="), "首行保留原文起点");
  for (const r of rows) {
    assert.ok(
      [...r].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) <=
        width,
      `溢出: ${r}`,
    );
  }
});

test("wrapToolCallText：参数内显式换行后的各行同样缩进", () => {
  const pad = " ".repeat(4);
  assert.deepEqual(wrapToolCallText("a\nb\nc", 20), [
    "a",
    pad + "b",
    pad + "c",
  ]);
});

test("wrapToolCallText：空串", () => {
  assert.deepEqual(wrapToolCallText("", 20), [""]);
});

test("wrapToolCallText：窄窗口降级不缩进", () => {
  const rows = wrapToolCallText("abcdefgh", TOOL_CONT_INDENT);
  assert.deepEqual(rows, ["abcd", "efgh"]);
});

test("分组判定：无状态前缀=调用，状态前缀=辅助行", () => {
  assert.ok(isToolCall("bash run task"), "无前缀=工具调用");
  assert.ok(!isToolCall("✓ done"), "✓ 是结果行");
  assert.ok(!isToolCall("step 2"), "step 是辅助行");
  assert.ok(isToolResult("✓ done"));
  assert.ok(isToolResult("✗ fail"));
  assert.ok(!isToolResult("bash run"));
  // 前缀集合齐全
  for (const p of TOOL_STATUS_PREFIXES)
    assert.ok(!isToolCall(p + "x"), `前缀 ${p} 应判非调用`);
});

test("tool 宽度：用户块最大正文宽带 gutter", () => {
  assert.equal(userMaxBodyWidth(20, 4), 16);
  assert.equal(userMaxBodyWidth(20, 0), Math.max(1, 20 - Math.min(0, 19)));
});

test("tone 映射覆盖全部 NoticeTone", () => {
  assert.deepEqual(NOTICE_TONE_COLOR, {
    log: "gray",
    info: "blue",
    warn: "yellow",
    error: "red",
    success: "green",
  });
});

test("工具渲染：✓ 前缀绿分离、工具名染黄", () => {
  const ok = renderToolText("✓ done");
  assert.equal(ok[0]!.text, "✓");
  assert.equal(ok[0]!.style?.fg, "green");
  const call = renderToolNameLine("bash -c x");
  assert.equal(call[0]!.text, "bash");
  assert.equal(call[0]!.style?.fg, "yellow");
  const solo = renderToolNameLine("bash");
  assert.equal(solo[0]!.style?.fg, "yellow");
});

test("常量齐全", () => {
  assert.equal(TOOL_MAX_GROUPS, 4);
  assert.equal(TOOL_CONT_INDENT, 4);
  assert.equal(TOOL_MORE, "...(更早工具调用已隐藏)");
  assert.equal(TURN_SEPARATOR_CHAR, "╌");
  assert.equal(ACTIVITY_SEPARATOR, "─");
  assert.equal(SEPARATOR, "─");
  assert.equal(USER_MIN_LEFT_GUTTER, 4);
});
