// TUI/src/app/layout/wrap-core.ts — 全仓唯一折行核
//
// 规范见 TUI/docs/SPEC.md §3（折行）与 docs/archived/2026-11-06-wrap-strategy.md。
// 折行能力 = 本文件的纯函数核 + 叶子属性 `wrap?: WrapSpec`：
//   - `mode`    断点口径：char（逐字符，缺省，与既有行为一致）/ word（按词）/ none（单行）
//   - `maxRows` 行数预算：0 = 不生效（缺省）；N > 0 = 只显示 N 行
//   - `hint`    隐藏提示：none / head / middle / tail（缺省 tail），提示符统一 `…`，
//               只占列、不额外占行
// 三个子字段都可缺省；缺省值写死在本文件，调用点不得自行兜底一套。

import type { FrameSegment, FrameStyle } from "../../renderer/screen.ts";
import { createTextCache, memo } from "./cache.ts";
import { charWidth } from "./markdown.ts";

/** 断点口径：逐字符 / 按词 / 不折行（单行截断） */
export type WrapStyle = "char" | "word" | "none";

/** 隐藏提示风格：无提示 / 保留末尾贴首行 / 保留两端贴中段 / 保留开头贴末行 */
export type WrapHint = "none" | "head" | "middle" | "tail";

/** 叶子折行属性（一个东西的一组开关，三个子字段都可缺省） */
export interface WrapSpec {
  /** 断点口径（缺省 char） */
  mode?: WrapStyle;
  /** 行数预算，0 = 不生效（缺省） */
  maxRows?: number;
  /** 隐藏提示风格（缺省 tail） */
  hint?: WrapHint;
}

/** 核内缺省断点口径（与历史逐字符折行一致） */
export const DEFAULT_WRAP_MODE: WrapStyle = "char";
/** 核内缺省行数预算：0 = 不生效 */
export const DEFAULT_WRAP_MAX_ROWS = 0;
/** 核内缺省隐藏提示 */
export const DEFAULT_WRAP_HINT: WrapHint = "tail";
/** 隐藏提示符（统一一个字符，只占列不占行） */
export const WRAP_ELLIPSIS = "…";

/** 折行属性的归一形态（子字段全部落到缺省值后的只读形状） */
export interface ResolvedWrapSpec {
  mode: WrapStyle;
  maxRows: number;
  hint: WrapHint;
}

/** 归一折行属性：缺省 / 非法值一律回落到核内缺省 */
export function resolveWrapSpec(spec?: WrapSpec): ResolvedWrapSpec {
  const mode =
    spec?.mode === "word" || spec?.mode === "none" || spec?.mode === "char"
      ? spec.mode
      : DEFAULT_WRAP_MODE;
  const rawMax = spec?.maxRows;
  const maxRows =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
      ? Math.floor(rawMax)
      : DEFAULT_WRAP_MAX_ROWS;
  const hint =
    spec?.hint === "none" ||
    spec?.hint === "head" ||
    spec?.hint === "middle" ||
    spec?.hint === "tail"
      ? spec.hint
      : DEFAULT_WRAP_HINT;
  return { mode, maxRows, hint };
}

/** 归一形态的短键（供各层缓存键拼装，避免同一文本切两档串味） */
export function wrapSpecKey(spec?: WrapSpec): string {
  const r = resolveWrapSpec(spec);
  return `${r.mode}:${r.maxRows}:${r.hint}`;
}

/**
 * 消费点判定：是否「不软折行」（单行）。
 * `{ mode: "none" }` 表达不折行，measure / fill 用它选单行分支。
 */
export function wrapIsNone(wrap?: WrapSpec): boolean {
  return wrap?.mode === "none";
}

// ---------------- 输入形态：带样式的字符流 ----------------

/**
 * 带样式的单个字符。断点单元必须跨样式段（`foo**bar**baz` 在 markdown 解析后
 * 是 3 段，但按词折行时它是一个词），故核的输入是字符流而不是段数组。
 */
export interface StyledChar {
  ch: string;
  style?: FrameStyle | undefined;
}

/** 样式段数组 → 带样式字符流（`\n` 也是字符，由核负责切成物理行） */
export function segmentsToChars(segs: readonly FrameSegment[]): StyledChar[] {
  const out: StyledChar[] = [];
  for (const s of segs) {
    for (const ch of s.text) out.push({ ch, style: s.style });
  }
  return out;
}

/** 字符流 → 行段数组（相邻同样式字符合并；空行保留为空段行） */
export function charsToSegments(chars: readonly StyledChar[]): FrameSegment[] {
  const out: FrameSegment[] = [];
  for (const c of chars) {
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, c.style)) last.text += c.ch;
    else out.push({ text: c.ch, style: c.style });
  }
  return out;
}

