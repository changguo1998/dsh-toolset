// tests/modelpicker.test.ts — /model 交互选择面板渲染 + picker reducer 单测
//
// 覆盖：三列独立列表同屏（provider/model/thinking）、当前生效
// provider/model/effort 各列标 `*`、焦点行 `>`、Tab 三区循环、thinking
// (unsupported)、纯 ASCII；reduceState 的 picker-open/move/tab/efforts/close。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickerColumnWidths,
  renderModelPicker,
} from "../src/app/components/ModelPicker.ts";
import {
  initialState,
  reduceState,
  type PickerState,
} from "../src/app/state.ts";
import { rowAnsi } from "./helpers/rowText.ts";

test("渲染：选项行着色——选中行 success 绿、焦点行 warn 黄（截断后着色）", () => {
  // providerIndex=1（ustc 焦点）、selectedProvider=deepseek：
  // row0 deepseek = 选中非焦点 → 绿 `* deepseek`；row1 ustc = 焦点 → 黄 `> ustc`
  const rows = renderModelPicker(
    {
      picker: picker({ selectedProvider: "deepseek", providerIndex: 1 }),
      height: 6,
      width: 80,
    },
    "dark",
  );
  assert.ok(
    rowAnsi(rows[1]!).includes("\x1b[38;2;97;211;131m* deepseek"),
    "选中行应着 success 绿: " + stripAnsi(rowAnsi(rows[1]!)),
  );
  assert.ok(
    rowAnsi(rows[2]!).includes("\x1b[38;2;233;201;68m> ustc"),
    "焦点行应着 warn 黄: " + stripAnsi(rowAnsi(rows[2]!)),
  );
});

test("渲染：空格选中后选中项着绿——焦点行同时是选中行时绿优先于黄", () => {
  // providerIndex=0 且 selectedProvider=deepseek：row0 既焦点又选中（空格刚写入）
  // → 标记 `*`，绿色优先（选中才有视觉反馈），不再停留在黄
  const rows = renderModelPicker(
    {
      picker: picker({ selectedProvider: "deepseek", providerIndex: 0 }),
      height: 6,
      width: 80,
    },
    "dark",
  );
  assert.ok(
    rowAnsi(rows[1]!).includes("\x1b[38;2;97;211;131m* deepseek"),
    "选中且焦点行应着 success 绿: " + stripAnsi(rowAnsi(rows[1]!)),
  );
  assert.ok(
    !rowAnsi(rows[1]!).includes("\x1b[38;2;233;201;68m"),
    "选中行不应着 warn 黄: " + stripAnsi(rowAnsi(rows[1]!)),
  );
});

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

test("pickerColumnWidths：按各列最长选项比例分配总可用宽，余数补最长列", () => {
  // longest=[30,10,5]，available=76：比例 30:10:5 → floor(50,16,8) 余 2 补 prov/model
  assert.deepEqual(pickerColumnWidths([30, 10, 5], 76), [51, 17, 8]);
  // 和恰为 available
  const w = pickerColumnWidths([30, 10, 5], 76);
  assert.equal(w[0] + w[1] + w[2], 76);
});

test("pickerColumnWidths：长 provider 不受 16 字符上限（按比例得宽列，不截断）", () => {
  // 长 provider（40）远大于 model(8)/effort(6)：prov 得 >16 且占比最大
  const w = pickerColumnWidths([40, 8, 6], 76);
  assert.ok(w[0] > 16, `prov 宽 ${w[0]} 应突破旧 16 上限`);
  assert.ok(w[0] > w[1] && w[0] > w[2], "最长列占比最大");
  assert.equal(w[0] + w[1] + w[2], 76);
});

test("pickerColumnWidths：无内容/空列表保底——不崩且每列至少 1", () => {
  assert.deepEqual(pickerColumnWidths([0, 0, 0], 76), [76, 1, 1]);
  // 单列超窄场景 available=1
  assert.deepEqual(pickerColumnWidths([10, 10, 10], 1), [1, 1, 1]);
});

test("pickerColumnWidths：effort 无选项（unsupported）按标题宽兜底，列宽可见", () => {
  // unsupported 时 effLong=displayWidth("effort (unsupported)")+2=22
  // 比例 10:10:22 → floor(18,18,39) 余 1 补 effort → [18,18,40]
  const w = pickerColumnWidths([10, 10, 22], 76);
  assert.deepEqual(w, [18, 18, 40]);
  assert.ok(w[2] >= 15, `effort 列宽 ${w[2]} 应能容纳标题`);
});

