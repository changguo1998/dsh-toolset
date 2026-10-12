// tests/status-column-equivalence.test.ts — 状态列 Box 改造的**行为等价性**证据（任务 5）
//
// 硬约束（追踪文档 docs/implementation/2026-10-12-status-column-boxes.md「口径澄清」）：
// 本次是**行为等价改造（视觉零回归）**——四块顺序、块间 `╌`、块内条目顺序、状态符号与配色、
// 灰色删除线、符号后的悬挂缩进、运行中闪烁、按帧高折叠分级、`Ctrl+S` 显隐、`PgUp`/`PgDn`
// 滚动都必须与改造前一致。这些细节没有既有自动化覆盖，故以「同一批 state 快照下新旧实现
// 逐行 diff 一致」为可执行证据（做法照 tests/pipeline-equivalence.test.ts 的旧路径 vs 新路径
// 先例：旧实现从改造前提交 `cca30c3` 取出后**冻结**在 tests/fixtures/status-column-old.ts）。
//
// 三部分：
//  A. 等价矩阵：无裸 `\n` 的输入（旧实现表现正确的场景）逐行文本 + ANSI 逐行一致；
//  B. 改造点：裸 `\n`（旧实现把一行写断的真机症状）在新实现下正常折行、且不产生控制字符；
//  C. 帧级断言：buildFrame 的状态列每行显示宽恒为 statusColWidth、行文本不含控制字符。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFrame,
  displayWidth,
  frameGeometry,
  renderStatusColumn,
  truncateToWidth,
} from "../src/app/layout.ts";
import { rowText } from "./helpers/rowText.ts";
import { statusFrameRows } from "./helpers/statusFrame.ts";
import { oldRenderStatusColumn } from "./fixtures/status-column-old.ts";
import { serializeFrameRow } from "../src/renderer/screen.ts";
import type { FrameRow, FrameSegment } from "../src/renderer/screen.ts";
import { THEMES } from "../src/renderer/theme.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { AppState, GoalHistory } from "../src/app/state.ts";
import type {
  AgentRowInfo,
  GoalActivation,
  JobInfo,
  TodoItemLike,
} from "../src/app/adapter/dsh.ts";

/** 一批 state 快照：两侧实现共用同一输入（`bodyW` = 状态列正文宽） */
interface Snapshot {
  goals?: GoalHistory;
  todos?: TodoItemLike[];
  jobs?: JobInfo[];
  agents?: AgentRowInfo[];
  activation?: GoalActivation;
  runTokens?: number;
  goalRounds?: { started?: number; max?: number };
  scroll?: number;
}

