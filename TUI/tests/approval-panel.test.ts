// tests/approval-panel.test.ts — 审批交互族与提问上下文（BACKLOG 3.2.4 / 3.2.5 / 3.2.6 /
// 3.2.10 / 3.3.1）：
//   - 审批面板两窗渲染：草稿描述窗（≤ 面板体 2/3）+「批准 / 拒绝」选项窗（编号 + 焦点）
//   - 拒绝项倒计时（deadline 注入固定 now，避免依赖真实时钟）
//   - 问答 / 审批的数字键决策（直接标记，不提交；自定义项上仍作文本输入）
//   - 无效键白名单（非白名单按键 → none，由 App 侧给无效键提示）与 Esc 取消
//   - 提问上下文：recentQuestionSource 纯函数 + 描述窗来源段渲染

import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_OPTIONS,
  maxApprovalScroll,
  renderApprovalPrompt,
} from "../src/app/components/ApprovalPrompt.ts";
import { renderQuestionPanel } from "../src/app/components/QuestionPrompt.ts";
import { questionKeyDecision } from "../src/app/question-transition.ts";
import {
  initialState,
  recentQuestionSource,
  reduceState,
  type AppState,
  type BufferLine,
} from "../src/app/state.ts";
import { rowAnsi, rowsText } from "./helpers/rowText.ts";

const plain = (rows: Parameters<typeof rowsText>[0]): string[] =>
  rowsText(rows).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

const NOW = 1_700_000_000_000;

/** 审批状态：草稿多行（命令另起一行），可带超时时刻 */
function approvalState(deadline: number | null = null): AppState {
  return reduceState(initialState(), {
    type: "approval",
    approval: {
      id: "a1",
      prompt: "允许工具 bash 执行?\n命令：\nrm -rf /tmp/x",
    },
    deadline,
  });
}

test("审批面板：描述窗 + 选项窗两项（编号 + 批准项缺省焦点）", () => {
  const rows = plain(
    renderApprovalPrompt(approvalState().approval!, 10, 60, 0, {
      focus: "approve",
      now: NOW,
    }),
  );
  assert.ok(
    rows[0]!.includes("△ 等待审批"),
    "标题含类型符号 △（BACKLOG TUI#4；旧 `[审批]` 已移除）: " +
      JSON.stringify(rows[0]),
  );
  assert.ok(
    rows.some((l) => l.includes("命令：")),
    "草稿含命令段: " + JSON.stringify(rows),
  );
  assert.ok(
    rows.some((l) => l.includes(">  1. 批准")),
    "编号 1 = 批准且为当前焦点: " + JSON.stringify(rows),
  );
  assert.ok(
    rows.some((l) => l.includes("   2. 拒绝")),
    "编号 2 = 拒绝（非焦点）: " + JSON.stringify(rows),
  );
  assert.equal(APPROVAL_OPTIONS.length, 2, "选项固定两项");
});

test("审批面板：←/→ 切换焦点（标记随焦点移动，0-based 不循环）", () => {
  const toReject = reduceState(approvalState(), {
    type: "approval-focus",
    focus: "reject",
  });
  assert.equal(toReject.approvalFocus, "reject");
  const rows = plain(
    renderApprovalPrompt(toReject.approval!, 10, 60, 0, {
      focus: toReject.approvalFocus,
      now: NOW,
    }),
  );
  assert.ok(
    rows.some((l) => l.includes(">  2. 拒绝")),
    "焦点移到拒绝: " + JSON.stringify(rows),
  );
  assert.ok(
    rows.some((l) => l.includes("   1. 批准")),
    "批准项失去焦点",
  );
  // 同一焦点重复设置 → 幂等（不产生新对象语义变化）
  const again = reduceState(toReject, {
    type: "approval-focus",
    focus: "reject",
  });
  assert.equal(again.approvalFocus, "reject");
});

