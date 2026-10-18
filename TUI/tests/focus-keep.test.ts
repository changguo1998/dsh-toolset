// tests/focus-keep.test.ts — 区域焦点在内容推进期间保持（BACKLOG「模型回复期间区域焦点被
// 内容推进清空（运行中切换不保持）」，2026-10-15 实现）
//
// 事件边界（`FOCUS_RESET_ACTIONS`，src/app/state.ts）：
//   复位（清焦点）——**只有用户提交输入**：`user-line` / `queued-push`；
//   保持（不复位）——流式内容（`append` / `thinking` / `tool-*` / `retry` / `step` /
//                    `subagent` / `workflow` / `command` / `code-dispatch` / `hook` /
//                    `schedule` / `feedback` / `compaction*`）、回合边界（`turn-begin` /
//                    `turn-end`）与无内容载荷的状态刷新（`notice` / `goal-change` /
//                    `todo-write` / `jobs-changed` / `permission-catalog` /
//                    `agent-preset-catalog`）——一次回复可能跨多个回合，边界清焦点 = 中途甩焦点。
//
// 本文件是「保持」侧的清单守卫：以后往 `StateAction` 加内容类 action 时，若它不该清焦点，
// 就加进 `KEEP_ACTIONS`；若它该清焦点，就加进 `RESET_CASES`。

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { App, type AppDeps } from "../src/app/index.ts";
import { initialState, reduceState, type AppState } from "../src/app/state.ts";
import { metricsFor, TITLE_BAR_ROWS } from "../src/app/layout.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import {
  withText,
  withToolCall,
  withToolResult,
} from "./helpers/pipelineContent.ts";

/** 本文件建过的 App（runner 不退：renderer 持有 stdin，必须统一 release） */
const createdApps: App[] = [];

/** 与生产同路径起一个 App（`pipelineSink` 交给假适配器做「事件 → 交付」镜像） */
function makeApp(): {
  app: App;
  renderer: FakeRenderer;
  adapter: FakeAdapter;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const sink: NonNullable<FakeAdapter["mirrorTo"]> = {};
  const app = new TrackedApp({
    renderer,
    adapter,
    notify: { enabled: false },
    pipelineSink: sink,
  });
  createdApps.push(app);
  app.start();
  adapter.mirrorTo = sink;
  return { app, renderer, adapter };
}

class TrackedApp extends App {
  constructor(deps: AppDeps) {
    super(deps);
    registerApp(this);
  }
}

afterEach(() => {
  for (const app of createdApps.splice(0)) {
    try {
      app.dispose();
    } catch {
      // 用例已自行 dispose / 半途失败：忽略重复释放
    }
  }
});

/** 焦点落在给定区域的状态（缺省回合区 = `Ctrl+T` 聚焦的那块） */
function focusedState(
  panel: "history" | "activity" | "status" = "activity",
): AppState {
  return reduceState(initialState(), { type: "focus-panel", panel });
}

/** 保持类 action 清单：派发后焦点必须原样保留 */
const KEEP_ACTIONS: StateActionLike[] = [
  // --- 流式内容（运行中每个 chunk 一次） ---
  { type: "append", text: "正文片段" },
  { type: "thinking", text: "思考片段" },
  {
    type: "tool-call",
    sessionId: "s1",
    name: "read",
    summary: "读取文件",
  },
  { type: "retry", attempt: 2, max: 5, delayMs: 500, code: "rate_limit" },
  { type: "retry-started", sessionId: "s1", attempt: 2 },
  {
    type: "step",
    sessionId: "s1",
    turn: 1,
    step: 2,
    phase: "start",
  },
  { type: "subagent", sessionId: "s1", label: "子代理", mode: "one-shot" },
  {
    type: "workflow",
    sessionId: "s1",
    phase: "agent-start",
    label: "审计",
  },
  { type: "command", sessionId: "s1", phase: "run", name: "/search" },
  {
    type: "code-dispatch",
    sessionId: "s1",
    phase: "start",
    name: "code",
    summary: "分发",
    ok: true,
  },
  {
    type: "hook",
    sessionId: "s1",
    phase: "invoked",
    point: "turn-start",
    ok: true,
  },
  { type: "schedule", sessionId: "s1", operation: "create", id: "job1" },
  { type: "feedback", sessionId: "s1", text: "不错" },
  { type: "compaction", phase: "start", sessionId: "s1" },
  {
    type: "compaction-summary",
    sessionId: "s1",
    text: "摘要",
    raw: {},
  },
  { type: "compaction-prune", sessionId: "s1", nodeCount: 3, tokenCount: 120 },
  // --- 无内容载荷的状态刷新 ---
  { type: "notice", text: "通知" },
  {
    type: "goal-change",
    sessionId: "s1",
    operation: "clear",
    cleared: { id: "g1" },
  },
  {
    type: "todo-write",
    sessionId: "s1",
    todos: [{ content: "待办", status: "pending" }],
  },
  { type: "jobs-changed", sessionId: "s1", jobs: [] },
  { type: "permission-catalog", names: ["read", "write"] },
  { type: "agent-preset-catalog", ids: ["default"] },
];

