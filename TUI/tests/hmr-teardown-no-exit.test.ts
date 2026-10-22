// tests/hmr-teardown-no-exit.test.ts — 宿主卸载 TUI 行不得结束进程
//
// 背景（BACKLOG「非 TUI 行的 HMR 重载不连带退出会话」）：dsh-hmr 的 reconcileProfile 在
// 模块比对后会 stopPlanned 停掉 TUI 条目（改任一非 TUI 行都可能触发整轮 recompose），
// 停机走插件 effect 清理 → disposeApp() → renderer.close() → process.exit()，会话随之丢失。
// 修法：卸载路径显式 exit:false（只恢复终端），用户退出路径行为不变。
//
// 覆盖：renderer.close 的 exit 分流（含缺省仍按 exitOnClose）；App.dispose 两条来源的
// close 参数；main() disposer 的提示与静默；/quit 仍按用户退出语义。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { main } from "../src/main.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";
import { createRenderer } from "../src/renderer/index.ts";

type CloseOptions = { exit?: boolean } | undefined;

class FakeRenderer implements Renderer {
  closed = 0;
  closeArgs: CloseOptions[] = [];
  size: Size = { cols: 80, rows: 24 };
  render(): void {}
  refresh(): void {}
  onKey(cb: (k: KeyEvent) => void): void {
    this.press = cb;
  }
  emitKey(k: KeyEvent): void {
    this.press(k);
  }
  onResize(): void {}
  getSize(): Size {
    return this.size;
  }
  setTheme(_id: ThemeId): void {}
  close(options?: CloseOptions): void {
    this.closed++;
    this.closeArgs.push(options);
  }
  press!: (k: KeyEvent) => void;
}

class FakeAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  disposed = 0;
  emit(e: DshEvent): void {
    for (const cb of this.cbs) cb(e);
  }
  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }
  dispose(): void {
    this.disposed++;
  }
  sendMessage(): void {}
  runCommand(): void {}
  approve(): void {}
  cancelApproval(): void {}
  answerQuestion(): void {}
  cancelQuestion(): void {}
  interrupt(): void {}
  modelCatalog() {
    return Promise.resolve({
      providers: [],
      models: [],
      current: { provider: "p", model: "m" },
    });
  }
  setSessionModel(sel: ModelSelection): Promise<ModelSelection> {
    return Promise.resolve(sel);
  }
  modelEfforts() {
    return Promise.resolve([{ id: "low", name: "low" }]);
  }
}

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

test("renderer.close：缺省按 exitOnClose 退出；close({exit:false}) 只恢复终端", () => {
  const exits: number[] = [];
  const original = process.exit;
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
  try {
    const first = createRenderer({ write: () => {}, rawMode: false });
    first.close();
    assert.deepEqual(
      exits,
      [0],
      "缺省 close() 仍结束进程（退出码尊重 exitCode）",
    );

    const second = createRenderer({ write: () => {}, rawMode: false });
    second.close({ exit: false });
    assert.deepEqual(exits, [0], "exit:false 不调 process.exit");
  } finally {
    process.exit = original;
  }
});

test("App.dispose()（用户退出）→ renderer.close 按缺省（不传选项）", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  app.dispose();
  assert.equal(adapter.disposed, 1);
  assert.equal(renderer.closed, 1);
  assert.deepEqual(
    renderer.closeArgs,
    [undefined],
    "用户退出不改变 close 语义",
  );
});

test("App.dispose({exit:false})（宿主卸载）→ renderer.close 收到 exit:false", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  app.dispose({ exit: false });
  assert.equal(adapter.disposed, 1, "卸载仍释放 adapter");
  assert.equal(renderer.closed, 1, "卸载仍恢复终端");
  assert.deepEqual(renderer.closeArgs, [{ exit: false }]);
});

test("/quit 仍按用户退出语义（close 不传 exit 选项）", () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter, pipelineSink: {} });
  app.start();
  typeAndEnter(renderer, "/quit");
  assert.equal(renderer.closed, 1);
  assert.deepEqual(renderer.closeArgs, [undefined]);
});

test("main() disposer：exit:false 不退出、写一行卸载提示", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const lines: string[] = [];
  const dispose = main({
    adapter,
    renderer,
    logger: (m) => lines.push(m),
    statusQueries: { time: () => "", cwd: () => "", git: () => "" },
  });
  dispose({ exit: false });
  await flush();
  assert.deepEqual(renderer.closeArgs, [{ exit: false }], "透传 exit:false");
  assert.equal(adapter.disposed, 1);
  assert.equal(lines.length, 1, "只有一行提示");
  assert.ok(lines[0]?.includes("宿主卸载了 TUI 行"), lines[0]);
  assert.ok(lines[0]?.includes("会话与进程保留"), lines[0]);
});

test("main() disposer：exit:false + notify:false 不写提示（exit 兜底路径）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const lines: string[] = [];
  const dispose = main({
    adapter,
    renderer,
    logger: (m) => lines.push(m),
    statusQueries: { time: () => "", cwd: () => "", git: () => "" },
  });
  dispose({ exit: false, notify: false });
  await flush();
  assert.deepEqual(renderer.closeArgs, [{ exit: false }]);
  assert.deepEqual(lines, []);
});

test("main() disposer：不带参 = 用户退出语义（不写提示）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const lines: string[] = [];
  const dispose = main({
    adapter,
    renderer,
    logger: (m) => lines.push(m),
    statusQueries: { time: () => "", cwd: () => "", git: () => "" },
  });
  dispose();
  await flush();
  assert.equal(renderer.closed, 1);
  assert.equal(adapter.disposed, 1);
  assert.deepEqual(lines, []);
  await tick();
});
