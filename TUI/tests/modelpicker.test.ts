// tests/modelpicker.test.ts — /model 交互选择面板渲染 + picker reducer 单测
//
// 覆盖：模型/思考等级两列同屏、当前模型 `*` + [current]、焦点行 `>` + 加粗、
// Tab 切换焦点区(phase)、视口跟随、纯 ASCII；reduceState 的 picker-open/move/tab/
// efforts/close。

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

test("渲染：模型列标 * [current]，焦点行 > 加粗；等级列同屏显示", () => {
  const p = picker({
    efforts: [
      { id: "max", name: "max" },
      { id: "low", name: "low" },
    ],
  });
  const rows = renderModelPicker({ picker: p, height: 8, width: 60 });
  // 模型列占上半屏：头部 + 3 行模型
  assert.equal(rows[0]!.text.trim(), "model:");
  assert.equal(rows[1]!.text.trim(), "* a/b [current]");
  assert.equal(rows[1]!.style, undefined);
  assert.equal(rows[2]!.text.trim(), "> a/c");
  assert.deepEqual(rows[2]!.style, { bold: true });
  assert.equal(rows[3]!.text.trim(), "a/d");
  // 等级列占下半屏：头部 + 2 行等级(其余补空)
  assert.equal(rows[4]!.text.trim(), "effort:");
  assert.equal(rows[5]!.text.trim(), "max");
  assert.equal(rows[6]!.text.trim(), "low");
});

test("渲染：焦点在等级列时,模型列不加粗、等级行 > 加粗", () => {
  const p = picker({
    phase: 1,
    efforts: [
      { id: "max", name: "max" },
      { id: "low", name: "low" },
    ],
    effortIndex: 1,
  });
  const rows = renderModelPicker({ picker: p, height: 8, width: 60 });
  assert.equal(rows[1]!.text.trim(), "* a/b [current]");
  assert.equal(rows[1]!.style, undefined);
  assert.equal(rows[2]!.text.trim(), "a/c");
  assert.equal(rows[2]!.style, undefined);
  assert.equal(rows[3]!.text.trim(), "a/d");
  assert.equal(rows[4]!.text.trim(), "effort:");
  assert.equal(rows[5]!.text.trim(), "max");
  assert.equal(rows[6]!.text.trim(), "> low");
  assert.deepEqual(rows[6]!.style, { bold: true });
});

test("渲染：模型无等级时显示 effort (unsupported)", () => {
  const rows = renderModelPicker({ picker: picker(), height: 6, width: 60 });
  const texts = rows.map((r) => r.text.trim());
  assert.ok(
    texts.some((t) => t.includes("effort: (unsupported)")),
    texts.join(","),
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
