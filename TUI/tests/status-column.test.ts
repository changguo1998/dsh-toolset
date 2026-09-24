// tests/status-column.test.ts — 顶部状态列渲染单测（renderStatusColumn）
//
// P7 起状态列**只承载 Goal / Todo / Jobs 三块**：Mode 块（运行模式/权限/策略/预设/开关）
// 已移除，改由标题栏状态符号承载（见 tests/title-bar.test.ts）。
//
// 覆盖：goal 列表（index 0 = 当前，其后为历史旧 goal；`Goal <phase>` 蓝标题+phase 状态色 +
// objective + blocked 黄 tone；已完成 objective 灰+删除线）、
// todo/jobs 列表（无强制行数上限）、无 goal/todo 占位、总高超窗口时「折叠等级从低到高
// 依次尝试（L0 全显 / L1 隐藏已完成、goal 保留最近 1 条历史 / L2 仅进行中、goal 压标题行 /
// L3 进行中压 1 行）」、每行定宽含右缘竖线、status-column-scroll
// reducer（PgUp/PgDn 经 index 转发）。
// Mode 块：会话运行模式/权限/策略（列出全部
// 可选项、生效项着色、其余灰）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusColumn, displayWidth } from "../src/app/layout.ts";
import { rowAnsi, rowText } from "./helpers/rowText.ts";
import type { GoalHistory, ModeState } from "../src/app/state.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { JobInfo, TodoItemLike } from "../src/app/adapter/dsh.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

type GoalPhase = "active" | "paused" | "blocked" | "complete";

/** 单条 goal 的列表形式（index 0 = 当前）；历史项由 goalList 拼装 */
const setGoal = (
  phase: GoalPhase,
  objective: string,
  blockedReason?: { code: string; message: string },
): GoalHistory => [
  {
    operation: phase === "blocked" ? "block" : "create",
    goal: { id: "g1", revision: 1, objective, phase, blockedReason },
  },
];

/** 当前 goal + 历史（旧）goal 列表：第 2 项起为历史条目 */
const goalList = (
  current: { phase: GoalPhase; objective: string },
  ...history: { phase: GoalPhase; objective: string }[]
): GoalHistory => [
  {
    operation: "create",
    goal: {
      id: "g0",
      revision: 1,
      objective: current.objective,
      phase: current.phase,
    },
  },
  ...history.map((h, i) => ({
    operation: "create" as const,
    goal: {
      id: `h${i + 1}`,
      revision: 1,
      objective: h.objective,
      phase: h.phase,
    },
  })),
];

function col(
  goals: GoalHistory | undefined,
  todos: TodoItemLike[] | undefined,
  opts: { height?: number; width?: number; scroll?: number } = {},
  jobs?: JobInfo[],
): string[] {
  return renderStatusColumn(
    goals,
    todos,
    jobs,
    opts.scroll ?? 0,
    opts.height ?? 8,
    opts.width ?? 20,
  ).map((l) => rowText(l));
}

