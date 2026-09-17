// TUI/src/app/layout/focus-frame.ts — 焦点框线全局覆写（规范见 SPEC.md §8 / DESIGN.md §8）
//
// 焦点框 = 全局覆写（不引入 box.border）：布局层产出焦点中性基线（灰线/
// 空白占位），FocusFrame 在 buildFrame 末尾对整帧一次扫描，把落在焦点
// 分区边界网格上的位置覆写为亮角字/边线。优先级 = 亮边 > 正常内容 >
// 空白占位（同一网格只写一次）；未聚焦（focusedPanel=null）不覆写。
//
// 不变式：不改变行数/行序；不切 CJK（宽度 2 字形内部 no-op）；不改行宽
// （覆写字符与目标字形同列宽）。矩形边界统一 right = x + w - 1、
// bottom = y + h - 1（advisor 定案）。

import type { FrameRow, FrameSegment, FrameStyle } from "../../renderer/screen.ts";
import type { ColorName, ThemeId } from "../../renderer/theme.ts";
import type { PaneId, Rect } from "./box.ts";
import { displayWidth } from "./markdown.ts";

/** 焦点框覆写上下文（不 import layout.ts / AppState，防循环依赖） */
export interface FocusFrameContext {
  themeId: ThemeId;
  focusedPanel: PaneId | null;
}

/** 焦点框亮色（与 layout.ts focusFrameColor 保持同一映射，防循环内联） */
export function focusColor(themeId: ThemeId): ColorName {
  return themeId === "dark" ? "brightWhite" : "black";
}

/** 分隔线默认字符（与现状 buildTopRegion/buildStatusSeparator 一致） */
export const FRAME_SEP = "─";
export const FRAME_DSEP = "│";

/**
 * 在指定显示列覆写一枚字形（就地改写 segments）。
 * - col 为显示列（0 基；跨段累加 displayWidth 定位）
 * - 目标字形为宽度 2（CJK）且覆写起点落在其内部 → no-op（不切）
 * - 覆写字形宽度须为 1（现状角字/线均为单列）
 * - 若原字形已是目标字形且样式一致 → 保持（幂等）
 */
export function setCell(
  row: FrameRow,
  col: number,
  ch: string,
  style?: FrameStyle,
): void {
  if (ch === "" || displayWidth(ch) !== 1) return;
  const segs = row.segments;
  // 定位 col 所在段与段内字形偏移（按显示宽度）
  let w = 0;
  let si = -1;
  let gi = 0; // 段内字形起始显示列
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const tw = displayWidth(s.text);
    if (col < w + tw) {
      si = i;
      gi = w; // 段起始显示列
      break;
    }
    w += tw;
  }
  if (si < 0) return; // col 超出该行宽度 → no-op
  const s = segs[si]!;
  // 段内逐字形定位：找到覆盖 col 的字形及其起始显示列
  let cw = gi;
  let cidx = 0; // 段内字形索引（代码点）
  let found = false;
  for (let i = 0; i < s.text.length; i++) {
    const chW = displayWidth(s.text[i]!);
    if (col < cw + chW) {
      cidx = i;
      found = true;
      break;
    }
    cw += chW;
    cidx = i + 1;
  }
  if (!found) return;
  const target = s.text[cidx]!;
  if (displayWidth(target) !== 1) return; // CJK 字形不覆写（仅 1 列字形，或整字节点）
  if (target === ch && (s.style === style || (s.style?.fg === style?.fg && s.style?.bg === style?.bg))) {
    return; // 幂等
  }
  // 构造替换后的段序列：段首..targetCol 保持 + 单字形替换 + 段尾
  const head = s.text.slice(0, cidx);
  const tail = s.text.slice(cidx + 1);
  const newSegs: FrameSegment[] = [];
  if (head !== "") newSegs.push({ text: head, style: s.style });
  newSegs.push({ text: ch, style });
  if (tail !== "") newSegs.push({ text: tail, style: s.style });
  row.segments = [
    ...segs.slice(0, si),
    ...newSegs,
    ...segs.slice(si + 1),
  ];
}

