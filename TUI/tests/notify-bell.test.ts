// tests/notify-bell.test.ts — 声音提醒事件钩子（P2#33 / BACKLOG 3.4.1-3.4.3）
//
// 契约（2026-09-26 更新）：
//  1) turn-end（任务运行结束）→ **只响一声**（BACKLOG 3.4.2：去掉原「随后 idle 补响一次」，
//     一次 run 结束不再听到两声）
//  2) 需交互（审批 / 问答面板弹出）→ 立即响一声（3.4.1），并起「无操作超阈值」计时；
//     超阈值仍无操作 → 每秒响一次，直到用户有操作或面板关闭（3.4.3）；
//     一次交互内最多进入一次（有操作即停、同一次交互不再重启）
//  3) 任意按键（含无效键，人在终端前即算操作）停止催促；面板关闭（提交 / 取消 / 超时）
//     与 dispose 必须清理计时
//  4) 开关 notify.enabled=false → 全程不响
// 配置经 tui.config.json `notify` 读取（config.ts 归一化；缺省即可用）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRenderer } from "../src/renderer/index.ts";
import { App } from "../src/app/index.ts";
import type { Renderer } from "../src/renderer/index.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelSelection,
} from "../src/app/adapter/types.ts";
import type { KeyEvent } from "../src/renderer/index.ts";

class FakeRenderer implements Renderer {
  bells = 0;
  /** 记录任务结束/等待超时之外还需完整状态区大小的实现 */
  size = { cols: 80, rows: 24 };
  render(): void {}
  refresh(): void {}
  private keyCb: ((k: KeyEvent) => void) | null = null;
  onKey(cb: (k: KeyEvent) => void): void {
    this.keyCb = cb;
  }
  emitKey(k: KeyEvent): void {
    this.keyCb?.(k);
  }
  onResize(): void {}
  getSize() {
    return this.size;
  }
  setTheme(): void {}
  bell(): void {
    this.bells++;
  }
  close(): void {}
}

/** 最小完整 DshAdapter：公开 emit 推事件（turn-end 等），其余方法空实现 */
class FakeAdapter implements DshAdapter {
  private cbs: ((e: DshEvent) => void)[] = [];
  onEvent(cb: (e: DshEvent) => void): () => void {
    this.cbs.push(cb);
    return () => {
      const i = this.cbs.indexOf(cb);
      if (i >= 0) this.cbs.splice(i, 1);
    };
  }
  emit(e: DshEvent): void {
    for (const cb of this.cbs) cb(e);
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

const tick = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** 构造 App + fake（notify 阈值按用例给） */
function makeApp(notify?: { enabled?: boolean; idleThresholdMs?: number }): {
  app: App;
  renderer: FakeRenderer;
  adapter: FakeAdapter;
} {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter, notify });
  app.start();
  return { app, renderer, adapter };
}

test("turn-end → 任务结束只响一声（BACKLOG 3.4.2：不再有 idle 补响）", async () => {
  const { app, renderer, adapter } = makeApp({ idleThresholdMs: 20 });
  adapter.emit({ type: "turn-end" });
  await tick(80);
  assert.equal(
    renderer.bells,
    1,
    "一次 run 结束只响一声（旧行为在超阈值后为 2 声）",
  );
  app.dispose();
});

test("turn-end 后长时间无输入 / 有输入都不改变响铃次数", async () => {
  const a = makeApp({ idleThresholdMs: 20 });
  a.adapter.emit({ type: "turn-end" });
  await tick(60);
  assert.equal(a.renderer.bells, 1, "无输入：仍只一声");
  a.app.dispose();

  const b = makeApp({ idleThresholdMs: 40 });
  b.adapter.emit({ type: "turn-end" });
  await tick(5);
  b.renderer.emitKey({ name: "enter", ctrl: false, meta: false, shift: false });
  await tick(90);
  assert.equal(b.renderer.bells, 1, "有输入：仍只一声");
  b.app.dispose();
});

