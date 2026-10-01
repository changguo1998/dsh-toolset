// tests/state-history-blocks.test.ts — 历史区正文分块（#1）：
//   分块边界 = [step 变化 | 工具调用行]，thinking / notice / 空行不切割；
//   取「最近一块含正文」整块 —— markFinalSummary 标 final 入历史区、
//   recentQuestionSource 取问答面板来源段（本回合取不到时回退上一回合）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  initialState,
  markFinalSummary,
  recentQuestionSource,
  type AppState,
  type BufferLine,
} from "../src/app/state.ts";

const line = (
  text: string,
  kind: BufferLine["kind"],
  extra: Partial<BufferLine> = {},
): BufferLine => ({ text, kind, ...extra });

/** 用给定 buffer 造状态（本文件只关心分块相关字段） */
function withBuffer(lines: BufferLine[]): AppState {
  return { ...initialState(), buffer: lines, nextSeq: lines.length + 1 };
}

/** buffer 里被标 final 的行文本（按行序） */
function finals(state: AppState): string[] {
  return state.buffer.filter((l) => l.final).map((l) => l.text);
}

test("markFinalSummary：#1 被思考行打断的正文整块入历史区（thinking 不切割）", () => {
  const state = withBuffer([
    line("## 机制本体", "assistant", { step: 1 }),
    line("Let me write it.", "thinking", { step: 1 }),
    line("正文第二段", "assistant", { step: 1 }),
  ]);
  assert.deepEqual(
    finals(markFinalSummary(state)),
    ["## 机制本体", "正文第二段"],
    "首段不再被思考行挤掉（真机缺陷回归点）",
  );
});

test("markFinalSummary：#1 工具调用行切块 —— 只标最近一块", () => {
  const state = withBuffer([
    line("工具调用前的说明", "assistant", { step: 1 }),
    line("⚙ bash echo hi", "tool", { step: 1 }),
    line("工具调用后的正文", "assistant", { step: 1 }),
  ]);
  assert.deepEqual(
    finals(markFinalSummary(state)),
    ["工具调用后的正文"],
    "工具调用前后的简短说明不进历史",
  );
});

test("markFinalSummary：#1 step 变化切块 —— 只标最新 step 的最近一块", () => {
  const state = withBuffer([
    line("第 1 步正文", "assistant", { step: 1 }),
    line("第 2 步正文", "assistant", { step: 2 }),
  ]);
  assert.deepEqual(finals(markFinalSummary(state)), ["第 2 步正文"]);
});

test("markFinalSummary：#1 notice 与空正文行不切割", () => {
  const state = withBuffer([
    line("正文一", "assistant", { step: 1 }),
    line("", "assistant", { step: 1 }),
    line("注入提示", "notice", { step: 1 }),
    line("正文二", "assistant", { step: 1 }),
  ]);
  assert.deepEqual(finals(markFinalSummary(state)), ["正文一", "", "正文二"]);
});

test("markFinalSummary：#1 最近一块是空锚点 → 回退取本回合更早的含正文块", () => {
  const state = withBuffer([
    line("工具调用前的正文", "assistant", { step: 1 }),
    line("⚙ bash ls", "tool", { step: 1 }),
    line("", "assistant", { step: 1 }),
  ]);
  assert.deepEqual(
    finals(markFinalSummary(state)),
    ["工具调用前的正文"],
    "空块不吞正文（用户 2026-10-01 追加裁定）",
  );
});

test("markFinalSummary：#1 本回合只有空正文 → 不标", () => {
  const state = withBuffer([line("", "assistant", { step: 1 })]);
  assert.deepEqual(finals(markFinalSummary(state)), []);
});

test("markFinalSummary：幂等（无变化时返回原状态对象）", () => {
  const once = markFinalSummary(
    withBuffer([line("正文", "assistant", { step: 1 })]),
  );
  assert.equal(markFinalSummary(once), once);
});

test("recentQuestionSource：#1 取最近一块整块（工具行切块、thinking 不切、不限行数）", () => {
  const lines = [
    line("上一块正文", "assistant", { step: 1 }),
    line("⚙ ask_user_question", "tool", { step: 1 }),
    line("说明第一行", "assistant", { step: 1 }),
    line("思考中", "thinking", { step: 1 }),
    line("说明第二行", "assistant", { step: 1 }),
    line("说明第三行", "assistant", { step: 1 }),
  ];
  assert.equal(
    recentQuestionSource(lines),
    "说明第一行\n说明第二行\n说明第三行",
  );
});

test("recentQuestionSource：#1 本回合最近一块是空锚点 → 回退本回合更早的含正文块（不跨回合）", () => {
  const lines = [
    line("上一回合正文", "assistant", { step: 1 }),
    line("回合分隔线", "separator"),
    line("本回合说明", "assistant", { step: 2 }),
    line("⚙ ask_user_question", "tool", { step: 2 }),
    line("", "assistant", { step: 2 }),
  ];
  assert.equal(recentQuestionSource(lines), "本回合说明");
});

test("recentQuestionSource：#1 本回合无正文 → 回退取上一回合的最近一块", () => {
  const lines = [
    line("上一回合正文", "assistant", { step: 1 }),
    line("回合分隔线", "separator"),
    line("⚙ bash ls", "tool", { step: 2 }),
    line("思考中", "thinking", { step: 2 }),
  ];
  assert.equal(recentQuestionSource(lines), "上一回合正文");
});

test("recentQuestionSource：#1 本回合与上一回合都无正文 → 空串", () => {
  const lines = [
    line("⚙ bash ls", "tool", { step: 1 }),
    line("回合分隔线", "separator"),
    line("思考中", "thinking", { step: 2 }),
  ];
  assert.equal(recentQuestionSource(lines), "", "面板不显示来源段");
  assert.equal(recentQuestionSource([]), "");
});
