// src/app/layout/markdown.ts — markdown 子集渲染（行内 + 块级，纯函数，可单测）
//
// 自 layout.ts 拆出：行内 markdown 解析（parseInlineMarkdown）、块级分类渲染
// （wrapAssistantLine/wrapCodeLine）与样式 ANSI 序列化（renderSeg）。宽度原语
// （ANSI_RE/stripAnsi/charWidth/displayWidth）一并迁至此供换行/padding 计算；
// layout.ts 重导 charWidth/displayWidth，公共导出不变，且不引入 layout↔markdown 循环依赖。

import type { ColorName, ColorTheme, ThemeId } from "../../renderer/theme.ts";
import { THEMES, ansiNameToHex, hexSgr } from "../../renderer/theme.ts";

// ---------- 宽度原语（自 layout.ts 迁入；layout.ts 重导 charWidth/displayWidth） ----------

/** ANSI SGR 转义序列：宽度计算与截断需跳过、原样透传 */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** 剥离全部 ANSI SGR 转义（displayWidth 前处理，保证宽字符计算不见转义） */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** 按字符显示宽度计算（CJK/全角 = 2 列，其余 = 1 列） */
/** 零宽字符（不占列宽）：组合附加符/变体选择符/ZWJ 等。
 *  ponytail: 覆盖常见零宽区间；不引 wcwidth 依赖，极端罕见区不处理。 */