/** 帧中某行的纯文本（用于焦点规则判定：角字/线是否本就存在） */
export function rowPlain(row: FrameRow): string {
  return row.segments.map((s) => s.text).join("");
}

/** 覆写某行指定显示列（rowIndex 越界或 col 越界 → no-op） */
export function cover(
  rows: FrameRow[],
  rowIndex: number,
  col: number,
  ch: string,
  style?: FrameStyle,
): void {
  if (rowIndex < 0 || rowIndex >= rows.length) return;
  setCell(rows[rowIndex]!, col, ch, style);
}

/**
 * 焦点框覆写入口：整帧一次扫描，把焦点分区边界网格点亮。
 * rects 由布局层构造（帧坐标，right=x+w-1、bottom=y+h-1）：
 *   history/activity 矩形 = 左列（x=0, w=historyWidth，D 列=status 矩形 x 分隔）
 *   status 矩形 = 状态列（x=historyWidth, w=statusColWidth）
 * focusedPanel=null 时不覆写。
 */
export function focusFrame(
  ctx: FocusFrameContext,
  rects: Map<PaneId, Rect>,
  rows: FrameRow[],
): void {
  const panel = ctx.focusedPanel;
  if (panel === null) return;
  const rect = rects.get(panel);
  if (!rect) return;
  const style = { fg: focusColor(ctx.themeId) };
  const left = rect.x;
  const right = rect.x + rect.w - 1;
  const top = rect.y;
  const bottom = rect.y + rect.h - 1;
  // 分隔竖线列（历史/活动区右缘 = status 矩形左缘）
  const dCol = rects.get("status")?.x ?? left + rect.w;

  switch (panel) {
    case "history": {
      // 顶边 = 标题栏下划线行（rect.top）：
      cover(rows, top, left, "┌", style);
      cover(rows, top, dCol, "┐", style);
      for (let c = left + 1; c < dCol && c < right; c++) cover(rows, top, c, "─", style);
      // 左缘 + D 列竖线（对话区行）
      for (let r = top + 1; r < bottom; r++) {
        cover(rows, r, left, "│", style);
        cover(rows, r, dCol, "│", style);
      }
      // 底边 = 活动区分隔行：两端 ┘、正文 ─
      cover(rows, bottom, left, "┘", style);
      cover(rows, bottom, dCol, "┘", style);
      for (let c = left + 1; c < dCol && c < right; c++) cover(rows, bottom, c, "─", style);
      break;
    }
    case "activity": {
      // 顶边 = 活动区分隔行：左下 ┌、D 列 ┐、正文 ─
      cover(rows, top, left, "┌", style);
      cover(rows, top, dCol, "┐", style);
      for (let c = left + 1; c < dCol && c < right; c++) cover(rows, top, c, "─", style);
      // 左缘 + D 列竖线（活动区行）
      for (let r = top + 1; r < bottom; r++) {
        cover(rows, r, left, "│", style);
        cover(rows, r, dCol, "│", style);
      }
      // 底边 = 状态区上方分隔行：左下 └、D 列 ┴、正文 ─（左列段）
      cover(rows, bottom, left, "└", style);
      cover(rows, bottom, dCol, "┴", style);
      for (let c = left + 1; c < dCol && c < right; c++) cover(rows, bottom, c, "─", style);
      break;
    }
    case "status": {
      // 顶边 = 状态列顶行（rc0）：D 列 ┌、右缘 ┐、正文 ─
      cover(rows, top, dCol, "┌", style);
      cover(rows, top, right, "┐", style);
      for (let c = dCol + 1; c < right; c++) cover(rows, top, c, "─", style);
      // 右缘竖线（状态区行）
      for (let r = top + 1; r <= bottom; r++) cover(rows, r, right, "│", style);
      // 底边 = 状态区上方分隔行：D 列 ┴、右缘 ┘、正文 ─（右列段）
      cover(rows, bottom, right, "┘", style);
      cover(rows, bottom, dCol, "┴", style);
      for (let c = dCol + 1; c < right; c++) cover(rows, bottom, c, "─", style);
      break;
    }
  }
}
