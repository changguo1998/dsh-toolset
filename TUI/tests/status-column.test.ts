// tests/status-column.test.ts — 顶部状态列渲染单测（renderStatusColumn）
//
// 覆盖：goal set（`Goal <phase>` 蓝标题+phase 状态色 + objective 目标上限 5 行 +
// blocked 黄 tone + todo 列表每条上限 3 行折叠）、无 goal/todo 占位、滚动窗口 clamp、
// 每行定宽含右缘竖线、status-column-scroll reducer（PgUp/PgDn 经 index 转发）。
// 2026-09-07 追加 Mode 块：会话运行模式/权限/策略（原水平状态栏徽标迁入，列出全部
// 可选项、生效项着色、其余灰）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderStatusColumn,
  STATUS_GOAL_MAX_LINES,
  STATUS_COL_EMPTY,
  displayWidth,
} from "../src/app/layout.ts";
import type { GoalState, ModeState } from "../src/app/state.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { JobInfo, TodoItemLike } from "../src/app/adapter/dsh.ts";

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
  jobs?: JobInfo[],
): string[] {
  return renderStatusColumn(
    goal,
    todos,
    jobs,
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
  assert.ok(t.includes("Goal active"), "goal 标题=Goal+phase");
  assert.ok(t.includes("实现状态列"), "objective 无「目标:」前缀");
  assert.ok(t.includes("Todo 0/2"), "todo 标题=完成数/总数");
  assert.ok(t.includes("● 渲染目标"), "进行中 ● 实心圆标记");
  assert.ok(t.includes("○ todo 列表"), "待办 ○ 空心圆标记");
});

test("renderStatusColumn: 完成 todo 灰+删除线，jobs 块展示", () => {
  const rows = col(
    setGoal("active", "目标"),
    [
      { content: "已完成项", status: "completed" },
      { content: "排队项", status: "pending" },
    ],
    { width: 24, height: 12 },
    [
      { id: "j1", kind: "bash", label: "跑测试", status: "running" },
      { id: "j2", kind: "bash", label: "构建", status: "failed" },
      { id: "j3", kind: "bash", label: "发布", status: "done" },
    ],
  );
  const t = rows.join("\n");
  assert.ok(t.includes("Todo 1/2"), "todo completed 计数");
  assert.ok(t.includes("✓ 已完成项"), "完成 ✓ 标记");
  assert.ok(t.includes("○ 排队项"), "待办 ○ 空心圆标记");
  assert.ok(t.includes("Jobs 1/3"), "jobs 运行中/总数标题");
  assert.ok(t.includes("● 跑测试"), "运行中 ● 行");
  assert.ok(t.includes("✗ 构建"), "失败 ✗ 行");
  assert.ok(t.includes("✓ 发布"), "完成 ✓ 行");
  // done 任务正文灰+删除线（与 todo completed 一致）：在未 strip 的原始行上断言
  // strike(9m) 出现在对号之后（删除线不覆盖对号）
  const rawDone = renderStatusColumn(
    setGoal("active", "目标"),
    [
      { content: "已完成项", status: "completed" },
      { content: "排队项", status: "pending" },
    ],
    [
      { id: "j1", kind: "bash", label: "跑测试", status: "running" },
      { id: "j3", kind: "bash", label: "发布", status: "done" },
    ],
    0,
    12,
    24,
    initialState().themeId,
  ).find((r) => r.includes("发布"))!;
  assert.ok(
    rawDone.includes("9m") && rawDone.indexOf("9m") > rawDone.indexOf("✓"),
    "done 正文灰+删除线且不覆盖对号: " + rawDone,
  );
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
  const goalLines = rows.filter((r) => /行\d/.test(r) || r.includes("(+"));
  // objective 行 + 折叠提示至多 STATUS_GOAL_MAX_LINES 行（不含 Goal 标题行）
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
  // Goal 标题 1 + 目标 1 + 块间虚线 1 + todo 计数 1 + 该条至多 3 行（2026-09-17 加块间虚线）
  assert.ok(todoLines.length <= 7, `条目上限内: ${todoLines.length} 行`);
  assert.ok(body.includes("(+"), "todo 折叠提示");
});

test("renderStatusColumn: 整体高度未溢出时内容完整显示（不折叠、不隐藏完成）", () => {
  const rows = col(
    setGoal("active", "目标一、目标二、目标三"),
    [
      { content: "完成的任务 A", status: "completed" },
      { content: "待办较长内容（演示未溢出时不截断且续行缩进）", status: "pending" },
    ],
    { width: 16, height: 20 },
  );
  const t = rows.join("\n");
  assert.ok(t.includes("目标三"), "目标完整显示不折叠");
  assert.ok(t.includes("完成的任务 A"), "高度充足时已完成任务不隐藏");
  assert.ok(t.includes("行缩进"), "长内容续行完整（不截断，文本跨行也保留）");
  assert.ok(!t.includes("(+"), "未溢出时不出现折叠提示");
});

