// tests/question-window.test.ts — 面板分窗滚动 / 类型标识 / 选项形态 / 编辑光标
// （BACKLOG 3.2.1 / 3.2.2 / 3.2.3 / 3.2.7 的纯函数级验收）
//
// 覆盖：
//  1) 两窗高度分配：长题干 / 长 detail 不把选项挤出可视区
//  2) 描述窗滚动：↑/↓ 逐行滚动，上界由 maxDescScrollFor 给出并被 reducer clamp
//  3) 焦点窗：Tab 切换、↑/↓ 语义随之分派；焦点在描述窗时选项窗仍锚定已标记项
//  4) 选项形态（3.2.3）：解释另起一行、缩进对齐选项正文起点、标记只在首行
//  5) 类型标识（3.2.2）：[单选] / [多选] / [审批] 与第 n/m 题导航
//  6) 编辑光标（3.2.7）：焦点在自定义兜底项时产出 caret（面板内 0 基行 + 0 基列）
//  7) 审批描述窗（3.2.1）：长草稿可滚动查看末尾
//  8) windowStart 共用窗口工具（3.2.1 的统一机制）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  reduceState,
  type AppState,
  type QuestionPanelState,
} from "../src/app/state.ts";
import type { QuestionItem } from "../src/app/adapter/types.ts";
import type { FrameRow } from "../src/renderer/index.ts";
import {
  maxDescScrollFor,
  questionCaretFor,
  renderQuestionPanel,
} from "../src/app/components/QuestionPrompt.ts";
import {
  maxApprovalScroll,
  renderApprovalPrompt,
} from "../src/app/components/ApprovalPrompt.ts";
import { questionKeyDecision } from "../src/app/question-transition.ts";
import { windowStart } from "../src/app/layout/panel.ts";
import { questionHintLine } from "../src/app/layout/hints.ts";
import { rowAnsi, rowsText } from "./helpers/rowText.ts";

/** 打开问答面板（与 App 事件路径同构：question-open → 面板状态） */
function questionState(questions: QuestionItem[]): AppState {
  return reduceState(initialState(), {
    type: "question-open",
    id: "q",
    questions,
  });
}

/** 面板状态（断言用；无面板则失败） */
function panelOf(state: AppState): QuestionPanelState {
  const panel = state.question;
  assert.ok(panel, "应打开问答面板");
  return panel;
}

/** 帧行 → 纯文本（去 ANSI） */
function plain(rows: FrameRow[]): string[] {
  return rowsText(rows).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
}