/** 两段样式是否全字段相等（相邻合并判定） */
function sameStyle(a?: FrameStyle, b?: FrameStyle): boolean {
  return (
    a?.bold === b?.bold &&
    a?.italic === b?.italic &&
    a?.underline === b?.underline &&
    a?.strike === b?.strike &&
    a?.fg === b?.fg &&
    a?.bg === b?.bg
  );
}

// ---------------- 折行入口 ----------------

/** 折行请求：字符流 + 逐行可用宽 + 折行属性 */
export interface WrapRequest {
  /** 带样式字符流（`\n` 表示显式换行） */
  chars: readonly StyledChar[];
  /**
   * 第 rowIndex 行（折行结果里的行号，跨物理行连续计数）的可用列宽。
   * 首行 / 续行差异（prefixW / hanging）由调用方在这个回调里表达。
   */
  limit: (rowIndex: number) => number;
  /** 折行属性（缺省 char + 0 + tail） */
  spec?: WrapSpec;
  /**
   * 调用方的几何键（宽 / 悬挂 / 前缀列等，由调用方拼好）：核的缓存键 =
   * 折行属性 + 本键 + 文本。不传则不走缓存（不同宽度不能用同一份结果）。
   */
  cacheKey?: string;
  /**
   * 是否把 `\n` 当显式换行切开（缺省 true）。
   * legacy 的行内折行（markdown 段集）历来把 `\n` 当零宽普通字符，故传 false。
   */
  splitLines?: boolean;
}

/**
 * 折行主入口：字符流 → 行段数组，length 即渲染高度。
 *
 * 口径（与旧实现逐字一致，由 TUI/tests/wrap-strategy.test.ts 守着）：
 *   - 先按 `\n` 切物理行；空物理行保留为空行，空输入产出一行空段；
 *   - `char`：逐字符贪心，当前行已有内容且放不下才换行（超宽单字符强制放下）；
 *   - 行宽由 `limit(rowIndex)` 给出，最小 1 列。
 */
export function wrapStyledChars(req: WrapRequest): FrameSegment[][] {
  const compute = (): FrameSegment[][] => {
    const spec = resolveWrapSpec(req.spec);
    const rows: FrameSegment[][] = [];
    const physical =
      req.splitLines === false ? [req.chars] : splitPhysicalChars(req.chars);
    for (const line of physical) {
      rows.push(...wrapPhysical(line, rows.length, req.limit, spec.mode));
    }
    return truncateRows(rows, req.spec);
  };
  if (req.cacheKey === undefined) return compute();
  const key = `${req.cacheKey}\u0000${wrapSpecKey(req.spec)}\u0000${charsKey(req.chars)}`;
  return memo(coreCache, key, compute);
}

/** 核结果缓存：键含折行属性 + 调用方几何键 + 文本（含逐段样式） */
const coreCache = createTextCache<FrameSegment[][]>();

/** 字符流的缓存键（样式按连续同样式段折叠，避免逐字符长键） */
function charsKey(chars: readonly StyledChar[]): string {
  const runs: string[] = [];
  let runStyle: FrameStyle | undefined;
  let runText = "";
  let started = false;
  for (const c of chars) {
    if (!started || !sameStyle(runStyle, c.style)) {
      if (started) runs.push(`${styleKey(runStyle)}:${runText}`);
      runStyle = c.style;
      runText = "";
      started = true;
    }
    runText += c.ch;
  }
  if (started) runs.push(`${styleKey(runStyle)}:${runText}`);
  return runs.join("\u0001");
}

/** 样式签名（缓存键用，只需稳定且区分度足够） */
function styleKey(style?: FrameStyle): string {
  if (style === undefined) return "";
  return [
    style.bold === true ? "b" : "",
    style.italic === true ? "i" : "",
    style.underline === true ? "u" : "",
    style.strike === true ? "s" : "",
    style.fg ?? "",
    style.bg ?? "",
  ].join(",");
}

/**
 * 行数预算 + 隐藏提示：对已摊平的行集按 `maxRows` / `hint` 取窗口并贴 `…`。
 *
 *   - `maxRows: 0`（或行数未超预算）：原样返回；
 *   - `none`：保留前 N 行，不贴符；
 *   - `head`：保留末 N 行，首行行首贴 `…`（显示内容末尾）；
 *   - `tail`：保留前 N 行，末行行尾贴 `…`（显示内容开头）；
 *   - `middle`：前 ceil(N/2) 行 + 后 floor(N/2) 行，前段末行行尾贴 `…`。
 *
 * 提示符只占列、不额外占行：N 行就是实际占用行数。
 */
