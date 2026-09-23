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
  USER_MIN_LEFT_GUTTER,
  userMaxBodyWidth,
  TITLE_BAR_ROWS,
  dialogueHalfPage,
  frameGeometry,
  userInputJump,
  DIALOGUE_KEEP_REPLIES,
  anchorToIndex,
  dialogueSpans,
  indexToAnchor,
  FRAME_LEFT_COLS,
  emptyRunVirt,
  nextRunVirt,
  TOKEN_CALIB_MAX,
  virtTick,
  VIRT_SLEW_RATE,
  VIRT_SPEED_MAX,
  VIRT_SPEED_MIN,
  type FrameScrollReport,
} from "../src/app/layout.ts";
import { initialState, reduceState, TURN_SEPARATOR } from "../src/app/state.ts";
import { wrapAssistantLine } from "../src/app/layout/markdown.ts";
import { buildContentRows } from "../src/app/layout/build-box.ts";
import type { InputMode, InputStatus, Buffer } from "../src/app/state.ts";
import type { FrameRow } from "../src/renderer/screen.ts";
import { rowAnsi, rowText } from "./helpers/rowText.ts";

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
 *  取首个即活动区分隔，故跳过 row0 顶部边框行与标题栏分隔行（history 焦点时
 *  顶部边框行也是 ─ 全；标题栏下划线在 index TITLE_BAR_ROWS=2，24/30 行终端
 *  标题栏恒为 2 行，下划线行亦为全 ─） */
function activitySepIdx(lines: string[], cols: number): number {
  return lines.findIndex(
    (l, i) => i > TITLE_BAR_ROWS && /^─+$/.test(histContent(l, cols).trim()),
  );
}

/** 思考行判定：历史区正文以 2 空格缩进开头（活动区瞬态，无 [思考] 前缀）。
 *  内容行补齐到整屏宽后，空白对话行 = 空格 + 右缘框线 │，须排除（trim 后剩 │）。 */
const isThinkingRow = (l: FrameRow, cols: number): boolean => {
  const b = histBody(rowText(l), cols);
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
  // 回合结束标记最终总结 → 历史区展示（流式中 assistant 在活动区）
  s = reduceState(s, { type: "turn-end" });
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
    Math.min(Math.max(20, Math.floor(60 / 3)), Math.max(1, 60 - 10)),
    "状态列窄列约 1/3 且最低 20 列、历史区保底 10 列",
  );
});

