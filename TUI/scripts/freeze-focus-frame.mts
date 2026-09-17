// TUI/scripts/freeze-focus-frame.mts — 冻结焦点构图与面板渲染基线（接线汇合里程碑前置）
//
// 一次性工具：调用当前 buildFrame 输出固化为 fixtures/focus-frame-legacy.json，
// 以供 tests/focus-frame.test.ts 从 fixture 读取基线做双轨对照（旧实现删除后
// 对照测试仍独立可回归）。新增场景（面板/焦点态）须双处同步（脚本 + 测试）。
//
// 用法：node --experimental-transform-types scripts/freeze-focus-frame.mts
//
// 序列化口径：整帧每行 { text, ansi } —— text=纯文本拼接（行宽 infos 保留），
// ansi=行经 dark 主题段级序列化（样式差异捕获）。key=`scene@w{cols}`。

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildFrame } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { AppState } from "../src/app/state.ts";
import { rowAnsi } from "../tests/helpers/rowText.ts";
import type { FrameRow } from "../src/renderer/screen.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "tests", "fixtures", "focus-frame-legacy.json");

/** 基线帧：整帧每行 {text, ansi} */
type Row = { text: string; ansi: string };
type Entry = { rows: Row[] };
type Fixture = Record<string, Entry>;

const TF = { rows: 24 } as const;

/** 基础内容帧（含历史 final 回复 + 活动区流式输出）——构造入口 */
function baseState(): AppState {
  let s = initialState();
  s = reduceState(s, {
    type: "status",
    status: { time: "12:00:00", cwd: "/home/u", git: "main" },
  });
  s = reduceState(s, { type: "user-line", text: "第一行" });
  s = reduceState(s, { type: "append", text: "中间输出一段" });
  s = reduceState(s, { type: "thinking", text: "思考过程" });
  s = reduceState(s, { type: "turn-end" });
  s = reduceState(s, { type: "append", text: "最终总结回复" });
  return s;
}

function rowsOf(s: AppState, cols: number): Row[] {
  return buildFrame(s, { ...TF, cols }).map((r: FrameRow) => ({
    text: r.segments.map((g) => g.text).join(""),
    ansi: rowAnsi(r),
  }));
}

const fixture: Fixture = {};

// —— 焦点态场景：基础帧 × {null,history,activity,status} × {w60, w20} ——
for (const cols of [60, 20]) {
  for (const t of ["null", "history", "activity", "status"] as const) {
    let s = baseState();
    // 用 focus-panel-cycle 走到目标焦点态（null 不进入；state 默认 null）
    if (t === "history") s = reduceState(s, { type: "focus-panel-cycle" });
    else if (t === "activity")
      s = reduceState(
        reduceState(s, { type: "focus-panel-cycle" }),
        { type: "focus-panel-cycle" },
      );
    else if (t === "status")
      s = reduceState(
        reduceState(reduceState(s, { type: "focus-panel-cycle" }), {
          type: "focus-panel-cycle",
        }),
        { type: "focus-panel-cycle" },
      );
    fixture[`focus-${t}@w${cols}`] = { rows: rowsOf(s, cols) };
  }
}

// —— 面板场景：7 面板各 1 基础场景（w60）——
// approval
{
  let s = baseState();
  s = reduceState(s, { type: "approval", approval: { id: "a1", prompt: "允许?" } });
  fixture[`panel-approval@w60`] = { rows: rowsOf(s, 60) };
}
// question
{
  let s = baseState();
  s = reduceState(s, {
    type: "question-open",
    id: "q1",
    questions: [
      {
        id: "qa",
        question: "是否继续？",
        options: [{ label: "是" }, { label: "否" }],
        multiSelect: false,
      },
    ],
  });
  fixture[`panel-question@w60`] = { rows: rowsOf(s, 60) };
}
// picker（/model）
{
  let s = baseState();
  s = reduceState(s, {
    type: "picker-open",
    picker: {
      providers: ["doubao"],
      providerIndex: 0,
      providerModels: { doubao: ["doubao-pro", "doubao-lite"] },
      models: ["doubao-pro", "doubao-lite"],
      modelIndex: 0,
      efforts: [],
      effortIndex: -1,
      phase: 0,
      selectedProvider: "doubao",
      selectedModel: "doubao-pro",
      selectedEffort: "",
    },
  });
  fixture[`panel-picker@w60`] = { rows: rowsOf(s, 60) };
}
// statusPanel（/policy 等通用选项面板）
{
  let s = baseState();
  s = reduceState(s, {
    type: "status-panel-open",
    panel: {
      kind: "policy",
      title: "/policy（当前：ask）",
      options: [
        { id: "ask", label: "ask" },
        { id: "never", label: "never" },
      ],
      index: 0,
      selected: "ask",
    },
  });
  fixture[`panel-statusPanel@w60`] = { rows: rowsOf(s, 60) };
}
// jobsPanel（/jobs；需先推入 jobs 列表）
{
  let s = baseState();
  s = reduceState(s, {
    type: "jobs-changed",
    sessionId: "cur",
    jobs: [
      { id: "j1", kind: "task", label: "任务一", status: "running" },
      { id: "j2", kind: "task", label: "任务二", status: "success" },
    ],
  });
  s = reduceState(s, { type: "jobs-panel-open" });
  fixture[`panel-jobsPanel@w60`] = { rows: rowsOf(s, 60) };
}
// history（/history 会话面板）
{
  let s = baseState();
  s = reduceState(s, { type: "history-open" });
  s = reduceState(s, {
    type: "history-list",
    records: [
      { id: "s1", title: "会话甲", createdAt: 1, live: false, persisted: true },
      { id: "s2", title: "会话乙", createdAt: 2, live: false, persisted: true },
    ],
  });
  fixture[`panel-history@w60`] = { rows: rowsOf(s, 60) };
}
// completion（/ 命令补全）
{
  let s = baseState();
  s = reduceState(s, { type: "input", text: "/", cursor: 1 });
  s = reduceState(s, {
    type: "command-catalog",
    commands: [
      { name: "help", desc: "帮助" },
      { name: "theme", desc: "主题" },
    ],
  });
  fixture[`panel-completion@w60`] = { rows: rowsOf(s, 60) };
}

writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
console.log(`frozen ${Object.keys(fixture).length} scenes -> ${outPath}`);
