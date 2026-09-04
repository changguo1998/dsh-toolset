// src/app/layout.ts — 视口切分 + 帧组装（纯函数，可单测）
//
// 语义（DESIGN scrollback 行为）：
//  - 长行按列宽软换行（wrapping）
//  - 视口 = 换行后行数组上裁剪出的可见窗口
//  - followBottom=true 跟随底部；用户上滚后 followBottom=false，
//    scrollOffset 表示距底部多少行，up/down/PageUp/PageDown 移动它
//  - buffer 超 2000 行裁剪由 state.ts 负责（MAX_BUFFER_LINES）
//
// markdown 子集渲染（行内/块级）与宽度原语见 ./layout/markdown.ts；本文件保留
// 换行/视口/帧组装，并重导 charWidth/displayWidth/parseInlineMarkdown/wrapInlineMarkdown。

import type { RenderLine } from "../renderer/index.ts";
import type { Size } from "../renderer/index.ts";
import type {
  AppState,
  InputMode,
  InputStatus,
  QuestionPanelState,
} from "./state.ts";

import type { Buffer, BufferKind, BufferLine } from "./state.ts";
import type { ApprovalItem, NoticeTone } from "./adapter/dsh.ts";
import { renderTextInput } from "./components/TextInput.ts";
import { renderModelPicker } from "./components/ModelPicker.ts";
import { renderHistoryPanel } from "./components/HistoryPanel.ts";
import { renderQuestionPanel } from "./components/QuestionPrompt.ts";
import type { ColorName, ThemeId } from "../renderer/theme.ts";
import { colorFor } from "../renderer/theme.ts";
import { renderApprovalPrompt } from "./components/ApprovalPrompt.ts";
import {
  charWidth,
  displayWidth,
  FENCE_RE,
  renderSeg,
  wrapAssistantLine,
  wrapCodeLine,
} from "./layout/markdown.ts";
export {
  charWidth,
  displayWidth,
  parseInlineMarkdown,
  wrapInlineMarkdown,
} from "./layout/markdown.ts";

// ---------- 换行（wrapping）纯函数 ----------

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

/** 按键提示区内容（独立区域，位于输入区下方、之间不画横线；窄终端按显示宽度截断；审批/问答/选择面板自带按键提示，不显示该区） */
export const HINT_LINE =
  "[Enter]发送 · [Alt+Enter]打断并发送 · [Esc]打断 · [Ctrl+L]重绘 · [/help]更多命令";

export interface FrameMetrics {
  /** 顶部区域行数 = rows - 状态区 - 输入区 - 按键提示区 - 分隔行（剩余高度全给上方两个） */
  topHeight: number;
  /** 系统状态区行数（可 >1：状态内容溢出到多行时按实际行数） */
  statusHeight: number;
  /** 输入区行数（审批弹窗时更高） */
  footerHeight: number;
  /** 按键提示区行数（独立区域，位于输入区下方、之间不画横线；输入态 1，面板打开 0） */
  hintHeight: number;
  /** 插件窄条固定宽 */
  pluginWidth: number;
  /** 历史区宽 = cols - pluginWidth */
  historyWidth: number;
}

