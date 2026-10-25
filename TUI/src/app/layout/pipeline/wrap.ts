// TUI/src/app/layout/pipeline/wrap.ts — §5/§6 共用的唯一折行入口 wrapLeaf
//
// §0 总原则 2 的落点（T14）：全仓文本叶逐字符折行只此一处（代码行折叠
// wrapCodeLine / expandCodeTabs 除外），measure 的行数 = wrapLeaf 结果长度。
//
// 折行口径对齐旧 fill 的 splitAndWrapSegments + wrapFrameSegments（逐字符计宽，
// 同 markdown.ts 的 wrapFrameSegments）：
//   - 叶内第 0 行可用宽 = width - prefixW；其余行（第 0 物理行的续行 + 后续
//     物理行的所有行）可用宽 = width - hanging（后续物理行基宽已含 hanging 减法）；
//   - 先按 \n 切物理行：空物理行保留为空行（产出一行空段）；空输入同样一行空段；
//   - 超宽单字符（单字符宽 > 可用宽）强制放下不丢字符；
//   - 相邻同样式段文本合并（同 wrapFrameSegments 尾部合并逻辑）。
//
// balance（并入旧 fill.balancedWidth）：行数不变、收窄列宽让各行尽量等宽，仅无
// `\n` 时生效；以 maxW = width - prefixW 为上限求平衡宽 w，再按 w 折行（叶内第 0
// 行用 w、后续用 w - hanging）。平衡宽计数复用本文件的内部折行核（同一口径，
// 不经 wrapLeaf 再算 prefixW，避免两套逻辑与递归死循环）。
//
// 缓存暂不做（阶段 0 无真实调用点）：待 measure/flatten 落地后再按真实调用面补
// cache.ts 的 memo/sizedKey（键需含 文本 + 宽 + prefixW + hanging + balance，
// StyledText 需稳定序列化），届时与既有 markdown.ts / fill.ts 的缓存风格保持一致。

import type { FrameSegment, FrameStyle } from "../../../renderer/screen.ts";
import type { StyledText } from "./ir.ts";
import { charWidth, displayWidth } from "../markdown.ts";

export interface WrapOptions {
  /** 首行前缀占列（叶内第 0 行可用宽 = width - prefixW） */
  prefixW: number;
  /** 悬挂缩进列数（除第 0 行外可用宽 = width - hanging） */
  hanging: number;
  /** 平衡折行：行数不变、收窄列宽（仅无 `\n` 时生效；缺省 false） */
  balance?: boolean;
}

/**
 * 唯一折行入口：StyledText → 行段数组，length 即渲染高度。
 * 宽度口径见文件头；返回行未于本文件内做前缀 / 悬挂空格补入（那是 flatten 的事）。
 */
export function wrapLeaf(
  text: StyledText,
  width: number,
  opts: WrapOptions,
): FrameSegment[][] {
  const segs = styledToSegments(text);
  const hanging = opts.hanging ?? 0;
  const prefixW = opts.prefixW ?? 0;
  const hasNewline = segs.some((s) => s.text.includes("\n"));
  // 首行 / 续行的「基准宽」分档：
  //   平衡折行：均按平衡宽 w（首行 = w，续行 = w - hanging）；
  //   普通折行：首行 = width - prefixW，续行 = width - hanging。
  let firstW: number;
  let restW: number;
  if (opts.balance === true && !hasNewline) {
    const maxW = Math.max(1, width - prefixW);
    const balanced = balancedWrapWidth(segs, maxW, hanging);
    firstW = balanced;
    restW = balanced;
  } else {
    firstW = width - prefixW;
    restW = width;
  }
  // 先按 \n 切物理行，再逐行折行；行号（叶内全局）决定首行 / 续行可用宽
  const physical = splitPhysical(segs);
  const out: FrameSegment[][] = [];
  for (const line of physical) {
    if (line.length === 0) {
      out.push([]); // 空物理行保留为空行（产出一行空段）
      continue;
    }
    const limit = (globalRow: number): number =>
      globalRow === 0 ? firstW : Math.max(1, restW - hanging);
    out.push(...wrapSegmentsAt(line, out.length, limit));
  }
  return out;
}

/** StyledStr → FrameSegment 样式映射：color → fg；bold → bold；italic → italic；
 *  code → bg = "code"（主题语义色）；link → fg = "blue" + underline。无样式字段时
 *  不写 style 字段（形状与旧无样式段一致）。 */
