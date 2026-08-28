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
import type { AppState } from "./state.ts";

import type { Buffer, BufferKind } from "./state.ts";
import type { ApprovalItem } from "./adapter/dsh.ts";
import { renderTextInput } from "./components/TextInput.ts";
import { renderModelPicker } from "./components/ModelPicker.ts";
import type { ThemeId } from "../renderer/theme.ts";
import { colorFor } from "../renderer/theme.ts";
import { renderApprovalPrompt } from "./components/ApprovalPrompt.ts";

// ---------- 换行（wrapping）纯函数 ----------

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
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** 按显示宽度截断：超出 cols 的尾部丢弃（不切半个 CJK 字符） */
export function truncateToWidth(text: string, cols: number): string {
  if (cols <= 0) return "";
  let w = 0;
  let out = "";
  for (const ch of text) {
    const cw = charWidth(ch);
    if (w + cw > cols) break;
    out += ch;
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
): WrappedRow[] {
  const out: WrappedRow[] = [];
  const thinking: WrappedRow[] = [];
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
      // 模型正文：右缘保留与用户块左缘对称的空间(交错布局)，文本不顶满右缘
      const rows = wrapLine(line.text, assistantMaxBodyWidth(width, gutter));
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
    footerLines = renderTextInput(
      state.inputText,
      state.inputCursor,
      "Type a message…",
      fullWidth,
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
