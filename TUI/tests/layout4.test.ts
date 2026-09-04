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

test("metricsFor: 交互区(输入+提示)占 1/5 且至少 2 行；插件竖线固定宽，历史区 = cols - 插件宽", () => {
  // rows=24 → 交互区 = floor(24/5) = 4：输入区 3 + 提示区 1
  const m = metricsFor({ rows: 24, cols: 60 }, false);
  assert.equal(m.footerHeight, 3, "输入区 = 交互区 4 - 提示区 1");
  assert.equal(m.topHeight, 24 - 1 - 3 - 2);
  // 按键提示区独立计入（不进 footerHeight）：输入态 hintRows=1
  const withHint = metricsFor({ rows: 24, cols: 60 }, false, 1, 1);
  assert.equal(withHint.footerHeight, 3);
  assert.equal(withHint.hintHeight, 1);
  // 不足时每区至少 1 行：rows=10 → 交互区 max(2, floor(10/5)) = 2
  const small = metricsFor({ rows: 10, cols: 60 }, false, 1, 1);
  assert.equal(small.footerHeight, 1, "输入区最小 1 行");
  assert.equal(small.hintHeight, 1, "提示区最小 1 行");
  assert.equal(m.pluginWidth, PLUGIN_WIDTH);
  assert.equal(m.historyWidth, 60 - PLUGIN_WIDTH);
});

