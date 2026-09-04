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
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
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
      // 图片占位：终端不显示图片，显示 [alt] 与 URL（灰斜体）
      const url = /\(([^)]*)\)/.exec(fullText)?.[1] ?? "";
      segs.push({
        text: `[${bracketText(fullText)}] ${url}`,
        style: { fg: "gray", italic: true },
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
      [{ text: "-".repeat(Math.max(0, width)), style: { fg: "gray" } }],
      width,
      themeId,
    );
  }
  // 2. 任务列表：ASCII [x]/[ ]，已完成绿色加粗、未完成灰色
  const task = TASK_RE.exec(text);
  if (task) {
    const checked = task[1]!.toLowerCase() === "x";
    const body = parseInlineMarkdown(task[2]!, themeId);
    const segs: InlineSegment[] = checked
      ? [
          // 已完成：勾选前缀灰色可辨识，正文灰色删除线
          { text: "[x] ", style: { fg: "gray" } },
          ...body.map((s) => ({
            text: s.text,
            style: mergeStyle({ fg: "gray", strike: true }, s.style ?? {}),
          })),
        ]
      : [{ text: "[ ] ", style: { fg: "gray" } }, ...body];
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
  // 4. 引用：竖线前缀 + 整体灰斜体
  const quote = QUOTE_RE.exec(text);
  if (quote) {
    // 单层引用：隐藏正文开头残留的 >（本次不做嵌套格式）
    const body = quote[1]!.replace(/^[>\s]+/, "").trim();
    if (body === "") return [""];
    const segs: InlineSegment[] = [
      { text: "> ", style: { fg: "gray" } },
      ...parseInlineMarkdown(body, themeId).map((s) => ({
        text: s.text,
        style: mergeStyle({ fg: "gray" }, s.style ?? {}),
      })),
    ];
    return wrapSegments(segs, width, themeId);
  }
  // 5. 普通列表项：前缀灰色，内容走行内解析
  const list = LIST_RE.exec(text);
  if (list) {
    // 无序列表 (-/*/+) 统一显示为明显的 •；有序列表保留数字前缀
    const bullet = /^[ \t]*[-*+][ \t]+/.test(text);
    const prefix = bullet ? "• " : text.slice(0, text.length - list[1]!.length);
    const segs: InlineSegment[] = [
      { text: prefix, style: { fg: "gray" } },
      ...parseInlineMarkdown(list[1]!, themeId),
    ];
    return wrapSegments(segs, width, themeId);
  }
  // 6. 普通行内 markdown
  return wrapSegments(parseInlineMarkdown(text, themeId), width, themeId);
}
