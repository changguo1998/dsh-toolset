// tests/layout-cache.test.ts — 排版缓存等价性 + App 合帧语义回归
//
// A. 折行/宽度缓存（TUI_LAYOUT_CACHE / setLayoutCacheEnabled）在同输入下必须与
//    关闭缓存时**逐行一致**：固定语料覆盖 markdown 分支、CJK/emoji/组合符/ANSI/
//    零宽/超长行与非法列宽，再对「固定状态 + 增量追加」逐步比对整帧输出。
// B. paint 合帧：同一 tick 内多次标脏只画一帧；显式冲刷（flushPaint/paintNow）、
//    定时路径（思考打字机，每 tick 一帧）与 dispose 丢弃待处理帧的语义。
//
// 语料确定性：不使用 Math.random（固定种子的线性同余发生器）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/index.ts";
import {
  initialState,
  reduceState,
  type AppState,
  type StateAction,
} from "../src/app/state.ts";
import { buildFrame } from "../src/app/layout.ts";
import {
  clearLayoutCaches,
  setLayoutCacheEnabled,
} from "../src/app/layout/cache.ts";
import { wrapLine } from "../src/app/layout/primitives.ts";
import {
  displayWidth,
  parseInlineMarkdown,
  wrapAssistantLine,
  wrapCodeLine,
  wrapInlineMarkdown,
} from "../src/app/layout/markdown.ts";
import { rowsText } from "./helpers/rowText.ts";
import type { DshAdapter, DshEvent } from "../src/app/adapter/dsh.ts";
import type { KeyEvent, Renderer } from "../src/renderer/index.ts";
import type { FrameRow, Size } from "../src/renderer/screen.ts";
import type { ThemeId } from "../src/renderer/theme.ts";

// ---------- A 部分：缓存开关等价性 ----------

/** 固定种子线性同余发生器（确定性伪随机；禁用 Math.random） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 结构/宽度覆盖语料（markdown 分支 + 宽度边界 + 控制字符） */
const CORPUS: string[] = [
  "",
  "plain ascii line",
  "中文宽度测试：全角标点，混合 ASCII abc 123",
  "# 标题一级",
  "## 标题二级 with **bold** tail",
  "> 引用行 `code` 与 [链接](https://example.com)",
  "- 列表项 with *italic*",
  "1. 有序列表项 ~~删除线~~",
  "- [ ] 未完成任务",
  "- [x] 已完成任务 with **粗体**",
  "---",
  "```ts",
  "const a = 1; // 代码块行",
  "| 表格 | 不支持 |",
  "emoji 👨‍👩‍👧‍👦 与 ZWJ 组合符 e\u0301 ō",
  "\u200b零宽空格开头",
  "\u001b[31mANSI 红字\u001b[0m 与折行",
  "超长行 " + "宽".repeat(200),
  "A".repeat(300),
];

/** 读一次全部折行/宽度出口（theme 影响缓存键，故按主题取样） */
function sampleOutputs(text: string, width: number, themeId: ThemeId) {
  return {
    line: wrapLine(text, width),
    width: displayWidth(text),
    parsed: parseInlineMarkdown(text, themeId),
    inline: wrapInlineMarkdown(text, width, themeId),
    assistant: wrapAssistantLine(text, width, themeId),
    code: wrapCodeLine(text, width),
  };
}

/** 在指定缓存模式下取样（warm=true 时先跑一次预热，命中缓存后再取） */
function sampleWithCache(
  enabled: boolean,
  warm: boolean,
  fn: () => unknown,
): unknown {
  try {
    setLayoutCacheEnabled(enabled);
    clearLayoutCaches();
    if (warm) fn();
    return fn();
  } finally {
    setLayoutCacheEnabled(true);
    clearLayoutCaches();
  }
}

test("折行/宽度缓存：固定语料在开/关两模式逐项一致（含热命中与宽/主题变体）", () => {
  const widths = [0, -3, 1, 7, 40, 84];
  const themes: ThemeId[] = ["dark", "light"];
  for (const text of CORPUS) {
    for (const width of widths) {
      for (const themeId of themes) {
        const compute = () => sampleOutputs(text, width, themeId);
        const off = sampleWithCache(false, false, compute);
        const onCold = sampleWithCache(true, false, compute);
        const onWarm = sampleWithCache(true, true, compute);
        const label = `text=${JSON.stringify(text.slice(0, 24))} w=${width} theme=${themeId}`;
        assert.deepEqual(onCold, off, `冷缓存与关闭缓存不一致：${label}`);
        assert.deepEqual(onWarm, off, `热缓存与关闭缓存不一致：${label}`);
      }
    }
  }
});

