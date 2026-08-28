// tests/layout4.test.ts — 四区域布局回归单测
//
// 覆盖：buildFrame 输出四区顺序与尺寸（顶部插件+历史 / 状态区 / 输入区）；
// 顶部高度 = rows - 状态(1) - 输入(1)；turn-begin 分隔线；历史按 top 宽换行。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame,
  metricsFor,
  renderStatusLine,
  PLUGIN_WIDTH,
  truncateToWidth,
  displayWidth,
  THINKING_MORE,
  USER_MIN_LEFT_GUTTER,
  userMaxBodyWidth,
} from "../src/app/layout.ts";
import {
  initialState,
  reduceState,
  TURN_SEPARATOR,
  DEFAULT_THINKING_MAX_LINES,
} from "../src/app/state.ts";
import type { InputMode, InputStatus } from "../src/app/state.ts";
import type { RenderLine } from "../src/renderer/screen.ts";

/** 去 ANSI 取行文本；思考行无前缀、仅 2 空格缩进（顶部窄条 "│ " 外再多 2 空格） */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const isThinkingRow = (l: { text: string }): boolean =>
  stripAnsi(l.text).startsWith("│   ");

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
  assert.ok(
    plain(frame[23]!).includes("Type a message…"),
    "idle 显示输入占位提示",
  );
});

