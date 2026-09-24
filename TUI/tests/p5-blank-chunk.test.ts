// tests/p5-blank-chunk.test.ts — P5：活动区流式思考被空行打断（宿主每步的空白文本块）
//
// 回归点：宿主每个 step 末尾会补发一个只有换行的文本块（实测 190 个文本分片里
// 154 个就是 "\n\n"）。TUI 逐行落 buffer，会在思考/工具行之后留下成片空行。
// 本轮只做降级版 A′：整段仅空白 **且** 上一行是异 kind（或 buffer 为空）时丢弃；
// 同 kind 内部的空白分片维持现状（软换行与段落空行语义不变）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduceState } from "../src/app/state.ts";

/** 当前 buffer 的 kind/text 快照（便于断言"没有多余空行"） */
function snapshot(s: ReturnType<typeof initialState>): string[] {
  return s.buffer.map((l) => `${l.kind}:${l.text}`);
}

test("P5：思考分片之间的空白文本块被丢弃（异 kind → 不产生空行）", () => {
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "问题" });
  s = reduceState(s, { type: "thinking", text: "I need to check the docs to" });
  // 宿主补发的 "\n\n" 文本块（kind=assistant，与上一行 thinking 异 kind）
  s = reduceState(s, { type: "append", text: "\n\n" });
  s = reduceState(s, { type: "thinking", text: "fix the title link." });
  assert.deepEqual(snapshot(s), [
    "user:问题",
    "thinking:I need to check the docs to",
    "thinking:fix the title link.",
  ]);
});

test("P5：buffer 为空时的空白分片不产生行", () => {
  let s = initialState();
  s = reduceState(s, { type: "append", text: "\n\n" });
  assert.deepEqual(snapshot(s), [], "空 buffer + 空白分片 → 仍为空");
});

test("P5：工具行之后的空白分片被丢弃", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "ls",
  });
  const before = snapshot(s);
  s = reduceState(s, { type: "append", text: " \n\n " });
  assert.deepEqual(snapshot(s), before, "异 kind 空白分片不落行");
});

test("P5：同 kind 内部的空白分片维持现状（段落空行保留）", () => {
  let s = initialState();
  s = reduceState(s, { type: "append", text: "第一段" });
  s = reduceState(s, { type: "append", text: "\n\n" });
  s = reduceState(s, { type: "append", text: "第二段" });
  assert.deepEqual(snapshot(s), [
    "assistant:第一段",
    "assistant:",
    "assistant:第二段",
  ]);
});

test("P5：非流式 kind（user）不受影响", () => {
  let s = initialState();
  s = reduceState(s, { type: "append", text: "x" });
  s = reduceState(s, { type: "user-line", text: " " });
  assert.deepEqual(
    snapshot(s),
    ["assistant:x", "user: "],
    "user 空白行维持现状",
  );
});
