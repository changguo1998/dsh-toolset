// tests/command-panel-loop.test.ts — A4：/loop 面板命令（metric-loop list() 接线）
//
// 覆盖：路由；列表渲染（measureCmd/状态·方向·轮数·best·更新时间）；空占位；
// 服务缺失降级（warn 不空开面板）；Enter 详情（loopDetail 4 行）；翻页基线。

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

class FakeLoopAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  refreshLoops: (() => Promise<void>) | undefined = async (): Promise<void> => {
    // 与 adapter/dsh.ts 相同的归一化：running → running、stopped → inactive
    this.emit({
      type: "command-panel-data",
      kind: "loop",
      rows: [
        {
          title: "npm test",
          detail: "运行中 · 最大化 · 轮 3/10 · best 88 · 更新 11:20",
          status: "running",
          payload: "loop-1",
        },
        {
          title: "归一化率",
          detail: "已停止 · 轮 10/10 · 更新 11:00",
          status: "inactive",
          payload: "loop-2",
        },
      ],
    });
  };
  loopDetail: ((id: string) => Promise<string | undefined>) | undefined =
    async (id: string): Promise<string | undefined> => {
      if (id === "loop-1") {
        return [
          "循环：loop-1",
          "状态：运行中",
          "方向：最大化 · 目标：npm test",
          "轮 3/10 · 窗口 5 · best 88",
        ].join("\n");
      }
      return undefined;
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

function press(renderer: FakeRenderer, name: string): void {
  renderer.press({ name, ctrl: false, meta: false, shift: false });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function frames(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("routeSlashCommand: /loop → loop", () => {
  assert.equal(routeSlashCommand("loop"), "loop");
});

test("/loop：列表渲染（measureCmd/状态·方向·轮数/best/更新时间）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeLoopAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/loop");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("循环（2）"), "面板标题与计数: " + f);
  assert.ok(f.includes("npm test"), "measureCmd 行: " + f);
  assert.ok(f.includes("运行中"), "running 状态: " + f);
  assert.ok(f.includes("轮 3/10"), "轮数: " + f);
  assert.ok(f.includes("best 88"), "最优: " + f);
  assert.ok(f.includes("更新"), "更新时间标识: " + f);
  app.dispose();
});

test("/loop：空循环 → 占位（无循环）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeLoopAdapter();
  adapter.refreshLoops = async (): Promise<void> => {
    adapter.emit({ type: "command-panel-data", kind: "loop", rows: [] });
  };
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/loop");
  await tick();
  assert.ok(frames(renderer).includes("（无循环）"), frames(renderer));
  app.dispose();
});

test("/loop：服务缺失 → warn 且不空开面板", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeLoopAdapter();
  adapter.refreshLoops = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/loop");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("metricLoop 服务不可用"), "warn 提示: " + f);
  assert.ok(!f.includes("循环（"), "不应开面板: " + f);
  app.dispose();
});

test("/loop：Enter 读取详情（loopDetail 4 行）→ 关面板 + notice", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeLoopAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/loop");
  await tick();
  press(renderer, "enter");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(!f.includes("循环（"), "详情后面板关闭: " + f);
  assert.ok(f.includes("循环：loop-1"), "详情含 id: " + f);
  assert.ok(f.includes("方向：最大化"), "详情含方向: " + f);
  assert.ok(f.includes("best 88"), "详情含 best: " + f);
  app.dispose();
});

test("/loop：数十项时 PgDn/PgUp 整页翻页", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeLoopAdapter();
  adapter.refreshLoops = async (): Promise<void> => {
    adapter.emit({
      type: "command-panel-data",
      kind: "loop",
      rows: Array.from({ length: 40 }, (_, i) => ({
        title: `loop-${String(i).padStart(2, "0")}`,
        detail: "已停止 · 轮 1/1",
        status: "inactive" as string,
        payload: `id-${i}`,
      })),
    });
  };
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/loop");
  await tick();
  assert.ok(
    frames(renderer).includes("loop-00"),
    "首屏含第一项: " + frames(renderer),
  );
  assert.ok(
    !frames(renderer).includes("loop-08"),
    "首屏不含翻页后首项: " + frames(renderer),
  );
  press(renderer, "pagedown");
  await tick();
  assert.ok(
    frames(renderer).includes("loop-08"),
    "PgDn 一页: " + frames(renderer),
  );
  assert.ok(
    !frames(renderer).includes("loop-00"),
    "翻页后首项滚出: " + frames(renderer),
  );
  press(renderer, "pageup");
  await tick();
  assert.ok(
    frames(renderer).includes("loop-00"),
    "PgUp 回退: " + frames(renderer),
  );
  app.dispose();
});
