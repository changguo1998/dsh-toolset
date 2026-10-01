// tests/step.test.ts — step 分步分割线（#7 起：step/start 即画）
//
// 直接驱动 reducer 断言 buffer 内容（工具行 ○/✓/✗ 与 `hh:mm:ss #N` 分割线均为
// kind="tool" 的纯文本行，不依赖渲染）。覆盖四类语义：
//   1. 分割线时机：`step/start` 到达即产线（每步都画，含首个 step 与无工具调用的 step）
//   2. 同一步不重复：组内工具行不再插头
//   3. step/end 关组；防御：前一 step 未关又到 step/start 时新线照产
//   4. 无 step 事件（旧会话 / mock）时工具行不产线，保持 append-only

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduceState } from "../src/app/state.ts";
import type { StateAction } from "../src/app/state.ts";
import { stepHeaderLine } from "../src/app/layout/tool-line.ts";

/** 顺序执行一串 action，返回最终 buffer 的纯文本行 */
function run(actions: StateAction[]): string[] {
  let s = initialState();
  for (const a of actions) s = reduceState(s, a);
  return s.buffer.map((l) => l.text);
}

/** 固定时间戳（本地时间 03:04:05）——分组头文本可精确断言 */
const T0 = new Date(2026, 0, 2, 3, 4, 5).getTime();
const stepStart = (step: number, time = T0): StateAction => ({
  type: "step",
  sessionId: "s1",
  turn: 1,
  step,
  phase: "start",
  time,
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

test("B3 分组头插入：step 内首条工具行前插 `hh:mm:ss #N`，同组不重复", () => {
  const lines = run([
    stepStart(1),
    toolCall("ls -la src/app"),
    toolOk("总用量 3 目录"),
    toolCall("pwd"),
  ]);
  assert.deepEqual(lines, [
    "03:04:05 #1",
    "bash ls -la src/app",
    "✓ 总用量 3 目录",
    "bash pwd",
  ]);
});

test("B3 每步都画：无工具调用的 step 也产线（#7 的真分割线口径）", () => {
  const lines = run([stepStart(5), stepEnd(5)]);
  assert.deepEqual(lines, ["03:04:05 #5"]);
});

test("B3 分割线跟随 step/end 关闭：结束后工具行不再产线", () => {
  const lines = run([
    stepStart(1),
    toolCall("ls"),
    stepEnd(1),
    toolErr("EACCES: 13"),
  ]);
  assert.deepEqual(lines, ["03:04:05 #1", "bash ls", "✗ EACCES: 13"]);
});

test("B3 防御 flush：活动组未关又到 step/start 时新组另起分组头", () => {
  const lines = run([
    stepStart(1),
    toolCall("ls"),
    stepStart(2), // 前一 step 未发 step/end（防御分支）
    toolCall("rm -rf /tmp/tui-demo"),
  ]);
  assert.deepEqual(lines, [
    "03:04:05 #1",
    "bash ls",
    "03:04:05 #2",
    "bash rm -rf /tmp/tui-demo",
  ]);
});

test("B3 向后兼容：无 step 上下文（旧会话/mock）工具行不插头", () => {
  const lines = run([toolCall("ls"), toolOk("d")]);
  assert.deepEqual(lines, ["bash ls", "✓ d"]);
});

test("B3 失败工具结果也参与分组：分组头先行", () => {
  const lines = run([stepStart(2), toolErr("EACCES: 13")]);
  assert.deepEqual(lines, ["03:04:05 #2", "✗ EACCES: 13"]);
});

test("B3 每步一条线：step/start 各自产线，工具行不产线", () => {
  // 无 step 上下文的会话，工具行照旧不产线（append-only 兼容）
  const lines = run([
    stepStart(1), // s1 的 step
    { type: "tool-call", sessionId: "s2", name: "bash", summary: "whoami" },
  ]);
  assert.deepEqual(lines, ["03:04:05 #1", "bash whoami"]);
  // 两个会话各自 step/start → 各产一条线（线与 step 一一对应）
  const lines2 = run([
    stepStart(1), // s1 组
    {
      type: "step",
      sessionId: "s2",
      turn: 1,
      step: 3,
      phase: "start",
      time: T0,
    },
    { type: "tool-call", sessionId: "s2", name: "bash", summary: "pwd" },
  ]);
  assert.deepEqual(lines2, ["03:04:05 #1", "03:04:05 #3", "bash pwd"]);
  // s1 的 step/end 后进行下一个 step：新线照产
  const lines3 = run([
    stepStart(1),
    { type: "step", sessionId: "s1", turn: 1, step: 1, phase: "end" },
    stepStart(2), // s1 新 step
    { type: "tool-call", sessionId: "s1", name: "bash", summary: "env" },
  ]);
  assert.deepEqual(lines3, ["03:04:05 #1", "03:04:05 #2", "bash env"]);
});

test("B3 思考拖尾换行保留下一个「换行锚点」空段（渲染层跳过空思考行）", () => {
  // 流式增量以 \n 结尾：appendStream 在 buffer 留下空 thinking 段作下一增量的续行锚点
  // （否则下一小段会错误拼接进本行）；该空段在渲染层（layout）被跳过，不显示为空行。
  const lines = run([
    stepStart(1),
    toolCall("ls"),
    toolOk("ok"),
    { type: "thinking", text: "好的，下一步执行\n" },
  ]);
  assert.deepEqual(lines, [
    "03:04:05 #1",
    "bash ls",
    "✓ ok",
    "好的，下一步执行",
    "",
  ]);
  // 下一思考增量合并进锚点空段 → 独立成行而非拼接
  const lines2 = run([
    { type: "thinking", text: "第一段\n" },
    { type: "thinking", text: "第二段\n" },
  ]);
  assert.deepEqual(lines2, ["第一段", "第二段", ""]);
});

test("P6 分组头文本：`hh:mm:ss #N`（24 小时制、步号不补零；缺时间只出 `#N`）", () => {
  assert.equal(stepHeaderLine(3, T0), "03:04:05 #3");
  assert.equal(stepHeaderLine(123, T0), "03:04:05 #123");
  // 下午时间用 24 小时制（本地时区 15:04:05）
  const pm = new Date(2026, 0, 2, 15, 4, 5).getTime();
  assert.equal(stepHeaderLine(1, pm), "15:04:05 #1");
  assert.equal(stepHeaderLine(7, undefined), "#7", "缺时间不设占位");
});

test("P6 事件缺 time：分组头回退当前时刻（mock / 合成事件）", () => {
  const before = Date.now();
  const lines = run([
    { type: "step", sessionId: "s1", turn: 1, step: 7, phase: "start" },
    toolCall("ls"),
  ]);
  const head = lines[0]!;
  assert.match(head, /^\d{2}:\d{2}:\d{2} #7$/, `回退当前时刻: ${head}`);
  // 回退时刻不早于调用前、不晚于调用后（允许 1s 粒度误差）
  const hms = head.slice(0, 8);
  const d = new Date(before);
  const expectLow = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  assert.ok(
    hms.startsWith(expectLow),
    `时钟接近调用时刻: ${hms} vs ${expectLow}`,
  );
});
