// tests/input-history.test.ts — 输入历史（BACKLOG TUI#34）
//
// 覆盖：提交入栈（普通输入与 `/` 命令共用一份）、↑ 上翻 / ↓ 下翻回到草稿、
// 到最早一条停住、相邻重复与空串不入栈、手动编辑退出翻看态、无历史且输入为空
// 时 ↑/↓ 仍走既有对话区滚动（语义不被抢占）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import {
  initialState,
  inputHistoryPush,
  reduceState,
} from "../src/app/state.ts";
import type { AppState, StateAction } from "../src/app/state.ts";
import type { KeyEvent } from "../src/renderer/index.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

function makeApp(): {
  renderer: FakeRenderer;
  adapter: FakeAdapter;
  /** 每次调用取当前 state（reducer 返回新对象，不能缓存快照） */
  st: () => AppState;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new TrackedApp({ renderer, adapter, notify: { enabled: false } });
  app.start();
  return {
    renderer,
    adapter,
    st: () => (app as unknown as { state: AppState }).state,
  };
}

const key = (name: string): KeyEvent => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
});

/** 逐字符输入（不提交） */
function type(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) renderer.press(key(ch));
}

/** 输入并提交 */
function typeAndEnter(renderer: FakeRenderer, text: string): void {
  type(renderer, text);
  renderer.press(key("enter"));
}

/** 纯 reducer 直调（不经 App） */
function reduce(state: AppState, action: StateAction): AppState {
  return reduceState(state, action);
}

test("提交入栈：普通输入与 `/` 命令共用一份历史；空串不入栈", () => {
  const { renderer, adapter, st } = makeApp();
  typeAndEnter(renderer, "第一条");
  // slash 侧代表：空输入按 `/` 进 slash 模式，再输命令名（前缀由 submit 补）
  // —— /help 是本地表命令（不经 adapter），/zzz 走注册表转发（adapter.runCommand）
  renderer.press(key("/"));
  typeAndEnter(renderer, "zzz");
  assert.deepEqual(adapter.sent, ["第一条"]);
  assert.deepEqual(adapter.commands, ["/zzz"]);
  assert.deepEqual(
    st().inputHistory,
    ["第一条", "zzz"],
    "slash 模式记录的是提示符口径文本（不含前导 /）",
  );
  // 空输入提交是 no-op，不产生历史条目
  renderer.press(key("enter"));
  assert.deepEqual(
    st().inputHistory,
    ["第一条", "zzz"],
    "slash 模式记录的是提示符口径文本（不含前导 /）",
  );
});

test("↑ 上翻取上一条、↓ 回到草稿；到最早一条停住", () => {
  const { renderer, st } = makeApp();
  typeAndEnter(renderer, "甲");
  typeAndEnter(renderer, "乙");
  // 输入区空：↑ 取最近一条
  renderer.press(key("up"));
  assert.equal(st().inputText, "乙");
  assert.equal(st().inputHistoryCursor, 1);
  // 再 ↑ 取更早一条
  renderer.press(key("up"));
  assert.equal(st().inputText, "甲");
  assert.equal(st().inputHistoryCursor, 2);
  // 已是最早：再 ↑ 停住（不越界、不清空）
  renderer.press(key("up"));
  assert.equal(st().inputText, "甲");
  assert.equal(st().inputHistoryCursor, 2);
  // ↓ 逐条回来，过最新条目后回到进入翻看前的草稿（此处为空）
  renderer.press(key("down"));
  assert.equal(st().inputText, "乙");
  renderer.press(key("down"));
  assert.equal(st().inputText, "");
  assert.equal(st().inputHistoryCursor, 0);
});

test("翻看中手输草稿不丢：↑ 前保存草稿，↓ 回到它", () => {
  const { renderer, st } = makeApp();
  typeAndEnter(renderer, "已提交");
  type(renderer, "半截草稿");
  // 输入非空：首按 ↑ 仍进入翻看（先把草稿存起来）
  renderer.press(key("up"));
  assert.equal(st().inputText, "已提交");
  assert.equal(st().inputHistoryDraft, "半截草稿");
  // ↓ 回最新条目之下 → 恢复草稿
  renderer.press(key("down"));
  assert.equal(st().inputText, "半截草稿");
  assert.equal(st().inputHistoryCursor, 0);
});

test("翻看态下编辑 → 退出翻看（游标归零，编辑文本成为新草稿）", () => {
  const { renderer, st } = makeApp();
  typeAndEnter(renderer, "旧输入");
  renderer.press(key("up"));
  assert.equal(st().inputText, "旧输入");
  renderer.press(key("backspace"));
  assert.equal(st().inputHistoryCursor, 0, "编辑即退出翻看");
  assert.equal(st().inputText, "旧输");
  assert.equal(st().inputHistoryDraft, "旧输", "编辑后的文本成为新草稿");
});

test("无历史且输入为空：↑/↓ 保持既有对话区滚动语义（不被历史抢占）", () => {
  const { renderer, st } = makeApp();
  renderer.press(key("up"));
  assert.equal(st().inputText, "");
  assert.equal(st().inputHistoryCursor, 0);
  assert.equal(st().inputHistory.length, 0);
});

test("reducer：相邻重复不入栈、超上限丢最旧", () => {
  const text = "同一句";
  const once = inputHistoryPush([], text);
  const twice = inputHistoryPush(once, text);
  assert.deepEqual(twice, [text], "与栈顶相同不入栈");
  let hist: readonly string[] = [];
  for (let i = 0; i < 205; i++) hist = inputHistoryPush(hist, `第${i}条`);
  assert.equal(hist.length, 200, "上限 200");
  assert.equal(hist[0], "第5条", "超出丢最旧");
  assert.equal(hist.at(-1), "第204条");
});

test("reducer：push 复位翻看态、空历史时 prev/next 为 no-op", () => {
  const base = initialState();
  const pushed = reduce(base, { type: "input-history", action: "push" });
  assert.deepEqual(pushed.inputHistory, [], "空输入不入栈");
  assert.equal(pushed.inputHistoryCursor, 0);
  assert.equal(pushed.inputHistoryDraft, "");
  // 空历史（且输入为空）：prev/next 不改状态
  assert.equal(
    reduce(pushed, { type: "input-history", action: "prev" }),
    pushed,
  );
  assert.equal(
    reduce(pushed, { type: "input-history", action: "next" }),
    pushed,
  );
});