test("审批面板：拒绝项倒计时按 deadline − now 显示，缺省不显示", () => {
  const shown = (deadline: number | null): string[] =>
    plain(
      renderApprovalPrompt(approvalState(deadline).approval!, 10, 60, 0, {
        focus: "approve",
        deadline,
        now: NOW,
      }),
    );
  assert.ok(
    shown(NOW + 60_000).some((l) => l.includes("拒绝 (60s)")),
    "60s 倒计时: " + JSON.stringify(shown(NOW + 60_000)),
  );
  assert.ok(
    shown(NOW + 30_000).some((l) => l.includes("拒绝 (30s)")),
    "30s 倒计时",
  );
  assert.ok(
    shown(NOW + 500).some((l) => l.includes("拒绝 (1s)")),
    "向上取整到 1s",
  );
  assert.ok(
    !shown(null).some((l) => l.includes("拒绝 (")),
    "无 deadline 不显示倒计时",
  );
  // 已过期（负剩余）不出现负号
  assert.ok(
    shown(NOW - 5_000).some((l) => l.includes("拒绝 (0s)")),
    "过期显示 0s: " + JSON.stringify(shown(NOW - 5_000)),
  );
});

test("审批面板：描述窗上限 = 面板体 2/3，选项窗吃剩余（BACKLOG 3.2.11 规则）", () => {
  const prompt = Array.from({ length: 40 }, (_, i) => `第${i + 1}行`).join(
    "\n",
  );
  const approval = { id: "a1", prompt };
  const height = 9; // 面板体 8 → 描述窗 ≤ floor(8 × 2/3) = 5，选项窗 3
  const rows = plain(
    renderApprovalPrompt(approval, height, 60, 0, { now: NOW }),
  );
  const descRows = rows
    .slice(1)
    .filter((l) => l.startsWith("│") || l.startsWith("┃"));
  assert.equal(descRows.length, 5, "描述窗 5 行: " + JSON.stringify(rows));
  assert.ok(
    rows.some((l) => l.includes("批准")) &&
      rows.some((l) => l.includes("拒绝")),
    "选项窗始终可见",
  );
  assert.equal(
    maxApprovalScroll(approval, height, 60),
    40 - 5,
    "滚动上界 = 内容行数 − 描述窗上限",
  );
});

test("审批面板：草稿滚动到底时滑块贴描述窗末行", () => {
  const prompt = Array.from({ length: 14 }, (_, i) => `审批第${i + 1}行`).join(
    "\n",
  );
  const approval = { id: "a1", prompt };
  const height = 6; // 面板体 5 → 描述窗 3 行 + 选项窗 2 行
  const bottom = plain(
    renderApprovalPrompt(
      approval,
      height,
      60,
      maxApprovalScroll(approval, height, 60),
      {
        now: NOW,
      },
    ),
  );
  assert.ok(
    bottom[1]!.startsWith("│"),
    "顶部为轨道: " + JSON.stringify(bottom),
  );
  assert.ok(
    bottom[3]!.startsWith("┃"),
    "滑块贴描述窗末行: " + JSON.stringify(bottom),
  );
});

test("问答数字键：1-9 直接标记第 n 项（不提交），自定义项上仍作文本（BACKLOG 3.2.6）", () => {
  const s = reduceState(initialState(), {
    type: "question-open",
    id: "q1",
    questions: [
      {
        id: "q1",
        question: "选哪个?",
        options: [{ label: "A" }, { label: "B" }],
      },
    ],
  });
  const panel = s.question!;
  const d2 = questionKeyDecision(panel, "2", false);
  assert.deepEqual(d2, { kind: "digit", n: 2 }, "数字键 2 → 标记第 2 项");
  assert.deepEqual(
    questionKeyDecision(panel, "9", false),
    { kind: "digit", n: 9 },
    "越界编号交由 App 侧吞掉（决策层只报编号）",
  );
  // 焦点落到「自定义回答」后，数字键是文本输入（不能被标记语义抢走）；
  // 空串插入 = 进入编辑态（BACKLOG TUI#35：caret 指向插入后的光标位）
  const onCustom = reduceState(s, { type: "question-move", delta: 2 });
  const customDecision = questionKeyDecision(onCustom.question!, "2", false);
  assert.deepEqual(
    customDecision,
    { kind: "custom-edit", text: "2", caret: 1 },
    "自定义项上数字是文本: " + JSON.stringify(customDecision),
  );
});

