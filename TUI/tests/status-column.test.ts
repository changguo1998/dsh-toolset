// tests/status-column.test.ts — 顶部状态列渲染单测（renderStatusColumn）
//
// 覆盖：goal set（objective 目标上限 5 行 + phase + blocked 黄 tone + todo 列表
// 每条上限 3 行折叠）、无 goal/todo 占位、滚动窗口 clamp、每行定宽含右缘竖线、
// status-column-scroll reducer（PgUp/PgDn 经 index 转发）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderStatusColumn,
  STATUS_GOAL_MAX_LINES,
  STATUS_TODO_MAX_LINES,
  STATUS_COL_EMPTY,
  displayWidth,
} from "../src/app/layout.ts";
import type { GoalState } from "../src/app/state.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { TodoItemLike } from "../src/app/adapter/dsh.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

type GoalPhase = "active" | "paused" | "blocked" | "complete";

const setGoal = (
  phase: GoalPhase,
  objective: string,
  blockedReason?: { code: string; message: string },
): GoalState => ({
  status: "set",
  operation: phase === "blocked" ? "block" : "create",
  goal: { id: "g1", revision: 1, objective, phase, blockedReason },
});

function col(
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  opts: { height?: number; width?: number; scroll?: number } = {},
): string[] {
  return renderStatusColumn(
    goal,
    todos,
    opts.scroll ?? 0,
    opts.height ?? 8,
    opts.width ?? 20,
    initialState().themeId,
  ).map((l) => stripAnsi(l));
}

test("renderStatusColumn: 无 goal/todo 显示占位，每行定宽且右缘竖线", () => {
  const rows = col(undefined, undefined, { height: 3, width: 20 });
  assert.equal(rows.length, 3, "恰 height 行");
  assert.ok(rows.join("|").includes(STATUS_COL_EMPTY), "占位文案");
  for (const r of rows) {
    assert.equal(displayWidth(r), 20, "每行定宽 statusColWidth");
    assert.ok(r.endsWith("│"), "右缘竖线分隔（制表符竖线）");
  }
});

test("renderStatusColumn: goal 目标 + phase + todo 列表渲染", () => {
  const rows = col(
    setGoal("active", "实现状态列"),
    [
      { content: "渲染目标", status: "in_progress" },
      { content: "todo 列表", status: "pending" },
    ],
    { width: 24 },
  );
  const t = rows.join("\n");
  assert.ok(t.includes("目标: 实现状态列"), "objective");
  assert.ok(t.includes("阶段: active"), "phase");
  assert.ok(t.includes("todo 1/2"), "todo 计数");
  assert.ok(t.includes("[●] 渲染目标"), "进行中 [●]");
  assert.ok(t.includes("[ ] todo 列表"), "待办 [ ]");
});

test("renderStatusColumn: blocked 黄 tone 显示阻塞原因", () => {
  const rows = col(
    setGoal("blocked", "目标", { code: "x", message: "用户拒绝" }),
    [],
    { width: 24 },
  );
  assert.ok(rows.join("\n").includes("阻塞: 用户拒绝"), "阻塞原因");
});

test("renderStatusColumn: 目标超过上限折叠到 5 行并提示折叠数", () => {
  const objective = Array.from({ length: 40 }, (_, i) => `行${i}`).join(" ");
  const rows = col(setGoal("active", objective), [], { width: 10 });
  const goalLines = rows.filter((r) => r.includes("目标") || r.includes("(+"));
  // 目标标题 + 折叠提示至多 STATUS_GOAL_MAX_LINES 行（不含 phase）
  assert.ok(
    goalLines.length <= STATUS_GOAL_MAX_LINES,
    `目标最多 ${STATUS_GOAL_MAX_LINES} 行: ${rows.join("|")}`,
  );
  assert.ok(
    rows.some((r) => r.includes("(+")),
    "折叠提示含被折叠行数",
  );
});

test("renderStatusColumn: 每条 todo 超过上限折叠到 3 行", () => {
  const long = Array.from({ length: 20 }, (_, i) => `待办${i}`).join(" ");
  const rows = col(
    setGoal("active", "x"),
    [{ content: long, status: "pending" }],
    { width: 12 },
  );
  const body = rows.join("\n");
  // 过滤纯右缘竖线的空行：行尾竖线前的部分 trim 为空才算空行
  const todoLines = body
    .split("\n")
    .filter((r) => r.replace(/[│|]$/, "").trim() !== "");
  // 目标 1 + 阶段 1 + todo 计数 1 + 该条至多 3 行
  assert.ok(todoLines.length <= 6, `条目上限内: ${todoLines.length} 行`);
  assert.ok(body.includes("(+"), "todo 折叠提示");
});

test("renderStatusColumn: 滚动窗口 clamp——超长内容可下滚看更晚条目", () => {
  const todos: TodoItemLike[] = Array.from({ length: 10 }, (_, i) => ({
    content: `任务${i}`,
    status: "pending",
  }));
  // 高 4 行：首屏只看到顶部（任务0 开头），滚动后看到任务0 消失、任务9 出现
  const top = col(setGoal("active", "目标"), todos, {
    height: 4,
    width: 20,
    scroll: 0,
  });
  assert.ok(top.join("|").includes("任务0"), "首屏含最早任务");
  const scrolled = col(setGoal("active", "目标"), todos, {
    height: 4,
    width: 20,
    scroll: 99,
  });
  assert.ok(!scrolled.join("|").includes("任务0"), "下滚后最早任务移出");
  assert.ok(scrolled.join("|").includes("任务9"), "下滚后显示最晚任务");
});

test("status-column-scroll reducer: delta 累加且 clamp 非负", () => {
  let s = initialState();
  s = reduceState(s, { type: "status-column-scroll", delta: 10 });
  assert.equal(s.statusColumnScroll, 10);
  s = reduceState(s, { type: "status-column-scroll", delta: -3 });
  assert.equal(s.statusColumnScroll, 7);
  s = reduceState(s, { type: "status-column-scroll", delta: -99 });
  assert.equal(s.statusColumnScroll, 0, "clamp 到 0");
});