test("renderStatusColumn: 无 goal/todo 直接留空，每行定宽且右缘竖线", () => {
  const rows = col(undefined, undefined, { height: 3, width: 20 });
  assert.equal(rows.length, 3, "恰 height 行");
  assert.ok(
    rows.every((r) => r.replace(/[│|]$/, "").trim() === ""),
    "无目标/待办直接留空，不显示占位文字",
  );
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
    { width: 24, height: 14 },
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
    14,
    24,
  ).find((r) => rowText(r).includes("发布"))!;
  assert.ok(
    rowAnsi(rawDone).includes("9m") &&
      rowAnsi(rawDone).indexOf("9m") > rowAnsi(rawDone).indexOf("✓"),
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

test("renderStatusColumn: goal 块超窗口高时按等级折叠（L2 压成标题行）", () => {
  const objective = Array.from({ length: 40 }, (_, i) => `行${i}`).join(" ");
  // 高 8 且仅 goal 一块：L0 放不下，goal 无条目级折叠 → L2 起压成标题行（无 objective）
  const rows = col(setGoal("active", objective), [], { width: 10, height: 8 });
  const t = rows.join("\n");
  assert.ok(t.includes("Goal act"), "标题保留（窄列被截断到列宽）");
  assert.ok(!t.includes("行0"), "objective 在 L2 压标题行时隐藏");
  // 高度充足时目标完整显示（无固定上限截断）
  const full = col(setGoal("active", objective), [], {
    width: 120,
    height: 30,
  });
  assert.ok(full.join("|").includes("行39"), "高度充足时目标完整显示");
});

test("renderStatusColumn: 当前 goal + 历史旧 goal 同块展示（旧条目灰+删除线）", () => {
  const goals = goalList(
    { phase: "active", objective: "当前目标" },
    { phase: "complete", objective: "旧目标" },
  );
  const rows = col(goals, [], { width: 30, height: 12 });
  const t = rows.join("\n");
  assert.ok(t.includes("Goal active"), "标题=当前 goal 的 phase");
  assert.ok(t.includes("当前目标"), "当前 objective 展示");
  assert.ok(t.includes("Goal complete"), "历史条目标题行保留 phase");
  assert.ok(t.includes("旧目标"), "历史 objective 展示");
  // 历史 objective 灰 + 删除线（同 todo 完成态口径）：在未 strip 的原始行上断言
  const rawRows = renderStatusColumn(goals, [], undefined, 0, 12, 30);
  const rawHistory = rawRows.find((r) => rowText(r).includes("旧目标"))!;
  assert.ok(
    rowAnsi(rawHistory).includes("9m"),
    "历史 objective 带删除线: " + rowAnsi(rawHistory),
  );
  const rawCurrent = rawRows.find((r) => rowText(r).includes("当前目标"))!;
  assert.ok(
    !rowAnsi(rawCurrent).includes("9m"),
    "进行中（active）当前 goal 不带删除线: " + rowAnsi(rawCurrent),
  );
  // 当前 goal 自身已 complete → 与历史条目同口径（灰 + 删除线）
  const done = renderStatusColumn(
    setGoal("complete", "已完成目标"),
    [],
    undefined,
    0,
    8,
    30,
  ).find((r) => rowText(r).includes("已完成目标"))!;
  assert.ok(
    rowAnsi(done).includes("9m"),
    "complete 的当前 goal objective 带删除线: " + rowAnsi(done),
  );
});

test("renderStatusColumn: 历史 goal 按折叠等级收敛（L1 留最近 1 条、L2 全隐藏）", () => {
  const goals = goalList(
    { phase: "active", objective: "当前" },
    { phase: "complete", objective: "历史一" },
    { phase: "complete", objective: "历史二" },
  );
  // 高度充足：L0 展示全部历史
  const full = col(goals, [], { width: 30, height: 20 }).join("\n");
  assert.ok(
    full.includes("历史一") && full.includes("历史二"),
    "L0 展示全部历史 goal",
  );
  // 高度 5（L0=6 行放不下）→ L1：当前 goal + 最近 1 条历史 + 隐藏计数提示
  const mid = col(goals, [], { width: 30, height: 5 }).join("\n");
  assert.ok(mid.includes("当前"), "L1 保留当前 goal 的 objective");
  assert.ok(mid.includes("历史一"), "L1 保留最近 1 条历史 goal");
  assert.ok(!mid.includes("历史二"), "L1 隐藏更早的历史 goal");
  assert.ok(mid.includes("历史 goal 已隐藏"), "L1 出现隐藏计数提示");
  // 高度 3：L1(5 行) 放不下 → L2 压成标题行（objective 与历史全隐藏）
  const tight = col(goals, [], { width: 30, height: 3 }).join("\n");
  assert.ok(tight.includes("Goal active"), "L2 保留标题行");
  assert.ok(
    !tight.includes("当前") && !tight.includes("历史一"),
    "L2 隐藏 objective 与全部历史 goal",
  );
});

test("renderStatusColumn: todo 无固定行数上限——高度充足完整显示，溢出保首部提示", () => {
  const long = Array.from({ length: 20 }, (_, i) => `待办${i}`).join(" ");
  // 高度充足：旧行为按 3 行截断；新实现完整显示（不设强制上限）
  const full = col(
    setGoal("active", "x"),
    [{ content: long, status: "pending" }],
    {
      width: 12,
      height: 20,
    },
  );
  const fb = full.join("\n");
  assert.ok(
    fb.includes("待办19"),
    "高度充足时单条长 todo 完整显示（无固定 3 行截断）",
  );
  assert.ok(!fb.includes("(+"), "高度充足时无折叠提示");
  // 高度不足（goal 2 + todo 8 > 6）：L1 无已完成不动 → L2 仅进行中 → 待办(pending) 全折叠
  const rows = col(
    setGoal("active", "x"),
    [{ content: long, status: "pending" }],
    {
      width: 12,
      height: 6,
    },
  );
  const body = rows.join("\n");
  assert.ok(
    body.includes("项已隐"),
    "溢出出现折叠提示（窄列下标记被列宽截断）",
  );
  assert.ok(body.includes("Todo 0/1"), "todo 计数标题保留");
  assert.ok(
    !body.includes("待办0"),
    "L2 仅进行中：pending 待办被折叠（计数标题仍含）",
  );
});

test("renderStatusColumn: 整体高度未溢出时内容完整显示（不折叠、不隐藏完成）", () => {
  const rows = col(
    setGoal("active", "目标一、目标二、目标三"),
    [
      { content: "完成的任务 A", status: "completed" },
      {
        content: "待办较长内容（演示未溢出时不截断且续行缩进）",
        status: "pending",
      },
    ],
    { width: 16, height: 20 },
  );
  const t = rows.join("\n");
  assert.ok(t.includes("目标三"), "目标完整显示不折叠");
  assert.ok(t.includes("完成的任务 A"), "高度充足时已完成任务不隐藏");
  assert.ok(t.includes("行缩进"), "长内容续行完整（不截断，文本跨行也保留）");
  assert.ok(!t.includes("(+"), "未溢出时不出现折叠提示");
});

test("renderStatusColumn: 溢出时按折叠等级递减内容（L1 隐藏完成 → L2 仅进行中）", () => {
  const rows = col(
    setGoal("active", "目标"),
    [
      { content: "完成的任务 A", status: "completed" },
      { content: "完成的任务 B", status: "completed" },
      { content: "待办任务 C", status: "pending" },
      { content: "待办任务 D", status: "pending" },
    ],
    // L0=12>9，L1 隐藏完成=11>9 → L2 仅进行中（无 in_progress → todo 折叠）+ goal 压标题
    // 输出：Goal active / Todo 2/4 / …(+4项已隐藏) / Jobs 块 = 7 行
    { width: 16, height: 9 },
    [{ id: "j1", kind: "bash", label: "跑测试", status: "running" }],
  );
  const t = rows.join("\n");
  assert.ok(
    t.includes("Todo 2/4"),
    "计数标题仍含完成数（隐藏的是条目不是计数）",
  );
  assert.ok(!t.includes("完成的任务"), "L1 已隐藏已完成任务");
  assert.ok(!t.includes("待办任务 C"), "L2 仅进行中：pending 待办也被折叠");
  assert.ok(t.includes("项已隐藏"), "隐藏条目有提示");
  assert.ok(t.includes("跑测试"), "jobs 块保留（无折叠语义）");
  assert.ok(t.includes("Goal active"), "goal 压成标题行");
  assert.ok(!t.includes("目标"), "goal objective 随 L2 标题行折叠");
});

test("renderStatusColumn: 总高超窗口时折叠而非滚动——隐藏条目滚动不可找回", () => {
  const todos: TodoItemLike[] = Array.from({ length: 10 }, (_, i) => ({
    content: `任务${i}`,
    status: "pending",
  }));
  // 高度充足（goal 2 + todo 12 = 14）：全部显示
  const full = col(setGoal("active", "目标"), todos, {
    height: 14,
    width: 20,
    scroll: 0,
  });
  const f = full.join("|");
  assert.ok(f.includes("任务0") && f.includes("任务9"), "高度充足全部显示");
  // 高度不足（6）：折叠到窗口高，靠后条目隐藏；滚动 99 也找不回
  const collapsed = col(setGoal("active", "目标"), todos, {
    height: 6,
    width: 20,
    scroll: 99,
  });
  const c = collapsed.join("\n");
  assert.ok(c.includes("项已隐藏"), "折叠提示出现");
  assert.ok(
    !c.includes("任务0"),
    "L2 仅进行中：pending 待办全折叠（计数标题仍含）",
  );
  assert.ok(!c.includes("任务9"), "折叠条目滚动不可找回");
  assert.ok(c.includes("Todo 0/10"), "计数标题保留 0/10");
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

// ===== Mode 块：会话运行模式/权限/策略 =====

test("renderStatusColumn（P7）：不再有 Mode 块——无 goal/todo/jobs 时整列留空", () => {
  const rows = renderStatusColumn(undefined, [], undefined, 0, 5, 20).map((l) =>
    rowText(l),
  );
  const body = rows
    .map((r) => r.replace(/│$/, "").trimEnd())
    .filter((r) => r !== "");
  assert.deepEqual(body, [], "无内容块时不显示任何行: " + JSON.stringify(body));
});

test("catalog reducer: 目录写入全局 state，且更新后回无焦点（与 jobs-changed 一致）", () => {
  let s = initialState();
  s = reduceState(s, { type: "permission-catalog", names: ["a", "b"] });
  assert.deepEqual(s.permissionOptions, ["a", "b"]);
  s = reduceState(s, { type: "agent-preset-catalog", ids: ["x", "y"] });
  assert.deepEqual(s.presetOptions, ["x", "y"]);
  // 内容推进语义：catalog 更新（外部状态变化）后自动回无焦点
  let f = initialState();
  f = reduceState(f, { type: "focus-panel-cycle" });
  assert.ok(f.focusedPanel !== null, "前提：焦点已进入循环");
  f = reduceState(f, { type: "permission-catalog", names: ["a"] });
  assert.equal(f.focusedPanel, null, "权限目录更新后回无焦点");
});

test("renderStatusColumn（P7）：permission 不再出现在状态列（已从展示中移除）", () => {
  let st = initialState();
  st = reduceState(st, {
    type: "mode",
    sessionId: "s1",
    kind: "permission",
    value: "danger-full-access",
  });
  st.activeSessionId = "s1";
  const rows = renderStatusColumn(undefined, [], undefined, 0, 8, 30).map((l) =>
    rowText(l),
  );
  const t = rows.join("\n");
  assert.ok(!t.includes("permission"), `状态列不含 permission: ${t}`);
  assert.ok(!t.includes("Mode"), `状态列不含 Mode 块: ${t}`);
});
