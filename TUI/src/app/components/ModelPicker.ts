// src/app/components/ModelPicker.ts — /model 交互选择面板渲染（纯函数）
//
// 输出恰 height 行，**左右分栏同屏**：每行左单元格为模型列（`model:` 头部 +
// 列表），右单元格为思考等级列（`effort:` 头部 + 列表）。Tab 切换焦点
// （phase 0=模型列，1=等级列），焦点所在列头部加粗、焦点行行内加粗
// （ANSI 内联，同状态栏配色方式，不进入宽度计算）。模型行：当前模型标 `*`
// 附 `[current]`；等级行：焦点行标 `>`。列内选项超出可视高度时视口跟随。

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

const BOLD_ON = "\u001b[1m";
const BOLD_OFF = "\u001b[22m";
/** 行内加粗（ANSI 内联，不占显示宽度） */
function bold(s: string): string {
  return BOLD_ON + s + BOLD_OFF;
}

/** 视口起点：让焦点项恒在可视区内 */
function scrollStart(len: number, focus: number, rows: number): number {
  if (len <= rows || rows <= 0) return 0;
  return Math.min(Math.max(0, focus - (rows - 1)), len - rows);
}

export function renderModelPicker(view: ModelPickerView): RenderLine[] {
  const { options, index, efforts, effortIndex, phase } = view.picker;
  const height = Math.max(1, view.height);
  const width = Math.max(1, view.width);
  // 左右列宽分配（中间 1 格分隔）
  const halfW = Math.max(1, Math.floor((width - 1) / 2));
  const rightW = Math.max(1, width - 1 - halfW);
  const listRows = Math.max(0, height - 1); // 首行公共为两个列的头部

  const modelStart = scrollStart(options.length, index, listRows);
  const effStart = scrollStart(efforts.length, effortIndex, listRows);
  const unsupported = efforts.length === 0;
  const rows: RenderLine[] = [];
  for (let r = 0; r < height; r++) {
    // --- 左单元格：模型列 ---
    let left: string;
    let leftFocused = false;
    if (r === 0) {
      left = " model:";
      leftFocused = phase === 0;
    } else {
      const idx = modelStart + (r - 1);
      if (idx >= options.length) {
        left = "";
      } else {
        const opt = options[idx]!;
        const selected = idx === index;
        const marker =
          phase === 0 && selected && !opt.current
            ? ">"
            : opt.current
              ? "*"
              : " ";
        left = ` ${marker} ${opt.label}${opt.current ? " [current]" : ""}`;
        leftFocused = phase === 0 && selected;
      }
    }

    // --- 右单元格：思考等级列 ---
    let right: string;
    let rightFocused = false;
    if (r === 0) {
      right = unsupported ? " effort: (unsupported)" : " effort:";
      rightFocused = phase === 1;
    } else {
      const idx = effStart + (r - 1);
      if (unsupported || idx >= efforts.length) {
        right = "";
      } else {
        const e = efforts[idx]!;
        const selected = idx === effortIndex;
        right = ` ${selected && phase === 1 ? ">" : " "} ${e.name}`;
        rightFocused = selected && phase === 1;
      }
    }

    // 先按列宽截断、补空格对齐到列宽，再加粗（ANSI 不进入宽度计算）
    const lc = truncateToWidth(left, halfW).padEnd(halfW);
    const rc = truncateToWidth(right, rightW).padEnd(rightW);
    rows.push({
      text: `${leftFocused ? bold(lc) : lc} ${rightFocused ? bold(rc) : rc}`,
    });
  }
  return rows;
}