test("buildFrame: 四区顺序与高度正确（顶部 / 分隔线 / 状态 / 分隔线 / 输入区 3 行 + 按键提示区 1 行）", () => {
  const { frame } = frameWith(24, 60);
  assert.equal(frame.length, 24, "帧恰好铺满 24 行");
  // 主题给边框/分隔线上色后带 ANSI 前缀，先剥离再断言
  const plain = (l: FrameRow) => rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, "");
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
  // 标题栏即顶部（无独立顶部边框行）：title 占位 + 实线下划线，历史区内容在其后
  assert.ok(
    rowAnsi(top[0]!).includes("<title>"),
    "顶部首行为标题栏（会话标题占位）",
  );
  assert.ok(
    /^─+$/.test(histContent(rowAnsi(top[1]!), 60)),
    "标题栏下为实线下划线",
  );
  assert.ok(
    rowAnsi(top[2]!).includes("第一行"),
    "历史区内容在左侧（标题栏之后）",
  );
  // 横线分隔：17 行后是分隔行，再之后状态区（短 cwd 下动态单行：env|LLM 全在一行）
  const separator1 = frame[17]!;
  assert.ok(plain(separator1).startsWith("─"), "状态区上方用 ─ 分隔");
  const status = frame[18]!;
  assert.ok(rowAnsi(status).includes("12:00:00"), "状态含时间");
  assert.ok(rowAnsi(status).includes("/home/u"), "状态含当前目录");
  assert.ok(rowAnsi(status).includes("main"), "状态含 git(branch)");
  // 标题已移入纵向状态列顶部（水平栏不再承载；此处验证水平栏不含标签行）
  assert.ok(!rowAnsi(status).includes("标题"), "水平状态栏不含标题段");
  assert.ok(rowAnsi(status).includes("·"), "组内段用 · 分隔");
  assert.ok(rowAnsi(status).includes("│"), "组间用框线 │ 分隔");
  assert.ok(rowAnsi(status).includes("none"), "LLM 组含模型思考后缀");
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

test("输入栏单字符提示符：当前模式符号（默认前景色）；状态符号移至水平状态栏最左侧", () => {
  const strip = (l: FrameRow): string =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, "");
  const sgr = (l: FrameRow): string =>
    /\x1b\[38;2;\d+;\d+;\d+m/.exec(rowAnsi(l))?.[0] ?? ""; // 行内首个 SGR（行首为前导空格）
  const inputRow = (s: ReturnType<typeof initialState>): FrameRow =>
    buildFrame(s, { rows: 10, cols: 40 }).at(-2)!; // 输入行（末行是按键提示区，之间不画横线）
  const statusRow = (s: ReturnType<typeof initialState>): FrameRow =>
    buildFrame(s, { rows: 24, cols: 60 })[18]!; // 状态栏行（状态区上方分隔线后首行）
  const mk = (curMode: InputMode, status: InputStatus) =>
    reduceState(
      reduceState(initialState(), { type: "input-mode", mode: curMode }),
      { type: "input-status", status },
    );
  // 单字符提示符 = 当前输入模式符号；状态色不着色（状态符号已移至状态栏）
  assert.ok(
    strip(inputRow(mk("normal", "success"))).startsWith("> "),
    "normal 模式提示符 > ",
  );
  assert.ok(
    strip(inputRow(mk("shell", "success"))).startsWith("$ "),
    "shell 模式提示符 $ ",
  );
  assert.ok(
    strip(inputRow(mk("slash", "success"))).startsWith("/ "),
    "slash 模式提示符 / ",
  );
  assert.equal(
    sgr(inputRow(mk("shell", "success"))),
    "",
    "提示符不着色（默认前景色，状态色在状态栏）",
  );
  // 占位提示固定
  assert.ok(
    strip(inputRow(mk("normal", "success"))).includes("Type a message..."),
    "占位提示固定",
  );

  // 状态符号在水平状态栏最左侧：四态符号 + 初始占位
  const mark = (status: InputStatus): { sym: string; sgr: string } => {
    const l = statusRow(mk("normal", status));
    return { sym: strip(l).trimStart()[0] ?? "", sgr: sgr(l) };
  };
  assert.equal(mark("success").sym, "✓", "成功 = 勾");
  assert.equal(mark("failure").sym, "✗", "失败 = 叉");
  assert.equal(mark("running").sym, "●", "运行中 = 实心圆（相位 0）");
  assert.equal(mark("waiting").sym, "△", "等待交互 = 空心三角");
  assert.equal(mark("idle").sym, "?", "回退/未知占位 = 问号");
  // 着色：成功绿 / 失败红 / 运行中黄 / 等待交互黄 / 回退占位默认前景
  const green = mark("success").sgr;
  const red = mark("failure").sgr;
  const yellow = mark("running").sgr;
  assert.ok(green, "成功符号为绿");
  assert.ok(red, "失败符号为红");
  assert.ok(yellow, "运行中符号为黄");
  assert.notEqual(green, red, "绿红互异");
  assert.notEqual(red, yellow, "红黄互异");
  assert.equal(yellow, mark("waiting").sgr, "等待交互与运行中同为黄");
  // 回退占位 ? 不着色：行内首个 SGR（边框竖线）非任何状态色；符号+竖线结构齐全
  const idleRow = strip(statusRow(mk("normal", "idle")));
  assert.ok(idleRow.includes("? │ "), "回退占位后接边框色竖线");
  assert.notEqual(mark("idle").sgr, green, "回退占位无绿");
  assert.notEqual(mark("idle").sgr, red, "回退占位无红");
  assert.notEqual(mark("idle").sgr, yellow, "回退占位无黄");
  // 外部活动（thinking/tool）→ 运行中黄●（相位 0）
  const busy = statusRow(
    reduceState(initialState(), { type: "agent-status", status: "thinking" }),
  );
  assert.equal(sgr(busy), yellow, "thinking 视为运行中");
  assert.equal(strip(busy).trimStart()[0], "●", "thinking 显示运行中实心圆");
  // 运行中符号按虚拟总 token 交替（与真实 tps 解耦）：
  // 虚拟速度 = 窗口速率估计 → 速率化 slew → clamp [MIN,MAX]；虚拟总 token = ∫虚拟速度 dt；
  // 首帧无时间基准不积分（相位 0）；速度为界内起点 MIN。
  const ascii = (chars: number): string => "x".repeat(chars);
  const busyAt = (evs: { t: number; text: string }[]): string => {
    let s = reduceState(initialState(), {
      type: "agent-status",
      status: "thinking",
    });
    for (const ev of evs)
      s = reduceState(s, { type: "append", text: ev.text, time: ev.t });
    return strip(statusRow(s)).trimStart()[0] ?? "";
  };
  assert.equal(
    busyAt([{ t: 1000, text: ascii(64) }]),
    "●",
    "首帧无时间基准不积分 = 实心圆",
  );
  // 高速率/低速率/思考流：循环推进直到相位翻转（帧数不写死，随频率参数自适应）
  const runUntilFlip = (
    kind: "append" | "thinking",
    stepMs: number,
    text: string,
  ): { sym: string; frames: number } => {
    let s = reduceState(initialState(), {
      type: "agent-status",
      status: "thinking",
    });
    for (let i = 1; i <= 80; i++) {
      s = reduceState(s, { type: kind, text, time: 1000 + i * stepMs });
      const sym = strip(statusRow(s)).trimStart()[0] ?? "";
      if (sym === "○") return { sym, frames: i };
    }
    return { sym: strip(statusRow(s)).trimStart()[0] ?? "", frames: 80 };
  };
  // 高速率（每 0.05s 64 字符 ≈ 320 token/s）：速度爬到上限，虚拟 token 跨阈值
  const fastFlip = runUntilFlip("append", 50, ascii(64));
  assert.equal(
    fastFlip.sym,
    "○",
    `高速率最终切换空心圆（${fastFlip.frames} 帧）`,
  );
  // 低速率（每 0.5s 16 汉字 ≈ 32 token/s）：下限速度兜底仍能切换
  const slowFlip = runUntilFlip("append", 500, "中".repeat(16));
  assert.equal(
    slowFlip.sym,
    "○",
    `低速率仍切换（下限速度驱动，${slowFlip.frames} 帧）`,
  );
  // 思考流同样驱动交替
  const thinkFlip = runUntilFlip("thinking", 50, ascii(64));
  assert.equal(
    thinkFlip.sym,
    "○",
    `思考流同样驱动交替（${thinkFlip.frames} 帧）`,
  );
  // run 边界 = 两次用户输入之间：turn-end（回合结束）**不清零**（同一 run 内），
  // 下次用户输入（turn-begin clearActivity=true）才清零回到相位 0
  let tb = reduceState(initialState(), {
    type: "agent-status",
    status: "thinking",
  });
  tb = reduceState(tb, { type: "append", text: ascii(64), time: 1000 });
  tb = reduceState(tb, { type: "append", text: ascii(64), time: 1050 });
  const beforeTurnEnd = tb.runVirt.tokens;
  assert.ok(beforeTurnEnd > 0, "流式输出已累计虚拟 token");
  tb = reduceState(tb, { type: "turn-end" });
  assert.equal(
    tb.runVirt.tokens,
    beforeTurnEnd,
    "turn-end 保留虚拟总 token（run 未结束）",
  );
  assert.equal(
    tb.runVirt.speed,
    VIRT_SPEED_MIN,
    "turn-end 仅把虚拟速度更新为下限（输出停止）",
  );
  // 用户输入开启的回合（clearActivity=true）：清零
  tb = reduceState(tb, { type: "turn-begin", clearActivity: true });
  assert.equal(tb.runVirt.tokens, 0, "用户输入（turn-begin）清零虚拟总 token");
  assert.equal(tb.runVirt.speed, VIRT_SPEED_MIN, "用户输入重置虚拟速度为下限");
  // 核心自发回合（clearActivity=false）：属同一 run，保留
  tb = reduceState(tb, { type: "agent-status", status: "thinking" });
  tb = reduceState(tb, { type: "append", text: ascii(64), time: 2000 });
  tb = reduceState(tb, { type: "append", text: ascii(64), time: 2050 });
  const midRun = tb.runVirt.tokens;
  assert.ok(midRun > 0, "核心回合流式输出累计虚拟 token");
  tb = reduceState(tb, { type: "turn-begin", clearActivity: false });
  assert.equal(
    tb.runVirt.tokens,
    midRun,
    "核心自发回合（clearActivity=false）不清零",
  );
  // 用户输入提交后状态栏回到相位 0 实心圆
  tb = reduceState(tb, { type: "turn-begin", clearActivity: true });
  tb = reduceState(tb, { type: "agent-status", status: "thinking" });
  assert.equal(
    strip(statusRow(tb)).trimStart()[0],
    "●",
    "用户输入清零后回到相位 0 实心圆",
  );
});

test("nextRunVirt: 窗口速率估计 + 速率化 slew + 上下限 clamp（P1 时间一致 / P2 抗噪）", () => {
  // 首帧无时间基准：仅登记基准，不更新速度、不积分、窗口不累计
  const first = nextRunVirt(emptyRunVirt(), 1000, 16);
  assert.equal(first.speed, VIRT_SPEED_MIN, "首帧速度保持下限（界内起点）");
  assert.equal(first.tokens, 0, "首帧不积分");
  assert.equal(first.lastTime, 1000, "登记时间基准");
  assert.equal(first.winTokens, 0, "首帧窗口未累计（无时长基准）");
  // 持续高速（每 50ms 16 token ≈ 320 token/s）→ 爬到上限
  let v = first;
  for (let i = 0; i < 40; i++) v = nextRunVirt(v, 1000 + (i + 1) * 50, 16);
  assert.equal(v.speed, VIRT_SPEED_MAX, "高速率爬到上限");
  assert.ok(v.tokens > 0, "虚拟总 token 随积分增长");
  // 极低真实速率（1s 1 token）→ clamp 到下限
  const slow = nextRunVirt({ ...emptyRunVirt(), lastTime: 2000 }, 3000, 1);
  assert.equal(slow.speed, VIRT_SPEED_MIN, "低速率 clamp 到下限");
  assert.ok(slow.tokens > 0, "下限速度仍积分出虚拟 token");
  // 时间未推进：不更新不积分
  const same = nextRunVirt(slow, 3000, 16);
  assert.equal(same.speed, slow.speed, "时间未推进速度不变");
  assert.equal(same.tokens, slow.tokens, "时间未推进不积分");
  // 无时间（undefined）：保持现有值
  const noTime = nextRunVirt(slow, undefined, 16);
  assert.equal(noTime.speed, slow.speed, "无时间速度不变");
  // P1 速率化 slew：单帧最大移动 = VIRT_SLEW_RATE × Δt（与帧间隔成正比）
  const boom = nextRunVirt(
    { ...emptyRunVirt(), speed: VIRT_SPEED_MIN, lastTime: 4000 },
    4100,
    1000, // 巨量数据：目标必到上限，但 slew 只允许 rate×0.1
  );
  assert.equal(
    boom.speed,
    VIRT_SPEED_MIN + VIRT_SLEW_RATE * 0.1,
    "爆发帧只移动 VIRT_SLEW_RATE×Δt",
  );
  const halt = nextRunVirt(
    { ...emptyRunVirt(), speed: VIRT_SPEED_MAX, lastTime: 5000 },
    5100,
    0, // 零数据：目标下限，slew 只允许 -rate×0.1
  );
  assert.equal(
    halt.speed,
    VIRT_SPEED_MAX - VIRT_SLEW_RATE * 0.1,
    "停顿帧只移动 -VIRT_SLEW_RATE×Δt",
  );
  // P1 时间一致：同样真实速率（80 token/s）、不同 chunk 频率 → 同一时刻速度相同
  const runFixedRate = (stepMs: number, totalMs: number): number => {
    let s = nextRunVirt(emptyRunVirt(), 1000, 0); // 登记基准
    for (let ms = stepMs; ms <= totalMs; ms += stepMs) {
      s = nextRunVirt(s, 1000 + ms, (80 * stepMs) / 1000);
    }
    return s.speed;
  };
  const fastFrames = runFixedRate(10, 400);
  const slowFrames = runFixedRate(200, 400);
  assert.ok(
    Math.abs(fastFrames - slowFrames) < 0.01,
    `时间一致：10ms 帧 ${fastFrames} vs 200ms 帧 ${slowFrames}`,
  );
  // P2 抗噪：单帧异常大 chunk 不使速度越过 slew 上限（窗口稀释）
  const noisy = nextRunVirt(
    {
      ...emptyRunVirt(),
      speed: 20,
      lastTime: 7000,
      winTokens: 20 * 0.5,
      winSecs: 0.5,
    },
    7100,
    500, // 单帧 500 token（异常）：窗口 = (10×0.82+500)/(0.5×0.82+0.1)
  );
  assert.ok(
    noisy.speed <= 20 + VIRT_SLEW_RATE * 0.1,
    "异常大 chunk 受 slew 限制",
  );
});

test("virtTick: 无数据时虚拟速度指数衰减回落到下限、虚拟总 token 持续积分（闪烁不停）", () => {
  // 无时间基准：原样返回
  const noBase = virtTick({ ...emptyRunVirt(), speed: VIRT_SPEED_MAX }, 1000);
  assert.equal(noBase.speed, VIRT_SPEED_MAX, "无时间基准速度不变");
  assert.equal(noBase.tokens, 0, "无时间基准不积分");
  // 时间未推进：原样返回
  const v0 = virtTick(
    { ...emptyRunVirt(), speed: VIRT_SPEED_MAX, lastTime: 1000 },
    2000,
  );
  const same = virtTick(v0, 2000);
  assert.equal(same.speed, v0.speed, "时间未推进速度不变");
  assert.equal(same.tokens, v0.tokens, "时间未推进不积分");
  // 6s（=τ）衰减：速度按 16 + (MAX−16)·e^(−1) 回落，token 按衰减速度积分增长
  const v1 = virtTick(
    { ...emptyRunVirt(), speed: VIRT_SPEED_MAX, lastTime: 0 },
    6000,
  );
  const expect6s =
    VIRT_SPEED_MIN + (VIRT_SPEED_MAX - VIRT_SPEED_MIN) * Math.exp(-1);
  assert.ok(
    Math.abs(v1.speed - expect6s) < 1e-6,
    `6s 后速度 ${expect6s}（实际 ${v1.speed}）`,
  );
  assert.ok(v1.speed < VIRT_SPEED_MAX, "6s 后速度已下降");
  // token 积分 = MIN·Δt + (v₀−MIN)·τ·(1−e^(−Δt/τ))
  const expectTokens =
    VIRT_SPEED_MIN * 6 +
    (VIRT_SPEED_MAX - VIRT_SPEED_MIN) * 6 * (1 - Math.exp(-1));
  assert.ok(
    Math.abs(v1.tokens - expectTokens) < 1e-6,
    `6s 积分 ${expectTokens}（实际 ${v1.tokens}）`,
  );
  // 长时间无数据：速度回落到下限附近，token 仍按下限速度持续增长
  const v2 = virtTick(v1, 6000 + 54000);
  assert.ok(
    v2.speed < VIRT_SPEED_MIN + 0.5,
    `60s 后速度接近下限（实际 ${v2.speed}）`,
  );
  assert.ok(v2.tokens > v1.tokens, "token 持续积分不停止");
  // 下限保持：速度永不低于 MIN
  const v3 = virtTick(v2, 6000 + 54000 + 60000);
  assert.ok(v3.speed >= VIRT_SPEED_MIN, "速度不低于下限");
  // 速率窗口同步衰减（忘记旧数据）
  const v4 = virtTick(
    {
      ...emptyRunVirt(),
      speed: VIRT_SPEED_MAX,
      lastTime: 0,
      winTokens: 100,
      winSecs: 1,
    },
    6000,
  );
  assert.ok(v4.winTokens < 100 && v4.winSecs < 1, "窗口随时长衰减");
});

test("运行中无数据：virt-tick 持续积分跨过阈值切换 ●/○，速度渐降但 token 不停", () => {
  const ascii = (chars: number): string => "x".repeat(chars);
  const strip = (l: FrameRow): string =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, "");
  const statusRow = (s: ReturnType<typeof initialState>): FrameRow =>
    buildFrame(s, { rows: 24, cols: 60 })[18]!; // 状态栏行
  const sym = (s: ReturnType<typeof initialState>): string =>
    strip(statusRow(s)).trimStart()[0] ?? "";
  // 高速流式若干帧（每 50ms 16 token）：速度按 slew 速率爬升，虚拟总 token 积分
  let s = reduceState(initialState(), {
    type: "agent-status",
    status: "thinking",
  });
  s = reduceState(s, { type: "append", text: ascii(64), time: 1000 });
  for (let i = 0; i < 8; i++)
    s = reduceState(s, {
      type: "append",
      text: ascii(64),
      time: 1050 + i * 50,
    });
  assert.equal(sym(s), "●", "数据停止时相位 0 实心圆");
  const tokensAtStop = s.runVirt.tokens;
  assert.ok(tokensAtStop > 0, "已累计虚拟 token");
  // 无数据：250ms tick 持续推进（token 单调增长），若干次后跨过阈值 → ○
  let flipped = -1;
  for (let i = 1; i <= 20; i++) {
    s = reduceState(s, { type: "virt-tick", time: 1400 + i * 250 });
    if (sym(s) === "○") {
      flipped = i;
      break;
    }
  }
  assert.ok(flipped > 0, `无数据 tick 最终跨阈值切换 ●→○（第 ${flipped} 次）`);
  assert.ok(s.runVirt.tokens > tokensAtStop, "虚拟总 token 持续积分不停止");
  // 长时间无数据：速度回落到下限附近，token 仍持续增长
  const tokensMid = s.runVirt.tokens;
  s = reduceState(s, { type: "virt-tick", time: 1400 + 20 * 250 + 30000 });
  assert.ok(
    s.runVirt.speed < VIRT_SPEED_MIN + 0.5,
    "长时间无数据速度回落到下限附近",
  );
  assert.ok(s.runVirt.tokens > tokensMid, "长时间无数据 token 仍增长");
});