/** 近似显示宽度（CJK/全角=2，其余=1），与面板 wrap 口径一致 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x20000 && cp <= 0x2fffd)
        ? 2
        : 1;
  }
  return w;
}

test("分窗：长题干不把选项挤出可视区（描述窗 + 选项窗同屏）", () => {
  const s = questionState([
    {
      id: "q1",
      question: "很长的题干内容".repeat(12),
      options: [{ label: "生产" }, { label: "测试" }],
    },
  ]);
  const lines = plain(renderQuestionPanel(panelOf(s), 12, 60));
  assert.ok(
    lines.some((l) => l.includes("很长的题干")),
    "题干出现在描述窗: " + JSON.stringify(lines),
  );
  assert.ok(
    lines.some((l) => l.includes(">  生产")),
    "首个选项仍在可视区（不再被长题干挤出）: " + JSON.stringify(lines),
  );
});

test("描述窗：长 detail 可逐行滚动查看末尾，偏移被 clamp 在上界", () => {
  const detail = Array.from({ length: 14 }, (_, i) => `说明第${i + 1}行`).join(
    "\n",
  );
  const s = questionState([
    { id: "q1", question: "问题", detail, options: [{ label: "A" }] },
  ]);
  const height = 12;
  const width = 60;
  const max = maxDescScrollFor(panelOf(s), height, width);
  assert.ok(max > 0, "长 detail 应可滚动（max > 0）");
  const before = plain(renderQuestionPanel(panelOf(s), height, width));
  assert.ok(
    before.some((l) => l.includes("说明第1行")),
    "初始可见首行",
  );
  assert.ok(
    !before.some((l) => l.includes("说明第14行")),
    "初始不可见末行: " + JSON.stringify(before),
  );
  // 连续 ↓ 超过上界：偏移停在上界（state 层 clamp）
  let st = s;
  for (let i = 0; i < max + 3; i++) {
    st = reduceState(st, { type: "question-desc-scroll", delta: 1, max });
  }
  assert.equal(
    panelOf(st).items[0]!.descScroll,
    max,
    "偏移被 clamp 到 maxDescScrollFor 给出的上界",
  );
  const after = plain(renderQuestionPanel(panelOf(st), height, width));
  assert.ok(
    after.some((l) => l.includes("说明第14行")),
    "滚动到底后末行可见: " + JSON.stringify(after),
  );
});

test("焦点窗：Tab 切换，↑/↓ 语义随之分派（选项窗移项 / 描述窗滚行）", () => {
  const s = questionState([
    {
      id: "q1",
      question: "问题",
      detail: "说明",
      options: [{ label: "A" }, { label: "B" }],
    },
  ]);
  assert.deepEqual(
    questionKeyDecision(panelOf(s), "up", false),
    { kind: "move", delta: -1 },
    "焦点缺省在选项窗：↑ 移项",
  );
  const s2 = reduceState(s, { type: "question-focus" });
  assert.equal(panelOf(s2).items[0]!.focus, "desc", "Tab 后焦点在描述窗");
  assert.deepEqual(
    questionKeyDecision(panelOf(s2), "down", false),
    { kind: "desc-scroll", delta: 1 },
    "焦点在描述窗：↓ 滚行",
  );
  assert.deepEqual(
    questionKeyDecision(panelOf(s2), "tab", false),
    { kind: "focus" },
    "Tab 决策恒为切窗",
  );
  const s3 = reduceState(s2, { type: "question-focus" });
  assert.equal(panelOf(s3).items[0]!.focus, "options", "再 Tab 回到选项窗");
});

test("焦点在描述窗时，选项窗仍锚定已标记项（标记不被滚出视野）", () => {
  const options = Array.from({ length: 6 }, (_, i) => ({
    label: `选项${i + 1}`,
  }));
  let st = questionState([{ id: "q1", question: "问题", options }]);
  // 光标移到末项并标记
  for (let i = 0; i < options.length - 1; i++) {
    st = reduceState(st, { type: "question-move", delta: 1 });
  }
  st = reduceState(st, { type: "question-select" });
  assert.deepEqual(panelOf(st).items[0]!.selected, ["选项6"], "末项已标记");
  // 切到描述窗（焦点离开选项窗）后，已标记项仍须在窗口内
  st = reduceState(st, { type: "question-focus" });
  const lines = plain(renderQuestionPanel(panelOf(st), 10, 60));
  assert.ok(
    lines.some((l) => l.includes("选项6")),
    "已标记项仍在选项窗内: " + JSON.stringify(lines),
  );
});

test("选项形态：解释另起一行、缩进 4 列，标记只在选项首行（BACKLOG 3.2.3）", () => {
  const s = questionState([
    {
      id: "q1",
      question: "问题",
      options: [{ label: "生产", description: "部署到生产环境" }],
    },
  ]);
  const lines = plain(renderQuestionPanel(panelOf(s), 10, 60));
  const head = lines.findIndex((l) => l.includes("生产"));
  assert.ok(head >= 0, "选项首行存在: " + JSON.stringify(lines));
  assert.ok(
    !lines[head]!.includes("部署到生产环境"),
    "解释不与选项正文同行: " + JSON.stringify(lines[head]),
  );
  const desc = lines.findIndex((l) => l.includes("部署到生产环境"));
  assert.ok(desc > head, "解释行紧随选项首行");
  assert.ok(
    /^ {4}\S/.test(lines[desc]!),
    "解释行缩进 4 列（对齐选项正文起点）: " + JSON.stringify(lines[desc]),
  );
  assert.ok(
    !/^ *[>*+]/.test(lines[desc]!),
    "解释行不重复光标/标记: " + JSON.stringify(lines[desc]),
  );
});

test("类型标识：单选 / 多选 / 审批（plan-review）与第 n/m 题导航（BACKLOG 3.2.2）", () => {
  const single = questionState([
    { id: "q1", question: "问题", options: [{ label: "A" }] },
  ]);
  const singleLines = plain(renderQuestionPanel(panelOf(single), 8, 60));
  assert.ok(
    singleLines.some((l) => l.includes("[单选]") && l.includes("第 1/1 题")),
    "单选标识 + 题号导航: " + JSON.stringify(singleLines[0]),
  );
  const multi = questionState([
    {
      id: "q1",
      question: "问题",
      multiSelect: true,
      options: [{ label: "A" }],
    },
  ]);
  assert.ok(
    plain(renderQuestionPanel(panelOf(multi), 8, 60)).some((l) =>
      l.includes("[多选]"),
    ),
    "多选标识",
  );
  const plan = questionState([
    {
      id: "q1",
      question: "批准？",
      detail: "计划正文",
      intent: { kind: "plan-review", approve: "批准" },
      options: [{ label: "批准" }],
    },
  ]);
  assert.ok(
    plain(renderQuestionPanel(panelOf(plan), 8, 60)).some((l) =>
      l.includes("[审批]"),
    ),
    "plan-review 按审批标识",
  );
});

test("编辑光标：焦点在自定义兜底项时产出 caret（行=该行、列=文本末尾）（BACKLOG 3.2.7）", () => {
  const st0 = questionState([
    {
      id: "q1",
      question: "问题",
      header: "头",
      options: [{ label: "A" }],
    },
  ]);
  assert.equal(
    questionCaretFor(panelOf(st0), 10, 60),
    null,
    "焦点在普通选项时无 caret",
  );
  let st = reduceState(st0, { type: "question-move", delta: 1 }); // → 自定义兜底项
  st = reduceState(st, { type: "question-custom", text: "abc" });
  const caret = questionCaretFor(panelOf(st), 10, 60);
  assert.ok(caret, "编辑焦点应产出 caret");
  const lines = plain(renderQuestionPanel(panelOf(st), 10, 60));
  const row = lines[caret!.row] ?? "";
  assert.ok(
    row.includes("自定义回答：abc"),
    "caret 行即自定义回答行: " + JSON.stringify(row),
  );
  assert.equal(
    caret!.col,
    displayWidth(row.trimEnd()),
    "caret 列 = 该行文本末尾（0 基显示列）",
  );
});

test("审批描述窗：长草稿可滚动查看末尾（BACKLOG 3.2.1）", () => {
  const prompt = Array.from({ length: 10 }, (_, i) => `审批第${i + 1}行`).join(
    "\n",
  );
  const approval = { id: "a1", prompt };
  const height = 8;
  const width = 60;
  const max = maxApprovalScroll(approval, height, width);
  assert.ok(max > 0, "长草稿应可滚动");
  const before = plain(renderApprovalPrompt(approval, height, width, 0));
  assert.ok(
    before.some((l) => l.includes("审批第1行")),
    "初始可见首行",
  );
  assert.ok(
    before.some((l) => l.includes("[审批]")),
    "标题含类型标识（BACKLOG 3.2.2）",
  );
  const after = plain(renderApprovalPrompt(approval, height, width, max));
  assert.ok(
    after.some((l) => l.includes("审批第10行")),
    "滚动到底可见末行: " + JSON.stringify(after),
  );
});

test("焦点窗可见性：提示区前缀 + 面板内题干焦点条（BACKLOG 3.2.8 / 修订）", () => {
  // 长题干（多行）：既看首行焦点条，也看滚动后焦点条是否仍在
  const s = questionState([
    {
      id: "q1",
      question: "很长的题干内容".repeat(30), // 折行后超过描述窗高度 → 可滚动
      options: [{ label: "A" }, { label: "B" }],
    },
  ]);
  // 提示区：显式标出当前焦点窗（此前只有 ↑/↓ 文案细差，看不出焦点）
  assert.ok(
    questionHintLine(panelOf(s)).startsWith("▶选项"),
    "缺省焦点在选项窗: " + questionHintLine(panelOf(s)),
  );
  const onDesc = reduceState(s, { type: "question-focus" });
  assert.ok(
    questionHintLine(panelOf(onDesc)).startsWith("▶题干"),
    "Tab 后焦点在描述窗: " + questionHintLine(panelOf(onDesc)),
  );
  // 面板内：描述窗聚焦时题干首行带黄色 `▶`（不增宽），失焦时不带
  const optLines = plain(renderQuestionPanel(panelOf(s), 10, 60));
  assert.ok(
    !optLines.some((l) => l.includes("▶")),
    "焦点在选项窗时题干无标记: " + JSON.stringify(optLines),
  );
  const descLines = plain(renderQuestionPanel(panelOf(onDesc), 10, 60));
  assert.ok(
    descLines.some((l) => l.startsWith("┃")),
    "描述窗聚焦时题干首行有焦点条 ┃: " + JSON.stringify(descLines),
  );
  // 滚动后焦点条仍在（BACKLOG 3.2.8 修订：此前单点 ▶ 一滚就丢）
  const max = maxDescScrollFor(panelOf(onDesc), 10, 60);
  assert.ok(max > 0, "长题干应可滚动（max > 0）");
  let scrolled = onDesc;
  for (let i = 0; i < max + 2; i++) {
    scrolled = reduceState(scrolled, {
      type: "question-desc-scroll",
      delta: 1,
      max,
    });
  }
  const scrolledLines = plain(renderQuestionPanel(panelOf(scrolled), 10, 60));
  assert.ok(
    scrolledLines.some((l) => l.startsWith("┃")),
    "滚动后仍有滚动条滑块: " + JSON.stringify(scrolledLines),
  );
  assert.ok(
    scrolledLines.some((l) => l.startsWith("│")),
    "滚动条轨道存在: " + JSON.stringify(scrolledLines),
  );
  // 折行宽度口径：行宽 ≤ 面板可用宽（width − 2）
  for (const l of descLines) {
    assert.ok(
      l === "" || displayWidth(l) <= 59,
      "行宽超出面板可用宽: " + JSON.stringify(l),
    );
  }
});

test("焦点互斥：聚焦描述窗时选项光标降色，全屏只有一处焦点黄（BACKLOG 3.2.8 修订）", () => {
  const YELLOW = "\x1b[38;2;233;201;68m";
  const s = questionState([
    { id: "q1", question: "问题", options: [{ label: "A" }] },
  ]);
  // 焦点在选项窗：选项光标行着黄，题干无焦点条
  const optFrame = renderQuestionPanel(panelOf(s), 10, 60).map((r) =>
    rowAnsi(r),
  );
  assert.ok(
    optFrame.some((l) => l.includes(YELLOW) && l.includes(">  A")),
    "焦点在选项窗时该行着黄: " + JSON.stringify(optFrame),
  );
  // Tab 到描述窗：选项光标降色（不再黄），题干焦点条着黄
  const onDesc = reduceState(s, { type: "question-focus" });
  const descFrame = renderQuestionPanel(panelOf(onDesc), 10, 60).map((r) =>
    rowAnsi(r),
  );
  assert.ok(
    !descFrame.some((l) => l.includes(YELLOW) && l.includes(">  A")),
    "聚焦描述窗时选项光标降色: " + JSON.stringify(descFrame),
  );
  assert.ok(
    descFrame.some((l) => l.includes(YELLOW) && l.includes("┃")),
    "题干焦点条着黄: " + JSON.stringify(descFrame),
  );
});

test("描述窗滚动条：滑块位置随偏移移动、轨道同屏（BACKLOG 3.2.8 修订）", () => {
  const s = questionState([
    {
      id: "q1",
      question: "很长的题干内容".repeat(30),
      options: [{ label: "A" }],
    },
  ]);
  const onDesc = reduceState(s, { type: "question-focus" });
  const height = 8; // 矮面板：描述窗可见行 < 内容行 → 画滚动条
  const width = 60;
  const thumbRows = (lines: string[]): number[] =>
    lines.map((l, i) => (l.startsWith("┃") ? i : -1)).filter((i) => i >= 0);
  const topLines = plain(renderQuestionPanel(panelOf(onDesc), height, width));
  const top = thumbRows(topLines);
  assert.ok(top.length >= 1, "顶部有滑块: " + JSON.stringify(topLines));
  assert.ok(top[0]! <= 2, "顶部时滑块贴近描述窗首行: " + JSON.stringify(top));
  assert.ok(
    topLines.some((l) => l.startsWith("│")),
    "轨道随滚动条一起出现: " + JSON.stringify(topLines),
  );
  const max = maxDescScrollFor(panelOf(onDesc), height, width);
  let bottom = onDesc;
  for (let i = 0; i < max + 2; i++) {
    bottom = reduceState(bottom, {
      type: "question-desc-scroll",
      delta: 1,
      max,
    });
  }
  const bottomLines = plain(
    renderQuestionPanel(panelOf(bottom), height, width),
  );
  const bottomThumb = thumbRows(bottomLines);
  assert.ok(bottomThumb.length >= 1, "底部有滑块");
  assert.ok(
    bottomThumb[bottomThumb.length - 1]! > top[0]!,
    "滑块随偏移下移: top=" +
      JSON.stringify(top) +
      " bottom=" +
      JSON.stringify(bottomThumb),
  );
});

test("审批描述窗滚动条：长草稿左侧画轨道与滑块（BACKLOG 3.2.8 修订）", () => {
  const prompt = Array.from({ length: 14 }, (_, i) => `审批第${i + 1}行`).join(
    "\n",
  );
  const approval = { id: "a1", prompt };
  const height = 6; // 标题 1 行 + body 5 行
  const width = 60;
  const top = plain(renderApprovalPrompt(approval, height, width, 0));
  assert.ok(
    top[1]?.startsWith("┃"),
    "顶部时滑块在 body 首行: " + JSON.stringify(top),
  );
  assert.ok(
    top.slice(1).some((l) => l.startsWith("│")),
    "轨道行存在: " + JSON.stringify(top),
  );
  const max = maxApprovalScroll(approval, height, width);
  const bottom = plain(renderApprovalPrompt(approval, height, width, max));
  assert.ok(
    bottom[height - 1]?.startsWith("┃"),
    "滚到底时滑块在 body 末行: " + JSON.stringify(bottom),
  );
  // 内容不足一屏：不画滚动条，保持 ` 文本` 形态
  const short = plain(
    renderApprovalPrompt({ id: "a2", prompt: "允许执行?" }, height, width, 0),
  );
  assert.ok(
    short.slice(1).every((l) => l === "" || l.startsWith(" ")),
    "短内容不画滚动条: " + JSON.stringify(short),
  );
});

test("分窗规则：描述窗上限 2/3，溢出由选项窗先承担（BACKLOG 3.2.11）", () => {
  const height = 14; // maxBody = 13 → 描述窗上限 floor(13 × 2/3) = 8
  const width = 60;
  const options = Array.from({ length: 12 }, (_, i) => ({
    label: `选项${i + 1}`,
  }));
  const s = questionState([
    { id: "q1", question: "很长题干".repeat(60), options },
  ]);
  const lines = plain(renderQuestionPanel(panelOf(s), height, width));
  // 描述窗固定占 8 行（带滚动条列），其后再接选项窗
  const descPart = lines
    .slice(1)
    .filter((l) => l.startsWith("│") || l.startsWith("┃"));
  assert.equal(
    descPart.length,
    8,
    "描述窗 = floor(maxBody × 2/3): " + JSON.stringify(lines.slice(0, 12)),
  );
  assert.ok(
    lines.some((l) => l.startsWith("│")),
    "描述窗自身超 2/3 → 出现滚动条",
  );
  // 选项窗只显示前几项：12 个选项无法全显示 → 溢出由选项窗滚动承担
  assert.ok(
    !lines.some((l) => l.includes("选项12")),
    "选项窗滚动而非压缩描述窗: " + JSON.stringify(lines),
  );
  assert.ok(
    lines.some((l) => l.includes("选项1")),
    "选项窗从首项开始显示: " + JSON.stringify(lines),
  );
});

test("分窗规则：内容不足时两窗紧邻、空白落在活动区下方（BACKLOG 3.2.11）", () => {
  const s = questionState([
    { id: "q1", question: "短题干", options: [{ label: "A" }, { label: "B" }] },
  ]);
  const lines = plain(renderQuestionPanel(panelOf(s), 14, 60));
  assert.ok(lines[1]?.includes("短题干"), "描述窗首行是题干");
  assert.ok(
    lines[2]?.includes("A") && !lines[2]!.includes("非选项"),
    "选项紧跟题干、中间无空行: " + JSON.stringify(lines.slice(0, 6)),
  );
  const lastNonEmpty = lines.filter((l) => l.trim() !== "").length;
  assert.ok(
    lastNonEmpty <= 5,
    "内容少时空白留在下方: " + JSON.stringify(lines),
  );
});

test("windowStart：内容不足不滚动，center / tail 两种锚点语义一致（BACKLOG 3.2.1）", () => {
  assert.equal(windowStart(3, 4, 1), 0, "内容不足窗口 → 不滚动");
  assert.equal(windowStart(10, 4, 0, "center"), 0, "首行锚定顶部");
  assert.equal(
    windowStart(10, 4, 9, "center"),
    6,
    "尾部 clamp 到 count-window",
  );
  assert.equal(windowStart(10, 4, 9, "tail"), 6, "tail：锚点贴窗口末行");
  assert.equal(
    windowStart(10, 4, 3, "tail"),
    0,
    "tail：锚点未越界时窗口停在顶部",
  );
  assert.equal(windowStart(10, 4, 5, "center"), 3, "center：锚点居中");
  assert.equal(windowStart(10, 0, 5), 0, "窗口高 0 → 不滚动");
});
