// tests/goalpanel.test.ts — /goal 迷你面板渲染单测（纯函数 renderGoalPanel）
//
// 覆盖：goal set（objective 标题 + phase 徽标 + todo 列表按状态着色标记）、
// blocked 黄 tone、clear/缺失占位、超长滚动窗口 clamp、行数占满 body。

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderGoalPanel } from "../src/app/components/GoalPanel.ts";
import { displayWidth } from "../src/app/layout.ts";
import type { GoalState } from "../src/app/state.ts";
import type { TodoItemLike } from "../src/app/adapter/dsh.ts";
import { initialState, reduceState } from "../src/app/state.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function panel(
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  opts: { height?: number; width?: number; scroll?: number } = {},
): string[] {
  return renderGoalPanel({
    goal,
    todos,
    scroll: opts.scroll ?? 0,
    height: opts.height ?? 8,
    width: opts.width ?? 60,
    themeId: initialState().themeId,
  }).map((l) => stripAnsi(l.text));
}

type GoalPhase = "active" | "paused" | "blocked" | "complete";

const setGoal = (
  phase: GoalPhase,
  blockedReason?: {
    code: string;
    message: string;
  },
): GoalState => ({
  status: "set",
  operation: phase === "blocked" ? "block" : "create",
  goal: {
    id: "g1",
    revision: 1,
    objective: "实现 P2 阶段 B1+B2：/goal 面板与状态栏模式徽标",
    phase,
    blockedReason,
  },
});

test("renderGoalPanel: 输出恰 height 行，首行为标题", () => {
  const rows = panel(setGoal("active"), []);
  assert.equal(rows.length, 8, "恰 height 行");
  assert.ok(rows[0]!.includes("当前目标"), "首行标题");
  assert.ok(rows[0]!.includes("[Esc]关闭"), "标题含按键提示");
});

test("renderGoalPanel: objective 与 phase 徽标 + todo 计数/标记着色", () => {
  const rows = panel(setGoal("active"), [
    { content: "状态栏徽标", status: "in_progress" },
    { content: "面板", status: "pending" },
    { content: "模式徽标", status: "completed" },
  ]);
  const t = rows.join("\n");
  assert.ok(t.includes("目标: 实现 P2 阶段 B1+B2"), "objective 标题");
  assert.ok(t.includes("阶段: active"), "phase 徽标");
  assert.ok(t.includes("todo 1/3"), "todo in_progress 1/共3");
  assert.ok(t.includes("[●] 状态栏徽标"), "进行中 [●]");
  assert.ok(t.includes("[ ] 面板"), "待办 [ ]");
  assert.ok(t.includes("[x] 模式徽标"), "完成 [x]");
});

test("renderGoalPanel: blocked 黄 tone 显示 blockedReason.message", () => {
  const rows = renderGoalPanel({
    goal: setGoal("blocked", {
      code: "user-said-no",
      message: "用户拒绝了方案",
    }),
    todos: [],
    scroll: 0,
    height: 8,
    width: 60,
    themeId: initialState().themeId,
  }).map((l) => l.text); // 保留 ANSI，验证着色
  const plain = rows.map((l) => stripAnsi(l));
  assert.ok(
    plain.join("\n").includes("阻塞: 用户拒绝了方案"),
    "blocked message",
  );
  const blockedRow = rows.find((l) => stripAnsi(l).includes("阻塞:")) ?? "";
  assert.ok(
    /\x1b\[[0-9;]*m/.test(blockedRow),
    "blocked 行应有 ANSI 着色 (黄 tone)",
  );
});

test("renderGoalPanel: cleared/缺失 → 面板清空占位", () => {
  const cleared: GoalState = {
    status: "cleared",
    operation: "clear",
    cleared: { id: "g1" },
  };
  const a = panel(cleared, undefined);
  assert.ok(a.join("\n").includes("（当前会话无 goal）"), "clear 占位");
  const b = panel(undefined, undefined);
  assert.ok(b.join("\n").includes("（当前会话无 goal）"), "缺失占位");
});

test("renderGoalPanel: 长列表滚动窗口 clamp（scroll 超界收敛）", () => {
  const todos: TodoItemLike[] = Array.from({ length: 20 }, (_, i) => ({
    content: `任务 ${i}`,
    status: i % 2 === 0 ? "in_progress" : "pending",
  }));
  const rows = panel(setGoal("active"), todos, { height: 6, scroll: 999 });
  const body = rows.slice(1).join("\n");
  assert.ok(
    !body.includes("任务 0"),
    "scroll 超界 → 窗口落在末尾（首项已滚出）",
  );
  assert.ok(body.includes("任务 19"), "窗口末尾可见最后一项");
  const firstSeg = rows.slice(1).find((r) => r !== "") ?? "";
  const idx = parseInt(firstSeg.match(/任务 (\d+)/)?.[1] ?? "-1", 10);
  assert.ok(idx >= 15, `clamp 后起点在 len-rows 内 (${idx})`);
});

test("renderGoalPanel: 长 objective 换行不超宽", () => {
  const rows = panel(setGoal("active"), [], { width: 30 });
  for (const r of rows) assert.ok(displayWidth(r) <= 30, `行不超宽 (${r})`);
});

// **state reducer：goal-panel 开/关/滚动 + stale guard**（附于本文件，减少文件数）
test("reduceState: goal-panel-open/scroll/close 与 stale guard", () => {
  let s = reduceState(initialState(), { type: "goal-panel-open" });
  assert.ok(s.goalPanel, "open 后 goalPanel 非空");
  // scroll 累加
  s = reduceState(s, { type: "goal-panel-scroll", delta: 3 });
  assert.equal(s.goalPanel?.scroll, 3);
  // 负数 clamp 到 0
  s = reduceState(s, { type: "goal-panel-scroll", delta: -5 });
  assert.equal(s.goalPanel?.scroll, 0);
  // 关闭后 scroll 丢弃（stale guard，返回原对象引用）
  s = reduceState(s, { type: "goal-panel-close" });
  const closed = s;
  const again = reduceState(closed, { type: "goal-panel-scroll", delta: 1 });
  assert.equal(again, closed, "面板关闭后迟到 scroll 返回原 state");
});
