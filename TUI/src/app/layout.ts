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
import type { ApprovalItem } from "./adapter/dsh.ts";
import { renderTextInput } from "./components/TextInput.ts";
import chalk from "chalk";
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
  /** 系统状态区行数（固定 1） */
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
): FrameMetrics {
  const statusHeight = 1;
  const footerHeight = hasApprovalPrompt
    ? Math.max(4, Math.floor(size.rows * 0.3))
    : 1;
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
  const wrapped = wrapLines(state.buffer, historyWidth);
  const vp = computeViewport({
    totalRows: wrapped.length,
    height: topHeight,
    followBottom: state.followBottom,
    scrollOffset: state.scrollOffset,
  });
  const rows: RenderLine[] = [];
  for (let i = 0; i < topHeight; i++) {
    const left = pluginCell(i, topHeight, pluginWidth);
    const idx = vp.start + i;
    const right = idx < vp.end ? (wrapped[idx] ?? "") : "";
    // 竖线(边框)灰色：先对纯文本做宽度截断，再把左侧竖线段染灰，
    // 避免 ANSI 码被 displayWidth/truncateToWidth 误计入显示宽度
    const trim = truncateToWidth(left + right, cols);
    const text =
      trim.length >= left.length
        ? chalk.gray(left) + trim.slice(left.length)
        : trim;
    rows.push({ text });
  }
  return rows;
}

/** 系统状态区：横向单行；无标题，`|` 分隔，仅路径段染蓝；超宽截断不切半个 CJK */
export function renderStatusLine(
  status: AppState["systemStatus"],
  cols: number,
): RenderLine {
  const values = [
    status.time,
    status.cwd,
    status.git,
    status.model,
    status.contextLen,
    status.cacheHit,
  ];
  // 状态栏默认前景色；仅路径(目录)段染蓝（values 下标 1，整状态段已移除）。
  // 纯文本宽度预算决定放得下的段（ANSI 着色不影响显示宽度：先布局、后着色）
  let used = 0; // 已占用可见宽度（含分隔符，不含首尾空格）
  const kept: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const sepW = kept.length > 0 ? 1 : 0; // '|' 宽 1
    const vw = displayWidth(v);
    if (used + sepW + vw > cols - 2) break; // 留首尾各 1 列，避免换行溢出
    kept.push({ idx: i, text: v });
    used += sepW + vw;
  }
  const text = kept
    .map((k) => (k.idx === 1 ? chalk.blue(k.text) : k.text))
    .join("|");
  return { text: " " + text + " " };
}

/** 由渲染帧（AppState → RenderLine[]）：顶部(插件+历史) + 分隔线 + 状态区 + 分隔线 + 输入/审批 */
export function buildFrame(state: AppState, size: Size): RenderLine[] {
  const approval = state.approval;
  const showApproval = approval !== null;
  const metrics = metricsFor(size, showApproval);
  const fullWidth = Math.max(1, size.cols);

  const topRegion = buildTopRegion(
    state,
    metrics.topHeight,
    metrics.pluginWidth,
    metrics.historyWidth,
    fullWidth,
  );

  const statusLine = renderStatusLine(state.systemStatus, fullWidth);

  const footerLines = showApproval
    ? renderApprovalPrompt(
        approval as ApprovalItem,
        metrics.footerHeight,
        fullWidth,
      )
    : renderTextInput(
        state.inputText,
        state.inputCursor,
        "Type a message…",
        fullWidth,
      );

  // 上/中/下三区之间各插一条横线分隔行（边框统一灰色：先纯文本截断再着色）
  const sepLine: RenderLine = {
    text: chalk.gray(truncateToWidth(SEPARATOR.repeat(fullWidth), fullWidth)),
  };
  return [...topRegion, sepLine, statusLine, sepLine, ...footerLines];
}
