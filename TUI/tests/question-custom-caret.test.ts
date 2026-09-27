// tests/question-custom-caret.test.ts — 问题面板自定义答案的光标移动（BACKLOG TUI#35）
//
// 覆盖（纯决策/reducer 层）：
//   1) 编辑态 ←/→ 在串内移动光标（右端到头不动、不切题）；左端再按仍不切题
//   2) 未编辑态（空串或 customCaret=null）←/→ 仍是切题导航
//   3) 插入 / 退格发生在光标处（中间定位）；退格删空 → 回未编辑态
//   4) 移项 / 选预设清空编辑态；聚焦描述窗时 ←/→ 语义不变

import assert from "node:assert/strict";
import test from "node:test";

import { questionKeyDecision } from "../src/app/question-transition.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import type { AppState, QuestionPanelItem } from "../src/app/state.ts";

/** 两题问答面板（q1 两个预设选项 + 自定义兜底项） */
function twoQuestionState(): AppState {
  return reduceState(initialState(), {
    type: "question-open",
    id: "q",
    questions: [
      {
        id: "q1",
        question: "第一题?",
        options: [{ label: "A" }, { label: "B" }],
      },
      { id: "q2", question: "第二题?", options: [{ label: "C" }] },
    ],
  });
}

/** 当前题的 item（断言用） */
function itemOf(state: AppState): QuestionPanelItem {
  const panel = state.question;
  assert.ok(panel, "应打开问答面板");
  const item = panel.items[panel.itemIndex];
  assert.ok(item, "应有当前题");
  return item;
}

/** 移到自定义兜底项（q1 有两项预设 → delta 2） */
function onCustom(state: AppState): AppState {
  const s = reduceState(state, { type: "question-move", delta: 2 });
  assert.equal(
    itemOf(s).optionIndex,
    itemOf(s).options.length,
    "应高亮在自定义兜底项",
  );
  return s;
}

/** 走一次按键决策 → reducer（等价 App 侧分派） */
function press(state: AppState, name: string): AppState {
  const panel = state.question;
  assert.ok(panel, "应打开问答面板");
  const d = questionKeyDecision(panel, name, false);
  switch (d.kind) {
    case "custom-edit":
      return reduceState(state, {
        type: "question-custom",
        text: d.text,
        caret: d.caret,
      });
    case "custom-caret":
      return reduceState(state, { type: "custom-caret", delta: d.delta });
    case "nav":
      return reduceState(state, { type: "question-nav", delta: d.delta });
    case "move":
      return reduceState(state, { type: "question-move", delta: d.delta });
    case "none":
      return state;
    default:
      return state; // 其余决策（focus/select/...）本用例不覆盖
  }
}

test("编辑态 ←/→ 在串内移动光标；右端到头不动、左端不切题（TUI#35）", () => {
  let s = onCustom(twoQuestionState());
  for (const ch of ["a", "b", "c"]) s = press(s, ch); // "abc"，光标在末尾
  assert.equal(itemOf(s).custom, "abc");
  assert.equal(itemOf(s).customCaret, 3);

  s = press(s, "left");
  assert.equal(itemOf(s).customCaret, 2, "← 左移一位");
  s = press(s, "left");
  assert.equal(itemOf(s).customCaret, 1);
  s = press(s, "right");
  assert.equal(itemOf(s).customCaret, 2, "→ 右移一位");
  s = press(s, "right");
  assert.equal(itemOf(s).customCaret, 3);
  s = press(s, "right"); // 右端到头：不动
  assert.equal(itemOf(s).customCaret, 3, "右端到头不再前进");
  assert.equal(s.question?.itemIndex, 0, "右端到头**不切题**");
  // 回到左端：不切题（编辑态锁定在串内）
  s = press(s, "left");
  s = press(s, "left");
  s = press(s, "left");
  assert.equal(itemOf(s).customCaret, 0);
  s = press(s, "left");
  assert.equal(itemOf(s).customCaret, 0, "左端到头停住");
  assert.equal(s.question?.itemIndex, 0, "左端到头不切题");
});

test("插入与退格在光标处生效（TUI#35）", () => {
  let s = onCustom(twoQuestionState());
  s = press(s, "a");
  s = press(s, "c"); // "ac"，光标在末尾（2）
  s = press(s, "left"); // 光标 → 1（a 与 c 之间）
  s = press(s, "b"); // 中间插入
  assert.equal(itemOf(s).custom, "abc");
  assert.equal(itemOf(s).customCaret, 2, "插入后光标随之前移");
  // 光标在 2：退格删的是 b
  s = press(s, "backspace");
  assert.equal(itemOf(s).custom, "ac");
  assert.equal(itemOf(s).customCaret, 1);
});

test("退格删空 → 回未编辑态（←/→ 恢复切题）；空串退格不动（TUI#35）", () => {
  let s = onCustom(twoQuestionState());
  s = press(s, "x");
  assert.equal(itemOf(s).customCaret, 1, "首字符输入即进入编辑态");
  s = press(s, "backspace");
  assert.equal(itemOf(s).custom, "");
  assert.equal(itemOf(s).customCaret, null, "删空回未编辑态");
  s = press(s, "backspace");
  assert.equal(itemOf(s).custom, "", "空串退格 no-op");
  // 未编辑态（空串）：←/→ 仍是切题导航
  s = press(s, "right");
  assert.equal(s.question?.itemIndex, 1, "未编辑态 → 切下一题");
  s = press(s, "left");
  assert.equal(s.question?.itemIndex, 0, "未编辑态 ← 切回上一题");
});

test("移项退出编辑态但保留文本；单选选预设清空文本与光标（TUI#35）", () => {
  let s = onCustom(twoQuestionState());
  s = press(s, "a");
  s = press(s, "b");
  // ↑ 移到预设项：退出编辑态（customCaret → null），文本保留
  s = press(s, "up");
  assert.equal(itemOf(s).optionIndex, 1);
  assert.equal(itemOf(s).custom, "ab", "移项不清空自定义文本");
  assert.equal(itemOf(s).customCaret, null, "移项退出编辑态");
  // 单选选预设：清空 custom 与光标
  s = reduceState(s, { type: "question-select" });
  assert.equal(itemOf(s).custom, "");
  assert.equal(itemOf(s).customCaret, null);
});

test("焦点在描述窗时 ←/→ 仍是切题（不因存在文本而改语义）（TUI#35 边界）", () => {
  let s = onCustom(twoQuestionState());
  // 有编辑文本 → 编辑态 ←/→ 走光标
  s = press(s, "a");
  assert.equal(
    questionKeyDecision(s.question!, "left", false).kind,
    "custom-caret",
  );
  // 移到预设项（未编辑态）后 ←/→ 回到切题
  const s2 = reduceState(s, { type: "question-move", delta: -2 });
  assert.equal(questionKeyDecision(s2.question!, "left", false).kind, "nav");
});
