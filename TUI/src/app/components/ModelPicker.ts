// src/app/components/ModelPicker.ts — /model 交互选择面板渲染（纯函数）
//
// 输出恰 height 行：上区模型列表、下区思考等级列表，**两者同屏显示**。
// Tab 切换焦点（phase 0=模型，1=思考等级）。模型行：当前模型标 `*` 附
// `[current]`，焦点行标 `>` 并加粗；等级行：焦点行标 `>` 并加粗。
// 选项超出可视高度时视口跟随焦点项滚动（保证焦点项恒在视口内）。

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

/** 单列列表行：marker + text，焦点行加粗 */
function listRow(
  marker: string,
  text: string,
  width: number,
  focused: boolean,
): RenderLine {
  const line = truncateToWidth(` ${marker} ${text}`, width);
  return focused ? { text: line, style: { bold: true } } : { text: line };
}

/** 空行铺满剩余高度 */
function pad(rows: RenderLine[], n: number): void {
  for (let i = 0; i < n; i++) rows.push({ text: "" });
}

export function renderModelPicker(view: ModelPickerView): RenderLine[] {
  const { options, index, efforts, effortIndex, phase } = view.picker;
  const height = Math.max(1, view.height);
  const half = Math.max(1, Math.floor(height / 2));
  const modelH = Math.min(half, Math.max(1, options.length + 1));
  const effortH = height - modelH;
  const rows: RenderLine[] = [];

  // --- 模型区（header + 列表） ---
  const modelActive = phase === 0;
  rows.push(
    modelActive
      ? { text: truncateToWidth(" model:", view.width), style: { bold: true } }
      : { text: truncateToWidth(" model:", view.width) },
  );
  const modelRows = modelH - 1;
  const modelStart =
    options.length <= modelRows
      ? 0
      : Math.min(
          Math.max(0, index - (modelRows - 1)),
          options.length - modelRows,
        );
  for (let i = 0; i < modelRows; i++) {
    const idx = modelStart + i;
    if (idx >= options.length) {
      pad(rows, modelRows - i);
      break;
    }
    const opt = options[idx]!;
    const selected = idx === index;
    let marker = " ";
    if (opt.current) marker = "*";
    else if (selected && modelActive) marker = ">";
    const suffix = opt.current ? " [current]" : "";
    rows.push(
      listRow(marker, opt.label + suffix, view.width, selected && modelActive),
    );
  }

  // --- 思考等级区（header + 列表或提示） ---
  const effortActive = phase === 1;
  rows.push({
    text: truncateToWidth(
      ` effort:${efforts.length === 0 ? " (unsupported)" : ""}`,
      view.width,
    ),
    style: effortActive ? { bold: true } : undefined,
  } as RenderLine);
  const effortRows = Math.max(0, effortH - 1);
  if (efforts.length === 0) {
    pad(rows, effortRows);
  } else {
    const effStart =
      efforts.length <= effortRows
        ? 0
        : Math.min(
            Math.max(0, effortIndex - (effortRows - 1)),
            efforts.length - effortRows,
          );
    for (let i = 0; i < effortRows; i++) {
      const idx = effStart + i;
      if (idx >= efforts.length) {
        pad(rows, effortRows - i);
        break;
      }
      const e = efforts[idx]!;
      const focused = effortActive && idx === effortIndex;
      rows.push(listRow(focused ? ">" : " ", e.name, view.width, focused));
    }
  }

  // 高度补齐（模型空行已铺，effort 也铺过；此处兜底）
  const missing = height - rows.length;
  if (missing > 0) pad(rows, missing);
  return rows;
}