test("问答数字键：标记第 2 项不改提交语义（Enter 仍为提交）", () => {
  const s = reduceState(initialState(), {
    type: "question-open",
    id: "q1",
    questions: [
      {
        id: "q1",
        question: "选哪个?",
        options: [{ label: "A" }, { label: "B" }],
      },
    ],
  });
  const marked = reduceState(
    reduceState(s, { type: "question-move", delta: 1 }),
    { type: "question-select" },
  );
  assert.deepEqual(marked.question!.items[0]!.selected, ["B"], "第 2 项被标记");
  assert.deepEqual(
    questionKeyDecision(marked.question!, "enter", false),
    { kind: "submit" },
    "Enter 仍是提交（数字键不提交）",
  );
});

test("审批按键白名单：Esc 取消、非白名单键由决策层吞掉（BACKLOG 3.3.1）", () => {
  const s = approvalState();
  assert.equal(s.approvalHint, null, "打开时无提示");
  assert.equal(s.approvalFocus, "approve", "缺省焦点在批准项");
  const hinted = reduceState(s, { type: "approval-hint", text: "[无效键] …" });
  assert.equal(hinted.approvalHint, "[无效键] …");
  // 切换焦点会清掉无效键提示（下一次有效键操作即恢复正常提示区）
  const cleared = reduceState(hinted, {
    type: "approval-focus",
    focus: "reject",
  });
  assert.equal(cleared.approvalHint, null, "有效键清空无效键提示");
  // 关闭面板：焦点 / 倒计时 / 提示一并归零
  const closed = reduceState(cleared, { type: "approval", approval: null });
  assert.equal(closed.approval, null);
  assert.equal(closed.approvalFocus, "approve");
  assert.equal(closed.approvalDeadline, null);
  assert.equal(closed.approvalHint, null);
});

test("recentQuestionSource：按分块口径取最近一块正文（工具行切块、空行与思考不切、整块不限行数；#1）", () => {
  const line = (text: string, kind: BufferLine["kind"]): BufferLine => ({
    text,
    kind,
  });
  assert.equal(
    recentQuestionSource([
      line("旧正文", "assistant"),
      line("工具行", "tool"),
      line("这是提问前的说明第一行", "assistant"),
      line("第二行说明", "assistant"),
    ]),
    "这是提问前的说明第一行\n第二行说明",
    "只取紧邻的连续正文（工具行截断）",
  );
  // 真机形态：正文尾部带空正文行 + 提问工具留下的若干行 —— 都不能让来源变空
  assert.equal(
    recentQuestionSource([
      line("说明正文第一行", "assistant"),
      line("说明正文第二行", "assistant"),
      line("", "assistant"),
      line("⚙ bash echo hi", "tool"),
      line("✓ 输出", "tool"),
      line("⚙ ask_user_question", "tool"),
    ]),
    "说明正文第一行\n说明正文第二行",
    "尾部空正文行跳过、工具行跳过（3.2.12 修复点）",
  );
  assert.equal(
    recentQuestionSource([
      line("很早以前的一条回复", "assistant"),
      ...Array.from({ length: 40 }, (_, i) => line(`工具行 ${i}`, "tool")),
    ]),
    "很早以前的一条回复",
    "工具行只切块、不再设扫描上限 → 同一回合的最近一块正文照取（#1）",
  );
  assert.equal(
    recentQuestionSource([line("思考内容", "thinking")]),
    "",
    "无正文返回空串",
  );
  const many = Array.from({ length: 10 }, (_, i) =>
    line(`第${i + 1}行`, "plain"),
  );
  assert.equal(
    recentQuestionSource(many).split("\n").length,
    10,
    "整块保留（#1 起不再限 6 行；超长由描述窗滚动承接）",
  );
});

