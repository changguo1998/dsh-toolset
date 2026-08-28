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
  THINKING_MAX,
  THINKING_MORE,
  THINKING_PREFIX,
  USER_INDENT,
} from "../src/app/layout.ts";
import { initialState, reduceState, TURN_SEPARATOR } from "../src/app/state.ts";
import type { RenderLine } from "../src/renderer/screen.ts";

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

test("metricsFor: 顶部高度 = rows - 状态(1) - 输入(1) - 分隔行(2)；插件竖线固定宽，历史区 = cols - 插件宽", () => {
  const m = metricsFor({ rows: 24, cols: 60 }, false);
  assert.equal(m.topHeight, 20);
  assert.equal(m.statusHeight, 1);
  assert.equal(m.footerHeight, 1);
  assert.equal(m.pluginWidth, PLUGIN_WIDTH);
  assert.equal(m.historyWidth, 60 - PLUGIN_WIDTH);
});

test("buildFrame: 四区顺序与高度正确（顶部插件竖线+历史 / 分隔线 / 状态 / 分隔线 / 输入）", () => {
  const { frame } = frameWith(24, 60);
  assert.equal(frame.length, 24, "帧恰好铺满 24 行");
  // 主题给边框/分隔线上色后带 ANSI 前缀，先剥离再断言
  const plain = (l: RenderLine) => l.text.replace(/\x1b\[[0-9;]*m/g, "");
  // 顶部区域：前 topHeight 行，每行以竖线开头（无边框无标题）
  const top = frame.slice(0, 20);
  assert.ok(
    top.every((l) => plain(l).startsWith("│ ")),
    "顶部每行含竖线分区",
  );
  assert.ok(top[0]!.text.includes("第一行"), "历史区内容在插件右侧");
  // 横线分隔：20 行后是分隔行，再之后是状态区
  const separator1 = frame[20]!;
  assert.ok(plain(separator1).startsWith("─"), "顶部与状态区之间横线分隔");
  const status = frame[21]!;
  assert.ok(status.text.includes("12:00:00"), "状态行含时间");
  assert.ok(status.text.includes("/home/u"), "状态行含当前目录");
  assert.ok(status.text.includes("main"), "状态行含 git(branch)");
  assert.ok(status.text.includes("|"), "状态行段间用 | 分隔");
  // 第二个横线分隔行，然后输入区
  const separator2 = frame[22]!;
  assert.ok(plain(separator2).startsWith("─"), "状态区与输入区之间横线分隔");
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
  assert.equal(m.topHeight, 24 - m.statusHeight - m.footerHeight - 2);
  const frame = buildFrame(s, { rows: 24, cols: 60 });
  assert.equal(frame.length, 24);
});

test("turn-end: buffer 末尾追加分隔线；流式内容仍实时合入 buffer", () => {
  let s = initialState();
  s = reduceState(s, { type: "append", text: "hi" });
  s = reduceState(s, { type: "turn-end" });
  assert.deepEqual(s.buffer[s.buffer.length - 1], {
    text: TURN_SEPARATOR,
    kind: "separator",
  });
  // 流式仍实时合入
  s = reduceState(s, { type: "append", text: " more" });
  assert.equal(s.buffer[s.buffer.length - 1]?.text, " more");
});

test("turn-end: 空 buffer 不追加孤立分隔线；重复 turn-end 不重复追加", () => {
  let s = initialState();
  s = reduceState(s, { type: "turn-end" });
  assert.equal(s.buffer.length, 0);
  s = reduceState(s, { type: "append", text: "a" });
  s = reduceState(s, { type: "turn-end" });
  s = reduceState(s, { type: "turn-end" });
  const seps = s.buffer.filter((l) => l.kind === "separator").length;
  assert.equal(seps, 1, "重复 turn-end 只保留一条分隔线");
});

test("appendStream 不修改旧 state 的行对象", () => {
  let s = initialState();
  s = reduceState(s, { type: "append", text: "原文" });
  const beforeLine = s.buffer[0];
  const next = reduceState(s, { type: "append", text: "续写" });
  assert.equal(beforeLine?.text, "原文");
  assert.equal(next.buffer[0]?.text, "原文续写");
  assert.notEqual(next.buffer[0], beforeLine);
});

test("truncateToWidth: 按显示宽度截断，不切半个 CJK", () => {
  assert.equal(truncateToWidth("中文abc", 4), "中文");
  assert.equal(truncateToWidth("abcdef", 3), "abc");
  assert.equal(truncateToWidth("abc", 0), "");
});

test("renderStatusLine: model 段 provider 紫色、模型名绿色，路径段染蓝", () => {
  const lines = renderStatusLine(
    {
      time: "10:00",
      cwd: "~/proj",
      git: "main",
      model: "ustc/deepseek-v4-flash:max",
      contextLen: "123",
      cacheHit: "87%",
    },
    "dark",
    80,
  );
  const text = lines.map((l) => l.text).join("\n");
  assert.ok(
    text.includes("\x1b[38;2;199;135;239m"),
    "应有紫色(brightMagenta #C787EF)",
  );
  assert.ok(text.includes("\x1b[38;2;132;231;70m"), "应有绿色(green #84E746)");
  assert.ok(
    text.includes("\x1b[38;2;70;132;231m"),
    "路径段应染蓝(blue #4684E7)",
  );
  assert.ok(text.includes(":max"), "思考等级随行显示");
});

test("renderStatusLine: 超宽溢出到多行，不丢段且每行不超宽", () => {
  const lines = renderStatusLine(
    {
      time: "12:00:00",
      cwd: "/very/long/path/that/exceeds/width",
      git: "main *",
      model: "deepseek",
      contextLen: "12345",
      cacheHit: "87%",
    },
    "dark",
    20,
  );
  assert.ok(lines.length >= 2, "应溢出为多行");
  const joined = lines.map((l) => l.text).join("\n");
  for (const seg of ["12:00:00", "/very/long/path", "deepseek", "87%"]) {
    assert.ok(joined.includes(seg), `段未溢出保留: ${seg}`);
  }
  for (const l of lines) {
    const visible = l.text.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(visible.length <= 20, `行超宽: ${visible}`);
  }
});

test("会话流：用户靠右、模型靠左，用户续行保持右侧缩进", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "user-line",
    text: "用户消息很长用于验证历史区的右侧缩进和续行换行行为这是一段更长的内容",
  });
  s = reduceState(s, { type: "append", text: "模型回答" });
  const top = buildFrame(s, { rows: 10, cols: 40 }).slice(0, 7);
  const plain = (line: RenderLine): string =>
    line.text.replace(/\x1b\[[0-9;]*m/g, "");
  const visible = top.map(plain);
  const userPrefix = "│ " + " ".repeat(USER_INDENT);
  const userRows = visible.filter(
    (line) =>
      line.startsWith(userPrefix) && line.slice(userPrefix.length).trim(),
  );
  assert.ok(userRows.length >= 2, "用户长消息应至少产生两行");
  assert.ok(userRows.every((line) => line.startsWith(userPrefix)));
  assert.ok(
    visible.some(
      (line) => line.includes("模型回答") && line.startsWith("│ 模型"),
    ),
  );
});

