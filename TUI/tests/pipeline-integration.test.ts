// tests/pipeline-integration.test.ts — 模块组合后的整体流水线测试（集成层）
//
// 目的：把 §1 split → §2 parse → §3 route → §4 structure → §5 measure → §6 flatten
// → §7 compose（经 `pipelineContent` 接线桥）串成一个整体，再经 `buildFrame` 到整帧，
// 断言**组合输出**的结构一致性与可消费性（不钉旧链路逐字节，那些是整体层 46 例的事）。
//
// 结构不变式：
//  - counts 各段之和 === 实际行数；
//  - keys 与 counts 一一对应（滚动段键契约）；
//  - dialogueUserRows 落在用户块首行；
//  - 渐进窗口 dropped 正确（内容不足窗口时为 0）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pipelineContent,
  sectionsOf,
} from "../src/app/layout/pipeline/frame.ts";
import { buildFrame } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import {
  sectionsFromScript,
  turnScript,
  type ScriptStep,
} from "./helpers/deliveriesFromScript.ts";

test("集成：交付流 → 两 pane 内容 + counts/keys/userRows 结构一致", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "status",
    status: { time: "12:00:00", cwd: "/w", git: "main" },
  });
  const T = 1_700_000_000_000;
  const steps = [
    ...turnScript({
      turn: 1,
      time: T,
      user: "第一问",
      assistant: "这是终态正文，足够长到多行，把整条会话区填起来。",
      reason: "completed",
    }),
  ];
  s = { ...s, pipeline: sectionsFromScript(steps) };
  const built = pipelineContent(sectionsOf(s), {
    dialogueTextW: 60,
    activityTextW: 60,
    windowGroups: s.windowGroups,
    render: { width: 60, activityWidth: 60 },
  });
  // counts 之和 === 实际行数
  assert.equal(
    built.dialogueCounts.reduce((a, b) => a + b, 0),
    built.dialogue.length,
    "对话 counts 与行数一致",
  );
  assert.equal(
    built.activityCounts.reduce((a, b) => a + b, 0),
    built.activity.length,
    "活动 counts 与行数一致",
  );
  // keys 与 counts 对齐（对话区）
  assert.equal(built.dialogueKeys.length, built.dialogueCounts.length);
  // 内容可达：会话区含正文
  const diaText = built.dialogue
    .map((r) => r.segments.map((x) => x.text).join(""))
    .join("");
  assert.ok(diaText.includes("终态正文"), "会话区含正文");
  // 窗口足够 → dropped 0
  assert.equal(built.dropped, 0, "内容不足窗口不丢更早");
});

test("集成：userRows 指向用户块首行（会话区内）", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "status",
    status: { time: "12:00:00", cwd: "/w", git: "main" },
  });
  const steps = [
    ...turnScript({
      turn: 1,
      time: 1_700_000_000_000,
      user: "问",
      assistant: "答",
      reason: "completed",
    }),
  ];
  s = { ...s, pipeline: sectionsFromScript(steps) };
  const built = pipelineContent(sectionsOf(s), {
    dialogueTextW: 60,
    activityTextW: 60,
    windowGroups: s.windowGroups,
    render: { width: 60, activityWidth: 60 },
  });
  assert.equal(built.dialogueUserRows.length >= 1, true, "有用户块行号");
  const first = built.dialogueUserRows[0]!;
  assert.ok(first >= 0 && first < built.dialogue.length, "行号在界内");
});

test("集成：整帧 buildFrame 可跑通（各段组合 → FrameRow[]，含正文与区分隔）", () => {
  let s = initialState(undefined, { activityPlacement: "vertical" });
  s = reduceState(s, {
    type: "status",
    status: { time: "12:00:00", cwd: "/w", git: "main" },
  });
  const steps = [
    ...turnScript({
      turn: 1,
      time: 1_700_000_000_000,
      user: "问",
      assistant: "一行正文",
      reason: "completed",
    }),
  ];
  s = { ...s, pipeline: sectionsFromScript(steps) };
  const frame = buildFrame(s, { cols: 80, rows: 24 });
  const txt = frame
    .map((r) => r.segments.map((x) => x.text).join(""))
    .join("\n");
  assert.ok(frame.length > 0, "帧产生");
  assert.ok(txt.includes("一行正文"), "正文上屏");
  assert.ok(txt.includes("╌"), "回合/步分隔线存在");
});