/** 只取 `type` 字段的形状（清单表用；实际派发时断言为完整 action） */
type StateActionLike = Parameters<typeof reduceState>[1];

test("焦点保持（清单）：流式内容与无内容状态刷新都不清焦点", () => {
  let s = focusedState("activity");
  assert.equal(s.focusedPanel, "activity", "前提：焦点在回合区");
  for (const action of KEEP_ACTIONS) {
    s = reduceState(s, action);
    assert.equal(
      s.focusedPanel,
      "activity",
      `${action.type} 后焦点应保持（2026-10-15 裁定：只有回合边界与用户提交输入复位）`,
    );
  }
});

test("焦点保持：实战序列（回合内流式 → 工具 → 通知，全程不掉焦点）", () => {
  // 用户视角的回归场景：Ctrl+T 聚焦后，模型整段回复（正文 / 思考 / 工具 / step /
  // 通知）期间焦点必须一直在，方向键才能持续滚动该区域。
  // 注：排队提交（queued-push）属「用户提交输入」类，清单外——它照旧清焦点。
  let s = focusedState("activity");
  const sequence: StateActionLike[] = [
    { type: "append", text: "第一段" },
    { type: "thinking", text: "想一下" },
    { type: "append", text: "第二段" },
    {
      type: "tool-call",
      sessionId: "s1",
      name: "bash",
      summary: "运行测试",
    },
    { type: "notice", text: "已排队" },
    { type: "step", sessionId: "s1", turn: 1, step: 2, phase: "start" },
    { type: "append", text: "第三段" },
  ];
  for (const action of sequence) {
    s = reduceState(s, action);
    assert.equal(
      s.focusedPanel,
      "activity",
      `${action.type} 后焦点应保持（运行中切不过去 = 本条缺陷的现象）`,
    );
  }
  // 回合边界同样保持（核心自发续轮会走到这里）
  s = reduceState(s, { type: "turn-end" });
  assert.equal(s.focusedPanel, "activity", "回合结束后焦点保持");
  s = reduceState(s, { type: "user-line", text: "下一轮提问" });
  assert.equal(s.focusedPanel, null, "用户提交输入后才回无焦点");
});

test("焦点保持：回合边界（turn-begin / turn-end）不清焦点", () => {
  // 一次回复可能跨多个回合（核心自发续轮）：回合边界清焦点 = 回复中途把焦点甩掉
  const afterBegin = reduceState(focusedState("activity"), {
    type: "turn-begin",
    clearActivity: false,
  });
  assert.equal(afterBegin.focusedPanel, "activity", "turn-begin 后焦点保持");
  const afterEnd = reduceState(focusedState("status"), { type: "turn-end" });
  assert.equal(afterEnd.focusedPanel, "status", "turn-end 后焦点保持");
});

test("焦点复位：用户提交输入两项 action 清焦点（user-line / queued-push）", () => {
  const afterUser = reduceState(focusedState("history"), {
    type: "user-line",
    text: "用户输入",
  });
  assert.equal(afterUser.focusedPanel, null, "user-line 后回无焦点");
  const afterPush = reduceState(focusedState("history"), {
    type: "queued-push",
    text: "排队",
    kind: "followup",
  });
  assert.equal(afterPush.focusedPanel, null, "queued-push 后回无焦点");
});

test("焦点保持：交付（pipeline-state）与 UI 滚动不清焦点", () => {
  let s = focusedState("history");
  s = withText(s, "正文");
  assert.equal(s.focusedPanel, "history", "withText（交付）后焦点保持");
  s = withToolCall(s, "read", "a.md");
  assert.equal(s.focusedPanel, "history", "工具调用交付后焦点保持");
  s = withToolResult(s, true, "ok");
  assert.equal(s.focusedPanel, "history", "工具结果交付后焦点保持");
  s = reduceState(s, { type: "status-column-scroll", delta: 1 });
  assert.equal(s.focusedPanel, "history", "状态列滚动后焦点保持");
});