export function truncateRows(
  rows: readonly FrameSegment[][],
  spec?: WrapSpec,
): FrameSegment[][] {
  const { maxRows, hint } = resolveWrapSpec(spec);
  if (maxRows <= 0 || rows.length <= maxRows) return rows.map((r) => [...r]);
  const n = maxRows;
  if (hint === "none") return rows.slice(0, n).map((r) => [...r]);
  if (hint === "head") {
    const kept = rows.slice(rows.length - n).map((r) => [...r]);
    kept[0] = prependEllipsis(kept[0] ?? []);
    return kept;
  }
  if (hint === "middle") {
    const headCount = Math.ceil(n / 2);
    const tailCount = n - headCount;
    const head = rows.slice(0, headCount).map((r) => [...r]);
    head[headCount - 1] = appendEllipsis(head[headCount - 1] ?? []);
    const tail =
      tailCount > 0
        ? rows.slice(rows.length - tailCount).map((r) => [...r])
        : [];
    return [...head, ...tail];
  }
  const kept = rows.slice(0, n).map((r) => [...r]);
  kept[n - 1] = appendEllipsis(kept[n - 1] ?? []);
  return kept;
}

/** 行尾贴 `…`（复制行内段，避免改写调用方的行集） */
function appendEllipsis(row: FrameSegment[]): FrameSegment[] {
  const out = row.map((s) => ({ ...s }));
  const last = out[out.length - 1];
  if (last !== undefined && last.style === undefined)
    last.text += WRAP_ELLIPSIS;
  else out.push({ text: WRAP_ELLIPSIS });
  return out;
}

/** 行首贴 `…` */
function prependEllipsis(row: FrameSegment[]): FrameSegment[] {
  const out = row.map((s) => ({ ...s }));
  const first = out[0];
  if (first !== undefined && first.style === undefined)
    first.text = WRAP_ELLIPSIS + first.text;
  else out.unshift({ text: WRAP_ELLIPSIS });
  return out;
}

/**
 * 单行宽度贴合：行宽超过 `width` 时按 `hint` 截断并贴 `…`（拼帧层兜底用）。
 *
 * 宽度归调用方（它知道可用列数），本函数只负责「保留哪一端 + 提示符位置」，
 * 与行数预算同一套贴符口径：`tail` 保留开头、`head` 保留末尾、`middle` 保留两端、
 * `none` 纯截断不贴符。
 */
export function fitRowWidth(
  segs: readonly FrameSegment[],
  width: number,
  hint: WrapHint = DEFAULT_WRAP_HINT,
): FrameSegment[] {
  const w = Math.max(0, width);
  const total = rowDisplayWidth(segs);
  if (total <= w) return segs.map((s) => ({ ...s }));
  if (hint === "none") return truncateEnd(segs, w);
  const keep = Math.max(0, w - 1);
  if (hint === "head")
    return [...prependEllipsis([]), ...truncateStart(segs, keep)];
  if (hint === "middle") {
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    return [
      ...appendEllipsis(truncateEnd(segs, head)),
      ...truncateStart(segs, tail),
    ];
  }
  return appendEllipsis(truncateEnd(segs, keep));
}

/** 行显示宽度（与 primitives.rowWidth2 同口径，避免核反向依赖 primitives） */
function rowDisplayWidth(segs: readonly FrameSegment[]): number {
  let w = 0;
  for (const s of segs) for (const ch of s.text) w += charWidth(ch);
  return w;
}

/** 保留开头 `width` 列（不切半个宽字符） */
function truncateEnd(
  segs: readonly FrameSegment[],
  width: number,
): FrameSegment[] {
  if (width <= 0) return [];
  const out: FrameSegment[] = [];
  let used = 0;
  for (const s of segs) {
    for (const ch of s.text) {
      const cw = charWidth(ch);
      if (used + cw > width) return out;
      used += cw;
      const last = out[out.length - 1];
      // 只合并「同一个样式对象」的相邻字符（与旧 truncateSegs 同口径，避免把不同来源
      // 但字段相同的段落并成一段，进而改变 ANSI 分段）
      if (last && last.style === s.style) last.text += ch;
      else out.push({ text: ch, style: s.style });
    }
  }
  return out;
}

/** 保留末尾 `width` 列（不切半个宽字符） */
function truncateStart(
  segs: readonly FrameSegment[],
  width: number,
): FrameSegment[] {
  if (width <= 0) return [];
  const chars: StyledChar[] = [];
  for (const s of segs)
    for (const ch of s.text) chars.push({ ch, style: s.style });
  const out: StyledChar[] = [];
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i]!;
    const cw = charWidth(c.ch);
    if (used + cw > width) break;
    used += cw;
    out.unshift(c);
  }
  return charsToSegments(out);
}

