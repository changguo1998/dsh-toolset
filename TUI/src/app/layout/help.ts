// TUI/src/app/layout/help.ts — /help 双列排版（无边框表格）
//
// 命令列定宽左对齐、描述列固定起点（像表格但不要边框线）。描述超出 pane
// 宽时由渲染层软折行，每条命令行以 `hanging` 悬挂缩进到描述列起点——
// 续行不再穿回第一列，且 resize 后重新折行仍然对齐（复用工具行的悬挂机制）。
// 宽度基元复用 displayWidth（CJK 安全，补白按显示列计算）。

import { displayWidth } from "./markdown.ts";

/** 行首缩进列数（命令列左侧） */
export const HELP_MARGIN = 2;

/** 命令列与描述列之间的间距 */
export const HELP_GAP = 2;

/** /help 的一行：命令列文本（含别名/参数示例）+ 描述列文本 */
export interface HelpRow {
  cmd: string;
  desc: string;
}

/** 排好版的一行 /help 行：text = 缩进 + 命令 + 补白 + 间距 + 描述；
 *  hanging = 悬垂缩进（描述列起点），渲染层折行时续行停靠在该列 */
export interface HelpTableLine {
  text: string;
  hanging: number;
}

/**
 * /help 双列表格排版：命令列宽 = 最长命令显示宽，每行文本 =
 * 行首缩进 + 命令 + 补白 + 间距 + 描述。折行交给渲染层（StyledText.hanging
 * 悬挂到描述列），本函数不按 pane 宽预折行——宽度变化后重排仍然对齐。
 */
export function helpTableLines(rows: readonly HelpRow[]): HelpTableLine[] {
  const col1 = Math.max(0, ...rows.map((r) => displayWidth(r.cmd)));
  const hanging = HELP_MARGIN + col1 + HELP_GAP;
  return rows.map((r) => ({
    text:
      " ".repeat(HELP_MARGIN) +
      r.cmd +
      " ".repeat(Math.max(0, col1 - displayWidth(r.cmd))) +
      " ".repeat(HELP_GAP) +
      r.desc,
    hanging,
  }));
}