test("usage 校准（P5）：真值/估算比例 EMA 更新 tokenCalib；无真值不校准", () => {
  let s = reduceState(initialState(), {
    type: "agent-status",
    status: "thinking",
  });
  // 估算 16 token（64 ASCII × 0.25）；真值 32 → ratio 2 → calib = 0.3×2 + 0.7×1
  s = reduceState(s, { type: "append", text: "x".repeat(64), time: 1000 });
  assert.equal(s.stepEstTokens, 16, "本 step 估算累计");
  s = reduceState(s, {
    type: "usage",
    sessionId: "s1",
    input: 100,
    output: 32,
    cacheRead: 0,
  });
  assert.ok(
    Math.abs(s.tokenCalib - 1.3) < 1e-9,
    `真值是估算 2 倍 → calib 1.3（实际 ${s.tokenCalib}）`,
  );
  assert.equal(s.stepEstTokens, 0, "校准后本 step 累计清零");
  // 估算与真值一致 → 向 1 收敛
  s = reduceState(s, { type: "append", text: "x".repeat(64), time: 1100 });
  s = reduceState(s, {
    type: "usage",
    sessionId: "s1",
    input: 100,
    output: 16,
    cacheRead: 0,
  });
  assert.ok(
    Math.abs(s.tokenCalib - 1.21) < 1e-9,
    `ratio=1 → calib 1.21（实际 ${s.tokenCalib}）`,
  );
  // 校准系数参与后续估算（P5 生效于 nextRunVirt 输入）
  const calibBefore = s.tokenCalib;
  const before = s.runVirt.winTokens;
  s = reduceState(s, { type: "append", text: "x".repeat(64), time: 1200 });
  const delta = s.runVirt.winTokens - before * Math.exp(-0.1 / 0.5);
  assert.ok(
    Math.abs(delta - 16 * calibBefore) < 1e-6,
    `窗口按校正后估算累计（实际 ${delta}）`,
  );
  // provider 未报 usage（output<=0）→ 不校准
  s = reduceState(s, { type: "append", text: "x".repeat(64), time: 1300 });
  const keep = s.tokenCalib;
  s = reduceState(s, {
    type: "usage",
    sessionId: "s1",
    input: 0,
    output: 0,
    cacheRead: 0,
  });
  assert.equal(s.tokenCalib, keep, "无真值不校准");
  assert.equal(s.stepEstTokens, 0, "step 累计仍清零");
  // 极端真值 → 校准系数 clamp 到上限
  s = reduceState(s, { type: "append", text: "x".repeat(4), time: 1400 });
  s = reduceState(s, {
    type: "usage",
    sessionId: "s1",
    input: 0,
    output: 10000,
    cacheRead: 0,
  });
  assert.equal(s.tokenCalib, TOKEN_CALIB_MAX, "校准系数 clamp 到上限");
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
  // 历史内容（用户行保留）；过程 assistant（非 final）在 turn-begin 时被清空
  s = reduceState(s, { type: "user-line", text: "q" });
  s = reduceState(s, { type: "append", text: "中间输出" });
  s = reduceState(s, { type: "turn-begin" });
  assert.deepEqual(
    (({ text, kind }) => ({ text, kind }))(s.buffer[s.buffer.length - 1]!),
    { text: TURN_SEPARATOR, kind: "separator" },
  );
  assert.equal(
    s.buffer.some((l) => l.kind === "assistant"),
    false,
    "turn-begin 清空非 final 中间输出（仅历史 user + 分隔线保留）",
  );
  // 流式仍实时合入
  s = reduceState(s, { type: "append", text: " more" });
  assert.equal(s.buffer[s.buffer.length - 1]?.text, " more");
});

test("turn-begin: 空 buffer 不画孤立分隔线；重复 begin 不重复；turn-end 不画线", () => {
  let s = initialState();
  s = reduceState(s, { type: "turn-begin" });
  assert.equal(s.buffer.length, 0);
  s = reduceState(s, { type: "user-line", text: "q" });
  s = reduceState(s, { type: "append", text: "a" });
  s = reduceState(s, { type: "turn-end" });
  assert.equal(
    s.buffer.filter((l) => l.kind === "assistant" && l.final).length,
    1,
    "turn-end 把最后一段 assistant 标为 final 总结",
  );
  s = reduceState(s, { type: "turn-begin" });
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

test("turn-end 标 final：中间输出留在活动区、总结进历史区；幂等与跨回合", () => {
  // 回合内：思考 → 中间输出 → 工具 → 总结
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "q" });
  s = reduceState(s, { type: "thinking", text: "思考" });
  s = reduceState(s, { type: "append", text: "中间回复 1" });
  s = reduceState(s, { type: "append", text: "中间回复 2" });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s",
    name: "bash",
    summary: "ls",
  });
  s = reduceState(s, { type: "append", text: "最终总结" });
  // turn-end 前：所有 assistant 均非 final
  assert.equal(
    s.buffer.filter((l) => l.kind === "assistant" && l.final).length,
    0,
    "回合进行中无 final 行（中间输出在活动区）",
  );
  s = reduceState(s, { type: "turn-end" });
  const finals = s.buffer.filter((l) => l.final);
  assert.equal(finals.length, 1, "仅最后一段 assistant 标 final");
  assert.equal(finals[0]!.text, "最终总结");
  // 幂等：再次 turn-end 不新增 final
  s = reduceState(s, { type: "turn-end" });
  assert.equal(s.buffer.filter((l) => l.final).length, 1, "重复 turn-end 幂等");
  // 新回合 turn-begin：清掉非 final 中间输出/思考/工具，保留 user + final 总结
  s = reduceState(s, { type: "turn-begin" });
  const kinds = s.buffer.map((l) => l.kind);
  assert.ok(!kinds.includes("thinking"), "思考被清");
  assert.ok(!kinds.includes("tool"), "工具被清");
  assert.equal(
    s.buffer.filter((l) => l.kind === "assistant" && !l.final).length,
    0,
    "非 final 中间输出被清",
  );
  assert.ok(
    s.buffer.some(
      (l) => l.kind === "assistant" && l.final && l.text === "最终总结",
    ),
    "final 总结保留在历史区",
  );
});

