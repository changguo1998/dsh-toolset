// tests/frame-contract.test.ts — 段级渲染契约（FrameRow/FrameSegment/segStyle）
//
// 主线 A 提交 1：新增段级序列化纯函数（segStyle/serializeFrameRow）与
// Frame 契约类型的单测。旧 RenderLine API 仍并存，本文件只测新契约。
// 覆盖：单段序列化、相邻同 style 合并、未知名色名回退基底、bold/italic/underline/strike、
// "#hex" 直接使用、code 槽位映射、行尾 SGR 重置。

import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES } from "../src/renderer/theme.ts";
import {
  segStyle,
  serializeFrameRow,
  type FrameRow,
} from "../src/renderer/screen.ts";

const dark = THEMES["dark"];

test("segStyle：无样式仅返回文本", () => {
  assert.equal(segStyle({ text: "hi" }, dark), "hi");
  assert.equal(segStyle({ text: "hi", style: {} }, dark), "hi");
});

test("segStyle：bold 段 open 1m + text + close 22m", () => {
  assert.equal(
    segStyle({ text: "B", style: { bold: true } }, dark),
    "\x1b[1mB\x1b[22m",
  );
});

test("segStyle：fg 色名 → hex SGR，恢复主题基底前景", () => {
  assert.equal(
    segStyle({ text: "x", style: { fg: "blue" } }, dark),
    `\x1b[38;2;90;152;243mx\x1b[38;2;201;220;222m`,
  );
});

test("segStyle：未知名色名回退基底（不输出 SGR，仅文本）", () => {
  // @ts-expect-error 未知名色名仅测试回退
  assert.equal(segStyle({ text: "x", style: { fg: "notacolor" } }, dark), "x");
});

test("segStyle：'#hex' 直接使用", () => {
  assert.equal(
    segStyle({ text: "x", style: { fg: "#112233" } }, dark),
    "\x1b[38;2;17;34;51mx\x1b[38;2;201;220;222m",
  );
});

test("segStyle：code 槽位背景映射（dark=ansi[0] #272336）", () => {
  assert.equal(
    segStyle({ text: "c", style: { bg: "code" } }, dark),
    "\x1b[48;2;39;35;54mc\x1b[48;2;10;17;39m",
  );
});

test("serializeFrameRow：相邻同 style 合并（只输出一次前缀）", () => {
  const row: FrameRow = {
    segments: [
      { text: "ab", style: { fg: "red" } },
      { text: "cd", style: { fg: "red" } },
    ],
  };
  const out = serializeFrameRow(row, dark);
  // 仅一次 open，文本拼接，行尾一次 close
  assert.equal(out, `\x1b[38;2;253;0;19mabcd\x1b[38;2;201;220;222m`);
});

test("serializeFrameRow：不同 style 段各自开/闭", () => {
  const row: FrameRow = {
    segments: [
      { text: "a", style: { bold: true } },
      { text: "b" },
      { text: "c", style: { fg: "blue", underline: true } },
    ],
  };
  const out = serializeFrameRow(row, dark);
  assert.ok(out.includes("\x1b[1ma\x1b[22m"), "bold 段独立开闭");
  assert.ok(out.includes("b"), "无样式段原样");
  assert.equal(
    segStyle({ text: "c", style: { fg: "blue", underline: true } }, dark),
    "\x1b[4m\x1b[38;2;90;152;243mc\x1b[38;2;201;220;222m\x1b[24m",
  );
  assert.ok(
    out.endsWith("\x1b[38;2;201;220;222m\x1b[24m"),
    "行尾关闭最后一个 styled 段（close 逆序）",
  );
});

test("serializeFrameRow：全无样式行 = 纯文本拼接", () => {
  const row: FrameRow = {
    segments: [{ text: "a" }, { text: "b" }, { text: "c" }],
  };
  assert.equal(serializeFrameRow(row, dark), "abc");
});

test("serializeFrameRow：italic/underline/strike 组合", () => {
  const row: FrameRow = {
    segments: [
      { text: "i", style: { italic: true } },
      { text: "u", style: { underline: true } },
      { text: "s", style: { strike: true } },
    ],
  };
  const out = serializeFrameRow(row, dark);
  assert.ok(out.startsWith("\x1b[3mi\x1b[23m"));
  assert.ok(out.includes("u\x1b[24m"));
  assert.ok(out.endsWith("\x1b[29m"));
});