function isZeroWidthChar(cp: number): boolean {
  // 组合附加符/变体选择符/ZWJ 等不占列宽（对齐 Markus Kuhn wcwidth 零宽表，紧凑分组）
  const ranges: ReadonlyArray<[number, number]> = [
    [0x0300, 0x036f],
    [0x0483, 0x0489],
    [0x0591, 0x05bd],
    [0x05bf, 0x05bf],
    [0x05c1, 0x05c2],
    [0x05c4, 0x05c5],
    [0x05c7, 0x05c7],
    [0x0610, 0x061a],
    [0x064b, 0x065f],
    [0x0670, 0x0670],
    [0x06d6, 0x06dc],
    [0x06df, 0x06e4],
    [0x06e7, 0x06e8],
    [0x06ea, 0x06ed],
    [0x0711, 0x0711],
    [0x0730, 0x074a],
    [0x07a6, 0x07b0],
    [0x07eb, 0x07f3],
    [0x0816, 0x0819],
    [0x081b, 0x0823],
    [0x0825, 0x0827],
    [0x0829, 0x082d],
    [0x0859, 0x085b],
    [0x08d3, 0x0902],
    [0x093a, 0x093a],
    [0x093c, 0x093c],
    [0x0941, 0x0948],
    [0x094d, 0x094d],
    [0x0951, 0x0957],
    [0x0962, 0x0963],
    [0x0981, 0x0981],
    [0x09bc, 0x09bc],
    [0x09c1, 0x09c4],
    [0x09cd, 0x09cd],
    [0x09e2, 0x09e3],
    [0x0a01, 0x0a02],
    [0x0a3c, 0x0a3c],
    [0x0a41, 0x0a42],
    [0x0a47, 0x0a48],
    [0x0a4b, 0x0a4d],
    [0x0a51, 0x0a51],
    [0x0a70, 0x0a71],
    [0x0a75, 0x0a75],
    [0x0a81, 0x0a82],
    [0x0abc, 0x0abc],
    [0x0ac1, 0x0ac5],
    [0x0ac7, 0x0ac8],
    [0x0acd, 0x0acd],
    [0x0ae2, 0x0ae3],
    [0x0b01, 0x0b01],
    [0x0b3c, 0x0b3c],
    [0x0b3f, 0x0b3f],
    [0x0b41, 0x0b44],
    [0x0b4d, 0x0b4d],
    [0x0b56, 0x0b56],
    [0x0b62, 0x0b63],
    [0x0b82, 0x0b82],
    [0x0bc0, 0x0bc0],
    [0x0bcd, 0x0bcd],
    [0x0c00, 0x0c00],
    [0x0c3e, 0x0c40],
    [0x0c46, 0x0c48],
    [0x0c4a, 0x0c4d],
    [0x0c55, 0x0c56],
    [0x0c62, 0x0c63],
    [0x0c81, 0x0c81],
    [0x0cbc, 0x0cbc],
    [0x0cbf, 0x0cbf],
    [0x0cc6, 0x0cc6],
    [0x0ccc, 0x0ccd],
    [0x0ce2, 0x0ce3],
    [0x0d00, 0x0d01],
    [0x0d3b, 0x0d3c],
    [0x0d41, 0x0d44],
    [0x0d4d, 0x0d4d],
    [0x0d62, 0x0d63],
    [0x0dca, 0x0dca],
    [0x0dd2, 0x0dd4],
    [0x0dd6, 0x0dd6],
    [0x0e31, 0x0e31],
    [0x0e34, 0x0e3a],
    [0x0e47, 0x0e4e],
    [0x0eb1, 0x0eb1],
    [0x0eb4, 0x0eb9],
    [0x0ebb, 0x0ebc],
    [0x0ec8, 0x0ecd],
    [0x0f18, 0x0f19],
    [0x0f35, 0x0f35],
    [0x0f37, 0x0f37],
    [0x0f39, 0x0f39],
    [0x0f71, 0x0f7e],
    [0x0f80, 0x0f84],
    [0x0f86, 0x0f87],
    [0x0f8d, 0x0f97],
    [0x0f99, 0x0fbc],
    [0x0fc6, 0x0fc6],
    [0x102d, 0x1030],
    [0x1032, 0x1037],
    [0x1039, 0x103a],
    [0x103d, 0x103e],
    [0x1058, 0x1059],
    [0x105e, 0x1060],
    [0x1071, 0x1074],
    [0x1082, 0x1082],
    [0x1085, 0x1086],
    [0x108d, 0x108d],
    [0x109d, 0x109d],
    [0x135d, 0x135f],
    [0x1712, 0x1714],
    [0x1732, 0x1734],
    [0x1752, 0x1753],
    [0x1772, 0x1773],
    [0x17b4, 0x17b5],
    [0x17b7, 0x17bd],
    [0x17c6, 0x17c6],
    [0x17c9, 0x17d3],
    [0x17dd, 0x17dd],
    [0x180b, 0x180d],
    [0x1885, 0x1886],
    [0x18a9, 0x18a9],
    [0x1920, 0x1922],
    [0x1927, 0x1928],
    [0x1932, 0x1932],
    [0x1939, 0x193b],
    [0x1a17, 0x1a18],
    [0x1a1b, 0x1a1b],
    [0x1a56, 0x1a56],
    [0x1a58, 0x1a5e],
    [0x1a60, 0x1a60],
    [0x1a62, 0x1a62],
    [0x1a65, 0x1a6c],
    [0x1a73, 0x1a7c],
    [0x1a7f, 0x1a7f],
    [0x1ab0, 0x1ace],
    [0x1b00, 0x1b03],
    [0x1b34, 0x1b34],
    [0x1b36, 0x1b3a],
    [0x1b3c, 0x1b3c],
    [0x1b42, 0x1b42],
    [0x1b6b, 0x1b73],
    [0x1b80, 0x1b81],
    [0x1ba2, 0x1ba5],
    [0x1ba8, 0x1ba9],
    [0x1bab, 0x1bad],
    [0x1be6, 0x1be6],
    [0x1be8, 0x1be9],
    [0x1bed, 0x1bed],
    [0x1bef, 0x1bf1],
    [0x1c2c, 0x1c33],
    [0x1c36, 0x1c37],
    [0x1cd0, 0x1cd2],
    [0x1cd4, 0x1ce0],
    [0x1ce2, 0x1ce8],
    [0x1ced, 0x1ced],
    [0x1cf4, 0x1cf4],
    [0x1cf8, 0x1cf9],
    [0x1dc0, 0x1dff],
    [0x20d0, 0x20f0],
    [0x2cef, 0x2cf1],
    [0x2d7f, 0x2d7f],
    [0x2de0, 0x2dff],
    [0x302a, 0x302d],
    [0x3099, 0x309a],
    [0xa66f, 0xa672],
    [0xa674, 0xa67d],
    [0xa69e, 0xa69f],
    [0xa6f0, 0xa6f1],
    [0xa802, 0xa802],
    [0xa806, 0xa806],
    [0xa80b, 0xa80b],
    [0xa825, 0xa826],
    [0xa82c, 0xa82c],
    [0xa8c4, 0xa8c5],
    [0xa8e0, 0xa8f1],
    [0xa8ff, 0xa8ff],
    [0xa926, 0xa92d],
    [0xa947, 0xa951],
    [0xa980, 0xa982],
    [0xa9b3, 0xa9b3],
    [0xa9b6, 0xa9b9],
    [0xa9bc, 0xa9bd],
    [0xa9e5, 0xa9e5],
    [0xaa29, 0xaa2e],
    [0xaa31, 0xaa32],
    [0xaa35, 0xaa36],
    [0xaa43, 0xaa43],
    [0xaa4c, 0xaa4c],
    [0xaa7c, 0xaa7c],
    [0xaab0, 0xaab0],
    [0xaab2, 0xaab4],
    [0xaab7, 0xaab8],
    [0xaabe, 0xaabf],
    [0xaac1, 0xaac1],
    [0xaaec, 0xaaed],
    [0xaaf6, 0xaaf6],
    [0xabe5, 0xabe5],
    [0xabe8, 0xabe8],
    [0xabed, 0xabed],
    [0xfb1e, 0xfb1e],
    [0xfe00, 0xfe0f],
    [0xfe20, 0xfe2f],
    [0xfeff, 0xfeff],
    [0x101fd, 0x101fd],
    [0x102e0, 0x102e0],
    [0x10376, 0x1037a],
    [0x10a01, 0x10a0f],
    [0x10a38, 0x10a3f],
    [0x10ae5, 0x10ae6],
    [0x10d24, 0x10d27],
    [0x10eab, 0x10eac],
    [0x10f46, 0x10f50],
    [0x11001, 0x11001],
    [0x11038, 0x11046],
    [0x11070, 0x11070],
    [0x11073, 0x11074],
    [0x1107f, 0x11081],
    [0x110b3, 0x110b6],
    [0x110b9, 0x110ba],
    [0x11100, 0x11102],
    [0x11127, 0x1112b],
    [0x1112d, 0x11134],
    [0x11173, 0x11173],
    [0x11180, 0x11181],
    [0x111b6, 0x111be],
    [0x111c9, 0x111cc],
    [0x111cf, 0x111cf],
    [0x1122f, 0x11231],
    [0x11234, 0x11234],
    [0x11236, 0x11237],
    [0x1123e, 0x1123e],
    [0x112df, 0x112df],
    [0x112e3, 0x112ea],
    [0x11300, 0x11301],
    [0x1133b, 0x1133c],
    [0x11340, 0x11340],
    [0x11366, 0x1136c],
    [0x11370, 0x11374],
    [0x11438, 0x1143f],
    [0x11442, 0x11444],
    [0x11446, 0x11446],
    [0x1145e, 0x1145e],
    [0x114b3, 0x114b8],
    [0x114ba, 0x114ba],
    [0x114bf, 0x114c0],
    [0x114c2, 0x114c3],
    [0x115b2, 0x115b5],
    [0x115bc, 0x115bd],
    [0x115bf, 0x115c0],
    [0x115dc, 0x115dd],
    [0x11633, 0x1163a],
    [0x1163d, 0x1163d],
    [0x1163f, 0x11640],
    [0x116ab, 0x116ab],
    [0x116ad, 0x116ad],
    [0x116b0, 0x116b5],
    [0x116b7, 0x116b7],
    [0x1171d, 0x1171f],
    [0x11722, 0x11725],
    [0x11727, 0x1172b],
    [0x1182f, 0x11837],
    [0x11839, 0x1183a],
    [0x1193b, 0x1193c],
    [0x1193e, 0x1193e],
    [0x11943, 0x11943],
    [0x119d4, 0x119d7],
    [0x119da, 0x119db],
    [0x119e0, 0x119e0],
    [0x11a01, 0x11a0a],
    [0x11a33, 0x11a38],
    [0x11a3b, 0x11a3e],
    [0x11a47, 0x11a47],
    [0x11a51, 0x11a56],
    [0x11a59, 0x11a5b],
    [0x11a8a, 0x11a96],
    [0x11a98, 0x11a99],
    [0x11c30, 0x11c36],
    [0x11c38, 0x11c3d],
    [0x11c3f, 0x11c3f],
    [0x11c92, 0x11ca7],
    [0x11caa, 0x11cb0],
    [0x11cb2, 0x11cb3],
    [0x11cb5, 0x11cb6],
    [0x11d31, 0x11d36],
    [0x11d3a, 0x11d3a],
    [0x11d3c, 0x11d3d],
    [0x11d3f, 0x11d45],
    [0x11d47, 0x11d47],
    [0x11d90, 0x11d91],
    [0x11d95, 0x11d95],
    [0x11d97, 0x11d97],
    [0x11ef3, 0x11ef4],
    [0x13430, 0x13438],
    [0x16af0, 0x16af4],
    [0x16b30, 0x16b36],
    [0x16f4f, 0x16f4f],
    [0x16f8f, 0x16f92],
    [0x16fe4, 0x16fe4],
    [0x1bc9d, 0x1bc9e],
    [0x1bca0, 0x1bca3],
    [0x1d165, 0x1d169],
    [0x1d16d, 0x1d182],
    [0x1d185, 0x1d18b],
    [0x1d1aa, 0x1d1ad],
    [0x1d242, 0x1d244],
    [0x1da00, 0x1da36],
    [0x1da3b, 0x1da6c],
    [0x1da75, 0x1da75],
    [0x1da84, 0x1da84],
    [0x1da9b, 0x1da9f],
    [0x1daa1, 0x1daaf],
    [0x1e000, 0x1e006],
    [0x1e008, 0x1e018],
    [0x1e01b, 0x1e021],
    [0x1e023, 0x1e024],
    [0x1e026, 0x1e02a],
    [0x1e130, 0x1e136],
    [0x1e2ae, 0x1e2ae],
    [0x1e2ec, 0x1e2ef],
    [0x1e8d0, 0x1e8d6],
    [0x1e944, 0x1e94a],
    [0xe0100, 0xe01ef],
    [0x200b, 0x200d],
    [0x2060, 0x2060],
    [0xfeff, 0xfeff],
    [0x1f3fb, 0x1f3ff],
    [0xe0020, 0xe007f],
  ];
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** 按字符显示宽度计算（CJK/全角 = 2 列，组合符/零宽 = 0，其余 = 1 列） */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  // 零宽字符：组合附加符/变体选择符/ZWJ 等（占 0 列，避免提前换行与总宽虚高）
  if (isZeroWidthChar(cp)) return 0;
  // CJK 统一表意文字、全角标点、Hangul 音节、假名 等常见宽字符区间
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x2fffd)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of stripAnsi(text)) w += charWidth(ch);
  return w;
}

