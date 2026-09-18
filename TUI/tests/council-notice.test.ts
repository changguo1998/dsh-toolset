// tests/council-notice.test.ts — P2#18：/council 二次意见命令（notice 型）
//
// 覆盖：路由；并行 N 个评审子代理（默认 2）→ 汇总 notice；带参 count 生效；
// 宿主无 subagents.start → warn 不假启动；部分失败降级保留其余；全部失败 → 失败提示。

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

class FakeCouncilAdapter implements DshAdapter {
  cbs: ((e: DshEvent) => void)[] = [];
  /** 记录 council 调用：目标 + count */
  calls: { target: string; count: number }[] = [];
  /** 模拟意见输出（第 i 个评审返回的文本；undefined = 该 run 失败降级） */
  opinions: (string | undefined)[] = [];
  /** 宿主无 start 面：置 undefined */
  council: ((target: string, count?: number) => Promise<string>) | undefined =
    async (target: string, count = 2): Promise<string> => {
      this.calls.push({ target, count });
      const n = Math.max(1, Math.min(4, Math.floor(count)));
      const lines: string[] = [];
      let ok = 0;
      for (let i = 0; i < n; i++) {
        const body = this.opinions[i];
        if (body === undefined) {
          lines.push(`评审 ${i + 1}：失败`);
        } else {
          lines.push(`评审 ${i + 1}：${body}`);
          ok++;
        }
      }
      if (ok === 0) return `council 失败：${count} 个评审均未返回意见`;
      return [`council（${ok}/${n} 成功）`, ...lines].join("\n");
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

test("routeSlashCommand: /council → council", () => {
  assert.equal(routeSlashCommand("council"), "council");
});

test("/council：默认 2 个评审并行 → notice 汇总（council（2/2 成功）+ 各行）", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCouncilAdapter();
  adapter.opinions = ["风险：缺少验收", "改进：补充测试"];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/council");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0]?.count, 2);
  assert.ok(f.includes("council（2/2 成功）"), "汇总行: " + f);
  assert.ok(f.includes("评审 1：风险：缺少验收"), "评审 1: " + f);
  assert.ok(f.includes("评审 2：改进：补充测试"), "评审 2: " + f);
  app.dispose();
});

test("/council 3：带参 count 生效", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCouncilAdapter();
  adapter.opinions = ["a", "b", "c"];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/council 3");
  await tick();
  await tick();
  assert.equal(adapter.calls[0]?.count, 3);
  const f = frames(renderer);
  assert.ok(f.includes("council（3/3 成功）"), f);
  app.dispose();
});

test("/council：宿主无 start 面 → warn 不假启动", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCouncilAdapter();
  adapter.council = undefined;
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/council");
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("council 不可用"), "warn 文案: " + f);
  app.dispose();
});

test("/council：部分失败降级保留其余", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCouncilAdapter();
  adapter.opinions = ["意见一", undefined, "意见三"];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/council 3");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("council（2/3 成功）"), "降级计数: " + f);
  assert.ok(f.includes("评审 1：意见一"), f);
  assert.ok(f.includes("评审 2：失败"), "失败行保留序号: " + f);
  assert.ok(f.includes("评审 3：意见三"), f);
  app.dispose();
});

test("/council：全部失败 → 失败提示", async () => {
  const renderer = new FakeRenderer();
  const adapter = new FakeCouncilAdapter();
  adapter.opinions = [undefined, undefined];
  const app = new App({ renderer, adapter });
  app.start();
  typeAndEnter(renderer, "/council");
  await tick();
  await tick();
  const f = frames(renderer);
  assert.ok(f.includes("council 失败"), "全部失败提示: " + f);
  app.dispose();
});
