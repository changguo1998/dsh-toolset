// tests/panel.test.ts — 面板场景原语（panel.ts）结构单测
//
// 覆盖：panelTitle/panelQuestion/panelExplanation 返回 Paragraph 形状与
// 默认样式；panelOptions 的标记语义（焦点 `>` 黄 / 单选选中 `*` 绿 / 多选
// `+`）；经 fill 摊平后的实际渲染（标记段 + 文本段）。原语为纯组装糖，
// 不改布局语义（SPEC.md §7）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  panelTitle,
  panelQuestion,
  panelExplanation,
  panelOptions,
} from "../src/app/layout/panel.ts";
import type { Paragraph, Box, StyledText } from "../src/app/layout/box.ts";
import { measure, allocate } from "../src/app/layout/measure.ts";
import { fillToList } from "../src/app/layout/fill.ts";
import { rowText } from "./helpers/rowText.ts";

const ctx = { themeId: "dark" as const, viewportWidth: 40 };

/** 以 fill 摊平节点 → 纯文本行 */
function rowsOf(node: Box | Paragraph | StyledText, w = 40): string[] {
  const st = measure(node, { maxW: w });
  const rects = allocate(st, { x: 0, y: 0, w, h: 1000 });
  return fillToList(ctx, node, { x: 0, y: 0, w, h: 1000 }, rects).map(rowText);
}

test("panelTitle：StyledText（bold）且 fill 渲染为标题全文", () => {
  const t = panelTitle("等待审批");
  assert.equal(t.kind, "styled");
  assert.deepEqual(t.segments, [{ text: "等待审批", style: { bold: true } }]);
  assert.deepEqual(rowsOf(t), ["等待审批"]);
});

test("panelTitle：自定义样式与 bold 合并", () => {
  const t = panelTitle("标题", { style: { fg: "blue" } });
  assert.deepEqual(t.segments, [
    { text: "标题", style: { bold: true, fg: "blue" } },
  ]);
});

test("panelTitle：bold:false 不加粗", () => {
  const t = panelTitle("标题", { style: { fg: "yellow" }, bold: false });
  assert.deepEqual(t.segments, [{ text: "标题", style: { fg: "yellow" } }]);
});

test("panelQuestion/panelExplanation：StyledText + 透传样式", () => {
  const q = panelQuestion("问题？");
  assert.equal(q.kind, "styled");
  assert.deepEqual(q.segments, [{ text: "问题？" }]);
  const e = panelExplanation("说明", { style: { fg: "gray" } });
  assert.deepEqual(e.segments, [{ text: "说明", style: { fg: "gray" } }]);
  assert.deepEqual(rowsOf(q), ["问题？"]);
});

test("panelOptions：单选标记（焦点>黄 / 选中*绿 / 普通）", () => {
  const box = panelOptions([
    { label: "是", focused: true },
    { label: "否", selected: true },
    { label: "跳过" },
  ]);
  assert.equal(box.kind, "box");
  assert.equal(box.children.length, 3);
  const rows = rowsOf(box);
  // 对齐现状 StatusPanel：前导空格 + 游标 + 选中标记 + 空格
  assert.deepEqual(rows, [" >  是", "  * 否", "    跳过"]);
  // 焦点/选中行整行着色（标记段 + label 段同色）
  const f = box.children[0] as StyledText;
  assert.deepEqual(f.segments, [
    { text: " >  ", style: { fg: "yellow" } },
    { text: "是", style: { fg: "yellow" } },
  ]);
  const s = box.children[1] as StyledText;
  assert.deepEqual(s.segments, [
    { text: "  * ", style: { fg: "green" } },
    { text: "否", style: { fg: "green" } },
  ]);
});

test("panelOptions：焦点行同时选中时绿优先（选中即绿，与 ModelPicker 一致）", () => {
  const box = panelOptions([{ label: "是", focused: true, selected: true }]);
  const row = box.children[0] as StyledText;
  assert.deepEqual(row.segments, [
    { text: " >* ", style: { fg: "green" } },
    { text: "是", style: { fg: "green" } },
  ]);
});

test("panelOptions：多选标记 + 与游标关闭", () => {
  const m = rowsOf(
    panelOptions([{ label: "a", selected: true }, { label: "b" }], {
      multiSelect: true,
    }),
  );
  assert.deepEqual(m, ["  + a", "    b"]);
  const n = rowsOf(
    panelOptions([{ label: "c", selected: true }], {
      cursor: "",
      multiSelect: true,
    }),
  );
  assert.deepEqual(n, ["  + c"]);
});

test("panelOptions：自定义焦点/选中样式透传", () => {
  const box = panelOptions(
    [{ label: "x", focused: true, focusStyle: { fg: "red" } }],
    { cursor: ">" },
  );
  const f = box.children[0] as StyledText;
  assert.deepEqual(f.segments[0], { text: " >  ", style: { fg: "red" } });
});