test("App 端到端：聚焦会话区后流式输出期间焦点框保持，提交输入 / Esc 才退出", () => {
  // 本条缺陷的用户可见现象（BACKLOG「模型回复期间区域焦点被内容推进清空」）：
  // 运行时按 Ctrl+E 聚焦会话区，焦点框立刻被下一个流式 chunk（或下一个回合开始）清掉。
  // 焦点框判据 = 会话区既有框线转焦点色（dark 主题 focus = 159;238;250，
  // 与 tests/app.test.ts 的 Esc 退出用例同口径）。
  const { app, renderer, adapter } = makeApp();
  renderer.size = { cols: 100, rows: 24 };
  const hasFocusVBar = (): boolean =>
    renderer.lastRender.some((l) => l.includes("\x1b[38;2;159;238;250m│"));
  const focused = (): unknown =>
    (app as unknown as { state: { focusedPanel: unknown } }).state.focusedPanel;

  // 先跑一个回合（有内容可滚）并结束它
  adapter.push({ type: "stream", sessionId: "s1", text: "第一回合回复\n" });
  adapter.push({ type: "turn-end" });
  assert.equal(focused(), null, "初始无焦点");

  // 运行中：聚焦会话区 → 焦点框出现
  renderer.press({ name: "e", ctrl: true, meta: false, shift: false });
  assert.equal(focused(), "history", "Ctrl+E 聚焦会话区");
  assert.ok(hasFocusVBar(), "焦点框已亮");

  // 流式推进（正文 / 思考 / 工具 / 通知）：焦点框必须一直在
  adapter.push({
    type: "stream",
    sessionId: "s1",
    text: "正在流式回复的内容\n",
  });
  assert.ok(hasFocusVBar(), "流式正文 chunk 后焦点框仍在");
  adapter.push({ type: "thinking", sessionId: "s1", text: "正在分析" });
  assert.ok(hasFocusVBar(), "思考 chunk 后焦点框仍在");
  adapter.push({
    type: "tool-call",
    sessionId: "s1",
    name: "read",
    summary: "读取文件",
  });
  assert.ok(hasFocusVBar(), "工具调用后焦点框仍在");
  adapter.push({ type: "notice", text: "系统通知" });
  assert.ok(hasFocusVBar(), "通知后焦点框仍在");
  assert.equal(focused(), "history", "全程焦点保持在会话区");

  // 回合结束（核心自发续轮 / 收尾）：焦点仍保持（回复中途被甩焦点即本条缺陷）
  adapter.push({ type: "turn-end" });
  assert.equal(focused(), "history", "回合结束后焦点仍保持");
  assert.ok(hasFocusVBar(), "回合结束后焦点框仍在");

  // 用户显式退出：idle + 空输入 Esc → 回无焦点，焦点框熄灭
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  assert.equal(focused(), null, "Esc 后回无焦点");
  assert.ok(!hasFocusVBar(), "Esc 后焦点框熄灭");
});

test("App 端到端：运行中（非 idle）Esc 也回无焦点，且不打断运行（2026-10-15 真机裁定）", () => {
  // 真机现象：忙时按 Esc 整键 no-op → 切了焦点退不出去。裁定 = 忙时 Esc 不打断运行，
  // 但要回到默认状态（无焦点 = 跟随最新）；打断仍只由 `!` 模式承担。
  const { app, renderer, adapter } = makeApp();
  renderer.size = { cols: 100, rows: 24 };
  const focused = (): unknown =>
    (app as unknown as { state: { focusedPanel: unknown } }).state.focusedPanel;

  // 忙：agent 处于 thinking（非 idle）
  adapter.push({ type: "agent-status", sessionId: "s1", status: "thinking" });
  adapter.push({ type: "stream", sessionId: "s1", text: "回复中\n" });

  // 运行中聚焦回合区 → 焦点在
  renderer.press({ name: "t", ctrl: true, meta: false, shift: false });
  assert.equal(focused(), "activity", "运行中 Ctrl+T 聚焦回合区");

  // 忙时 Esc：回无焦点（默认状态），且不调用 interrupt
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  assert.equal(focused(), null, "忙时 Esc 也回无焦点");
  assert.equal(adapter.interrupts, 0, "忙时 Esc 不打断运行（打断走 `!` 模式）");

  // 焦点已回默认：后续流式推进不再影响（无焦点 = 跟随最新）
  adapter.push({ type: "stream", sessionId: "s1", text: "后续内容\n" });
  assert.equal(focused(), null, "回默认后保持无焦点");
});

