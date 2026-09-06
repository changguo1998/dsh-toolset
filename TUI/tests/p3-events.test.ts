// tests/p3-events.test.ts — P3 事件显示增强（workflow/command/code-dispatch/hook/
// schedule/compaction-prune/feedback）reducer 层测试：断言缓冲行文本与 tone。
//
// 归一化（raw session 事件 → DshEvent）由 adapter.dsh.test.ts 覆盖；本文件只测
// state 层（reduceState 对已归一化事件的展示决策）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduceState } from "../src/app/state.ts";
import type { AppState, BufferLine } from "../src/app/state.ts";

const sid = "s1";

function fresh(): AppState {
  return initialState();
}

/** 取 buffer 中 kind=tool 或 notice 的末行 */
function lastLine(
  s: AppState,
  kind: "tool" | "notice",
): BufferLine | undefined {
  return [...s.buffer].reverse().find((l) => l.kind === kind);
}

test("workflow：run-start/agent-start/agent-end 活动区行 + run-end toast", () => {
  let s = fresh();
  s = reduceState(s, {
    type: "workflow",
    sessionId: sid,
    phase: "run-start",
    label: "research",
  });
  assert.equal(lastLine(s, "tool")?.text, "⚑ workflow: research");
  s = reduceState(s, {
    type: "workflow",
    sessionId: sid,
    phase: "agent-start",
    label: "reviewer",
    detail: "1",
  });
  assert.equal(lastLine(s, "tool")?.text, "⤷ reviewer");
  s = reduceState(s, {
    type: "workflow",
    sessionId: sid,
    phase: "agent-end",
    label: "",
    detail: "1 success",
  });
  assert.equal(lastLine(s, "tool")?.text, "↩ #1 success");
  assert.equal(lastLine(s, "tool")?.tone, "muted");
  s = reduceState(s, {
    type: "workflow",
    sessionId: sid,
    phase: "run-end",
    label: "",
    detail: "completed",
  });
  assert.equal(lastLine(s, "notice")?.text, "workflow 结束 (completed)");
  assert.equal(lastLine(s, "notice")?.tone, "muted");
});

test("workflow agent-start 无 label 回落 #seq", () => {
  const s = reduceState(fresh(), {
    type: "workflow",
    sessionId: sid,
    phase: "agent-start",
    label: "",
    detail: "3",
  });
  assert.equal(lastLine(s, "tool")?.text, "⤷ #3");
});

test("command：run 行 + 失败红行；成功静默", () => {
  let s = fresh();
  s = reduceState(s, {
    type: "command",
    sessionId: sid,
    phase: "run",
    name: "goal",
  });
  assert.equal(lastLine(s, "tool")?.text, "/> goal");
  // 成功 done：静默（结果由命令自身 notice 呈现，避免重复）
  const before = s.buffer.length;
  s = reduceState(s, {
    type: "command",
    sessionId: sid,
    phase: "done",
    name: "goal",
    ok: true,
  });
  assert.equal(s.buffer.length, before);
  // 失败 done：红行
  s = reduceState(s, {
    type: "command",
    sessionId: sid,
    phase: "done",
    name: "policy",
    text: "审批策略服务不可用",
    ok: false,
  });
  assert.equal(lastLine(s, "tool")?.text, "✗ /policy: 审批策略服务不可用");
  assert.equal(lastLine(s, "tool")?.tone, "error");
});

test("code-dispatch：start 行；settle 成功静默、失败红行", () => {
  let s = fresh();
  s = reduceState(s, {
    type: "code-dispatch",
    sessionId: sid,
    phase: "start",
    name: "read",
    summary: "src/app/index.ts",
    ok: true,
  });
  assert.equal(lastLine(s, "tool")?.text, "⇥ read src/app/index.ts");
  const before = s.buffer.length;
  s = reduceState(s, {
    type: "code-dispatch",
    sessionId: sid,
    phase: "settle",
    name: "read",
    summary: "",
    ok: true,
  });
  assert.equal(s.buffer.length, before);
  s = reduceState(s, {
    type: "code-dispatch",
    sessionId: sid,
    phase: "settle",
    name: "write",
    summary: "",
    ok: false,
  });
  assert.equal(lastLine(s, "tool")?.text, "✗ write");
  assert.equal(lastLine(s, "tool")?.tone, "error");
});

test("hook：invoked 行 + result 失败红行", () => {
  let s = fresh();
  s = reduceState(s, {
    type: "hook",
    sessionId: sid,
    phase: "invoked",
    point: "PreToolUse",
    ok: true,
  });
  assert.equal(lastLine(s, "tool")?.text, "⌗ PreToolUse");
  assert.equal(lastLine(s, "tool")?.tone, "muted");
  s = reduceState(s, {
    type: "hook",
    sessionId: sid,
    phase: "result",
    point: "PreToolUse",
    decision: "block",
    ok: false,
  });
  assert.equal(lastLine(s, "tool")?.text, "✗ PreToolUse (block)");
  assert.equal(lastLine(s, "tool")?.tone, "error");
});

test("schedule：仅 dispatch 提示；create/delete 静默", () => {
  let s = fresh();
  s = reduceState(s, {
    type: "schedule",
    sessionId: sid,
    operation: "create",
    id: "s1",
  });
  assert.equal(s.buffer.length, 0);
  s = reduceState(s, {
    type: "schedule",
    sessionId: sid,
    operation: "dispatch",
    id: "s1",
  });
  assert.equal(lastLine(s, "notice")?.text, "计划提醒触发");
});

test("compaction-prune 计数 toast", () => {
  const s = reduceState(fresh(), {
    type: "compaction-prune",
    sessionId: sid,
    nodeCount: 42,
    tokenCount: 36000,
  });
  assert.equal(
    lastLine(s, "notice")?.text,
    "压缩：已剪除 42 个节点 (~36000 tok)",
  );
});

test("feedback 记录确认 toast", () => {
  const s = reduceState(fresh(), {
    type: "feedback",
    sessionId: sid,
    text: "很好用",
  });
  assert.equal(lastLine(s, "notice")?.text, "反馈已记录");
});
test("retry-started：↻ 启动灰行（attempt）", () => {
  const s = reduceState(fresh(), {
    type: "retry-started",
    sessionId: sid,
    attempt: 1,
  });
  assert.equal(lastLine(s, "tool")?.text, "↻ 重试中 (1)");
  assert.equal(lastLine(s, "tool")?.tone, "muted");
});
