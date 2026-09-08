// tests/layout4.test.ts — 四区域布局回归单测
//
// 覆盖：buildFrame 输出四区顺序与尺寸（顶部插件+历史 / 状态区 / 输入区）；
// 顶部高度 = rows - 状态(1) - 输入(1)；turn-begin 分隔线；历史按 top 宽换行。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrame,
  focusFrameColor,
  metricsFor,
  renderStatusLine,
  truncateToWidth,
  displayWidth,
  THINKING_MORE,
  USER_MIN_LEFT_GUTTER,
  userMaxBodyWidth,
} from "../src/app/layout.ts";
import { initialState, reduceState, TURN_SEPARATOR } from "../src/app/state.ts";
import type { InputMode, InputStatus } from "../src/app/state.ts";
import type { RenderLine } from "../src/renderer/screen.ts";

/** 去 ANSI 取行文本 */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** 顶部行历史/活动区正文：取左侧历史区段（跳过 col0 左缘框格，
 *  到 historyWidth-1 宽为止，右侧为详细状态列；按显示宽度定位，兼容 CJK） */
function histBody(line: string, cols: number): string {
  const m = metricsFor({ rows: 24, cols }, false);
  const contentW = m.historyWidth - 1; // 历史正文宽（col0 左缘框格外）
  const s = stripAnsi(line);
  let out = "";
  let w = 0; // 累计显示列（含 col0）
  for (let i = 0; i < s.length; i++) {
    const cw = displayWidth(s[i]!);
    if (w + cw <= 1) {
      w += cw;
      continue;
    } // 仍在 col0 框格内
    if (w >= 1 + contentW) break; // 已到正文段末尾（右侧状态列前）
    out += s[i]!;
    w += cw;
  }
  return out;
}

/** 正文区左侧内容：历史/活动区正文段（不含右侧状态列与分隔竖线） */
function histContent(line: string, cols: number): string {
  return histBody(line, cols).trimEnd();
}

/** 活动区分隔行索引——对话历史 ↔ 流输出边界：左半（历史区正文）全实线 ─；
 *  turn 分隔为虚线 ╌ 不冲突；状态区上方/下方分隔是全宽 ─（更靠后，findIndex
 *  取首个即活动区分隔，故跳过 row0 顶部边框行——history 焦点时它也是 ─ 全） */
function activitySepIdx(lines: string[], cols: number): number {
  return lines.findIndex(
    (l, i) => i >= 1 && /^─+$/.test(histContent(l, cols).trim()),
  );
}

/** 思考行判定：历史区正文以 2 空格缩进开头（活动区瞬态，无 [思考] 前缀）。
 *  内容行补齐到整屏宽后，空白对话行 = 空格 + 右缘框线 │，须排除（trim 后剩 │）。 */
const isThinkingRow = (l: { text: string }, cols: number): boolean => {
  const b = histBody(l.text, cols);
  const t = b.trim();
  return t !== "" && b.startsWith("  ") && !t.endsWith("│");
};

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

test("metricsFor: 交互区(输入+提示)占 1/5 且至少 2 行；历史区 = cols - 状态列", () => {
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
  assert.equal(m.historyWidth, 60 - m.statusColWidth);
  assert.equal(
    m.statusColWidth,
    Math.min(Math.max(1, Math.floor(60 / 3)), Math.max(1, 60 - 10)),
    "状态列窄列约 1/3 且历史区保底 10 列",
  );
});