test("renderStatusColumn: 溢出时优先隐藏已完成任务（计数标题仍含）", () => {
  const rows = col(
    setGoal("active", "目标"),
    [
      { content: "完成的任务 A", status: "completed" },
      { content: "完成的任务 B", status: "completed" },
      { content: "待办任务 C", status: "pending" },
      { content: "待办任务 D", status: "pending" },
    ],
    { width: 16, height: 7 }, // Goal+目标+虚线+标题+2 待办=6 行；completed 被优先隐藏
    [{ id: "j1", kind: "bash", label: "跑测试", status: "running" }],
  );
  const t = rows.join("\n");
  assert.ok(t.includes("Todo 2/4"), "计数标题仍含完成数（隐藏的是行不是计数）");
  assert.ok(!t.includes("完成的任务"), "已完成任务行被优先隐藏");
  assert.ok(t.includes("待办任务 C") && t.includes("待办任务 D"), "未完成任务保留");
});

test("renderStatusColumn: 滚动窗口 clamp——超长内容可下滚看更晚条目", () => {
  const todos: TodoItemLike[] = Array.from({ length: 10 }, (_, i) => ({
    content: `任务${i}`,
    status: "pending",
  }));
  // 高 5 行（Goal 标题/目标/块间虚线/计数 + 1 条任务）：首屏看到顶部（任务0 开头），
  // 滚动后看到任务0 消失、任务9 出现
  const top = col(setGoal("active", "目标"), todos, {
    height: 5,
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

// ===== Mode 块：会话运行模式/权限/策略（原水平状态栏徽标迁入，2026-09-07）=====

test("renderStatusColumn: Mode 块在无 goal 时也展示且位于最前；各项目列出全部可选项", () => {
  const mode: ModeState = {
    plan: "on",
    sandbox: "read-only",
    permission: "danger-full-access",
  };
  const rows = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    8,
    30,
    initialState().themeId,
    mode,
    "ask",
    "claude",
  ).map((l) => stripAnsi(l));
  const t = rows.join("\n");
  assert.ok(t.includes("Mode"), "Mode 块标题存在（无 goal 也显示）");
  assert.ok(
    t.indexOf("Mode") < t.indexOf("（无目标/待办）"),
    "Mode 块位于占位/Goal 之前",
  );
  assert.ok(t.includes("plan off on"), "plan 列出 off/on 全部可选项");
  assert.ok(t.includes("sandbox ro wr full"), "sandbox 列出 ro/wr/full");
  assert.ok(
    t.includes("permission ro wr full"),
    "permission 独立列出全部可选项（不与 sandbox 合并省略）",
  );
  assert.ok(t.includes("policy ask auto"), "policy 列出 ask/auto");
  assert.ok(t.includes("preset claude"), "preset 显示当前值");
});

test("renderStatusColumn: Mode 生效项着色强调、其余灰（同行内不同 SGR）", () => {
  const raw = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    8,
    34,
    initialState().themeId,
    { plan: "on", sandbox: "read-only", permission: "read-only" },
    "never",
    undefined,
  );
  // 忽略定宽补齐用的白色 SGR（255;255;255），只统计各选项着色
  const sgr = (l: string): string[] =>
    [...l.matchAll(/\x1b\[38;2;(?!255;255;255)[\d;]+m/g)].map((m) => m[0]);
  const sandbox = raw.find((l) => l.includes("sandbox"))!;
  const policy = raw.find((l) => l.includes("policy"))!;
  // sandbox 行 ro(生效绿)、wr/full(灰)：三个选项各有着色，生效与灰不同色
  assert.equal(sgr(sandbox).length, 3, "sandbox 三个选项各有着色");
  assert.notEqual(
    sgr(sandbox)[0],
    sgr(sandbox)[1],
    "sandbox ro 生效项与灰选项不同色",
  );
  // policy=never → auto 生效（红）与 ask(灰) 不同色
  assert.equal(sgr(policy).length, 2, "policy ask/auto 各有着色");
  assert.notEqual(
    sgr(policy)[0],
    sgr(policy)[1],
    "policy auto 生效项与 ask 灰不同色",
  );
});

test("renderStatusColumn: 无 mode/policy/preset 时 Mode 块整块省略", () => {
  const rows = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    5,
    20,
    initialState().themeId,
  ).map((l) => stripAnsi(l));
  const t = rows.join("\n");
  assert.ok(!t.includes("Mode"), "无会话配置数据不显示 Mode 块");
  assert.ok(t.includes("（无目标/待办）"), "仍显示无目标占位");
});
