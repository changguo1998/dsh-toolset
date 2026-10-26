// tests/input-cursor-keys.test.ts — 输入区光标键 vs 面板翻页键的分派
//
// 2026-10-27 用户裁定：只有会话区 / 回合区处于焦点时，↑/↓、PgUp/PgDn、Home/End 才当成翻页；
// 否则在用户输入区移动光标——↑/↓ 一次一行（落同显示列）、←/→ 一次一格、
// Home/End = 整串开头 / 结尾、PgUp/PgDn = 光标所在行的行首 / 行尾。

import { test } from "node:test";
import assert from "node:assert/strict";

import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import type { AppState } from "../src/app/state.ts";
import type { KeyEvent } from "../src/renderer/index.ts";

/** 单字符键事件 */
const ch = (text: string): KeyEvent => ({
  name: text,
  ctrl: false,
  meta: false,
  shift: false,
});

const key = (name: string, mods: { ctrl?: boolean } = {}): KeyEvent => ({
  name,
  ctrl: mods.ctrl === true,
  meta: false,
  shift: false,
});

function makeApp(): { renderer: FakeRenderer; st: () => AppState; app: App } {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter, notify: { enabled: false } });
  registerApp(app);
  app.start();
  return {
    renderer,
    app,
    st: () => (app as unknown as { state: AppState }).state,
  };
}

/** 直接灌入多行输入（粘贴形态）并把光标置到末尾 */
function typeMultiline(renderer: FakeRenderer, text: string): void {
  renderer.press({
    name: "paste",
    text,
    ctrl: false,
    meta: false,
    shift: false,
  });
}

test("无面板焦点：↑/↓ 在输入区上下移一行，落在同一显示列", () => {
  const { renderer, st, app } = makeApp();
  typeMultiline(renderer, "abc\ndefgh\nij");
  const len = st().inputText.length;
  assert.equal(st().inputCursor, len, "粘贴后光标在末尾（第 3 行行尾）");
  renderer.press(key("up"));
  // 第 3 行行首列 = 2 → 落到第二行「defgh」的第 2 列（索引 6）
  assert.equal(st().inputCursor, 6, "上一行同显示列（索引 6）");
  renderer.press(key("up"));
  assert.equal(st().inputCursor, 2, "再上一行同列（第一行第 2 列）");
  renderer.press(key("down"));
  assert.equal(st().inputCursor, 6, "↓ 回到第二行同列");
  renderer.press(key("down"));
  assert.equal(st().inputCursor, len, "↓ 回到末尾行");
  renderer.press(key("down"));
  assert.equal(st().inputCursor, len, "末行再 ↓ 不动");
  app.dispose();
});

test("无面板焦点：←/→ 一次一格；Home/End 跳整串首尾；PgUp/PgDn 跳行首/行尾", () => {
  const { renderer, st, app } = makeApp();
  typeMultiline(renderer, "abc\ndefgh\nij");
  const len = st().inputText.length;
  renderer.press(key("left"));
  assert.equal(st().inputCursor, len - 1, "← 退一格");
  renderer.press(key("right"));
  assert.equal(st().inputCursor, len, "→ 进一格");
  renderer.press(key("home"));
  assert.equal(st().inputCursor, 0, "Home = 整串开头");
  renderer.press(key("end"));
  assert.equal(st().inputCursor, len, "End = 整串结尾");
  renderer.press(key("pageup"));
  assert.equal(st().inputCursor, 10, "PgUp = 光标所在行（第 3 行）行首");
  renderer.press(key("pagedown"));
  assert.equal(st().inputCursor, len, "PgDn = 该行行尾");
  renderer.press(key("up"));
  renderer.press(key("pageup"));
  assert.equal(st().inputCursor, 4, "PgUp 在第二行 → 该行行首");
  app.dispose();
});

test("会话区聚焦时：↑/PgUp/Home 走翻页、不动输入光标", () => {
  const { renderer, st, app } = makeApp();
  typeMultiline(renderer, "abc\ndefgh\nij");
  const cursor = st().inputCursor;
  renderer.press(key("escape")); // 有输入时 Esc 不清空，仅确保无焦点
  renderer.press(key("e", { ctrl: true })); // Ctrl+E → 会话区焦点
  for (const name of ["up", "pageup", "home"] as const)
    renderer.press(key(name));
  assert.equal(st().inputCursor, cursor, "翻页键不动输入光标");
  app.dispose();
});

test("光标在整个输入开头时可按模式键切换模式（有内容也不吞内容）", () => {
  const { renderer, st, app } = makeApp();
  typeMultiline(renderer, "abc");
  // 光标在末尾：模式键当普通字符插入
  renderer.press(ch("$"));
  assert.equal(st().inputText, "abc$", "末尾按 $ = 插入字符");
  assert.equal(st().inputMode, "steer", "模式未变");
  // 光标移到最前：模式键切模式并吞键
  renderer.press(key("home"));
  renderer.press(ch("$"));
  assert.equal(st().inputMode, "shell", "开头按 $ = 切到 shell 模式");
  assert.equal(st().inputText, "abc$", "内容保留、模式键不插入");
  // 开头 Backspace 回退默认模式（内容保留）
  renderer.press(key("backspace"));
  assert.equal(st().inputMode, "steer", "开头 Backspace 回退默认模式");
  assert.equal(st().inputText, "abc$", "回退模式不动内容");
  app.dispose();
});
