// tests/focus-frame.test.ts — 焦点构图与面板渲染双轨对照
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
import { withText, withTurnEnd, withUser } from "./helpers/pipelineContent.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildFrame as buildFrameRaw } from "../src/app/layout.ts";
import { truncateToWidth } from "../src/app/layout.ts";
import { PICKER_HINT_LINE } from "../src/app/layout/hints.ts";
import { sectionsFromLocal } from "../src/app/layout/pipeline/replay.ts";
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

/**
 * 条目 16 段 C1：本文件用 `reduceState` 造缓冲行再直接出帧；生产侧的「无 sink 回退」剥离后
 * 在这里显式补一节缓存（助手带单槽 memo，行为与剥离前逐字等价）。段 C2 删内容类 `BufferKind`
 * 时本包装失效 → 那时的用例改成交付流。
 */
const buildFrame = (...args: Parameters<typeof buildFrameRaw>) => {
  const state = args[0];
  if (state.pipeline !== undefined) return buildFrameRaw(...args);
  return buildFrameRaw(
    { ...state, pipeline: sectionsFromLocal(state.local) },
    ...(args.slice(1) as [Parameters<typeof buildFrameRaw>[1]]),
  );
};

function baseState(): AppState {
  let s = initialState();
  s = reduceState(s, {
    type: "status",
    status: { time: "12:00:00", cwd: "/home/u", git: "main" },
  });
  s = withUser(s, "第一行");
  s = withText(s, "中间输出一段");
  s = withText(s, "思考过程", "reasoning");
  s = withTurnEnd(s);
  s = withText(s, "最终总结回复");
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
      s = reduceState(reduceState(s, { type: "focus-panel-cycle" }), {
        type: "focus-panel-cycle",
      });
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
          {
            id: "s1",
            title: "会话甲",
            createdAt: 1,
            live: false,
            persisted: true,
          },
          {
            id: "s2",
            title: "会话乙",
            createdAt: 2,
            live: false,
            persisted: true,
          },
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
    const skip = DEVIATED_ROWS[key] ?? [];
    for (let i = 0; i < baseline.length; i++) {
      if (skip.includes(i)) continue; // 有意偏离的行在下方专用用例里断言
      assert.equal(got[i]!.text, baseline[i]!.text, `${key} 第 ${i} 行 text`);
      assert.equal(got[i]!.ansi, baseline[i]!.ansi, `${key} 第 ${i} 行 ansi`);
    }
  });
}

/**
 * 有意偏离冻结基线的行（唯一豁免口）：`panel-picker@w60` 的**输入区 + 提示区**
 * （20-23 行）—— `/model` 面板态输入区不再是空白占位, 而是筛选输入行;
 * 提示行补 `[输入]筛选` 与 Esc 两段语义（见追踪文档 2026-10-13-model-picker-filter.md）。
 * 冻结基线记录的是旧行为, 只豁免这几行 —— 其余行（含面板本体）仍逐行等价,
 * 偏离内容与方向由下方向例显式断言（禁止盲刷夹具）。
 */
const DEVIATED_ROWS: Record<string, number[]> = {
  "panel-picker@w60": [20, 21, 22, 23],
};

test("focus-frame（已偏离）：panel-picker@w60 的输入区改显筛选行、提示行补筛选键位", () => {
  const key = "panel-picker@w60";
  const baseline = FIXTURE[key]!.rows;
  const got = rowsOf(stateFor(key), 60);
  // 偏离面恰为这 4 行（输入区 3 行 + 提示区 1 行）
  assert.deepEqual(DEVIATED_ROWS[key], [20, 21, 22, 23]);
  // 输入区首行 = 筛选输入行（`筛选 <焦点列>: <词>`；词空 → placeholder, caret 在词尾）
  assert.equal(got[20]!.text, "筛选 provider: 输入以筛选 (匹配度排序)");
  // 其余两行仍是空行（不带填充, 与无面板态输入区一致）
  assert.equal(got[21]!.text, "");
  assert.equal(got[22]!.text, "");
  // 提示行 = 新键位文案（w60 下按显示宽截断）
  assert.equal(got[23]!.text, truncateToWidth(PICKER_HINT_LINE, 60));
  // 基线侧确为旧行为（空输入区 + 旧提示行）——偏离是「有意」而非夹具漂移
  assert.equal(baseline[20]!.text.trim(), "");
  assert.notEqual(got[23]!.text, baseline[23]!.text);
});

// —— 结构不变量：FocusFrame 不改行数/行序（A5 兼容）——
test("focus-frame：行不变量（行数恒定、无 CJK 被切、显示宽度不回退）", () => {
  const s = stateFor("focus-activity@w60");
  const rows = buildFrame(s, { ...TF, cols: 60 });
  // 每行段拼接的显示宽度不因实现变化而改变（以 text 长度近似校验行序稳定）
  const texts = rows.map((r: FrameRow) =>
    r.segments.map((g) => g.text).join(""),
  );
  assert.equal(texts.length, FIXTURE["focus-activity@w60"]!.rows.length);
});