// ---------- markdown 子集（粗体 / 斜体 / 行内代码 / 链接 / 图片 / 块级） ----------

/** 语义化行内样式：fg/bg 可为主题色名或 "#hex"；渲染时始终恢复主题基底前景/背景（不用 39m/0m） */
interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fg?: ColorName | string;
  bg?: ColorName | string;
}

/** 行内代码/代码块背景：按主题取与基底对比足够的灰（dark 深灰、light 浅灰） */
const CODE_BG: Record<ThemeId, string> = {
  dark: "#434343",
  light: "#E8E8E8",
};

/** 带样式的文本段：先保持纯文本，按显示宽度换行完成后再序列化为 ANSI */
interface InlineSegment {
  text: string;
  style?: InlineStyle;
}

/**
 * 行内 token：`` `code` ``、`**bold**`、`*italic*`、`[文字](url)` 链接、
 * `![alt](url)` 图片占位。内容不含 `*` 防嵌套；未闭合/歧义按普通文本保留。
 * 图片组在链接组之前（`![` 以 `[` 前缀出现），以保证 `![alt](url)` 先命中。
 */
const INLINE_RE =
  /(\\(?:[\\*_~`#+.!\->|()[\]{}]))|(`[^`\n]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(~~[^~\n]+~~)|(__[^_\n]+__)|((?<!\*)\*[^*\s][^*]*\*)|(!\[[^\]\n]*\]\([^)\s]*\))|(\[[^\]\n]+\]\([^)\s]*\))|(<https?:\/\/[^\s<>]+>)/g;

/** 从 `[alt](url)` / `[text](url)` 提取方括号内文本 */
function bracketText(full: string): string {
  const m = /\[([^\]]*)\]/.exec(full);
  return m?.[1] ?? full;
}

/**
 * 解析行内 markdown 为样式段。优先级：转义 → code → ***粗斜*** → 粗体 →
 * ~~删除线~~ → __下划线__ → *斜体* → 图片 → 链接 → <自动链接>。只实现
 * 最外层 token（嵌套除 *** 外/跨行强调/复杂 URL 不支持）；未闭合/歧义按
 * 普通文本原样保留（不误删用户内容）；转义后的标点作为普通文本输出。
 */
export function parseInlineMarkdown(
  text: string,
  themeId: ThemeId = "dark",
): InlineSegment[] {
  const segs: InlineSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index!;
    if (idx > last) segs.push({ text: text.slice(last, idx) });
    const [
      full,
      esc,
      code,
      boldIt,
      bold,
      strike,
      underline,
      _italic,
      img,
      link,
      autolink,
    ] = m;
    const fullText = full!;
    if (esc) {
      // 反斜杠转义：转义后的标点作为普通文本（不再触发样式）
      segs.push({ text: esc.slice(1) });
    } else if (code) {
      // 行内代码：主题专用灰底（dark 深灰 / light 浅灰）+ 基底前景
      segs.push({
        text: fullText.slice(1, -1),
        style: { bg: CODE_BG[themeId] },
      });
    } else if (boldIt) {
      // ***bold+italic***：同一段粗体+斜体
      segs.push({
        text: fullText.slice(3, -3),
        style: { bold: true, italic: true },
      });
    } else if (bold) {
      segs.push({ text: fullText.slice(2, -2), style: { bold: true } });
    } else if (strike) {
      segs.push({ text: fullText.slice(2, -2), style: { strike: true } });
    } else if (underline) {
      segs.push({ text: fullText.slice(2, -2), style: { underline: true } });
    } else if (img) {
      // 图片占位：终端不显示图片，显示 [alt] 与 URL（斜体，正常前景色）
      const url = /\(([^)]*)\)/.exec(fullText)?.[1] ?? "";
      segs.push({
        text: `[${bracketText(fullText)}] ${url}`,
        style: { italic: true },
      });
    } else if (link) {
      // 链接：只显示可见文本，蓝色下划线（无点击交互）
      segs.push({
        text: bracketText(fullText),
        style: { fg: "blue", underline: true },
      });
    } else if (autolink) {
      // 自动链接 <https://…>：蓝色下划线显示 URL
      segs.push({
        text: fullText.slice(1, -1),
        style: { fg: "blue", underline: true },
      });
    } else {
      segs.push({ text: fullText.slice(1, -1), style: { italic: true } });
    }
    last = idx + fullText.length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs;
}

/** 样式叠加（块级前缀样式 + 行内 token 样式），冲突时后者（b）胜 */
function mergeStyle(a: InlineStyle, b: InlineStyle): InlineStyle {
  return { ...a, ...b };
}

/** 相邻段样式是否相同（换行后合并用） */
function sameStyle(a?: InlineStyle, b?: InlineStyle): boolean {
  return (
    a?.bold === b?.bold &&
    a?.italic === b?.italic &&
    a?.underline === b?.underline &&
    a?.strike === b?.strike &&
    a?.fg === b?.fg &&
    a?.bg === b?.bg
  );
}

/** 颜色解析：主题色名，或 "#hex" 直接使用；未知返回 null */
function hexOf(theme: ColorTheme, v?: ColorName | string): string | null {
  if (v === undefined) return null;
  if (v.startsWith("#")) return v;
  return ansiNameToHex(theme, v);
}

/** 单段序列化为 manual ANSI：open + text + close（恢复主题基底前景/背景） */
export function renderSeg(seg: InlineSegment, themeId: ThemeId): string {
  const st = seg.style;
  if (!st) return seg.text;
  const theme = THEMES[themeId];
  const open: string[] = [];
  const close: string[] = [];
  if (st.bold) {
    open.push("\x1b[1m");
    close.push("\x1b[22m");
  }
  if (st.italic) {
    open.push("\x1b[3m");
    close.push("\x1b[23m");
  }
  if (st.underline) {
    open.push("\x1b[4m");
    close.push("\x1b[24m");
  }
  if (st.strike) {
    open.push("\x1b[9m");
    close.push("\x1b[29m");
  }
  if (st.fg) {
    const hex = hexOf(theme, st.fg);
    if (hex) {
      open.push(hexSgr(hex, true));
      close.push(hexSgr(theme.foreground, true));
    }
  }
  if (st.bg) {
    const hex = hexOf(theme, st.bg);
    if (hex) {
      open.push(hexSgr(hex, false));
      close.push(hexSgr(theme.background, false));
    }
  }
  if (open.length === 0) return seg.text;
  return open.join("") + seg.text + close.reverse().join("");
}

/**
 * 行内 markdown 正文按显示宽度软换行：逐字符计宽（CJK 2 列），样式跨行时
 * 每行独立打开/关闭样式，相邻同样式段合并后序列化为 ANSI。空串保持 [""]
 * 语义，行首超宽字符强制放下（与 wrapLine 一致）。
 */
export function wrapInlineMarkdown(
  text: string,
  width: number,
  themeId: ThemeId,
): string[] {
  return wrapSegments(parseInlineMarkdown(text, themeId), width, themeId);
}

/** 段集按显示宽度软换行：样式跨行每行独立开/闭，合并相邻同样式后序列化 */
function wrapSegments(
  segs: InlineSegment[],
  width: number,
  themeId: ThemeId,
): string[] {
  if (width <= 0) return [segs.map((s) => renderSeg(s, themeId)).join("")];
  const rows: InlineSegment[][] = [];
  let cur: InlineSegment[] = [];
  let curW = 0;
  const flush = (): void => {
    if (cur.length > 0) rows.push(cur);
    cur = [];
    curW = 0;
  };
  for (const seg of segs) {
    const style = seg.style;
    for (const ch of seg.text) {
      const w = charWidth(ch);
      if (curW > 0 && curW + w > width) flush();
      cur.push({ text: ch, style });
      curW += w;
    }
  }
  flush();
  if (rows.length === 0) return [""];
  return rows.map((line) => {
    const merged: InlineSegment[] = [];
    for (const s of line) {
      const lastSeg = merged[merged.length - 1];
      if (lastSeg && sameStyle(lastSeg.style, s.style)) lastSeg.text += s.text;
      else merged.push({ text: s.text, style: s.style });
    }
    return merged.map((s) => renderSeg(s, themeId)).join("");
  });
}

// ---------- 块级 markdown（标题 / 引用 / 列表 / 任务列表 / 分隔线 / fenced 代码块） ----------

/** fenced 代码块开/关行：三个以上反引号或波浪号，后可跟语言标签 */
export const FENCE_RE = /^ {0,3}(```+|~~~+)[ \t]*([\w.+-]*)[ \t]*$/;

/** 标题：行首 1-6 个 `#` 后跟空格（`#hashtag` 不算） */
const HEADING_RE = /^[ \t]*(#{1,6})[ \t]+(.+)$/;

/** 引用：行首 `>`（可带一个空格） */
const QUOTE_RE = /^[ \t]*>[ \t]?(.*)$/;

/** 任务列表：`- [ ]` / `- [x]`（`*`/`+` 前缀亦支持） */
const TASK_RE = /^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(.+)$/;

/** 普通列表项：`-`/`*`/`+` 或 `1.` 前缀 */
const LIST_RE = /^[ \t]*(?:[-*+]+|\d+\.)[ \t]+(.+)$/;

/** 分隔线：三个以上 - / * / _ */
const RULE_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;

/** 标题强调色：深色/浅色主题下均醒目的青 */
const HEADING_FG: ColorName = "brightCyan";

/** 代码块行：整行主题灰底并补齐到内容区宽度；fence 内不解析 markdown */
export function wrapCodeLine(
  text: string,
  width: number,
  themeId: ThemeId,
): string[] {
  if (text === "") return [""];
  const bg = CODE_BG[themeId];
  const segs: InlineSegment[] = [{ text, style: { bg } }];
  return wrapSegments(segs, width, themeId).map((row) => {
    const pad = Math.max(0, width - displayWidth(stripAnsi(row)));
    return pad > 0
      ? row + renderSeg({ text: " ".repeat(pad), style: { bg } }, themeId)
      : row;
  });
}

/**
 * 普通 assistant 行（fence 外）按块级元素分类渲染：
 * 分隔线 → 任务列表 → 标题 → 引用 → 普通列表 → 行内 markdown。
 */
export function wrapAssistantLine(
  text: string,
  width: number,
  themeId: ThemeId,
): string[] {
  // 1. 分隔线：灰色横线铺满内容区（与 turn 分隔线视觉区分）
  if (RULE_RE.test(text)) {
    return wrapSegments(
      [{ text: "─".repeat(Math.max(0, width)), style: { fg: "border" } }],
      width,
      themeId,
    );
  }
  // 2. 任务列表：ASCII [x]/[ ]，已完成正文删除线、未完成普通（均正常前景色）
  const task = TASK_RE.exec(text);
  if (task) {
    const checked = task[1]!.toLowerCase() === "x";
    const body = parseInlineMarkdown(task[2]!, themeId);
    const segs: InlineSegment[] = checked
      ? [
          // 已完成：勾选前缀 + 正文删除线（正常前景色）
          { text: "[x] " },
          ...body.map((s) => ({
            text: s.text,
            style: mergeStyle({ strike: true }, s.style ?? {}),
          })),
        ]
      : [{ text: "[ ] " }, ...body];
    return wrapSegments(segs, width, themeId);
  }
  // 3. 标题：去掉 #，整行 bold + 醒目青；行内 token（如 **粗**）叠加保留
  const heading = HEADING_RE.exec(text);
  if (heading) {
    const segs = parseInlineMarkdown(heading[2]!, themeId).map((s) => ({
      text: s.text,
      style: mergeStyle({ bold: true, fg: HEADING_FG }, s.style ?? {}),
    }));
    return wrapSegments(segs, width, themeId);
  }
  // 4. 引用：竖线前缀 + 整体斜体（正常前景色）
  const quote = QUOTE_RE.exec(text);
  if (quote) {
    // 单层引用：隐藏正文开头残留的 >（本次不做嵌套格式）
    const body = quote[1]!.replace(/^[>\s]+/, "").trim();
    if (body === "") return [""];
    const segs: InlineSegment[] = [
      { text: "> " },
      ...parseInlineMarkdown(body, themeId).map((s) => ({
        text: s.text,
        style: s.style ?? {},
      })),
    ];
    return wrapSegments(segs, width, themeId);
  }
  // 5. 普通列表项：前缀正常前景色，内容走行内解析
  const list = LIST_RE.exec(text);
  if (list) {
    // 无序列表 (-/*/+) 统一显示为明显的 •；有序列表保留数字前缀
    const bullet = /^[ \t]*[-*+][ \t]+/.test(text);
    const prefix = bullet ? "• " : text.slice(0, text.length - list[1]!.length);
    const segs: InlineSegment[] = [
      { text: prefix },
      ...parseInlineMarkdown(list[1]!, themeId),
    ];
    return wrapSegments(segs, width, themeId);
  }
  // 6. 普通行内 markdown
  return wrapSegments(parseInlineMarkdown(text, themeId), width, themeId);
}
