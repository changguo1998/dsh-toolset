// tests/picker-filter.test.ts — /model 面板筛选（picker-filter 纯函数 + reducer）
//
// 覆盖：匹配分档与排序（全等 / 前缀 / 段首前缀 / 子串 / 子序列 + 稳定 tie-break）、
// 空词默认序、逐键编辑（追加 / 删尾 / Ctrl 与功能键交回）、焦点列与筛选词、
// reducer 的 picker-filter（焦点行按值保持、effort 列不筛）、
// move / select / resolvePickerSelection 一律走**可见列表**（防「显示一套、取值另一套」）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickerFilterColumn,
  pickerFilterInput,
  pickerFilterText,
  pickerFocusedValues,
  pickerVisibleModels,
  pickerVisibleProviders,
  rankPickerItems,
} from "../src/app/picker-filter.ts";
import {
  initialState,
  reduceState,
  type PickerState,
} from "../src/app/state.ts";
import { resolvePickerSelection } from "../src/app/model-transition.ts";
import { rowText } from "./helpers/rowText.ts";
import { renderModelPicker } from "../src/app/components/ModelPicker.ts";

function picker(partial: Partial<PickerState> = {}): PickerState {
  return {
    providers: ["deepseek", "alibaba", "ustc"],
    providerIndex: 0,
    providerModels: {
      deepseek: ["deepseek-chat", "deepseek-reasoner"],
      alibaba: ["qwen-max", "qwen-plus"],
      ustc: ["glm-4", "mi-7b"],
    },
    models: ["deepseek-chat", "deepseek-reasoner"],
    modelIndex: 0,
    phase: 1,
    efforts: [],
    effortIndex: 0,
    ...partial,
  };
}

/** 带面板的 state（picker-open 后即可走 reducer / 渲染） */
function withPicker(p: PickerState) {
  return reduceState(initialState(), { type: "picker-open", picker: p });
}

// —— 匹配分档与排序 ——

test("rankPickerItems：分档顺序 = 全等 → 前缀 → 段首前缀 → 子串 → 子序列", () => {
  const items = [
    "qwen-max-long", // 子串（max 不在段首, 前缀是 qwen-）
    "x-max-y", // 段首前缀（`-` 之后）
    "max", // 全等
    "maxx", // 前缀
    "submax", // 子串
    "m-a-x", // 子序列（按序命中、可跳过）
    "unrelated", // 不匹配
  ];
  assert.deepEqual(rankPickerItems(items, "max"), [
    "max",
    "maxx",
    "x-max-y",
    "qwen-max-long",
    "submax",
    "m-a-x",
  ]);
});

test("rankPickerItems：同档按匹配起点 → 名称更短 → 原索引（稳定）", () => {
  // 三个子串命中：起点 0 是前缀（另档）；起点 1 / 4 同为子串 → 起点早者在前
  assert.deepEqual(rankPickerItems(["axx", "xxab"], "a"), ["axx", "xxab"]);
  // 同档同起点 → 名称更短者在前；再同则保持原索引
  assert.deepEqual(rankPickerItems(["mab", "mabc", "mabd"], "mab"), [
    "mab", // 全等
    "mabc", // 前缀
    "mabd", // 前缀
  ]);
  assert.deepEqual(rankPickerItems(["zzz-cat", "aaa-cat"], "cat"), [
    "zzz-cat",
    "aaa-cat",
  ]);
});

test("rankPickerItems：大小写不敏感；空词回落默认序（原序）；无命中 → 空", () => {
  assert.deepEqual(rankPickerItems(["GPT-5-Codex", "gpt-5"], "GPT-5"), [
    "gpt-5", // 全等（忽略大小写）
    "GPT-5-Codex", // 前缀
  ]);
  const items = ["b", "a", "c"];
  assert.deepEqual(rankPickerItems(items, ""), items);
  assert.deepEqual(
    rankPickerItems(items, "zzz"),
    [],
    "无命中 → 空列表（面板列留空）",
  );
});

test("rankPickerItems：返回新数组（不改原列表，默认序分支也不共享引用）", () => {
  const items = ["a", "b"];
  const out = rankPickerItems(items, "");
  assert.notEqual(out, items);
  out.push("c");
  assert.deepEqual(items, ["a", "b"]);
});

// —— 焦点列 / 筛选词 / 逐键编辑 ——

test("pickerFilterColumn / pickerFilterText：只 provider / model 两列可筛，各记各的词", () => {
  assert.equal(pickerFilterColumn(0), "provider");
  assert.equal(pickerFilterColumn(1), "model");
  assert.equal(pickerFilterColumn(2), null, "effort 列不筛");
  const p = picker({ phase: 0, providerFilter: "deep", modelFilter: "chat" });
  assert.equal(pickerFilterText(p), "deep");
  assert.equal(pickerFilterText({ ...p, phase: 1 }), "chat");
  assert.equal(pickerFilterText({ ...p, phase: 2 }), "", "effort 列恒空串");
});

test("pickerFilterInput：可打印字符追加、Backspace 删尾（按 code point）、其余交回", () => {
  assert.equal(pickerFilterInput("", "o", false), "o");
  assert.equal(pickerFilterInput("op", "u", false), "opu");
  assert.equal(pickerFilterInput("opu", "backspace", false), "op");
  assert.equal(
    pickerFilterInput("", "backspace", false),
    null,
    "词空删尾 → 交回",
  );
  assert.equal(
    pickerFilterInput("思考", "backspace", false),
    "思",
    "CJK 按 1 个字符删",
  );
  assert.equal(pickerFilterInput("a", "c", true), null, "Ctrl 组合不入选");
  assert.equal(pickerFilterInput("a", "up", false), null, "功能键不入选");
  assert.equal(pickerFilterInput("a", "\x7f", false), null, "裸 DEL 不入选");
});

