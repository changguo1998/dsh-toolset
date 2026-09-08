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
    { width: 12, height: 11 }, // 标题行+分隔后仍须露出折叠提示
  );
  const body = rows.join("\n");
  // 过滤纯右缘竖线的空行：行尾竖线前的部分 trim 为空才算空行
  const todoLines = body
    .split("\n")
    .filter((r) => r.replace(/[│|]$/, "").trim() !== "");
  // 标题行 1 + 标题分隔 1 + Goal 标题 1 + 目标 1 + 块间虚线 1 + todo 计数 1 + 该条至多 3 行
  assert.ok(todoLines.length <= 9, `条目上限内: ${todoLines.length} 行`);
  assert.ok(body.includes("(+"), "todo 折叠提示");
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

test("renderStatusColumn: 溢出时优先隐藏已完成任务（计数标题仍含）", () => {
  const rows = col(
    setGoal("active", "目标"),
    [
      { content: "完成的任务 A", status: "completed" },
      { content: "完成的任务 B", status: "completed" },
      { content: "待办任务 C", status: "pending" },
      { content: "待办任务 D", status: "pending" },
    ],
    { width: 16, height: 9 }, // 标题+虚线+Goal+目标+虚线+计数+2 待办=8 行；completed 被优先隐藏
    [{ id: "j1", kind: "bash", label: "跑测试", status: "running" }],
  );
  const t = rows.join("\n");
  assert.ok(t.includes("Todo 2/4"), "计数标题仍含完成数（隐藏的是行不是计数）");
  assert.ok(!t.includes("完成的任务"), "已完成任务行被优先隐藏");
  assert.ok(
    t.includes("待办任务 C") && t.includes("待办任务 D"),
    "未完成任务保留",
  );
});