test("输入栏符号随模式（> ! $ /），颜色随状态（绿/黄/红）", () => {
  const strip = (l: RenderLine): string =>
    l.text.replace(/\x1b\[[0-9;]*m/g, "");
  const sgr = (l: RenderLine): string =>
    /^\x1b\[38;2;\d+;\d+;\d+m/.exec(l.text)?.[0] ?? "";
  const last = (s: ReturnType<typeof initialState>): RenderLine =>
    buildFrame(s, { rows: 10, cols: 40 }).at(-1)!;
  const mk = (mode: InputMode, status: InputStatus) =>
    reduceState(reduceState(initialState(), { type: "input-mode", mode }), {
      type: "input-status",
      status,
    });
  // 符号只受模式影响
  assert.ok(
    strip(last(mk("normal", "success"))).startsWith("> "),
    "normal 显示 >",
  );
  assert.ok(
    strip(last(mk("interrupt", "success"))).startsWith("! "),
    "interrupt 显示 !",
  );
  assert.ok(
    strip(last(mk("shell", "success"))).startsWith("$ "),
    "shell 显示 $",
  );
  assert.ok(
    strip(last(mk("slash", "success"))).startsWith("/ "),
    "slash 显示 /",
  );
  // 颜色三态互异且均着色
  const green = sgr(last(mk("normal", "success")));
  const yellow = sgr(last(mk("normal", "running")));
  const red = sgr(last(mk("normal", "failure")));
  assert.ok(green && yellow && red, "三态前缀均有着色");
  assert.notEqual(green, yellow);
  assert.notEqual(yellow, red);
  // 外部活动（thinking/tool）→ 进行中黄
  const busy = last(
    reduceState(initialState(), { type: "agent-status", status: "thinking" }),
  );
  assert.equal(sgr(busy), yellow, "thinking 视为进行中");
  // 占位提示固定
  assert.ok(
    strip(last(mk("normal", "success"))).includes("Type a message…"),
    "占位提示固定",
  );
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

test("turn-begin: 回合开始时在历史末尾追加分隔线；流式内容仍实时合入 buffer", () => {
  let s = initialState();
  s = reduceState(s, { type: "append", text: "hi" });
  s = reduceState(s, { type: "turn-begin" });
  assert.deepEqual(s.buffer[s.buffer.length - 1], {
    text: TURN_SEPARATOR,
    kind: "separator",
  });
  // 流式仍实时合入
  s = reduceState(s, { type: "append", text: " more" });
  assert.equal(s.buffer[s.buffer.length - 1]?.text, " more");
});

test("turn-begin: 空 buffer 不画孤立分隔线；重复 begin 不重复；turn-end 不画线", () => {
  let s = initialState();
  s = reduceState(s, { type: "turn-begin" });
  assert.equal(s.buffer.length, 0);
  s = reduceState(s, { type: "append", text: "a" });
  s = reduceState(s, { type: "turn-begin" });
  s = reduceState(s, { type: "turn-end" });
  let seps = s.buffer.filter((l) => l.kind === "separator").length;
  assert.equal(seps, 1, "turn-end 不增线，仅 turn-begin 画一条");
  s = reduceState(s, { type: "turn-begin" });
  seps = s.buffer.filter((l) => l.kind === "separator").length;
  assert.equal(seps, 1, "重复 begin 只保留一条分隔线");
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

test("会话流：用户靠右、模型靠左，用户续行保持右侧缩进(块右对齐、内部左对齐)", () => {
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
  // 长消息占满最大正文宽 ⇒ 左边界 = 历史宽 - userMaxBodyWidth
  const hist = 40 - PLUGIN_WIDTH;
  const pad = hist - userMaxBodyWidth(hist);
  assert.equal(pad, USER_MIN_LEFT_GUTTER, "长消息左边界应为 gutter");
  const userPrefix = "│ " + " ".repeat(pad);
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

test("会话流：短用户消息块整体靠右，右缘贴历史区右缘，块内左对齐", () => {
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "你好" });
  const plain = buildFrame(s, { rows: 10, cols: 40 }).map((line) =>
    line.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const row = plain.find((l) => l.includes("你好"))!;
  assert.ok(row.startsWith("│ "), "应在插件竖线右侧");
  assert.equal(displayWidth(row), 40, "短消息整行铺满 ⇒ 右缘贴历史区右缘");
  assert.ok(row.endsWith("你好"), "文本整体靠右");
  assert.equal(
    row.indexOf("你好") + 2,
    row.length,
    "块内结尾即文本(内部左对齐)",
  );
});

test("会话流：用户消息显式换行与软换行共享同一左边界", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "user-line",
    text: "第一行内容\n第二行更长的内容会触发软换行继续向下一行展示直到超出三十六列宽度限制为止",
  });
  const plain = buildFrame(s, { rows: 10, cols: 40 }).map((line) =>
    line.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const rows = plain.filter(
    (l) => l.includes("第一行") || l.includes("第二行") || l.includes("展示"),
  );
  assert.ok(rows.length >= 3, "应至少三行(显式换行 1 + 软换行 2)");
  const indents = rows.map((l) => l.length - l.trimStart().length);
  assert.equal(new Set(indents).size, 1, `所有续行共享同一左边界: ${indents}`);
});

test("会话流：用户块与回答/思考之间恰有一行空行；无回复或紧跟分隔线时不加空行", () => {
  // user → assistant：恰有一行空白
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "问题" });
  s = reduceState(s, { type: "append", text: "答案" });
  let plain = buildFrame(s, { rows: 10, cols: 40 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const ui = plain.findIndex((l) => l.includes("问题"));
  const ai = plain.findIndex((l) => l.includes("答案"));
  assert.ok(ui >= 0 && ai > ui);
  const between = plain.slice(ui + 1, ai);
  assert.equal(between.length, 1, "用户与答案之间应恰有一行");
  assert.equal(
    between[0]!.replace(/^│ /, "").trim(),
    "",
    "该行为空行(仅插件竖线)",
  );
  assert.ok(between[0]!.startsWith("│"), "空行仍保留插件竖线");

  // user → thinking：恰有一行空白
  let t = reduceState(initialState(), { type: "user-line", text: "q" });
  t = reduceState(t, { type: "thinking", text: "思考中" });
  plain = buildFrame(t, { rows: 10, cols: 40 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const ut = plain.findIndex((l) => l.includes("q"));
  const tt = plain.findIndex((l) => l.includes("思考中"));
  assert.ok(ut >= 0 && tt - ut === 2, "user→thinking 之间应恰有一行空白");
  assert.equal(plain[ut + 1]!.replace(/^│ /, "").trim(), "");

  // user → 下回合 begin 分隔线：不加空行
  let u = reduceState(initialState(), { type: "user-line", text: "孤立" });
  u = reduceState(u, { type: "turn-end" });
  u = reduceState(u, { type: "turn-begin" });
  plain = buildFrame(u, { rows: 10, cols: 20 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const uu = plain.findIndex((l) => l.includes("孤立"));
  const nextU = plain[uu + 1] ?? "";
  assert.ok(nextU.includes("─"), "user 后紧跟分隔线，无空行");
});

test("会话流：模型回复尾部空行不显示；正文段落间空行保留", () => {
  // 流式正文块以换行结尾 → appendStream 会留末尾空 assistant 行；
  // 下回合分隔线应紧贴正文末行，不留多余空白
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "问题" });
  s = reduceState(s, { type: "append", text: "第一段\n" });
  s = reduceState(s, { type: "append", text: "第二段\n" });
  s = reduceState(s, { type: "append", text: "第三段\n" });
  s = reduceState(s, { type: "turn-begin" });
  const plain = buildFrame(s, { rows: 12, cols: 40 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const codeIdx = plain.findIndex((l) => l.includes("第三段"));
  // 历史区内的 turn 分隔线带插件竖线前缀；底部全屏横线(┼)不在此列
  const sepIdx = plain.findIndex((l) => l.startsWith("│ ─"));
  assert.ok(codeIdx >= 0 && sepIdx > codeIdx, "正文与分隔线都应存在且顺序正确");
  const gap = plain.slice(codeIdx + 1, sepIdx);
  assert.equal(gap.length, 0, "回复末尾不留空行：正文末行后直接分隔线");

  // 正文段落之间的空行（一段\n\n二段）必须保留
  let p = initialState();
  p = reduceState(p, { type: "append", text: "一段\n\n二段\n" });
  const plainP = buildFrame(p, { rows: 12, cols: 40 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const i1 = plainP.findIndex((l) => l.includes("一段"));
  const i2 = plainP.findIndex((l) => l.includes("二段"));
  assert.ok(i1 >= 0 && i2 > i1);
  assert.equal(i2 - i1, 2, "两段正文之间的空行保留");
});

test("会话流：思考只显示最新几行，并在正文或 turn-end 后消失", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "thinking",
    text: "t1\nt2\nt3\nt4\nt5\nt6",
  });
  const frame = buildFrame(s, { rows: 12, cols: 60 });
  const thinkingLines = frame.filter(isThinkingRow);
  assert.ok(thinkingLines.length <= DEFAULT_THINKING_MAX_LINES);
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

test("thinkingMaxLines 可配置：initialState(opts) 决定折叠阈值", () => {
  const s = initialState("light", { thinkingMaxLines: 2 });
  assert.equal(s.thinkingMaxLines, 2, "state 记录自定义上限");
  const with3 = reduceState(s, { type: "thinking", text: "x1\nx2\nx3" });
  const frame = buildFrame(with3, { rows: 12, cols: 60 });
  const thinking = frame.filter(isThinkingRow);
  // cap=2 且已有 3 行 → 折叠：显示 cap-1 行 + 折叠提示
  assert.ok(thinking.length <= 2, "自定义上限内");
  assert.ok(frame.some((line) => line.text.includes(THINKING_MORE)));
  assert.ok(frame.some((line) => line.text.includes("x3")));
  assert.ok(!frame.some((line) => line.text.includes("x1")));
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

test("交错布局：模型正文右缘保留与用户块左缘对称的空位(gutter)；用户块仍贴右缘", () => {
  const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "");
  // cols=40 → historyWidth=38；USER_MIN_LEFT_GUTTER=4 → 正文宽 34(右留 4)
  let s = initialState();
  s = reduceState(s, {
    type: "append",
    text: "0123456789012345678901234567890123456789", // 40 字符
  });
  const rows = buildFrame(s, { rows: 10, cols: 40 })
    .map((l) => strip(l.text))
    .filter((l) => /[0-9]/.test(l));
  assert.ok(rows.length >= 2, "超 gutter 宽的正文应软换行");
  for (const l of rows) {
    const body = l.replace(/^│ /, "");
    assert.ok(body.length <= 34, `正文行右侧保留 gutter，不顶满右缘: ${l}`);
  }
  const first = rows[0]!.replace(/^│ /, "");
  assert.equal(first.length, 34, "默认 gutter=4：正文宽恰为 38-4");
  // 用户块仍整体靠右(行尾即内容)
  let u = initialState();
  u = reduceState(u, { type: "user-line", text: "hi" });
  const uf = buildFrame(u, { rows: 10, cols: 40 })
    .map((l) => strip(l.text))
    .find((l) => l.includes("hi"));
  assert.ok(uf !== undefined && uf.endsWith("hi"), "用户块贴右缘");
});

test("交错布局：messageGutter 配置生效——gutter=0 时正文顶满历史区右缘", () => {
  const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "");
  let s = initialState(undefined, { messageGutter: 0 });
  s = reduceState(s, {
    type: "append",
    text: "0123456789012345678901234567890123456789", // 40 字符
  });
  const rows = buildFrame(s, { rows: 10, cols: 40 })
    .map((l) => strip(l.text))
    .filter((l) => /[0-9]/.test(l));
  // historyWidth = cols(40) - plugin(2) = 38；gutter=0 → 正文宽 38，顶满右缘
  assert.ok(rows.length >= 2, "40 字符在 38 宽下软换行");
  const body = rows[0]!.replace(/^│ /, "");
  assert.equal(body.length, 38, "gutter=0 时正文顶满历史区宽度");
});

test("markdown 子集：标题/任务列表/引用/分隔线/链接/图片/代码块", () => {
  const lines = [
    "# 一级标题",
    "## 二级 **粗** 标题",
    "- [x] 已完成",
    "- [ ] 未完成",
    "> 引用内容 **加粗**",
    "---",
    "看 [链接文档](https://example.com/x) 和 ![图描述](https://example.com/i.png)",
    "```ts",
    "const a: number = 1; // 注释 **不加粗**",
    "```",
  ];
  // append 为流式合并语义：逐条会粘连成一行，须一次 append 整份多行文本（贴近真实回复）
  let s = initialState();
  s = reduceState(s, { type: "append", text: lines.join("\n") + "\n" });
  const raw = buildFrame(s, { rows: 40, cols: 80 });
  const plain = raw.map((l) => l.text.replace(/\x1b\[[0-9;]*m/g, ""));
  const joined = plain.join("\n");
  // 标题：内容保留、# 前缀消费、行内粗体叠加且有 bold SGR
  assert.ok(joined.includes("一级标题"), "标题内容");
  assert.ok(!joined.includes("# 一级标题"), "# 前缀被消费");
  assert.ok(joined.includes("二级 粗 标题"), "标题内行内粗体");
  assert.ok(
    raw.some(
      (l) => l.text.includes("一级标题") && l.text.includes("\x1b[1m"),
    ),
    "标题 bold 强调",
  );
  // 任务列表：ASCII [x]/[ ]，前缀 - 被消费
  assert.ok(joined.includes("[x] 已完成"), "已完成显示 [x]");
  assert.ok(joined.includes("[ ] 未完成"), "未完成显示 [ ]");
  assert.ok(!joined.includes("- [x]"), "列表前缀被消费");
  // 引用：竖线前缀 + 行内粗体合并
  assert.ok(joined.includes("│ 引用内容 加粗"), "引用带竖线前缀");
  // 分隔线：灰色横线铺满
  assert.ok(plain.some((l) => /^│ ─+$/.test(l)), "分隔线横线");
  // 链接：文本可见、URL 不显示
  assert.ok(joined.includes("链接文档"), "链接文本");
  assert.ok(!joined.includes("example.com/x"), "链接 URL 不显示");
  // 图片：占位 [alt]，URL 不显示
  assert.ok(joined.includes("[图描述]"), "图片 [alt] 占位");
  assert.ok(!joined.includes("i.png"), "图片 URL 不显示");
  // 代码块：fence 不显示、代码原样、语言标签、块内不解析、背景存在
  assert.ok(!joined.includes("```"), "fence 开关行不显示");
  assert.ok(joined.includes("const a: number = 1;"), "代码原样保留");
  assert.ok(joined.includes("**不加粗**"), "fence 内不解析粗体");
  assert.ok(plain.some((l) => l.trim().endsWith("ts")), "语言标签显示");
  assert.ok(raw.some((l) => /\x1b\[48;2;\d+;\d+;\d+m/.test(l.text)), "代码行有背景");
});