test("buildFrame: 四区顺序与高度正确（顶部 / 分隔线 / 状态 / 分隔线 / 输入区 3 行 + 按键提示区 1 行）", () => {
  const { frame } = frameWith(24, 60);
  assert.equal(frame.length, 24, "帧恰好铺满 24 行");
  // 主题给边框/分隔线上色后带 ANSI 前缀，先剥离再断言
  const plain = (l: RenderLine) => l.text.replace(/\x1b\[[0-9;]*m/g, "");
  // 顶部区域：前 topHeight=17 行（24 - 状态1 - 输入3 - 提示1 - 分隔2）。
  // 对调后：历史/活动区在左（左缘框格 │）、详细状态列在右（分隔竖线在 D 列）
  const top = frame.slice(0, 17);
  assert.ok(
    top.every((l) => !plain(l).startsWith("│")),
    "默认无焦点：历史/活动区左缘框格空白占位（Tab 后 history 焦点才画 │）",
  );
  assert.ok(
    top.slice(1).every((l) => /[│─╌]/.test(plain(l))),
    "分隔竖线保留（对话区右缘/状态列左缘，内容行均有；活动区分隔行两端的角为 ┘/┐）",
  );
  assert.ok(
    top[1]!.text.includes("第一行"),
    "历史区内容在左侧（顶部边框行之后）",
  );
  // 横线分隔：17 行后是分隔行，再之后状态区（短 cwd 下动态单行：env|LLM 全在一行）
  const separator1 = frame[17]!;
  assert.ok(plain(separator1).startsWith("─"), "状态区上方用 ─ 分隔");
  const status = frame[18]!;
  assert.ok(status.text.includes("12:00:00"), "状态含时间");
  assert.ok(status.text.includes("/home/u"), "状态含当前目录");
  assert.ok(status.text.includes("main"), "状态含 git(branch)");
  // 标题已移入纵向状态列顶部（水平栏不再承载；此处验证水平栏不含标签行）
  assert.ok(!status.text.includes("标题"), "水平状态栏不含标题段");
  assert.ok(status.text.includes("·"), "组内段用 · 分隔");
  assert.ok(status.text.includes("|"), "组间用 | 分隔");
  assert.ok(status.text.includes("none"), "LLM 组含模型思考后缀");
  // 第二个横线分隔行，然后输入区（3 行，多行框顶部对齐：首行占位提示）
  const separator2 = frame[19]!;
  assert.ok(plain(separator2).startsWith("─"), "状态区与输入区之间横线分隔");
  assert.ok(
    plain(frame[20]!).includes("Type a message..."),
    "idle 显示输入占位提示（输入区首行）",
  );
  assert.ok(plain(frame[22]!).trim() === "", "输入区第 3 行留空");
  // 按键提示区（独立区域，与输入区之间不画横线）
  assert.ok(
    plain(frame[23]!).startsWith("[Alt+Enter]打断并发送"),
    "末行为按键提示区",
  );
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
    strip(last(mk("normal", "success"))).includes("Type a message..."),
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
  s = reduceState(s, { type: "activity-scroll", delta: 5 }); // 先上滚活动区
  assert.equal(s.activityScroll, 5, "前置：活动区已上滚 5 行");
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
  s = reduceState(s, { type: "turn-end" }); // 回合结束：思考保留(下回合 begin 才清)，工具/notice 保留
  const transient1 = s.buffer.filter(
    (l) => l.kind === "tool" || l.kind === "notice",
  );
  assert.ok(transient1.length === 3, "turn-end 后工具(*++)与 notice 仍可见");
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
  // 活动区整区被清空（每回合瞬态）：滚动偏移一并归零，新回合回到跟随最新——
  // 不归零则旧偏移超出新内容可视上限，↓ 需连续按到偏移耗尽才恢复（“向下没反应”死区）
  assert.equal(s.activityScroll, 0, "turn-begin 后 activityScroll 归零");
});

test("activityScroll 归零：turn-begin 空 buffer/已有分隔线路径 + clear-buffer", () => {
  // 空 buffer 路径：仍应归零（万一旧 state 残留偏移）
  let s = reduceState(initialState(), { type: "activity-scroll", delta: 3 });
  s = reduceState(s, { type: "turn-begin" });
  assert.equal(s.activityScroll, 0, "空 buffer turn-begin 也归零");
  // 末行已是分隔线路径（上回合转场已画过线）：不重复画线但仍归零
  s = reduceState(initialState(), { type: "activity-scroll", delta: 4 });
  s = reduceState(s, { type: "user-line", text: "q" });
  s = reduceState(s, { type: "turn-begin" }); // 首回合转场画分隔线
  s = reduceState(s, { type: "activity-scroll", delta: 2 });
  assert.equal(s.activityScroll, 2, "前置：再次上滚 2 行");
  s = reduceState(s, { type: "turn-begin" }); // 末行已分隔线：不追加且归零
  const separators = s.buffer.filter((l) => l.kind === "separator").length;
  assert.equal(separators, 1, "末行已分隔线时不重复追加");
  assert.equal(s.activityScroll, 0, "已有分隔线路径同样归零");
  // /cls 清屏：活动区随之清空，偏移归零
  s = reduceState(s, { type: "activity-scroll", delta: 9 });
  s = reduceState(s, { type: "clear-buffer" });
  assert.equal(s.buffer.length, 0, "清屏后 buffer 空");
  assert.equal(s.activityScroll, 0, "clear-buffer 后 activityScroll 归零");
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

test("renderStatusLine: model 段 provider 紫、模型名青，路径段染蓝（无亮色系）", () => {
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
    text.includes("\x1b[38;2;169;70;231m"),
    "应有紫色(magenta #A946E7)",
  );
  assert.ok(text.includes("\x1b[38;2;70;231;169m"), "应有青色(cyan #46E7A9)");
  assert.ok(
    text.includes("\x1b[38;2;70;132;231m"),
    "路径段应染蓝(blue #4684E7)",
  );
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(visible.includes(":on"), "开启思考并入 model 段（:on 后缀保尾）");
  assert.ok(!visible.includes(":max"), "思考状态以 on/off/none 取代实际等级名");
});

test("renderStatusLine: 相邻段颜色不同且不含红/黄/绿状态色", () => {
  const lines = renderStatusLine(
    {
      time: "10:00",
      cwd: "~/proj",
      git: "feature/x",
      model: "deepseek/deepseek-v4-pro:max",
      modelThinking: "max",
      contextLen: "123",
      cacheHit: "87%",
    },
    "dark",
    160,
  );
  assert.equal(lines.length, 1, "宽屏应单行");
  const sgrs = [
    ...lines[0]!.text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g),
  ].map((m) => {
    const h = (n: string): string => Number(n).toString(16).padStart(2, "0");
    return `#${h(m[1]!)}${h(m[2]!)}${h(m[3]!)}`.toUpperCase();
  });
  assert.ok(sgrs.length >= 4, `应有多个着色段: ${sgrs.join(",")}`);
  for (let i = 0; i < sgrs.length - 1; i++) {
    assert.notEqual(sgrs[i], sgrs[i + 1], `相邻段同色: ${sgrs[i]}`);
  }
  for (const c of sgrs) {
    // dark 主题红/黄/绿：#E74684 / #E7A946 / #84E746——状态栏段不使用状态色
    assert.ok(
      !/#E74684|#E7A946|#84E746/.test(c),
      `不应使用状态色(红/黄/绿): ${c}`,
    );
  }
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
  // 极端窄屏：分组折行 + 单组超宽组内压缩（cwd 保尾 / model 保后缀），行不超宽
  assert.ok(lines.length >= 2, "窄屏应折行为多行");
  const joined = lines.map((l) => l.text).join("\n");
  assert.ok(joined.includes("12:00:00"), "时间保留");
  assert.ok(joined.includes("87%"), "缓存命中保留");
  assert.ok(joined.includes(":none"), "model 段思考后缀保尾保留");
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
  const m = metricsFor({ rows: 20, cols: 40 }, false);
  const hist = m.historyWidth;
  const pad = hist - userMaxBodyWidth(hist);
  assert.equal(pad, USER_MIN_LEFT_GUTTER, "长消息左边界应为 gutter");
  // 右侧竖线占 2 列、块整体右对齐 → 左侧可见空位 = gutter - 2
  const userPrefix = " ".repeat(USER_MIN_LEFT_GUTTER - 1);
  const userRows = visible.filter((line) => {
    const body = histBody(line, 40);
    return body.startsWith(userPrefix) && body.slice(userPrefix.length).trim();
  });
  assert.ok(userRows.length >= 2, "用户长消息应至少产生两行");
  assert.ok(
    userRows.every((line) => histBody(line, 40).startsWith(userPrefix)),
  );
  assert.ok(
    visible.some(
      (line) =>
        line.includes("模型回答") && histBody(line, 40).startsWith("┃模型"),
    ),
  );
});

test("renderStatusLine: 长 cwd 按余宽保尾截断，行1 预算内单行容纳", () => {
  const lines = renderStatusLine(
    {
      time: "10:00",
      cwd: "0123456789ABCDEF", // 16 字符，超出窄宽行1 余宽
      git: "main",
      model: "deepseek",
      modelThinking: "off", // 支持思考模型但当前未开启
      contextLen: "123",
      cacheHit: "87%",
    },
    "dark",
    24,
  );
  // 窄屏单组(环境)超行宽 → 组内压缩，cwd 保尾截断；LLM 组折行
  assert.ok(lines.length >= 2, `窄屏应折为多行 (got ${lines.length} lines)`);
  const joined = lines.map((l) => l.text).join("\n");
  const visible = joined.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(
    visible.includes("deepseek:off"),
    "支持但未开启并入 model 段显示 off",
  );
  assert.ok(visible.includes("…"), "cwd 过长应出现省略号");
  assert.ok(!visible.includes("0123456789ABCDEF"), "cwd 不应原样整段保留");
  assert.ok(visible.includes("9ABCDEF"), "cwd 截断应保留路径尾部");
  for (const l of lines) {
    assert.ok(
      l.text.replace(/\x1b\[[0-9;]*m/g, "").length <= 24,
      `行不应超宽: ${l.text}`,
    );
  }
});

test("renderStatusLine: 超长 git 折行完整保留（不截断）", () => {
  const lines = renderStatusLine(
    {
      time: "10:00",
      cwd: "~/p",
      git: "feature/very-long-branch-name",
      model: "deepseek",
      contextLen: "123",
      cacheHit: "87%",
    },
    "dark",
    44,
  );
  // 完整优先：单组放得下就完整显示并折行，不截断内容（标题已移入状态列，不再占水平栏宽度）
  assert.ok(lines.length >= 2, `应折行为多行 (got ${lines.length} lines)`);
  const visible = lines
    .map((l) => l.text)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(
    visible.includes("feature/very-long-branch-name"),
    "超长分支名完整保留",
  );
  for (const l of lines) {
    assert.ok(
      l.text.replace(/\x1b\[[0-9;]*m/g, "").length <= 44,
      `行不应超宽: ${l.text}`,
    );
  }
});

test("renderStatusLine: 宽度足够时各段完整显示不省略号", () => {
  // 回归：宽屏不应因固定预算把 model/git/cwd 截断隐藏
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
    "dark",
    160,
  );
  assert.equal(lines.length, 1, "宽屏完整单行(env|LLM 分组)");
  const visible = lines
    .map((l) => l.text)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(visible.includes("ustc/deepseek-v4-pro:high"), "model 全名完整");
  assert.ok(visible.includes(cwd), "cwd 完整");
  assert.ok(visible.includes("feature/very-long-branch"), "git 完整");
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
  assert.ok(!row.startsWith("|"), "最左侧无插件竖线");
  assert.equal(displayWidth(row), 40, "短消息整行铺满");
  const hc = histContent(row, 40);
  assert.ok(
    hc.trimEnd().endsWith("你好┃"),
    "文本靠右（右缘预留焦点框列；末尾青色竖线）",
  );
  assert.equal(
    hc.trimEnd().indexOf("你好") + 3,
    hc.trimEnd().length,
    "块内结尾即 文本+竖线（内部左对齐、右缘竖线）",
  );
});

test("会话流：用户消息软换行续行共享同一左边界；显式换行另起一个右对齐收缩块", () => {
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
  // 左边界按历史区正文量测（跳过状态列）：appendStream 按 \n 拆出独立块，
  // 每个块各自右对齐（左缘随块宽不同），块内软换行续行共享同一左边界
  const indents = rows.map((l) => {
    const b = histBody(l, 40);
    return b.length - b.trimStart().length;
  });
  assert.equal(
    new Set(indents.slice(1)).size,
    1,
    `软换行续行共享同一左边界: ${indents}`,
  );
});

test("会话流：用户块与回答/思考之间恰有一行空行；无回复或紧跟分隔线时不加空行", () => {
  // user → assistant：恰有一行空白
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "问题" });
  s = reduceState(s, { type: "append", text: "答案" });
  let plain = buildFrame(s, { rows: 13, cols: 40 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const ui = plain.findIndex((l) => l.includes("问题"));
  const ai = plain.findIndex((l) => l.includes("答案"));
  assert.ok(ui >= 0 && ai > ui);
  const between = plain.slice(ui + 1, ai);
  assert.equal(between.length, 1, "用户与答案之间应恰有一行");
  assert.equal(histContent(between[0]!, 40), "", "该行为空行(状态列外无内容)");
  assert.ok(!between[0]!.startsWith("|"), "空行最左侧无插件竖线");

  // user → thinking：思考归属活动区（分隔线之下展示），不再要求与用户消息间空行
  let t = reduceState(initialState(), { type: "user-line", text: "q" });
  t = reduceState(t, { type: "thinking", text: "思考中" });
  plain = buildFrame(t, { rows: 16, cols: 40 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const tt = plain.findIndex((l) => l.includes("思考中"));
  assert.ok(tt >= 0, "思考应在帧内可见");
  assert.ok(
    plain.slice(0, tt).some((l2) => l2.includes("─")),
    "思考应位于活动区实线分隔之下",
  );

  // 活动区分隔线：灰色实线（ANSI 直方）；turn 分隔线灰色虚线；状态栏上 = 下 -
  const graySGR = "\x1b[38;2;";
  const dt = buildFrame(
    reduceState(initialState(), { type: "thinking", text: "x" }),
    {
      rows: 16,
      cols: 40,
    },
  );
  const dotRaw = dt.find((l) => /^─+$/.test(histContent(l.text, 40)));
  assert.ok(dotRaw, "活动区分隔线为实线");
  assert.ok(
    dotRaw!.text.includes(graySGR),
    "活动区分隔线为灰色（含 truecolor SGR）",
  );
  let ts = reduceState(initialState(), { type: "append", text: "正文" });
  ts = reduceState(ts, { type: "turn-begin" });
  const turnRaw = buildFrame(ts, { rows: 10, cols: 40 }).find((l) =>
    /^╌+$/.test(histContent(l.text, 40)),
  );
  assert.ok(turnRaw, "turn 分隔线(虚线)仍在历史区");
  assert.ok(
    turnRaw!.text.includes(graySGR),
    "turn 分隔线为灰色（含 truecolor SGR）",
  );
  const st = buildFrame(
    reduceState(initialState(), { type: "thinking", text: "x" }),
    {
      rows: 16,
      cols: 40,
    },
  ).map((l) => l.text.replace(/\x1b\[[0-9;]*m/g, ""));
  // 标题已移入状态列，水平栏定位改用组间管道符（标题段不再承载）
  const statIdx = st.findIndex((l) => l.includes("|"));
  assert.ok(statIdx > 0, "状态行存在");
  assert.ok(st[statIdx - 1]!.trimStart().startsWith("─"), "状态栏上方 ─ 分隔");
  assert.ok(
    st[statIdx + 1]!.trimStart().startsWith("─"),
    "状态栏下方仍 ─ 分隔",
  );

  // user → 下回合 begin 分隔线：不加空行
  let u = reduceState(initialState(), { type: "user-line", text: "孤立" });
  u = reduceState(u, { type: "turn-end" });
  u = reduceState(u, { type: "turn-begin" });
  plain = buildFrame(u, { rows: 20, cols: 30 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const uu = plain.findIndex((l) => l.includes("孤立"));
  assert.ok(uu >= 0, "user 行需可见（窗口高度合适）");
  const nextU = plain[uu + 1] ?? "";
  assert.ok(nextU.includes("╌"), "user 后紧跟 turn 分隔线(虚线)，无空行");
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
  const plain = buildFrame(s, { rows: 13, cols: 40 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const codeIdx = plain.findIndex((l) => l.includes("第三段"));
  // 历史区内的 turn 分隔线（灰色虚线 ╌）；底部全屏横线不在此列
  // 分隔线行 = 历史区正文全为 `╌`（活动区分隔为全 ─、顶部边框行 i>0 排除，均不冲突）
  const sepIdx = plain.findIndex(
    (l, i) => i > 0 && /^╌+$/.test(histContent(l, 40)),
  );
  assert.ok(codeIdx >= 0 && sepIdx > codeIdx, "正文与分隔线都应存在且顺序正确");
  const gap = plain.slice(codeIdx + 1, sepIdx);
  assert.equal(gap.length, 0, "回复末尾不留空行：正文末行后直接分隔线");

  // 正文段落之间的空行（一段\n\n二段）必须保留
  let p = initialState();
  p = reduceState(p, { type: "append", text: "一段\n\n二段\n" });
  const plainP = buildFrame(p, { rows: 13, cols: 40 }).map((l) =>
    l.text.replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const i1 = plainP.findIndex((l) => l.includes("一段"));
  const i2 = plainP.findIndex((l) => l.includes("二段"));
  assert.ok(i1 >= 0 && i2 > i1);
  assert.equal(i2 - i1, 2, "两段正文之间的空行保留");
});

test("会话流：思考只显示最新几行；正文(输出)到达保留、turn-end 后保留至下回合", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "thinking",
    text: "t1\nt2\nt3\nt4\nt5\nt6",
  });
  const frame = buildFrame(s, { rows: 16, cols: 60 });
  const thinkingLines = frame.filter((l) => isThinkingRow(l, 60));
  // 折叠上限跟随活动区（瞬态显示区）高度：rows=16 → activityH=4
  assert.ok(thinkingLines.length <= 4, "思考最多占满活动区高度");
  assert.ok(frame.some((line) => line.text.includes(THINKING_MORE)));
  assert.ok(frame.some((line) => line.text.includes("t6")));
  assert.ok(!frame.some((line) => line.text.includes("t1")));

  s = reduceState(s, { type: "append", text: "正文" });
  assert.equal(
    s.buffer.some((line) => line.kind === "thinking"),
    true,
    "正文到达后思考仍保留（思考属活动区，正文属历史区）",
  );

  s = reduceState(s, { type: "thinking", text: "残留思考" });
  s = reduceState(s, { type: "turn-end" }); // 输出结束：不立即清空
  assert.equal(
    s.buffer.some((line) => line.kind === "thinking"),
    true,
    "turn-end 后思考保留显示（输出结束后不立即清空）",
  );
  s = reduceState(s, { type: "turn-begin" }); // 下一轮需要进行输出前：统一清空
  assert.equal(
    s.buffer.some((line) => line.kind === "thinking"),
    false,
    "下回合 turn-begin 才清空思考（输出前清空）",
  );
});

test("thinkingMaxLines 可配置：initialState(opts) 决定折叠阈值", () => {
  const s = initialState("light", { thinkingMaxLines: 2 });
  assert.equal(s.thinkingMaxLines, 2, "state 记录自定义上限");
  const with3 = reduceState(s, { type: "thinking", text: "x1\nx2\nx3" });
  const frame = buildFrame(with3, { rows: 16, cols: 60 });
  const thinking = frame.filter((l) => isThinkingRow(l, 60));
  // min(thinkingMaxLines=2, activityH=4)=2 且已有 3 行 → 折叠：显示 cap-1 行 + 折叠提示
  assert.ok(thinking.length <= 2, "自定义上限内");
  assert.ok(frame.some((line) => line.text.includes(THINKING_MORE)));
  assert.ok(frame.some((line) => line.text.includes("x3")));
  assert.ok(!frame.some((line) => line.text.includes("x1")));
});

test("会话流：思考折叠上限=活动区高度（默认），收紧配置仍生效", () => {
  // rows=24 → contentTopH=16 → activityH=8：12 行思考默认折叠为 7 行+MORE，恰好占满活动区
  let s = initialState();
  for (let i = 1; i <= 12; i++) {
    // 两位零填充：避免 "a1" 误匹配前缀 "a12"
    s = reduceState(s, {
      type: "thinking",
      text: `a${String(i).padStart(2, "0")}\n`,
    });
  }
  const frame = buildFrame(s, { rows: 24, cols: 60 });
  const thinking = frame.filter((l) => isThinkingRow(l, 60));
  assert.ok(
    thinking.length <= 8,
    "默认思考最多占满活动区高度（rows=24 → activityH=8），实际:" +
      thinking.length,
  );
  assert.ok(frame.some((line) => line.text.includes(THINKING_MORE)));
  assert.ok(frame.some((line) => line.text.includes("a12")));
  assert.ok(!frame.some((line) => line.text.includes("a01")));

  // 收紧配置 thinkingMaxLines=3 仍生效：即使活动区更高也只显示 3 行
  let t = initialState("light", { thinkingMaxLines: 3 });
  for (let i = 1; i <= 5; i++) {
    t = reduceState(t, { type: "thinking", text: `b${i}\n` });
  }
  const frameT = buildFrame(t, { rows: 24, cols: 60 });
  const thinkingT = frameT.filter((l) => isThinkingRow(l, 60));
  assert.ok(
    thinkingT.length <= 3,
    "收紧配置生效（≤3 行），实际:" + thinkingT.length,
  );
  assert.ok(frameT.some((line) => line.text.includes(THINKING_MORE)));
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
  // cols=40 → historyWidth 依 metricsFor；USER_MIN_LEFT_GUTTER=4 → 正文宽 = hist-4
  const m = metricsFor({ rows: 10, cols: 40 }, false);
  const hist = m.historyWidth;
  const bodyW = hist - USER_MIN_LEFT_GUTTER - 1; // contentW（右缘预留框列）- gutter
  let s = initialState();
  s = reduceState(s, {
    type: "append",
    text: "0123456789012345678901234567890123456789", // 40 字符
  });
  const rows = buildFrame(s, { rows: 11, cols: 40 })
    .map((l) => strip(l.text))
    .filter((l) => /[0-9]/.test(l));
  assert.ok(rows.length >= 2, "超 gutter 宽的正文应软换行");
  for (const l of rows) {
    const body = histContent(l, 40);
    // 助手行含左侧绿色竖线前缀（"│ " 2 列），正文本身仍 ≤ bodyW
    assert.ok(
      body.length <= bodyW + 1,
      `正文行右侧保留 gutter，不顶满右缘: ${l}`,
    );
  }
  const first = histContent(rows[0]!, 40);
  assert.equal(
    first.length,
    bodyW + 1,
    `默认 gutter=4：正文(含左侧竖线)恰为内容区宽-4+2（右缘预留框列）`,
  );
  // 用户块整体靠右（右缘预留焦点框列）
  let u = initialState();
  u = reduceState(u, { type: "user-line", text: "hi" });
  const uf = buildFrame(u, { rows: 11, cols: 40 })
    .map((l) => strip(l.text))
    .find((l) => l.includes("hi"));
  assert.ok(
    uf !== undefined && histContent(uf, 40).endsWith("hi┃"),
    "用户块贴右缘（右缘为青色竖线）",
  );
});

test("交错布局：messageGutter 配置生效——gutter=0 时正文顶满历史区右缘", () => {
  const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "");
  let s = initialState(undefined, { messageGutter: 0 });
  s = reduceState(s, {
    type: "append",
    text: "0123456789012345678901234567890123456789", // 40 字符
  });
  const rows = buildFrame(s, { rows: 11, cols: 40 })
    .map((l) => strip(l.text))
    .filter((l) => /[0-9]/.test(l));
  const m = metricsFor({ rows: 11, cols: 40 }, false);
  const hist = m.historyWidth;
  // gutter=0 → 正文宽 = historyWidth-1（内容区右侧预留焦点框列）
  assert.ok(rows.length >= 2, "40 字符在窄历史宽下软换行");
  const body = histContent(rows[0]!, 40);
  assert.equal(
    body.length,
    hist - 1,
    "gutter=0 时正文顶满内容区宽度（右缘留框列）",
  );
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
  assert.ok(joined.includes("> 引用内容 加粗"), "引用带竖线前缀");
  // 分隔线：灰色横线铺满
  assert.ok(
    plain.some((l) => /^─+$/.test(histContent(l, 80))),
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
    plain.some((l) => histContent(l, 80).trimEnd().endsWith("ts")),
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
  assert.ok(joined.includes("> 残留引用"), "引用隐藏残留 >");
  // 已完成任务：灰色删除线 SGR（前缀带 ANSI，先用 strip 后的 plain 定位）
  const doneIdx = plain.findIndex((l) => l.includes("[x] 完成了"));
  assert.ok(doneIdx >= 0, "已完成任务可见");
  assert.ok(raw[doneIdx]!.text.includes("\x1b[9m"), "已完成任务删除线");
  // thinking 保持纯文本（markdown 只作用于最终正文）
  // thinking 保持纯文本（markdown 只作用于最终正文）
  assert.ok(
    plain.some((l) => l.includes("**粗** 在 thinking")),
    "thinking 保持原样",
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
  const noUsage = renderStatusLine(baseStatus, "dark", 80);
  assert.ok(
    noUsage
      .map((l) => l.text)
      .join("\n")
      .includes("—"),
    "无 usage 保留占位 —",
  );
  const withUsage = renderStatusLine(baseStatus, "dark", 80, {
    input: 12000,
    output: 900,
    cacheRead: 24000,
  });
  const t = withUsage.map((l) => l.text).join("\n");
  assert.ok(t.includes("ctx 36k"), `contextLen 段应显示 ctx 36k (got ${t})`);
  assert.ok(t.includes("cache 67%"), "cacheHit 段应显示 cache 67%");
});

test("renderStatusLine: token 缩写 k/M（12.4k / 1.5M），零总量回占位", () => {
  const mid = renderStatusLine(baseStatus, "dark", 120, {
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
  const big = renderStatusLine(baseStatus, "dark", 120, {
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
  const zero = renderStatusLine(baseStatus, "dark", 120, {
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

test("buildFrame: 工具调用/结果行（*/+/x，失败着红）", () => {
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
  assert.ok(plain.includes("bash ls"), "工具调用行 ○ name summary");
  assert.ok(plain.includes("✓ 总用量 0"), "成功结果行 ✓ detail");
  assert.ok(plain.includes("✗ EACCES: 13"), "失败结果行 ✗ detail");
  assert.ok(
    joined.includes("\x1b[38;2;231;70;132m✗ EACCES: 13"),
    "失败工具行着红(231;70;132)",
  );
});

test("buildFrame: notice tone 行在帧内灰/蓝/黄/红/绿着色", () => {
  let s = initialState();
  s = reduceState(s, { type: "notice", text: "日志", tone: "log" });
  s = reduceState(s, { type: "notice", text: "提示", tone: "info" });
  s = reduceState(s, { type: "notice", text: "黄", tone: "warn" });
  s = reduceState(s, { type: "notice", text: "红", tone: "error" });
  s = reduceState(s, { type: "notice", text: "绿", tone: "success" });
  const joined = buildFrame(s, { rows: 24, cols: 40 })
    .map((l) => l.text)
    .join("\n");
  assert.ok(joined.includes("\x1b[38;2;120;120;120m日志"), "log → 灰");
  assert.ok(joined.includes("\x1b[38;2;70;132;231m提示"), "info → 蓝");
  assert.ok(joined.includes("\x1b[38;2;231;169;70m黄"), "warn → 黄");
  assert.ok(joined.includes("\x1b[38;2;231;70;132m红"), "error → 红");
  assert.ok(joined.includes("\x1b[38;2;132;231;70m绿"), "success → 绿");
});

test("buildFrame: 工具历史在活动区窗口内只显最近行，窗口内组间仍有空行", () => {
  let s = initialState();
  // 6 次调用组（每次 * + +）：活动区为右上区一半（rows=20 → topHeight13 → 6 行），
  // 只显示最后约 2 组（更早的 MORE/cmd1~4 被折叠）
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
  assert.ok(!plain.includes("cmd 4"), "更早调用被活动区窗口裁出");
  assert.ok(!plain.includes("cmd 3"), "再更早调用被裁出");
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
    lines.slice(i5, i6).filter((l) => l.replace(/[│|\s]/g, "") === "").length,
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
    lines.slice(i1, i2).filter((l) => l.replace(/[│|\s]/g, "") === "").length,
    1,
    "两次调用之间应有 1 个空行",
  );
});

test("buildFrame: 工具名（黄）独立着色，结果 ✓ 绿 / ✗ 整行红", () => {
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
  // dark 主题 24bit 码：黄 #E7A946 / 绿 #84E746 / 红 #E74684
  assert.ok(
    joined.includes("\x1b[38;2;231;169;70mbash"),
    "工具名着黄（无前缀图标）",
  );
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
  assert.ok(plain.includes("正在压缩上下文..."), "start toast");
  assert.ok(plain.includes("压缩完成"), "end toast");
  assert.ok(
    plain.includes("重试 1/2 (1.5s): TRANSPORT 连接被重置"),
    "retry toast 文案",
  );
});

test("renderStatusLine: cache 命中率取整（全命中 → cache 100%）", () => {
  const t = renderStatusLine(baseStatus, "dark", 120, {
    input: 500,
    output: 500,
    cacheRead: 9500,
  })
    .map((l) => l.text)
    .join("\n");
  assert.ok(t.includes("ctx 10k"), "total=10000 → ctx 10k");
  assert.ok(t.includes("cache 95%"), "9500/10000 → cache 95%");
  const full = renderStatusLine(baseStatus, "dark", 120, {
    input: 0,
    output: 100,
    cacheRead: 20000,
  })
    .map((l) => l.text)
    .join("\n");
  assert.ok(full.includes("cache 100%"), "cacheRead 全命中 → cache 100%");
});

test("renderStatusLine: 极窄列(<24 列)省略标题段时 usage ctx/cache 段仍保留", () => {
  const t = renderStatusLine(baseStatus, "dark", 20, {
    input: 12400,
    output: 0,
    cacheRead: 0,
  })
    .map((l) => l.text)
    .join("\n");
  assert.ok(t.includes("ctx 12.4k"), "窄列下 contextLen 段保留");
  assert.ok(!t.includes("新会话"), "窄列下标题段省略");

  // --- 会话徽标已整体迁出：plan/sandbox/permission/ask/preset/jobs 移入顶部状态列
  //     Mode 块（见 statusColumnBody/modeBlock），水平状态栏不再承载任何会话徽标 ---

  test("renderStatusLine: 会话徽标已全部移除（已移入顶部状态列 Mode 块；jobs 不再显示）", () => {
    const t = renderStatusLine(baseStatus, "dark", 120, undefined)
      .map((l) => l.text)
      .join("\n");
    for (const bad of [
      "plan",
      "ro·",
      "·full",
      "ask",
      "auto",
      "preset:",
      "jobs ",
    ]) {
      assert.ok(!t.includes(bad), `水平栏不再含徽标「${bad}」(${t})`);
    }
    // 标题段已摘除（移入纵向状态列顶部），水平栏不承载会话标题
    assert.ok(!t.includes("一个非常长的会话"), "水平栏不再含标题");
  });
});

// ===== 顶部三面板焦点与活动区滚动（Tab / activityScroll）=====

test("顶部面板：hint 行为隐藏 Enter/Esc 且不带面板标签；Tab 由 reducer 断言", () => {
  // 100 列：hint 行完整展示（无面板标签后可整体断言）
  const size = { rows: 12, cols: 100 } as const;
  const hintOf = (st: ReturnType<typeof initialState>): string => {
    const line = buildFrame(st, size)
      .map((l) => l.text)
      .find((l) => stripAnsi(l).startsWith("[Alt+Enter]"));
    return stripAnsi(line ?? "");
  };
  const h0 = hintOf(initialState());
  assert.ok(!h0.includes("面板"), "hint 不含面板标签");
  assert.ok(
    !h0.includes("[Enter]") && !h0.includes("[Esc]"),
    "hint 隐藏 Enter/Esc",
  );
  assert.ok(
    h0.includes("[Alt+Enter]") && h0.includes("[Ctrl+L]"),
    "hint 保留 Alt+Enter/Ctrl+L",
  );
  const hCycle = hintOf(
    reduceState(reduceState(initialState(), { type: "focus-panel-cycle" }), {
      type: "focus-panel-cycle",
    }),
  );
  assert.equal(h0, hCycle, "切换焦点不改变 hint 行（无标签）");
});

test("focus-panel-cycle / activity-scroll reducer：循环与偏移非负 clamp", () => {
  let s = reduceState(initialState(), { type: "activity-scroll", delta: -5 });
  assert.equal(s.activityScroll, 0, "下滚到 0 后 clamp");
  s = reduceState(s, { type: "activity-scroll", delta: 3 });
  assert.equal(s.activityScroll, 3);
  assert.equal(s.focusedPanel, null, "默认无焦点（null）");
  assert.equal(
    reduceState(s, { type: "focus-panel-cycle" }).focusedPanel,
    "history",
    "无焦点 → Tab 进入历史",
  );
  const a = reduceState(reduceState(s, { type: "focus-panel-cycle" }), {
    type: "focus-panel-cycle",
  });
  assert.equal(a.focusedPanel, "activity", "history → activity");
  const st = reduceState(
    reduceState(reduceState(s, { type: "focus-panel-cycle" }), {
      type: "focus-panel-cycle",
    }),
    { type: "focus-panel-cycle" },
  );
  assert.equal(st.focusedPanel, "status", "activity → status");
});

test("reduceState: 新输入/输出（内容推进）后焦点自动回 null；UI action 不重置", () => {
  const s = reduceState(initialState(), { type: "focus-panel-cycle" }); // null → 历史
  assert.equal(s.focusedPanel, "history");
  const afterOut = reduceState(s, { type: "append", text: "模型输出" });
  assert.equal(afterOut.focusedPanel, null, "模型输出后自动回无焦点");
  const afterIn = reduceState(
    reduceState(initialState(), { type: "focus-panel-cycle" }),
    { type: "user-line", text: "用户输入" },
  );
  assert.equal(afterIn.focusedPanel, null, "用户输入后自动回无焦点");
  const afterNotice = reduceState(
    reduceState(initialState(), { type: "focus-panel-cycle" }),
    { type: "notice", text: "通知" },
  );
  assert.equal(afterNotice.focusedPanel, null, "notice 后自动回无焦点");
  // UI action（状态列滚动）不重置焦点
  const ui = reduceState(
    reduceState(initialState(), { type: "focus-panel-cycle" }),
    { type: "status-column-scroll", delta: 1 },
  );
  assert.equal(ui.focusedPanel, "history", "UI action 不重置焦点");
});

test("活动区：activityScroll 滚动窗口（默认尾部；上滚看更早；clamp 到顶部）", () => {
  // rows=30 → topHeight=23 → 活动区 11 行；notice 20 行 → maxOffset=9
  const n = 20;
  let s = initialState();
  s = reduceState(s, {
    type: "notice",
    text: Array.from({ length: n }, (_, i) => `行${i}`).join("\n"),
  });
  const body = (scrollDelta: number): string[] => {
    const st =
      scrollDelta === 0
        ? s
        : reduceState(s, { type: "activity-scroll", delta: scrollDelta });
    const plain = buildFrame(st, { rows: 30, cols: 60 }).map((l) => l.text);
    const sep = activitySepIdx(plain, 60);
    // 状态栏上方 ─ 分隔行：D 列交点恒为灰 ┴（无焦点不再延续活动区点线）
    const end = plain.findIndex(
      (l, i) => i > sep && /^[─┴]+$/.test(stripAnsi(l)),
    );
    assert.ok(sep >= 0 && end > sep, "活动区分隔线与状态栏存在");
    return plain
      .slice(sep + 1, end)
      .map((l) => histContent(l, 60))
      .filter((l) => l.trim() !== "");
  };
  // 0（默认尾部）：行9..行19
  let v = body(0);
  assert.equal(v.length, 11);
  assert.equal(v[0], "行9");
  assert.equal(v[v.length - 1]!, "行19");
  // 上滚 5 行：行4..行14
  v = body(5);
  assert.equal(v[0], "行4");
  assert.equal(v[v.length - 1]!, "行14");
  // 上滚 99（clamp 到 maxOffset=9）：行0..行10
  v = body(99);
  assert.equal(v[0], "行0");
  assert.equal(v[v.length - 1]!, "行10");
});

test("焦点面板四边框：白/黑亮色 + 角字；焦点切换/面板态空白占位不重排", () => {
  // dark 主题焦点框=white #FFFFFF（灰→白）；light 主题应取黑（单独断言 focusFrameColor）
  // dark 主题 focusFrameColor="white" → 调色板 #D8D8D8（灰→亮白）
  const WHITE = "\x1b[38;2;216;216;216m";
  const size = { rows: 24, cols: 80 } as const;
  // 对调后：历史/活动区在左（宽 historyWidth=60），详细状态列在右（宽 statusColWidth=20）
  const m = metricsFor(size, false);
  const D = m.historyWidth; // 60：分隔竖线列（历史区右缘/状态列左缘）
  const rowsOf = (st: ReturnType<typeof initialState>): string[] =>
    buildFrame(st, size).map((l) => l.text);
  const plain = (l: string): string => stripAnsi(l);
  const sepRow = (lines: string[]): string => {
    const i = activitySepIdx(lines, size.cols);
    return i >= 0 ? lines[i]! : "";
  };
  const eqRow = (lines: string[]): string =>
    lines.find(
      (l) => /^[└─]+/.test(plain(l)) && !plain(l).includes("（新会话）"),
    )!;
  // 指定显示列字符（按显示宽度定位，兼容 CJK）；越界返回 ""
  const colAt = (line: string, col: number): string => {
    const s = plain(line);
    let w = 0;
    for (let i = 0; i < s.length; i++) {
      if (w === col) return s[i]!;
      w += displayWidth(s[i]!);
      if (w > col) return "";
    }
    return "";
  };
  const topRows = metricsFor(size, false).topHeight;
  const countBrightBar = (raw: string): number =>
    raw.split(WHITE + "│").length - 1;

  // 默认无焦点（null）：三面板全不高亮——顶边/两侧框列空白占位、无亮角
  let st = initialState();
  let rows = rowsOf(st);
  const b0 = rows[0]!;
  assert.ok(!plain(b0).includes("─"), "无焦点：顶部边框行空白（不画 ─）");
  assert.ok(!plain(b0).includes("┌"), "无焦点：顶部无角");
  assert.ok(!b0.includes(WHITE), "无焦点：顶边无亮色");
  const s0 = sepRow(rows);
  assert.ok(!s0.includes(WHITE + "─"), "无焦点：活动区分隔 ╌ 不亮（回灰）");
  const dlg = rows.find((l) => plain(l).includes("（无目标/待办）"))!;
  assert.ok(!plain(dlg).startsWith("│"), "无焦点：左缘框格空白占位");
  assert.ok(colAt(dlg, D) === "│", "无焦点：分隔竖线恒位于 D 列（灰）");
  assert.ok(
    plain(dlg).replace(/\s+$/, "").endsWith("（无目标/待办）"),
    "无焦点：状态列正文在右侧（行尾）",
  );
  assert.ok(!eqRow(rows).includes(WHITE + "─"), "无焦点：状态区上方分隔无亮 ─");
  const sepIdx0 = activitySepIdx(rows, size.cols);
  assert.equal(countBrightBar(rows[sepIdx0 + 1]!), 0, "无焦点：活动行无亮 │");
  assert.ok(
    rows.slice(1, topRows).every((l) => displayWidth(plain(l)) === 80),
    "所有内容行补齐到整屏宽（右缘框线恒在固定列）",
  );
  assert.ok(
    rows.slice(1, sepIdx0).every((l) => colAt(l, D) === "│"),
    "无焦点：对话区各行分隔竖线仍恒位于 D 列（灰）",
  );
  const sigHistory = contentSig(rows, topRows);

  // 焦点=历史（左列）：Tab 一次进入——顶边 ┌─┐、活动区分隔 ─ 亮 + 两端 ┘、对话区左缘/分隔竖线亮 │
  st = reduceState(initialState(), { type: "focus-panel-cycle" }); // null → 历史
  rows = rowsOf(st);
  const bH = rows[0]!;
  assert.ok(plain(bH).includes("─"), "历史焦点：顶部边框行画 ─");
  assert.ok(plain(bH).includes("┌"), "历史焦点：左上角 ┌");
  assert.ok(colAt(bH, D) === "┐", "历史焦点：右上角 ┐（分隔竖线列）");
  assert.ok(bH.includes(WHITE), "历史焦点：顶边/竖线亮白");
  const dlgH = rows.find((l) => plain(l).includes("（无目标/待办）"))!;
  assert.ok(plain(dlgH).startsWith("│"), "历史焦点：最左侧左缘框格 │");
  assert.equal(
    countBrightBar(dlgH),
    2,
    "历史焦点：对话行左缘框格+分隔竖线 2 条亮 │",
  );
  const sH = sepRow(rows);
  assert.ok(sH.includes(WHITE + "─"), "历史焦点：活动区分隔 ─ 亮白");
  assert.ok(plain(sH).includes("┘"), "历史焦点：分隔行两端 ┘");
  assert.equal(
    countBrightBar(rows[sepIdx0 + 1]!),
    0,
    "历史焦点：活动行分隔竖线回灰",
  );

  // 焦点=流输出（左列）：顶边空白、活动区分隔 ─ 亮 + 两端 ┌/┐、活动区左缘/分隔竖线亮 │、─ 亮左段含 └┴（无 ┘）
  st = reduceState(initialState(), { type: "focus-panel-cycle" }); // null → 历史
  st = reduceState(st, { type: "focus-panel-cycle" }); // 历史 → 流输出
  rows = rowsOf(st);
  assert.ok(!plain(rows[0]!).includes("─"), "流输出焦点：顶部不画顶边");
  assert.ok(!plain(rows[0]!).includes("┐"), "流输出焦点：顶部无角");
  const s1 = sepRow(rows);
  assert.ok(s1.includes(WHITE + "─"), "流输出焦点：活动区分隔 ─ 亮白");
  assert.ok(plain(s1).includes("┐"), "流输出焦点：分隔行右端 ┐");
  assert.ok(plain(s1).startsWith("┌"), "流输出焦点：分隔行左端 ┌");
  // 活动区首行（分隔行之后）左缘框格与分隔竖线应亮 │
  const sepIdx1 = activitySepIdx(rows, size.cols);
  const act = rows[sepIdx1 + 1]!;
  assert.ok(plain(act).startsWith("│"), "流输出焦点：活动区左缘框列 │");
  assert.ok(colAt(act, D) === "│", "流输出焦点：活动区右缘分隔竖线 │");
  const dlgA = rows.find((l) => plain(l).includes("（无目标/待办）"))!;
  assert.equal(countBrightBar(dlgA), 0, "流输出焦点：对话行分隔竖线回灰");
  assert.equal(
    countBrightBar(act),
    2,
    "流输出焦点：活动行左缘框列+分隔竖线 2 条亮 │",
  );
  assert.ok(!plain(dlgA).startsWith("│"), "流输出焦点：对话行左缘空白占位");
  const e1 = eqRow(rows);
  assert.ok(e1.includes(WHITE + "─"), "流输出焦点：─ 亮白左段");
  assert.ok(plain(e1).includes("┴"), "流输出焦点：分隔列角 ┴");
  assert.ok(plain(e1).includes("└"), "流输出焦点：历史/活动区底角 └");
  assert.ok(!plain(e1).includes("┘"), "流输出焦点：无状态列右下角 ┘");
  assert.deepEqual(contentSig(rows, topRows), sigHistory, "切换焦点不重排内容");

  // 焦点=状态（右列）：顶边 ┌─┐（D 起）、活动区分隔回灰、─ 亮右段含 ┴┘（无 └）
  st = reduceState(initialState(), { type: "focus-panel-cycle" }); // null → 历史
  st = reduceState(st, { type: "focus-panel-cycle" }); // → 流输出
  st = reduceState(st, { type: "focus-panel-cycle" }); // → 状态
  rows = rowsOf(st);
  const b2 = rows[0]!;
  assert.ok(plain(b2).includes("─"), "状态焦点：顶部右边 ─");
  assert.ok(colAt(b2, D) === "┌", "状态焦点：顶边收角 ┌（分隔竖线列）");
  assert.ok(colAt(b2, 79) === "┐", "状态焦点：右上角 ┐（屏幕右缘）");
  assert.ok(b2.includes(WHITE + "─"), "状态焦点：顶边/竖线亮白");
  assert.ok(!sepRow(rows).includes(WHITE + "─"), "状态焦点：活动区分隔回灰");
  const dlgS = rows.find((l) => plain(l).includes("（无目标/待办）"))!;
  assert.ok(
    !plain(dlgS).startsWith("│"),
    "状态焦点：左缘空白占位（状态列在右）",
  );
  assert.equal(countBrightBar(dlgS), 2, "状态焦点：分隔竖线+右缘框列 2 条亮 │");
  assert.ok(rows[0]!.includes(WHITE + "┌"), "状态焦点：左上角 ┌");
  const e2 = eqRow(rows);
  assert.ok(e2.includes(WHITE + "─"), "状态焦点：─ 右段亮白");
  assert.ok(plain(e2).includes("┴"), "状态焦点：分隔列角 ┴");
  assert.ok(plain(e2).includes("┘"), "状态焦点：状态列右下角 ┘");
  assert.ok(!plain(e2).includes("└"), "状态焦点：无历史/活动区底角 └");
  assert.deepEqual(contentSig(rows, topRows), sigHistory, "状态焦点同样不重排");

  // 面板态（非输入态）：亮色框全回灰、顶边/两侧框列空白占位，内容仍不重排
  st = reduceState(initialState(), {
    type: "picker-open",
    picker: {
      providers: ["deepseek", "ustc"],
      providerIndex: 1,
      providerModels: { deepseek: ["chat", "reasoner"], ustc: ["glm", "mi"] },
      models: ["chat", "reasoner"],
      modelIndex: 1,
      phase: 0,
      efforts: [],
      effortIndex: 0,
      current: { provider: "deepseek", model: "chat", reasoningEffort: "low" },
    },
  });
  rows = rowsOf(st);
  const whole = rows.map(plain).join("\n");
  assert.ok(
    !/\x1b\[38;2;216;216;216m[╌─│┐┘└┌┴]/.test(whole),
    "面板态：无亮白框线",
  );
  assert.ok(!plain(rows[0]!).includes("─"), "面板态：顶部边框行空白占位");
  // 面板态：审批/问答/选择面板自 2026-09-17 起渲染在流输出（活动区）窗口
  // （分隔行之后），而非底部交互区；对话历史/状态列内容不被挤占（无缓冲仍空）
  const sepI2 = activitySepIdx(rows, size.cols);
  const actRows2 = rows.slice(sepI2 + 1, topRows).map(plain);
  assert.ok(
    actRows2.some((l) => l.includes("deepseek")),
    "面板态：模型选择面板显示在流输出窗口",
  );
  assert.ok(
    rows
      .slice(1, sepI2)
      .every((l) => plain(l).slice(1, m.historyWidth).trim() === ""),
    "面板态：对话历史区仍空（未因面板挤占重排）",
  );

  // focusFrameColor：dark=白、light=黑（灰不再彩色化，仅更亮/更黑）
  assert.equal(focusFrameColor("dark"), "white");
  assert.equal(focusFrameColor("light"), "black");
});

/** 顶部面板内容签名：去掉 col0 左缘框格（右侧状态列正文跨焦点/面板态恒定，
 *  不影响签名）+ 框线字符 + 尾部空白，逐行一致 */
function contentSig(lines: string[], topRows: number): string[] {
  return lines
    .slice(1, topRows) // 顶部边框行不计数；footer/状态栏被模态面板接管，不算内容
    .map((l) =>
      stripAnsi(l)
        .slice(1) // 去掉 col0 左缘框格（│ 或空白占位）
        // 右缘框列 `│` 与行内焦点角（活动分隔行右端）删除以跨焦点等长；
        // 其余角/虚线归一化为线段字符（行尾 `┘`=状态栏右下角、`┴`、`╌`→─，
        // 长度不变），焦点差异不计入内容签名
        // ┤ 为活动区分隔行在分隔竖线的连接交点（非线段内容），与 ┐/│ 同理移除
        .replace(/[│┐└┌┤]/g, "")
        .replace(/┘(?=\s)/g, "")
        .replace(/[┘┴╌]/g, "─")
        .replace(/\s+$/, ""),
    );
}

test("对话区：上滚展开折叠历史（offset>0 更早回复可见，跟底时灰占位折叠）", () => {
  let s = initialState();
  // 5 组回复（> DIALOGUE_KEEP_REPLIES=3）：user+assistant交替
  for (let i = 1; i <= 5; i++) {
    s = reduceState(s, { type: "user-line", text: `Q${i}` });
    s = reduceState(s, { type: "append", text: `A${i} 的回复正文` });
  }
  const frame = (st: typeof s): string =>
    buildFrame(st, { rows: 60, cols: 80 })
      .map((l) => l.text)
      .join("\n");
  // 跟随底部：更早回复折叠为灰占位，最早回复不可见
  const joined0 = frame(s);
  assert.ok(joined0.includes("更早回复已折叠"), "跟底时应显示折叠占位");
  assert.ok(!joined0.includes("A1 的回复正文"), "折叠后最早回复不可见");
  // 上滚 1 行：展开全量——更早回复可见、折叠占位消失
  s = reduceState(s, { type: "scroll", delta: 1 });
  const joined1 = frame(s);
  assert.ok(joined1.includes("A1 的回复正文"), "上滚后更早回复可见");
  assert.ok(!joined1.includes("更早回复已折叠"), "上滚中不显示折叠占位");
});
