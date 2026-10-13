// tests/small-terminal-warning.test.ts — 启动时终端尺寸过小警告
// （BACKLOG〈启动时终端尺寸过小警告〉）
//
// 覆盖：判据边界（宽 ≤ 16 / 高 ≤ 9；0 = 未知不算过小）；启动即过小 → 首帧出现警告
// （宽 / 高各一）；启动正常 → 不提示；resize 重跑检测（仍过小 → 警告再次出现；
// 已够大 → 不新增警告、最新仍是别的 notice）。

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { App, smallTerminal } from "../src/app/index.ts";
import { FakeAdapter, FakeRenderer } from "./helpers/appFakes.ts";

/** 帧文本（去 ANSI） */
function frame(renderer: FakeRenderer): string {
  return renderer.lastRender.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** 警告文案的短标记：窄终端下全文折行（16 列时逐段断开），故取首段判定 */
const MARK = "终端尺寸";
/** 「别的 notice」文案（/theme 非法参数的 usage 提示；经本地 notice 路径可见） */
const OTHER = "usage: /theme";

function typeAndEnter(renderer: FakeRenderer, text: string): void {
  for (const ch of Array.from(text)) {
    renderer.press({ name: ch, ctrl: false, meta: false, shift: false });
  }
  renderer.press({ name: "enter", ctrl: false, meta: false, shift: false });
}

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.dispose();
});

/** 构造并启动 App（尺寸由 renderer.size 注入；与生产同路径：传 pipelineSink） */
function boot(
  cols: number,
  rows: number,
): { app: App; renderer: FakeRenderer } {
  const renderer = new FakeRenderer();
  renderer.size = { cols, rows };
  const adapter = new FakeAdapter();
  const app = new App({ renderer, adapter, pipelineSink: {} });
  apps.push(app);
  app.start();
  app.flushPaint();
  return { app, renderer };
}

/** 警告在帧里出现的次数（重绘/重新记录会多一条） */
function markCount(f: string): number {
  return f.split(MARK).length - 1;
}

test("判据：宽 ≤ 16 或 高 ≤ 9 为过小，尺寸未知（0）不算过小", () => {
  assert.equal(
    smallTerminal({ cols: 80, rows: 24 }),
    false,
    "常规尺寸不算过小",
  );
  assert.equal(smallTerminal({ cols: 16, rows: 24 }), true, "宽 16 算过小");
  assert.equal(smallTerminal({ cols: 17, rows: 24 }), false, "宽 17 不算过小");
  assert.equal(smallTerminal({ cols: 80, rows: 9 }), true, "高 9 算过小");
  assert.equal(smallTerminal({ cols: 80, rows: 10 }), false, "高 10 不算过小");
  assert.equal(smallTerminal({ cols: 0, rows: 0 }), false, "尺寸未知不误报");
});

test("启动即过小（宽 16）→ 首帧出现警告", () => {
  const { renderer } = boot(16, 24);
  const f = frame(renderer);
  assert.ok(f.includes(MARK), "过小应提示: " + JSON.stringify(f));
});

test("启动即过小（高 9）→ 首帧出现警告", () => {
  const { renderer } = boot(80, 9);
  const f = frame(renderer);
  assert.ok(f.includes(MARK), "过小应提示: " + f);
});

test("启动尺寸正常 → 不提示", () => {
  const { renderer } = boot(80, 24);
  const f = frame(renderer);
  assert.ok(!f.includes(MARK), "正常尺寸不应提示: " + f);
});

test("尺寸未知（0）→ 不提示（按正常处理）", () => {
  const { renderer } = boot(0, 0);
  const f = frame(renderer);
  assert.ok(!f.includes(MARK), "未知尺寸不应提示: " + f);
});

test("resize 仍过小 → 警告再次出现（先被别的 notice 覆盖）", () => {
  const { app, renderer } = boot(80, 24);
  assert.ok(!frame(renderer).includes(MARK), "前置：启动正常无警告");
  typeAndEnter(renderer, "/theme xyz");
  app.flushPaint();
  assert.ok(frame(renderer).includes(OTHER), "前置：别的 notice 已显示");
  assert.ok(!frame(renderer).includes(MARK), "前置：此时仍无警告");
  // 尺寸变化：变过小 → 重跑检测，新记录一条警告
  renderer.size = { cols: 80, rows: 9 };
  renderer.resize(80, 9);
  app.flushPaint();
  const f = frame(renderer);
  assert.ok(f.includes(MARK), "resize 后过小应提示: " + f);
});

test("resize 已够大 → 不新增警告（旧警告记录不清）", () => {
  const { app, renderer } = boot(80, 9);
  assert.equal(markCount(frame(renderer)), 1, "前置：启动过小，警告一条");
  typeAndEnter(renderer, "/theme xyz");
  app.flushPaint();
  assert.ok(frame(renderer).includes(OTHER), "前置：别的 notice 覆盖已生效");
  // 尺寸变化：已够大 → 什么都不做：不新增警告、也不清除已有记录
  renderer.size = { cols: 80, rows: 24 };
  renderer.resize(80, 24);
  app.flushPaint();
  const f = frame(renderer);
  assert.equal(markCount(f), 1, "够大时不应再记录警告: " + f);
  assert.ok(f.includes(OTHER), "最新一条仍是别的 notice: " + f);
});