/** goal 列表构造（index 0 = 当前；其后为历史旧 goal） */
const goalList = (
  current: {
    phase: string;
    objective: string;
    blockedReason?: { code: string; message: string };
  },
  ...history: { phase: string; objective: string }[]
): GoalHistory =>
  [
    {
      operation: "create",
      goal: {
        id: "g0",
        revision: 1,
        objective: current.objective,
        phase: current.phase,
        blockedReason: current.blockedReason,
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
  ] as GoalHistory;

/** 长文本（跨多行折行用；无裸 `\n`） */
const LONG = "长目标描述文本".repeat(5);
const ASCII_LONG = "a-long-objective-line-for-wrapping".repeat(2);

const GOALS: Snapshot["goals"][] = [
  undefined,
  [],
  goalList({ phase: "active", objective: "短概括" }),
  goalList({ phase: "active", objective: LONG }),
  goalList({ phase: "active", objective: ASCII_LONG }),
  goalList({ phase: "complete", objective: LONG }),
  goalList({ phase: "paused", objective: "暂停的目标" }),
  goalList({
    phase: "blocked",
    objective: "阻塞目标",
    blockedReason: { code: "x", message: "用户拒绝" },
  }),
  goalList({
    phase: "blocked",
    objective: "阻塞目标",
    blockedReason: { code: "x", message: "很长的阻塞原因".repeat(6) },
  }),
  goalList({ phase: "weird", objective: "未知相位" }),
  goalList({ phase: "active", objective: "" }),
  goalList(
    { phase: "active", objective: "当前" },
    { phase: "complete", objective: "历史一" },
    { phase: "complete", objective: LONG },
  ),
  goalList(
    { phase: "active", objective: LONG },
    ...Array.from({ length: 5 }, (_, i) => ({
      phase: "complete",
      objective: `旧目标${i} ${ASCII_LONG}`,
    })),
  ),
];

const TODOS: Snapshot["todos"][] = [
  undefined,
  [],
  [{ content: "待办一", status: "pending" }],
  [
    { content: "进行中的任务内容较长需要折行显示", status: "in_progress" },
    // completed 条目取**不折行**内容：折行时旧实现续行无缩进（历史不一致），
    // 属已知差异，由下面「completed 续行悬挂缩进」用例单独钉住
    { content: "完", status: "completed" },
    { content: "待办", status: "pending" },
  ],
  [{ content: "", status: "pending" }],
  Array.from({ length: 12 }, (_, i) => ({
    content: i % 3 === 2 ? "完" : `任务${i}`,
    status: (["pending", "in_progress", "completed"] as const)[i % 3]!,
  })),
];

const JOBS: Snapshot["jobs"][] = [
  undefined,
  [],
  [
    { id: "j1", kind: "bash", label: "跑测试", status: "running" },
    { id: "j2", kind: "bash", label: "构建", status: "failed" },
    { id: "j3", kind: "bash", label: "发布", status: "done" },
    { id: "j4", kind: "bash", label: "取消的", status: "cancelled" },
    { id: "j5", kind: "bash", label: "停止中", status: "stopping" },
    { id: "j6", kind: "bash", label: "冷条目", status: "inactive" },
  ],
  [
    { id: "j7", kind: "subprocess", label: "", status: "running" },
    { id: "j8", kind: "", label: "", status: "running" },
    { id: "j9", kind: "超长任务标签".repeat(6), label: "", status: "running" },
    {
      id: "j10",
      kind: "bash",
      label: "a-very-long-job-label-that-exceeds-the-column",
      status: "running",
    },
  ],
];

const AGENTS: Snapshot["agents"][] = [
  undefined,
  [],
  [{ id: "s-a", label: "worker-a", status: "running" }],
  [
    {
      id: "s-a",
      label: "worker-a",
      status: "running",
      alias: "otter",
      work: "bash npm run test",
    },
    { id: "s-b", label: "worker-b", status: "inactive" },
    {
      id: "s-c",
      label: "broken",
      status: "diagnostic",
      diagnostic: { reason: "corrupt" },
    },
  ],
  [
    {
      id: "s-a",
      label: "worker-a",
      status: "running",
      alias: "otter",
      work: "bash npm run test -- --reporter=spec --watch=false",
      tps: 12,
    },
    { id: "s-b", label: "很长的别名标签".repeat(4), status: "running", tps: 2 },
    { id: "s-c", label: "slow", status: "running", tps: 0.5 },
  ],
];

/** 新旧两侧共用的输入快照矩阵（`bodyW` / `height` / `scroll` 逐档扫） */
const SNAPSHOTS: Snapshot[] = [];
for (const goals of GOALS)
  for (const todos of TODOS)
    for (const jobs of JOBS)
      for (const agents of AGENTS)
        SNAPSHOTS.push({ goals, todos, jobs, agents });

/** 补充：相位开关 / 轮次进度 / 闪烁节拍（agents 数据固定） */
const EXTRAS: Snapshot[] = [];
for (const activation of [undefined, "armed", "disarmed"] as const)
  for (const goalRounds of [
    undefined,
    { started: 3 },
    { started: 3, max: 999 },
  ])
    for (const runTokens of [0, 17, 40])
      EXTRAS.push({
        goals: goalList({ phase: "active", objective: LONG }),
        todos: TODOS[3],
        jobs: JOBS[2],
        agents: AGENTS[4],
        activation,
        goalRounds,
        runTokens,
      });

// bodyW 最小取 4：旧实现在 bodyW ≤ 3（终端 ≤ 15 列，生产不可达——statusColWidth 最低 20 或
// cols−10 → 可见时 bodyW ≥ 8）会把「标记 + 首个宽字符」拼成超宽行交给拼帧层截断，新实现
// 按列宽折行、多出 1 行 → 折叠档位可能不同。其余已知差异记在追踪文档「实现记录」。
const BODY_WIDTHS = [4, 8, 18, 31, 40, 60];
const HEIGHTS = [1, 2, 3, 5, 8, 14, 30];

/** 新实现 → 帧内可见行（截断 / 补白 / 分隔竖线按拼帧层口径还原） */
function newRows(
  s: Snapshot,
  bodyW: number,
  height: number,
): ReturnType<typeof statusFrameRows> {
  const rows = renderStatusColumn(
    s.goals,
    s.todos,
    s.jobs,
    s.scroll ?? 0,
    height,
    bodyW,
    s.agents,
    s.activation,
    s.runTokens ?? 0,
    s.goalRounds,
  );
  return statusFrameRows(rows, bodyW, height);
}

/** 旧实现 → 帧内可见行（旧签名收「正文 + 1 列分隔竖线」宽，且自带竖线与补白） */
function oldRows(
  s: Snapshot,
  bodyW: number,
  height: number,
): ReturnType<typeof statusFrameRows> {
  const rows = oldRenderStatusColumn(
    s.goals,
    s.todos,
    s.jobs,
    s.scroll ?? 0,
    height,
    bodyW + 1,
    s.agents,
    s.activation,
    s.runTokens ?? 0,
    s.goalRounds,
  );
  return statusFrameRows(rows, bodyW, height);
}

/** 归零「空白字符的样式」：悬挂缩进在排版库内以**无样式空格段**产出，旧实现把它并进着色段
 *  ——空白无字形、状态列无底色，屏幕上不可见，故比对 ANSI 时把前导空白从着色段里摘出来。 */
const dropBlankStyle = (row: FrameRow): FrameRow => {
  const segments: FrameSegment[] = [];
  for (const s of row.segments) {
    const m = /^(\s+)([\s\S]*)$/.exec(s.text);
    if (m === null) {
      segments.push({ ...s });
      continue;
    }
    segments.push({ text: m[1]! });
    if (m[2] !== "") segments.push({ text: m[2]!, style: s.style });
  }
  return { segments };
};

/** 行 ANSI（渲染层真实写屏路径：相邻同 style 合并，等价于屏幕所见） */
const ansiOf = (rows: readonly FrameRow[]): string[] =>
  rows.map((r) => serializeFrameRow(dropBlankStyle(r), THEMES.dark));

test("状态列等价性：新旧实现逐行文本与 ANSI 一致（全套快照 × 宽度 × 高度）", () => {
  let checked = 0;
  for (const [si, s] of SNAPSHOTS.entries()) {
    for (const bodyW of BODY_WIDTHS) {
      for (const height of HEIGHTS) {
        const o = oldRows(s, bodyW, height);
        const n = newRows(s, bodyW, height);
        const ctx = `快照#${si} bodyW=${bodyW} height=${height}`;
        assert.deepEqual(
          n.map((r) => rowText(r)),
          o.map((r) => rowText(r)),
          `逐行文本不一致：${ctx}`,
        );
        assert.deepEqual(ansiOf(n), ansiOf(o), `逐行 ANSI 不一致：${ctx}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 20000, `矩阵规模 = ${checked}`);
});

test("状态列等价性：相位开关 / 轮次进度 / 闪烁节拍各档一致", () => {
  for (const [si, s] of EXTRAS.entries()) {
    for (const bodyW of BODY_WIDTHS) {
      for (const height of HEIGHTS) {
        const ctx = `附加#${si} bodyW=${bodyW} height=${height}`;
        assert.deepEqual(
          newRows(s, bodyW, height).map((r) => rowText(r)),
          oldRows(s, bodyW, height).map((r) => rowText(r)),
          `逐行文本不一致：${ctx}`,
        );
      }
    }
  }
});

test("状态列等价性：滚动偏移不影响可见行（折叠优先，与改造前同）", () => {
  const s: Snapshot = {
    goals: goalList(
      { phase: "active", objective: "当前" },
      {
        phase: "complete",
        objective: LONG,
      },
    ),
    todos: TODOS[5],
    jobs: JOBS[2],
    agents: AGENTS[3],
  };
  for (const scroll of [0, 3, 99])
    for (const height of [3, 8, 14]) {
      const ctx = `scroll=${scroll} height=${height}`;
      assert.deepEqual(
        newRows({ ...s, scroll }, 31, height).map((r) => rowText(r)),
        oldRows({ ...s, scroll }, 31, height).map((r) => rowText(r)),
        `逐行文本不一致：${ctx}`,
      );
    }
});

// ---------- A2. 已知差异（有意变更，非等价） ----------

test("已知差异：completed todo 折行时续行改为悬挂对齐（旧实现续行无缩进）", () => {
  // 旧实现 todoItemRows 的 completed 分支只给首行挂标记、续行**不补缩进**（与
  // in_progress / pending 两个分支不一致，续行也比正文短 2 列）；新实现按 D2.3 统一用
  // `hanging`（= 标记宽）缩进。差异 = 续行前导 2 空格的**对齐修正**：折行边界与文本
  // 一字不变（同一列宽下逐行去缩进/补白后完全一致），只是续行不再贴左。
  const todos: TodoItemLike[] = [
    { content: "已完成的任务需要折行", status: "completed" },
  ];
  const bodyW = 8;
  const height = 10;
  const o = statusFrameRows(
    oldRenderStatusColumn(undefined, todos, undefined, 0, height, bodyW + 1),
    bodyW,
    height,
  ).map((r) => rowText(r));
  const n = newRows({ todos }, bodyW, height).map((r) => rowText(r));
  const strip = (r: string): string => r.replace(/│$/, "").trim();
  assert.equal(n.length, o.length, "行数一致（折行边界不变）");
  assert.deepEqual(n.map(strip), o.map(strip), "去缩进与补白后逐行文本一致");
  assert.equal(
    o[2]!.length - o[2]!.trimStart().length,
    0,
    "旧：续行无缩进（历史不一致）",
  );
  assert.equal(
    n[2]!.length - n[2]!.trimStart().length,
    2,
    "新：续行悬挂缩进 = 标记宽 2 列",
  );
  assert.equal(
    n[1]!.length - n[1]!.trimStart().length,
    0,
    "首行仍以标记起头（无额外缩进）",
  );
});

// ---------- B. 改造点：裸 `\n` 不再把一行写断 ----------

/** 状态列**正文**文本（帧内可见列：去 col0 外缘框格与末列分隔竖线） */
function statusCellTexts(
  state: AppState,
  cols: number,
  rows: number,
): string[] {
  const geom = frameGeometry(state, { cols, rows });
  return buildFrame(state, { cols, rows })
    .slice(0, geom.contentTopH)
    .map((r) => truncateToWidth(rowText(r), geom.statusColWidth))
    .map((cell) => cell.slice(1, -1));
}

test("改造点：多行 objective 的历史 goal 不再把一行写断（原真机症状）", () => {
  // 宿主 objective 自带换行：「一句话概括」+ `\n` + 「细节: ...」（原症状 = 后半截被终端
  // 执行成真实换行，`ESC[K` 之后不再回填 → 该行右缘竖线与右侧区域全空、内容消失）
  const state = withSession({
    goals: goalList(
      { phase: "active", objective: "当前概括" },
      {
        phase: "complete",
        objective: "一句话概括（首行结尾）\n细节: (1) 实时路径终态归属优",
      },
    ),
  });
  const cells = statusCellTexts(state, 100, 30);
  const joined = cells.join("\n");
  assert.ok(joined.includes("一句话概括"), "首逻辑行显示: " + joined);
  assert.ok(
    joined.includes("细节: (1) 实时路径"),
    "第二逻辑行独立成行显示（不再与首行挤在同一行）: " + joined,
  );
  assert.ok(!joined.includes("\n\n"), "不产生空行断层");
  // 每个状态列正文行定宽（断行症状的直接反证；帧内整列宽恒为 statusColWidth 见帧级用例）
  const geom = frameGeometry(state, { cols: 100, rows: 30 });
  for (const c of cells)
    assert.equal(
      displayWidth(c),
      geom.statusColWidth - 2,
      "状态列正文行显示宽恒为 statusBodyW: " + JSON.stringify(c),
    );
});

test("改造点：多行 objective 的当前 goal 只取首个逻辑行（口径不变）", () => {
  const state = withSession({
    goals: goalList({
      phase: "active",
      objective: "第一句概括\n第二段细节不应出现",
    }),
  });
  const joined = statusCellTexts(state, 100, 30).join("\n");
  assert.ok(joined.includes("第一句概括"), "首逻辑行显示: " + joined);
  assert.ok(!joined.includes("第二段细节"), "后续逻辑行不展示: " + joined);
});

test("改造点：todo / agents 条目内容含裸 `\\n` 时按物理行折行（不再写断）", () => {
  const state = withSession({
    goals: goalList({ phase: "active", objective: "目标" }),
    todos: [{ content: "第一行\n第二行", status: "pending" }],
    agents: [{ id: "a1", label: "别名\n第二行", status: "running" }],
  });
  const cells = statusCellTexts(state, 100, 30);
  const joined = cells.join("\n");
  assert.ok(!cells.some((c) => c.includes("\n")), "单元格不含裸换行");
  assert.ok(joined.includes("第一行"), "todo 首物理行: " + joined);
  assert.ok(joined.includes("第二行"), "todo 第二物理行独立成行: " + joined);
  // 续行停在首行文字起点（悬挂缩进 2 列 = 标记宽）
  const cont = cells.find((c) => c.includes("第二行"))!;
  assert.ok(
    cont.startsWith("  第二行"),
    "续行悬挂缩进 = 标记宽（2 列）: " + JSON.stringify(cont),
  );
});

// ---------- C. 帧级断言 ----------

test("帧级：状态列每行显示宽恒为 statusColWidth、行文本不含控制字符", () => {
  for (const cols of [40, 60, 100, 126]) {
    for (const rows of [10, 24, 40]) {
      const state = withSession({
        goals: goalList(
          {
            phase: "blocked",
            objective: LONG,
            blockedReason: { code: "x", message: "阻塞原因" },
          },
          { phase: "complete", objective: "一句话概括\n细节: 换行内容" },
          { phase: "complete", objective: ASCII_LONG },
        ),
        todos: TODOS[3],
        jobs: JOBS[2],
        agents: AGENTS[3],
      });
      const size = { cols, rows };
      const geom = frameGeometry(state, size);
      const frame = buildFrame(state, size);
      assert.ok(geom.statusColWidth > 0, "前提：状态列可见");
      const top = frame.slice(0, geom.contentTopH);
      for (const [ri, r] of top.entries()) {
        const text = rowText(r);
        assert.ok(
          !/[\n\r\x1b]/.test(text),
          `cols=${cols} rows=${rows} 第${ri}行含控制字符: ${JSON.stringify(text)}`,
        );
        const cell = truncateToWidth(text, geom.statusColWidth);
        assert.equal(
          displayWidth(cell),
          geom.statusColWidth,
          `cols=${cols} rows=${rows} 第${ri}行状态列宽不符: ${JSON.stringify(cell)}`,
        );
        // 分隔列字形：内容行 `│`、结构行（标题栏下划线 / 活动区分隔行）`├`（divFor 口径）
        assert.ok(
          /^[│├]$/.test(cell.slice(-1)),
          `cols=${cols} rows=${rows} 第${ri}行分隔列字形异常: ${JSON.stringify(cell)}`,
        );
        // 外缘框格列（col0）恒为单列占位（未聚焦留白，焦点态由 focusFrame 覆写）
        assert.equal(displayWidth(cell[0] ?? ""), 1, "外缘框格占 1 列");
      }
    }
  }
});

test("帧级：Ctrl+S 隐藏状态列后整帧不含状态列内容（宽度归 0）", () => {
  const shown = withSession({
    goals: goalList({ phase: "active", objective: "状态列独有目标文本" }),
    todos: TODOS[3],
  });
  const hidden = reduceState(shown, { type: "status-column", visible: false });
  const size = { cols: 100, rows: 24 };
  assert.ok(frameGeometry(shown, size).statusColWidth > 0, "显示态宽度 > 0");
  assert.equal(frameGeometry(hidden, size).statusColWidth, 0, "隐藏态宽度 = 0");
  const textOf = (st: AppState): string =>
    buildFrame(st, size)
      .map((r) => rowText(r))
      .join("\n");
  assert.ok(textOf(shown).includes("状态列独有目标文本"), "显示态含状态列内容");
  assert.ok(
    !textOf(hidden).includes("状态列独有目标文本"),
    "隐藏态不含状态列内容",
  );
  for (const r of buildFrame(hidden, size))
    assert.ok(displayWidth(rowText(r)) <= size.cols, "隐藏态帧行不超宽");
});

// ---------- 状态构造 ----------

/** 造一个带状态列内容的 AppState（活跃会话 s1） */
function withSession(fields: {
  goals?: GoalHistory;
  todos?: TodoItemLike[];
  jobs?: JobInfo[];
  agents?: AgentRowInfo[];
}): AppState {
  let s = initialState();
  s = reduceState(s, { type: "session-identify", id: "s1", title: "会话" });
  // goal 历史：`goal-change` 的 create 是**前插**（index 0 = 当前）→ 逆序喂入
  for (const e of [...(fields.goals ?? [])].reverse()) {
    s = reduceState(s, {
      type: "goal-change",
      sessionId: "s1",
      operation: "create",
      goal: e.goal,
    });
  }
  if (fields.todos)
    s = reduceState(s, {
      type: "todo-write",
      sessionId: "s1",
      todos: fields.todos,
    });
  if (fields.jobs)
    s = reduceState(s, {
      type: "jobs-changed",
      sessionId: "s1",
      jobs: fields.jobs,
    });
  if (fields.agents)
    s = reduceState(s, {
      type: "agents-changed",
      sessionId: "s1",
      agents: fields.agents,
    });
  return s;
}
