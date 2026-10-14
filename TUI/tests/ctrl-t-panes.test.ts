// tests/ctrl-t-panes.test.ts — #9 Ctrl+T 聚焦 / 收起下半区（Turn 流 + Tool 面板区）
//
// 契约：缺省显示；`Ctrl+T` 未聚焦时聚焦（可见但未聚焦只聚焦、不隐藏）、已聚焦时收起 +
// 焦点回会话区；收起后活动区高度/宽度归零、空间并入对话区，输入栏不受影响；
// 显式隐藏时焦点从下半区移开；活动区内有交互面板打开时仍照常显示。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFrame, frameGeometry } from "../src/app/layout.ts";
import { displayWidth } from "../src/app/layout/markdown.ts";
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

test("#9 隐藏时焦点从下半区移开；Ctrl+T 再按 = 重新显示并聚焦", () => {
  let st = initialState();
  st = reduceState(st, { type: "focus-panel", panel: "activity" });
  assert.equal(st.focusedPanel, "activity");
  assert.equal(
    st.lowerPanesVisible,
    true,
    "聚焦不隐藏（可见时首次按键只聚焦）",
  );
  // 已聚焦再按 = 收起 + 焦点回会话区
  st = reduceState(st, { type: "focus-panel", panel: "activity" });
  assert.equal(st.focusedPanel, null, "收起后焦点回会话区");
  assert.equal(st.lowerPanesVisible, false, "收起 = 隐藏下半区");
  // 隐藏态下再按 = 重新显示并聚焦（不是「收起」——不可见时无从收起）
  st = reduceState(st, { type: "focus-panel", panel: "activity" });
  assert.equal(st.lowerPanesVisible, true, "隐藏态再按重新显示");
  assert.equal(st.focusedPanel, "activity", "并聚焦回合区");
});

test("#9 显式隐藏已聚焦的下半区：焦点被移开", () => {
  let st = reduceState(initialState(), {
    type: "focus-panel",
    panel: "activity",
  });
  st = reduceState(st, { type: "lower-panes", visible: false });
  assert.equal(st.focusedPanel, null, "隐藏即不聚焦");
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
    !rowsOf(st).some((r) => r.includes("── Turn ──")),
    "隐藏后不再有 Turn 标题（活动区分隔行消失）",
  );
  // 视作「只有会话 pane」：活动区宽归零、会话 pane 吃满区域宽（横向排列下也不会
  // 残留内部分隔竖线贴正文）
  assert.equal(hidden.activityW, 0, "活动区宽归零");
  assert.equal(hidden.dialogueW, hidden.contentW, "会话 pane 整宽");
  assert.equal(hidden.mode, "vertical", "隐藏态按纵向出图");
  // 隐藏态：内容行都补齐到整屏宽（右缘框线恒在固定列，不贴正文）；
  // 提示区（末尾 hintHeight 行）例外——提示文案按实际宽度出帧，右侧留白由渲染层补
  const cols = 80;
  const hintRows = frameGeometry(st, SIZE).hintHeight;
  const short = rowsOf(st)
    .slice(0, SIZE.rows - hintRows)
    .map((r, i) => [i, displayWidth(r)] as const)
    .filter(([, w]) => w !== cols && w !== 0 && w > 30);
  assert.deepEqual(
    short,
    [],
    `隐藏态无未补齐的内容行：${JSON.stringify(short)}`,
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
    rowsOf(st).some((r) => r.includes("── Tool ──")),
    "标题位写 `── Tool ──`",
  );
});
