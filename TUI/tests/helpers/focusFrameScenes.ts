// tests/helpers/focusFrameScenes.ts — 焦点构图双轨对照的场景构造（**唯一来源**）
//
// tests/focus-frame.test.ts（对照断言）与 scripts/freeze-focus-frame.mts（重冻夹具）
// 共用本模块，保证「重冻出的基线」与「断言用的 state」逐字同源——此前两处各写一份
// 构造，冻结脚本停在「内容不进 pipeline」的旧写法，夹具与断言长期错位。
//
// 场景键格式：`{scene}@w{cols}`；覆盖焦点态 null/history/activity/status × 60/20 列、
// 七个面板场景（approval/question/picker/statusPanel/jobsPanel/history/completion）。

import { initialState, reduceState } from "../../src/app/state.ts";
import type { AppState } from "../../src/app/state.ts";
import { withText, withTurnEnd, withUser } from "./pipelineContent.ts";
import assert from "node:assert/strict";

/** 基础内容帧（历史 final 回复 + 活动区流式输出），走交付流（pipeline）构造 */
export function baseState(): AppState {
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

/** 场景 → 目标 state（对照断言与冻结脚本共用） */
export function stateFor(scene: string): AppState {
  const kind = scene.split("@")[0]!;
  let s = baseState();
  if (kind.startsWith("focus-")) {
    const t = kind.slice("focus-".length);
    assert.ok(
      t === "null" || t === "history" || t === "activity" || t === "status",
      `未知焦点场景 ${scene}`,
    );
    // null = 无焦点（state 默认）；其余一键聚焦对应区域
    return t === "null" ? s : reduceState(s, { type: "focus-panel", panel: t });
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

/** 场景 → 列宽（`@w{cols}` 后缀；与冻结脚本一致） */
export function colsFor(scene: string): number {
  const [, w] = scene.split("@");
  return Number(w!.slice(1));
}

/** 本夹具覆盖的全部场景键（顺序即冻结脚本的写出顺序） */
export const FOCUS_FRAME_SCENES: readonly string[] = [
  ...([60, 20] as const).flatMap((cols) =>
    (["null", "history", "activity", "status"] as const).map(
      (t) => `focus-${t}@w${cols}`,
    ),
  ),
  "panel-approval@w60",
  "panel-question@w60",
  "panel-picker@w60",
  "panel-statusPanel@w60",
  "panel-jobsPanel@w60",
  "panel-history@w60",
  "panel-completion@w60",
];
