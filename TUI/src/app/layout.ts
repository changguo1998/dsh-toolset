// src/app/layout.ts — 视口切分 + 帧组装（纯函数，可单测）
//
// 语义（DESIGN scrollback 行为）：
//  - 长行按列宽软换行（wrapping）
//  - 视口 = 换行后行数组上裁剪出的可见窗口
//  - followBottom=true 跟随底部；用户上滚后 followBottom=false，
//    scrollOffset 表示距底部多少行，up/down/PageUp/PageDown 移动它
//  - buffer 超 2000 行裁剪由 state.ts 负责（MAX_BUFFER_LINES）

import type { RenderLine } from "../renderer/index.ts";
import type { Size } from "../renderer/index.ts";
import type { AppState, InputMode, InputStatus } from "./state.ts";

import type { Buffer, BufferKind } from "./state.ts";
import type { ApprovalItem } from "./adapter/dsh.ts";
import { renderTextInput } from "./components/TextInput.ts";
import { renderModelPicker } from "./components/ModelPicker.ts";
import type { ColorName, ColorTheme, ThemeId } from "../renderer/theme.ts";
import { colorFor, THEMES, ansiNameToHex, hexSgr } from "../renderer/theme.ts";
import { renderApprovalPrompt } from "./components/ApprovalPrompt.ts";

// ---------- 换行（wrapping）纯函数 ----------

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

/**
 * 按显示宽度截断：超出 cols 的尾部丢弃（不切半个 CJK 字符）。
 * ANSI 转义不计宽并原样透传（不切断转义序列，避免破坏着色）。
 */
