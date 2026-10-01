// tests/ctrl-t-panes.test.ts — #9 Ctrl+T 切换下半区（Turn 流 + Tool 面板区）显隐
//
// 契约：缺省显示；切换后活动区高度/宽度归零、空间并入对话区，输入栏不受影响；
// 隐藏时焦点从下半区移开且焦点循环跳过 activity；活动区内有交互面板打开时仍照常显示。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFrame, frameGeometry } from "../src/app/layout.ts";
import { initialState, reduceState } from "../src/app/state.ts";
import { rowAnsi } from "./helpers/rowText.ts";

const SIZE = { rows: 24, cols: 80 } as const;
const rowsOf = (st: ReturnType<typeof initialState>): string[] =>
  buildFrame(st, SIZE).map((r) => rowAnsi(r));

test("#9 lower-panes：缺省显示，动作可反复切换", () => {
  let st = initialState();
  assert.equal(st.lowerPanesVisible, true, "缺省显示");
  st = reduceState(st, { type: "lower-panes" });
  assert.equal(st.lowerPanesVisible, false, "切换隐藏");
  st = reduceState(st, { type: "lower-panes" });
  assert.equal(st.lowerPanesVisible, true, "再切换恢复");
  st = reduceState(st, { type: "lower-panes", visible: false });
  assert.equal(st.lowerPanesVisible, false, "显式指定可见性");
});

test("#9 隐藏时焦点从下半区移开，焦点循环跳过 activity", () => {
  let st = initialState();
  st = reduceState(st, { type: "focus-panel-cycle" }); // null → history
  st = reduceState(st, { type: "focus-panel-cycle" }); // history → activity
  assert.equal(st.focusedPanel, "activity");
  st = reduceState(st, { type: "lower-panes", visible: false });
  assert.equal(st.focusedPanel, null, "隐藏即不聚焦");
  st = reduceState(st, { type: "focus-panel-cycle" }); // null → history
  st = reduceState(st, { type: "focus-panel-cycle" }); // history →（跳过 activity）status
  assert.equal(st.focusedPanel, "status", "循环跳过隐藏的下半区");
});

test("#9 隐藏时几何：活动区高度归零、空间并入对话区", () => {
  const shown = frameGeometry(initialState(), SIZE);
  const st = reduceState(initialState(), {
    type: "lower-panes",
    visible: false,
  });
  const hidden = frameGeometry(st, SIZE);
  assert.ok(shown.activityH > 0, "缺省有活动区");
  assert.equal(hidden.activityH, 0, "隐藏后活动区高度 0");
  assert.ok(
    hidden.dialogueH > shown.dialogueH,
    `对话区吃掉腾出的高度（${shown.dialogueH} → ${hidden.dialogueH}）`,
  );
  assert.ok(
    !rowsOf(st).some((r) => r.includes("-- Turn --")),
    "隐藏后不再有 Turn 标题（活动区分隔行消失）",
  );
});

test("#9 隐藏状态下交互面板仍照常显示（临时显示，不改可见性状态）", () => {
  let st = reduceState(initialState(), { type: "lower-panes", visible: false });
  st = reduceState(st, {
    type: "question-open",
    id: "q1",
    questions: [
      {
        id: "qa",
        question: "是否继续？",
        options: [{ label: "是" }],
        multiSelect: false,
      },
    ],
  });
  assert.equal(st.lowerPanesVisible, false, "可见性状态未被面板改变");
  assert.ok(
    frameGeometry(st, SIZE).activityH > 0,
    "面板打开时活动区恢复高度（面板可见）",
  );
  assert.ok(
    rowsOf(st).some((r) => r.includes("-- Tool --")),
    "标题位写 `-- Tool --`",
  );
});
