// tests/command-panel-task.test.ts — A1：/task 面板命令（TaskEngine 只读查询面接线）
//
// 覆盖：路由；列表渲染（标题/状态/待拆分标记/嵌套缩进）；空任务占位（无任务）；
// 服务缺失降级（warn 且不空开面板）；Enter 详情（taskDetail）；翻页键位基线。

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

class FakeTaskAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  refreshTasks: (() => Promise<void>) | undefined = async (): Promise<void> => {
    // 与 adapter/dsh.ts 相同的归一化：先序展平 + 嵌套缩进 + status/detail
    this.emit({
      type: "command-panel-data",
      kind: "task",
      rows: [
        {
          title: "根任务",
          detail: "active",
          status: "active",
          payload: "root-1",
        },
        {
          title: "  子任务甲",
          detail: "todo · 待拆分",
          status: "todo",
          payload: "leaf-1",
        },
      ],
    });
  };
  taskDetail: ((id: string) => Promise<string | undefined>) | undefined =
    async (id: string): Promise<string | undefined> => {
      if (id === "root-1") {
        return [
          "任务：根任务",
          "状态：active",
          "id：root-1",
          "需拆分：否",
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

test("routeSlashCommand: /task → task", () => {
  assert.equal(routeSlashCommand("task"), "task");
});

test("/task：列表渲染（标题/状态/嵌套缩进/待拆分标记）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeTaskAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/task");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("任务（2）"), "面板标题与计数: " + f);
  assert.ok(f.includes("根任务"), "顶层任务: " + f);
  assert.ok(f.includes("active"), "状态: " + f);
  assert.ok(f.includes("子任务甲"), "子任务: " + f);
  assert.ok(f.includes("待拆分"), "需拆分标记: " + f);
  assert.ok(
    /  \s*子任务甲/.test(f.replace(/\s/g, " ")) || f.includes("  子任务甲"),
    "嵌套缩进: " + f,
  );
  app.dispose();
});

test("/task：空任务 → 占位（无任务）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeTaskAdapter();
  adapter.refreshTasks = async (): Promise<void> => {
    adapter.emit({ type: "command-panel-data", kind: "task", rows: [] });
  };
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/task");
  await tick();
  assert.ok(frames(renderer).includes("（无任务）"), frames(renderer));
  app.dispose();
});

test("/task：服务缺失 → warn 且不空开面板", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeTaskAdapter();
  adapter.refreshTasks = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/task");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("taskEngine 服务不可用"), "warn 提示: " + f);
  assert.ok(!f.includes("任务（"), "不应开面板: " + f);
  app.dispose();
});

test("/task：Enter 读取详情（taskDetail）→ 关面板 + notice", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeTaskAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/task");
  await tick();
  press(renderer, "enter");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(!f.includes("任务（"), "详情后面板关闭: " + f);
  assert.ok(f.includes("根任务"), "详情含标题: " + f);
  assert.ok(f.includes("id：root-1"), "详情含 id: " + f);
  app.dispose();
});

test("/task：数十项时 PgDn/PgUp 整页翻页", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeTaskAdapter();
  adapter.refreshTasks = async (): Promise<void> => {
    adapter.emit({
      type: "command-panel-data",
      kind: "task",
      rows: Array.from({ length: 40 }, (_, i) => ({
        title: `t-${String(i).padStart(2, "0")}`,
        detail: "todo",
        status: "todo" as string,
        payload: `id-${i}`,
      })),
    });
  };
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/task");
  await tick();
  assert.ok(
    frames(renderer).includes("t-00"),
    "首屏含第一项: " + frames(renderer),
  );
  assert.ok(
    !frames(renderer).includes("t-08"),
    "首屏不含翻页后首项: " + frames(renderer),
  );
  press(renderer, "pagedown");
  await tick();
  assert.ok(
    frames(renderer).includes("t-08"),
    "PgDn 一页: " + frames(renderer),
  );
  assert.ok(
    !frames(renderer).includes("t-00"),
    "翻页后首项滚出: " + frames(renderer),
  );
  press(renderer, "pageup");
  await tick();
  assert.ok(
    frames(renderer).includes("t-00"),
    "PgUp 回退: " + frames(renderer),
  );
  app.dispose();
});