test("turn-end 无模型正文：不标 final（纯工具/思考回合）", () => {
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "q" });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s",
    name: "bash",
    summary: "ls",
  });
  s = reduceState(s, { type: "turn-end" });
  assert.equal(
    s.buffer.filter((l) => l.final).length,
    0,
    "无 assistant 输出时不产生 final 行",
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
    80,
  );
  const text = lines.map((l) => rowAnsi(l)).join("\n");
  assert.ok(
    text.includes("\x1b[38;2;197;130;237m"),
    "应有紫色(magenta #C582ED)",
  );
  assert.ok(text.includes("\x1b[38;2;100;214;230m"), "应有青色(cyan #64D6E6)");
  assert.ok(
    text.includes("\x1b[38;2;90;152;243m"),
    "路径段应染蓝(blue #5A98F3)",
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
    160,
  );
  assert.equal(lines.length, 1, "宽屏应单行");
  const sgrs = [
    ...rowAnsi(lines[0]!).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g),
  ].map((m) => {
    const h = (n: string): string => Number(n).toString(16).padStart(2, "0");
    return `#${h(m[1]!)}${h(m[2]!)}${h(m[3]!)}`.toUpperCase();
  });
  assert.ok(sgrs.length >= 4, `应有多个着色段: ${sgrs.join(",")}`);
  for (let i = 0; i < sgrs.length - 1; i++) {
    if (sgrs[i] === sgrs[i + 1]) {
      // dark 基底 foreground=#C9DCDE=ansi[7]，边框 border 同取 ansi[7]
      // （用户指定正文/边框同色），仅允许该对相邻同色；其余相邻段必须可区分
      assert.equal(sgrs[i], "#C9DCDE", `仅允许基底/边框同色对`);
    }
  }
  for (const c of sgrs) {
    // dark 主题红/黄/绿：#FD0013 / #E9C944 / #61D383——状态栏段不使用状态色
    assert.ok(
      !/#FD0013|#E9C944|#61D383/.test(c),
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
    20,
  );
  // 极端窄屏：分组折行 + 单组超宽组内压缩（cwd 保尾 / model 保后缀），行不超宽
  assert.ok(lines.length >= 2, "窄屏应折行为多行");
  const joined = lines.map((l) => rowAnsi(l)).join("\n");
  assert.ok(joined.includes("12:00:00"), "时间保留");
  assert.ok(joined.includes("87%"), "缓存命中保留");
  assert.ok(joined.includes(":none"), "model 段思考后缀保尾保留");
  for (const l of lines) {
    const visible = rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, "");
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
  // 回合结束：最后一段 assistant 标为 final 总结 → 历史区展示
  s = reduceState(s, { type: "turn-end" });
  // 标题栏占左列顶部 2 行：加高终端（rows=24 → dialogueH=5）保证用户块全部可见
  const top = buildFrame(s, { rows: 24, cols: 40 }).slice(0, 10);
  const plain = (line: FrameRow): string =>
    rowAnsi(line).replace(/\x1b\[[0-9;]*m/g, "");
  const visible = top.map(plain);
  // 长消息占满最大正文宽 ⟹ 左边界 = 历史宽 - userMaxBodyWidth
  const m = metricsFor({ rows: 24, cols: 40 }, false);
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
    24,
  );
  // 窄屏单组(环境)超行宽 → 组内压缩，cwd 保尾截断；LLM 组折行
  assert.ok(lines.length >= 2, `窄屏应折为多行 (got ${lines.length} lines)`);
  const joined = lines.map((l) => rowAnsi(l)).join("\n");
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
      rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, "").length <= 24,
      `行不应超宽: ${rowAnsi(l)}`,
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
    44,
  );
  // 完整优先：单组放得下就完整显示并折行，不截断内容（标题已移入状态列，不再占水平栏宽度）
  assert.ok(lines.length >= 2, `应折行为多行 (got ${lines.length} lines)`);
  const visible = lines
    .map((l) => rowAnsi(l))
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(
    visible.includes("feature/very-long-branch-name"),
    "超长分支名完整保留",
  );
  for (const l of lines) {
    assert.ok(
      rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, "").length <= 44,
      `行不应超宽: ${rowAnsi(l)}`,
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
    160,
  );
  assert.equal(lines.length, 1, "宽屏完整单行(env|LLM 分组)");
  const visible = lines
    .map((l) => rowAnsi(l))
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
      80,
    );
    const visible = lines
      .map((l) => rowAnsi(l))
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
    rowAnsi(line).replace(/\x1b\[[0-9;]*m/g, ""),
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
  // 标题栏占左列顶部 2 行：加高终端（rows=24 → dialogueH=5）保证首行块可见；
  // cols=50（状态列最低 20 → 历史区 30）确保两个用户块都在可视窗口内
  const plain = buildFrame(s, { rows: 24, cols: 50 }).map((line) =>
    rowAnsi(line).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const rows = plain.filter(
    (l) => l.includes("第一行") || l.includes("第二行") || l.includes("展示"),
  );
  assert.ok(rows.length >= 3, "应至少三行(显式换行 1 + 软换行 2)");
  // 左边界按历史区正文量测（跳过状态列）：appendStream 按 \n 拆出独立块，
  // 每个块各自右对齐（左缘随块宽不同），块内软换行续行共享同一左边界
  const indents = rows.map((l) => {
    const b = histBody(l, 50);
    return b.length - b.trimStart().length;
  });
  assert.equal(
    new Set(indents.slice(1)).size,
    1,
    `软换行续行共享同一左边界: ${indents}`,
  );
});
test("会话流：用户消息软换行竖线固定在块右缘（不随行尾）", () => {
  let s = initialState();
  // 单条消息软换行成不等宽两行：续行内容短，竖线应补空格对齐到块右缘
  s = reduceState(s, {
    type: "user-line",
    text: "a".repeat(40),
  });
  const plain = buildFrame(s, { rows: 24, cols: 40 }).map((line) =>
    rowAnsi(line).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const rows = plain.filter((l) => l.includes("aaaa"));
  assert.ok(rows.length >= 2, "应软换行成至少两行");
  const cols = rows.map((l) => histBody(l, 40).lastIndexOf("┃"));
  assert.equal(
    new Set(cols).size,
    1,
    `换行后竖线应在同一列(块右缘)而非跟随行尾: ${cols}`,
  );
});
test("会话流：用户块与回答/思考之间恰有一行空行；无回复或紧跟分隔线时不加空行", () => {
  // user → assistant：恰有一行空白
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "问题" });
  s = reduceState(s, { type: "append", text: "答案" });
  // 回合结束：答案标 final → 历史区展示
  s = reduceState(s, { type: "turn-end" });
  // 标题栏占左列顶部 2 行：加高终端（rows=19 → dialogueH=3）保证问题+空行+答案可见
  let plain = buildFrame(s, { rows: 19, cols: 40 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
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
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const tt = plain.findIndex((l) => l.includes("思考中"));
  assert.ok(tt >= 0, "思考应在帧内可见");
  assert.ok(
    plain.slice(0, tt).some((l2) => l2.includes("─")),
    "思考应位于活动区实线分隔之下",
  );

  // 活动区分隔线：灰色实线（ANSI 直方）；turn 分隔线灰色虚线；状态栏上 = 下 -
  // 标题栏下划线行也是全 ─（index 2），须跳过以定位真正的活动区分隔行
  const graySGR = "\x1b[38;2;";
  const dt = buildFrame(
    reduceState(initialState(), { type: "thinking", text: "x" }),
    {
      rows: 16,
      cols: 40,
    },
  );
  const dotRaw = dt.find(
    (l, i) => i > TITLE_BAR_ROWS && /^─+$/.test(histContent(rowAnsi(l), 40)),
  );
  assert.ok(dotRaw, "活动区分隔线为实线");
  assert.ok(
    rowAnsi(dotRaw!).includes(graySGR),
    "活动区分隔线为灰色（含 truecolor SGR）",
  );
  let ts = reduceState(initialState(), { type: "append", text: "正文" });
  ts = reduceState(ts, { type: "turn-end" }); // 正文标 final 进历史区
  ts = reduceState(ts, { type: "turn-begin" });
  const turnRaw = buildFrame(ts, { rows: 10, cols: 40 }).find((l) =>
    /^╌+$/.test(histContent(rowAnsi(l), 40)),
  );
  assert.ok(turnRaw, "turn 分隔线(虚线)仍在历史区");
  assert.ok(
    rowAnsi(turnRaw!).includes(graySGR),
    "turn 分隔线为灰色（含 truecolor SGR）",
  );
  const st = buildFrame(
    reduceState(initialState(), { type: "thinking", text: "x" }),
    {
      rows: 16,
      cols: 40,
    },
  ).map((l) => rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""));
  // 标题已移入状态列，水平栏定位改用组间框线（状态栏行 = 状态符号 + 空格 + │ 开头）
  const statIdx = st.findIndex((l) => /^[✓✗●○△?] │/.test(l.trimStart()));
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
  // cols=40（历史宽 20）：gutter=6 下窄窗正文宽更小，cols=30 会把「孤立」折成两行
  plain = buildFrame(u, { rows: 20, cols: 40 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
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
  s = reduceState(s, { type: "append", text: "第三段\n" });
  s = reduceState(s, { type: "turn-end" }); // 正文标 final → 历史区
  s = reduceState(s, { type: "turn-begin" });
  // 标题栏占左列顶部 2 行：活动区 1/2 后加高终端（rows=24 → dialogueH=6）保证正文尾段可见
  const plain = buildFrame(s, { rows: 24, cols: 40 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
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
  p = reduceState(p, { type: "turn-end" }); // 正文标 final → 历史区
  const plainP = buildFrame(p, { rows: 24, cols: 40 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const i1 = plainP.findIndex((l) => l.includes("一段"));
  const i2 = plainP.findIndex((l) => l.includes("二段"));
  assert.ok(i1 >= 0 && i2 > i1);
  assert.equal(i2 - i1, 2, "两段正文之间的空行保留");
});

test("会话流：思考在活动区按视口截断；正文(输出)到达保留、turn-end 后保留至下回合", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "thinking",
    text: "t1\nt2\nt3\nt4\nt5\nt6",
  });
  const frame = buildFrame(s, { rows: 16, cols: 60 });
  const thinkingLines = frame.filter((l) => isThinkingRow(l, 60));
  // 活动区视口 = activityH 行（rows=16 → activityH=4）：只显示最近 4 行，可滚动回看
  assert.ok(thinkingLines.length <= 4, "思考最多占满活动区视口");
  assert.ok(frame.some((line) => rowAnsi(line).includes("t6")));
  assert.ok(!frame.some((line) => rowAnsi(line).includes("t1")));

  s = reduceState(s, { type: "append", text: "正文" });
  assert.equal(
    s.buffer.some((line) => line.kind === "thinking"),
    true,
    "正文到达后思考仍保留（思考/中间输出属活动区，总结属历史区）",
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

test("会话流：思考不再单独折叠，活动区整体按视口高度截断（可滚动回看）", () => {
  // rows=24 → contentTopH=16 → activityH=8：12 行思考 → 视口显示最近 8 行，无折叠提示
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
    "活动区视口=activityH（rows=24 → activityH=8），实际:" + thinking.length,
  );
  assert.ok(frame.some((line) => rowAnsi(line).includes("a12")));
  assert.ok(!frame.some((line) => rowAnsi(line).includes("a01")));
});
test("会话流：窄终端仍保留用户与思考文本", () => {
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "用户" });
  s = reduceState(s, { type: "thinking", text: "思考" });
  // 标题栏占左列顶部：加高到 rows=17（cols=8 时状态栏折 2 行，dialogueH=2）
  // 保证用户块两行（窄列换行）可见
  const plain = buildFrame(s, { rows: 17, cols: 8 }).map((line) =>
    rowAnsi(line).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const narrowJoined = plain.join("");
  assert.ok(narrowJoined.includes("用") && narrowJoined.includes("户"));
  assert.ok(narrowJoined.includes("思") && narrowJoined.includes("考"));
});

test("会话流：cols=2 极限宽度不丢失宽字符", () => {
  const s = reduceState(initialState(), { type: "user-line", text: "中" });
  const plain = buildFrame(s, { rows: 20, cols: 2 }).map((line) =>
    rowAnsi(line).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  assert.ok(plain.some((line) => line.includes("中")));
});

test("会话流：turn 分隔线在历史区铺满宽度", () => {
  let s = reduceState(initialState(), { type: "user-line", text: "x" });
  s = reduceState(s, { type: "turn-end" });
  const plain = buildFrame(s, { rows: 10, cols: 20 }).map((line) =>
    rowAnsi(line).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  assert.ok(
    plain.some((line) => line.length === 20 && line.includes("─".repeat(18))),
  );
});

test("交错布局：模型正文右缘保留与用户块左缘对称的空位(gutter)；用户块仍贴右缘", () => {
  const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "");
  // cols=40 → historyWidth 依 metricsFor；USER_MIN_LEFT_GUTTER=4 → 正文宽 = hist-4
  const m = metricsFor({ rows: 16, cols: 40 }, false);
  const hist = m.historyWidth;
  const bodyW = hist - USER_MIN_LEFT_GUTTER - 1; // contentW（右缘预留框列）- gutter
  let s = initialState();
  s = reduceState(s, {
    type: "append",
    text: "0123456789012345678901234567890123456789", // 40 字符
  });
  s = reduceState(s, { type: "turn-end" }); // 正文标 final → 历史区
  // 标题栏占左列顶部 2 行：加高终端（rows=16 → dialogueH=2）保证两行正文可见
  const rows = buildFrame(s, { rows: 16, cols: 40 })
    .map((l) => strip(rowAnsi(l)))
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
    .map((l) => strip(rowAnsi(l)))
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
  const rows = buildFrame(s, { rows: 16, cols: 40 })
    .map((l) => strip(rowAnsi(l)))
    .filter((l) => /[0-9]/.test(l));
  const m = metricsFor({ rows: 16, cols: 40 }, false);
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

test("交错布局：输入最长折行左缘与回复正文第 5 个字符同列（gutter=6）", () => {
  const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "");
  const cols = 60;
  // 输入/回复均为超长英文（无自然断点）→ 各自折到宽度上限，左缘停在最左可占据列
  let s = initialState();
  s = reduceState(s, { type: "user-line", text: "U".repeat(120) });
  s = reduceState(s, { type: "append", text: "R".repeat(120) });
  s = reduceState(s, { type: "turn-end" }); // 正文标 final → 历史区
  const frame = buildFrame(s, { rows: 24, cols }).map((l) => strip(rowAnsi(l)));
  const colOf = (line: string, ch: string): number => {
    let col = 0;
    for (const c of [...line]) {
      if (c === ch) return col;
      col += displayWidth(c);
    }
    return -1;
  };
  const uRow = frame.find((l) => l.includes("U"));
  const rRow = frame.find((l) => l.includes("R"));
  assert.ok(uRow !== undefined && rRow !== undefined, "输入/回复行都可见");
  // 屏幕列口径：左缘框列 1 + 用户块留白 gutter-1 → 输入正文起 gutter 列；
  // 回复行 ┃ 占 col1、正文自 col2 起 → 第 5 个字符在 col2+4
  assert.equal(
    colOf(uRow, "U"),
    USER_MIN_LEFT_GUTTER,
    "输入最长左缘 = gutter 列",
  );
  assert.equal(colOf(rRow, "R") + 4, USER_MIN_LEFT_GUTTER, "回复第 5 字符同列");
  assert.equal(colOf(rRow, "R"), 2, "回复正文自 col2 起（┃ 占 col1）");
});

test("交错布局：多行输入为一块——块内行首左对齐、块宽 = 最长行、右缘竖线同列", () => {
  const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "");
  const cols = 60;
  // 三行显式换行（最长行 24 列 < 上限 33 → 块不顶左边界，左缘由块宽决定）
  let s = initialState();
  s = reduceState(s, {
    type: "user-line",
    text: "短\n中等长度的一行\n最长的一行内容ABCDEFGHIJ",
  });
  s = reduceState(s, { type: "append", text: "好" });
  s = reduceState(s, { type: "turn-end" });
  // 一次输入 = 一条 buffer 行（显式换行保留在行内，不再拆成多条 user 行）
  const userLines = s.buffer.filter((l) => l.kind === "user");
  assert.equal(userLines.length, 1, "多行输入只占一条 buffer 行");
  assert.ok(userLines[0]!.text.includes("\n"), "换行保留在行内");

  const rows = buildFrame(s, { rows: 24, cols })
    .map((l) => strip(rowAnsi(l)))
    .filter((l) => /短|中等长度的一行|最长的一行内容/.test(l));
  assert.equal(rows.length, 3, "三行都在同一块内可见");
  const body = (l: string): string => histContent(l, cols);
  const lead = (l: string): number =>
    displayWidth(body(l)) - displayWidth(body(l).trimStart());
  const barCol = (l: string): number => {
    let col = 0;
    for (const c of [...body(l)]) {
      if (c === "┃") return col;
      col += displayWidth(c);
    }
    return -1;
  };
  // 块内行首左对齐（三行同一左边界）+ 右缘竖线同列（块宽 = 最长行 + 1 列竖线）
  assert.deepEqual(
    [lead(rows[1]!), lead(rows[2]!)],
    [lead(rows[0]!), lead(rows[0]!)],
    "块内各行行首左对齐",
  );
  assert.deepEqual(
    [barCol(rows[1]!), barCol(rows[2]!)],
    [barCol(rows[0]!), barCol(rows[0]!)],
    "块右缘竖线同列",
  );
  // 块宽 = 最长行（24）+ 竖线 1 列 → 左缘 = 正文区宽 − 25
  const contentW = metricsFor({ rows: 24, cols }, false).historyWidth - 1;
  assert.equal(lead(rows[2]!), contentW - 25, "块宽取决于最长行（右对齐贴边）");
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
  const plain = raw.map((l) => rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""));
  const joined = plain.join("\n");
  // 标题：内容保留、# 前缀消费、行内粗体叠加且有 bold SGR
  assert.ok(joined.includes("一级标题"), "标题内容");
  assert.ok(!joined.includes("# 一级标题"), "# 前缀被消费");
  assert.ok(joined.includes("二级 粗 标题"), "标题内行内粗体");
  assert.ok(
    raw.some(
      (l) => rowAnsi(l).includes("一级标题") && rowAnsi(l).includes("\x1b[1m"),
    ),
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
    raw.some((l) => /\x1b\[48;2;\d+;\d+;\d+m/.test(rowAnsi(l))),
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
  const plain = raw.map((l) => rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""));
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
  assert.ok(rowAnsi(raw[doneIdx]!).includes("\x1b[9m"), "已完成任务删除线");
  // thinking 保持纯文本（markdown 只作用于最终正文）
  // thinking 保持纯文本（markdown 只作用于最终正文）
  assert.ok(
    plain.some((l) => l.includes("**粗** 在 thinking")),
    "thinking 保持原样",
  );
});

test("markdown 列表长项折行：悬挂缩进对齐正文、续行不顶满", () => {
  // 单元：wrapAssistantLine——首行前缀 + 续行同宽空格缩进（正文对齐、不重复前缀）
  const unit = (input: string, width: number, prefixWidth: number): void => {
    const rows = wrapAssistantLine(input, width, "dark");
    assert.ok(rows.length >= 2, "长列表项应折出多行");
    const first = rows[0]!.map((s) => s.text).join("");
    assert.ok(
      !first.startsWith(" "),
      "首行以前缀开头（无前导缩进）: " + JSON.stringify(first),
    );
    for (const row of rows.slice(1)) {
      const text = row.map((s) => s.text).join("");
      assert.ok(
        text.startsWith(" ".repeat(prefixWidth)),
        `续行缩进 ${prefixWidth} 列对齐正文: ${JSON.stringify(text.slice(0, prefixWidth + 4))}`,
      );
      assert.ok(!text.startsWith("• "), "续行不重复子弹前缀");
      assert.ok(
        displayWidth(text) <= width,
        `续行总宽不超 ${width}: ${JSON.stringify(text)}`,
      );
    }
  };
  // 无序 •（2 列）/ 有序 1. 与 10. + 全角数字前缀（3/4 列）/ 任务 [x] [ ]（4 列）
  unit("- ".concat("标".repeat(60)), 20, 2);
  unit("1. ".concat("标".repeat(60)), 22, 3);
  unit("10. ".concat("标".repeat(60)), 23, 4);
  unit("- [x] ".concat("标".repeat(60)), 24, 4);
  unit("- [ ] ".concat("标".repeat(60)), 24, 4);
  // 集成：对话区真实渲染——续行在 assistant 左竖线（U+2503）后缩进到正文列
  // （不顶满第一列）。竖线为 UI 既有装饰字符，此处用码点转义书写。
  let s = initialState();
  s = reduceState(s, {
    type: "append",
    text: "- ".concat("ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(3)) + "\n",
  });
  const raw = buildFrame(s, { rows: 24, cols: 80 });
  const lines = raw
    .map((l) => stripAnsi(rowText(l)))
    .filter((l) => l.includes("ABCDEFG"));
  assert.ok(lines.length >= 2, "列表项在对话区折出多行");
  const body = (t: string): string => {
    const i = t.indexOf("\u2503");
    return i >= 0 ? t.slice(i + 1) : t;
  };
  const cont0 = body(lines[0]!);
  const cont1 = body(lines[1]!);
  assert.ok(cont0.startsWith("• "), "首行子弹前缀: " + JSON.stringify(cont0));
  assert.ok(
    cont1.startsWith("  ") && !cont1.startsWith("• "),
    "续行悬挂缩进对齐正文: " + JSON.stringify(cont1),
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
  const noUsage = renderStatusLine(baseStatus, 80);
  assert.ok(
    noUsage
      .map((l) => rowAnsi(l))
      .join("\n")
      .includes("—"),
    "无 usage 保留占位 —",
  );
  const withUsage = renderStatusLine(baseStatus, 80, {
    input: 12000,
    output: 900,
    cacheRead: 24000,
  });
  const t = withUsage.map((l) => rowAnsi(l)).join("\n");
  assert.ok(t.includes("ctx 36k"), `contextLen 段应显示 ctx 36k (got ${t})`);
  assert.ok(t.includes("cache 67%"), "cacheHit 段应显示 cache 67%");
});

test("renderStatusLine: token 缩写 k/M（12.4k / 1.5M），零总量回占位", () => {
  const mid = renderStatusLine(baseStatus, 120, {
    input: 12400,
    output: 0,
    cacheRead: 0,
  });
  assert.ok(
    mid
      .map((l) => rowAnsi(l))
      .join("\n")
      .includes("ctx 12.4k"),
  );
  const big = renderStatusLine(baseStatus, 120, {
    input: 1500000,
    output: 0,
    cacheRead: 0,
  });
  assert.ok(
    big
      .map((l) => rowAnsi(l))
      .join("\n")
      .includes("ctx 1.5M"),
  );
  const zero = renderStatusLine(baseStatus, 120, {
    input: 0,
    output: 0,
    cacheRead: 0,
  });
  assert.ok(
    zero
      .map((l) => rowAnsi(l))
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
    .map((l) => rowAnsi(l))
    .join("\n");
  const plain = joined.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(plain.includes("bash ls"), "工具调用行 ○ name summary");
  assert.ok(plain.includes("✓ 总用量 0"), "成功结果行 ✓ detail");
  assert.ok(plain.includes("✗ EACCES: 13"), "失败结果行 ✗ detail");
  assert.ok(
    joined.includes("\x1b[38;2;253;0;19m✗ EACCES: 13"),
    "失败工具行着红(253;0;19)",
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
    .map((l) => rowAnsi(l))
    .join("\n");
  assert.ok(
    joined.includes("\x1b[38;2;128;135;142m日志"),
    "log → 次要灰(L2 #80878E)",
  );
  assert.ok(joined.includes("\x1b[38;2;90;152;243m提示"), "info → 蓝");
  assert.ok(joined.includes("\x1b[38;2;233;201;68m黄"), "warn → 黄");
  assert.ok(joined.includes("\x1b[38;2;253;0;19m红"), "error → 红");
  assert.ok(joined.includes("\x1b[38;2;97;211;131m绿"), "success → 绿");
});

test("buildFrame: 工具历史不按组数折叠，只受活动 pane 可视行数约束（超出可上滚回看）", () => {
  let s = initialState();
  // 6 次调用组（每次 * + +）：过去按固定组数上限（=4）折叠掉前两组，
  // 现在全部保留（只受 pane 高约束，pane 外的内容可上滚回看）
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
  const strip = (rows: ReturnType<typeof buildFrame>): string =>
    rows
      .map((l) => rowAnsi(l))
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
  const SIZE = { rows: 20, cols: 50 };
  const plain = strip(buildFrame(s, SIZE));
  assert.ok(
    !plain.includes("更早工具调用已隐藏"),
    "不再出现按组数折叠的占位行",
  );
  assert.ok(plain.includes("cmd 6"), "最新调用应保留在活动区窗口");
  assert.ok(plain.includes("ok 6"), "最新结果应保留");
  // 折叠点 = pane 高：可见行数恰为 activityH，更早内容在 pane 外（内容仍在缓冲里）
  const g = frameGeometry(s, SIZE);
  assert.equal(g.mode, "vertical");
  const scrolled = strip(
    buildFrame(reduceState(s, { type: "activity-scroll", delta: 100 }), SIZE),
  );
  assert.ok(
    scrolled.includes("cmd 1") && scrolled.includes("ok 1"),
    "上滚可回看最早调用（内容未被折叠掉）",
  );
  // 组间不再插空行：cmd5 组与 cmd6 组之间的区域不含空行（旧行为有 1 个）
  const lines = strip(buildFrame(s, SIZE)).split("\n");
  const i5 = lines.findIndex((l) => l.includes("cmd 5"));
  const i6 = lines.findIndex((l) => l.includes("cmd 6"));
  assert.ok(i5 >= 0 && i6 > i5, "cmd5/cmd6 均在帧中");
  assert.equal(
    lines.slice(i5, i6).filter((l) => l.replace(/[│|\s]/g, "") === "").length,
    0,
    "窗口内组间不再有空行（紧凑拼接）",
  );
});

test("buildFrame: step 分组头渲染为 `╌╌ step N ╌╌╌` 历史虚线整行（与 turn 分隔一致），后无空行", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "step",
    sessionId: "s1",
    turn: 1,
    step: 123,
    phase: "start",
  });
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
  const lines = buildFrame(s, { rows: 20, cols: 50 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const sep = lines.findIndex((l) => l.includes("╌╌ step 123"));
  assert.ok(sep >= 0, "虚线 step 分隔行存在: " + lines.join("|"));
  // 活动区行带左缩进 + 右缘竖线：段头前后均为与 turn 一致的历史虚线段（╌，到竖线前）
  const head = "╌╌ step 123 ";
  const after = lines[sep]!.slice(lines[sep]!.indexOf(head) + head.length);
  assert.ok(
    /^ *╌+│? *$/.test(after) && after.includes("╌"),
    "step 段头后为与 turn 分隔一致的历史虚线段（╌）直至行尾/竖线: " +
      JSON.stringify(lines[sep]),
  );
  assert.ok(
    (lines[sep + 1] ?? "").includes("bash ls"),
    "step 虚线后紧跟工具行，不再插入空行: " + JSON.stringify(lines[sep + 1]),
  );
});

test("buildFrame: step 分割行前吸收空活动行（前文结束即接分割行）", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "step",
    sessionId: "s1",
    turn: 1,
    step: 1,
    phase: "start",
  });
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
    detail: "ok 1",
  });
  // 前文之后积一空 notice 行（空段拖尾，如多行 notice 的末尾换行）——分割行须吸收
  s = reduceState(s, {
    type: "notice",
    tone: "info",
    text: "中间提示\n",
    error: false,
  });
  s = reduceState(s, {
    type: "step",
    sessionId: "s1",
    turn: 1,
    step: 2,
    phase: "start",
  });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "pwd",
  });
  s = reduceState(s, {
    type: "tool-result",
    sessionId: "s1",
    ok: true,
    detail: "ok 2",
  });
  const lines = buildFrame(s, { rows: 20, cols: 50 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const blank = (l: string): boolean => l.replace(/[│|\s]/g, "") === "";
  const sep = lines.findIndex((l) => l.includes("╌╌ step 2"));
  assert.ok(sep >= 0, "step 2 分割行存在: " + lines.join("|"));
  assert.ok(
    !blank(lines[sep - 1]!),
    "分割行上一行非空: " + JSON.stringify(lines[sep - 1]),
  );
  assert.ok(
    (lines[sep + 1] ?? "").includes("bash pwd"),
    "分割行后紧跟工具行: " + JSON.stringify(lines[sep + 1]),
  );
});

test("buildFrame: 思考以换行结尾时 step 分割行前不显示空行（真实流式场景）", () => {
  let s = initialState();
  s = reduceState(s, {
    type: "step",
    sessionId: "s1",
    turn: 1,
    step: 1,
    phase: "start",
  });
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
    detail: "ok 1",
  });
  // step 之间模型输出以 \n 结尾的思考增量（buffer 留空 thinking 锚点段）
  s = reduceState(s, { type: "thinking", text: "好的，下一步执行\n" });
  s = reduceState(s, {
    type: "step",
    sessionId: "s1",
    turn: 1,
    step: 2,
    phase: "start",
  });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "pwd",
  });
  s = reduceState(s, {
    type: "tool-result",
    sessionId: "s1",
    ok: true,
    detail: "ok 2",
  });
  const lines = buildFrame(s, { rows: 20, cols: 50 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const blank = (l: string): boolean => l.replace(/[│|\s]/g, "") === "";
  const sep = lines.findIndex((l) => l.includes("╌╌ step 2"));
  assert.ok(sep >= 0, "step 2 分割行存在: " + lines.join("|"));
  assert.ok(
    (lines[sep - 1] ?? "").includes("┃好的，下一步执行") ||
      (lines[sep - 1] ?? "").includes("好的，下一步执行"),
    "分割行上一行即思考行（无空行）: " + JSON.stringify(lines[sep - 1]),
  );
  assert.ok(!blank(lines[sep - 1]!), "思考行与分割行之间无空行");
});

test("buildFrame: notice 纯换行紧贴 step 头被吸收（无视觉空行）", () => {
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
    detail: "ok 1",
  });
  // notice 文本恰为单个换行：剥离尾部换行后节点变空 → 连续吸收（不留空行）
  s = reduceState(s, {
    type: "notice",
    tone: "warn",
    text: "\n",
    error: false,
  });
  s = reduceState(s, {
    type: "step",
    sessionId: "s1",
    turn: 1,
    step: 2,
    phase: "start",
  });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "pwd",
  });
  const lines = buildFrame(s, { rows: 20, cols: 50 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const blank = (l: string): boolean => l.replace(/[│|\s]/g, "") === "";
  const sep = lines.findIndex((l) => l.includes("╌╌ step 2"));
  assert.ok(sep >= 0, "step 2 分割行存在: " + lines.join("|"));
  assert.ok(!blank(lines[sep - 1]!), "纯换行 notice 被吸收，分割行前无空行");
  assert.ok((lines[sep + 1] ?? "").includes("bash pwd"), "分割行后紧跟工具行");
});

