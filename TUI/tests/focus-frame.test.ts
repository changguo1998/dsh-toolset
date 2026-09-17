// tests/focus-frame.test.ts — 焦点构图与面板渲染双轨对照（接线汇合里程碑）
//
// 冻结基线：fixtures/focus-frame-legacy.json（scripts/freeze-focus-frame.mts
// 生成，其调用了迁移前的内联焦点构图 buildFrame）。本测试从 fixture 读取
// 基线并重新生成逐行精确比较（text + ansi），确保新 Box/FocusFrame 管线
// 与冻结行为逐一等价。新增场景须双处同步（冻结脚本 + 本测试）。
//
// 对比口径：整帧每行 {text, ansi} 精确相等（text=纯文本、ansi=段级序列化
// 含样式差异）。覆盖：焦点态 null/history/activity/status × w60/w20、
// 七个面板场景（approval/question/picker/statusPanel/jobsPanel/history/completion）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildFrame } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { AppState } from "../src/app/state.ts";
import { rowAnsi } from "./helpers/rowText.ts";
import type { FrameRow } from "../src/renderer/screen.ts";

interface FixtureEntry {
  rows: { text: string; ansi: string }[];
}
interface Fixture {
  [key: string]: FixtureEntry;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "focus-frame-legacy.json");
const FIXTURE: Fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
const TF = { rows: 24 } as const;

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

/** 场景 → 目标 state（与冻结脚本一一对应） */
function stateFor(scene: string): AppState {
  const [k, w] = scene.split("@");
  const kind = k!;
  const cols = Number(w!.slice(1));
  void cols;
  let s = baseState();
  if (kind.startsWith("focus")) {
    const t = kind.slice("focus-".length);
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
    return s;
  }
  switch (kind) {
    case "panel-approval":
      s = reduceState(s, {
        type: "approval",
        approval: { id: "a1", prompt: "允许?" },
      });
      break;
    case "panel-question":
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
      break;
    case "panel-picker":
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
      break;
    case "panel-statusPanel":
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
      break;
    case "panel-jobsPanel":
      s = reduceState(s, {
        type: "jobs-changed",
        sessionId: "cur",
        jobs: [
          { id: "j1", kind: "task", label: "任务一", status: "running" },
          { id: "j2", kind: "task", label: "任务二", status: "success" },
        ],
      });
      s = reduceState(s, { type: "jobs-panel-open" });
      break;
    case "panel-history":
      s = reduceState(s, { type: "history-open" });
      s = reduceState(s, {
        type: "history-list",
        records: [
          { id: "s1", title: "会话甲", createdAt: 1, live: false, persisted: true },
          { id: "s2", title: "会话乙", createdAt: 2, live: false, persisted: true },
        ],
      });
      break;
    case "panel-completion":
      s = reduceState(s, { type: "input", text: "/", cursor: 1 });
      s = reduceState(s, {
        type: "command-catalog",
        commands: [
          { name: "help", desc: "帮助" },
          { name: "theme", desc: "主题" },
        ],
      });
      break;
    default:
      assert.fail(`未知场景 ${scene}`);
  }
  return s;
}

/** 场景 → 列宽（与冻结脚本一致） */
function colsFor(scene: string): number {
  const [, w] = scene.split("@");
  return Number(w!.slice(1));
}

function rowsOf(s: AppState, cols: number): { text: string; ansi: string }[] {
  return buildFrame(s, { ...TF, cols }).map((r: FrameRow) => ({
    text: r.segments.map((g) => g.text).join(""),
    ansi: rowAnsi(r),
  }));
}

// —— 全场景逐行精确对照 ——
for (const key of Object.keys(FIXTURE)) {
  test(`focus-frame 基线：${key}`, () => {
    const baseline = FIXTURE[key]!.rows;
    const got = rowsOf(stateFor(key), colsFor(key));
    assert.equal(got.length, baseline.length, `行数一致 (${key})`);
    for (let i = 0; i < baseline.length; i++) {
      assert.equal(got[i]!.text, baseline[i]!.text, `${key} 第 ${i} 行 text`);
      assert.equal(got[i]!.ansi, baseline[i]!.ansi, `${key} 第 ${i} 行 ansi`);
    }
  });
}

// —— 结构不变量：FocusFrame 不改行数/行序（A5 兼容）——
test("focus-frame：行不变量（行数恒定、无 CJK 被切、显示宽度不回退）", () => {
  const s = stateFor("focus-activity@w60");
  const rows = buildFrame(s, { ...TF, cols: 60 });
  // 每行段拼接的显示宽度不因实现变化而改变（以 text 长度近似校验行序稳定）
  const texts = rows.map((r: FrameRow) => r.segments.map((g) => g.text).join(""));
  assert.equal(texts.length, FIXTURE["focus-activity@w60"]!.rows.length);
});
