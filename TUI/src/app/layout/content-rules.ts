// TUI/src/app/layout/content-rules.ts — 内容规则共享层（buildBox 与 layout.ts 共同依赖）
//
// 不依赖 layout.ts（避免循环）；primitives.ts 只放宽度/换行基元，不放内容规则。
// 信息：工具行分组/折叠参数、tone 着色映射、对话/活动区分隔字形、判定谓词。

import type { FrameSegment } from "../../renderer/screen.ts";
import type { ColorName } from "../../renderer/theme.ts";
import type { NoticeTone } from "../adapter/dsh.ts";
import { charWidth } from "./markdown.ts";
import { seg } from "./primitives.ts";

// ---------------- 字形与分隔 ----------------

/** 对话 turn 之间的分隔线字形：用点更少的虚线（double dash），与窗口间实线区分 */
export const TURN_SEPARATOR_CHAR = "╌";

/** 活动区分隔线字形：对话历史 ↔ 流输出边界实线（窗口间统一实线） */
export const ACTIVITY_SEPARATOR = "─";

/** 对话区窗口下边框/状态区上方分隔线（其余横线一致的单线 `─`） */
export const STATUS_TOP_SEPARATOR = "─";

/** 水平分隔线字符（顶边 / 状态区下方横线等窗口间分隔；box-drawing 可与竖线连成连续线） */
export const SEPARATOR = "─";

// ---------------- 用户/助手缩进 ----------------

/** 用户消息块最小左缘留白（窄列降级阈值也用它）。
 *  6 = 正文区留白 gutter-1 = 5 列：输入最长折行时左缘与回复正文第 5 个字符同列
 *  （回复竖线占正文区第 0 列、正文自第 1 列起）。 */
export const USER_MIN_LEFT_GUTTER = 6;

/** 用户消息块最大正文宽：块整体靠右，左侧至少保留 gutter(默认 USER_MIN_LEFT_GUTTER) */
export function userMaxBodyWidth(
  width: number,
  gutter: number = USER_MIN_LEFT_GUTTER,
): number {
  return Math.max(1, width - Math.min(gutter, Math.max(0, width - 1)));
}

/** 模型正文块最大宽：右缘与用户块左缘对称留白(gutter)，与用户输入形成左右交错 */
export function assistantMaxBodyWidth(
  width: number,
  gutter: number = USER_MIN_LEFT_GUTTER,
): number {
  return Math.max(1, width - Math.min(gutter, Math.max(0, width - 1)));
}

/** 工具调用参数续行缩进：软换行/参数内显式换行后的续行统一 4 空格对齐 */
export const TOOL_CONT_INDENT = 4;

/**
 * 工具调用行折行（含续行缩进）：整体首行不缩进、可用全宽；其余行——同段软换行的
 * 续行、参数内显式换行后的各行——统一缩进 TOOL_CONT_INDENT 列，且折行宽度扣掉缩进，
 * 保证缩进后每行总宽不超 width（行首超宽字符仍强制放下，不丢字符）。
 * 参数内空行保留（与 split("\n") 语义一致）；窄窗口（width ≤ 缩进）降级不缩进，
 * 避免缩进本身溢出。
 */
export function wrapToolCallText(text: string, width: number): string[] {
  const indent = width > TOOL_CONT_INDENT ? TOOL_CONT_INDENT : 0;
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  // 当前行落盘：整体首行原样，其余行加续行缩进
  const flush = (): void => {
    rows.push(rows.length === 0 ? cur : " ".repeat(indent) + cur);
    cur = "";
    curW = 0;
  };
  for (const seg2 of text === "" ? [""] : text.split("\n")) {
    for (const ch of seg2) {
      const w = charWidth(ch);
      // 可用宽度：首行全宽，续行扣掉缩进
      const avail = Math.max(1, width - (rows.length === 0 ? 0 : indent));
      if (curW > 0 && curW + w > avail) flush();
      cur += ch;
      curW += w;
    }
    flush(); // 段末（参数内显式换行 / 末段收尾）
  }
  return rows;
}

// ---------------- 工具行分组/判定/渲染 ----------------

/** 工具行分组判定：无状态符号前缀的行=工具调用（新组起点）。
 * 前缀集与 tool-line.ts 各辅助行对齐（✓/✗/↻/⚑/⤷/↩//>/⇥/⌗/@/step） */
export const TOOL_STATUS_PREFIXES = [
  "✓ ",
  "✗ ",
  "↻ ",
  "⚑ ",
  "⤷ ",
  "↩ ",
  "/> ",
  "⇥ ",
  "⌗ ",
  "@ ",
  "step ",
];

/** 无状态符号前缀的行=工具调用行（新组起点） */
export function isToolCall(text: string): boolean {
  return !TOOL_STATUS_PREFIXES.some((p) => text.startsWith(p));
}

/** 工具结果行判定（✓ 成功 / ✗ 失败前缀）：结果行与调用行同规格折行缩进 */
export function isToolResult(text: string): boolean {
  return text.startsWith("✓ ") || text.startsWith("✗ ");
}

/** notice/tool 行 tone → 着色名（log 灰 / info 蓝 / warn 黄 / error 红 / success 绿） */
export const NOTICE_TONE_COLOR: Record<NoticeTone, ColorName> = {
  log: "gray",
  info: "blue",
  warn: "yellow",
  error: "red",
  success: "green",
};

/** 工具行前缀着色：✓ 前缀绿；其余原样（✗ 由 tone 整体着红） */
export function renderToolText(text: string): FrameSegment[] {
  if (text.startsWith("✓ ")) {
    return [seg("✓", { fg: "green" }), seg(" " + text.slice(2))];
  }
  return [seg(text)];
}

/** 工具调用行渲染：首词（工具名）染黄，其余原色（无前缀图标） */
export function renderToolNameLine(text: string): FrameSegment[] {
  const sp = text.indexOf(" ");
  if (sp < 0) return [seg(text, { fg: "yellow" })];
  return [seg(text.slice(0, sp), { fg: "yellow" }), seg(text.slice(sp))];
}
