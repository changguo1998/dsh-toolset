// src/app/components/ModelPicker.ts — /model 交互选择面板渲染（纯函数）
//
// 输出恰 height 行：每行 = 标记 + 模型 label（纯 ASCII），当前模型标 `*`
// 并附 `[current]`，选中项标 `>` 并加粗；两者重叠时以 `*` 为标记（选中仍加粗）。
// 选项超出可视高度时视口跟随选中项滚动（选中项恒在视口内）。

import type { RenderLine } from "../../renderer/index.ts";
import type { PickerState } from "../state.ts";
import { truncateToWidth } from "../layout.ts";

export interface ModelPickerView {
  picker: PickerState;
  /** 面板可用行数（footer 高度） */
  height: number;
  /** 面板可用列宽 */
  width: number;
}

export function renderModelPicker(view: ModelPickerView): RenderLine[] {
  const { options, index } = view.picker;
  const height = Math.max(1, view.height);
  const len = options.length;
  // 视口跟随选中项：选中项超出可视范围时滚动（尽量置于底部），保证始终可见
  const viewStart =
    len <= height
      ? 0
      : Math.min(Math.max(0, index - (height - 1)), len - height);
  const rows: RenderLine[] = [];
  for (let i = 0; i < height; i++) {
    const idx = viewStart + i;
    if (idx >= len) {
      rows.push({ text: "" });
      continue;
    }
    const opt = options[idx]!;
    const selected = idx === index;
    // 标记：当前模型 `*`（始终显示），否则选中项 `>`；都不满足为空格
    let marker = " ";
    if (opt.current) marker = "*";
    else if (selected) marker = ">";
    const suffix = opt.current ? " [current]" : "";
    const text = truncateToWidth(` ${marker} ${opt.label}${suffix}`, view.width);
    rows.push(selected ? { text, style: { bold: true } } : { text });
  }
  return rows;
}
