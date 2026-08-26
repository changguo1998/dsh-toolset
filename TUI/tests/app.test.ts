// tests/app.test.ts — App 层 slash 命令路由单测
//
// 覆盖：submit() 对 / 前缀行走 slash 路由；本地表 /help /clearscreen /cls /quit；
// 未知命令 fail-close(不经 sendMessage)；notice 事件进入缓冲。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import type { DshAdapter, DshEvent } from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { RenderLine, Size } from "../src/renderer/screen.ts";

/** 记录行为的 fake renderer */
class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  renders = 0;
  refreshes = 0;
  closed = 0;
  size: Size = { cols: 80, rows: 24 };

  render(_lines: RenderLine[]): void {
    this.renders++;
  }
  refresh(_lines: RenderLine[]): void {
    this.refreshes++;
  }
  onKey(cb: (k: KeyEvent) => void): void {
    this.keys.length = 0;
    // 简单起见保留最后注册的 cb
    this.keys.push({ name: "__cb__", ctrl: false } as KeyEvent);
    this.press = cb;
  }
  onResize(cb: (cols: number, rows: number) => void): void {
    this.resize = cb;
  }
  getSize(): Size {
    return this.size;
  }
  close(): void {
    this.closed++;
  }
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;
}

/** 记录行为的 fake adapter */
class FakeAdapter implements DshAdapter {
  sent: string[] = [];
  commands: string[] = [];
  events: DshEvent[] = [];
  disposed = 0;
  private cbs: ((e: DshEvent) => void)[] = [];

  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }
  sendMessage(text: string): void {
    this.sent.push(text);
  }
  runCommand(line: string): void {
    this.commands.push(line);
  }
  dispose(): void {
    this.disposed++;
  }
  approve(_id: string, _allow: boolean): void {}
  interrupts = 0;
  interrupt(): void {
    this.interrupts++;
  }

  /** 测试辅助：注入事件 */
  push(e: DshEvent): void {
    for (const cb of this.cbs) cb(e);
  }
}

function makeApp(): { app: App; renderer: FakeRenderer; adapter: FakeAdapter } {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  return { app, renderer, adapter };
}

/** 模拟在输入框输入文本并回车 */
function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
}

test("普通输入(不以 / 开头) → sendMessage", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "你好 DSH");
  assert.deepEqual(adapter.sent, ["你好 DSH"]);
  assert.deepEqual(adapter.commands, []);
});

test("/help → 本地表(不经 sendMessage/runCommand)", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/help");
  assert.deepEqual(adapter.sent, []);
  assert.deepEqual(adapter.commands, []);
});

test("/clearscreen → 本地表(不经 sendMessage/runCommand)", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/clearscreen");
  assert.deepEqual(adapter.sent, []);
  assert.deepEqual(adapter.commands, []);
});

test("/cls 别名 → 与 /clearscreen 同一功能", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/cls");
  assert.deepEqual(adapter.sent, []);
  assert.deepEqual(adapter.commands, []);
});

test("/quit → 关闭 renderer", () => {
  const { app, renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/quit");
  assert.equal(renderer.closed, 1);
  assert.deepEqual(adapter.sent, []);
  assert.deepEqual(adapter.commands, []);
  app.dispose();
});

test("Esc 触发打断(interrupt)，不触发退出(close 不被调用)", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  assert.equal(adapter.interrupts, 1);
  assert.equal(renderer.closed, 0);
  assert.deepEqual(adapter.sent, []);
});

test("Ctrl+L 触发强制重绘(refresh)，不吞普通 'l' 输入", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "l", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.refreshes, 1);
  assert.equal(renderer.closed, 0);
  assert.deepEqual(adapter.sent, []);
});

test("普通 'l' 仍插入输入框(不被 Ctrl+L 分支吞掉)", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "l", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, ["l"]);
  assert.equal(renderer.refreshes, 0);
});

test("Tab 占位提示进 UI 缓冲(不影响 sendMessage)", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, []);
  assert.equal(renderer.renders > 1, true);
});

test("Ctrl+C 不再触发退出(close 不被调用)", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "c", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 0);
  assert.deepEqual(adapter.sent, []);
});

test("未知 /xxx → adapter.runCommand(fail-close 不经 sendMessage)", () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/plan 明天");
  assert.deepEqual(adapter.commands, ["/plan 明天"]);
  assert.deepEqual(adapter.sent, []);
});

test("notice 事件 → 进入 UI 缓冲(渲染发生)", () => {
  const { app, renderer, adapter } = makeApp();
  const before = renderer.renders;
  adapter.push({ type: "notice", text: "[c1] 已压缩会话。" });
  assert.ok(renderer.renders > before, "notice 应触发重绘");
  app.dispose();
});

test("dispose 调用 adapter.dispose", () => {
  const { app, adapter } = makeApp();
  app.dispose();
  assert.equal(adapter.disposed, 1);
});

test("Ctrl+D 且 idle+输入区空 → 退出(close 被调用)", () => {
  const { renderer, adapter } = makeApp();
  renderer.press({ name: "d", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 1);
  assert.deepEqual(adapter.sent, []);
});

test("Ctrl+D 但输入区非空 → 不退出", () => {
  const { renderer } = makeApp();
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "d", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 0);
});

test("Ctrl+D 但状态非 idle → 不退出", () => {
  const { renderer, adapter } = makeApp();
  adapter.push({ type: "agent-status", sessionId: "s1", status: "thinking" });
  renderer.press({ name: "d", ctrl: true, meta: false, shift: false });
  assert.equal(renderer.closed, 0);
});