test("会话流：思考只显示最新几行，并在正文或 turn-end 后消失", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "thinking",
    text: "t1\nt2\nt3\nt4\nt5\nt6",
  });
  const frame = buildFrame(s, { rows: 12, cols: 60 });
  const thinkingLines = frame.filter((line) =>
    line.text.includes(THINKING_PREFIX),
  );
  assert.ok(thinkingLines.length <= THINKING_MAX);
  assert.ok(frame.some((line) => line.text.includes(THINKING_MORE)));
  assert.ok(frame.some((line) => line.text.includes("t6")));
  assert.ok(!frame.some((line) => line.text.includes("t1")));

  s = reduceState(s, { type: "append", text: "正文" });
  assert.equal(
    s.buffer.some((line) => line.kind === "thinking"),
    false,
  );

  s = reduceState(s, { type: "thinking", text: "残留思考" });
  s = reduceState(s, { type: "turn-end" });
  assert.equal(
    s.buffer.some((line) => line.kind === "thinking"),
    false,
  );
});

test("会话流：窄终端仍保留用户与思考文本", () => {
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "用户" });
  s = reduceState(s, { type: "thinking", text: "思考" });
  const plain = buildFrame(s, { rows: 10, cols: 8 }).map((line) =>
    line.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const narrowJoined = plain.join("");
  assert.ok(narrowJoined.includes("用") && narrowJoined.includes("户"));
  assert.ok(narrowJoined.includes("思") && narrowJoined.includes("考"));
});

test("会话流：cols=2 极限宽度不丢失宽字符", () => {
  const s = reduceState(initialState(), { type: "user-line", text: "中" });
  const plain = buildFrame(s, { rows: 20, cols: 2 }).map((line) =>
    line.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  assert.ok(plain.some((line) => line.includes("中")));
});

test("会话流：turn 分隔线在历史区铺满宽度", () => {
  let s = reduceState(initialState(), { type: "user-line", text: "x" });
  s = reduceState(s, { type: "turn-end" });
  const plain = buildFrame(s, { rows: 10, cols: 20 }).map((line) =>
    line.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some((line) => line.length === 20 && line.includes("─".repeat(18))),
  );
});