/** 字符流按 `\n` 切成物理行（`\n` 不进入结果；末尾换行产出空行） */
function splitPhysicalChars(chars: readonly StyledChar[]): StyledChar[][] {
  const lines: StyledChar[][] = [[]];
  for (const c of chars) {
    if (c.ch === "\n") {
      lines.push([]);
      continue;
    }
    lines[lines.length - 1]!.push(c);
  }
  return lines;
}

/** 单物理行的折行（`rowOffset` 为该行在叶内的起始行号） */
function wrapPhysical(
  chars: readonly StyledChar[],
  rowOffset: number,
  limit: (rowIndex: number) => number,
  mode: WrapStyle,
): FrameSegment[][] {
  if (chars.length === 0) return [[]];
  // `none`：不软折行，物理行原样成行（宽度截断由行集预算那一步负责）
  if (mode === "none") return [charsToSegments(chars)];
  const units = mode === "word" ? wordUnits(chars) : charUnits(chars);
  const rows: StyledChar[][] = [];
  let cur: StyledChar[] = [];
  let curW = 0;
  const limitAt = (): number => Math.max(1, limit(rowOffset + rows.length));
  const flush = (): void => {
    // 行尾空格只在按词折行时裁掉（断点空格被吃掉）；逐字符折行保留原字符
    rows.push(mode === "word" ? trimTrailingSpace(cur) : cur);
    cur = [];
    curW = 0;
  };
  for (const unit of units) {
    const unitW = widthOf(unit.chars);
    if (unit.space) {
      // 空白：行首丢弃；放不下则作为断点被吃掉（续行不以空格开头）
      if (curW === 0) continue;
      if (curW + unitW > limitAt()) {
        flush();
        continue;
      }
      for (const c of unit.chars) cur.push(c);
      curW += unitW;
      continue;
    }
    if (curW > 0 && curW + unitW > limitAt()) flush();
    if (unitW > limitAt()) {
      // 单元超宽：回落逐字符（不丢字符、不切半个宽字符）
      for (const c of unit.chars) {
        const w = charWidth(c.ch);
        if (curW > 0 && curW + w > limitAt()) flush();
        cur.push(c);
        curW += w;
      }
      continue;
    }
    for (const c of unit.chars) cur.push(c);
    curW += unitW;
  }
  if (cur.length > 0 || rows.length === 0) flush();
  return rows.map(charsToSegments);
}

/** 折行单元：一个字符，或一个「按词」不可再分的词 */
interface WrapUnit {
  chars: StyledChar[];
  /** 空白串（作为断点候选；行首丢弃、行尾裁掉） */
  space: boolean;
}

/** 逐字符单元 */
function charUnits(chars: readonly StyledChar[]): WrapUnit[] {
  return chars.map((c) => ({ chars: [c], space: false }));
}

/**
 * 按词单元：空白是可断点；`-` / `/` 之后可断；CJK 与其它字符之间任意可断。
 * 词可以跨样式段（断点单元是连续非空白字符，不按 markdown token 切）。
 */
function wordUnits(chars: readonly StyledChar[]): WrapUnit[] {
  const units: WrapUnit[] = [];
  let cur: StyledChar[] = [];
  const flush = (): void => {
    if (cur.length > 0) units.push({ chars: cur, space: false });
    cur = [];
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (isWrapSpace(c.ch)) {
      flush();
      units.push({ chars: [c], space: true });
      continue;
    }
    cur.push(c);
    const next = chars[i + 1];
    // `-` / `/` 之后可断；CJK 单字成单元（与任何字符之间都可断）
    if (c.ch === "-" || c.ch === "/" || isCjk(c.ch)) flush();
    else if (next !== undefined && isCjk(next.ch)) flush();
  }
  flush();
  return units;
}

/** 空白判定按字符类（`charWidth` 对 `\t` 返 0，不能按宽度反推） */
function isWrapSpace(ch: string): boolean {
  return /\s/u.test(ch);
}

/** CJK 与全角标点：可任意断行（不做禁则，见追踪文档「明确不做」） */
function isCjk(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

/** 字符流显示宽度 */
function widthOf(chars: readonly StyledChar[]): number {
  let w = 0;
  for (const c of chars) w += charWidth(c.ch);
  return w;
}

/** 行尾空白裁剪（断点空格吃掉） */
function trimTrailingSpace(chars: readonly StyledChar[]): StyledChar[] {
  let end = chars.length;
  while (end > 0 && isWrapSpace(chars[end - 1]!.ch)) end -= 1;
  return chars.slice(0, end);
}
