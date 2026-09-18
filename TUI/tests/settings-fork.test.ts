// tests/settings-fork.test.ts — 批次 4：/settings 与 /fork（收尾 notice 型命令）
//
// 覆盖：路由（settings/fork）；/settings 只读展示（多行 `ns：value`、空态占位）；
// 服务缺失降级（warn 且不空开任何面板）；/fork 成功（success + 新会话 id +
// 与当前会话不同时提示用 /session 查看）；错误路径（reject → warn「分叉失败：原因」）；
// /fork 服务缺失降级。

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
  keys: KeyEvent[] = [];
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

class FakeSettingsForkAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  readSettingsResult: string | undefined = "theme：dark\nfork.policy：ask";
  readSettingsError = false;
  readSettingsCalls = 0;
  forkResult: { id: string; title?: string } | undefined = {
    id: "child-s9",
    title: "分叉会话",
  };
  forkError: Error | undefined;
  forkCalls = 0;
  readSettings: (() => Promise<string | undefined>) | undefined =
    async (): Promise<string | undefined> => {
      this.readSettingsCalls++;
      if (this.readSettingsError) throw new Error("describe 失败");
      return this.readSettingsResult;
    };
  forkCurrentSession:
    (() => Promise<{ id: string; title?: string }>) | undefined =
    async (): Promise<{ id: string; title?: string }> => {
      this.forkCalls++;
      if (this.forkError) throw this.forkError;
      if (!this.forkResult) throw new Error("源会话不存在");
      return this.forkResult;
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

test("routeSlashCommand: /settings → settings；/fork → fork", () => {
  assert.equal(routeSlashCommand("settings"), "settings");
  assert.equal(routeSlashCommand("fork"), "fork");
});

// ---------- /settings ----------

test("/settings：readSettings 多行 → info notice（含 ns：value）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSettingsForkAdapter();
  adapter.readSettingsResult = "theme：dark\nfork.policy：ask";
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/settings");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.equal(adapter.readSettingsCalls, 1, "只调一次 describe");
  assert.ok(f.includes("theme：dark"), "首行: " + f);
  assert.ok(f.includes("fork.policy：ask"), "第二行: " + f);
  app.dispose();
});

test("/settings：adapter 返回空 → 占位「（无设置项）」", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSettingsForkAdapter();
  adapter.readSettingsResult = "";
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/settings");
  await tick();
  await tick();
  assert.ok(frames(renderer).includes("（无设置项）"), frames(renderer));
  app.dispose();
});

test("/settings：服务缺失 → warn 且不调 describe", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSettingsForkAdapter();
  adapter.readSettings = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/settings");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("settings 服务不可用"), "warn 提示: " + f);
  app.dispose();
});

test("/settings：describe 抛错 → warn", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSettingsForkAdapter();
  adapter.readSettingsError = true;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/settings");
  await tick();
  await tick();
  assert.ok(frames(renderer).includes("settings 服务不可用"), frames(renderer));
  app.dispose();
});

// ---------- /fork ----------

test("/fork：成功 → success + 新会话 id + /session 提示（id 与当前不同）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSettingsForkAdapter();
  adapter.forkResult = { id: "child-s9", title: "分叉会话" };
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/fork");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.equal(adapter.forkCalls, 1);
  assert.ok(f.includes("已分叉新会话 child-s9"), "success 提示: " + f);
  assert.ok(f.includes("可用 /session 查看或切换"), "切换提示: " + f);
  app.dispose();
});

test("/fork：错误（错误码映射文案）→ warn 分叉失败", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSettingsForkAdapter();
  adapter.forkError = new Error("源会话不存在");
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/fork");
  await tick();
  await tick();
  assert.ok(
    frames(renderer).includes("分叉失败：源会话不存在"),
    frames(renderer),
  );
  app.dispose();
});

test("/fork：服务缺失 → warn 且不调服务", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeSettingsForkAdapter();
  adapter.forkCurrentSession = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/fork");
  await tick();
  assert.ok(frames(renderer).includes("sessions 服务不可用"), frames(renderer));
  app.dispose();
});
