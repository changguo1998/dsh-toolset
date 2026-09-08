// tests/agent-preset.test.ts — agent 预设（/preset）：route 路由 + reducer 隔离 + App 命令
//
// 覆盖：routeSlashCommand /preset；DshEvent agent-preset → reducer presetBySession
// 按 sessionId 隔离（latest-wins）；App 无参（读 ctx.agentPresets 目录 → notice 列
// 当前/可用/默认）、带参（selectAgentPreset 写路径）、宿主未挂载 ctx.agentPresets
// → notice「agent 预设服务不可用」不崩溃。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import { routeSlashCommand } from "../src/app/commands.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { AgentPresetInfo } from "../src/app/adapter/types.ts";
import { createRealDshAdapter } from "../src/app/adapter/dsh.ts";
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

const DEMO_INFO: AgentPresetInfo = {
  current: "research",
  defaultId: "default",
  presets: [
    { id: "default", name: "default", description: "General-purpose agent." },
    {
      id: "research",
      name: "research",
      description: "Read-heavy research preset.",
    },
  ],
};

class FakePresetAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  selectCalls: string[] = [];
  /** 模拟宿主未挂载 ctx.agentPresets：置 undefined */
  agentPresetCatalog: (() => Promise<AgentPresetInfo | undefined>) | undefined =
    async () => DEMO_INFO;
  selectAgentPreset: ((id: string) => Promise<void>) | undefined = async (
    id: string,
  ): Promise<void> => {
    this.selectCalls.push(id);
  };
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

test("routeSlashCommand: /preset → preset；未知仍回 registry", () => {
  assert.equal(routeSlashCommand("preset"), "preset");
  assert.equal(routeSlashCommand("bogus"), "registry");
});

test("agent-preset 事件 → reducer 按 sessionId 隔离（latest-wins）", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "agent-preset",
    sessionId: "s1",
    preset: "research",
  });
  s = reduceState(s, {
    type: "agent-preset",
    sessionId: "s2",
    preset: "code-review",
  });
  s = reduceState(s, {
    type: "agent-preset",
    sessionId: "s1",
    preset: "default",
  });
  assert.equal(s.presetBySession["s1"], "default");
  assert.equal(s.presetBySession["s2"], "code-review");
});

test("/preset 无参：读目录 → 打开状态选项面板列出 agent 预设", async () => {
  const renderer = new FakeRenderer();
  const app = new App({ renderer, adapter: new FakePresetAdapter() });
  app.start();
  typeAndEnter(renderer, "/preset");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("/preset agent 预设"), "面板标题: " + f);
  assert.ok(f.includes("research"), "应列出当前预设: " + f);
  assert.ok(
    f.includes("code-review") || f.includes("General-purpose"),
    "应列出预设: " + f,
  );
  assert.ok(f.includes("[Enter]提交"), "操作提示: " + f);
  app.dispose();
});

test("/preset <id>：调用 selectAgentPreset 写路径并提示已切换", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakePresetAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/preset code-review");
  await tick();
  assert.deepEqual(adapter.selectCalls, ["code-review"]);
  const f = frames(renderer);
  assert.ok(f.includes("已切换为 code-review"), "应提示切换结果: " + f);
  app.dispose();
});

test("/preset 无参：宿主未挂载 ctx.agentPresets → notice 不可用不崩溃", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakePresetAdapter();
  adapter.agentPresetCatalog = undefined;
  adapter.selectAgentPreset = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/preset");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("agent 预设服务不可用"), "应提示不可用: " + f);
  app.dispose();
});
test("agent-preset/selected 归一化：seq 守卫 + 非活跃会话丢弃（DshEvent 层）", () => {
  // 契约点名 tests/agent-preset.test.ts 的 DshEvent 归一化断言；与
  // adapter.dsh.test.ts 相同覆盖（此处为契约文件级落位，两份保留）。
  const events: DshEvent[] = [];
  const runtime = new FakeAdapterRuntime();
  const adapter = createRealDshAdapter({
    runtime,
    sessionId: "s1",
    agent: { session: { id: "s1" }, followup() {} },
    approvalTimeoutMs: 50,
  });
  adapter.onEvent((e) => events.push(e));
  const send = (sessionId: string, seq: number, preset: unknown): void => {
    runtime.fireRaw(
      "session/event",
      { id: sessionId },
      {
        type: "agent-preset/selected",
        seq,
        time: Date.now(),
        data: { agentPreset: preset },
      },
    );
  };
  // 递增 seq 正常归一化
  send("s1", 1, "research");
  // 同 seq 重复 → 丢弃（seq 守卫）
  send("s1", 1, "default");
  // 递增 seq 正常 → 更新
  send("s1", 2, "code-review");
  // 非法（非字符串 / 空）→ 丢弃
  send("s1", 3, "");
  send("s1", 4, 42);
  // 非活跃会话 → 丢弃（适配器单活跃会话约束）
  send("s2", 1, "research");
  const presets = events.filter((e) => e.type === "agent-preset");
  assert.deepEqual(presets, [
    { type: "agent-preset", sessionId: "s1", preset: "research" },
    { type: "agent-preset", sessionId: "s1", preset: "code-review" },
  ]);
});

/** 最小 fake runtime：仅需 on + fireRaw（适配器注册/归一化链路）。 */
class FakeAdapterRuntime {
  listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  on(event: string, listener: (...args: unknown[]) => unknown): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
  fireRaw(event: string, ...args: unknown[]): unknown {
    const set = this.listeners.get(event);
    if (!set) return undefined;
    for (const cb of [...set]) cb(...args);
  }
}