export function metricsFor(
  size: Size,
  /** 是否有交互面板打开（审批/问答/模型选择） */
  hasPanel = false,
  /** 状态区行数（默认 1；可多行溢出时按实际行数压缩顶部区域） */
  statusHeight = 1,
  /** 按键提示区行数（独立区域，与输入区共同构成交互区；输入态 1） */
  hintRows = 0,
): FrameMetrics {
  // 「交互区」（输入区+按键提示区）高度固定：总高足够时占 floor(rows/4)，
  // 不足时至少 2 行（输入 1 + 提示 1）。面板态（审批/问答/选择）整体占据
  // 交互区（面板自带最底行按键提示、无独立提示区），与输入态同高——
  // 面板开关不改变交互区高度，避免顶部区域上下跳动
  const interaction = Math.max(2, Math.floor(size.rows / 4));
  const footerHeight = hasPanel ? interaction : interaction - 1;
  // 插件窄条：固定宽，但窄终端时让出至少 1 列给历史区
  const pluginWidth = Math.min(PLUGIN_WIDTH, Math.max(1, size.cols - 2));
  const historyWidth = Math.max(1, size.cols - pluginWidth);
  const topHeight = Math.max(
    0,
    size.rows - statusHeight - footerHeight - hintRows - SEPARATOR_ROWS,
  );
  return {
    topHeight,
    statusHeight,
    footerHeight,
    hintHeight: hintRows,
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
/** 对话区仅保留最近 DIALOGUE_KEEP_REPLIES 条回复，更早以灰占位折叠 */
export const DIALOGUE_KEEP_REPLIES = 3;
export const DIALOGUE_MORE = "…(更早回复已折叠)";
/** 活动区固定行高（下方思考/工具/瞬态窗口） */
export const ACTIVITY_HEIGHT = 5;
/** 活动区分隔线字形（与 turn/区域分隔线 `─` 区分，不参与 barRowCount 统计） */
export const ACTIVITY_SEPARATOR = "╌";

/** 对话区按回复组折叠：仅保留最近 keep 组 assistant 回复，更早替换为灰色占位 */
function foldDialogue(
  rows: WrappedRow[],
  themeId: ThemeId,
  keep: number,
): WrappedRow[] {
  // 回复组 = 连续 assistant 行（同一回复的流式/多行）
  const starts: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (
      rows[i]!.kind === "assistant" &&
      (i === 0 || rows[i - 1]!.kind !== "assistant")
    )
      starts.push(i);
  }
  if (starts.length <= keep) return rows;
  // 剪切点：第 keep 新回复组起点，前移包含其前置用户消息/分隔线/空行，
  // 使可见区从“最后 keep 组对话”的用户消息开始，读起来完整。
  let cut = starts[starts.length - keep]!;
  while (cut > 0 && isConversationKind(rows[cut - 1]!.kind)) cut--;
  const marker: WrappedRow = {
    text: colorFor(themeId, NOTICE_TONE_COLOR.muted)(DIALOGUE_MORE),
    kind: "plain",
    indent: 0,
  };
  return [marker, ...rows.slice(cut)];
}

/** 对话区前置段类型（剪切点外推）：用户/分隔线/空行属于回复的陪衬 */
function isConversationKind(kind: BufferKind): boolean {
  return kind === "user" || kind === "separator" || kind === "plain";
}

/** 顶部区域：上部对话区（视口滚动）+ 下部活动区（固定高、底部跟随） */
function buildTopRegion(
  state: AppState,
  topHeight: number,
  pluginWidth: number,
  historyWidth: number,
  cols: number,
): RenderLine[] {
  const { dialogue, activity } = wrapBufferLines(
    state.buffer,
    historyWidth,
    state.thinkingMaxLines,
    state.messageGutter,
    state.themeId,
  );
  const dialogueRows = foldDialogue(
    dialogue,
    state.themeId,
    DIALOGUE_KEEP_REPLIES,
  );
  // 活动区固定 ACTIVITY_HEIGHT 行 + 1 条分隔线；极窄时收缩保对话区非空
  // 活动区固定 ACTIVITY_HEIGHT 行 + 1 条分隔线；极窄终端收缩活动区，
  // 为对话区保留至少 DIALOGUE_MIN_ROWS 行（避免把对话完全挤出历史区）
  const dialogueMin = Math.min(3, Math.max(0, topHeight - 1));
  const activityH = Math.min(
    ACTIVITY_HEIGHT,
    Math.max(1, topHeight - 1 - dialogueMin),
  );
  const dialogueH = Math.max(
    0,
    topHeight - activityH - (activityH > 0 ? 1 : 0),
  );
  const vp = computeViewport({
    totalRows: dialogueRows.length,
    height: dialogueH,
    followBottom: state.followBottom,
    scrollOffset: state.scrollOffset,
  });
  const rows: RenderLine[] = [];
  const histLine = (row: number, content: string): RenderLine => {
    const left = pluginCell(row, topHeight, pluginWidth);
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
    return { text };
  };
  // 对话区：视口窗口可见行（followBottom / scrollOffset 只作用于对话区）
  for (let i = 0; i < dialogueH; i++) {
    const w = dialogueRows[vp.start + i];
    const content =
      w && vp.start + i < vp.end ? " ".repeat(w.indent) + w.text : "";
    rows.push(histLine(i, content));
  }
  if (activityH > 0) {
    // 两区分隔线
    rows.push(
      histLine(dialogueH, ACTIVITY_SEPARATOR.repeat(Math.max(1, historyWidth))),
    );
    // 活动区：底部对齐显示最近 activityH 行，不足时顶部留白
    const act = activity.slice(-activityH);
    const topPad = activityH - act.length;
    for (let i = 0; i < activityH; i++) {
      const a = i - topPad;
      const content = a >= 0 ? " ".repeat(act[a]!.indent) + act[a]!.text : "";
      rows.push(histLine(dialogueH + 1 + i, content));
    }
  }
  return rows;
}

export const USER_MIN_LEFT_GUTTER = 4;
export const THINKING_INDENT = 2;
export const THINKING_MORE = "…(更多思考已折叠)";
/** 工具调用历史：仅展示最近 TOOL_MAX_GROUPS 个调用组，更早隐藏（折叠标记） */
export const TOOL_MAX_GROUPS = 4;
export const TOOL_MORE = "…(更早工具调用已隐藏)";
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

interface PaneRows {
  /** 对话区行：user/assistant/separator/plain（可滚动视口） */
  dialogue: WrappedRow[];
  /** 活动区行：thinking/tool/notice（瞬态，底部固定窗口） */
  activity: WrappedRow[];
}

function wrapBufferLines(
  buffer: Buffer,
  width: number,
  thinkingMaxLines: number,
  gutter: number,
  themeId: ThemeId,
): PaneRows {
  const dialogue: WrappedRow[] = [];
  const activity: WrappedRow[] = [];
  const thinking: WrappedRow[] = [];
  let inFence = false;
  // 工具行按连续 run 收集，flush 时做折叠/分组渲染；遇到非工具行先落盘
  const toolRun: BufferLine[] = [];
  const flushToolRun = (): void => {
    if (toolRun.length === 0) return;
    // 按调用分组：⚙ 起新组，后续 ✓/✗ 结果归入当前组
    const groups: BufferLine[][] = [[]];
    for (const l of toolRun) {
      if (l.text.startsWith("⚙") && groups[groups.length - 1]!.length > 0)
        groups.push([]);
      groups[groups.length - 1]!.push(l);
    }
    // 折叠：仅保留最近 TOOL_MAX_GROUPS 组，更早以灰色折叠标记隐藏
    const visible = groups.slice(-TOOL_MAX_GROUPS);
    const hasMore = groups.length > TOOL_MAX_GROUPS;
    if (hasMore) {
      activity.push({
        text: colorFor(themeId, NOTICE_TONE_COLOR.muted)(TOOL_MORE),
        kind: "tool",
        indent: 0,
      });
    }
    for (let gi = 0; gi < visible.length; gi++) {
      if (gi > 0) activity.push({ text: "", kind: "tool", indent: 0 }); // 组间空行
      for (const l of visible[gi]!) {
        const rows =
          l.text === "" ? [""] : wrapLine(l.text, Math.max(1, width));
        // ✗ 由 tone 整体着红；⚙/✓ 前缀+工具名特殊着色（见 renderToolText）
        for (const t of rows) {
          const text = l.tone
            ? colorFor(themeId, NOTICE_TONE_COLOR[l.tone])(t)
            : renderToolText(t, themeId);
          activity.push({ text, kind: "tool", indent: 0 });
        }
      }
    }
    toolRun.length = 0;
  };
  for (const line of buffer) {
    if (line.kind !== "tool" && toolRun.length > 0) flushToolRun();
    if (line.kind === "tool") {
      toolRun.push(line);
      continue;
    }
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
      for (const text of rows)
        dialogue.push({ text, kind: "user", indent: pad });
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
            dialogue.push({
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
      for (const text of rows)
        dialogue.push({ text, kind: line.kind, indent: 0 });
      continue;
    }
    if (line.kind === "notice") {
      // notice → 活动区（瞬态提示）
      const rows =
        line.text === "" ? [""] : wrapLine(line.text, Math.max(1, width));
      const tone = line.tone;
      const color = tone
        ? (s: string) => colorFor(themeId, NOTICE_TONE_COLOR[tone])(s)
        : (s: string) => s;
      for (const text of rows)
        activity.push({ text: color(text), kind: "notice", indent: 0 });
      continue;
    }
    // separator / plain → 对话区
    const content =
      line.kind === "separator"
        ? SEPARATOR.repeat(Math.max(1, width))
        : line.text;
    const rows = content === "" ? [""] : wrapLine(content, Math.max(1, width));
    for (const text of rows)
      dialogue.push({ text, kind: line.kind, indent: 0 });
  }
  flushToolRun();
  // 思考折叠 → 活动区
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
      activity.push({ text: row.text, kind: "thinking", indent: row.indent });
    }
  }
  // 对话区：用户消息块与随后的答案之间空一行（纯布局展示，不写状态）
  const spaced: WrappedRow[] = [];
  for (const row of dialogue) {
    const last = spaced[spaced.length - 1];
    if (last && last.kind === "user" && row.kind === "assistant") {
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
  return { dialogue: spaced, activity };
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
/** notice/tool 行 tone → 着色名（error 红 / warn 黄 / muted 灰） */
const NOTICE_TONE_COLOR: Record<NoticeTone, ColorName> = {
  error: "red",
  warn: "yellow",
  muted: "gray",
};

/** 工具行前缀着色：⚙ 前缀青、工具名黄；✓ 前缀绿；✗/续行原样（✗ 由 tone 整体着红） */
function renderToolText(text: string, themeId: ThemeId): string {
  if (text.startsWith("⚙ ")) {
    const rest = text.slice(2);
    const sp = rest.indexOf(" ");
    const name = sp < 0 ? rest : rest.slice(0, sp);
    const summary = sp < 0 ? "" : rest.slice(sp); // 含前导空格
    return (
      colorFor(themeId, "cyan")("⚙") +
      " " +
      colorFor(themeId, "yellow")(name) +
      summary
    );
  }
  if (text.startsWith("✓ ")) {
    return colorFor(themeId, "green")("✓") + " " + text.slice(2);
  }
  return text;
}

/** token 数 → 紧凑缩写（k 千 / M 百万，1 位小数，如 12.4k / 1.5M） */
function formatTokens(n: number): string {
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/** state.usage → 状态栏 contextLen/cacheHit 段（total<=0 或无用量时 undefined，保留占位） */
function usageStatus(u: {
  input: number;
  output: number;
  cacheRead: number;
}): { ctx: string; cache: string } | undefined {
  const total = u.input + u.cacheRead;
  if (total <= 0) return undefined;
  const pct = Math.round((u.cacheRead / total) * 100);
  return { ctx: "ctx " + formatTokens(total), cache: "cache " + pct + "%" };
}

/** 段文本按预算截断：过长保留开头 + 省略号（w<=3 视作不截断，交给换行兜底） */
function fitHead(s: string, w: number): string {
  if (w <= 3 || displayWidth(s) <= w) return s;
  return truncateToWidth(s, w - 1) + "…";
}

/** 路径段按预算截断：保留末尾 + 省略号（路径尾部更有辨识度） */
function fitTail(s: string, w: number): string {
  if (w <= 3 || displayWidth(s) <= w) return s;
  const budget = w - 1; // 省略号占 1 列
  let kept = "";
  let used = 0;
  for (const ch of [...s].reverse()) {
    const cw = charWidth(ch);
    if (budget - used < cw) break; // 剩余预算放不下该字符则停，保留已取尾部
    kept = ch + kept;
    used += cw;
  }
  return "…" + kept;
}

/**
 * 模型段按预算截断：优先截 provider/model 名，保留 effort 后缀（:min/:med/:max 等）。
 * 稳定内容紧凑化，避免长模型名挤占动态段（cwd/ctx/cache）的宽度。
 */
function fitModel(s: string, w: number): string {
  const slash = s.indexOf("/");
  const colon = (slash < 0 ? s : s.slice(slash)).indexOf(":");
  const effort = colon >= 0 ? s.slice(slash + colon) : ""; // 含 : 前缀
  const body = effort ? s.slice(0, s.length - effort.length) : s;
  if (w <= 4 || displayWidth(s) <= w) return s;
  const bodyW = Math.max(1, w - 1 - displayWidth(effort)); // 留 1 列省略号
  return truncateToWidth(body, bodyW) + "…" + effort;
}

export function renderStatusLine(
  status: AppState["systemStatus"],
  title: string,
  themeId: ThemeId,
  cols: number,
  /** 最新一次模型调用 token 用量（有且 total>0 时覆盖 contextLen/cacheHit 占位） */
  usage?: AppState["usage"],
): RenderLine[] {
  const u = usage ? usageStatus(usage) : undefined;
  const ctxSeg = u?.ctx ?? status.contextLen;
  const cacheSeg = u?.cache ?? status.cacheHit;
  // 稳定组（time/title/model/git）按固定预算截断 → 各段宽度有上限、不变频跳动；
  // 动态组（cwd/ctx/cache）独立成段，其中 cwd 独占单行余下宽度（留足变化空间）。
  const titleSeg = cols >= 24 ? fitHead(title, 16) : "";
  const gitSeg = fitHead(status.git, 12);
  const fixed: Array<{ seg: string; color: (s: string) => string }> = [
    { seg: status.time, color: identity },
    // 会话标题段：极窄终端（<24 列）省略以保留对话内容（窄屏退化）
    ...(cols >= 24
      ? [
          {
            seg: titleSeg,
            color: (_s: string) => colorFor(themeId, "cyan")(titleSeg),
          },
        ]
      : []),
    { seg: fitModel(status.model, 22), color: (s) => colorModel(themeId, s) },
    { seg: gitSeg, color: identity },
    { seg: ctxSeg, color: identity },
    { seg: cacheSeg, color: identity },
  ];
  // 单行预算：留首尾各 1 列，减固定段宽与 k 个分隔符，余下全给 cwd。
  const maxSegW = Math.max(1, cols - 2); // 留首尾各 1 列
  const k = fixed.length; // 固定段数 = 单行分隔符数（cwd 占 1 个分隔符）
  const sumFixed = fixed.reduce((acc, f) => acc + displayWidth(f.seg), 0);
  const cwdSeg = fitTail(status.cwd, maxSegW - k - sumFixed);
  // 段序：稳定组在前（time|title|model|git），动态组在后（cwd|ctx|cache）
  const headN = cols >= 24 ? 4 : 3;
  const values: Array<{ seg: string; color: (s: string) => string }> = [
    ...fixed.slice(0, headN),
    { seg: cwdSeg, color: colorFor(themeId, "blue") },
    ...fixed.slice(headN), // ctx/cache
  ];
  // 布局先用纯文本算宽，着色放在行组装时（ANSI 码不进入宽度计算）。
  // 极窄终端预算不足（cwd 未截断）时仍可溢出到下一行，段不丢。
  const rows: RenderLine[] = [];
  let line: Array<{ text: string; color: (s: string) => string }> = [];
  let used = 0; // 已占用可见宽度（含分隔符，不含行首尾空格）
  const flush = (): void => {
    rows.push({
      text: " " + line.map((k2) => k2.color(k2.text)).join("|") + " ",
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
  const question = state.question;
  const history = state.history;
  const fullWidth = Math.max(1, size.cols);
  // 状态区先算出行数，再让 metrics 以便压缩顶部区域（多行状态栏不溢出帧）
  // 按键提示区仅输入态存在（审批/问答/选择/历史面板自带按键提示），与输入区之间不画横线
  const normalInput = !showApproval && !question && !picker && !history;
  const statusLines = renderStatusLine(
    state.systemStatus,
    state.sessionTitle,
    state.themeId,
    fullWidth,
    state.usage,
  );
  // 面板态/输入态共用固定交互区高度（见 metricsFor）；提示区仅输入态计入
  const metrics = metricsFor(
    size,
    !normalInput,
    statusLines.length,
    normalInput ? 1 : 0,
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
  } else if (question) {
    footerLines = renderQuestionPanel(
      question as QuestionPanelState,
      metrics.footerHeight,
      fullWidth,
    );
  } else if (picker) {
    footerLines = renderModelPicker({
      picker,
      height: metrics.footerHeight,
      width: fullWidth,
    });
  } else if (history) {
    footerLines = renderHistoryPanel({
      history,
      height: metrics.footerHeight,
      width: fullWidth,
    });
  } else {
    // 两字符提示符：左字符 = 上次提交所用模式符号（MODE_SYMBOL[lastSubmitMode]，
    // 颜色随状态绿/黄/红），右字符 = 当前输入模式符号（MODE_SYMBOL[inputMode]，
    // 默认前景色不着色）；prompt 预先分段着色，renderTextInput 宽度按未着色文本计算。
    // 输入区为多行框：文本按宽度换行、顶部对齐，光标行超出区域时跟随。
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
      undefined,
      metrics.footerHeight,
    );
  }

  // 按键提示区（独立区域，与输入区之间不画横线；统一灰色同边框；窄终端按显示宽度截断）
  const hintLines: RenderLine[] = normalInput
    ? [
        {
          text: colorFor(
            state.themeId,
            "gray",
          )(truncateToWidth(HINT_LINE, fullWidth)),
        },
      ]
    : [];

  // 上/中/下三区之间各插一条横线分隔行（边框统一灰色：先纯文本截断再着色）
  const sepLine: RenderLine = {
    text: colorFor(
      state.themeId,
      "gray",
    )(truncateToWidth(SEPARATOR.repeat(fullWidth), fullWidth)),
  };
  return [
    ...topRegion,
    sepLine,
    ...statusLines,
    sepLine,
    ...footerLines,
    ...hintLines,
  ];
}
