// tests/step.test.ts — P2 阶段 B3：step 分步（工具行分组头）
//
// 直接驱动 reducer 断言 buffer 内容（工具行 ○/✓/✗ 与 `step N` 分组头均为
// kind="tool" 的纯文本行，不依赖渲染）。覆盖四类语义：
//   1. 分组头插入：step 内首条工具行前插 `step N`，且不重复
//   2. 无工具 step 静默：不产生任何输出
//   3. step/end 关组：结束后工具行不再有分组头
//   4. 防御 flush：活动组未关又到 step/start 时，新组另起分组头
// 另含向后兼容：无 step 上下文（旧会话/mock）时不插头。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduceState } from "../src/app/state.ts";
import type { StateAction } from "../src/app/state.ts";

/** 顺序执行一串 action，返回最终 buffer 的纯文本行 */
function run(actions: StateAction[]): string[] {
  let s = initialState();
  for (const a of actions) s = reduceState(s, a);
  return s.buffer.map((l) => l.text);
}

const stepStart = (step: number): StateAction => ({
  type: "step",
  sessionId: "s1",
  turn: 1,
  step,
  phase: "start",
});
const stepEnd = (step: number): StateAction => ({
  type: "step",
  sessionId: "s1",
  turn: 1,
  step,
  phase: "end",
});
const toolCall = (summary: string): StateAction => ({
  type: "tool-call",
  sessionId: "s1",
  name: "bash",
  summary,
});
const toolOk = (detail: string): StateAction => ({
  type: "tool-result",
  sessionId: "s1",
  ok: true,
  detail,
});
const toolErr = (detail: string): StateAction => ({
  type: "tool-result",
  sessionId: "s1",
  ok: false,
  detail,
});

test("B3 分组头插入：step 内首条工具行前插 `step N`，同组不重复", () => {
  const lines = run([
    stepStart(1),
    toolCall("ls -la src/app"),
    toolOk("总用量 3 目录"),
    toolCall("pwd"),
  ]);
  assert.deepEqual(lines, [
    "step 1",
    "bash ls -la src/app",
    "✓ 总用量 3 目录",
    "bash pwd",
  ]);
});

test("B3 无工具 step 静默：step/start→end 无工具调用不产生任何行", () => {
  const lines = run([stepStart(5), stepEnd(5)]);
  assert.equal(lines.length, 0);
});

test("B3 分组头跟随 step/end 关闭：结束后工具行不再插头", () => {
  const lines = run([
    stepStart(1),
    toolCall("ls"),
    stepEnd(1),
    toolErr("EACCES: 13"),
  ]);
  assert.deepEqual(lines, ["step 1", "bash ls", "✗ EACCES: 13"]);
});

test("B3 防御 flush：活动组未关又到 step/start 时新组另起分组头", () => {
  const lines = run([
    stepStart(1),
    toolCall("ls"),
    stepStart(2), // 前一 step 未发 step/end（防御分支）
    toolCall("rm -rf /tmp/tui-demo"),
  ]);
  assert.deepEqual(lines, [
    "step 1",
    "bash ls",
    "step 2",
    "bash rm -rf /tmp/tui-demo",
  ]);
});

test("B3 向后兼容：无 step 上下文（旧会话/mock）工具行不插头", () => {
  const lines = run([toolCall("ls"), toolOk("d")]);
  assert.deepEqual(lines, ["bash ls", "✓ d"]);
});

test("B3 失败工具结果也参与分组：分组头先行", () => {
  const lines = run([stepStart(2), toolErr("EACCES: 13")]);
  assert.deepEqual(lines, ["step 2", "✗ EACCES: 13"]);
});

test("B3 会话隔离：旧会话 step 组不误插当前会话工具行分组头", () => {
  // s1 的活动 step 组未关；s2 首条工具行不得插入 `step 1`（stepGroup 带 sessionId）
  const lines = run([
    stepStart(1), // s1 组
    { type: "tool-call", sessionId: "s2", name: "bash", summary: "whoami" },
  ]);
  assert.deepEqual(lines, ["bash whoami"]);
  // s2 自己有 step 上下文时才正常分组
  const lines2 = run([
    stepStart(1), // s1 组
    { type: "step", sessionId: "s2", turn: 1, step: 3, phase: "start" },
    { type: "tool-call", sessionId: "s2", name: "bash", summary: "pwd" },
  ]);
  assert.deepEqual(lines2, ["step 3", "bash pwd"]);
  // s1 的 step/end 只关 s1 组，不影响 s2
  const lines3 = run([
    stepStart(1),
    { type: "step", sessionId: "s1", turn: 1, step: 1, phase: "end" },
    stepStart(2), // s1 新组
    { type: "tool-call", sessionId: "s1", name: "bash", summary: "env" },
  ]);
  assert.deepEqual(lines3, ["step 2", "bash env"]);
});
