// TUI/src/app/layout/focus-frame.ts — 焦点框线全局覆写（规范见 SPEC.md §8 / TUI/docs/DESIGN.md §8）
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
  /** 标题栏下划线行（=diaStart-1；无下划线时 0/-1）——该行 D 列归属 history 顶边，
   *  status 焦点时不强调（保持灰） */
  titleUnderlineRow?: number;
  /** 横向排列（历史区在左、活动区在右）时的内部分隔竖线列：
   *  history 右缘 / activity 左缘改为此列，底边不再有纵向分隔行（缺省 = 纵向排列） */
  innerDividerCol?: number;
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

/** 框线字形集合（只对这些字形改色；正文/空白一律不碰） */
const FRAME_GLYPHS = new Set([
  "─",
  "│",
  "┌",
  "┐",
  "└",
  "┘",
  "├",
  "┤",
  "┬",
  "┴",
  "┼",
  "╌",
  "═",
  "╪",
]);

/** #4：焦点强调——只把**既有**框线字形的颜色改为焦点色（主题 `semantics.focus`）。
 *  目标位置不是框线字形（正文 / 空白 / 内容列）时 no-op：这是"焦点只改颜色、
 *  不新增边框、不覆写内容列"的保证——隐藏状态列时左缘退化到内容列也不会被覆盖。 */
function emphasize(
  rows: FrameRow[],
  rowIndex: number,
  col: number,
  style: FrameStyle,
): void {
  if (rowIndex < 0 || rowIndex >= rows.length) return;
  const ch = cellAt(rows, rowIndex, col);
  if (!FRAME_GLYPHS.has(ch)) return;
  setCell(rows[rowIndex]!, col, ch, style);
}

/** 区间版强调（[c0, c1) 逐列；同样只命中既有框线字形） */
function emphasizeH(
  rows: FrameRow[],
  rowIndex: number,
  c0: number,
  c1: number,
  style: FrameStyle,
): void {
  for (let c = c0; c < c1; c++) emphasize(rows, rowIndex, c, style);
}

/**
 * 焦点框入口：整帧一次扫描，把焦点 pane 的**既有**框线（边框 + 分隔线）改为焦点色；
 * **不落新字形、不覆写内容列**（#4）。
 * rects 由布局层构造（帧坐标，right=x+w-1、bottom=y+h-1）：
 *   status 矩形 = 状态列（x=0, w=statusColWidth，右缘即分隔竖线 D 列）
 *   history/activity 矩形 = 区域（x=区域正文起始列，w=historyWidth，横向两 pane 以
 *   内部分隔列切开）
 * focusedPanel=null 时不强调。
 */
/** 读 (row, col) 处字形（按显示列定位；越界/无字返回空格） */
function cellAt(rows: FrameRow[], row: number, col: number): string {
  const r = rows[row];
  if (!r || col < 0) return " ";
  let w = 0;
  for (const segment of r.segments) {
    for (const ch of segment.text) {
      const cw = displayWidth(ch);
      if (cw <= 0) continue;
      if (col < w + cw) return ch;
      w += cw;
    }
  }
  return " ";
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
      // 顶边（标题栏下划线行）：左缘 D 列 + 右缘（横向 = 内部分隔列、纵向 = 外框列）
      const rEdge = horizontal ? divCol : right;
      // 顶边框**整行**染色（含标题文字两侧的边框线；只染既有框线字形）
      emphasizeH(rows, top, dCol, rEdge + 1, style);
      // 左右缘竖线（历史区行）
      for (let r = top + 1; r < bottom; r++) {
        emphasize(rows, r, dCol, style);
        emphasize(rows, r, rEdge, style);
      }
      // 底边 = 活动区分隔行（纵向）/ 状态区分隔行（横向）：只强调既有横线
      emphasizeH(rows, bottom, dCol, rEdge + 1, style);
      break;
    }
    case "activity": {
      // 左缘（纵向 = D 列、横向 = 内部分隔列）；顶/底既有横线一并强调（本 pane 无右边框）
      const lEdge = horizontal ? divCol : dCol;
      emphasizeH(rows, top, lEdge, right + 1, style);
      for (let r = top + 1; r < bottom; r++) emphasize(rows, r, lEdge, style);
      emphasizeH(rows, bottom, lEdge, right + 1, style);
      break;
    }
    case "status": {
      // 右缘 D 列（下划线行归属 history 顶边 → 跳过）+ 顶/底既有横线；
      // 左缘（屏幕首列）无既有框线 → 不强调（不新增边框），也不覆写内容列
      for (let r = top; r <= bottom; r++) {
        if (ctx.titleUnderlineRow !== undefined && r === ctx.titleUnderlineRow)
          continue;
        emphasize(rows, r, right, style);
      }
      emphasizeH(rows, top, left, right + 1, style);
      emphasizeH(rows, bottom, left, right + 1, style);
      break;
    }
  }
}
