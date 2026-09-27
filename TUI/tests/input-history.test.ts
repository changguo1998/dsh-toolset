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
import type {
  AppState,
  InputHistoryEntry,
  StateAction,
} from "../src/app/state.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import type { ShellRunner } from "../src/app/local-shell.ts";

/** 假 shell 执行器（TUI#37）：本文件不验证 `$` 执行本身，仅需不回真进程 */
const noopShell: ShellRunner = async () => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
});

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
  const app = new TrackedApp({
    renderer,
    adapter,
    notify: { enabled: false },
    runShell: noopShell,
  });
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

test("提交入栈：普通输入与 `/` 命令共用一份历史（含各自模式）；空串不入栈", () => {
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
    [
      { text: "第一条", mode: "normal" },
      { text: "zzz", mode: "slash" },
    ],
    "条目 = 提示符口径文本 + 提交时的模式",
  );
  // 空输入提交是 no-op，不产生历史条目
  renderer.press(key("enter"));
  assert.equal(st().inputHistory.length, 2, "空串不入栈");
});

test("历史回溯恢复**输入模式**（真机缺陷修复）：slash 命令不再退化成普通输入", () => {
  const { renderer, adapter, st } = makeApp();
  // 用 slash 模式提交 /zzz（注册表转发；不开面板——面板打开时 ↑ 归面板列表，
  // 这正是真机上 /agents 之外仍需先关面板才回溯的原因，与本条断言无关）
  renderer.press(key("/"));
  typeAndEnter(renderer, "zzz");
  assert.deepEqual(adapter.commands, ["/zzz"]);
  assert.equal(st().inputMode, "normal", "提交后回退 normal");
  // ↑ 回溯：文本与模式**同时**恢复 → 提示符回到 `/`，再次提交仍是 slash 命令
  renderer.press(key("up"));
  assert.equal(st().inputText, "zzz");
  assert.equal(st().inputMode, "slash", "模式随条目恢复（不再变成普通输入）");
  renderer.press(key("enter"));
  assert.deepEqual(
    adapter.commands,
    ["/zzz", "/zzz"],
    "回溯后再提交仍走 slash 路由",
  );
  assert.deepEqual(adapter.sent, [], "没有被当成普通消息发给模型");

  // `$` shell 与 `<` steer 同理：模式随条目恢复
  renderer.press(key("$"));
  typeAndEnter(renderer, "ls -la");
  renderer.press(key("<"));
  typeAndEnter(renderer, "快点");
  renderer.press(key("up"));
  assert.equal(st().inputMode, "steer", "最近一条是 steer 条目");
  assert.equal(st().inputText, "快点");
  renderer.press(key("up"));
  assert.equal(st().inputMode, "shell", "再上一条是 shell 条目");
  assert.equal(st().inputText, "ls -la");
  renderer.press(key("down"));
  assert.equal(st().inputMode, "steer");
  renderer.press(key("down"));
  assert.equal(
    st().inputMode,
    "normal",
    "回到最新之下 → 恢复草稿模式（normal）",
  );
  assert.equal(st().inputText, "");
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

test("reducer：相邻重复（文本 + 模式）不入栈、模式不同算不同条目、超上限丢最旧", () => {
  const entry: InputHistoryEntry = { text: "同一句", mode: "normal" };
  const once = inputHistoryPush([], entry);
  assert.deepEqual(
    inputHistoryPush(once, entry),
    [entry],
    "与栈顶完全相同（文本 + 模式）不入栈",
  );
  assert.deepEqual(
    inputHistoryPush(once, { text: "同一句", mode: "slash" }),
    [entry, { text: "同一句", mode: "slash" }],
    "模式不同 → 视为不同条目（回溯要还原成 slash 语义）",
  );
  let hist: readonly InputHistoryEntry[] = [];
  for (let i = 0; i < 205; i++)
    hist = inputHistoryPush(hist, { text: `第${i}条`, mode: "normal" });
  assert.equal(hist.length, 200, "上限 200");
  assert.equal(hist[0]?.text, "第5条", "超出丢最旧");
  assert.equal(hist.at(-1)?.text, "第204条");
  assert.equal(hist.at(-1)?.mode, "normal", "模式随条目保存");
});

test("reducer：push 复位翻看态、空历史时 prev/next 为 no-op", () => {
  const base = initialState();
  const pushed = reduce(base, { type: "input-history", action: "push" });
  assert.deepEqual(pushed.inputHistory, [], "空输入不入栈");
  assert.equal(pushed.inputHistoryCursor, 0);
  assert.equal(pushed.inputHistoryDraft, "");
  assert.equal(pushed.inputHistoryDraftMode, "normal");
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
