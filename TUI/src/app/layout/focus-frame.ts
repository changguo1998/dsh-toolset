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

import type {
  FrameRow,
  FrameSegment,
  FrameStyle,
} from "../../renderer/screen.ts";
import type { ColorName, ThemeId } from "../../renderer/theme.ts";
import type { PaneId, Rect } from "./box.ts";
import { displayWidth } from "./markdown.ts";

/** 焦点框覆写上下文（不 import layout.ts / AppState，防循环依赖） */
export interface FocusFrameContext {
  themeId: ThemeId;
  focusedPanel: PaneId | null;
  /** 标题栏下划线行（=diaStart-1；无下划线时 0/-1）——该行 D 列在 status 焦点保持灰 ┤ */
  titleUnderlineRow?: number;
  /** 活动区分隔行（=diaEnd）——该行 D 列为连接字形 `┤`，status 焦点覆写亮 ┤ */
  activitySepRow?: number;
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
 * - 目标字形为宽度 2（CJK/宽 emoji）且覆写起点落在其内部 → no-op（不切）
 * - 覆写字形宽度须为 1（现状角字/线均为单列）
 * - 若原字形已是目标字形且样式全字段一致 → 保持（幂等）
 * - 段按 code point 切分（surrogate pair emoji 不切两半）
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
  let gi = 0; // 段起始显示列
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const tw = displayWidth(s.text);
    if (col < w + tw) {
      si = i;
      gi = w;
      break;
    }
    w += tw;
  }
  if (si < 0) return; // col 超出该行宽度 → no-op
  const s = segs[si]!;
  // 段内逐 code point 定位（isHighSurrogate 前导合并，防切 surrogate pair）
  let cw = gi;
  let cidx = 0; // 段内字形起始（UTF-16 索引）
  let found = false;
  for (let i = 0; i < s.text.length;) {
    const cp = s.text.codePointAt(i)!;
    const cpLen = cp > 0xffff ? 2 : 1;
    const chW = displayWidth(String.fromCodePoint(cp));
    if (col < cw + chW) {
      cidx = i;
      found = true;
      break;
    }
    cw += chW;
    i += cpLen;
    cidx = i;
  }
  if (!found) return;
  const target = s.text.codePointAt(cidx);
  if (target === undefined) return;
  const targetCh = String.fromCodePoint(target);
  if (displayWidth(targetCh) !== 1) return; // 宽字形不覆写（仅 1 列字形可被角/线替换）
  // 幂等：目标字形与 ch 相同且样式全字段一致（fg/bg/bold/italic/underline/strike）
  if (targetCh === ch && styleEqual(s.style, style)) return;
  // 按 code point 边界拆段：head + 单字形替换 + tail（段无样式时不带 style 键）
  const head = s.text.slice(0, cidx);
  const cpLen = target > 0xffff ? 2 : 1;
  const tail = s.text.slice(cidx + cpLen);
  const newSegs: FrameSegment[] = [];
  if (head !== "")
    newSegs.push(s.style ? { text: head, style: s.style } : { text: head });
  if (style !== undefined && style !== null) newSegs.push({ text: ch, style });
  else newSegs.push({ text: ch });
  if (tail !== "")
    newSegs.push(s.style ? { text: tail, style: s.style } : { text: tail });
  row.segments = [...segs.slice(0, si), ...newSegs, ...segs.slice(si + 1)];
}

