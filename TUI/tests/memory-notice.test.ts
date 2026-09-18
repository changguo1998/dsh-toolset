// tests/memory-notice.test.ts — A3：/memory 命令（knowledge-base 概要，notice 型）
//
// 覆盖：路由；就绪概要展示（路径/chunk·source 计数）；未就绪 → info 说明；
// 服务缺失降级（warn）；读取失败降级（warn）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { routeSlashCommand } from "../src/app/commands.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

class FakeRenderer implements Renderer {
  renders = 0;
  refreshes = 0;
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  lastRender: string[] = [];
  render(rows: FrameRow[]): void {
    this.lastRender = rows.map((r) => r.segments.map((s) => s.text).join(""));
    this.renders++;
  }
  refresh(_rows: FrameRow[]): void {
    this.refreshes++;
  }
  onKey(cb: (k: KeyEvent) => void): void {
    this.press = cb;
  }
  emitKey(k: KeyEvent): void {
    this.press(k);
  }
  onResize(cb: (cols: number, rows: number) => void): void {
    this.resize = cb;
  }
  getSize(): Size {
    return this.size;
  }
  themeCalls: ThemeId[] = [];
  setTheme(id: ThemeId): void {
    this.themeCalls.push(id);
  }
  close(): void {
    this.closed++;
  }
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;
}

class FakeMemoryAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  memorySummaryResult: string | undefined = [
    "知识库：就绪",
    "路径：/tmp/dsh-kb.sqlite",
    "chunks：42 · sources：7",
  ].join("\n");
  memorySummaryError: Error | undefined;
  memorySummary: (() => Promise<string>) | undefined =
    async (): Promise<string> => {
      if (this.memorySummaryError) throw this.memorySummaryError;
      if (this.memorySummaryResult === undefined) {
        return "知识库尚未就绪（apply 尚未创建库或启动失败）";
      }
      return this.memorySummaryResult;
    };
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
  sendMessage(): void {}
  runCommand(): void {}
  approve(): void {}
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

function frames(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("routeSlashCommand: /memory → memory", () => {
  assert.equal(routeSlashCommand("memory"), "memory");
});

test("/memory：就绪 → info 展示概要（路径/chunk·source 计数）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/memory");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("知识库：就绪"), "就绪行: " + f);
  assert.ok(f.includes("/tmp/dsh-kb.sqlite"), "路径行: " + f);
  assert.ok(f.includes("chunks：42 · sources：7"), "计数行: " + f);
  app.dispose();
});

test("/memory：未就绪 → info 说明（不报服务缺失）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryAdapter();
  adapter.memorySummaryResult = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/memory");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("知识库尚未就绪"), "未就绪说明: " + f);
  assert.ok(!f.includes("服务不可用"), "不应报服务缺失: " + f);
  app.dispose();
});

test("/memory：服务缺失 → warn 且不调", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryAdapter();
  adapter.memorySummary = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/memory");
  await tick();
  assert.ok(
    frames(renderer).includes("knowledge 服务不可用"),
    frames(renderer),
  );
  app.dispose();
});

test("/memory：读取失败（reject）→ warn knowledge 服务不可用", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeMemoryAdapter();
  adapter.memorySummaryError = new Error("boom");
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/memory");
  await tick();
  await tick();
  assert.ok(
    frames(renderer).includes("knowledge 服务不可用"),
    frames(renderer),
  );
  app.dispose();
});