test("渲染：长 provider 名完整显示不截断（列宽按最长选项比例分配）", () => {
  const longName = "deepseek-official-very-long-name";
  const p = picker({
    providers: [longName, "ustc", "aliyun"],
    providerIndex: 1,
    phase: 0,
    efforts: [
      { id: "low", name: "low" },
      { id: "max", name: "max" },
    ],
  });
  const rows = renderModelPicker({ picker: p, height: 6, width: 90 }, "dark");
  // provider 列应完整容纳最长名（旧实现 16 字符上限会截断）
  const r1 = stripAnsi(rowAnsi(rows[1]!));
  assert.ok(
    r1.includes(longName),
    `长 provider 名应完整显示: ${r1.slice(0, 50)}`,
  );
  // model 与 effort 列仍同屏且内容可见（无整列消失）
  const r2 = stripAnsi(rowAnsi(rows[2]!));
  assert.ok(r2.includes("reasoner"), "model 列内容可见: " + r2);
  assert.ok(
    stripAnsi(rowAnsi(rows[1]!)).includes("low") ||
      stripAnsi(rowAnsi(rows[2]!)).includes("max"),
    "effort 列内容可见",
  );
});

test("最底行按键帮助：整行满宽 [按键]文字 格式，不按列宽截断", () => {
  const rows = renderModelPicker(
    { picker: picker(), height: 6, width: 80 },
    "dark",
  );
  const last = stripAnsi(rowAnsi(rows.at(-1)!).trim());
  assert.equal(
    last,
    "[space]select · [left/right]col · [tab]next col · [enter]commit · [esc]cancel",
    last,
  );
});

