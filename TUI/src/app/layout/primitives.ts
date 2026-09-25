// TUI/src/app/layout/primitives.ts — 排版中立基元（宽度/换行/段构造）
//
// 供 layout.ts / measure.ts / fill.ts / build-box.ts 共同依赖，模块间不
// 产生循环依赖。规范见 SPEC.md §6 与 TUI/docs/design/DESIGN.md §6。

import type { FrameSegment, FrameStyle } from "../../renderer/screen.ts";
import { charWidth, displayWidth } from "./markdown.ts";
import { createTextCache, memo, sizedKey } from "./cache.ts";

// ---------------- 段构造 ----------------

/** 构造一个样式段（style 缺失=纯文本） */
export function seg(text: string, style?: FrameStyle): FrameSegment {
  return { text, style };
}

/** 段数组显示宽度（不切半个 CJK；渲染前补齐用） */
export function rowWidth2(segs: readonly FrameSegment[]): number {
  let w = 0;
  for (const s of segs) w += displayWidth(s.text);
  return w;
}

/** 段数组按显示宽度截断（不切半个 CJK；超宽丢弃尾部，返回新段数组） */
export function truncateSegs(
  segs: readonly FrameSegment[],
  width: number,
): FrameSegment[] {
  if (width <= 0) return [];
  const out: FrameSegment[] = [];
  let w = 0;
  outer: for (const s of segs) {
    for (const ch of s.text) {
      const cw = charWidth(ch);
      if (w + cw > width) break outer;
      w += cw;
      const last = out[out.length - 1];
      if (last && last.style === s.style) last.text += ch;
      else out.push({ text: ch, style: s.style });
    }
  }
  return out;
}

// ---------- 换行（wrapping）纯函数 ----------

/**
 * 按显示宽度截断：超出 cols 的尾部丢弃（不切半个 CJK 字符）。
 * ANSI 转义不计宽并原样透传（不切断转义序列，避免破坏着色）。
 */
const truncateCache = createTextCache<string>();

export function truncateToWidth(text: string, cols: number): string {
  return memo(truncateCache, sizedKey(text, cols), () =>
    computeTruncateToWidth(text, cols),
  );
}

/** truncateToWidth 直算路径（无缓存） */
function computeTruncateToWidth(text: string, cols: number): string {
  if (cols <= 0) return "";
  let w = 0;
  let out = "";
  for (const m of text.matchAll(/\x1b\[[0-9;]*m|[\s\S]/gu)) {
    const t = m[0]!;
    if (t.startsWith("\x1b")) {
      out += t;
      continue;
    }
    const cw = charWidth(t);
    if (w + cw > cols) continue; // 丢弃超宽字符，后续转义仍透传(样式不泄漏)
    out += t;
    w += cw;
  }
  return out;
}

/**
 * 按列宽软换行：返回不超过 width 列的各行（width<=0 视为无穷）。
 * 行首字符比宽度还宽时强制放下（不丢字符）；空行不产出多余的空白行。
 */
const wrapLineCache = createTextCache<string[]>();

/** 命中缓存的字符串数组按只读消费（调用方均以展开/拼接使用，不就地改写） */
export function wrapLine(text: string, width: number): string[] {
  return memo(wrapLineCache, sizedKey(text, width), () =>
    computeWrapLine(text, width),
  );
}

/** wrapLine 直算路径（无缓存） */
function computeWrapLine(text: string, width: number): string[] {
  if (width <= 0) return text === "" ? [""] : [text];
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (curW > 0 && curW + w > width) {
      rows.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  rows.push(cur);
  return rows;
}

/** buffer 各原始行 → 全部 wrapped 行（保留空行语义） */
export function wrapLines(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      out.push("");
      continue;
    }
    out.push(...wrapLine(line, width));
  }
  return out;
}
