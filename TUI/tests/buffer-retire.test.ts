// tests/buffer-retire.test.ts — 条目 7 选项 1：生产路径的缓冲不承载会话内容
//
// 覆盖 `bufferRetainsContent: false`（App 注入节缓存时置否）的口径：
//   - 内容类 action（正文 / 用户行 / 思考 / step / 工具行 / 分隔线 / 恢复行）只更新状态
//     事实，不写缓冲；
//   - UI 本地行（notice / shell / 辅助工具行）仍写缓冲——底部 toast 与 App 的事件补投
//     需要它们（见追踪文档第四阶段）；
//   - 用户输入开启的回合清掉活动区提示行；历史恢复清空缓冲（不带上一会话的本地行）；
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
  applyDelivery,
  createSections,
  lastTextOfSources,
} from "../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../src/app/layout/pipeline/types.ts";

/** 生产口径 state：注入节缓存 + 关掉「缓冲承载会话内容」 */
function prod(): AppState {
  return reduceState(initialState(), {
    type: "pipeline-state",
    pipeline: createSections(),
    bufferRetainsContent: false,
  });
}

const applyAll = (s: AppState, actions: readonly StateAction[]): AppState =>
  actions.reduce((acc, action) => reduceState(acc, action), s);

test("内容类 action 不写缓冲；UI 本地行仍写（toast / 事件补投的来源）", () => {
  const content: StateAction[] = [
    { type: "append", text: "回复正文" },
    { type: "user-line", text: "你好" },
    { type: "thinking", text: "想一下" },
    { type: "step", sessionId: "s1", turn: 1, step: 1, phase: "start" },
    { type: "tool-call", sessionId: "s1", name: "bash", summary: "echo hi" },
    { type: "tool-result", sessionId: "s1", ok: true, detail: "hi" },
    { type: "turn-begin", clearActivity: false },
  ];
  const kept = applyAll(prod(), content);
  assert.deepEqual(kept.buffer, [], "缓冲不承载会话内容");
  assert.equal(kept.nextSeq, 1, "行号不因内容推进");

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
    local.buffer.map((l) => l.kind),
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
  assert.deepEqual(s.buffer, [], "notice / 工具行被清掉");
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
  assert.deepEqual(s.buffer, [], "恢复行只进节模型（批 A2），缓冲清空");
  assert.equal(s.activeSessionId, "s2", "状态事实保留");
});

test("缺省仍承载内容（测试 / 嵌入用法不变）", () => {
  const s = applyAll(initialState(), [
    { type: "append", text: "回复正文" },
    { type: "user-line", text: "你好" },
  ]);
  assert.deepEqual(
    s.buffer.map((l) => l.text),
    ["回复正文", "你好"],
    "bufferRetainsContent 缺省 true",
  );
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
