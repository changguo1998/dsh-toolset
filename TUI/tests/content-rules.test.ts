// TUI/tests/content-rules.test.ts — 内容规则共享层（buildBox 与 layout.ts 共用）
//
// 规则搬移等价验证：userMaxBodyWidth / 分组判定 /
// tone 映射。与原 layout.ts 定义逐一对应（双轨共用一套避免漂移）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_CONT_INDENT,
  TOOL_STATUS_PREFIXES,
  TURN_SEPARATOR_CHAR,
  ACTIVITY_SEPARATOR,
  SEPARATOR,
  isToolCall,
  isStepHeader,
  NOTICE_TONE_COLOR,
  userMaxBodyWidth,
  USER_MIN_LEFT_GUTTER,
} from "../src/app/layout/content-rules.ts";

test("分组判定：无状态前缀=调用，状态前缀=辅助行", () => {
  assert.ok(isToolCall("bash run task"), "无前缀=工具调用");
  assert.ok(!isToolCall("✓ done"), "✓ 是结果行");
  assert.ok(
    !isToolCall("22:31:05 #2"),
    "step 分组头是辅助行（形制 hh:mm:ss ⇆N #M）",
  );
  assert.ok(isStepHeader("22:31:05 ⇆3 #2"), "带时间与回合号的分组头");
  assert.ok(isStepHeader("⇆3 #2"), "缺时间的分组头");
  assert.ok(isStepHeader("22:31:05 #2"), "旧形制（历史缓冲行）仍是分组头");
  assert.ok(isStepHeader("#2"), "两项都缺的分组头");
  // 护栏：回合分隔线标签（`hh:mm:ss ⇆N`，无步号）不得被认成分组头
  assert.ok(!isStepHeader("03:04:05 ⇆3"), "回合分隔线标签不是分组头");
  assert.ok(!isStepHeader("step 2"), "旧格式不再识别为分组头");
  assert.ok(!isToolCall("#2"), "缺时间的分组头同样非调用行");
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

test("常量齐全", () => {
  assert.equal(TOOL_CONT_INDENT, 2);
  assert.equal(TURN_SEPARATOR_CHAR, "╌");
  assert.equal(ACTIVITY_SEPARATOR, "─");
  assert.equal(SEPARATOR, "─");
  // 窄窗降级的最小左缘留白（竖线可见阈值 = 6 + 2 = 8）；与 DEFAULT_MESSAGE_GUTTER（默认 4）各自独立
  assert.equal(USER_MIN_LEFT_GUTTER, 6);
});