test("提问上下文：来源段渲染在描述窗顶部（灰、随窗滚动，与题干空行分隔）", () => {
  const s = reduceState(initialState(), {
    type: "question-open",
    id: "q1",
    questions: [
      { id: "q1", question: "请选择部署环境", options: [{ label: "生产" }] },
    ],
    source: "提问前的说明正文",
  });
  const ansi = renderQuestionPanel(s.question!, 12, 60).map((r) => rowAnsi(r));
  const rows = plain(renderQuestionPanel(s.question!, 12, 60));
  assert.ok(
    rows.some((l) => l.includes("提问前的说明正文")),
    "来源段出现在面板内: " + JSON.stringify(rows),
  );
  const srcIdx = rows.findIndex((l) => l.includes("提问前的说明正文"));
  const qIdx = rows.findIndex((l) => l.includes("请选择部署环境"));
  assert.ok(srcIdx >= 0 && srcIdx < qIdx, "来源段在题干之上");
  // BACKLOG TUI#38：来源段与题干同口径走 markdown，**颜色回默认前景**（不再硬编码青色，
  // 也不再是「着色但非标题」）——纯文本来源行不带颜色 SGR
  assert.ok(
    !ansi[srcIdx]!.includes("\x1b[38;2;") && !ansi[srcIdx]!.includes("\x1b[1m"),
    "来源段默认前景、非加粗: " + JSON.stringify(ansi[srcIdx]),
  );
  // markdown 生效：`**加粗**` 来源段按加粗渲染（与题干同口径）
  const md = reduceState(initialState(), {
    type: "question-open",
    id: "q3",
    questions: [{ id: "q3", question: "继续?", options: [{ label: "A" }] }],
    source: "**加粗来源**",
  });
  const mdRows = renderQuestionPanel(md.question!, 12, 60);
  const mdAnsi = mdRows.map((r) => rowAnsi(r));
  const mdIdx = plain(mdRows).findIndex((l) => l.includes("加粗来源"));
  assert.ok(
    mdIdx >= 0 && mdAnsi[mdIdx]!.includes("\x1b[1m"),
    "来源段按 markdown 渲染（加粗生效）: " + JSON.stringify(mdAnsi[mdIdx]),
  );
  // 无来源（缺省）时不占行：题干即面板首行（单题无标题区）
  const bare = reduceState(initialState(), {
    type: "question-open",
    id: "q2",
    questions: [
      { id: "q2", question: "请选择部署环境", options: [{ label: "生产" }] },
    ],
  });
  const bareRows = plain(renderQuestionPanel(bare.question!, 12, 60));
  assert.equal(
    bareRows.findIndex((l) => l.includes("请选择部署环境")),
    0,
    "无来源段时题干在首行（无标题区）",
  );
});

test("审批草稿：命令段按代码块渲染，内部不被行内语法改写（BACKLOG TUI#6）", () => {
  const approval = {
    id: "a1",
    prompt:
      "允许工具 bash 执行？\n命令：\nrm -rf *_cache_* `x` **not bold**\n参数：{}",
  };
  const text = plain(
    renderApprovalPrompt(approval, 10, 60, 0, { focus: "approve", now: NOW }),
  ).join("\n");
  assert.ok(text.includes("命令："), "命令标签行保留: " + text);
  assert.ok(
    text.includes("rm -rf *_cache_* `x` **not bold**"),
    "命令原文保留（`*` / 反引号 / `**` 不被行内语法改写）: " + text,
  );
  assert.ok(text.includes("参数：{}"), "命令段之后的草稿行照常渲染: " + text);
});