test("App 端到端：运行中聚焦回合区后方向键可滚该区域，流式推进不重置滚动位置", () => {
  // 条目验收④的单测替身：回复期间 Ctrl+T 聚焦 → ↑ 滚动该区域有效；
  // 期间继续到达的流式 chunk 不清焦点、也不把滚动位置弹回底部。
  const { app, renderer, adapter } = makeApp();
  const size = { cols: 120, rows: 24 } as const;
  renderer.size = size;
  const strip = (l: string): string => l.replace(/\u001b\[[0-9;]*m/g, "");
  const { statusColWidth } = metricsFor(size);
  /** 回合区（活动 pane）正文段：默认排列「状态列 | 会话区 | 回合区」→
   *  活动区左缘框线竖线之后即正文（分隔/边框行不含竖线，返回 null 由调用方跳过） */
  const bodyOf = (l: string): string | null => {
    const raw = strip(l).replace(/\s+$/, "");
    // 活动区左缘框线列在 `statusColWidth`（0 基）；正文可能自带 `┃`（思考前缀）等
    // 其它竖线字形，故从该列起找**第一个** `│`
    const at = raw.indexOf("│", statusColWidth - 1);
    return at >= 0 ? raw.slice(at + 1) : null;
  };
  /** 回合区（活动 pane）首行可见文本：标题栏分隔行 → 状态区上分隔行之间的正文首行 */
  /** 回合区顶边分隔行（带窗口标题 `── Turn ──`，唯一的定位锚点） */
  const turnTopRow = (): number => {
    const top = renderer.lastRender.findIndex(
      (l, i) => i > TITLE_BAR_ROWS && strip(l).includes("── Turn ──"),
    );
    assert.ok(top >= 0, "回合区窗口存在");
    return top;
  };
  /** 回合区当前可见的全部正文行（跳过顶/底边行与空行） */
  const actLines = (): string[] => {
    const out: string[] = [];
    for (const line of renderer.lastRender.slice(turnTopRow() + 1)) {
      const body = bodyOf(line);
      if (body !== null && body.trim() !== "") out.push(body.trim());
    }
    return out;
  };
  /** 回合区首行可见文本 */
  const actFirst = (): string => {
    for (const line of renderer.lastRender.slice(turnTopRow() + 1)) {
      const body = bodyOf(line);
      if (body !== null && body.trim() !== "") return body.trim();
    }
    return "(空)";
  };
  const scroll = (): number =>
    (app as unknown as { state: { activityScroll: number } }).state
      .activityScroll;
  const focused = (): unknown =>
    (app as unknown as { state: { focusedPanel: unknown } }).state.focusedPanel;
  const up = (): void =>
    renderer.press({ name: "up", ctrl: false, meta: false, shift: false });
  const down = (): void =>
    renderer.press({ name: "down", ctrl: false, meta: false, shift: false });

  // 运行中：先聚焦回合区，再让内容超出窗口（每 chunk 一个 notice 形态的推进）
  renderer.press({ name: "t", ctrl: true, meta: false, shift: false });
  assert.equal(focused(), "activity", "Ctrl+T 聚焦回合区");
  adapter.push({ type: "stream", sessionId: "s1", text: "第一回合回复\n" });
  for (let i = 0; i < 30; i++)
    adapter.push({ type: "notice", text: `turn1 行 ${i}` });
  assert.ok(actFirst().startsWith("turn1 行"), "turn1 内容显示");
  assert.equal(scroll(), 0, "默认跟随最新");
  assert.equal(focused(), "activity", "流式 / 通知推进后焦点保持");

  // ↑ 滚该区域（不是会话区）：越过可视上限后钳到最早行
  for (let i = 0; i < 25; i++) up();
  assert.ok(scroll() > 0, "↑ 已滚动回合区");
  assert.ok(actLines().includes("turn1 行 0"), "上滚越过可视上限后钳到最早行");

  // 期间继续到达的流式 chunk：焦点与视口位置都不被打断。
  // 2026-10-18 起活动区按「距底偏移 + 增长补偿」保持视口（见 App.syncActivityPos）：
  // 内容增长时偏移会等量增大，故断言从「偏移不变」改为「偏移只增不减 + 视口仍在最早行」。
  const held = scroll();
  for (let i = 0; i < 3; i++)
    adapter.push({ type: "stream", sessionId: "s1", text: `后续内容 ${i}\n` });
  assert.equal(focused(), "activity", "流式 chunk 后焦点仍保持");
  assert.ok(scroll() >= held, "流式 chunk 后滚动位置未被重置回底部");
  assert.ok(actLines().includes("turn1 行 0"), "仍在最早行（未弹回底部）");

  // ↓ 连续按回底部 → 恢复跟随最新（后续新内容才可见）
  for (let i = 0; i < 60; i++) down();
  assert.equal(scroll(), 0, "↓ 回到底部跟随最新");
  // 注：正文行经六步流水线归入会话区（历史 pane），回合区只承载思考/工具/notice 等
  // 活动行——故这里不断言正文可见，只验证「回到底部」这一滚动语义本身
  assert.equal(focused(), "activity", "↓ 之后焦点仍在回合区");
});

test("App 端到端：提交输入后回无焦点（焦点只由用户动作退出）", () => {
  // 条目验收②：焦点只在用户显式退出与**提交输入**时回无焦点（= 跟随最新）。
  // 这里走真实提交路径（输入字符 + Enter → submit() → sendUserText 派发 user-line）。
  const { app, renderer, adapter } = makeApp();
  renderer.size = { cols: 100, rows: 24 };
  const focused = (): unknown =>
    (app as unknown as { state: { focusedPanel: unknown } }).state.focusedPanel;

  adapter.push({ type: "stream", sessionId: "s1", text: "上一回合回复\n" });
  adapter.push({ type: "turn-end" });
  renderer.press({ name: "t", ctrl: true, meta: false, shift: false });
  assert.equal(focused(), "activity", "Ctrl+T 聚焦回合区");

  // 提交输入（真实按键路径）
  for (const ch of Array.from("新问题")) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.equal(focused(), null, "提交输入后回无焦点");
  assert.ok(
    adapter.log.some((l) => l.includes("新问题")),
    "消息已发出（提交路径生效）",
  );

  // 回合开始 / 流式推进不再把焦点「清」成默认态，而是保持用户设定
  renderer.press({ name: "e", ctrl: true, meta: false, shift: false });
  assert.equal(focused(), "history", "再次 Ctrl+E 聚焦会话区");
  adapter.push({ type: "stream", sessionId: "s1", text: "回复中\n" });
  adapter.push({ type: "turn-end" });
  assert.equal(focused(), "history", "流式与回合边界都不再清焦点");
});

test("App 端到端：排队消息在新回合被认领（清焦点语义保持不变）", () => {
  // 覆盖 2026-10-15 给 `queued-claim` 加的「队列非空才派发」前置：
  // 真排队时仍要弹队列，且用户提交输入的清焦点语义不变（条目期望②）。
  const { app, renderer, adapter } = makeApp();
  renderer.size = { cols: 100, rows: 24 };
  const probe = app as unknown as {
    state: { focusedPanel: unknown; queued: unknown[] };
  };
  const press = (name: string, ctrl = false): void =>
    renderer.press({ name, ctrl, meta: false, shift: false });
  const typeAndEnter = (text: string): void => {
    for (const ch of Array.from(text)) press(ch);
    press("enter");
  };

  // 回合运行中（agent 非 idle → 提交走排队）
  adapter.push({ type: "agent-status", sessionId: "s1", status: "thinking" });
  adapter.push({ type: "stream", sessionId: "s1", text: "第一回合回复\n" });
  press("e", true);
  assert.equal(probe.state.focusedPanel, "history", "Ctrl+E 聚焦会话区");

  press("<"); // 切到 followup 模式 → Enter 排队等下一回合
  typeAndEnter("排队的问题");
  assert.equal(
    probe.state.queued.length,
    1,
    "followup 在运行中进入排队块（而不是直发）",
  );
  assert.equal(
    probe.state.focusedPanel,
    null,
    "排队登记属用户提交输入 → 回无焦点",
  );
  assert.ok(
    adapter.log.some((l) => l.includes("排队的问题")),
    "排队消息已投递给宿主",
  );

  // 新回合开始：队列被认领（`queued-claim` 仍会派发——队列非空）
  adapter.push({ type: "turn-end" });
  adapter.push({ type: "stream", sessionId: "s1", text: "第二回合回复\n" });
  assert.equal(probe.state.queued.length, 0, "新回合认领后队列清空");

  // 认领后焦点保持无焦点（不被内容推进「点亮」，也不残留旧焦点）
  assert.equal(probe.state.focusedPanel, null, "新回合后仍无焦点");
});
