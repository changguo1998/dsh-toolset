// tests/buffer-retire.test.ts — 条目 7 选项 1 / 条目 16 段 C2：生产路径的 `local` 只承载 UI 本地行
//
// 条目 16 段 C2 之后，内容（用户块 / 正文 / 思考 / step 头 / 工具批）的唯一来源是节缓存
// `state.pipeline`（交付驱动），`local` 只剩 UI 本地行：
//   - 交付把内容送进节缓存，缓冲里没有内容行（本文件用交付构造器造内容；App 级同型断言见
//     `tests/p5-blank-chunk.test.ts` 与 `tests/pipeline-app.test.ts`）；
//   - UI 本地行（notice / shell / 辅助工具行 / 重试提示）仍写缓冲——底部 toast 与 App 的
//     事件补投需要它们（见追踪文档第四阶段）；
//   - 用户输入开启的回合清掉活动区提示行；历史恢复 / 会话切换清空缓冲（不带上一会话的本地行）。
//
// 已退场的口径：`bufferRetainsContent` / `CONTENT_ACTIONS` 的「内容写缓冲闸门」与
// 「缺省仍承载内容（测试 / 嵌入用法）」——C2 后内容类 action 只承载状态事实
// （`inputStatus` / 回合号 / `strippedChars` …），不再有内容类缓冲写入。
//
// 读侧迁移的 App 级回归（`/copy` 取节模型）见 `tests/pipeline-app.test.ts`。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initialState,
  reduceState,
  type AppState,
  type StateAction,
} from "../src/app/state.ts";
import {
  allSections,
  applyDelivery,
  createSections,
  lastTextOfSources,
} from "../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";
import {
  withStep,
  withText,
  withToolCall,
  withToolResult,
  withUser,
} from "./helpers/pipelineContent.ts";

/** 固定时间戳（本地时间 03:04:05）——step 声明用 */
const T0 = new Date(2026, 0, 2, 3, 4, 5).getTime();

/**
 * 生产口径 state：注入节缓存（内容唯一来源 = 节缓存；App 装配时同此）。
 *
 * 条目 16 段 C2：内容类 action 不再写缓冲（开关 `bufferRetainsContent` 已删），本文件其余
 * 断言即生产口径。
 */
function prod(): AppState {
  return reduceState(initialState(), {
    type: "pipeline-state",
    pipeline: createSections(),
  });
}

const applyAll = (s: AppState, actions: readonly StateAction[]): AppState =>
  actions.reduce((acc, action) => reduceState(acc, action), s);

test("交付把内容送进节缓存；缓冲里没有内容行", () => {
  let s = prod();
  s = withUser(s, "你好");
  s = withText(s, "回复正文", "assistant");
  s = withText(s, "想一下", "reasoning");
  s = withStep(s, 1, T0);
  s = withToolCall(s, "bash", "echo hi", "c1");
  s = withToolResult(s, true, "hi", "c1");
  const dump = JSON.stringify(allSections(s.pipeline!));
  for (const text of ["你好", "回复正文", "想一下", "echo hi", "hi"])
    assert.ok(
      dump.includes(text),
      `节缓存应含「${text}」：${dump.slice(0, 200)}`,
    );
  assert.deepEqual(
    [...(s.pipeline?.stepMeta.keys() ?? [])],
    ["1:1"],
    "step 声明进节缓存元数据",
  );
  assert.deepEqual(s.local, [], "缓冲不承载会话内容（local 只留 UI 本地行）");
});

test("UI 本地行照写（toast / 事件补投的来源）", () => {
  const local = applyAll(prod(), [
    { type: "notice", text: "提示一下", tone: "warn" },
    { type: "shell-lines", lines: [{ text: "$ echo hi" }] },
    {
      type: "retry",
      attempt: 2,
      max: 3,
      delayMs: 1500,
      code: "429",
    },
    {
      type: "subagent",
      sessionId: "s1",
      label: "researcher",
      mode: "one-shot",
    },
  ]);
  assert.deepEqual(
    local.local.map((l) => l.kind),
    ["notice", "shell", "notice", "tool"],
    "UI 本地行照写（底部 toast 与 A1 补投依赖）",
  );
});

test("用户输入开启的回合：清掉活动区提示行（toast 不挂上一回合的提示）", () => {
  const s = applyAll(prod(), [
    { type: "notice", text: "上一回合的提示" },
    { type: "subagent", sessionId: "s1", label: "a", mode: "one-shot" },
    { type: "turn-begin", clearActivity: true },
  ]);
  assert.deepEqual(s.local, [], "notice / 工具行被清掉");
});

test("历史恢复 / 会话切换：缓冲清空（不带上一会话的 UI 本地行）", () => {
  const rows = [
    { text: "旧提问", kind: "user" as const },
    { text: "旧回答", kind: "assistant" as const, final: true },
  ];
  const s = applyAll(prod(), [
    { type: "notice", text: "恢复前的提示" },
    { type: "history-restore", id: "s2", title: "t", rows },
  ]);
  assert.deepEqual(s.local, [], "恢复行只进节模型（批 A2），缓冲清空");
  assert.equal(s.activeSessionId, "s2", "状态事实保留");
});

test("lastTextOfSources：按节序取最后一条匹配来源的非空文本", () => {
  const deliveries: BlockDelivery[] = [
    {
      kind: "text",
      turn: 1,
      step: 0,
      index: 0,
      source: "assistant",
      text: "先说明",
      full: true,
    },
    { kind: "user", turn: 1, step: 1, text: "选哪个" },
  ];
  const sections = deliveries.reduce(applyDelivery, createSections());
  assert.equal(lastTextOfSources(sections, ["assistant", "user"]), "选哪个");
  assert.equal(lastTextOfSources(sections, ["assistant"]), "先说明");
  assert.equal(lastTextOfSources(sections, ["shell"]), undefined);
});
