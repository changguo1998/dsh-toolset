// tests/p8-compaction-active.test.ts — P8：会话压缩期间算作 active
//
// 口径（docs/PENDING-FIXES.md P8）：
//  1. `compaction/start` → 该会话标记压缩中；`compaction/end` → 清除；
//  2. 压缩期间用户块符号显示「进行中」●/○（不是 ?）；
//  3. 压缩期间 Ctrl+D 退出守卫不触发（`canExitOnCtrlD`）；
//  4. 压缩期间新消息走排队（`App.agentBusy`，见 app.test.ts 的 App 级用例）；
//  5. Esc 中断语义不变。
// 驱动 reducer 直接断言状态与渲染，不依赖 App 外壳。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, isCompacting, reduceState } from "../src/app/state.ts";
import { canExitOnCtrlD } from "../src/app/index.ts";
import { buildFrame } from "../src/app/layout.ts";
import { rowText } from "./helpers/rowText.ts";

/** 活跃会话 s1 + 一条用户输入（产生一个用户块，供符号断言） */
function withUser(): ReturnType<typeof initialState> {
  let s = initialState();
  s.activeSessionId = "s1";
  s = reduceState(s, { type: "user-line", text: "问一句" });
  return s;
}

test("P8：compaction start 标记当前会话、end 清除", () => {
  let s = withUser();
  assert.equal(isCompacting(s), false, "初始未压缩");
  s = reduceState(s, { type: "compaction", phase: "start" });
  assert.equal(isCompacting(s), true, "start 后标记压缩中");
  s = reduceState(s, { type: "compaction", phase: "end" });
  assert.equal(isCompacting(s), false, "end 后清除");
  assert.deepEqual(s.compactingBySession, {}, "end 不留 false 残留项");
});

test("P8：压缩标记按会话隔离（非活跃会话不影响当前视图）", () => {
  let s = withUser();
  s = reduceState(s, {
    type: "compaction",
    phase: "start",
    sessionId: "other",
  });
  assert.equal(isCompacting(s), false, "别的会话压缩不影响当前活跃会话");
  assert.equal(s.compactingBySession["other"], true, "标记仍按会话记录");
  // 切到 other 会话后即视为压缩中
  s.activeSessionId = "other";
  assert.equal(isCompacting(s), true, "切到该会话后算压缩中");
});

test("P8：压缩期间用户块显示进行中符号（●/○ 而非 ?）", () => {
  const markOf = (s: ReturnType<typeof initialState>): string => {
    const row =
      buildFrame(s, { rows: 24, cols: 80 })
        .map((r) => rowText(r))
        .find((t) => t.includes("问一句")) ?? "";
    // 只认「符号 + 空格 + 用户文本」——行左侧状态列里也有 ✓/✗（开关项），不能取首个
    return /([✓✗■●○△?]) 问一句/.exec(row)?.[1] ?? "";
  };
  let s = withUser();
  assert.equal(markOf(s), "?", "空闲且无终态 → 回退占位 ?");
  s = reduceState(s, { type: "compaction", phase: "start" });
  assert.ok(
    ["●", "○"].includes(markOf(s)),
    `压缩中显示进行中圆点（实际 ${markOf(s)}）`,
  );
  s = reduceState(s, { type: "compaction", phase: "end" });
  assert.equal(markOf(s), "?", "压缩结束后回到 ?（该块仍无终态）");
});

test("P8：Ctrl+D 退出守卫——压缩期间不退出", () => {
  let s = withUser();
  // 空闲 + 输入区为空 → 可退出
  assert.equal(canExitOnCtrlD(s), true, "空闲且输入为空可退出");
  s = reduceState(s, { type: "compaction", phase: "start" });
  assert.equal(canExitOnCtrlD(s), false, "压缩期间不退出");
  s = reduceState(s, { type: "compaction", phase: "end" });
  assert.equal(canExitOnCtrlD(s), true, "压缩结束恢复可退出");
  // 输入非空 / agent 忙 仍不退出（既有口径）
  let t = withUser();
  t = reduceState(t, { type: "input", text: "草稿", cursor: 2 });
  assert.equal(canExitOnCtrlD(t), false, "输入非空不退出");
  let u = withUser();
  u = reduceState(u, { type: "agent-status", status: "thinking" });
  assert.equal(canExitOnCtrlD(u), false, "agent 忙不退出");
});