test("集成：多回合 → 会话区出现回合分隔、counts 仍一致、正文段可排序", () => {
  let s = initialState(undefined, { activityPlacement: "vertical" });
  s = reduceState(s, {
    type: "status",
    status: { time: "12:00:00", cwd: "/w", git: "main" },
  });
  const T = 1_700_000_000_000;
  const steps = [
    ...turnScript({
      turn: 1,
      time: T,
      user: "问一",
      assistant: "答一",
      reason: "completed",
    }),
    ...turnScript({
      turn: 2,
      time: T + 60_000,
      user: "问二",
      assistant: "答二",
      reason: "completed",
    }),
  ];
  s = { ...s, pipeline: sectionsFromScript(steps) };
  const built = pipelineContent(sectionsOf(s), {
    dialogueTextW: 60,
    activityTextW: 60,
    windowGroups: s.windowGroups,
    render: { width: 60, activityWidth: 60 },
  });
  assert.equal(
    built.dialogueCounts.reduce((a, b) => a + b, 0),
    built.dialogue.length,
    "multi counts",
  );
  const sep = built.dialogue.filter((r) => r.kind === "separator").length;
  assert.ok(sep >= 1, "多回合有回合分隔行");
  const txt = built.dialogue
    .map((r) => r.segments.map((x) => x.text).join(""))
    .join("");
  assert.ok(txt.includes("答二"), "最新正文在");
});

test("集成：工具批进活动区（名字/结果行 kind 可读）", () => {
  let s = initialState(undefined, { activityPlacement: "vertical" });
  const steps: ScriptStep[] = [
    { delivery: { kind: "turn-start", turn: 1 } },
    { delivery: { kind: "user", turn: 1, step: 0, text: "跑一下" } },
    {
      delivery: {
        kind: "tool-call",
        turn: 1,
        step: 1,
        callId: "c1",
        name: "bash",
        args: "{}",
      },
    },
    {
      delivery: {
        kind: "tool-result",
        turn: 1,
        step: 1,
        callId: "c1",
        ok: true,
        detail: "ok out",
      },
    },
  ];
  s = { ...s, pipeline: sectionsFromScript(steps) };
  const built = pipelineContent(sectionsOf(s), {
    dialogueTextW: 60,
    activityTextW: 60,
    windowGroups: s.windowGroups,
    render: { width: 60, activityWidth: 60 },
  });
  assert.ok(
    built.activity.some((r) => r.kind === "tool-name"),
    "活动区有工具名行",
  );
  assert.ok(
    built.activity.some((r) => r.kind === "tool-result"),
    "活动区有结果行",
  );
});

test("集成：窗口不足 → 丢弃更早、dropped > 0（渐进窗口结构成立）", () => {
  let s = initialState();
  const steps = [
    ...turnScript({
      turn: 1,
      time: 1,
      user: "问一",
      assistant: "答一",
      reason: "completed",
    }),
    ...turnScript({
      turn: 2,
      time: 2,
      user: "问二",
      assistant: "答二",
      reason: "completed",
    }),
    ...turnScript({
      turn: 3,
      time: 3,
      user: "问三",
      assistant: "答三",
      reason: "completed",
    }),
  ];
  s = { ...s, pipeline: sectionsFromScript(steps) };
  const built = pipelineContent(sectionsOf(s), {
    dialogueTextW: 60,
    activityTextW: 60,
    windowGroups: 1, // 只留最近 1 组
    render: { width: 60, activityWidth: 60 },
  });
  assert.ok(built.dropped > 0, "窗口小丢更早回合");
});
