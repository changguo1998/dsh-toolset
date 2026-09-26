// tests/stats-rename.test.ts — 批次 1：/stats 与 /rename（notice 型命令）
//
// 覆盖：路由（stats/usage/context → stats；rename → rename）；/stats 读 state.usage
// 输出「最近一次调用行 / 本会话累计行 / 上下文行 / 命中率行」、contextWindow 缺失或为 0
// 时只显绝对量（不除零）、无 usage → info 提示；usage 累计口径与清零边界（TUI#9：会话
// 切换/恢复清零、清屏不清零）；/rename 成功经 adapter.renameSession、缺参 → 用法 info、
// 空白参数 → error、服务缺失 → warn（后三者均不发服务调用）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import {
  renameCommandDecision,
  routeSlashCommand,
} from "../src/app/commands.ts";
import { initialState, reduceState } from "../src/app/state.ts";
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

class FakeCmdAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  renameCalls: string[] = [];
  /** 模拟宿主未挂载 ctx.sessionTitle：置 undefined */
  renameSession: ((title: string) => Promise<void>) | undefined = async (
    title: string,
  ): Promise<void> => {
    this.renameCalls.push(title);
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

function frames(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("routeSlashCommand: /stats、/usage、/context → stats；/rename → rename", () => {
  assert.equal(routeSlashCommand("stats"), "stats");
  assert.equal(routeSlashCommand("usage"), "stats");
  assert.equal(routeSlashCommand("context"), "stats");
  assert.equal(routeSlashCommand("rename"), "rename");
  assert.equal(routeSlashCommand("bogus"), "registry");
});

test("/stats：有 usage（含 contextWindow）→ 分解行 + 上下文占比 + 命中率", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCmdAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  adapter.emit({
    type: "usage",
    sessionId: "s1",
    input: 1000,
    output: 200,
    cacheRead: 4000,
    contextWindow: 20000,
  });
  typeAndEnter(renderer, "/stats");
  await tick();
  const f = frames(renderer);
  // 上下文口径 = input + cacheRead = 5000；占比 5000/20000 = 25%；命中率 4000/5000 = 80%
  assert.ok(
    f.includes("最近一次调用：输入 1000 · 输出 200 · 缓存读 4000"),
    "最近一次调用行: " + f,
  );
  assert.ok(
    f.includes("本会话累计：输入 1000 · 输出 200 · 缓存读 4000"),
    "本会话累计行（首次调用时与最近一次相同）: " + f,
  );
  assert.ok(f.includes("上下文：5000 / 20000（25%）"), "上下文行: " + f);
  assert.ok(f.includes("缓存命中率：80%"), "命中率行: " + f);
  app.dispose();
});

test("usage 双口径：会话累计 = 事件求和；会话切换/恢复清零、清屏不清零（TUI#9）", () => {
  // 逐次 usage 事件求和 = 本会话累计；usage 仍是「最近一次调用」
  let s = initialState();
  s = reduceState(s, {
    type: "usage",
    sessionId: "s1",
    input: 100,
    output: 10,
    cacheRead: 900,
    contextWindow: 2000,
  });
  s = reduceState(s, {
    type: "usage",
    sessionId: "s1",
    input: 200,
    output: 20,
    cacheRead: 1800,
    contextWindow: 2000,
  });
  assert.deepEqual(s.usageTotals, { input: 300, output: 30, cacheRead: 2700 });
  assert.equal(s.usage?.input, 200, "usage 仍为最近一次调用口径");
  // /clearscreen（clear-buffer）：只清显示 → 累计保留
  assert.deepEqual(
    reduceState(s, { type: "clear-buffer" }).usageTotals,
    s.usageTotals,
  );
  // /new（session-switch）：换新会话 → 累计清零
  const fresh = reduceState(s, {
    type: "session-switch",
    id: "s2",
    title: "新会话",
  });
  assert.deepEqual(fresh.usageTotals, { input: 0, output: 0, cacheRead: 0 });
  // /session 面板恢复（history-resume-ok）：换会话 → 累计清零
  let r = reduceState(s, { type: "history-open" });
  r = reduceState(r, { type: "history-resume", id: "old-1" });
  r = reduceState(r, {
    type: "history-resume-ok",
    id: "old-1",
    title: "旧会话",
    rows: [],
  });
  assert.deepEqual(r.usageTotals, { input: 0, output: 0, cacheRead: 0 });
});

test("/stats：contextWindow 缺失 → 只显绝对量，不除零", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCmdAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  adapter.emit({
    type: "usage",
    sessionId: "s1",
    input: 10,
    output: 1,
    cacheRead: 0,
  });
  typeAndEnter(renderer, "/usage");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("上下文：10"), "绝对量行: " + f);
  assert.ok(!f.includes("上下文：10 /"), "不应出现除式: " + f);
  assert.ok(f.includes("缓存命中率：0%"), "命中率 0%（cacheRead=0）: " + f);
  app.dispose();
});

test("/stats：contextWindow 为 0 → 不除零（同缺失处理）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCmdAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  adapter.emit({
    type: "usage",
    sessionId: "s1",
    input: 7,
    output: 0,
    cacheRead: 3,
    contextWindow: 0,
  });
  typeAndEnter(renderer, "/context");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("上下文：10"), "绝对量行: " + f);
  assert.ok(!f.includes("上下文：10 /"), "不应出现除式（除零）: " + f);
  app.dispose();
});

test("/stats：无 usage → info 提示（本会话尚未调用）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCmdAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/stats");
  await tick();
  const f = frames(renderer);
  assert.ok(
    f.includes("暂无 token 用量数据（本会话尚未发生模型调用）"),
    "提示文本: " + f,
  );
  app.dispose();
});

test("/rename <title>：调用 renameSession 并提示成功", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCmdAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/rename 修复登录流程");
  await tick();
  assert.deepEqual(adapter.renameCalls, ["修复登录流程"]);
  const f = frames(renderer);
  assert.ok(f.includes("已重命名为「修复登录流程」"), "成功提示: " + f);
  app.dispose();
});

test("/rename：缺参 → 用法提示，且不发服务调用", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCmdAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/rename");
  await tick();
  assert.equal(adapter.renameCalls.length, 0, "不应调用服务");
  const f = frames(renderer);
  assert.ok(f.includes("用法：/rename <标题>"), "用法提示: " + f);
  app.dispose();
});

test("renameCommandDecision：无参 → usage；空白/换行 → invalid；其余 → apply", () => {
  assert.deepEqual(renameCommandDecision("/rename"), { kind: "usage" });
  // App 提交路径已 trim 整行，故「空白参数」与「含换行」两个非法分支
  // 只能经纯函数直接构造验证（边界：handler 仍按其结果拒绝，不发服务调用）
  assert.deepEqual(renameCommandDecision("/rename   "), {
    kind: "invalid",
    reason: "标题不能为空",
  });
  assert.deepEqual(renameCommandDecision("/rename a\nb"), {
    kind: "invalid",
    reason: "标题不能包含换行",
  });
  assert.deepEqual(renameCommandDecision("/rename 修复登录流程"), {
    kind: "apply",
    title: "修复登录流程",
  });
});

test("/rename：服务缺失 → warn，不崩溃", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCmdAdapter();
  adapter.renameSession = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/rename 新标题");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("sessionTitle 服务不可用"), "不可用提示: " + f);
  app.dispose();
});
