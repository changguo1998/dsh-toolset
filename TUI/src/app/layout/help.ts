// TUI/src/app/layout/help.ts — /help 双列排版（无边框表格）
//
// 命令列定宽左对齐、描述列固定起点（像表格但不要边框线）。个别命令因含
// 别名/参数示例过长时，不再撑宽整表——命令留在本行、描述另起一行且缩进
// 到描述列起点（第二列）。描述超出 pane 宽时由渲染层软折行，每条命令行以
// `hanging` 悬挂缩进到描述列起点——续行不再穿回第一列，且 resize 后重新
// 折行仍然对齐（复用工具行的悬挂机制）。宽度基元复用 displayWidth（CJK
// 安全，补白按显示列计算）。

import { displayWidth } from "./markdown.ts";

/** 行首缩进列数（命令列左侧） */
export const HELP_MARGIN = 2;

/** 命令列与描述列之间的间距 */
export const HELP_GAP = 2;

/** 命令列宽上限（显示列）：超过此宽的命令视为「过长」，其描述不再跟在
 *  同行补白之后，而是另起一行缩进到描述列起点，避免单个长命令把整表
 *  描述列撑到右侧去（常见诱因：别名/参数示例合并写在一个命令里）。 */
export const HELP_CMD_MAX = 10;

/** /help 的一行：命令列文本（含别名/参数示例）+ 描述列文本 */
export interface HelpRow {
  cmd: string;
  desc: string;
}

/** 排好版的一行 /help 行：text = 缩进 + 命令 + 补白 + 间距 + 描述；
 *  hanging = 悬垂缩进（描述列起点），渲染层折行时续行停靠在该列。
 *  noCompact：/help 内容无论紧凑模式与否都完整显示（build-box notice 分支豁免） */
export interface HelpTableLine {
  text: string;
  hanging: number;
  noCompact: true;
}

/**
 * /help 双列表格排版：命令列宽 = min(最长命令显示宽, HELP_CMD_MAX)，每行文本 =
 * 行首缩进 + 命令 + 补白 + 间距 + 描述；命令显示宽超上限时拆成两条独立行——
 * 命令独占一行、描述另起一行（缩进 = 描述列起点）。拆行而非内嵌 \n：渲染层
 * 会给续行补 hanging 前导空格，若描述行文本再自带前导空格会叠加；拆成独立
 * 行让「首行缩进来自文本、续行缩进来自 hanging」各归其位，appendNoticeLines
 * 逐条成行时同样成立。折行交给渲染层（StyledText.hanging 悬挂到描述列），
 * 本函数不按 pane 宽预折行——宽度变化后重排仍然对齐。
 */
export function helpTableLines(rows: readonly HelpRow[]): HelpTableLine[] {
  const maxCmd = Math.max(0, ...rows.map((r) => displayWidth(r.cmd)));
  const col1 = Math.min(HELP_CMD_MAX, maxCmd);
  const hanging = HELP_MARGIN + col1 + HELP_GAP;
  const out: HelpTableLine[] = [];
  for (const r of rows) {
    const w = displayWidth(r.cmd);
    if (w > col1) {
      // 命令超宽：命令留在首行，描述另起一行缩进到描述列起点（第二列）。
      // 若命令本身也超 pane 宽，渲染层仍按 hanging 软折行停靠描述列。
      out.push({
        text: " ".repeat(HELP_MARGIN) + r.cmd,
        hanging,
        noCompact: true,
      });
      out.push({
        text: " ".repeat(hanging) + r.desc,
        hanging,
        noCompact: true,
      });
      continue;
    }
    out.push({
      text:
        " ".repeat(HELP_MARGIN) +
        r.cmd +
        " ".repeat(Math.max(0, col1 - w)) +
        " ".repeat(HELP_GAP) +
        r.desc,
      hanging,
      noCompact: true,
    });
  }
  return out;
}

/** /help 条目排序键 = **首个命令名**（去前导 `/`，取到第一个空白/顿号/逗号为止）：
 *  `/provider、/effort (/thinking)` 按 `provider` 排、`/stats (/usage /context)` 按
 *  `stats` 排、`/clearscreen (/cls)` 按 `clearscreen` 排（别名与参数示例不参与排序）。 */
export function helpSortKey(cmd: string): string {
  const head =
    cmd
      .trim()
      .replace(/^\//, "")
      .split(/[\s、,，]+/)[0] ?? "";
  const m = /^[a-z0-9_-]+/i.exec(head);
  return (m?.[0] ?? head).toLowerCase();
}

/** /help 条目按命令名**字母序**排列（大小写不敏感；键相同者保持原相对顺序=稳定排序）。
 *  条目在 App 侧按主题手写，展示前统一排序（口径：整体字母序，不再保留分组）。 */
export function sortHelpRows(rows: readonly HelpRow[]): HelpRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        helpSortKey(a.row.cmd).localeCompare(helpSortKey(b.row.cmd)) ||
        a.index - b.index,
    )
    .map((x) => x.row);
}
