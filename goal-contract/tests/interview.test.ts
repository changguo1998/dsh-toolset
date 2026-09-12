// tests/interview.test.ts — 访谈状态机（objective → clauses → confirm）
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANCEL_LABEL,
  CONFIRM_LABEL,
  applyAnswer,
  initialState,
  nextQuestion,
} from "../src/interview.ts";
import type { InterviewAnswer } from "../src/interview.ts";

const CLAUSE_ANSWER: InterviewAnswer = {
  id: "clauses",
  selected: [],
  custom: "测试全绿 → npm test\n文档齐全",
};
const OBJECTIVE_ANSWER: InterviewAnswer = {
  id: "objective",
  selected: [],
  custom: "实现 goal 契约插件",
};
const CONFIRM_ANSWER: InterviewAnswer = {
  id: "confirm",
  selected: [CONFIRM_LABEL],
};
const CANCEL_ANSWER: InterviewAnswer = {
  id: "confirm",
  selected: [CANCEL_LABEL],
};

test("initialState: 无预填从 ask-objective 开始；预填跳过对应提问", () => {
  assert.equal(initialState().phase, "ask-objective");
  assert.equal(initialState({ objective: "o" }).phase, "ask-clauses");
  assert.equal(
    initialState({
      objective: "o",
      clauses: [{ id: "c1", check: "c", level: "human" }],
    }).phase,
    "ask-confirm",
  );
});

test("完整正向流程：objective → clauses → confirm → done，attempts 逐段归零", () => {
  let s = initialState();
  assert.equal(nextQuestion(s)?.id, "objective");
  s = applyAnswer(s, OBJECTIVE_ANSWER);
  assert.equal(s.phase, "ask-clauses");
  assert.equal(s.objective, "实现 goal 契约插件");
  assert.equal(nextQuestion(s)?.id, "clauses");
  s = applyAnswer(s, CLAUSE_ANSWER);
  assert.equal(s.phase, "ask-confirm");
  assert.deepEqual(s.clauses, [
    { id: "c1", check: "测试全绿", level: "mechanical", command: "npm test" },
    { id: "c2", check: "文档齐全", level: "human" },
  ]);
  // confirm 问题带选项
  const q = nextQuestion(s);
  assert.equal(q?.id, "confirm");
  assert.deepEqual(
    q?.options?.map((o) => o.label),
    [CONFIRM_LABEL, CANCEL_LABEL],
  );
  s = applyAnswer(s, CONFIRM_ANSWER);
  assert.equal(s.phase, "done");
  assert.equal(nextQuestion(s), null);
  assert.equal(s.questionsAsked, 3);
});

test("取消：confirm 阶段选取消 → aborted，原因明确", () => {
  const s = initialState({
    objective: "o",
    clauses: [{ id: "c1", check: "c", level: "human" }],
  });
  const next = applyAnswer(s, CANCEL_ANSWER);
  assert.equal(next.phase, "aborted");
  assert.equal(next.abortReason, "用户取消了起草");
  assert.equal(nextQuestion(next), null);
});

test("确认：同义回答（yes/确认）视为确认，其余视为取消", () => {
  const s = initialState({
    objective: "o",
    clauses: [{ id: "c1", check: "c", level: "human" }],
  });
  assert.equal(
    applyAnswer(s, { id: "confirm", selected: [], custom: "yes" }).phase,
    "done",
  );
  assert.equal(
    applyAnswer(s, { id: "confirm", selected: [], custom: "确认" }).phase,
    "done",
  );
  assert.equal(
    applyAnswer(s, { id: "confirm", selected: [], custom: "no" }).phase,
    "aborted",
  );
});

test("重问：空 objective / 非法条款 → 同阶段重问并携带错误，questionsAsked 累计", () => {
  let s = initialState();
  s = applyAnswer(s, { id: "objective", selected: [], custom: "  " });
  assert.equal(s.phase, "ask-objective");
  assert.equal(s.attempts, 1);
  assert.ok(nextQuestion(s)?.question.includes("上次回答未通过"));
  s = applyAnswer(s, OBJECTIVE_ANSWER);
  s = applyAnswer(s, { id: "clauses", selected: [], custom: "[{broken" });
  assert.equal(s.phase, "ask-clauses");
  assert.ok(nextQuestion(s)?.question.includes("解析失败"));
  assert.equal(s.questionsAsked, 3);
});

test("超限：连续空回答达到 maxAttempts → aborted（防无限循环）", () => {
  let s = initialState();
  for (let i = 0; i < 3; i += 1) {
    s = applyAnswer(s, { id: "objective", selected: [], custom: "" });
  }
  assert.equal(s.phase, "aborted");
  assert.ok(s.abortReason?.includes("超过 3 次重问"));
});

test("终态不可迁移：done/aborted 上 applyAnswer 原样返回", () => {
  const done = applyAnswer(
    initialState({
      objective: "o",
      clauses: [{ id: "c1", check: "c", level: "human" }],
    }),
    CONFIRM_ANSWER,
  );
  assert.equal(applyAnswer(done, CANCEL_ANSWER), done);
});
