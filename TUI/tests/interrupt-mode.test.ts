// tests/interrupt-mode.test.ts — `!` 输入模式（「打断并发送」）语义
//
// 2026-10-15 起：「打断并发送」从 `Alt+Enter` 快捷键改为**第五种输入模式** `!`——空输入按 `!`
// 进入（提示符切 `!`、`!` 被吞、同符号幂等、空输入 Backspace 回退 `>`、任何提交后回退 `>`）；
// 该模式 Enter = 忙时**打断后直发**（不带 `next-step`、不登记排队块）、空闲时直发；空输入提交
// = 只打断。打断入口收敛到本模式：Esc 不再打断、Alt+Enter 不再有独立语义（覆盖见
// tests/app.test.ts；解码层合并仍由 tests/input.test.ts 覆盖）。

import assert from "node:assert/strict";
import test from "node:test";

import { App } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";
import { registerApp } from "./helpers/paintFlush.ts";
import type { AppState } from "../src/app/state.ts";

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

const key = (
  name: string,
  opts: { ctrl?: boolean; meta?: boolean } = {},
): { name: string; ctrl: boolean; meta: boolean; shift: boolean } => ({
  name,
  ctrl: opts.ctrl ?? false,
  meta: opts.meta ?? false,
  shift: false,
});

/** 帧纯文本（含用户块/输入区/提示区） */
function plainFrame(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n");
}

function typeText(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) renderer.press(key(ch));
}

test("空输入按 `!` 进入 interrupt 模式：提示符 `! `、`!` 被吞、同符号幂等", () => {
  const { renderer, st } = makeApp();
  assert.ok(
    plainFrame(renderer).includes("> Type a message..."),
    "默认提示符应为 `>`: " + JSON.stringify(plainFrame(renderer)),
  );
  renderer.press(key("!"));
  assert.equal(st().inputMode, "interrupt", "空输入按 `!` 切模式");
  assert.equal(st().inputText, "", "`!` 被吞、不进输入框");
  assert.ok(
    plainFrame(renderer).includes("! Type a message..."),
    "提示符应切为 `!`: " + JSON.stringify(plainFrame(renderer)),
  );
  renderer.press(key("!"));
  assert.equal(st().inputMode, "interrupt", "同符号幂等");
  assert.equal(st().inputText, "", "重复按 `!` 仍被吞");
  // 模式键仍是全局口径：interrupt 模式下按 `$` 切到 shell
  renderer.press(key("$"));
  assert.equal(st().inputMode, "shell", "其余模式键照旧可切");
});

test("非空输入里 `!` 仍是普通字符（不切模式）", () => {
  const { renderer, st } = makeApp();
  typeText(renderer, "a");
  renderer.press(key("!"));
  assert.equal(st().inputMode, "steer", "非空输入不切模式");
  assert.equal(st().inputText, "a!", "`!` 按普通字符插入");
});

test("空输入 Backspace 回退 `>`；`!` 模式提交后也回退 `>`", () => {
  const { renderer, adapter, st } = makeApp();
  renderer.press(key("!"));
  renderer.press(key("backspace"));
  assert.equal(st().inputMode, "steer", "空输入 Backspace 回退默认模式");
  assert.ok(
    plainFrame(renderer).includes("> Type a message..."),
    "提示符回 `>`",
  );
  // 提交后回退（`!` 被吞 → 提交内容不含 `!`）
  renderer.press(key("!"));
  typeText(renderer, "打断发");
  renderer.press(key("enter"));
  assert.deepEqual(adapter.sent, ["打断发"], "提交内容不含模式符号");
  assert.equal(st().inputMode, "steer", "提交后回退默认模式");
  assert.equal(st().inputText, "", "输入区已清空");
});

test("空闲 `!` 提交 = 直发：不打断、不带 next-step", () => {
  const { renderer, adapter } = makeApp();
  renderer.press(key("!"));
  typeText(renderer, "hi");
  renderer.press(key("enter"));
  assert.equal(adapter.interrupts, 0, "空闲没有可打断的回合 → 不调 interrupt");
  assert.deepEqual(adapter.log, ["send:hi"], "打断口径直发（不带 next-step）");
  assert.deepEqual(adapter.steered, [], "不走 step 边界投递");
});

test("忙时 `!` 提交 = 打断后直发：不走 step 边界、不登记排队块", () => {
  const { renderer, adapter, st } = makeApp();
  typeText(renderer, "先发");
  renderer.press(key("enter"));
  adapter.push({ type: "agent-status", sessionId: "s1", status: "thinking" });
  renderer.press(key("!"));
  typeText(renderer, "打断发");
  renderer.press(key("enter"));
  assert.equal(adapter.interrupts, 1, "忙时先打断一次");
  assert.deepEqual(
    adapter.log,
    ["steer:先发", "interrupt", "send:打断发"],
    "先打断再直发（顺序不可颠倒）",
  );
  assert.deepEqual(
    adapter.steered,
    ["先发"],
    "打断后直发不按 step 边界投递（只有打断前空闲那条在）",
  );
  assert.deepEqual(st().queued, [], "不登记排队块");
});

test("`!` 模式提交后 Ctrl+P 回溯：模式一并恢复为 `!`（草稿模式仍归默认）", () => {
  const { renderer, st } = makeApp();
  renderer.press(key("!"));
  typeText(renderer, "甲");
  renderer.press(key("enter"));
  assert.equal(st().inputMode, "steer", "提交后回退默认模式");
  renderer.press(key("p", { ctrl: true }));
  assert.equal(st().inputText, "甲", "回溯到已提交条目");
  assert.equal(st().inputMode, "interrupt", "模式随条目恢复");
  assert.ok(
    plainFrame(renderer).includes("! 甲"),
    "提示符随模式恢复为 `!`: " + JSON.stringify(plainFrame(renderer)),
  );
  renderer.press(key("n", { ctrl: true }));
  assert.equal(st().inputText, "", "下翻回到空草稿");
  assert.equal(st().inputMode, "steer", "草稿模式 = 默认 steer");
});