test("折行/宽度缓存：随机追加语料逐条一致（确定性种子）", () => {
  const rand = lcg(20260918);
  const pieces = [
    "中",
    "a",
    " ",
    "**x**",
    "`c`",
    "🙂",
    "e\u0301",
    "\n",
    "#",
    "- ",
  ];
  let text = "";
  for (let i = 0; i < 240; i++) {
    text += pieces[Math.floor(rand() * pieces.length)]!;
    const width = 1 + Math.floor(rand() * 60);
    const themeId: ThemeId = rand() < 0.5 ? "dark" : "light";
    const compute = () => sampleOutputs(text, width, themeId);
    const off = sampleWithCache(false, false, compute);
    const onWarm = sampleWithCache(true, true, compute);
    assert.deepEqual(
      onWarm,
      off,
      `随机语料不一致（第 ${i} 次追加, w=${width}, theme=${themeId}）`,
    );
  }
});

/** 固定动作序列：内容/工具/思考/notice/回合边界（覆盖内容区 + 状态列 + footer） */
const FRAME_ACTIONS: StateAction[] = [
  { type: "user-line", text: "给我看一下 TUI 的排版管线" },
  { type: "thinking", text: "先看 buildFrame 与 buildContentRows 的分工" },
  { type: "append", text: "## 结论\n- buildBox 结构分类\n- measure 折行测量" },
  {
    type: "tool-call",
    sessionId: "s1",
    name: "read",
    summary: "src/app/layout.ts",
  },
  { type: "notice", text: "已读取 1 个文件" },
  { type: "append", text: "超长行 " + "宽".repeat(120) },
  { type: "turn-end" },
  { type: "user-line", text: "第二回合：再看缓存" },
  { type: "append", text: '```ts\nconst x = displayWidth(\\"中文\\")\n```' },
  { type: "scroll", delta: -5 },
  { type: "scroll-to-bottom" },
];

test("buildFrame：缓存开/关在固定状态 + 增量追加下逐行一致", () => {
  const size: Size = { cols: 100, rows: 30 };
  // 状态构建与缓存无关：先一次性折叠出每一步的状态快照
  const states: AppState[] = [];
  let s = initialState();
  states.push(s);
  for (const action of FRAME_ACTIONS) {
    s = reduceState(s, action);
    states.push(s);
  }
  for (let i = 1; i < states.length; i++) {
    const snapshot = states[i]!;
    const off = sampleWithCache(false, false, () =>
      rowsText(buildFrame(snapshot, size)),
    );
    const onWarm = sampleWithCache(true, true, () =>
      rowsText(buildFrame(snapshot, size)),
    );
    assert.deepEqual(onWarm, off, `第 ${i} 步整帧不一致`);
  }
});

test("buildFrame：同一状态重复排版在两种模式下都稳定（缓存不产生跨帧污染）", () => {
  const size: Size = { cols: 92, rows: 26 };
  let s = initialState();
  for (const action of FRAME_ACTIONS) s = reduceState(s, action);
  const first = sampleWithCache(true, false, () =>
    rowsText(buildFrame(s, size)),
  );
  const second = sampleWithCache(true, true, () =>
    rowsText(buildFrame(s, size)),
  );
  const third = sampleWithCache(true, true, () =>
    rowsText(buildFrame(s, size)),
  );
  assert.deepEqual(second, first, "热缓存改变了输出");
  assert.deepEqual(third, second, "重复排版不稳定");
});

// ---------- B 部分：paint 合帧 ----------

class FrameRenderer implements Renderer {
  /** 每帧的行文本（渲染顺序快照） */
  frames: string[][] = [];
  keys: KeyEvent[] = [];
  closed = 0;
  size: Size = { cols: 100, rows: 30 };
  themeId: ThemeId = "dark";
  press!: (k: KeyEvent) => void;
  resize!: (cols: number, rows: number) => void;

