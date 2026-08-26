// tests/modelpicker.test.ts — /model 交互选择面板渲染 + picker reducer 单测
//
// 覆盖：左右分栏同屏（模型列 + 思考等级列）、当前模型 `*` [current]、焦点行
// `>` 行内加粗、Tab 切换焦点区(phase)、effort (unsupported)、纯 ASCII；
// reduceState 的 picker-open/move/tab/efforts/close。

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderModelPicker } from "../src/app/components/ModelPicker.ts";
import {
  initialState,
  reduceState,
  type PickerState,
} from "../src/app/state.ts";

function optionsOf(labels: string[], current = -1): PickerState["options"] {
  return labels.map((label, i) => ({
    label,
    selection: { provider: "p", model: label },
    current: i === current,
  }));
}

function picker(partial: Partial<PickerState> = {}): PickerState {
  return {
    options: optionsOf(["a/b", "a/c", "a/d"], 0),
    index: 1,
    phase: 0,
    efforts: [],
    effortIndex: 0,
    ...partial,
  };
}

const BOLD_ON = "\u001b[1m";
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

test("渲染：左右分栏, 模型列标 * [current] 焦点行 > 加粗, 等级列同屏", () => {
  const p = picker({
    efforts: [
      { id: "max", name: "max" },
      { id: "low", name: "low" },
    ],
  });
  const rows = renderModelPicker({ picker: p, height: 6, width: 60 });
  // 头部行: 左 model: 右 effort:
  const h = stripAnsi(rows[0]!.text);
  assert.ok(h.includes("model:") && h.includes("effort:"), h);
  // 左列: current 行标 *, 焦点行 > 且行内加粗; 右列同行的等级显示
  assert.ok(
    stripAnsi(rows[1]!.text).includes("* a/b [current]"),
    stripAnsi(rows[1]!.text),
  );
  assert.ok(rows[1]!.text.includes(BOLD_ON) === false, rows[1]!.text);
  const r1 = stripAnsi(rows[1]!.text);
  assert.ok(r1.includes("max"), "等级列与模型同屏: " + r1);
  const r2 = stripAnsi(rows[2]!.text);
  assert.ok(r2.includes("> a/c") && r2.includes("low"), r2);
  assert.ok(
    rows[2]!.text.includes(BOLD_ON + " > a/c"),
    "模型焦点行应单元格加粗",
  );
  const r3 = stripAnsi(rows[3]!.text);
  assert.ok(r3.includes("a/d"), r3);
});

test("渲染：焦点在等级列时,模型列无 > 且不加粗,等级行 > 行内加粗", () => {
  const p = picker({
    phase: 1,
    efforts: [
      { id: "max", name: "max" },
      { id: "low", name: "low" },
    ],
    effortIndex: 1,
  });
  const rows = renderModelPicker({ picker: p, height: 6, width: 60 });
  // 头部行: 等级列头部加粗 (焦点在等级列)
  assert.ok(rows[0]!.text.includes(BOLD_ON + " effort:"), rows[0]!.text);
  // 模型列: current 行标 *, 其余无 > 无加粗
  assert.ok(stripAnsi(rows[1]!.text).includes("* a/b [current]"));
  const r2 = stripAnsi(rows[2]!.text);
  assert.ok(r2.includes("a/c") && !r2.includes("> a/c"), r2);
  assert.ok(
    !rows[2]!.text.includes(BOLD_ON + " a/c"),
    "模型列单元格不应加粗: " + rows[2]!.text,
  );
  // 等级列: 焦点行(低) > 且加粗
  const r1 = stripAnsi(rows[1]!.text);
  assert.ok(r1.includes("max") && !r1.includes("> max"), r1);
  const r22 = stripAnsi(rows[2]!.text);
  assert.ok(r22.includes("> low"), r22);
  assert.ok(rows[2]!.text.includes(BOLD_ON + " > low"), "等级焦点行应加粗");
});

test("渲染：模型无等级时显示 effort (unsupported)", () => {
  const rows = renderModelPicker({ picker: picker(), height: 6, width: 60 });
  assert.ok(
    stripAnsi(rows[0]!.text).includes("effort: (unsupported)"),
    stripAnsi(rows[0]!.text),
  );
});

test("渲染：纯 ASCII（无汉字）", () => {
  const rows = renderModelPicker({
    picker: picker({ efforts: [{ id: "max", name: "max" }] }),
    height: 6,
    width: 60,
  });
  for (const r of rows) {
    assert.ok(!/[\u4e00-\u9fff]/.test(r.text), "不应含汉字: " + r.text);
  }
});

test("reducer：picker-open 激活 / 模型区 move clamp / tab 切焦点 / efforts 区 move / close", () => {
  const base = initialState();
  const s1 = reduceState(base, {
    type: "picker-open",
    picker: picker(),
  });
  assert.ok(s1.picker);
  assert.equal(s1.picker!.index, 1);
  assert.equal(s1.picker!.phase, 0);

  // 模型区上移
  const s2 = reduceState(s1, { type: "picker-move", delta: -3 });
  assert.equal(s2.picker!.index, 0);
  // 模型区下移 clamp
  const s3 = reduceState(s2, { type: "picker-move", delta: 9 });
  assert.equal(s3.picker!.index, 2);

  // Tab 切到思考等级区
  const s4 = reduceState(s3, { type: "picker-tab" });
  assert.equal(s4.picker!.phase, 1);

  // 等级区在 efforts 内 clamp
  const s5 = reduceState(s4, {
    type: "picker-efforts",
    efforts: [
      { id: "low", name: "low" },
      { id: "max", name: "max" },
    ],
  });
  assert.equal(s5.picker!.effortIndex, 0);
  const s6 = reduceState(s5, { type: "picker-move", delta: 5 });
  assert.equal(s6.picker!.effortIndex, 1);
  const s7 = reduceState(s6, { type: "picker-tab" });
  assert.equal(s7.picker!.phase, 0);

  const s8 = reduceState(s7, { type: "picker-close" });
  assert.equal(s8.picker, null);
});

test("reducer：等级区 efforts 为空时,方向键不移动(整面板不崩)", () => {
  const base = initialState();
  const s1 = reduceState(base, {
    type: "picker-open",
    picker: picker({ efforts: [], phase: 1 }),
  });
  const s2 = reduceState(s1, { type: "picker-move", delta: 1 });
  assert.equal(s2.picker!.effortIndex, 0);
});