test("notify.enabled=false → turn-end 与需交互面板都不响", async () => {
  const { app, renderer, adapter } = makeApp({
    enabled: false,
    idleThresholdMs: 10,
  });
  adapter.emit({ type: "turn-end" });
  adapter.emit({ type: "approval", id: "a1", prompt: "允许执行?" });
  await tick(60);
  assert.equal(renderer.bells, 0, "关闭开关不应响");
  app.dispose();
});

test("需交互：审批 / 问答面板弹出即响一声（BACKLOG 3.4.1）", async () => {
  // 阈值给大值，隔离 3.4.3 的催促，只看即时响铃
  const a = makeApp({ idleThresholdMs: 60_000 });
  a.adapter.emit({ type: "approval", id: "a1", prompt: "允许执行?" });
  assert.equal(a.renderer.bells, 1, "审批弹出即响一声");
  a.app.dispose();

  const q = makeApp({ idleThresholdMs: 60_000 });
  q.adapter.emit({
    type: "question",
    id: "q1",
    questions: [{ id: "q1", question: "继续?" }],
  });
  assert.equal(q.renderer.bells, 1, "问答弹出即响一声");
  q.app.dispose();
});

test("需交互无操作超阈值 → 每秒催促，按键即停且不再重启（BACKLOG 3.4.3）", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { app, renderer, adapter } = makeApp({ idleThresholdMs: 1000 });
  adapter.emit({ type: "approval", id: "a1", prompt: "允许执行?" });
  assert.equal(renderer.bells, 1, "弹出即响一声（3.4.1）");
  t.mock.timers.tick(999);
  assert.equal(renderer.bells, 1, "阈值内不催促");
  t.mock.timers.tick(1); // 超阈值 → 进入重复（首次间隔尚未到）
  t.mock.timers.tick(3000); // 3 次催促
  assert.equal(renderer.bells, 4, "超阈值后每秒响一次");
  // 任意按键（无效键也算「人在终端前」）→ 停止且不重启
  renderer.emitKey({ name: "x", ctrl: false, meta: false, shift: false });
  t.mock.timers.tick(5000);
  assert.equal(renderer.bells, 4, "按键后停止催促，且同一次交互不再重启");
  app.dispose();
  t.mock.timers.reset();
});

test("需交互面板关闭（y 应答）→ 停止催促计时（BACKLOG 3.4.3）", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { app, renderer, adapter } = makeApp({ idleThresholdMs: 1000 });
  adapter.emit({ type: "approval", id: "a1", prompt: "允许执行?" });
  t.mock.timers.tick(1000); // 超阈值 → 进入重复
  t.mock.timers.tick(1000); // 第一次催促
  assert.ok(renderer.bells >= 2, "催促已启动: " + renderer.bells);
  const before = renderer.bells;
  renderer.emitKey({ name: "y", ctrl: false, meta: false, shift: false });
  t.mock.timers.tick(5000);
  assert.equal(renderer.bells, before, "面板关闭后不再催促");
  app.dispose();
  t.mock.timers.reset();
});

test("dispose 清理催促计时（不再响铃、无泄漏）", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { app, renderer, adapter } = makeApp({ idleThresholdMs: 1000 });
  adapter.emit({ type: "approval", id: "a1", prompt: "允许执行?" });
  t.mock.timers.tick(3000);
  const before = renderer.bells;
  app.dispose();
  t.mock.timers.tick(5000);
  assert.equal(renderer.bells, before, "dispose 后不再响铃");
  t.mock.timers.reset();
});

test("真实 renderer bell 输出 BEL（\\x07）到输出流", () => {
  let out = "";
  const r = createRenderer({
    write: (s: string) => {
      out += s;
    },
    rawMode: false,
    exitOnClose: false, // 测试内不 exit 进程（默认 true 会杀 node:test runner）
  });
  r.bell?.();
  assert.ok(out.includes("\x07"), `输出流应收到 BEL: ${JSON.stringify(out)}`);
  r.close();
});