test("buildFrame: notice 尾换行被吸收但正文保留（中间提示场景）", () => {
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
    detail: "ok 1",
  });
  s = reduceState(s, {
    type: "notice",
    tone: "info",
    text: "中间提示\n",
    error: false,
  });
  s = reduceState(s, {
    type: "step",
    sessionId: "s1",
    turn: 1,
    step: 2,
    phase: "start",
  });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: "pwd",
  });
  const lines = buildFrame(s, { rows: 20, cols: 50 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const blank = (l: string): boolean => l.replace(/[│|\s]/g, "") === "";
  const sep = lines.findIndex((l) => l.includes("╌╌ step 2"));
  assert.ok(sep >= 0, "step 2 分割行存在: " + lines.join("|"));
  assert.ok(
    (lines[sep - 1] ?? "").includes("中间提示"),
    "分割行上一行保留 notice 正文: " + JSON.stringify(lines[sep - 1]),
  );
  assert.ok(!blank(lines[sep - 1]!), "notice 正文行与分割行之间无空行");
});

test("buildFrame: 两次调用组之间不再插空行（紧凑拼接，虚线 step 才分隔）", () => {
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
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  const i1 = lines.findIndex((l) => l.includes("run 1"));
  const i2 = lines.findIndex((l) => l.includes("run 2"));
  assert.ok(i1 >= 0 && i2 >= 0, "两次调用都应出现");
  assert.equal(
    lines.slice(i1, i2).filter((l) => l.replace(/[│|\s]/g, "") === "").length,
    0,
    "两次调用之间不再有空行（紧凑拼接）",
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
    .map((l) => rowAnsi(l))
    .join("\n");
  // dark 主题 24bit 码：黄 #E9C944 / 绿 #61D383 / 红 #FD0013
  assert.ok(
    joined.includes("\x1b[38;2;233;201;68mbash"),
    "工具名着黄（无前缀图标）",
  );
  assert.ok(joined.includes("\x1b[38;2;97;211;131m✓"), "✓ 前缀着绿");
  assert.ok(joined.includes("\x1b[38;2;253;0;19m✗ EACCES"), "✗ 失败整行着红");
});

test("buildFrame: 工具调用长参数换行——仅首行工具名着黄，续行不再按首个空格染黄", () => {
  // 回归：活动区工具行超宽换行时，旧实现按 buffer 行号 li===0 染黄，
  // 续行（参数被截断的中段）也会把「第一个空格前的内容」染黄。
  // 修复后仅调用行的首换行行（ri===0）染工具名，续行为普通前景色。
  const LONG =
    "-c 'echo this-is-a-very-long-argument-string-that-exceeds-width'";
  let s = initialState();
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s1",
    name: "bash",
    summary: LONG,
  });
  const plain = buildFrame(s, { rows: 24, cols: 60 }).map((l) =>
    rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""),
  );
  // 工具调用行按列宽换行为多行：定位首行（含 bash + 参数头），连读后续非空活动行
  const start = plain.findIndex((l) => l.includes("bash"));
  assert.ok(start >= 0 && start + 1 < plain.length, "工具调用行应存在");
  const block: string[] = [plain[start]!];
  for (let i = start + 1; i < plain.length && plain[i]!.trim() !== ""; i++)
    block.push(plain[i]!);
  // 整行宽 60、参数超宽 → 至少拆成 2 行
  assert.ok(block.length >= 2, "工具调用行应发生换行: " + block);
  const YELLOW = "\x1b[38;2;233;201;68m";
  const colored = buildFrame(s, { rows: 24, cols: 60 }).map((l) => rowAnsi(l));
  const firstRow = colored[start]!;
  const restRows = colored
    .slice(start + 1, start + block.length)
    .filter((l) => l.replace(/\x1b\[[0-9;]*m/g, "") !== "");
  assert.ok(
    firstRow
      .replace(/\x1b\[[0-9;]*m/g, "")
      .trimStart()
      .startsWith("bash "),
    "首行为工具调用原始行",
  );
  assert.ok(firstRow.includes(YELLOW), "首行工具名着黄");
  for (let i = 0; i < restRows.length; i++) {
    assert.ok(
      !restRows[i]!.includes(YELLOW),
      `续行 ${i + 1} 不应染黄（参数续行保持文本前景色）`,
    );
  }
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
    .map((l) => rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""))
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
    .map((l) => rowAnsi(l).replace(/\x1b\[[0-9;]*m/g, ""))
    .join("\n");
  assert.ok(plain.includes("正在压缩上下文..."), "start toast");
  assert.ok(plain.includes("压缩完成"), "end toast");
  assert.ok(
    plain.includes("重试 1/2 (1.5s): TRANSPORT 连接被重置"),
    "retry toast 文案",
  );
});

