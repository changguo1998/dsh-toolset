// tests/question-transition.test.ts — 问答面板「选中/标记」提交语义（纯函数级）
//
// 术语约定：选中 = 面板内临时高亮的选项（optionIndex，行首 >）；标记 = 空格写入、
// Enter 会提交生效的选项（selected，* / +）。
// 行为：未标记任何选项（selected 为空）且无自定义输入时，默认提交当前选中的（高亮）选项；
// 与 StatusPanel 的「无预选回退焦点行」语义一致。高亮在自定义兜底项时无选项可回退。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuestionAnswers } from "../src/app/question-transition.ts";
import type { QuestionPanelState } from "../src/app/state.ts";

function panel(
  overrides: Partial<QuestionPanelState["items"][number]> = {},
): QuestionPanelState {
  return {
    id: "q",
    items: [
      {
        id: "qa",
        question: "选择部署方式",
        options: [
          { label: "docker" },
          { label: "k8s" },
          { label: "serverless" },
        ],
        multiSelect: false,
        optionIndex: 0,
        selected: [],
        custom: "",
        ...overrides,
      },
    ],
    itemIndex: 0,
  };
}

test("有标记：提交 selected，不受高亮位置影响", () => {
  const p = panel({ optionIndex: 2, selected: ["docker"] });
  const { answers } = buildQuestionAnswers(p);
  assert.deepEqual(answers[0]!.selected, ["docker"]);
});

test("无标记 + 高亮在预设选项：默认提交当前选中的高亮选项（单选）", () => {
  const p = panel({ optionIndex: 1 });
  const { answers } = buildQuestionAnswers(p);
  assert.deepEqual(answers[0]!.selected, ["k8s"]);
});

test("无标记 + 高亮在自定义兜底项（optionIndex == options.length）：无可回退，保持空", () => {
  const p = panel({ optionIndex: 3 });
  const { answers } = buildQuestionAnswers(p);
  assert.deepEqual(answers[0]!.selected, []);
});

test("无标记 + 无高亮预设：带自定义文本时提交 custom、不回退高亮", () => {
  const p = panel({ optionIndex: 0, custom: "自己部署" });
  const { answers } = buildQuestionAnswers(p);
  assert.deepEqual(answers[0]!.selected, []);
  assert.equal(answers[0]!.custom, "自己部署");
});

test("多选无标记 + 高亮在预设选项：默认提交当前选中的高亮选项", () => {
  const p = panel({ multiSelect: true, optionIndex: 2 });
  const { answers } = buildQuestionAnswers(p);
  assert.deepEqual(answers[0]!.selected, ["serverless"]);
});

test("多选有标记：保持已标记集合，不受高亮位置影响", () => {
  const p = panel({
    multiSelect: true,
    optionIndex: 1,
    selected: ["docker", "k8s"],
  });
  const { answers } = buildQuestionAnswers(p);
  assert.deepEqual(answers[0]!.selected, ["docker", "k8s"]);
});

test("多选无标记 + 高亮在自定义兜底项：无可回退，保持空", () => {
  const p = panel({ multiSelect: true, optionIndex: 3 });
  const { answers } = buildQuestionAnswers(p);
  assert.deepEqual(answers[0]!.selected, []);
});