export function truncateToWidth(text: string, cols: number): string {
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
export function wrapLine(text: string, width: number): string[] {
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
function renderSeg(seg: InlineSegment, themeId: ThemeId): string {
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
const FENCE_RE = /^ {0,3}(```+|~~~+)[ \t]*([\w.+-]*)[ \t]*$/;

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
function wrapCodeLine(text: string, width: number, themeId: ThemeId): string[] {
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
function wrapAssistantLine(
  text: string,
  width: number,
  themeId: ThemeId,
): string[] {
  // 1. 分隔线：灰色横线铺满内容区（与 turn 分隔线视觉区分）
  if (RULE_RE.test(text)) {
    return wrapSegments(
      [{ text: "─".repeat(Math.max(0, width)), style: { fg: "gray" } }],
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
      { text: "│ ", style: { fg: "gray" } },
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

// ---------- 视口纯函数 ----------

export interface ViewportInput {
  totalRows: number;
  height: number; // 视口区域行数
  followBottom: boolean;
  scrollOffset: number; // 距底部行数
}

export interface Viewport {
  start: number; // wrapped 行数组内可见起始下标
  end: number; // 结束下标（不含）
  followBottom: boolean;
  scrollOffset: number;
}

/** 由 followBottom + scrollOffset 计算可见窗口；offset 超界自动收敛 */
export function computeViewport(vp: ViewportInput): Viewport {
  if (vp.totalRows <= vp.height) {
    return { start: 0, end: vp.totalRows, followBottom: true, scrollOffset: 0 };
  }
  if (vp.followBottom) {
    return {
      start: vp.totalRows - vp.height,
      end: vp.totalRows,
      followBottom: true,
      scrollOffset: 0,
    };
  }
  const offset = Math.min(vp.scrollOffset, vp.totalRows - vp.height);
  const start = vp.totalRows - vp.height - offset;
  const end = start + vp.height;
  const followBottom = offset <= 0;
  return { start: Math.max(0, start), end, followBottom, scrollOffset: offset };
}

// ---------- 帧组装 ----------

/** 顶部(插件窄条 + 对话历史)固定宽度列数 */
export const PLUGIN_WIDTH = 2;

/** 水平分隔线字符 */
export const SEPARATOR = "─";

/** 上/中/下三区之间的横线分隔行数 */
export const SEPARATOR_ROWS = 2;

export interface FrameMetrics {
  /** 顶部区域行数 = rows - 状态区 - 输入区 - 分隔行（剩余高度全给上方两个） */
  topHeight: number;
  /** 系统状态区行数（可 >1：状态内容溢出到多行时按实际行数） */
  statusHeight: number;
  /** 输入区行数（审批弹窗时更高） */
  footerHeight: number;
  /** 插件窄条固定宽 */
  pluginWidth: number;
  /** 历史区宽 = cols - pluginWidth */
  historyWidth: number;
}

export function metricsFor(
  size: Size,
  hasApprovalPrompt: boolean,
  pickerRows = 0,
  /** 状态区行数（默认 1；可多行溢出时按实际行数压缩顶部区域） */
  statusHeight = 1,
): FrameMetrics {
  // footer 高度：审批弹窗 / 选择面板 / 单行输入框
  let footerHeight = 1;
  if (hasApprovalPrompt) {
    footerHeight = Math.max(4, Math.floor(size.rows * 0.3));
  } else if (pickerRows > 0) {
    footerHeight = Math.min(
      pickerRows,
      Math.max(4, Math.floor(size.rows * 0.4)),
    );
  }
  // 插件窄条：固定宽，但窄终端时让出至少 1 列给历史区
  const pluginWidth = Math.min(PLUGIN_WIDTH, Math.max(1, size.cols - 2));
  const historyWidth = Math.max(1, size.cols - pluginWidth);
  const topHeight = Math.max(
    0,
    size.rows - statusHeight - footerHeight - SEPARATOR_ROWS,
  );
  return {
    topHeight,
    statusHeight,
    footerHeight,
    pluginWidth,
    historyWidth,
  };
}

/**
 * 顶部插件竖线单元格（0 基，rows 行为总高）。
 * 无边框无标题，仅左右分区之间的竖线（占整列 pluginWidth 宽）。
 */
function pluginCell(_row: number, _rows: number, width: number): string {
  // 竖线在最左，其余留白；超宽由调用方 truncate
  return "│" + " ".repeat(Math.max(0, width - 1));
}

/** 顶部区域：每行 = 左侧插件窄条 + 右侧历史行（合并为一个 RenderLine） */
function buildTopRegion(
  state: AppState,
  topHeight: number,
  pluginWidth: number,
  historyWidth: number,
  cols: number,
): RenderLine[] {
  const wrapped = wrapBufferLines(
    state.buffer,
    historyWidth,
    state.thinkingMaxLines,
    state.messageGutter,
    state.themeId,
  );
  const vp = computeViewport({
    totalRows: wrapped.length,
    height: topHeight,
    followBottom: state.followBottom,
    scrollOffset: state.scrollOffset,
  });
  const rows: RenderLine[] = [];
  for (let i = 0; i < topHeight; i++) {
    const left = pluginCell(i, topHeight, pluginWidth);
    const w = wrapped[vp.start + i];
    const content =
      w && vp.start + i < vp.end ? " ".repeat(w.indent) + w.text : "";
    const trim = truncateToWidth(left + content, cols);
    // 极限窄终端若连一个宽字符都容不下，保留该字符而不静默丢失内容。
    const visible =
      content && displayWidth(trim) <= displayWidth(left)
        ? left + content
        : trim;
    const text =
      visible.length >= left.length
        ? colorFor(state.themeId, "gray")(left) + visible.slice(left.length)
        : visible;
    rows.push({ text });
  }
  return rows;
}

export const USER_MIN_LEFT_GUTTER = 4;
export const THINKING_INDENT = 2;
export const THINKING_MORE = "…(更多思考已折叠)";
/** THINKING_MAX 兼容导出（state.DEFAULT_THINKING_MAX_LINES 为权威默认） */
export const THINKING_MAX: number = 4;

/** 用户消息块最大正文宽：块整体靠右，左侧至少保留 gutter(默认 USER_MIN_LEFT_GUTTER) */
export function userMaxBodyWidth(
  width: number,
  gutter: number = USER_MIN_LEFT_GUTTER,
): number {
  return Math.max(1, width - Math.min(gutter, Math.max(0, width - 1)));
}

/** 模型正文块最大宽：右缘与用户块左缘对称留白(gutter)，与用户输入形成左右交错 */
export function assistantMaxBodyWidth(
  width: number,
  gutter: number = USER_MIN_LEFT_GUTTER,
): number {
  return Math.max(1, width - Math.min(gutter, Math.max(0, width - 1)));
}

/** 思考行缩进列数：顶部窄条 "│ " 之外再缩进 THINKING_INDENT（足够窄时收敛到 0） */
function thinkingIndentOf(width: number): number {
  return Math.min(THINKING_INDENT, Math.max(0, width - 2));
}

interface WrappedRow {
  text: string;
  kind: BufferKind;
  indent: number;
}

function wrapBufferLines(
  buffer: Buffer,
  width: number,
  thinkingMaxLines: number,
  gutter: number,
  themeId: ThemeId,
): WrappedRow[] {
  const out: WrappedRow[] = [];
  const thinking: WrappedRow[] = [];
  let inFence = false;
  for (const line of buffer) {
    if (line.kind === "thinking") {
      const indent = thinkingIndentOf(width);
      const rows = wrapLine(line.text, Math.max(1, width - indent));
      for (const text of rows)
        thinking.push({ text, kind: "thinking", indent });
      continue;
    }
    if (line.kind === "user") {
      // 用户消息块：按内容收缩宽度并整体靠右（统一 leftPad），块内保持左对齐
      const maxBody = userMaxBodyWidth(width, gutter);
      const rows = wrapLines(line.text.split("\n"), maxBody);
      const bodyWidth = Math.max(1, ...rows.map((r) => displayWidth(r)));
      const pad = Math.max(0, width - bodyWidth);
      for (const text of rows) out.push({ text, kind: "user", indent: pad });
      continue;
    }
    if (line.kind === "assistant") {
      // 模型正文：右缘保留交错留白；fence 代码块内原样展示（块背景不解析），
      // 块外按块级/行内 markdown 子集渲染（标题/引用/列表/任务/分隔线/粗斜/行内代码/链接/图片）
      const fence = FENCE_RE.exec(line.text);
      if (fence && fence[1]!.length >= 3) {
        if (inFence) {
          inFence = false;
        } else {
          inFence = true;
          const lang = fence[2] ?? "";
          if (lang) {
            // 代码块语言标签行：灰斜体（fence 开关行本身不显示）
            out.push({
              text: renderSeg(
                { text: lang, style: { fg: "gray", italic: true } },
                themeId,
              ),
              kind: line.kind,
              indent: 0,
            });
          }
        }
        continue;
      }
      const bodyWidth = assistantMaxBodyWidth(width, gutter);
      const rows = inFence
        ? wrapCodeLine(line.text, bodyWidth, themeId)
        : wrapAssistantLine(line.text, bodyWidth, themeId);
      for (const text of rows) out.push({ text, kind: line.kind, indent: 0 });
      continue;
    }
    const content =
      line.kind === "separator"
        ? SEPARATOR.repeat(Math.max(1, width))
        : line.text;
    const rows = content === "" ? [""] : wrapLine(content, Math.max(1, width));
    for (const text of rows) out.push({ text, kind: line.kind, indent: 0 });
  }
  if (thinking.length > 0) {
    const cap = Math.max(1, thinkingMaxLines);
    const hasMore = thinking.length > cap;
    const visible = thinking.slice(-(hasMore ? cap - 1 : cap));
    if (hasMore) {
      visible.unshift({
        text: THINKING_MORE,
        kind: "thinking",
        indent: thinkingIndentOf(width),
      });
    }
    for (const row of visible) {
      // 思考行仅保留缩进展示，不加 [思考] 前缀（正文区分靠缩进层级）
      out.push({ text: row.text, kind: "thinking", indent: row.indent });
    }
  }
  // 用户消息块与随后的答案/思考之间空一行（纯布局展示，不写状态）
  const spaced: WrappedRow[] = [];
  for (const row of out) {
    const last = spaced[spaced.length - 1];
    if (
      last &&
      last.kind === "user" &&
      (row.kind === "assistant" || row.kind === "thinking")
    ) {
      spaced.push({ text: "", kind: "plain", indent: 0 });
    }
    spaced.push(row);
  }
  // 模型回复尾部空行不显示：流式块以换行结尾时 appendStream 会留下末尾空
  // assistant 行；仅两个正文段之间的空行才有段落意义(保留)，其后不再有正文
  // 的空行（分隔线/下条用户消息/缓冲尾部之前）视为多余。
  let hasBodyAfter = false;
  for (let i = spaced.length - 1; i >= 0; i--) {
    const row = spaced[i]!;
    if (row.kind === "assistant" && row.text !== "") hasBodyAfter = true;
    else if (row.kind === "assistant" && row.text === "" && !hasBodyAfter)
      spaced.splice(i, 1);
  }
  return spaced;
}

/** 系统状态区：可多行；无标题，`|` 分隔；超宽时溢出到下一行（不截断） */
const identity = (s: string): string => s;
/** 模型段标签：provider/model[:reasoningEffort]，无 effort 时不带冒号后缀 */
export function modelLabel(sel: {
  provider: string;
  model: string;
  reasoningEffort?: string;
}): string {
  return `${sel.provider}/${sel.model}${sel.reasoningEffort ? ":" + sel.reasoningEffort : ""}`;
}

/** provider 浅紫，模型名绿色，:effort 灰色；无 "/" 时整体绿色（如占位 "—" 保持无色） */
function colorModel(themeId: ThemeId, s: string): string {
  const slash = s.indexOf("/");
  if (slash < 0) return s === "—" ? s : colorFor(themeId, "green")(s);
  const rest = s.slice(slash + 1);
  const colon = rest.indexOf(":");
  const model = colon < 0 ? rest : rest.slice(0, colon);
  const effort = colon < 0 ? "" : rest.slice(colon);
  return (
    colorFor(themeId, "brightMagenta")(s.slice(0, slash)) +
    colorFor(themeId, "green")("/" + model) +
    (effort ? colorFor(themeId, "gray")(effort) : "")
  );
}
export function renderStatusLine(
  status: AppState["systemStatus"],
  themeId: ThemeId,
  cols: number,
): RenderLine[] {
  const values: Array<{ seg: string; color: (s: string) => string }> = [
    { seg: status.time, color: identity },
    { seg: status.model, color: (s) => colorModel(themeId, s) },
    { seg: status.cwd, color: colorFor(themeId, "blue") },
    { seg: status.git, color: identity },
    { seg: status.contextLen, color: identity },
    { seg: status.cacheHit, color: identity },
  ];
  // 布局先用纯文本算宽，着色放在行组装时（ANSI 码不进入宽度计算）。
  // 放不下的段溢出到下一行；段本身先按预算分块，保证任何单块都不超一行可用宽度。
  const rows: RenderLine[] = [];
  let line: Array<{ text: string; color: (s: string) => string }> = [];
  let used = 0; // 已占用可见宽度（含分隔符，不含行首尾空格）
  const maxSegW = Math.max(1, cols - 2); // 留首尾各 1 列
  const flush = (): void => {
    rows.push({
      text: " " + line.map((k) => k.color(k.text)).join("|") + " ",
    });
    line = [];
    used = 0;
  };
  for (const v of values) {
    for (const chunk of wrapLine(v.seg, maxSegW)) {
      const sepW = line.length > 0 ? 1 : 0;
      const vw = displayWidth(chunk);
      if (line.length > 0 && used + sepW + vw > maxSegW) flush();
      line.push({ text: chunk, color: v.color });
      used += (line.length > 1 ? 1 : 0) + vw;
    }
  }
  flush();
  return rows;
}

/** 提示符左字符 = 上次提交所用模式的符号（normal > / shell $ / slash /；颜色随状态） */

/** 提示符左字符状态色：绿=成功等待 / 黄=进行中 / 红=失败等待 */
const STATUS_PROMPT_COLOR: Record<InputStatus, ColorName> = {
  success: "green",
  running: "yellow",
  failure: "red",
};
/** 提示符右字符 = 当前输入模式符号（normal > / shell $ / slash /；默认前景色，不着色） */
const MODE_SYMBOL: Record<InputMode, string> = {
  normal: ">",
  shell: "$",
  slash: "/",
};

/** 由渲染帧（AppState → RenderLine[]）：顶部(插件+历史) + 分隔线 + 状态区 + 分隔线 + 输入/审批 */
export function buildFrame(state: AppState, size: Size): RenderLine[] {
  const approval = state.approval;
  const showApproval = approval !== null;
  const picker = state.picker;
  const fullWidth = Math.max(1, size.cols);
  // 状态区先算出行数，再让 metrics 以便压缩顶部区域（多行状态栏不溢出帧）
  const statusLines = renderStatusLine(
    state.systemStatus,
    state.themeId,
    fullWidth,
  );
  const metrics = metricsFor(
    size,
    showApproval,
    // 三列共用同一视口高度；按 providers 与各 provider 的模型列表较大者算，
    // 不随当前 models/efforts 变化，保证切换 provider 时面板高度稳定不跳动。
    // +1 用于最底行按键帮助
    Math.max(
      picker?.providers.length ?? 0,
      ...Object.values(picker?.providerModels ?? {}).map((list) => list.length),
    ) + 1,
    statusLines.length,
  );

  const topRegion = buildTopRegion(
    state,
    metrics.topHeight,
    metrics.pluginWidth,
    metrics.historyWidth,
    fullWidth,
  );

  let footerLines: RenderLine[];
  if (showApproval) {
    footerLines = renderApprovalPrompt(
      approval as ApprovalItem,
      metrics.footerHeight,
      fullWidth,
    );
  } else if (picker) {
    footerLines = renderModelPicker({
      picker,
      height: metrics.footerHeight,
      width: fullWidth,
    });
  } else {
    // 两字符提示符：左字符 = 上次提交所用模式符号（MODE_SYMBOL[lastSubmitMode]，
    // 颜色随状态绿/黄/红），右字符 = 当前输入模式符号（MODE_SYMBOL[inputMode]，
    // 默认前景色不着色）；prompt 预先分段着色，renderTextInput 宽度按未着色文本计算。
    const prompt =
      colorFor(
        state.themeId,
        STATUS_PROMPT_COLOR[state.inputStatus],
      )(MODE_SYMBOL[state.lastSubmitMode] ?? ">") +
      (MODE_SYMBOL[state.inputMode] ?? ">") +
      " ";
    footerLines = renderTextInput(
      state.inputText,
      state.inputCursor,
      "Type a message…",
      fullWidth,
      prompt,
    );
  }

  // 上/中/下三区之间各插一条横线分隔行（边框统一灰色：先纯文本截断再着色）
  const sepLine: RenderLine = {
    text: colorFor(
      state.themeId,
      "gray",
    )(truncateToWidth(SEPARATOR.repeat(fullWidth), fullWidth)),
  };
  return [...topRegion, sepLine, ...statusLines, sepLine, ...footerLines];
}
