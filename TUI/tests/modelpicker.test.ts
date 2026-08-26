// tests/modelpicker.test.ts — /model 交互选择面板渲染 + picker reducer 单测
//
// 覆盖：当前模型补行与 `*`/[current] 标记、选中项 `>` + 加粗、视口跟随选中项、
// 纯 ASCII；reduceState 的 picker-open/move/close。

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderModelPicker } from "../src/app/components/ModelPicker.ts";
import { initialState, reduceState, type PickerState } from "../src/app/state.ts";

function optionsOf(labels: string[], current = -1): PickerState["options"] {
  return labels.map((label, i) => ({
    label,
    selection: { provider: "p", model: label },
    current: i === current,
  }));
}

test("渲染：当前模型标 * 并附 [current]（非选中不加粗），选中项标 > 并加粗", () => {
  const picker: PickerState = {
    options: optionsOf(["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"], 0),
    index: 1,
  };
  const rows = renderModelPicker({ picker, height: 3, width: 60 });
  assert.equal(rows[0]!.text.trim(), "* deepseek/deepseek-chat [current]");
  assert.equal(rows[0]!.style, undefined);
  assert.equal(rows[1]!.text.trim(), "> deepseek/deepseek-reasoner");
  assert.deepEqual(rows[1]!.style, { bold: true });
  assert.equal(rows[2]!.text, ""); // 高度富余补空行
});

test("渲染：选中项恰为当前模型时标记取 * 且加粗（始终显示当前模型）", () => {
  const picker: PickerState = {
    options: optionsOf(["a/b", "a/c"], 0),
    index: 0,
  };
  const rows = renderModelPicker({ picker, height: 2, width: 60 });
  assert.equal(rows[0]!.text.trim(), "* a/b [current]");
  assert.deepEqual(rows[0]!.style, { bold: true });
});

test("渲染：视口跟随选中项（选项超出高度时选中项恒在视口内）", () => {
  const labels = ["m0", "m1", "m2", "m3", "m4", "m5"];
  const picker: PickerState = { options: optionsOf(labels), index: 5 };
  const rows = renderModelPicker({ picker, height: 3, width: 60 });
  assert.ok(rows[0]!.text.includes("m3"));
  assert.ok(rows[1]!.text.includes("m4"));
  assert.equal(rows[2]!.text.trim(), "> m5");
  assert.deepEqual(rows[2]!.style, { bold: true });
});

test("渲染：纯 ASCII（无汉字）", () => {
  const picker: PickerState = {
    options: optionsOf(["deepseek/deepseek-chat", "ustc/glm-5.2-107"], 1),
    index: 0,
  };
  const rows = renderModelPicker({ picker, height: 2, width: 60 });
  for (const r of rows) {
    assert.ok(!/[\u4e00-\u9fff]/.test(r.text), "不应含汉字: " + r.text);
  }
});

test("reducer：picker-open 激活 / picker-move clamp / picker-close 退出", () => {
  const base = initialState();
  const s1 = reduceState(base, {
    type: "picker-open",
    picker: { options: optionsOf(["a", "b"]), index: 0 },
  });
  assert.ok(s1.picker);
  assert.equal(s1.picker!.index, 0);

  // 下移 clamp 到末项
  const s2 = reduceState(s1, { type: "picker-move", delta: 5 });
  assert.equal(s2.picker!.index, 1);
  // 上移回到首项
  const s3 = reduceState(s2, { type: "picker-move", delta: -3 });
  assert.equal(s3.picker!.index, 0);

  const s4 = reduceState(s3, { type: "picker-close" });
  assert.equal(s4.picker, null);
});
