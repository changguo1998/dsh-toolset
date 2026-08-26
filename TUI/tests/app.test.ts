// tests/app.test.ts — App 层 slash 命令路由单测
//
// 覆盖：submit() 对 / 前缀行走 slash 路由；本地表 /help /clearscreen /cls /quit；
// 未知命令 fail-close(不经 sendMessage)；notice 事件进入缓冲。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App, formatModelCatalog, resolveModelSpec } from "../src/app/index.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelCatalog,
  ModelSelection,
} from "../src/app/adapter/dsh.ts";
import type { Renderer, KeyEvent } from "../src/renderer/index.ts";
import type { RenderLine, Size } from "../src/renderer/screen.ts";

/** 记录行为的 fake renderer */
class FakeRenderer implements Renderer {
  keys: KeyEvent[] = [];
  renders = 0;
  refreshes = 0;
  closed = 0;
  size: Size = { cols: 80, rows: 24 };
  /** 最近一次 render 的文本行（仅文本，无 ANSI） */
  lastRender: string[] = [];

  render(lines: RenderLine[]): void {
    this.lastRender = lines.map((l) => l.text);
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
  emitKey(k: KeyEvent): void {
    this.press(k);
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
  catalogCalls = 0;
  savedSelections: ModelSelection[] = [];
  modelCatalogData: ModelCatalog = {
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [
      { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
      {
        provider: "deepseek",
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
      },
    ],
    current: { provider: "deepseek", model: "deepseek-chat" },
  };
  async modelCatalog(): Promise<ModelCatalog> {
    this.catalogCalls++;
    return this.modelCatalogData;
  }
  async setSessionModel(sel: ModelSelection): Promise<ModelSelection> {
    this.savedSelections.push(sel);
    this.modelCatalogData = { ...this.modelCatalogData, current: { ...sel } };
    return { ...sel };
  }
  async modelEfforts(
    _provider: string,
    _model: string,
  ): Promise<{ id: string; name: string }[] | undefined> {
    return [
      { id: "low", name: "low" },
      { id: "high", name: "high" },
      { id: "max", name: "max" },
    ];
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

/** 等待 /model 的 async 链路（Promise 微任务 + setTimeout 0）落定 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
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

test("formatModelCatalog ASCII 紧凑格式: -> 标记当前, 空格缩进其他", () => {
  const text = formatModelCatalog({
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [
      { provider: "deepseek", id: "deepseek-chat", name: "chat" },
      { provider: "deepseek", id: "deepseek-reasoner", name: "reasoner" },
    ],
    current: { provider: "deepseek", model: "deepseek-chat" },
  });
  assert.match(text, /^ {2}-> deepseek\/deepseek-chat$/m);
  assert.match(text, /^ {5}deepseek\/deepseek-reasoner$/m);
  // 无中文（纯 ASCII）
  assert.ok(!/[\u4e00-\u9fff]/.test(text), "不应含汉字: " + text);
});

test("formatModelCatalog 当前模型不在列表中也以 -> 显示", () => {
  const text = formatModelCatalog({
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [{ provider: "deepseek", id: "deepseek-chat", name: "chat" }],
    current: { provider: "deepseek", model: "deepseek-reasoner" },
  });
  assert.match(text, /^ {2}-> deepseek\/deepseek-reasoner$/m);
  assert.match(text, /^ {5}deepseek\/deepseek-chat$/m);
});

test("resolveModelSpec 裸 id 唯一匹配 / 未匹配 / 歧义", () => {
  const catalog: ModelCatalog = {
    providers: [
      { provider: "p1", name: "p1" },
      { provider: "p2", name: "p2" },
    ],
    models: [
      { provider: "p1", id: "chat", name: "chat" },
      { provider: "p2", id: "chat", name: "chat" },
      { provider: "p1", id: "reasoner", name: "reasoner" },
    ],
    current: { provider: "p1", model: "chat" },
  };
  const uniq = resolveModelSpec(catalog, "reasoner");
  assert.ok(!("error" in uniq));
  assert.deepEqual(uniq.selection, { provider: "p1", model: "reasoner" });
  assert.equal(uniq.same, false);

  const missing = resolveModelSpec(catalog, "nope");
  assert.ok("error" in missing);
  assert.match(missing.error, /not found/);

  const amb = resolveModelSpec(catalog, "chat");
  assert.ok("error" in amb);
  assert.match(amb.error, /multiple providers/);
});

test("/model 面板: Tab 切到思考等级, ↓ 选等级, Enter 应用(模型+等级一起)", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  // 模型焦点区: 下移离开 current 行(选中 deepseek-reasoner)
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush();
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  await flush(); // phase -> 1, efforts已加载(low/high/max)
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush(); // effortIndex -> 1 = high
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.ok(adapter.savedSelections.length >= 1, "应有切换");
  assert.deepEqual(adapter.savedSelections[0], {
    provider: "deepseek",
    model: "deepseek-reasoner",
    reasoningEffort: "high",
  });
});

test("/model 面板: 同模型改等级不触发 already-on, 应用 max", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush(); // 模型焦点区 index0 = current 行(deepseek-chat)
  renderer.press({ name: "tab", ctrl: false, meta: false, shift: false });
  await flush(); // 等级焦点区
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush();
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  await flush(); // effortIndex -> 2 = max
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.savedSelections[0], {
    provider: "deepseek",
    model: "deepseek-chat",
    reasoningEffort: "max",
  });
});

test("resolveModelSpec provider/model 显式直通（无需目录命中）", () => {
  const catalog: ModelCatalog = {
    providers: [],
    models: [],
    current: undefined,
  };
  const r = resolveModelSpec(catalog, "custom/deepseek-v3");
  assert.ok(!("error" in r));
  assert.deepEqual(r.selection, { provider: "custom", model: "deepseek-v3" });
});

test("/model 无参 → 调用 modelCatalog（不经 sendMessage）", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  assert.ok(adapter.catalogCalls >= 1);
  assert.deepEqual(adapter.savedSelections, []);
  assert.deepEqual(adapter.sent, []);
});

test("/model <id> → setSessionModel + 更新", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model deepseek-reasoner");
  await flush();
  assert.deepEqual(adapter.savedSelections, [
    { provider: "deepseek", model: "deepseek-reasoner" },
  ]);
  assert.deepEqual(adapter.sent, []);

  test("/model 切换后状态栏显示新模型", async () => {
    const { renderer, adapter } = makeApp();
    typeAndEnter(renderer, "/model deepseek-reasoner");
    await flush();
    const joined = renderer.lastRender.join("\n");
    assert.ok(
      joined.includes("deepseek-reasoner"),
      "状态栏应含新模型，实际:\n" + joined,
    );
    assert.ok(adapter.savedSelections.length === 1); // 确认确实切换了
  });
});

test("/model 未知模型 → 不调用 setSessionModel", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model nope");
  await flush();
  assert.deepEqual(adapter.savedSelections, []);
  assert.deepEqual(adapter.sent, []);
});

test("/model 当前模型 → 不重复切换", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model deepseek-chat");
  await flush();
  assert.deepEqual(adapter.savedSelections, []);
  assert.deepEqual(adapter.sent, []);
});

// ---------- /model 交互选择模式 ----------

test("交互选择：无参 /model 打开面板；模式下普通字符不插入输入框", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  assert.ok(adapter.catalogCalls >= 1);
  assert.deepEqual(adapter.savedSelections, []);
  // 选择模式下按普通字符 x 与方向之外的键：不进入输入框、不发送
  renderer.press({ name: "x", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  // index 0 = 当前模型行, 默认等级 low → 同模型但等级不同 → 允许切换
  assert.deepEqual(adapter.savedSelections, [
    {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "low",
    },
  ]);
  assert.deepEqual(adapter.sent, []);
});

test("交互选择：↑/↓ 移动，Enter 确认持久切换并保留当前 reasoningEffort", async () => {
  const { renderer, adapter } = makeApp();
  adapter.modelCatalogData = {
    ...adapter.modelCatalogData,
    current: {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "high",
    },
  };
  typeAndEnter(renderer, "/model");
  await flush();
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.savedSelections, [
    {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningEffort: "high",
    },
  ]);
  assert.deepEqual(adapter.sent, []);
});

test("交互选择：Esc 取消不改变，退出后输入恢复正常", async () => {
  const { renderer, adapter } = makeApp();
  typeAndEnter(renderer, "/model");
  await flush();
  renderer.press({ name: "down", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "escape", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.savedSelections, []);
  // 退出面板后：普通输入恢复进输入框
  renderer.press({ name: "a", ctrl: false, meta: false, shift: false });
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  assert.deepEqual(adapter.sent, ["a"]);
});

test("交互选择：当前模型不在候选目录中时补行，Enter 确认当前 → 不重复切换", async () => {
  const { renderer, adapter } = makeApp();
  adapter.modelCatalogData = {
    providers: [{ provider: "deepseek", name: "deepseek" }],
    models: [
      { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
    ],
    current: {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningEffort: "low", // 不在 models 里, 且等级与面板默认(低)一致
    },
  };
  typeAndEnter(renderer, "/model");
  await flush();
  // index 0 = 补行的当前模型 deepseek-reasoner, 等级 low == 默认等级 → 不重复切换
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
  await flush();
  assert.deepEqual(adapter.savedSelections, []);
  assert.deepEqual(adapter.sent, []);
});