// —— reducer：picker-filter ——

test("reducer picker-filter：只改当前焦点列的词，另一列不受影响", () => {
  let s = withPicker(picker({ phase: 0, modelFilter: "chat" }));
  s = reduceState(s, { type: "picker-filter", text: "ali" });
  assert.equal(s.picker!.providerFilter, "ali");
  assert.equal(s.picker!.modelFilter, "chat", "model 列的词不动");
  // 切到 model 列再输入 → 写 modelFilter
  s = reduceState(s, { type: "picker-phase", delta: 1 });
  s = reduceState(s, { type: "picker-filter", text: "chat" });
  assert.equal(s.picker!.modelFilter, "chat");
  assert.equal(s.picker!.providerFilter, "ali", "provider 列的词保留");
});

test("reducer picker-filter：焦点行按值保持（仍在可见列表内则跟随新下标）", () => {
  // provider 列焦点在 ustc（原下标 2）；输入 `u` 后可见列表 = [ustc] → 下标 0
  let s = withPicker(picker({ phase: 0, providerIndex: 2 }));
  s = reduceState(s, { type: "picker-filter", text: "u" });
  assert.deepEqual(pickerVisibleProviders(s.picker!), ["ustc"]);
  assert.equal(s.picker!.providerIndex, 0, "焦点跟随原焦点项");
  // 焦点项被筛掉（输入 `de`）→ 回落 0 = 匹配度最高项
  s = reduceState(s, { type: "picker-filter", text: "de" });
  assert.deepEqual(pickerVisibleProviders(s.picker!), ["deepseek"]);
  assert.equal(s.picker!.providerIndex, 0);
});

test("reducer picker-filter：星号选中不动（筛选只改显示与焦点）", () => {
  let s = withPicker(
    picker({ phase: 1, selectedProvider: "ustc", selectedModel: "glm-4" }),
  );
  s = reduceState(s, { type: "picker-filter", text: "qwen" });
  assert.equal(s.picker!.selectedProvider, "ustc");
  assert.equal(s.picker!.selectedModel, "glm-4");
  // 同词重设 → 幂等（state 引用不变）
  const same = reduceState(s, { type: "picker-filter", text: "qwen" });
  assert.equal(same, s);
});

test("reducer picker-filter：effort 列不筛（无操作）", () => {
  const s = withPicker(picker({ phase: 2 }));
  assert.equal(reduceState(s, { type: "picker-filter", text: "x" }), s);
});

// —— 可见列表是唯一真源：move / select / resolve 全部按显示序 ——

test("reducer picker-move：clamp 按可见列表长度（筛选后行数变少）", () => {
  let s = withPicker(picker({ phase: 1, modelFilter: "reason" }));
  assert.deepEqual(pickerVisibleModels(s.picker!), ["deepseek-reasoner"]);
  s = reduceState(s, { type: "picker-move", delta: 1 });
  assert.equal(
    s.picker!.modelIndex,
    0,
    "只有一个可见行 → 不动（旧实现会移到 1）",
  );
});

test("reducer picker-select：星号取可见列表焦点行（不是原列表同下标项）", () => {
  // model 列原列表 [deepseek-chat, deepseek-reasoner]；筛 `reason` → 可见 [deepseek-reasoner]
  let s = withPicker(picker({ phase: 1, modelFilter: "reason" }));
  s = reduceState(s, { type: "picker-select" });
  assert.equal(s.picker!.selectedModel, "deepseek-reasoner");
});

test("resolvePickerSelection：星号缺失时回退可见列表焦点行", () => {
  const p = picker({ phase: 0, providerFilter: "ali", providerIndex: 0 });
  const sel = resolvePickerSelection({
    ...p,
    selectedProvider: undefined,
    selectedModel: undefined,
  });
  assert.equal(sel?.provider, "alibaba");

  const pm = picker({ phase: 1, modelFilter: "plus", modelIndex: 0 });
  const sel2 = resolvePickerSelection({
    ...pm,
    selectedProvider: "alibaba",
    models: ["qwen-max", "qwen-plus"],
    selectedModel: undefined,
  });
  assert.equal(sel2?.model, "qwen-plus");
});

test("pickerFocusedValues：按可见序取各列焦点行值", () => {
  const p = picker({
    phase: 0,
    providerFilter: "us",
    providerIndex: 0,
    models: ["glm-4", "mi-7b"],
    modelFilter: "mi",
    modelIndex: 0,
  });
  assert.deepEqual(pickerFocusedValues(p), {
    provider: "ustc",
    model: "mi-7b",
  });
});

// —— 渲染：面板只显示可见列表，且与 select 取值同源 ——

test("渲染：筛选后 model 列只显示命中项（顺序 = 匹配度）", () => {
  const p = picker({
    phase: 1,
    modelFilter: "l",
    models: ["glm-4", "mi-7b", "qwen-plus", "llama"],
  });
  const rows = renderModelPicker({ picker: p, height: 6, width: 80 }).map(
    rowText,
  );
  const text = rows.join("\n");
  assert.ok(text.includes("llama"), "前缀命中排首位且可见");
  assert.ok(text.includes("glm-4"), "子串命中可见");
  assert.ok(!text.includes("mi-7b"), "不命中项不显示");
  const llamaRow = rows.findIndex((r) => r.includes("llama"));
  const glmRow = rows.findIndex((r) => r.includes("glm-4"));
  assert.ok(llamaRow < glmRow, "前缀命中排在子串命中之前");
});