test("renderStatusLine: cache 命中率取整（全命中 → cache 100%）", () => {
  const t = renderStatusLine(baseStatus, 120, {
    input: 500,
    output: 500,
    cacheRead: 9500,
  })
    .map((l) => rowAnsi(l))
    .join("\n");
  assert.ok(t.includes("ctx 10k"), "total=10000 → ctx 10k");
  assert.ok(t.includes("cache 95%"), "9500/10000 → cache 95%");
  const full = renderStatusLine(baseStatus, 120, {
    input: 0,
    output: 100,
    cacheRead: 20000,
  })
    .map((l) => rowAnsi(l))
    .join("\n");
  assert.ok(full.includes("cache 100%"), "cacheRead 全命中 → cache 100%");
});

test("renderStatusLine: 极窄列(<24 列)省略标题段时 usage ctx/cache 段仍保留", () => {
  const t = renderStatusLine(baseStatus, 20, {
    input: 12400,
    output: 0,
    cacheRead: 0,
  })
    .map((l) => rowAnsi(l))
    .join("\n");
  assert.ok(t.includes("ctx 12.4k"), "窄列下 contextLen 段保留");
  assert.ok(!t.includes("新会话"), "窄列下标题段省略");

  // --- 会话徽标位于顶部状态列 Mode 块（见 modeBlock）：plan/sandbox/permission/
  //     ask/preset/jobs；水平状态栏不承载会话徽标 ---

  test("renderStatusLine: 会话徽标已全部移除（已移入顶部状态列 Mode 块；jobs 不再显示）", () => {
    const t = renderStatusLine(baseStatus, 120, undefined)
      .map((l) => rowAnsi(l))
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
      .map((l) => rowAnsi(l))
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
    const plain = buildFrame(st, { rows: 30, cols: 60 }).map((l) => rowAnsi(l));
    const sep = activitySepIdx(plain, 60);
    // 状态栏上方 ─ 分隔行：D 列交点恒为灰 ┴、框线竖线交点 ┬（无焦点不再延续活动区点线）
    const end = plain.findIndex(
      (l, i) => i > sep && /^[─┴┬]+$/.test(stripAnsi(l)),
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
  // dark 主题焦点框=L4 强调 brightWhite #FFFFFF；light 主题应取黑（单独断言 focusFrameColor）
  const WHITE = "\x1b[38;2;255;255;255m";
  const size = { rows: 24, cols: 80 } as const;
  // 对调后：历史/活动区在左（宽 historyWidth=60），详细状态列在右（宽 statusColWidth=20）
  const m = metricsFor(size, false);
  const D = m.historyWidth; // 60：分隔竖线列（历史区右缘/状态列左缘）
  const rowsOf = (st: ReturnType<typeof initialState>): string[] =>
    buildFrame(st, size).map((l) => rowAnsi(l));
  const plain = (l: string): string => stripAnsi(l);
  const sepRow = (lines: string[]): string => {
    const i = activitySepIdx(lines, size.cols);
    return i >= 0 ? lines[i]! : "";
  };
  const eqRow = (lines: string[]): string =>
    lines.find(
      (l) =>
        /^[└─]+/.test(plain(l)) &&
        plain(l).includes("┴") && // 标题栏下划线行无 ┴，仅状态区上方分隔行含 ┴
        !plain(l).includes("（新会话）"),
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

  // 默认无焦点（null）：三面板全不高亮——标题栏即顶部（无独立顶部边框行），
  // 两侧框列空白占位、无亮角
  let st = initialState();
  let rows = rowsOf(st);
  const b0 = rows[0]!;
  assert.ok(plain(b0).includes("<title>"), "无焦点：顶部首行为标题栏");
  assert.ok(!plain(b0).includes("─"), "无焦点：标题行不画 ─");
  assert.ok(!plain(b0).includes("┌"), "无焦点：顶部无角");
  assert.ok(!b0.includes(WHITE), "无焦点：标题行无亮色");
  const s0 = sepRow(rows);
  assert.ok(!s0.includes(WHITE + "─"), "无焦点：活动区分隔 ╌ 不亮（回灰）");
  const dlg = rows.find((l) => plain(l).includes("<title>"))!;
  assert.ok(!plain(dlg).startsWith("│"), "无焦点：左缘框格空白占位");
  assert.ok(colAt(dlg, D) === "│", "无焦点：分隔竖线恒位于 D 列（灰）");
  assert.ok(
    plain(dlg).slice(0, D).includes("<title>"),
    "无焦点：会话标题在左侧标题栏（历史区上方、分隔竖线左侧）",
  );
  assert.ok(!eqRow(rows).includes(WHITE + "─"), "无焦点：状态区上方分隔无亮 ─");
  const sepIdx0 = activitySepIdx(rows, size.cols);
  assert.equal(countBrightBar(rows[sepIdx0 + 1]!), 0, "无焦点：活动行无亮 │");
  assert.ok(
    rows.slice(0, topRows).every((l) => displayWidth(plain(l)) === 80),
    "所有内容行补齐到整屏宽（右缘框线恒在固定列）",
  );
  assert.ok(
    rows
      .slice(1, sepIdx0)
      .filter(
        (l) =>
          !/^─+$/.test(plain(l).slice(0, D).trim()) &&
          !/^─+$/.test(
            plain(l)
              .slice(D + 1)
              .replace(/\s+$/, ""),
          ),
      )
      .every((l) => colAt(l, D) === "│"),
    "无焦点：对话区各行分隔竖线仍恒位于 D 列（灰；标题栏下划线行 D 列 ┤ 除外）",
  );
  const sigHistory = contentSig(rows, topRows);

  // 焦点=历史（左列）：Tab 一次进入——标题栏下划线行兼作顶边 ┌─┐（标题行不在焦点
  // 窗口：左缘空白、D 列竖线灰）、活动区分隔 ─ 亮 + 两端 ┘、对话区左缘/分隔竖线亮 │
  st = reduceState(initialState(), { type: "focus-panel-cycle" }); // null → 历史
  rows = rowsOf(st);
  const bH = rows[1]!; // 下划线行（顶边）
  assert.ok(plain(bH).includes("─"), "历史焦点：下划线行兼作顶边画 ─");
  assert.ok(plain(bH).includes("┌"), "历史焦点：左上角 ┌");
  assert.ok(colAt(bH, D) === "┐", "历史焦点：右上角 ┐（分隔竖线列）");
  assert.ok(bH.includes(WHITE), "历史焦点：顶边/竖线亮白");
  const titleH = rows.find((l) => plain(l).includes("<title>"))!;
  assert.ok(
    !plain(titleH).startsWith("│"),
    "历史焦点：标题行左缘空白（标题不在焦点窗口）",
  );
  assert.equal(
    countBrightBar(titleH),
    0,
    "历史焦点：标题行无亮框线（D 列竖线也保持灰）",
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
  const dlgA = rows.find((l) => plain(l).includes("<title>"))!;
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
  const dlgS = rows.find((l) => plain(l).includes("<title>"))!;
  assert.ok(
    !plain(dlgS).startsWith("│"),
    "状态焦点：左缘空白占位（状态列在右）",
  );
  assert.ok(
    dlgS.includes(WHITE + "┌") && colAt(dlgS, 79) === "┐",
    "状态焦点：标题行状态列顶边角 ┌/┐ 亮白（顶边从 D 列起）",
  );
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
    !/\x1b\[38;2;255;255;255m[╌─│┐┘└┌┴]/.test(whole),
    "面板态：无亮白框线",
  );
  assert.ok(!plain(rows[0]!).includes("─"), "面板态：顶部边框行空白占位");
  // 面板态：审批/问答/选择面板渲染在流输出（活动区）窗口
  // （分隔行之后），而非底部交互区；对话历史/状态列内容不被挤占（无缓冲仍空）
  const sepI2 = activitySepIdx(rows, size.cols);
  const actRows2 = rows.slice(sepI2 + 1, topRows).map(plain);
  assert.ok(
    actRows2.some((l) => l.includes("deepseek")),
    "面板态：模型选择面板显示在流输出窗口",
  );
  assert.ok(
    rows
      // 跳过标题栏（标题行 + 下划线），只查对话历史区正文
      .slice(1 + TITLE_BAR_ROWS, sepI2)
      .every((l) => plain(l).slice(1, m.historyWidth).trim() === ""),
    "面板态：对话历史区仍空（未因面板挤占重排）",
  );

  // focusFrameColor：语义色名 "focus"，取色由各主题 semantics 解析
  //（dark=bright[7] #FFFFFF、light=ansi[0] #121418——即旧 L4 强调 slot）
  assert.equal(focusFrameColor(), "focus");
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

test("对话区：渐进窗口（跟底只物化最近 N 组，上滚逐步扩窗露出更早回复）", () => {
  let s = initialState();
  // 8 组回复（> DIALOGUE_KEEP_REPLIES=3），每组多行 → 3 组物化即超出 24 行终端的一屏
  for (let i = 1; i <= 8; i++) {
    s = reduceState(s, { type: "user-line", text: `Q${i}` });
    for (let k = 0; k < 4; k++)
      s = reduceState(s, {
        type: "append",
        text: `A${i} 的回复正文第 ${k} 行`,
      });
    s = reduceState(s, { type: "turn-end" }); // 回复标 final 进历史区
  }
  const size = { rows: 24, cols: 80 };
  const geomOf = (st: typeof s) => {
    const r = emptyReportForTest();
    buildFrame(st, size, r);
    return r.dialogueGeometry;
  };
  const frame = (st: typeof s): string =>
    buildFrame(st, size)
      .map((l) => rowAnsi(l))
      .join("\n");
  // 跟随底部：只物化最近 3 个回合组 → 首行是「更早回复已折叠」占位（line = -1）
  const g0 = geomOf(s);
  assert.equal(s.windowGroups, 3, "默认窗口 = 最近 3 个回合组");
  assert.equal(g0.spans[0]!.seq, -1, "窗口未覆盖最旧内容 → 顶部物化占位行");
  assert.ok(!frame(s).includes("A1 的回复正文"), "窗口外的更早回复未物化");
  const groups0 = s.windowGroups;
  // 上滚：接近窗口顶部时按步长增窗；锚点保证同一内容留在视口顶行
  let topBefore = "";
  let grew = false;
  for (let i = 0; i < 12; i++) {
    const before = geomOf(s);
    const rowAtTop = buildFrame(s, size)
      .map((l) => rowText(l))
      .slice(before.height === 0 ? 0 : 0);
    void rowAtTop;
    s = reduceState(s, { type: "scroll", delta: 6, geom: before });
    const after = geomOf(s);
    if (s.windowGroups > groups0) {
      grew = true;
      // 增窗后锚点未变：同一 (buffer 行, 行内行号) 仍在视口顶行
      assert.deepEqual(
        s.scrollAnchor,
        indexToAnchor(after.spans, after.topIdx),
      );
      topBefore = s.scrollAnchor ? `${s.scrollAnchor.seq}` : "";
      break;
    }
    void after;
  }
  assert.ok(grew, "上滚接近窗口顶部时增窗");
  assert.ok(topBefore !== "", "增窗后仍持有锚点（非跟随底部）");
  // 继续上滚到顶：更早的回复出现（窗口已覆盖）
  for (let i = 0; i < 60; i++) {
    s = reduceState(s, { type: "scroll", delta: 6, geom: geomOf(s) });
  }
  assert.ok(frame(s).includes("A1 的回复正文"), "扩窗后更早回复可见");
  // 回到底部：窗口复位默认组数（释放增量物化）
  s = reduceState(s, { type: "scroll-to-bottom" });
  assert.equal(s.windowGroups, 3, "回底复位窗口");
  assert.equal(s.scrollAnchor, null, "回底 = 锚点 null（跟随底部）");
});

test("活动区新输出不推历史：非 final 中间输出不算窗口组，不折叠旧回复", () => {
  // 回归：turnGroupStarts 曾把活动区（思考/工具/非 final assistant）也算组起点，
  // agent 持续输出会把历史窗口向前挤、折叠旧回复——历史区被活动区“推着滚动”。
  let s = initialState();
  // 5 个真实回合（用户 + turn-begin + 回复 + turn-end）
  for (let i = 1; i <= 5; i++) {
    s = reduceState(s, { type: "user-line", text: `Q${i}` });
    s = reduceState(s, { type: "turn-begin" });
    s = reduceState(s, { type: "append", text: `A${i}` });
    s = reduceState(s, { type: "turn-end" });
  }
  const size = { rows: 24, cols: 80 };
  const geomOf = (st: typeof s) => {
    const r = emptyReportForTest();
    buildFrame(st, size, r);
    return r.dialogueGeometry;
  };
  const g0 = geomOf(s);
  // 只来活动区内容：思考 + 工具 + 非 final 中间输出（均不进历史区）
  s = reduceState(s, { type: "thinking", text: "思考…" });
  s = reduceState(s, {
    type: "tool-call",
    sessionId: "s",
    name: "bash",
    summary: "ls",
  });
  for (const t of ["中间输出1", "中间输出2"]) {
    s = reduceState(s, { type: "append", text: t });
  }
  const g1 = geomOf(s);
  assert.deepEqual(g1.spans, g0.spans, "历史窗口不被活动区折叠/移位");
  assert.equal(g1.rows, g0.rows, "历史行数不变");
  assert.equal(s.windowGroups, 3, "窗口组数不被活动区撑大");
});

test("滚动历史区不改变活动区：两 pane 滚动独立", () => {
  // 回归：活动区内容若受渐进窗口切片影响，滚动历史会改变活动区显示。
  // 固定横向排列（活动 pane 在左、历史 pane 在右），滚动历史只许改右侧对话区。
  let s = initialState(undefined, {
    activityPlacement: "horizontal" as const,
  });
  for (let i = 1; i <= 4; i++) {
    s = reduceState(s, { type: "user-line", text: `Q${i}` });
    s = reduceState(s, { type: "turn-begin" });
    s = reduceState(s, { type: "append", text: `回复正文行${i}` });
    s = reduceState(s, { type: "turn-end" });
  }
  // 当前回合：大量活动区内容（非 final 中间输出 + 工具 + step）
  s = reduceState(s, { type: "turn-begin" });
  for (let n = 1; n <= 12; n++) {
    s = reduceState(s, {
      type: "step",
      phase: "start",
      sessionId: "s",
      turn: 1,
      step: n,
    });
    s = reduceState(s, {
      type: "tool-call",
      sessionId: "s",
      name: "bash",
      summary: `cmd${n}`,
    });
    s = reduceState(s, {
      type: "tool-result",
      sessionId: "s",
      ok: true,
      detail: `out${n}`,
    });
    s = reduceState(s, {
      type: "step",
      phase: "end",
      sessionId: "s",
      turn: 1,
      step: n,
    });
  }
  const size = { rows: 18, cols: 100 };
  const g = frameGeometry(s, size);
  assert.equal(g.mode, "horizontal", "用例固定横向排列");
  const div = FRAME_LEFT_COLS + g.activityW;
  const colText = (l: string, from: number, to: number): string => {
    let out = "";
    let w = 0;
    for (const ch of l) {
      const cw = displayWidth(ch);
      if (w >= to) break;
      if (w >= from && w + cw <= to) out += ch;
      w += cw;
    }
    return out.trimEnd();
  };
  const region = (from: number, to: number): string[] => {
    const rows = buildFrame(s, size).map((r) =>
      r.segments.map((x) => x.text).join(""),
    );
    const out: string[] = [];
    for (let i = g.titleRows; i < g.titleRows + g.activityH; i++)
      out.push(colText(rows[i]!, from, to));
    return out;
  };
  const act = (): string[] => region(FRAME_LEFT_COLS, div);
  const dia = (): string[] => region(div + 1, div + 1 + g.dialogueW);
  const actBase = act();
  const diaBase = dia();
  // 滚动历史区（对话）：先补算几何再应用 scroll
  const r: FrameScrollReport = emptyReportForTest();
  buildFrame(s, size, r);
  let s2 = s;
  for (let i = 0; i < 6; i++) {
    s2 = reduceState(s2, {
      type: "scroll",
      delta: 1,
      geom: r.dialogueGeometry,
    } as never);
  }
  const old = s;
  s = s2;
  const actAfter = act();
  const diaAfter = dia();
  s = old;
  assert.notDeepEqual(diaAfter, diaBase, "历史 pane 本身确实滚动了");
  assert.deepEqual(actAfter, actBase, "活动 pane 不受历史滚动影响");
});

/** 测试用空报告（字段与 FrameScrollReport 对齐） */
function emptyReportForTest(): FrameScrollReport {
  return {
    dialogueMaxScroll: 0,
    activityMaxScroll: 0,
    dialogueGeometry: { rows: 0, height: 0, spans: [], topIdx: 0 },
    dialogueTop: { seq: 0, row: 0 },
  };
}

// --- /session 历史面板在活动区（modalPanel）的回归：标题对齐 + 按键提示位置 ---

/** 历史面板帧：打开（all=true 切到「全部」范围）+ list/error 阶段记录（两个目录） */
function historyFrame(
  kind: "loading" | "list" | "error",
  rows = 24,
  cols = 80,
  all = false,
): string[] {
  let s = initialState();
  // 状态区 cwd 已知：默认「当前目录」范围可解析
  s = reduceState(s, { type: "status", status: { cwd: "/proj" } });
  s = reduceState(s, { type: "history-open" });
  if (kind === "list" || kind === "error") {
    s = reduceState(s, {
      type: "history-list",
      records: [
        {
          id: "s42",
          createdAt: 1,
          live: false,
          persisted: true,
          title: "历史标题",
          cwd: "/proj",
        },
        {
          id: "s43",
          createdAt: 2,
          live: false,
          persisted: true,
          title: "他目录标题",
          cwd: "/other",
        },
      ],
    });
  }
  if (kind === "error")
    s = reduceState(s, { type: "history-list-error", error: "boom" });
  if (all) s = reduceState(s, { type: "history-scope-toggle" });
  return buildFrame(s, { rows, cols }).map((l) =>
    stripAnsi(typeof l === "string" ? l : rowAnsi(l)),
  );
}

test("/session 历史面板：标题按显示宽补齐，活动区右缘框线不错位（CJK 标题顶不开）", () => {
  // 旧实现 title.padEnd(width) 按 JS 字符串长度补齐：CJK 显示宽 2 → 标题行
  // 显示宽超 contentW，右缘框线 │ 被顶开。面板上移到活动区后此问题暴露。
  // 比较须用「│ 的显示列」（lastIndexOf 是字符索引，CJK 会偏移）。
  const borderDispCol = (row: string): number => {
    const i = row.lastIndexOf("│");
    return i < 0 ? -1 : displayWidth(row.slice(0, i));
  };
  for (const kind of ["loading", "list", "error"] as const) {
    const plain = historyFrame(kind);
    // 各阶段面板标题行：loading=历史会话、list=历史会话（N）、error=加载失败
    const titleMark = kind === "error" ? "加载失败" : "历史会话";
    const titleIdx = plain.findIndex((l) => l.includes(titleMark));
    assert.ok(titleIdx >= 0, `${kind}: 面板标题行存在（${titleMark}）`);
    const expect = borderDispCol(plain[titleIdx]!);
    assert.ok(expect > 0, `${kind}: 标题行有右缘框线`);
    // 后续行（面板正文/空行）右缘框线显示列必须与标题行一致
    let checked = 0;
    for (let i = titleIdx + 1; i < plain.length && checked < 4; i++) {
      if (!plain[i]!.includes("│")) continue;
      assert.equal(
        borderDispCol(plain[i]!),
        expect,
        `${kind}: row ${i} 右缘框线对齐（标题行 ${expect}）`,
      );
      checked++;
    }
  }
});

test("/session 历史面板：按键提示在输入区下方提示区，不内嵌面板标题行", () => {
  const plain = historyFrame("list");
  const titleRow = plain.find((l) => l.includes("历史会话 ["));
  assert.ok(titleRow, "list 阶段标题行存在");
  assert.ok(
    !titleRow!.includes("[↑/↓]") && !titleRow!.includes("[Enter]"),
    "标题行不再内嵌按键提示",
  );
  // 末行 = 输入区下方提示区，显示历史面板键位
  const last = plain[plain.length - 1]!;
  assert.ok(
    last.includes("[↑/↓]移动") && last.includes("[Enter]切换"),
    "提示区显示历史面板按键提示: " + last,
  );
  // 提示行之上为空白占位（输入区）
  const footerRow = plain[plain.length - 2]!;
  assert.equal(footerRow.trim(), "", "输入区空白占位");
});

test("/session 历史面板 error 阶段：标题短、提示区显示 [Esc]关闭", () => {
  const plain = historyFrame("error");
  const titleRow = plain.find((l) => l.includes("加载失败"));
  assert.ok(titleRow, "error 标题行存在");
  assert.ok(!titleRow!.includes("[Esc]"), "标题行不内嵌 [Esc]关闭");
  const last = plain[plain.length - 1]!;
  assert.ok(last.includes("[Esc]关闭"), "提示区显示关闭键位: " + last);
});

// ===== 对话区翻页：↑/↓ 半屏 + PgUp/PgDn 用户输入跳转 =====

test("dialogueHalfPage：半屏取整且至少 1 行", () => {
  assert.equal(dialogueHalfPage(6), 3);
  assert.equal(dialogueHalfPage(7), 3);
  assert.equal(dialogueHalfPage(1), 1);
  assert.equal(dialogueHalfPage(0), 1);
});

test("frameGeometry：正文宽/可视高与 buildFrame 同口径（rows=24/cols=80）", () => {
  const m = frameGeometry(initialState(), { rows: 24, cols: 80 });
  assert.equal(m.dialogueH, 6, "对话区可视行（标题栏 2 行由对话区承担后）");
  assert.equal(m.viewportH, 6, "无排队块 → 历史视口 = 对话 pane 高");
  // historyWidth = 80 - floor(80/3) = 54，col0 左缘框格占 1 → contentW=53
  assert.equal(m.dialogueW, 53, "对话区正文宽 = historyWidth - 左缘框列");
});

test("userInputJump：PgUp/PgDn 把用户消息首行翻到顶行，后文不足一屏时填充前面历史", () => {
  const themeId = initialState().themeId;
  // 每行 1 条 wrapped 行（短文本 + 宽列不换行），块间空行由布局层插入：
  // 0=u1 1=<空> 2=a1 3=u2 4=<空> 5=a2 6=u3 7=<空> 8=a3，共 9 行，用户块首行 [0,3,6]
  const buffer: Buffer = [
    { text: "u1", kind: "user" },
    { text: "a1", kind: "assistant", final: true },
    { text: "u2", kind: "user" },
    { text: "a2", kind: "assistant", final: true },
    { text: "u3", kind: "user" },
    { text: "a3", kind: "assistant", final: true },
  ];
  const H = 4;
  // 跟随底部（start=5）：PgUp 跳上一条用户消息 u2（buffer 行 2）顶对齐
  assert.deepEqual(
    userInputJump(buffer, 60, 4, themeId, H, 5, 0, 1),
    { seq: 2, row: 0 },
    "跟随底部 PgUp：跳到上一条用户输入并顶对齐",
  );
  // 继续 PgUp：当前视口首行=3（u2）→ 上一条 u1（buffer 行 0）
  assert.deepEqual(
    userInputJump(buffer, 60, 4, themeId, H, 3, 0, 1),
    { seq: 0, row: 0 },
    "再次 PgUp：跳到更早一条用户输入",
  );
  // 已到最早用户消息（start=0）：无更早 → null（视口不动）
  assert.equal(userInputJump(buffer, 60, 4, themeId, H, 0, 0, 1), null);
  // PgDn：从 start=0 跳下一条 u2 → 行 2
  assert.deepEqual(
    userInputJump(buffer, 60, 4, themeId, H, 0, 0, -1),
    { seq: 2, row: 0 },
    "PgDn：跳到下一条用户输入并顶对齐",
  );
  // 下一条 u3：u3 后文本不足一屏（6+4>9）→ 收敛到底对齐（锚点指到底对齐那一行）
  const rows = buildContentRows(buffer, { themeId, gutter: 4 }, 60).dialogue;
  const spans = dialogueSpans(rows);
  const jump = userInputJump(buffer, 60, 4, themeId, H, 3, 0, -1)!;
  assert.equal(
    anchorToIndex(spans, jump),
    Math.min(6, rows.length - H),
    "最后一条用户消息后文不足一屏：填充前面历史（底对齐）",
  );
  // 窗口切片：lineOffset=3（窗口从 u2 起）时锚点用绝对行号
  assert.deepEqual(
    userInputJump(buffer.slice(2), 60, 4, themeId, H, 3, 2, 1),
    { seq: 2, row: 0 },
    "窗口切片下锚点取绝对 buffer 行号",
  );
});

test("userInputJump：PgDn 无下一条用户消息 → null（调用方回到底部）；边界返回 null", () => {
  const themeId = initialState().themeId;
  const single: Buffer = [
    { text: "u1", kind: "user" },
    { text: "a1", kind: "assistant", final: true },
  ];
  // 视口首行已是唯一用户块之上（start=0）：无下一条 → null（App 走 scroll-to-bottom）
  assert.equal(userInputJump(single, 60, 4, themeId, 4, 0, 0, -1), null);
  // 无任何用户块 → null
  assert.equal(
    userInputJump(
      [{ text: "a1", kind: "assistant", final: true }],
      60,
      4,
      themeId,
      4,
      0,
      0,
      1,
    ),
    null,
  );
  // 空 buffer → null
  assert.equal(userInputJump([], 60, 4, themeId, 4, 0, 0, 1), null);
  // 对话区不可见（dialogueH<=0）→ null
  assert.equal(userInputJump(single, 60, 4, themeId, 0, 0, 0, 1), null);
});

test("/session 历史面板：标题标明列表范围（当前目录 可见/全量 ⇄ 全部），提示含 [Tab]范围", () => {
  const project = historyFrame("list");
  const projectTitle = project.find((l) => l.includes("历史会话 ["));
  assert.ok(projectTitle, "标题行存在");
  assert.ok(
    projectTitle!.includes("历史会话 [当前目录]（1/2）"),
    "当前目录范围标题含可见/全量: " + projectTitle,
  );
  assert.ok(
    project.some((l) => l.includes("历史标题")),
    "当前目录会话可见",
  );
  assert.ok(
    !project.some((l) => l.includes("他目录标题")),
    "他目录会话默认隐藏",
  );
  const hint = project[project.length - 1]!;
  assert.ok(hint.includes("[Tab]范围"), "提示区含 [Tab]范围: " + hint);

  const all = historyFrame("list", 24, 80, true);
  const allTitle = all.find((l) => l.includes("历史会话 ["));
  assert.ok(
    allTitle!.includes("历史会话 [全部]（2）"),
    "全部范围标题: " + allTitle,
  );
  assert.ok(
    all.some((l) => l.includes("他目录标题")),
    "全部范围显示他目录会话",
  );
});

test("/session 历史面板：批量标记行标 *、标题标计数；批量删除确认列出数量", () => {
  let s = initialState();
  s = reduceState(s, { type: "status", status: { cwd: "/proj" } });
  s = reduceState(s, { type: "history-open" });
  s = reduceState(s, {
    type: "history-list",
    records: [
      {
        id: "s1",
        createdAt: 1,
        live: false,
        persisted: true,
        title: "甲",
        cwd: "/proj",
      },
      {
        id: "s2",
        createdAt: 2,
        live: false,
        persisted: true,
        title: "乙",
        cwd: "/proj",
      },
    ],
  });
  // 标记 s1（首行）→ 高亮自动下移到 s2
  s = reduceState(s, { type: "history-mark-toggle" });
  const rows = (state: Parameters<typeof buildFrame>[0]): string[] =>
    buildFrame(state, { rows: 24, cols: 80 }).map((l) =>
      stripAnsi(typeof l === "string" ? l : rowAnsi(l)),
    );
  const plain = rows(s);
  const title = plain.find((l) => l.includes("历史会话 ["));
  assert.ok(title?.includes("· 标记 1"), "标题含标记计数: " + title);
  const markedRow = plain.find((l) => l.includes("甲"));
  assert.ok(markedRow?.includes("*"), "标记行显示 * 标记: " + markedRow);

  // 未标记行无 *
  const unmarked = plain.find((l) => l.includes("乙"));
  assert.ok(unmarked && !unmarked.includes("*"), "未标记行无 *: " + unmarked);

  // 批量确认：标题 + 数量 + 预览
  s = reduceState(s, { type: "history-confirm-delete" });
  const confirm = rows(s);
  assert.ok(
    confirm.some((l) => l.includes("批量删除确认")),
    "批量确认标题",
  );
  assert.ok(
    confirm.some((l) => l.includes("删除标记的 1 个会话？")),
    "确认文案含标记数量",
  );
  assert.ok(
    confirm.some((l) => l.includes("- 甲（")),
    "确认预览列出标题",
  );
});

test("不变量：所有 FrameSegment.text 不含 ANSI 转义（C3 段级契约）", () => {
  // C3 契约不变量 #1：排版层产出段文本绝不含 ANSI（样式在 style 字段），
  // 渲染层 serial 才生成 SGR。对代表性帧（含 markdown/状态列/焦点框内容）全量断言。
  let s = initialState();
  s = reduceState(s, {
    type: "append",
    text: "**加粗** 与 `code` 与 [链接](http://x)",
  });
  s = reduceState(s, { type: "append", text: "第二行含宽字符—测试" });
  s = reduceState(s, { type: "turn-begin" });
  s = reduceState(s, { type: "append", text: "1. 有序列表项" });
  s = reduceState(s, { type: "append", text: "- 无序项" });
  const frame = buildFrame(s, { rows: 24, cols: 80 });
  assert.ok(frame.length > 10, "代表性帧行数充足");
  for (const row of frame) {
    assert.ok(
      row.segments.every((seg) => !seg.text.includes("\x1b[")),
      `段文本不得含 ANSI: ${JSON.stringify(row.segments.map((x) => x.text))}`,
    );
  }
});

test("buildFrame 回填滚动几何：上限随物化窗口（渐进），初始窗口为默认组数", () => {
  // 契约：dialogueMaxScroll = 物化窗口行数 − 可视行数（窗口缺省只含最近 3 个回合组），
  // 并回填语义锚点几何（行分组表/视口顶行）供 App 换算行位移。
  let s = initialState();
  for (let i = 1; i <= 12; i++) {
    s = reduceState(s, { type: "user-line", text: `问题 ${i}` }); // 回合组起点
    s = reduceState(s, { type: "turn-begin" }); // 回合分隔线：断开流式续写合并
    s = reduceState(s, {
      type: "append",
      text: `回复正文行 ${i}甲\n回复正文行 ${i}乙`,
    });
    s = reduceState(s, { type: "turn-end" });
  }
  for (let i = 0; i < 40; i++)
    s = reduceState(s, { type: "notice", text: `活动区行 ${i}` });
  const size = { rows: 24, cols: 80 };
  const report = emptyReport();
  buildFrame(s, size, report);
  assert.ok(report.dialogueMaxScroll > 0, "对话区可滚上限 > 0");
  assert.ok(report.activityMaxScroll > 0, "活动区可滚上限 > 0");
  assert.ok(report.dialogueGeometry.rows > 0, "回填物化行数");
  assert.ok(
    report.dialogueGeometry.rows < s.buffer.length,
    "窗口只物化尾部（渐进定位：不再整段历史入排版）",
  );
  // 窗口一次扩到全部回合组 → 物化行数随之增长（渐进扩窗）
  const bigger = emptyReport();
  buildFrame(reduceState(s, { type: "scroll-to-oldest" }), size, bigger);
  assert.ok(
    bigger.dialogueGeometry.rows > report.dialogueGeometry.rows,
    "扩窗后物化行数变多",
  );
  assert.ok(bigger.dialogueMaxScroll > report.dialogueMaxScroll);
});

/** 空滚动报告（测试用；字段与 FrameScrollReport 对齐） */
function emptyReport(): FrameScrollReport {
  return {
    dialogueMaxScroll: 0,
    activityMaxScroll: 0,
    dialogueGeometry: { rows: 0, height: 0, spans: [], topIdx: 0 },
    dialogueTop: { seq: 0, row: 0 },
  };
}