  render(rows: FrameRow[]): void {
    this.frames.push(rowsText(rows));
  }
  refresh(rows: FrameRow[]): void {
    this.render(rows);
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
  setTheme(id: ThemeId): void {
    this.themeId = id;
  }
  close(): void {
    this.closed++;
  }
  /** 末帧行文本（无帧时为空数组） */
  get last(): string[] {
    return this.frames.at(-1) ?? [];
  }
}

class EventAdapter implements DshAdapter {
  readonly sessionId = "s1";
  cbs: ((e: DshEvent) => void)[] = [];
  disposed = 0;

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
  setSessionModel(sel: { provider: string; model: string }) {
    return Promise.resolve(sel);
  }
  modelEfforts() {
    return Promise.resolve([{ id: "low", name: "low" }]);
  }
  dispose(): void {
    this.disposed++;
  }
}

/** 清空微任务队列（setImmediate 属宏任务，必然晚于本 tick 的全部微任务） */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function key(name: string): KeyEvent {
  return { name, ctrl: false, meta: false, shift: false };
}

function makeApp(): {
  app: App;
  renderer: FrameRenderer;
  adapter: EventAdapter;
} {
  const renderer = new FrameRenderer();
  const adapter = new EventAdapter();
  const app = new App({ renderer, adapter });
  app.start();
  return { app, renderer, adapter };
}

test("合帧：同一 tick 内 200 个事件只画一帧，末帧含最后一个事件", async () => {
  const { renderer, adapter } = makeApp();
  const base = renderer.frames.length; // start() 的首帧（paintNow 同步）
  assert.equal(base, 1, "启动首帧应同步可见");
  for (let i = 0; i < 200; i++) {
    adapter.emit({ type: "notice", text: `合帧行 ${i}` });
  }
  assert.equal(renderer.frames.length, base, "同一 tick 内不应逐事件出帧");
  await drain();
  assert.equal(renderer.frames.length, base + 1, "tick 末尾只应补画一帧");
  assert.ok(
    renderer.last.some((l) => l.includes("合帧行 199")),
    "末帧应包含最后一个事件的内容",
  );
});

test("合帧：flushPaint 同步冲刷、paintNow 立即出帧（供断言/需即时可见路径）", async () => {
  const { app, renderer, adapter } = makeApp();
  const base = renderer.frames.length;
  adapter.emit({ type: "notice", text: "冲刷目标" });
  app.flushPaint();
  assert.equal(renderer.frames.length, base + 1, "flushPaint 应同步出帧");
  assert.ok(
    renderer.last.some((l) => l.includes("冲刷目标")),
    "冲刷后的帧应反映状态",
  );
  adapter.emit({ type: "notice", text: "立即帧" });
  app.paintNow();
  assert.equal(renderer.frames.length, base + 2, "paintNow 应立即出帧");
  assert.ok(renderer.last.some((l) => l.includes("立即帧")));
  await drain();
  assert.equal(renderer.frames.length, base + 2, "已消费的脏帧不应再补画一次");
});

test("合帧：按键交互与事件同 tick 混排只画一帧，冲刷后图标即时可见", async () => {
  const { app, renderer, adapter } = makeApp();
  const base = renderer.frames.length;
  for (const ch of Array.from("hello")) renderer.emitKey(key(ch));
  adapter.emit({ type: "notice", text: "混排 notice" });
  renderer.emitKey(key("!"));
  assert.equal(renderer.frames.length, base, "混排期间不应逐次出帧");
  app.flushPaint();
  const joined = renderer.last.join("\n");
  assert.ok(joined.includes("hello!"), "冲刷后输入区应含全部按键字符");
  await drain();
  assert.equal(renderer.frames.length, base + 1, "同 tick 只应有一帧");
});

test("合帧：绘制期间再次标脏会补画一帧并收敛（不自旋）", async () => {
  const adapter = new EventAdapter();
  const renderer = new FrameRenderer();
  let reentered = false;
  const originalRender = renderer.render.bind(renderer);
  renderer.render = (rows: FrameRow[]): void => {
    originalRender(rows);
    // 在第 2 帧（合帧冲刷那一帧）的绘制过程中再标脏：
    // 应排队补画一帧，而不是丢帧或自旋（帧数不收敛）
    if (!reentered && renderer.frames.length === 2) {
      reentered = true;
      adapter.emit({
        type: "notice",
        text: "渲染中到达的事件",
      });
    }
  };
  const app = new App({ renderer, adapter });
  app.start(); // 帧 1
  adapter.emit({ type: "notice", text: "首个事件" }); // 标脏
  await drain(); // 帧 2（冲刷；其间再标脏）
  assert.equal(renderer.frames.length, 3, "绘制期间标脏应补画一帧");
  assert.ok(
    renderer.last.some((l) => l.includes("渲染中到达的事件")),
    "补画帧应反映绘制期间到达的事件",
  );
  await drain();
  assert.equal(renderer.frames.length, 3, "无新标脏时不应继续出帧");
});

test("合帧：dispose 丢弃待处理帧（不再写终端）", async () => {
  const { app, renderer, adapter } = makeApp();
  const base = renderer.frames.length;
  adapter.emit({ type: "notice", text: "dispose 前的待画帧" });
  app.dispose();
  await drain();
  assert.equal(renderer.frames.length, base, "dispose 后不应再出帧");
  assert.equal(renderer.closed, 1, "renderer.close 应被调用一次");
  assert.equal(adapter.disposed, 1, "adapter.dispose 应被调用一次");
});
