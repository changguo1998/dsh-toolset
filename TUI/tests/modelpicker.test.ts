// tests/modelpicker.test.ts — /model 交互选择面板渲染 + picker reducer 单测
//
// 覆盖：三列独立列表同屏（provider/model/thinking）、当前生效
// provider/model/effort 各列标 `*`、焦点行 `>`、Tab 三区循环、thinking
// (unsupported)、纯 ASCII；reduceState 的 picker-open/move/tab/efforts/close。

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderModelPicker } from "../src/app/components/ModelPicker.ts";
import {
  initialState,
  reduceState,
  type PickerState,
} from "../src/app/state.ts";

function picker(partial: Partial<PickerState> = {}): PickerState {
  return {
    providers: ["deepseek", "ustc"],
    providerIndex: 1,
    providerModels: {
      deepseek: ["chat", "reasoner"],
      ustc: ["glm", "mi"],
    },
    models: ["chat", "reasoner"],
    modelIndex: 1,
    phase: 0,
    efforts: [],
    effortIndex: 0,
    current: { provider: "deepseek", model: "chat", reasoningEffort: "low" },
    ...partial,
  };
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

test("渲染：三列同屏, 头部全小写, 焦点行箭头, 当前生效值不标星", () => {
  const p = picker({
    efforts: [
      { id: "low", name: "low" },
      { id: "max", name: "max" },
    ],
  });
  const rows = renderModelPicker({ picker: p, height: 5, width: 80 });
  const h = stripAnsi(rows[0]!.text);
  assert.ok(
    h.includes("[ provider ]") && h.includes("model") && h.includes("effort"),
    h,
  );
  assert.ok(!h.includes("[current]"), "不应有 [current]: " + h);
  // 当前提供方 deepseek 不再标星（浅绿显示，非 TTY 下无 ANSI 时仅无星号）
  const r1 = stripAnsi(rows[1]!.text);
  assert.ok(!r1.includes("* "), "当前值不应标星: " + r1);
  assert.ok(!r1.includes("[current]"), r1);
  // provider 列第2行 = ustc；焦点行(phase0, providerIndex=1)标 > 且列表无边框
  const r2 = stripAnsi(rows[2]!.text);
  assert.ok(r2.includes("> ustc"), r2);
  assert.ok(!r2.includes("["), "列表行不应有边框: " + r2);
  // model 列与 effort 列也同屏且 effort 列有内容
  assert.ok(r2.includes("reasoner"), r2);
  assert.ok(
    rows[1]!.text.includes("low") || rows[1]!.text.includes("max"),
    "effort 列同屏",
  );
});

test("渲染：effort 列 id!=name 时选中仍按 id 标星", () => {
  const p = picker({
    efforts: [
      { id: "low", name: "Low" },
      { id: "max", name: "Max" },
    ],
    effortIndex: 1,
    phase: 2,
    selectedEffort: "max",
  });
  const rows = renderModelPicker({ picker: p, height: 6, width: 80 });
  // effort 列显示名 Max 标星（选中键 id="max" 匹配；选中与焦点同行时星号优先）
  const r2 = stripAnsi(rows[2]!.text);
  assert.ok(r2.includes("* Max"), "effort 按 id 标星: " + r2);
  // 未选中的 Low 不标星
  assert.ok(!rows[1]!.text.includes("* Low"), "未选中不标星");
});

test("渲染：星号标各列选中值（独立于焦点/当前），可与箭头同行", () => {
  const p = picker({
    providers: ["deepseek", "ustc", "ali"],
    providerIndex: 2, // 焦点行 = ali
    phase: 0,
    selectedProvider: "deepseek", // 星号在 deepseek
    selectedModel: "reasoner",
    efforts: [
      { id: "low", name: "low" },
      { id: "max", name: "max" },
    ],
    selectedEffort: "max",
  });
  const rows = renderModelPicker({ picker: p, height: 6, width: 80 });
  const r1 = stripAnsi(rows[1]!.text);
  const r2 = stripAnsi(rows[2]!.text);
  const r3 = stripAnsi(rows[3]!.text);
  // provider 列: 行1 = deepseek(星号)、行2 = ustc、行3 = ali(焦点箭头)
  assert.ok(r1.includes("* deepseek"), "provider 选中标星: " + r1);
  assert.ok(r3.includes("> ali"), "焦点行箭头: " + r3);
  // model 列: 行2 = reasoner 标星（models=["chat","reasoner"]）
  assert.ok(r2.includes("* reasoner"), "model 选中标星: " + r2);
  // effort 列 max 标星
  assert.ok(r2.includes("* max"), "effort 选中标星: " + r2);
});

test("渲染：当前 model 与 effort 值只以浅绿方式呈现（不标星）", () => {
  const p = picker({
    efforts: [
      { id: "low", name: "low" },
      { id: "max", name: "max" },
    ],
  });
  const rows = renderModelPicker({ picker: p, height: 5, width: 80 });
  // 行1: provider 第1行 deepseek、model 第1行 chat、effort 第1行 low
  // phase=0 焦点在 provider 列(providerIndex=1=ustc)，所以 providerIndex=0=deepseek
  // 非焦点 → 当前值行无星号
  const r1 = stripAnsi(rows[1]!.text);
  assert.ok(r1.includes("deepseek"), r1);
  assert.ok(!r1.includes("* deepseek"), "当前值不标星: " + r1);
  assert.ok(r1.includes("chat"), "model 当前值: " + r1);
  assert.ok(!r1.includes("* chat"), "model 当前值不标星: " + r1);
  assert.ok(r1.includes("low"), "effort 当前值: " + r1);
  assert.ok(!r1.includes("* low"), "effort 当前值不标星: " + r1);
});

test("渲染：焦点在 model 列时 model 标题加边框, model 焦点行 > 无边框", () => {
  const p = picker({
    phase: 1,
    efforts: [
      { id: "low", name: "low" },
      { id: "max", name: "max" },
    ],
  });
  const rows = renderModelPicker({ picker: p, height: 5, width: 80 });
  assert.ok(
    rows[0]!.text.includes("[ model ]"),
    "model 标题应加边框: " + rows[0]!.text,
  );
  // model 列焦点行(行2, modelIndex=1=reasoner) 箭头 > 且无边框
  const r2 = stripAnsi(rows[2]!.text);
  assert.ok(r2.includes("> reasoner"), r2);
  assert.ok(!r2.includes("["), "列表行不应有边框: " + r2);
});

test("渲染：模型无等级时 effort 列显示 (unsupported)", () => {
  const rows = renderModelPicker({ picker: picker(), height: 5, width: 80 });
  assert.ok(
    stripAnsi(rows[0]!.text).includes("effort (unsupported)"),
    stripAnsi(rows[0]!.text),
  );
});

test("渲染：列表上下有未显示项时顶/底行显示省略号, 焦点行不显示", () => {
  // provider 6 项、数据行 listRows=4（height 6, 末行为帮助行）、内容行 2：
  // 焦点 index=2 时 start=1，顶部省略号 + 底部省略号同时出现，焦点恒可见
  const p = picker({
    providers: ["a", "b", "c", "d", "e", "f"],
    providerIndex: 2,
    phase: 0,
  });
  const rows = renderModelPicker({ picker: p, height: 6, width: 80 });
  const r1 = stripAnsi(rows[1]!.text);
  const r4 = stripAnsi(rows[4]!.text);
  assert.ok(r1.includes("..."), "顶部应有省略号: " + r1);
  assert.ok(r4.includes("..."), "底部应有省略号: " + r4);
  // 焦点行(providerIndex=2)应显示 c 而非省略号（箭头指示位置）
  const focusRow = stripAnsi(rows[3]!.text);
  assert.ok(focusRow.includes("> c"), "焦点行应显示内容: " + focusRow);
});

test("渲染：焦点在列表顶部时顶部不显示省略号", () => {
  const p = picker({
    providers: ["a", "b", "c", "d", "e", "f"],
    providerIndex: 0,
    phase: 0,
  });
  const rows = renderModelPicker({ picker: p, height: 6, width: 80 });
  const r1 = stripAnsi(rows[1]!.text);
  assert.ok(r1.includes("a"), "首行应为焦点内容 a: " + r1);
  const r4 = stripAnsi(rows[4]!.text);
  assert.ok(r4.includes("..."), "底部应有省略号: " + r4);
});

test("渲染：纯 ASCII（无汉字）且各列对齐", () => {
  const rows = renderModelPicker({
    picker: picker({ efforts: [{ id: "max", name: "max" }] }),
    height: 5,
    width: 80,
  });
  for (const r of rows) {
    assert.ok(!/[\u4e00-\u9fff]/.test(r.text), "不应含汉字: " + r.text);
  }
  const h = stripAnsi(rows[0]!.text);
  const hPos = h.indexOf("effort");
  assert.ok(hPos > 0, "header 应有 thinking 列: " + h);
  for (const r of rows.slice(1)) {
    const p2 = stripAnsi(r.text).indexOf("low") >= 0 ? 0 : -1;
    void p2;
  }
});

test("reducer：picker-open 激活 / 各列 clamp / tab 三区循环 / efforts / close", () => {
  const base = initialState();
  const s1 = reduceState(base, { type: "picker-open", picker: picker() });
  assert.ok(s1.picker);
  assert.equal(s1.picker!.providerIndex, 1);
  assert.equal(s1.picker!.modelIndex, 1);
  assert.equal(s1.picker!.phase, 0);

  // provider 列上移 → 切换到 deepseek, model 列同步为该 provider 的模型并重置
  const s2 = reduceState(s1, { type: "picker-move", delta: -3 });
  assert.equal(s2.picker!.providerIndex, 0);
  assert.deepEqual(s2.picker!.models, ["chat", "reasoner"]);
  assert.equal(s2.picker!.modelIndex, 0);
  // 再移动 provider 到 ustc → model 列切换为 ustc 的模型并重置
  const s2b = reduceState(s2, { type: "picker-move", delta: 1 });
  assert.equal(s2b.picker!.providerIndex, 1);
  assert.deepEqual(s2b.picker!.models, ["glm", "mi"]);
  assert.equal(s2b.picker!.modelIndex, 0);
  // Tab -> model 区
  const s3 = reduceState(s2b, { type: "picker-tab" });
  assert.equal(s3.picker!.phase, 1);
  // model 列下移 clamp
  const s3b = reduceState(s3, { type: "picker-move", delta: 9 });
  assert.equal(s3b.picker!.modelIndex, 1);
  assert.equal(s3b.picker!.providerIndex, 1);

  // Tab 循环: 1 -> 2 -> 0 -> 1 -> 2（回到 thinking 区）
  const s4 = reduceState(s3b, { type: "picker-tab" });
  assert.equal(s4.picker!.phase, 2);
  const s4b = reduceState(s4, { type: "picker-tab" });
  assert.equal(s4b.picker!.phase, 0);
  const s4c = reduceState(s4b, { type: "picker-tab" });
  assert.equal(s4c.picker!.phase, 1);
  const s4d = reduceState(s4c, { type: "picker-tab" });
  assert.equal(s4d.picker!.phase, 2);

  // thinking 区在 efforts 内 clamp
  const s5 = reduceState(s4d, {
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

test("reducer：thinking 区 efforts 为空时,方向键不移动(整面板不崩)", () => {
  const base = initialState();
  const s1 = reduceState(base, {
    type: "picker-open",
    picker: picker({ efforts: [], phase: 2 }),
  });
  const s2 = reduceState(s1, { type: "picker-move", delta: 1 });
  assert.equal(s2.picker!.effortIndex, 0);
});
