// tests/command-panel-guard.test.ts — A2：/guard 面板命令（security-guard 只读查询面接线）
//
// 覆盖：路由；列表渲染（工具名/拦截·放行/原因摘要）；空记录占位；服务缺失降级
//（warn 且不空开面板）；Enter 策略快照（policy() 4 行）；翻页基线。

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

class FakeGuardAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  refreshGuard: (() => Promise<void>) | undefined = async (): Promise<void> => {
    // 与 adapter/dsh.ts 相同的归一化：deny → failed/拦截、allow → success/放行
    this.emit({
      type: "command-panel-data",
      kind: "guard",
      rows: [
        {
          title: "bash",
          detail: "拦截 · 命中黑名单 rm -rf",
          status: "failed",
          payload: undefined,
        },
        {
          title: "read",
          detail: "放行",
          status: "success",
          payload: undefined,
        },
      ],
    });
  };
  guardPolicy: (() => Promise<string | undefined>) | undefined =
    async (): Promise<string | undefined> => {
      return [
        "守卫：启用",
        "命令黑名单：2 条规则 · 放行 1 条",
        "敏感文件：3 条规则 · 放行 2 条",
        "拦截记录：最近 1 条",
      ].join("\n");
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

test("routeSlashCommand: /guard → guard", () => {
  assert.equal(routeSlashCommand("guard"), "guard");
});

test("/guard：列表渲染（工具名 + 拦截/放行 + 原因摘要）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGuardAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/guard");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("守卫（2）"), "面板标题与计数: " + f);
  assert.ok(f.includes("bash"), "含工具名: " + f);
  assert.ok(f.includes("拦截"), "deny 行: " + f);
  assert.ok(f.includes("命中黑名单"), "原因摘要: " + f);
  assert.ok(f.includes("放行"), "allow 行: " + f);
  app.dispose();
});

test("/guard：空记录 → 占位（无记录）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGuardAdapter();
  adapter.refreshGuard = async (): Promise<void> => {
    adapter.emit({ type: "command-panel-data", kind: "guard", rows: [] });
  };
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/guard");
  await tick();
  assert.ok(frames(renderer).includes("（无记录）"), frames(renderer));
  app.dispose();
});

test("/guard：服务缺失 → warn 且不空开面板", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGuardAdapter();
  adapter.refreshGuard = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/guard");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("guard 服务不可用"), "warn 提示: " + f);
  assert.ok(!f.includes("守卫（"), "不应开面板: " + f);
  app.dispose();
});

test("/guard：Enter 展示策略快照（policy() 4 行）→ 关面板 + notice", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGuardAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/guard");
  await tick();
  press(renderer, "enter");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(!f.includes("守卫（"), "策略后面板关闭: " + f);
  assert.ok(f.includes("守卫：启用"), "策略启用: " + f);
  assert.ok(f.includes("命令黑名单：2 条规则"), "黑名单: " + f);
  assert.ok(f.includes("敏感文件：3 条规则"), "敏感文件: " + f);
  app.dispose();
});

test("/guard：数十条时 PgDn/PgUp 整页翻页", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeGuardAdapter();
  adapter.refreshGuard = async (): Promise<void> => {
    adapter.emit({
      type: "command-panel-data",
      kind: "guard",
      rows: Array.from({ length: 40 }, (_, i) => ({
        title: `tool-${String(i).padStart(2, "0")}`,
        detail: i % 2 === 0 ? "拦截" : "放行",
        status: i % 2 === 0 ? ("failed" as string) : ("success" as string),
        payload: undefined,
      })),
    });
  };
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/guard");
  await tick();
  assert.ok(
    frames(renderer).includes("tool-00"),
    "首屏含第一项: " + frames(renderer),
  );
  assert.ok(
    !frames(renderer).includes("tool-08"),
    "首屏不含翻页后首项: " + frames(renderer),
  );
  press(renderer, "pagedown");
  await tick();
  assert.ok(
    frames(renderer).includes("tool-08"),
    "PgDn 一页: " + frames(renderer),
  );
  assert.ok(
    !frames(renderer).includes("tool-00"),
    "翻页后首项滚出: " + frames(renderer),
  );
  press(renderer, "pageup");
  await tick();
  assert.ok(
    frames(renderer).includes("tool-00"),
    "PgUp 回退: " + frames(renderer),
  );
  app.dispose();
});