test("renderStatusColumn: 滚动窗口 clamp——超长内容可下滚看更晚条目", () => {
  const todos: TodoItemLike[] = Array.from({ length: 10 }, (_, i) => ({
    content: `任务${i}`,
    status: "pending",
  }));
  // 高 5 行（Goal 标题/目标/块间虚线/计数 + 1 条任务）：首屏看到顶部（任务0 开头），
  // 滚动后看到任务0 消失、任务9 出现
  const top = col(setGoal("active", "目标"), todos, {
    height: 7,
    width: 20,
    scroll: 0,
  });
  assert.ok(top.join("|").includes("任务0"), "首屏含最早任务");
  const scrolled = col(setGoal("active", "目标"), todos, {
    height: 5,
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

test("renderStatusColumn: 标题行置顶、Mode 块随后展示（无 goal 也显示）；各项目列出全部可选项", () => {
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
    12,
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

test("renderStatusColumn: sandbox 三档外生效值（custom）补入列表并高亮", () => {
  const raw = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    8,
    90,
    initialState().themeId,
    { plan: "on", sandbox: "danger-custom", permission: "read-only" },
    "ask",
    undefined,
  );
  const t = raw.map((l) => stripAnsi(l)).join("\n");
  assert.ok(
    t.includes("sandbox ro wr full danger-custom"),
    "custom 生效值应补入 sandbox 列表: " + t,
  );
  // 洋红高亮（custom 目录外值，与三档 permColor 区分）
  const row = raw.find((l) => l.includes("danger-custom"))!;
  assert.ok(
    row.includes("\x1b[38;2;169;70;231m"),
    "custom sandbox 应以洋红强调: " + row,
  );
});

test("renderStatusColumn: Mode 生效项着色强调、其余灰（段内至少两种不同 SGR）", () => {
  const raw = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    8,
    90,
    initialState().themeId,
    { plan: "on", sandbox: "read-only", permission: "read-only" },
    "never",
    undefined,
  );
  // 忽略定宽补齐 SGR 与竖线分隔灰，只核对选项段内色差
  const sgr = (l: string): string[] =>
    [...l.matchAll(/\x1b\[38;2;(?!255;255;255)[\d;]+m/g)].map((m) => m[0]);
  const sandbox = raw.find((l) => l.includes("sandbox"))!;
  const policy = raw.find((l) => l.includes("policy"))!;
  const GRAY = "\x1b[38;2;120;120;120m"; // 次要灰 bright[0] #787878
  // sandbox 行：ro(生效绿)、wr/full(灰) —— 生效项与未生效灰不同色，且未生效项确为灰
  assert.ok(
    new Set(sgr(sandbox)).size >= 2,
    "sandbox 生效 ro 与灰选项颜色不同: " + raw.join("\n"),
  );
  assert.ok(sgr(sandbox).includes(GRAY), "sandbox wr/full 未生效项为灰");
  // policy=never → auto 生效（红）与 ask(灰) 不同色
  assert.ok(
    new Set(sgr(policy)).size >= 2,
    "policy auto 生效与 ask 灰颜色不同: " + raw.join("\n"),
  );
  assert.ok(sgr(policy).includes(GRAY), "policy ask 未生效项为灰");
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

test("renderStatusColumn: Mode 各项以竖线分隔连续排布；宽列单行、窄列折行且断行行尾无竖线", () => {
  const theme = initialState().themeId;
  const text = (w: number): string =>
    renderStatusColumn(
      undefined,
      [],
      undefined,
      0,
      10,
      w,
      theme,
      {
        plan: "on",
        sandbox: "read-only",
        permission: "danger-full-access",
      },
      "ask",
      "claude",
    )
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
      .join("\n");
  // 宽列：各项单行连续排布（不强制换行），竖线分隔
  const wide = text(120);
  assert.ok(
    wide.includes("plan off on | sandbox ro wr full"),
    "宽列各项以 | 分隔连续排布（不强制换行）: " + wide,
  );
  assert.ok(
    wide.includes("policy ask auto | preset claude"),
    "preset 也以 | 与上一项衔接: " + wide,
  );
  const wideBody = wide.split("\n").filter((l) => l.includes("plan"));
  assert.equal(wideBody.length, 1, "宽列 Mode 内容单行: " + wide);
  // 中等宽度：同行项目间有竖线，但折行处的行尾不残留竖线
  const mid = text(36);
  assert.ok(mid.includes(" | "), "中等宽度同行项目以竖线分隔: " + mid);
  const midLines = mid
    .split("\n")
    .filter((l) => /plan|sandbox|permission|policy|preset/.test(l));
  assert.ok(midLines.length >= 3, "中等宽度放不下时折行: " + mid);
  for (const l of midLines)
    assert.ok(!l.trimEnd().endsWith("|"), "折行行尾不残留竖线: " + l);
  // 窄列：全部折行，且断行处均无竖线
  const narrow = text(20);
  const bodyLines = narrow
    .split("\n")
    .filter((l) => /plan|sandbox|permission|policy|preset/.test(l));
  assert.ok(
    bodyLines.length >= 3,
    "窄列放不下时溢出折行（多行内容）: " + narrow,
  );
  for (const l of bodyLines)
    assert.ok(!l.trimEnd().endsWith("|"), "窄列断行处无竖线: " + l);
});

test("renderStatusColumn: Mode 属性名用默认前景色（不被外层灰二次包裹），只有未生效值灰", () => {
  const theme = initialState().themeId;
  const raw = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    8,
    120,
    theme,
    { plan: "on", sandbox: "read-only", permission: "danger-full-access" },
    "ask",
    "claude",
  );
  const permRow = raw.find((l) => l.includes("permission"))!;
  // 行首首个 ANSI 前的片段：若被外层灰二次包裹则为空（灰码在行首）；未包裹则直接是文本
  const head = permRow.split(/\x1b\[/)[0] ?? "";
  assert.ok(
    head.trim() !== "" && head.includes("plan"),
    "属性名默认前景、未被外层灰包裹（行首片段非空）: " + JSON.stringify(head),
  );
});

test("renderStatusColumn: Mode 块与 Goal 块之间以虚线分隔，Goal 与 todo 之间虚线保留", () => {
  const theme = initialState().themeId;
  const strip = (l: string): string =>
    l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  const noGoal = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    10,
    30,
    theme,
    { plan: "on", sandbox: "read-only", permission: "read-only" },
    "ask",
    "claude",
  ).map(strip);
  // 无 goal：Mode 块后直接占位，无虚线
  const ng = noGoal.join("\n");
  const iM = ng.indexOf("Mode");
  const iPh = ng.indexOf("（无目标/待办）");
  assert.ok(
    iM >= 0 && iM < iPh && !ng.slice(iM, iPh).includes("╌"),
    "无 goal 时 Mode 后不画虚线: " + ng,
  );
  const withGoal = renderStatusColumn(
    setGoal("active", "目标"),
    [],
    undefined,
    0,
    12,
    40,
    theme,
    { plan: "on", sandbox: "read-only", permission: "read-only" },
    "ask",
    undefined,
  ).map(strip);
  const g = withGoal.join("\n");
  const iMode = g.indexOf("Mode");
  const iGoal = g.indexOf("Goal active");
  assert.ok(iMode >= 0 && iGoal > iMode, "Mode 与 Goal 顺序正确: " + g);
  assert.ok(
    g.slice(iMode, iGoal).includes("╌"),
    "Mode 与 Goal 之间含虚线分隔: " + g,
  );
  // 无 todo 时 Goal 后应无 todo 虚线（既有）
  assert.ok(
    !g.slice(iGoal).includes("╌"),
    "无 todo 时 Goal 后无多余虚线: " + g,
  );
});

test("renderStatusColumn: permission/preset 按目录列出全部可选值", () => {
  const theme = initialState().themeId;
  const strip = (l: string): string =>
    l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  const rows = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    10,
    120,
    theme,
    { plan: "on", sandbox: "read-only", permission: "danger-full-access" },
    "ask",
    "claude",
    ["read-only", "workspace-write", "danger-full-access", "custom"],
    ["claude", "default", "research"],
  ).map(strip);
  const t = rows.join("\n");
  assert.ok(
    t.includes("permission ro wr full custom"),
    "permission 按目录列出（custom 也在）: " + t,
  );
  assert.ok(
    t.includes("preset claude default research"),
    "preset 按目录列出全部 id: " + t,
  );
});

test("renderStatusColumn: 目录不含当前生效值 → 补入列表并显示", () => {
  const theme = initialState().themeId;
  const strip = (l: string): string =>
    l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  // permission 当前值 deploy-safe 不在目录；preset 当前值 ghost 不在目录
  const rows = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    10,
    120,
    theme,
    { plan: "on", sandbox: "workspace-write", permission: "deploy-safe" },
    "ask",
    "ghost",
    ["read-only", "workspace-write", "danger-full-access"],
    ["claude", "default"],
  ).map(strip);
  const t = rows.join("\n");
  assert.ok(
    t.includes("permission ro wr full deploy-safe"),
    "三档外生效值补入权限列表: " + t,
  );
  assert.ok(
    t.includes("preset claude default ghost"),
    "目录外生效值补入 preset 列表: " + t,
  );
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

test("renderStatusColumn: 目录空（未同步/降级）时目录外自定义当前值仍补入三档列表", () => {
  const theme = initialState().themeId;
  const strip = (l: string): string =>
    l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  // permissionOptions=[]（空数组=目录未同步 → 降级标准三档），当前值超长自定义名
  const rows = renderStatusColumn(
    undefined,
    [],
    undefined,
    0,
    10,
    80,
    theme,
    { sandbox: "read-only", permission: "very-long-custom-preset-name-0123" },
    "ask",
    "p",
    [],
    undefined,
  ).map(strip);
  const t = rows.join("\n");
  assert.ok(
    t.includes("permission ro wr full very-long-custom-preset-name-0123"),
    "目录空降级时自定义当前值仍补入并显示: " + t,
  );
});