test("buildFrame: 四区顺序与高度正确（顶部 / 分隔线 / 状态 / 分隔线 / 输入区 3 行 + 按键提示区 1 行）", () => {
  const { frame } = frameWith(24, 60);
  assert.equal(frame.length, 24, "帧恰好铺满 24 行");
  // 主题给边框/分隔线上色后带 ANSI 前缀，先剥离再断言
  const plain = (l: RenderLine) => l.text.replace(/\x1b\[[0-9;]*m/g, "");
  // 顶部区域：前 topHeight=17 行（24 - 状态1 - 输入3 - 提示1 - 分隔2），每行以竖线开头
  const top = frame.slice(0, 17);
  assert.ok(
    top.every((l) => plain(l).startsWith("│ ")),
    "顶部每行含竖线分区",
  );
  assert.ok(top[0]!.text.includes("第一行"), "历史区内容在插件右侧");
  // 横线分隔：17 行后是分隔行，再之后是状态区
  const separator1 = frame[17]!;
  assert.ok(plain(separator1).startsWith("─"), "顶部与状态区之间横线分隔");
  const status = frame[18]!;
  assert.ok(status.text.includes("12:00:00"), "状态行含时间");
  assert.ok(status.text.includes("/home/u"), "状态行含当前目录");
  assert.ok(status.text.includes("main"), "状态行含 git(branch)");
  assert.ok(status.text.includes("|"), "状态行段间用 | 分隔");
  // 第二个横线分隔行，然后输入区（3 行，多行框顶部对齐：首行占位提示）
  const separator2 = frame[19]!;
  assert.ok(plain(separator2).startsWith("─"), "状态区与输入区之间横线分隔");
  assert.ok(
    plain(frame[20]!).includes("Type a message…"),
    "idle 显示输入占位提示（输入区首行）",
  );
  assert.ok(plain(frame[22]!).trim() === "", "输入区第 3 行留空");
  // 按键提示区（独立区域，与输入区之间不画横线）
  assert.ok(plain(frame[23]!).startsWith("[Enter]发送"), "末行为按键提示区");
});

test("输入栏两字符提示符：左=上次提交模式符号+状态色，右=当前模式符号（默认前景色）", () => {
  const strip = (l: RenderLine): string =>
    l.text.replace(/\x1b\[[0-9;]*m/g, "");
  const sgr = (l: RenderLine): string =>
    /^\x1b\[38;2;\d+;\d+;\d+m/.exec(l.text)?.[0] ?? "";
  const last = (s: ReturnType<typeof initialState>): RenderLine =>
    buildFrame(s, { rows: 10, cols: 40 }).at(-2)!; // 输入行（末行是按键提示区，之间不画横线）
  const mk = (
    lastMode: InputMode,
    status: InputStatus,
    curMode: InputMode = "normal",
  ) =>
    reduceState(
      reduceState(
        reduceState(initialState(), {
          type: "last-submit-mode",
          mode: lastMode,
        }),
        { type: "input-status", status },
      ),
      { type: "input-mode", mode: curMode },
    );
  // 左字符=上次提交模式符号，右字符=当前模式符号
  // 左字符=上次提交模式符号，右字符=当前模式符号
  assert.ok(
    strip(last(mk("normal", "success"))).startsWith(">> "),
    "normal 提交成功显示 >> ",
  );
  assert.ok(
    strip(last(mk("shell", "success"))).startsWith("$> "),
    "shell 提交成功显示 $>（左 $ 绿）",
  );
  assert.ok(
    strip(last(mk("slash", "success"))).startsWith("/> "),
    "slash 提交成功显示 /> ",
  );
  assert.ok(
    strip(last(mk("shell", "success", "shell"))).startsWith("$$ "),
    "当前模式 shell 时右字符 $",
  );
  assert.ok(
    strip(last(mk("normal", "running"))).startsWith(">> "),
    "running 左字符仍为上次模式符号",
  );
  assert.ok(
    strip(last(mk("normal", "failure"))).startsWith(">> "),
    "failure 左字符仍为上次模式符号",
  );
  // 左字符 SGR 三态为绿/黄/红且互异
  const green = sgr(last(mk("shell", "success")));
  const yellow = sgr(last(mk("shell", "running")));
  const red = sgr(last(mk("shell", "failure")));
  assert.ok(green && yellow && red, "左字符三态均有着色");
  assert.notEqual(green, yellow);
  assert.notEqual(yellow, red);
  // 结构：SGR + 左符号 + 恢复 SGR + 右符号（右符号前无新 SGR，默认前景色）
  const t = last(mk("shell", "success")).text;
  assert.ok(
    /^(\x1b\[38;2;\d+;\d+;\d+m)(\$)(\x1b\[38;2;\d+;\d+;\d+m)(>)/.test(t),
    "两字符提示符结构：着色 $ + 恢复 + 默认色 >",
  );
  // 外部活动（thinking/tool）→ 进行中黄
  const busy = last(
    reduceState(initialState(), { type: "agent-status", status: "thinking" }),
  );
  assert.equal(sgr(busy), yellow, "thinking 视为进行中");
  assert.ok(strip(busy).startsWith(">> "), "thinking 左字符保持上次模式符号");
  // 占位提示固定
  assert.ok(
    strip(last(mk("normal", "success"))).includes("Type a message…"),
    "占位提示固定",
  );
});

test("buildFrame: 审批弹窗时交互区高度与输入态一致（不上下调整）", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "approval",
    approval: { id: "a1", prompt: "允许?" },
  });
  // 面板占据整个交互区：footer=交互区高度（24 行 → 4），与输入态（输入 3+提示 1）同高
  const m = metricsFor({ rows: 24, cols: 60 }, true);
  assert.equal(m.footerHeight, Math.max(2, Math.floor(24 / 5)));
  assert.equal(
    m.topHeight,
    metricsFor({ rows: 24, cols: 60 }, false, 1, 1).topHeight,
  );
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

test("turn-begin: 新回合清空旧活动区瞬态（工具/notice），仅保留对话与分隔线", () => {
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "问题 1" });
  s = reduceState(s, { type: "thinking", text: "思考 1" });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s",
    name: "bash",
    summary: "cmd 1",
  });
  s = reduceState(s, {
    type: "tool-result",
    sessionId: "s",
    ok: true,
    detail: "ok 1",
  });
  s = reduceState(s, { type: "notice", text: "theme: dark" });
  s = reduceState(s, { type: "turn-end" }); // 回合结束：思考清空，工具/notice 保留
  const transient1 = s.buffer.filter(
    (l) => l.kind === "tool" || l.kind === "notice",
  );
  assert.ok(transient1.length === 3, "turn-end 后工具(⚙+✓)与 notice 仍可见");
  s = reduceState(s, { type: "turn-begin" }); // 新回合：旧活动结果被冲掉
  const kinds = s.buffer.map((l) => l.kind);
  assert.ok(!kinds.includes("tool"), "新回合清空旧工具行");
  assert.ok(!kinds.includes("notice"), "新回合清空旧 notice");
  assert.ok(!kinds.includes("thinking"), "新回合无思考残留");
  assert.ok(kinds.includes("user"), "对话保留");
  assert.equal(
    kinds.filter((k) => k === "separator").length,
    1,
    "新回合带一条分隔线",
  );
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
    "（新会话）",
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
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(visible.includes(":on"), "开启思考并入 model 段（:on 后缀保尾）");
  assert.ok(!visible.includes(":max"), "思考状态以 on/off/none 取代实际等级名");
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
    "（新会话）",
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
  const top = buildFrame(s, { rows: 20, cols: 40 }).slice(0, 7);
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

test("renderStatusLine: 长 cwd 按余宽保尾截断，中等宽度单行容纳", () => {
  const lines = renderStatusLine(
    {
      time: "10:00",
      cwd: "0123456789ABCDEF", // 16 字符，远超窄列余宽
      git: "main",
      model: "deepseek",
      modelThinking: "off", // 支持思考模型但当前未开启
      contextLen: "123",
      cacheHit: "87%",
    },
    "t",
    "dark",
    48,
  );
  assert.equal(
    lines.length,
    1,
    `中等宽度下预算截断应单行容纳 (got ${lines.length} lines)`,
  );
  const visible = lines[0]!.text.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(
    visible.includes("deepseek:off"),
    "支持但未开启并入 model 段显示 off",
  );
  assert.ok(visible.includes("…"), "cwd 过长应出现省略号");
  assert.ok(!visible.includes("0123456789ABCDEF"), "cwd 不应原样整段保留");
  assert.ok(visible.includes("9ABCDEF"), "cwd 截断应保留路径尾部");
  assert.ok(visible.length <= 48, `单行不应超宽: ${visible}`);
});

test("renderStatusLine: 固定预算截断 git/标题（开头+…），稳定段宽度有上限", () => {
  const lines = renderStatusLine(
    {
      time: "10:00",
      cwd: "~/p",
      git: "feature/very-long-branch-name",
      model: "deepseek",
      contextLen: "123",
      cacheHit: "87%",
    },
    "一个非常长的会话标题标题标题标题标题标题标题",
    "dark",
    68,
  );
  // 未做固定预算截断时总宽 ≈ 5+15*2+26 会超过 60 列必然换行；应单行 + 省略号
  assert.equal(
    lines.length,
    1,
    `标题/git 截断后应单行容纳 (got ${lines.length} lines)`,
  );
  const visible = lines
    .map((l) => l.text)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(visible.includes("…"), "git/标题过长应截断");
  assert.ok(
    !visible.includes("feature/very-long-branch-name"),
    "超长分支名不应整段保留",
  );
});

test("renderStatusLine: 宽度足够时各段完整显示不省略号", () => {
  // 回归：宽屏不应因固定预算把 model/标题/git/cwd 截断隐藏
  const cwd = "/home/user/projects/very/long/path/component";
  const lines = renderStatusLine(
    {
      time: "10:00",
      cwd,
      git: "feature/very-long-branch",
      model: "ustc/deepseek-v4-pro:high",
      modelThinking: "high",
      contextLen: "123",
      cacheHit: "87%",
    },
    "一个非常长的会话标题标题标题",
    "dark",
    160,
  );
  assert.equal(lines.length, 1, "宽屏应单行容纳");
  const visible = lines[0]!.text.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(visible.includes("ustc/deepseek-v4-pro:high"), "model 全名完整");
  assert.ok(visible.includes(cwd), "cwd 完整");
  assert.ok(visible.includes("feature/very-long-branch"), "git 完整");
  assert.ok(visible.includes("一个非常长的会话标题"), "标题完整");
  assert.ok(!visible.includes("…"), "宽度足够时不应出现省略号");
});

test("renderStatusLine: 思考后缀 none/off/on/实际等级名", () => {
  // none=不支持；off=支持未开；on=单等级开启；等级名=多等级开启（modelThinking 显式驱动）
  const cases: Array<[string, string]> = [
    ["none", "deepseek:none"],
    ["off", "deepseek:off"],
    ["on", "deepseek:on"],
    ["high", "deepseek:high"],
  ];
  for (const [mt, expect] of cases) {
    const lines = renderStatusLine(
      {
        time: "10:00",
        cwd: "~/p",
        git: "main",
        model: "deepseek",
        modelThinking: mt,
        contextLen: "123",
        cacheHit: "87%",
      },
      "t",
      "dark",
      80,
    );
    const visible = lines
      .map((l) => l.text)
      .join("")
      .replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(
      visible.includes(expect),
      `modelThinking=${mt} 应显示 ${expect} (got ${visible})`,
    );
  }
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
  const plain = buildFrame(s, { rows: 20, cols: 40 }).map((line) =>
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

  // user → thinking：思考归属活动区（分隔线之下展示），不再要求与用户消息间空行
  let t = reduceState(initialState(), { type: "user-line", text: "q" });
  t = reduceState(t, { type: "thinking", text: "思考中" });
  plain = buildFrame(t, { rows: 16, cols: 40 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const tt = plain.findIndex((l) => l.includes("思考中"));
  assert.ok(tt >= 0, "思考应在帧内可见");
  assert.ok(
    plain.slice(0, tt).some((l2) => l2.includes("╌")),
    "思考应位于活动区分隔线之下",
  );

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
  const frame = buildFrame(s, { rows: 16, cols: 60 });
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
  const frame = buildFrame(with3, { rows: 16, cols: 60 });
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
  const plain = buildFrame(s, { rows: 12, cols: 8 }).map((line) =>
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
    raw.some((l) => l.text.includes("一级标题") && l.text.includes("\x1b[1m")),
    "标题 bold 强调",
  );
  // 任务列表：ASCII [x]/[ ]，前缀 - 被消费
  assert.ok(joined.includes("[x] 已完成"), "已完成显示 [x]");
  assert.ok(joined.includes("[ ] 未完成"), "未完成显示 [ ]");
  assert.ok(!joined.includes("- [x]"), "列表前缀被消费");
  // 引用：竖线前缀 + 行内粗体合并
  assert.ok(joined.includes("│ 引用内容 加粗"), "引用带竖线前缀");
  // 分隔线：灰色横线铺满
  assert.ok(
    plain.some((l) => /^│ ─+$/.test(l)),
    "分隔线横线",
  );
  // 链接：文本可见、URL 不显示
  assert.ok(joined.includes("链接文档"), "链接文本");
  assert.ok(!joined.includes("example.com/x"), "链接 URL 不显示");
  // 图片：占位 [alt]，URL 不显示
  assert.ok(joined.includes("[图描述]"), "图片 [alt] 占位");
  assert.ok(joined.includes("i.png"), "图片占位显示 URL");
  // 代码块：fence 不显示、代码原样、语言标签、块内不解析、背景存在
  assert.ok(!joined.includes("```"), "fence 开关行不显示");
  assert.ok(joined.includes("const a: number = 1;"), "代码原样保留");
  assert.ok(joined.includes("**不加粗**"), "fence 内不解析粗体");
  assert.ok(
    plain.some((l) => l.trim().endsWith("ts")),
    "语言标签显示",
  );
  assert.ok(
    raw.some((l) => /\x1b\[48;2;\d+;\d+;\d+m/.test(l.text)),
    "代码行有背景",
  );
});

test("markdown 子集扩展：• 列表/有序列表/任务完成/引用隐藏 >/thinking 不渲染", () => {
  const lines = [
    "- 圆点一",
    "* 圆点二",
    "1. 编号一",
    "- [x] 完成了",
    "- [ ] 未完成",
    "> > 残留引用",
    "**粗** 在 thinking",
  ];
  // append 为流式合并语义：一次 append 整份多行文本（贴近真实回复）
  let s = initialState();
  s = reduceState(s, {
    type: "append",
    text: lines.slice(0, 6).join("\n") + "\n",
  });
  s = reduceState(s, { type: "thinking", text: lines[6]! });
  const raw = buildFrame(s, { rows: 40, cols: 80 });
  const plain = raw.map((l) => l.text.replace(/\x1b\[[0-9;]*m/g, ""));
  const joined = plain.join("\n");
  // 无序列表：-/*/ + 统一 •；有序列表保留数字
  assert.ok(
    joined.includes("• 圆点一") && joined.includes("• 圆点二"),
    "• 圆点",
  );
  assert.ok(!joined.includes("- 圆点一"), "前缀 - 被替换");
  assert.ok(joined.includes("1. 编号一"), "有序列表保留数字");
  // 引用：隐藏正文开头残留的 >，单层竖线渲染
  assert.ok(joined.includes("│ 残留引用"), "引用隐藏残留 >");
  // 已完成任务：灰色删除线 SGR（前缀带 ANSI，先用 strip 后的 plain 定位）
  const doneIdx = plain.findIndex((l) => l.includes("[x] 完成了"));
  assert.ok(doneIdx >= 0, "已完成任务可见");
  assert.ok(raw[doneIdx]!.text.includes("\x1b[9m"), "已完成任务删除线");
  // thinking 保持纯文本（markdown 只作用于最终正文）
  const thinkPlain = plain.find(
    (l) => l.replace(/^│\s*/, "").trim() === "**粗** 在 thinking",
  );
  assert.ok(thinkPlain, "thinking 保持原样");
  const thinkRaw = raw.find((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, "").includes("**粗** 在 thinking"),
  );
  assert.ok(
    thinkRaw && !thinkRaw.text.includes("\x1b[1m"),
    "thinking 不解析 markdown",
  );
});

// ===== 阶段 2：usage 状态栏槽位 + 工具行/notice tone 着色 =====

const baseStatus = {
  time: "10:00",
  cwd: "~/p",
  git: "main",
  model: "deepseek",
  contextLen: "—",
  cacheHit: "—",
};

test("renderStatusLine: 有 usage 显示 ctx/cache，无 usage 保留占位 —", () => {
  const noUsage = renderStatusLine(baseStatus, "（新会话）", "dark", 80);
  assert.ok(
    noUsage
      .map((l) => l.text)
      .join("\n")
      .includes("—"),
    "无 usage 保留占位 —",
  );
  const withUsage = renderStatusLine(baseStatus, "（新会话）", "dark", 80, {
    input: 12000,
    output: 900,
    cacheRead: 24000,
  });
  const t = withUsage.map((l) => l.text).join("\n");
  assert.ok(t.includes("ctx 36k"), `contextLen 段应显示 ctx 36k (got ${t})`);
  assert.ok(t.includes("cache 67%"), "cacheHit 段应显示 cache 67%");
});

test("renderStatusLine: token 缩写 k/M（12.4k / 1.5M），零总量回占位", () => {
  const mid = renderStatusLine(baseStatus, "t", "dark", 120, {
    input: 12400,
    output: 0,
    cacheRead: 0,
  });
  assert.ok(
    mid
      .map((l) => l.text)
      .join("\n")
      .includes("ctx 12.4k"),
  );
  const big = renderStatusLine(baseStatus, "t", "dark", 120, {
    input: 1500000,
    output: 0,
    cacheRead: 0,
  });
  assert.ok(
    big
      .map((l) => l.text)
      .join("\n")
      .includes("ctx 1.5M"),
  );
  const zero = renderStatusLine(baseStatus, "t", "dark", 120, {
    input: 0,
    output: 0,
    cacheRead: 0,
  });
  assert.ok(
    zero
      .map((l) => l.text)
      .join("\n")
      .includes("—"),
    "总量为 0 回占位",
  );
});

test("buildFrame: 工具调用/结果行（⚙/✓/✗，失败着红）", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "ls",
  });
  s = reduceState(s, {
    type: "tool-result",
    sessionId: "s1",
    ok: true,
    detail: "总用量 0",
  });
  s = reduceState(s, {
    type: "tool-result",
    sessionId: "s1",
    ok: false,
    detail: "EACCES: 13",
  });
  const joined = buildFrame(s, { rows: 16, cols: 40 })
    .map((l) => l.text)
    .join("\n");
  const plain = joined.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(plain.includes("⚙ bash ls"), "工具调用行 ⚙ name summary");
  assert.ok(plain.includes("✓ 总用量 0"), "成功结果行 ✓ detail");
  assert.ok(plain.includes("✗ EACCES: 13"), "失败结果行 ✗ detail");
  assert.ok(
    joined.includes("\x1b[38;2;231;70;132m✗ EACCES: 13"),
    "失败工具行着红(231;70;132)",
  );
});

test("buildFrame: notice tone 行在帧内红/黄/灰着色", () => {
  let s = initialState();
  s = reduceState(s, { type: "notice", text: "红", tone: "error" });
  s = reduceState(s, { type: "notice", text: "黄", tone: "warn" });
  s = reduceState(s, { type: "notice", text: "灰", tone: "muted" });
  const joined = buildFrame(s, { rows: 16, cols: 40 })
    .map((l) => l.text)
    .join("\n");
  assert.ok(joined.includes("\x1b[38;2;231;70;132m红"), "error → 红");
  assert.ok(joined.includes("\x1b[38;2;231;169;70m黄"), "warn → 黄");
  assert.ok(joined.includes("\x1b[38;2;120;120;120m灰"), "muted → 灰");
});

test("buildFrame: 工具历史在活动区窗口内只显最近行，窗口内组间仍有空行", () => {
  let s = initialState();
  // 6 次调用组（每次 ⚙ + ✓）：活动区为固定 5 行窗口，只显示最后约 2 组
  for (let i = 1; i <= 6; i++) {
    s = reduceState(s, {
      type: "tool-call",
      sessionId: "s1",
      name: "bash",
      summary: "cmd " + i,
    });
    s = reduceState(s, {
      type: "tool-result",
      sessionId: "s1",
      ok: true,
      detail: "ok " + i,
    });
  }
  const joined = buildFrame(s, { rows: 20, cols: 50 })
    .map((l) => l.text)
    .join("\n");
  const plain = joined.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(plain.includes("cmd 6"), "最新调用应保留在活动区窗口");
  assert.ok(plain.includes("ok 6"), "最新结果应保留");
  assert.ok(plain.includes("cmd 5"), "倒数第二调用应保留");
  assert.ok(!plain.includes("cmd 4"), "更早调用被 5 行窗口裁出");
  assert.ok(!plain.includes("cmd 3"), "更早调用被裁出");
  assert.ok(!plain.includes("cmd 1"), "最早调用不可见");
  assert.ok(!plain.includes("cmd 2"), "第二早调用不可见");
  // 窗口内 cmd5/cmd6 之间仍有空行分隔
  const lines = buildFrame(s, { rows: 20, cols: 50 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const i5 = lines.findIndex((l) => l.includes("cmd 5"));
  const i6 = lines.findIndex((l) => l.includes("cmd 6"));
  assert.ok(i5 >= 0 && i6 > i5, "cmd5/cmd6 均在帧中");
  assert.equal(
    lines.slice(i5, i6).filter((l) => l.replace(/[│\s]/g, "") === "").length,
    1,
    "窗口内组间有 1 个空行",
  );
});

test("buildFrame: 两次调用组之间插空行分隔", () => {
  let s = initialState();
  for (const n of [1, 2]) {
    s = reduceState(s, {
      type: "tool-call",
      sessionId: "s1",
      name: "bash",
      summary: "run " + n,
    });
    s = reduceState(s, {
      type: "tool-result",
      sessionId: "s1",
      ok: true,
      detail: "out " + n,
    });
  }
  const lines = buildFrame(s, { rows: 20, cols: 50 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const i1 = lines.findIndex((l) => l.includes("run 1"));
  const i2 = lines.findIndex((l) => l.includes("run 2"));
  assert.ok(i1 >= 0 && i2 >= 0, "两次调用都应出现");
  assert.equal(
    lines.slice(i1, i2).filter((l) => l.replace(/[│\s]/g, "") === "").length,
    1,
    "两次调用之间应有 1 个空行",
  );
});

test("buildFrame: 工具行前缀/工具名独立着色（⚙ 青、名黄、✓ 绿；✗ 整行红）", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "ls",
  });
  s = reduceState(s, {
    type: "tool-result",
    sessionId: "s1",
    ok: true,
    detail: "ok",
  });
  s = reduceState(s, {
    type: "tool-result",
    sessionId: "s1",
    ok: false,
    detail: "EACCES",
  });
  const joined = buildFrame(s, { rows: 16, cols: 40 })
    .map((l) => l.text)
    .join("\n");
  // dark 主题 24bit 码：青 #46E7A9 / 黄 #E7A946 / 绿 #84E746 / 红 #E74684
  assert.ok(joined.includes("\x1b[38;2;70;231;169m⚙"), "⚙ 前缀着青");
  assert.ok(joined.includes("\x1b[38;2;231;169;70mbash"), "工具名着黄");
  assert.ok(joined.includes("\x1b[38;2;132;231;70m✓"), "✓ 前缀着绿");
  assert.ok(joined.includes("\x1b[38;2;231;70;132m✗ EACCES"), "✗ 失败整行着红");
});

test("buildFrame: usage 入帧 → 状态栏显示 ctx/cache（取代占位 —）", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "usage",
    sessionId: "s1",
    input: 8000,
    output: 200,
    cacheRead: 4000,
  });
  const plain = buildFrame(s, { rows: 6, cols: 60 })
    .map((l) => l.text.replace(/\x1b\[[0-9;]*m/g, ""))
    .join("\n");
  // total=12000 → ctx 12k；cache=4000/12000≈33%
  assert.ok(plain.includes("ctx 12k"), "帧内状态栏应有 ctx 12k");
  assert.ok(plain.includes("cache 33%"), "帧内状态栏应有 cache 33%");
  assert.ok(!plain.includes("ctx —"), "usage 后 contextLen 不再显示占位 —");
});

test("buildFrame: compaction/retry toast 文案入帧", () => {
  let s = initialState();
  s = reduceState(s, { type: "compaction", phase: "start" });
  s = reduceState(s, { type: "compaction", phase: "end" });
  s = reduceState(s, {
    type: "retry",
    attempt: 1,
    max: 2,
    delayMs: 1500,
    code: "TRANSPORT",
    message: "连接被重置",
  });
  const plain = buildFrame(s, { rows: 16, cols: 60 })
    .map((l) => l.text.replace(/\x1b\[[0-9;]*m/g, ""))
    .join("\n");
  assert.ok(plain.includes("正在压缩上下文…"), "start toast");
  assert.ok(plain.includes("压缩完成"), "end toast");
  assert.ok(
    plain.includes("重试 1/2 (1.5s): TRANSPORT 连接被重置"),
    "retry toast 文案",
  );
});

test("renderStatusLine: cache 命中率取整（全命中 → cache 100%）", () => {
  const t = renderStatusLine(baseStatus, "t", "dark", 120, {
    input: 500,
    output: 500,
    cacheRead: 9500,
  })
    .map((l) => l.text)
    .join("\n");
  assert.ok(t.includes("ctx 10k"), "total=10000 → ctx 10k");
  assert.ok(t.includes("cache 95%"), "9500/10000 → cache 95%");
  const full = renderStatusLine(baseStatus, "t", "dark", 120, {
    input: 0,
    output: 100,
    cacheRead: 20000,
  })
    .map((l) => l.text)
    .join("\n");
  assert.ok(full.includes("cache 100%"), "cacheRead 全命中 → cache 100%");
});

test("renderStatusLine: 极窄列(<24 列)省略标题段时 usage ctx/cache 段仍保留", () => {
  const t = renderStatusLine(baseStatus, "（新会话）", "dark", 20, {
    input: 12400,
    output: 0,
    cacheRead: 0,
  })
    .map((l) => l.text)
    .join("\n");
  assert.ok(t.includes("ctx 12.4k"), "窄列下 contextLen 段保留");
  assert.ok(!t.includes("新会话"), "窄列下标题段省略");
});
