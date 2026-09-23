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
  /** 活动区分隔行（=diaEnd；横向排列无此行）——该行 D 列为连接字形 `┤`，status 焦点覆写亮 ┤ */
  activitySepRow?: number;
  /** 横向排列（历史区在左、活动区在右）时的内部分隔竖线列：
   *  history 右缘 / activity 左缘改为此列，底边不再有纵向分隔行（缺省 = 纵向排列） */
  innerDividerCol?: number;
  /** 状态区上方分隔行行号（=contentTopH，buildStatusSeparator 所在行）——
   *  该行被焦点 coverH 覆写为 ─ 时恢复状态栏框线竖线交点（┬），保持相接结构 */
  statusSepRow?: number;
  /** 状态栏框线竖线列（buildStatusSeparator 行的 ┬ 交点列，0 基） */
  statusSeamCols?: number[];
}

/** 焦点框亮色（语义色名 "focus"，取色由渲染层经主题 semantics 解析）；不再按主题 ID 推断（旧 dark=brightWhite / light=black） */
export function focusColor(): ColorName {
  return "focus";
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
 *   status 矩形 = 状态列（x=0, w=statusColWidth，右缘即分隔竖线 D 列）
 *   history/activity 矩形 = 区域（x=区域正文起始列，w=historyWidth，横向两 pane 以
 *   内部分隔列切开）
 * focusedPanel=null 时不覆写。
 */

/** coverH 把状态区上方分隔行整段覆写为 ─ 后，恢复状态栏框线竖线交点（┬），
 *  保持竖线与横线相接的结构（交点随焦点 body 变亮）。仅作用于该行 */
function restoreStatusSeams(
  rows: FrameRow[],
  bottom: number,
  c0: number,
  c1: number,
  style: FrameStyle | undefined,
  ctx: FocusFrameContext,
): void {
  if (ctx.statusSepRow === undefined || bottom !== ctx.statusSepRow) return;
  for (const c of ctx.statusSeamCols ?? []) {
    if (c >= c0 && c < c1) cover(rows, bottom, c, "┬", style);
  }
}
export function focusFrame(
  ctx: FocusFrameContext,
  rects: Map<PaneId, Rect>,
  rows: FrameRow[],
): void {
  const panel = ctx.focusedPanel;
  if (panel === null) return;
  const rect = rects.get(panel);
  if (!rect) return;
  const style = { fg: focusColor() };
  const left = rect.x;
  const right = rect.x + rect.w - 1;
  const top = rect.y;
  const bottom = rect.y + rect.h - 1;
  // 分隔竖线列 D（状态列右缘/区域左缘）：区域两 pane 的左缘与该列重合——该列竖线
  // 上下贯穿（状态列与区域共用），横线出入处用连接字 ├/┴/┬，不用角字
  const statusRect = rects.get("status");
  const dCol = statusRect ? statusRect.x + statusRect.w - 1 : left;
  // 内部分隔列（横向排列：history 右缘 / activity 左缘；缺省 undefined = 纵向）
  const divCol = ctx.innerDividerCol;
  const horizontal = divCol !== undefined;

  switch (panel) {
    case "history": {
      // 顶边 = 标题栏下划线行（rect.top）：连接字/角字亮、body 灰（基线 ─ 灰保留）。
      // 左缘恒为 D 列（`├`：竖线上下贯穿 + 横线右接入）；右缘横向 = 内部分隔列
      // （`┬`）、纵向 = 区域外缘框列（`┐`）。
      const rEdge = horizontal ? divCol : right;
      cover(rows, top, dCol, "├", style);
      cover(rows, top, rEdge, horizontal ? "┬" : "┐", style);
      // 左缘（D 列）+ 右缘竖线（历史区行）
      for (let r = top + 1; r < bottom; r++) {
        cover(rows, r, dCol, "│", style);
        cover(rows, r, rEdge, "│", style);
      }
      // 底边：纵向 = 活动区分隔行（D 列 `├`、右端 `┘`）、横向 = 状态区分隔行
      // （D 列 `┴`、内部列 `┴`）；正文 ─ 亮后两端连接字/角字（coverH 先 body、
      // cover 后角，保留 body 与角字独立段）；分隔行被覆写后恢复状态栏交点（┬）
      coverH(rows, bottom, dCol + 1, rEdge, "─", style);
      restoreStatusSeams(rows, bottom, dCol + 1, rEdge, style, ctx);
      cover(rows, bottom, dCol, horizontal ? "┴" : "├", style);
      cover(rows, bottom, rEdge, horizontal ? "┴" : "┘", style);
      break;
    }
    case "activity": {
      // 顶边 = 纵向：活动区分隔行（左缘 D 列 `├`）；横向：标题栏下划线行
      // （左缘 = 内部分隔列 → `┬`）。右缘恒为区域外缘框列（`┐`）。
      const lEdge = horizontal ? divCol : dCol;
      coverH(rows, top, lEdge + 1, right, "─", style);
      cover(rows, top, lEdge, horizontal ? "┬" : "├", style);
      cover(rows, top, right, "┐", style);
      // 左缘 + 右缘竖线（活动区行）
      for (let r = top + 1; r < bottom; r++) {
        cover(rows, r, lEdge, "│", style);
        cover(rows, r, right, "│", style);
      }
      // 底边 = 状态区上方分隔行：正文 ─ 亮后左缘 ┴（左缘竖线在此收束）、右缘 ┘；
      // 覆写后恢复框线竖线交点（┬）
      coverH(rows, bottom, lEdge + 1, right, "─", style);
      restoreStatusSeams(rows, bottom, lEdge + 1, right, style, ctx);
      cover(rows, bottom, lEdge, "┴", style);
      cover(rows, bottom, right, "┘", style);
      break;
    }
    case "status": {
      // 状态列在最左：左缘 = 屏幕首列（外缘框列）、右缘 = D 列（分隔竖线）
      // 顶边 = 状态列顶行（rc0）：正文 ─ 亮后左缘 ┌、右缘 D 列 ┐
      coverH(rows, top, left + 1, right, "─", style);
      cover(rows, top, left, "┌", style);
      cover(rows, top, right, "┐", style);
      // D 列竖线（状态列右缘=历史/活动区左缘，status 焦点全列亮；下划线行
      // diaStart-1 保持灰 ├——标题栏顶边归属 history，不归 status）
      for (let r = top + 1; r <= bottom; r++) {
        if (ctx.titleUnderlineRow !== undefined && r === ctx.titleUnderlineRow)
          continue;
        if (ctx.activitySepRow !== undefined && r === ctx.activitySepRow)
          cover(rows, r, right, "├", style);
        else cover(rows, r, right, "│", style);
      }
      // 左缘竖线（状态列行）
      for (let r = top + 1; r <= bottom; r++) cover(rows, r, left, "│", style);
      // 底边 = 状态区上方分隔行：正文 ─ 亮后左缘 └、右缘 D 列 ┴；
      // 覆写后恢复框线竖线交点（┬）——状态列位于最左，状态栏框线竖线列在其底边范围内
      coverH(rows, bottom, left + 1, right, "─", style);
      restoreStatusSeams(rows, bottom, left + 1, right, style, ctx);
      cover(rows, bottom, left, "└", style);
      cover(rows, bottom, right, "┴", style);
      break;
    }
  }
}