/** 样样式全字段相等比较（fg/bg/bold/italic/underline/strike；含 undefined 等价） */
function styleEqual(
  a: FrameStyle | undefined,
  b: FrameStyle | undefined,
): boolean {
  if (a === b) return true;
  const A = a ?? {};
  const B = b ?? {};
  return (
    A.fg === B.fg &&
    A.bg === B.bg &&
    (A.bold ?? false) === (B.bold ?? false) &&
    (A.italic ?? false) === (B.italic ?? false) &&
    (A.underline ?? false) === (B.underline ?? false) &&
    (A.strike ?? false) === (B.strike ?? false)
  );
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

/** 合并一行中相邻同样式段（serializeFrameRow 前统一，消除逐字符分段） */

/** 覆写一行 [c0, c1) 显示列区间（含 c0 不含 c1）：统一替换为 ch。
 * 只重建与区间相交的段；未相交段原样保留（不与其邻段合并）——
 * 保留冻结基线（旧 divFor/segN 独立产出）的段边界。 */
export function coverH(
  rows: FrameRow[],
  rowIndex: number,
  c0: number,
  c1: number,
  ch: string,
  style?: FrameStyle,
): void {
  if (rowIndex < 0 || rowIndex >= rows.length || c1 <= c0) return;
  if (displayWidth(ch) !== 1) return;
  const row = rows[rowIndex]!;
  const segs = row.segments;
  const out: FrameSegment[] = [];
  let w = 0;
  for (const s of segs) {
    const tw = displayWidth(s.text);
    const segStart = w;
    const segEnd = w + tw;
    if (segEnd > c0 && segStart < c1) {
      // 与区间相交：段内逐字形重建（跨界处替换为 ch；区间内相邻同 style 合并）
      let segW = segStart;
      const touched: { ch: string; style?: FrameStyle }[] = [];
      for (const segCh of s.text) {
        const cw = displayWidth(segCh);
        const segCol = segW;
        segW += cw;
        if (segCol >= c0 && segCol < c1 && cw === 1) {
          touched.push({ ch, style });
        } else {
          touched.push({ ch: segCh, style: s.style });
        }
      }
      let cur: { text: string; style?: FrameStyle } | null = null;
      for (const tch of touched) {
        if (
          cur &&
          cur.style?.fg === tch.style?.fg &&
          cur.style?.bg === tch.style?.bg
        ) {
          cur.text += tch.ch;
        } else {
          if (cur) out.push(cur);
          cur = { text: tch.ch, style: tch.style };
        }
      }
      if (cur) out.push(cur);
    } else {
      // 未相交段：原样保留（独立段，不并入相邻）
      out.push({ ...s });
    }
    w = segEnd;
  }
  row.segments = out;
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
      // 顶边 = 标题栏下划线行（rect.top）：角字亮、body 灰（基线 ─ 灰保留，
      // 对齐现状下划线行仅角亮——body 不覆写）
      cover(rows, top, left, "┌", style);
      cover(rows, top, dCol, "┐", style);
      // 左缘 + D 列竖线（对话区行）
      for (let r = top + 1; r < bottom; r++) {
        cover(rows, r, left, "│", style);
        cover(rows, r, dCol, "│", style);
      }
      // 底边 = 活动区分隔行：正文 ─ 亮后两端 ┘（coverH 先 body、cover 后角，
      // 保留 body 与角字独立段，对齐旧 divFor/sepSegments 分段）
      coverH(rows, bottom, left + 1, dCol, "─", style);
      cover(rows, bottom, left, "┘", style);
      cover(rows, bottom, dCol, "┘", style);
      break;
    }
    case "activity": {
      // 顶边 = 活动区分隔行：正文 ─ 亮后左下 ┌、D 列 ┐
      coverH(rows, top, left + 1, dCol, "─", style);
      cover(rows, top, left, "┌", style);
      cover(rows, top, dCol, "┐", style);
      // 左缘 + D 列竖线（活动区行）
      for (let r = top + 1; r < bottom; r++) {
        cover(rows, r, left, "│", style);
        cover(rows, r, dCol, "│", style);
      }
      // 底边 = 状态区上方分隔行：正文 ─ 亮后左下 └、D 列 ┴（左列段）
      coverH(rows, bottom, left + 1, dCol, "─", style);
      cover(rows, bottom, left, "└", style);
      cover(rows, bottom, dCol, "┴", style);
      break;
    }
    case "status": {
      // 顶边 = 状态列顶行（rc0）：正文 ─ 亮后 D 列 ┌、右缘 ┐
      coverH(rows, top, dCol + 1, right, "─", style);
      cover(rows, top, dCol, "┌", style);
      cover(rows, top, right, "┐", style);
      // D 列竖线（历史/活动区右缘=状态列左缘，status 焦点全列亮；下划线行
      // diaStart-1 保持灰 ┤——标题栏顶边归属 history，不归 status）
      for (let r = top + 1; r <= bottom; r++) {
        if (ctx.titleUnderlineRow !== undefined && r === ctx.titleUnderlineRow)
          continue;
        if (ctx.activitySepRow !== undefined && r === ctx.activitySepRow)
          cover(rows, r, dCol, "┤", style);
        else cover(rows, r, dCol, "│", style);
      }
      // 右缘竖线（状态区行）
      for (let r = top + 1; r <= bottom; r++) cover(rows, r, right, "│", style);
      // 底边 = 状态区上方分隔行：正文 ─ 亮后 D 列 ┴、右缘 ┘（右列段）
      coverH(rows, bottom, dCol + 1, right, "─", style);
      cover(rows, bottom, dCol, "┴", style);
      cover(rows, bottom, right, "┘", style);
      break;
    }
  }
}
