// tests/notify-bell.test.ts — P2#33 声音提醒事件钩子
//
// 契约：任务运行结束（turn-end 事件）→ renderer.bell()（终端 BEL \x07）；随后启动
// 「等待用户输入超阈值」计时（notify.idleThresholdMs，默认 8000ms；可配），阈值内
// 任意用户输入即取消，超阈值补响一次。开关 notify.enabled=false → 全程不响。
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

test("turn-end → 任务结束 bell 一次", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  adapter.emit({ type: "turn-end" });
  await tick(10);
  assert.equal(renderer.bells, 1, "turn-end 应响 bell");
  app.dispose();
});

test("notify.enabled=false → 全程不响 bell", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter, notify: { enabled: false } });
  app.start();
  adapter.emit({ type: "turn-end" });
  await tick(40);
  assert.equal(renderer.bells, 0, "关闭开关不应响");
  app.dispose();
});

test("等待用户输入超阈值 → 补响一次（阈值可配）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({
    renderer,
    adapter,
    notify: { idleThresholdMs: 20 },
  });
  app.start();
  adapter.emit({ type: "turn-end" });
  await tick(80);
  assert.equal(
    renderer.bells,
    2,
    "超阈值应补响（1 次任务结束 + 1 次等待超时）",
  );
  app.dispose();
});

test("阈值内用户输入 → 等待 bell 取消（仅任务结束 1 次）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeAdapter();
  const app = new App({
    renderer,
    adapter,
    notify: { idleThresholdMs: 40 },
  });
  app.start();
  adapter.emit({ type: "turn-end" });
  await tick(5);
  renderer.emitKey({ name: "enter", ctrl: false, meta: false, shift: false });
  await tick(90);
  assert.equal(renderer.bells, 1, "输入后等待 bell 取消");
  app.dispose();
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
