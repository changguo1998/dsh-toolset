// tests/layout4.test.ts — 四区域布局回归单测
//
// 覆盖：buildFrame 输出四区顺序与尺寸（顶部插件+历史 / 状态区 / 输入区）；
// 顶部高度 = rows - 状态(1) - 输入(1)；turn-end 分隔线；历史按 top 宽换行。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame,
  metricsFor,
  renderStatusLine,
  PLUGIN_WIDTH,
  truncateToWidth,
} from "../src/app/layout.ts";
import { initialState, reduceState, TURN_SEPARATOR } from "../src/app/state.ts";

function frameWith(rows: number, cols: number) {
  let s = initialState();
  s = reduceState(s, {
    type: "status",
    status: { time: "12:00:00", cwd: "/home/u", git: "main" },
  });
  s = reduceState(s, { type: "append", text: "第一行\n第二行内容" });
  const frame = buildFrame(s, { rows, cols });
  return { s, frame };
}

test("metricsFor: 顶部高度 = rows - 状态(1) - 输入(1)；插件固定宽，历史区 = cols - 插件宽", () => {
  const m = metricsFor({ rows: 24, cols: 60 }, false);
  assert.equal(m.topHeight, 22);
  assert.equal(m.statusHeight, 1);
  assert.equal(m.footerHeight, 1);
  assert.equal(m.pluginWidth, PLUGIN_WIDTH);
  assert.equal(m.historyWidth, 60 - PLUGIN_WIDTH);
});

test("buildFrame: 四区顺序与高度正确（顶部插件+历史 / 状态 / 输入）", () => {
  const { frame } = frameWith(24, 60);
  assert.equal(frame.length, 24, "帧恰好铺满 rows");
  // 顶部区域：前 topHeight 行
  const top = frame.slice(0, 22);
  assert.ok(top[0]!.text.startsWith("┌─ plugin"), "首行含插件框顶");
  assert.ok(top[21]!.text.startsWith("└"), "末行含插件框底");
  assert.ok(top[0]!.text.includes("第一行"), "历史区内容在插件右侧");
  // 状态区：第 23 行（topHeight+1）
  const status = frame[22]!;
  assert.ok(status.text.includes("12:00:00"), "状态行含时间");
  assert.ok(status.text.includes("/home/u"), "状态行含当前目录");
  assert.ok(status.text.includes("git main"), "状态行含 git");
  // 输入区：最后一行
  assert.equal(frame[23]!.text, "❯ Type a message…");
});

test("buildFrame: 审批弹窗时 footer 更高，顶部高度相应缩减", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "approval",
    approval: { id: "a1", prompt: "允许?" },
  });
  const m = metricsFor({ rows: 24, cols: 60 }, s.approval !== null);
  assert.equal(m.footerHeight, Math.max(4, Math.floor(24 * 0.3)));
  assert.equal(m.topHeight, 24 - m.statusHeight - m.footerHeight);
  const frame = buildFrame(s, { rows: 24, cols: 60 });
  assert.equal(frame.length, 24);
});

test("turn-end: buffer 末尾追加分隔线；流式内容仍实时合入 buffer", () => {
  let s = initialState();
  s = reduceState(s, { type: "append", text: "hi" });
  s = reduceState(s, { type: "turn-end" });
  assert.equal(s.buffer[s.buffer.length - 1], TURN_SEPARATOR);
  // 流式仍实时合入
  s = reduceState(s, { type: "append", text: " more" });
  assert.equal(s.buffer[s.buffer.length - 1], " more");
});

test("turn-end: 空 buffer 不追加孤立分隔线；重复 turn-end 不重复追加", () => {
  let s = initialState();
  s = reduceState(s, { type: "turn-end" });
  assert.equal(s.buffer.length, 0);
  s = reduceState(s, { type: "append", text: "a" });
  s = reduceState(s, { type: "turn-end" });
  s = reduceState(s, { type: "turn-end" });
  const seps = s.buffer.filter((l) => l === TURN_SEPARATOR).length;
  assert.equal(seps, 1, "重复 turn-end 只保留一条分隔线");
});

test("truncateToWidth: 按显示宽度截断，不切半个 CJK", () => {
  assert.equal(truncateToWidth("中文abc", 4), "中文");
  assert.equal(truncateToWidth("abcdef", 3), "abc");
  assert.equal(truncateToWidth("abc", 0), "");
});

test("renderStatusLine: 超宽截断不抛错", () => {
  const line = renderStatusLine(
    {
      time: "12:00:00",
      cwd: "/very/long/path/that/exceeds/width",
      git: "main *",
      model: "deepseek",
      contextLen: "12345",
      cacheHit: "87%",
    },
    "thinking",
    20,
  );
  assert.ok(line.text.length > 0);
  assert.ok(line.text.length <= 20);
});