export function styledToSegments(text: StyledText): FrameSegment[] {
  return text.map((s) => {
    const style: FrameStyle = {};
    if (s.color !== undefined) style.fg = s.color;
    if (s.bold === true) style.bold = true;
    if (s.italic === true) style.italic = true;
    if (s.code === true) style.bg = "code";
    if (s.link !== undefined) {
      style.fg = "blue";
      style.underline = true;
    }
    return Object.keys(style).length > 0
      ? { text: s.text, style }
      : { text: s.text };
  });
}

/**
 * 内部折行核（单物理行逐字符折行）：limit(globalRow) 给出该行（叶内全局行号）的
 * 可用宽，供 wrapLeaf 与 balance 计数共用——同一折行口径，避免两套逻辑漂移。
 * 空输入产出 `[[]]`（一行空段）；超宽单字符（当前行空时）强制放下不丢字符；
 * 换行后合并相邻同样式段。 */
function wrapSegmentsAt(
  segs: FrameSegment[],
  rowOffset: number,
  limit: (globalRow: number) => number,
): FrameSegment[][] {
  if (segs.length === 0) return [[]];
  const rows: FrameSegment[][] = [];
  let cur: FrameSegment[] = [];
  let curW = 0;
  for (const seg of segs) {
    const style = seg.style;
    for (const ch of seg.text) {
      const w = charWidth(ch);
      const limitW = Math.max(1, limit(rowOffset + rows.length));
      // curW > 0：当前行已有内容且放不下才换行 → 超宽单字符强制放下
      if (curW > 0 && curW + w > limitW) {
        rows.push(cur);
        cur = [];
        curW = 0;
      }
      cur.push({ text: ch, style });
      curW += w;
    }
  }
  rows.push(cur);
  return rows.map(mergeAdjacent);
}

/**
 * 平衡折行宽度：复刻 fill.ts 的 balancedWidth —— 总宽 L、最大列宽 Cmax → 行数
 * R = countAt(Cmax)，再取 C = ceil(L / R) 为实际列宽（行数不变、收窄列宽）；
 * 宽字符按整格取整可能多出一行，故 countAt(C) > R 时右移少量列直到行数回到 R。
 * 计数走 wrapSegmentsAt（不 recalc prefixW，避免互相递归）。
 */
function balancedWrapWidth(
  segs: FrameSegment[],
  maxWidth: number,
  hanging: number,
): number {
  const countAt = (w: number): number =>
    wrapSegmentsAt(segs, 0, (globalRow) => (globalRow === 0 ? w : w - hanging))
      .length;
  const rows = countAt(maxWidth);
  if (rows <= 1) return maxWidth;
  const total = segs.reduce((sum, s) => sum + displayWidth(s.text), 0);
  let width = Math.max(1, Math.ceil(total / rows));
  while (width < maxWidth && countAt(width) > rows) width += 1;
  return width;
}

/** 段序列按 \n 切成一串物理行段（样式段跨 `\n` 拆分；空行保留为段空行） */
function splitPhysical(segs: FrameSegment[]): FrameSegment[][] {
  const lines: FrameSegment[][] = [[]];
  for (const s of segs) {
    const parts = s.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      const part = parts[i]!;
      if (part !== "")
        lines[lines.length - 1]!.push({ text: part, style: s.style });
    }
  }
  return lines;
}

/** 相邻同样式段文本合并（同 markdown.ts wrapFrameSegments 尾部合并逻辑） */
function mergeAdjacent(line: FrameSegment[]): FrameSegment[] {
  const merged: FrameSegment[] = [];
  for (const s of line) {
    const lastSeg = merged[merged.length - 1];
    if (lastSeg && sameStyle(lastSeg.style, s.style)) lastSeg.text += s.text;
    else merged.push({ text: s.text, style: s.style });
  }
  return merged;
}

/** 两段样式是否全字段相等（相邻合并判定） */
function sameStyle(
  a: FrameStyle | undefined,
  b: FrameStyle | undefined,
): boolean {
  return (
    a?.bold === b?.bold &&
    a?.italic === b?.italic &&
    a?.underline === b?.underline &&
    a?.strike === b?.strike &&
    a?.fg === b?.fg &&
    a?.bg === b?.bg
  );
}
