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
import { renderScrollView } from "./components/ScrollView.ts";
import { renderTextInput } from "./components/TextInput.ts";
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

export interface FrameMetrics {
  headerHeight: number;
  scrollHeight: number;
  footerHeight: number;
  scrollStart: number; // scroll 区域第一行行号（1-based）
}

export function metricsFor(
  size: Size,
  hasApprovalPrompt: boolean,
): FrameMetrics {
  const headerHeight = 1;
  const footerHeight = hasApprovalPrompt
    ? Math.max(4, Math.floor(size.rows * 0.3))
    : 1;
  const scrollHeight = Math.max(0, size.rows - headerHeight - footerHeight);
  return {
    headerHeight,
    scrollHeight,
    footerHeight,
    scrollStart: headerHeight + 1,
  };
}

/** 由渲染帧（AppState → RenderLine[]），header + 流式区 + 输入行/审批弹窗 */
export function buildFrame(state: AppState, size: Size): RenderLine[] {
  const approval = state.approval;
  const showApproval = approval !== null;
  const metrics = metricsFor(size, showApproval);
  const fullWidth = Math.max(1, size.cols);

  // header：会话标题 + agent 状态
  const headerLine: RenderLine = {
    text: ` DSHTUI · ${state.activeSessionId ?? "—"} · ${state.agentStatus} `,
  };

  // 流式区
  const wrapped = wrapLines(state.buffer, fullWidth);
  const vp = computeViewport({
    totalRows: wrapped.length,
    height: metrics.scrollHeight,
    followBottom: state.followBottom,
    scrollOffset: state.scrollOffset,
  });
  const scrollLines = renderScrollView(wrapped, vp.start, vp.end, fullWidth);

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

  return [headerLine, ...scrollLines, ...footerLines];
}