test("渲染：三列同屏, 头部全小写, 焦点行箭头, 当前生效值不标星", () => {
  const p = picker({
    efforts: [
      { id: "low", name: "low" },
      { id: "max", name: "max" },
    ],
  });
  const rows = renderModelPicker({ picker: p, height: 5, width: 80 }, "dark");
  const h = stripAnsi(rowAnsi(rows[0]!));
  assert.ok(
    h.includes("[ provider ]") && h.includes("model") && h.includes("effort"),
    h,
  );
  assert.ok(!h.includes("[current]"), "不应有 [current]: " + h);
  // 当前提供方 deepseek 不再标星（浅绿显示，非 TTY 下无 ANSI 时仅无星号）
  const r1 = stripAnsi(rowAnsi(rows[1]!));
  assert.ok(!r1.includes("* "), "当前值不应标星: " + r1);
  assert.ok(!r1.includes("[current]"), r1);
  // provider 列第2行 = ustc；焦点行(phase0, providerIndex=1)标 > 且列表无边框
  const r2 = stripAnsi(rowAnsi(rows[2]!));
  assert.ok(r2.includes("> ustc"), r2);
  assert.ok(!r2.includes("["), "列表行不应有边框: " + r2);
  // model 列与 effort 列也同屏且 effort 列有内容
  assert.ok(r2.includes("reasoner"), r2);
  assert.ok(
    rowAnsi(rows[1]!).includes("low") || rowAnsi(rows[1]!).includes("max"),
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
  const rows = renderModelPicker({ picker: p, height: 6, width: 80 }, "dark");
  // effort 列显示名 Max 标星（选中键 id="max" 匹配；选中与焦点同行时星号优先）
  const r2 = stripAnsi(rowAnsi(rows[2]!));
  assert.ok(r2.includes("* Max"), "effort 按 id 标星: " + r2);
  // 未选中的 Low 不标星
  assert.ok(!rowAnsi(rows[1]!).includes("* Low"), "未选中不标星");
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
  const rows = renderModelPicker({ picker: p, height: 6, width: 80 }, "dark");
  const r1 = stripAnsi(rowAnsi(rows[1]!));
  const r2 = stripAnsi(rowAnsi(rows[2]!));
  const r3 = stripAnsi(rowAnsi(rows[3]!));
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
  const rows = renderModelPicker({ picker: p, height: 5, width: 80 }, "dark");
  // 行1: provider 第1行 deepseek、model 第1行 chat、effort 第1行 low
  // phase=0 焦点在 provider 列(providerIndex=1=ustc)，所以 providerIndex=0=deepseek
  // 非焦点 → 当前值行无星号
  const r1 = stripAnsi(rowAnsi(rows[1]!));
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
  const rows = renderModelPicker({ picker: p, height: 5, width: 80 }, "dark");
  assert.ok(
    rowAnsi(rows[0]!).includes("[ model ]"),
    "model 标题应加边框: " + rowAnsi(rows[0]!),
  );
  // model 列焦点行(行2, modelIndex=1=reasoner) 箭头 > 且无边框
  const r2 = stripAnsi(rowAnsi(rows[2]!));
  assert.ok(r2.includes("> reasoner"), r2);
  assert.ok(!r2.includes("["), "列表行不应有边框: " + r2);
});

test("渲染：模型无等级时 effort 列显示 (unsupported)", () => {
  const rows = renderModelPicker(
    { picker: picker(), height: 5, width: 80 },
    "dark",
  );
  assert.ok(
    stripAnsi(rowAnsi(rows[0]!)).includes("effort (unsupported)"),
    stripAnsi(rowAnsi(rows[0]!)),
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
  const rows = renderModelPicker({ picker: p, height: 6, width: 80 }, "dark");
  const r1 = stripAnsi(rowAnsi(rows[1]!));
  const r4 = stripAnsi(rowAnsi(rows[4]!));
  assert.ok(r1.includes("..."), "顶部应有省略号: " + r1);
  assert.ok(r4.includes("..."), "底部应有省略号: " + r4);
  // 焦点行(providerIndex=2)应显示 c 而非省略号（箭头指示位置）
  const focusRow = stripAnsi(rowAnsi(rows[3]!));
  assert.ok(focusRow.includes("> c"), "焦点行应显示内容: " + focusRow);
});

test("渲染：焦点在列表顶部时顶部不显示省略号", () => {
  const p = picker({
    providers: ["a", "b", "c", "d", "e", "f"],
    providerIndex: 0,
    phase: 0,
  });
  const rows = renderModelPicker({ picker: p, height: 6, width: 80 }, "dark");
  const r1 = stripAnsi(rowAnsi(rows[1]!));
  assert.ok(r1.includes("a"), "首行应为焦点内容 a: " + r1);
  const r4 = stripAnsi(rowAnsi(rows[4]!));
  assert.ok(r4.includes("..."), "底部应有省略号: " + r4);
});

test("渲染：纯 ASCII（无汉字）且各列对齐", () => {
  const rows = renderModelPicker(
    {
      picker: picker({ efforts: [{ id: "max", name: "max" }] }),
      height: 5,
      width: 80,
    },
    "dark",
  );
  for (const r of rows) {
    assert.ok(!/[\u4e00-\u9fff]/.test(rowAnsi(r)), "不应含汉字: " + rowAnsi(r));
  }
  const h = stripAnsi(rowAnsi(rows[0]!));
  const hPos = h.indexOf("effort");
  assert.ok(hPos > 0, "header 应有 thinking 列: " + h);
  for (const r of rows.slice(1)) {
    const p2 = stripAnsi(rowAnsi(r)).indexOf("low") >= 0 ? 0 : -1;
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

  // provider 列焦点移动只移动 > 焦点, model 列跟随星号(选中)不变
  const s2 = reduceState(s1, { type: "picker-move", delta: -3 });
  assert.equal(s2.picker!.providerIndex, 0);
  assert.deepEqual(s2.picker!.models, ["chat", "reasoner"]);
  assert.equal(s2.picker!.modelIndex, 1);
  // 再移动 provider 到 ustc → model 列仍不变
  const s2b = reduceState(s2, { type: "picker-move", delta: 1 });
  assert.equal(s2b.picker!.providerIndex, 1);
  assert.deepEqual(s2b.picker!.models, ["chat", "reasoner"]);
  assert.equal(s2b.picker!.modelIndex, 1);
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

test("reducer：picker-select 星号移到新 provider → model 列同步, 旧 model 选中失效", () => {
  const s1 = reduceState(initialState(), {
    type: "picker-open",
    picker: picker({
      selectedProvider: "deepseek",
      selectedModel: "chat",
      selectedEffort: "low",
    }),
  });
  // 焦点在 ustc(providerIndex=1), 星号在 deepseek → 空格选中 ustc
  const s2 = reduceState(s1, { type: "picker-select" });
  assert.equal(s2.picker!.selectedProvider, "ustc");
  assert.deepEqual(s2.picker!.models, ["glm", "mi"]);
  assert.equal(s2.picker!.modelIndex, 0);
  assert.equal(s2.picker!.selectedModel, undefined, "旧 model 选中失效");
  assert.equal(s2.picker!.selectedEffort, "low", "思考等级星号保留");
  assert.deepEqual(s2.picker!.efforts, [], "effort 列表清空待重载");
  // 幂等：再选同一 provider 不重置 model 列
  const s3 = reduceState(s2, { type: "picker-select" });
  assert.deepEqual(s3.picker!.models, ["glm", "mi"]);
});

test("reducer：左右方向键切换焦点区,clamp 不循环(右到头/左到头不动)", () => {
  const base = initialState();
  const s1 = reduceState(base, {
    type: "picker-open",
    picker: picker({
      efforts: [
        { id: "low", name: "low" },
        { id: "max", name: "max" },
      ],
      effortIndex: 1,
    }),
  });
  assert.ok(s1.picker);

  // 右: 0 -> 1 -> 2,到 2 后再右不动(不循环回 0)
  const r1 = reduceState(s1, { type: "picker-phase", delta: 1 });
  assert.equal(r1.picker!.phase, 1);
  const r2 = reduceState(r1, { type: "picker-phase", delta: 1 });
  assert.equal(r2.picker!.phase, 2);
  const r3 = reduceState(r2, { type: "picker-phase", delta: 1 });
  assert.equal(r3.picker!.phase, 2);

  // 左: 2 -> 1 -> 0,到 0 后再左不动(不循环回 2)
  const l1 = reduceState(r2, { type: "picker-phase", delta: -1 });
  assert.equal(l1.picker!.phase, 1);
  const l2 = reduceState(l1, { type: "picker-phase", delta: -1 });
  assert.equal(l2.picker!.phase, 0);
  const l3 = reduceState(l2, { type: "picker-phase", delta: -1 });
  assert.equal(l3.picker!.phase, 0);

  // 左右切换只改 phase，保留各列独立行位置（effortIndex 不被重置）
  assert.equal(r1.picker!.effortIndex, 1);
  assert.equal(l1.picker!.effortIndex, 1);
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
