// tests/permission.test.ts — 权限预设选择（/permission）：route + App 命令
//
// 覆盖：routeSlashCommand /permission；App 无参（读 ctx.permissionPresets 目录 →
// notice 列当前 + 可用列表）、带参（转发宿主 /permission 写路径）、宿主未挂载
// ctx.permissionPresets（adapter 无 permissionCatalog）→ notice「权限预设服务不可用」不崩溃。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { routeSlashCommand } from "../src/app/commands.ts";
import type { PermissionPresetInfo } from "../src/app/adapter/types.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { RenderLine, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  renders = 0;
  refreshes = 0;
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  lastRender: string[] = [];
  render(lines: RenderLine[]): void {
    this.lastRender = lines.map((l) => l.text);
    this.renders++;
  }
  refresh(_lines: RenderLine[]): void {
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

const DEMO_INFO: PermissionPresetInfo = {
  current: "workspace-write",
  names: ["workspace-write", "danger-full-access"],
  entries: [
    {
      key: "workspace-write",
      name: "workspace-write",
      description:
        "Write inside the workspace; wider retries require approval.",
    },
    {
      key: "danger-full-access",
      name: "danger-full-access",
      description: "Full file access without approval prompts.",
    },
  ],
};

class FakePermissionAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  commands: string[] = [];
  /** 模拟宿主未挂载：置 undefined */
  permissionCatalog:
    (() => Promise<PermissionPresetInfo | undefined>) | undefined = async () =>
    DEMO_INFO;
  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }
  sendMessage(): void {}
  runCommand(line: string): void {
    this.commands.push(line);
  }
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

test("routeSlashCommand: /permission → permission；未知仍回 registry", () => {
  assert.equal(routeSlashCommand("permission"), "permission");
  assert.equal(routeSlashCommand("bogus"), "registry");
});

test("/permission 无参：读目录 → 打开状态选项面板列出可用预设", async () => {
  const renderer = new FakeRenderer();
  const app = new App({ renderer, adapter: new FakePermissionAdapter() });
  app.start();
  typeAndEnter(renderer, "/permission");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("/permission 权限预设"), "面板标题: " + f);
  assert.ok(f.includes("workspace-write"), "应列出可用预设: " + f);
  assert.ok(f.includes("danger-full-access"), "应列出两个预设: " + f);
  assert.ok(f.includes("[Enter]提交"), "操作提示: " + f);
  app.dispose();
});

test("/permission <name>：转发宿主 /permission（写路径由宿主完成）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakePermissionAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/permission danger-full-access");
  await tick();
  assert.deepEqual(adapter.commands, ["/permission danger-full-access"]);
  app.dispose();
});

test("/permission 无参：宿主未挂载 ctx.permissionPresets → notice 不可用不崩溃", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakePermissionAdapter();
  adapter.permissionCatalog = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/permission");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("权限预设服务不可用"), "应提示不可用: " + f);
  app.dispose();
});
