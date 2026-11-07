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
import { displayWidth } from "../markdown.ts";
import { segmentsToChars, wrapStyledChars } from "../wrap-core.ts";
import type { WrapSpec } from "../wrap-core.ts";

export interface WrapOptions {
  /** 首行前缀占列（叶内第 0 行可用宽 = width - prefixW） */
  prefixW: number;
  /** 悬挂缩进列数（除第 0 行外可用宽 = width - hanging） */
  hanging: number;
  /** 平衡折行：行数不变、收窄列宽（仅无 `\n` 时生效；缺省 false） */
  balance?: boolean;
  /** 叶子折行属性（缺省取核内缺省 char + 0 + tail） */
  wrap?: WrapSpec;
}

/**
 * 唯一折行入口：StyledText → 行段数组，length 即渲染高度。
 * 宽度口径见文件头；折行本体在 `layout/wrap-core.ts`，本文件只做几何展开
 * （前缀 / 悬挂 / 平衡宽的入参换算）。
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
  //   普通折行：首行 = width - prefixW，续行 = width。
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
  return wrapStyledChars({
    chars: segmentsToChars(segs),
    limit: (globalRow) =>
      globalRow === 0 ? firstW : Math.max(1, restW - hanging),
    ...(opts.wrap === undefined ? {} : { spec: opts.wrap }),
  });
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
    if (s.strike === true) style.strike = true;
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
 * 平衡折行宽度：复刻 fill.ts 的 balancedWidth —— 总宽 L、最大列宽 Cmax → 行数
 * R = countAt(Cmax)，再取 C = ceil(L / R) 为实际列宽（行数不变、收窄列宽）；
 * 宽字符按整格取整可能多出一行，故 countAt(C) > R 时右移少量列直到行数回到 R。
 * 计数走折行核（不 recalc prefixW，避免互相递归）。
 */
function balancedWrapWidth(
  segs: FrameSegment[],
  maxWidth: number,
  hanging: number,
): number {
  const chars = segmentsToChars(segs);
  const countAt = (w: number): number =>
    wrapStyledChars({
      chars,
      limit: (row) => (row === 0 ? w : w - hanging),
    }).length;
  const rows = countAt(maxWidth);
  if (rows <= 1) return maxWidth;
  const total = segs.reduce((sum, s) => sum + displayWidth(s.text), 0);
  let width = Math.max(1, Math.ceil(total / rows));
  while (width < maxWidth && countAt(width) > rows) width += 1;
  return width;
}
