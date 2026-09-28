// tests/exit-confirm.test.ts — 退出前问题面板确认（BACKLOG「tmux 断连后 dsh 退出」）
//
// 语义：Ctrl+D（idle 且输入区为空）与 750ms 双击 Ctrl+C 不再直接退出，改为弹出合成问答
// 面板确认——默认高亮「取消/留在 TUI」，Esc 取消，Enter 确认高亮项；仅确认「退出 dsh」
// 才走 App.dispose。/quit 保持直接退出。合成面板不调用 adapter（无宿主 ask）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import type { KeyEvent } from "../src/renderer/index.ts";
import type { ShellRunner } from "../src/app/local-shell.ts";
import { flushApp, registerApp } from "./helpers/paintFlush.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";

class TrackedApp extends App {
  constructor(deps: ConstructorParameters<typeof App>[0]) {
    super(deps);
    registerApp(this);
  }
}

/** 假 shell 执行器（单测不真起子进程） */
const noopShell: ShellRunner = async () => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
});

function makeApp(): {
  app: App;
  renderer: FakeRenderer;
  adapter: FakeAdapter;
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
  return { app, renderer, adapter };
}

const key = (name: string, ctrl = false): KeyEvent => ({
  name,
  ctrl,
  meta: false,
  shift: false,
});

/** 帧纯文本（去 ANSI）：面板文案断言用 */
const frameText = (renderer: FakeRenderer): string => {
  flushApp();
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
};

const ctrlD = (renderer: FakeRenderer): void => renderer.press(key("d", true));

test("Ctrl+D → 弹出退出确认面板（不退出）；Esc 取消后留在 TUI", () => {
  const { app, renderer, adapter } = makeApp();
  ctrlD(renderer);
  const text = frameText(renderer);
  assert.ok(text.includes("确认退出 dsh？"), "面板题干可见");
  assert.ok(
    text.includes(">  1. 取消"),
    "默认高亮「取消」（留在 TUI），不是「退出」",
  );
  assert.ok(text.includes("2. 退出 dsh"), "「退出 dsh」作为第二选项可见");
  assert.equal(renderer.closed, 0, "弹面板不退出");
  // Esc = 取消（questionKeyDecision 既有语义）
  renderer.press(key("escape"));
  assert.equal(renderer.closed, 0, "Esc 取消后仍在 TUI");
  assert.equal(adapter.cancelledQuestions.length, 0, "合成面板不调 adapter");
  assert.ok(!frameText(renderer).includes("确认退出 dsh？"), "取消后面板关闭");
  // 取消后可再次请求（守卫与状态复位）
  ctrlD(renderer);
  assert.ok(
    frameText(renderer).includes("确认退出 dsh？"),
    "取消后 Ctrl+D 可再次弹面板",
  );
});

test("确认面板：Enter（默认「取消」）关面板不退出；数字 2 + Enter 才退出", () => {
  const { app, renderer, adapter } = makeApp();
  ctrlD(renderer);
  renderer.press(key("enter"));
  assert.equal(renderer.closed, 0, "默认项 Enter = 留在 TUI");
  assert.equal(adapter.disposed, 0, "未释放 adapter");
  assert.ok(!frameText(renderer).includes("确认退出 dsh？"), "面板已关闭");
  // 明确选「退出 dsh」（数字 2 直接标记第 2 项）→ Enter 确认 → dispose
  ctrlD(renderer);
  renderer.press(key("2"));
  renderer.press(key("enter"));
  assert.equal(renderer.closed, 1, "确认「退出 dsh」后关闭 renderer");
  assert.equal(adapter.disposed, 1, "确认退出释放 adapter");
  assert.equal(
    adapter.answeredQuestions.length,
    0,
    "合成面板绝不调用 answerQuestion",
  );
  assert.equal(
    adapter.cancelledQuestions.length,
    0,
    "合成面板不调 cancelQuestion",
  );
});

test("750ms 双击 Ctrl+C → 同样先弹确认面板；单击 Ctrl+C 仅清空输入", () => {
  const { renderer } = makeApp();
  // 输入非空：首次 Ctrl+C 清空且不弹面板
  for (const ch of Array.from("待清空")) renderer.press(key(ch));
  renderer.press(key("c", true));
  assert.ok(
    !frameText(renderer).includes("确认退出 dsh？"),
    "单击 Ctrl+C 不弹面板",
  );
  assert.equal(renderer.closed, 0);
  // 750ms 窗口内第二次 Ctrl+C → 请求确认（不直接退出）
  renderer.press(key("c", true));
  assert.ok(
    frameText(renderer).includes("确认退出 dsh？"),
    "双击 Ctrl+C 弹面板",
  );
  assert.equal(renderer.closed, 0, "弹面板不退出");
  // 面板已开时 Ctrl+D 幂等（不叠面板、不退出）
  ctrlD(renderer);
  assert.equal(renderer.closed, 0, "面板期间 Ctrl+D 不退出");
});

test("/quit 保持直接退出（不弹确认面板）", () => {
  const { renderer } = makeApp();
  for (const ch of Array.from("/quit")) renderer.press(key(ch));
  renderer.press(key("enter"));
  assert.equal(renderer.closed, 1, "/quit 直接退出");
  assert.ok(
    !frameText(renderer).includes("确认退出 dsh？"),
    "显式命令不弹面板",
  );
});
