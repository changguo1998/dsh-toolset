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
  GoalState,
  ModeState,
} from "./state.ts";

import type { Buffer, BufferKind, BufferLine } from "./state.ts";
import type { ApprovalItem, NoticeTone, TodoItemLike } from "./adapter/dsh.ts";
import { renderTextInput } from "./components/TextInput.ts";
import { renderModelPicker } from "./components/ModelPicker.ts";
import { renderHistoryPanel } from "./components/HistoryPanel.ts";
import { renderQuestionPanel } from "./components/QuestionPrompt.ts";
import { renderGoalPanel } from "./components/GoalPanel.ts";
import { renderJobsPanel } from "./components/JobsPanel.ts";
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

/** 水平分隔线字符（turn 分隔 / 状态区下方横线；box-drawing 可与竖线连成连续线） */
export const SEPARATOR = "─";

/** 状态区上方分隔线字符（双线观感，沿用原 `=`；box-drawing 可与竖线连成连续线） */
export const STATUS_TOP_SEPARATOR = "═";

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
  /** 顶部状态列宽（详细 goal/todo；窄列约 25%，含左缘分隔竖线，状态列位于右侧列） */
  statusColWidth: number;
  /** 历史区宽 = cols - statusColWidth */
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
  // 「交互区」（输入框 3 行 + 按键提示区 1 行）固定为 4 行；
  // 不足时至少 2 行（输入 1 + 提示 1）。面板态（审批/问答/选择）整体占据
  // 交互区（面板自带最底行按键提示、无独立提示区），与输入态同高——
  // 面板开关不改变交互区高度，避免顶部区域上下跳动
  // 输入框固定 3 行(+按键提示 1 行 → 交互区 4 行)；矮终端按 1/5 比例收缩保底每区 ≥1 行
  const interaction = Math.min(4, Math.max(2, Math.floor(size.rows / 5)));
  const footerHeight = hasPanel ? interaction : interaction - 1;
  // 状态列：窄列约 25%（含右侧竖线），但历史区保底 10 列
  const statusColWidth = Math.min(
    Math.max(1, Math.floor(size.cols * 0.25)),
    Math.max(1, size.cols - 10),
  );
  const historyWidth = Math.max(1, size.cols - statusColWidth);
  const topHeight = Math.max(
    0,
    size.rows - statusHeight - footerHeight - hintRows - SEPARATOR_ROWS,
  );
  return {
    topHeight,
    statusHeight,
    footerHeight,
    hintHeight: hintRows,
    statusColWidth,
    historyWidth,
  };
}

/** 对话区仅保留最近 DIALOGUE_KEEP_REPLIES 条回复，更早以灰占位折叠 */
export const DIALOGUE_KEEP_REPLIES = 3;
export const DIALOGUE_MORE = "...(更早回复已折叠)";
/** 活动区行数 = 右上区（对话历史+活动区）高度的一半（固定比例，不随内容变化） */
export const ACTIVITY_HEIGHT_RATIO = 1 / 2;
/** 活动区分隔线字形（对话历史 ↔ 流输出边界：box-drawing 虚线，保留点感；不参与 barRowCount 统计） */
export const ACTIVITY_SEPARATOR = "┈";
/** 焦点面板四边框的保留格：顶部 1 行、左侧 1 列、右侧 1 列（所有状态恒定，未聚焦留空白占位，防内容重排） */
export const FRAME_TOP_ROWS = 1;
export const FRAME_LEFT_COLS = 1;
export const FRAME_RIGHT_COLS = 1;

/** 焦点框中性亮色：dark 用白、light 用黑（不引入彩色，仅把灰更亮/更黑） */
export function focusFrameColor(themeId: ThemeId): ColorName {
  return themeId === "dark" ? "white" : "black";
}

/** 顶部三面板（Tab 焦点循环）中文标签（hint 行末尾提示焦点用） */
export const PANEL_LABEL: Record<AppState["focusedPanel"], string> = {
  history: "历史",
  activity: "流输出",
  status: "状态",
};

/**
 * 活动区可视行数（= 顶部区域「内容行数」= topHeight-边框行的一半；
 * 与 buildTopRegion/inputPanelHeights 同口径）
 */
export function activityHeight(contentTopH: number): number {
  return contentTopH <= 0
    ? 0
    : Math.max(1, Math.floor(contentTopH * ACTIVITY_HEIGHT_RATIO));
}

/** 普通输入态顶部三面板可视行高（P4 整页滚动用，与 buildFrame 同口径） */
export interface PanelHeights {
  /** 状态列内容高（= topHeight - 顶部边框行；PgUp/PgDn 状态列整页用） */
  topHeight: number;
  activityH: number;
  dialogueH: number;
}

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

/** 顶部状态列：goal 目标条目行数上限 */
export const STATUS_GOAL_MAX_LINES = 5;
/** 顶部状态列：每条 todo 行数上限 */
export const STATUS_TODO_MAX_LINES = 3;
/** 顶部状态列无内容占位 */
export const STATUS_COL_EMPTY = "（无目标/待办）";

const TODO_MARKER: Record<TodoItemLike["status"], string> = {
  pending: "[ ]",
  in_progress: "[●]",
  completed: "[x]",
};

/** todo 行着色：进行中黄、完成绿、待办默认（与 GoalPanel 一致） */
function todoLineColor(
  themeId: ThemeId,
  status: TodoItemLike["status"],
): (s: string) => string {
  if (status === "in_progress") return colorFor(themeId, "yellow");
  if (status === "completed") return colorFor(themeId, "green");
  return (s: string) => s;
}

/** 折叠：wrap 后超过 max 行则截到 max 行，末行追加折叠提示（统计被折叠行数） */
function capWrap(
  text: string,
  width: number,
  max: number,
): { text: string; color?: (s: string) => string }[] {
  const rows = wrapLine(text, Math.max(1, width));
  const out = rows.map((text) => ({ text }));
  if (out.length <= max) return out;
  const hidden = out.length - max;
  const kept = out.slice(0, max - 1);
  // 末行改为折叠提示（保留被折叠行数）；不再在原内容上追加（避免被截掉）
  kept.push({ text: truncateToWidth(`…(+${hidden}行)`, Math.max(1, width)) });
  return kept;
}

/** 顶部状态列正文行（未按可视高度裁剪；供滚动窗口取窗） */
function statusColumnBody(
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  width: number,
  themeId: ThemeId,
): { text: string; color?: (s: string) => string }[] {
  const out: { text: string; color?: (s: string) => string }[] = [];
  if (!goal || goal.status === "cleared") {
    out.push({ text: STATUS_COL_EMPTY, color: colorFor(themeId, "gray") });
    return out;
  }
  const g = goal.goal;
  // 目标（可长，上限 STATUS_GOAL_MAX_LINES 行）
  out.push(
    ...capWrap(
      "目标: " + (g.objective || "（空目标）"),
      width,
      STATUS_GOAL_MAX_LINES,
    ),
  );
  // 阶段徽标
  out.push({ text: `阶段: ${g.phase}` });
  // blocked → blockedReason.message 黄 tone
  if (g.phase === "blocked" && g.blockedReason?.message) {
    out.push({
      text: "阻塞: " + g.blockedReason.message,
      color: colorFor(themeId, "yellow"),
    });
  }
  // todo 计数 + 列表（每条上限 STATUS_TODO_MAX_LINES 行）
  const list = todos ?? [];
  if (list.length > 0) {
    const n = list.filter((t) => t.status === "in_progress").length;
    out.push({ text: `todo ${n}/${list.length}` });
    for (const t of list) {
      const prefix = TODO_MARKER[t.status] + " ";
      const body = t.content === "" ? "（空项）" : t.content;
      const rows = capWrap(prefix + body, width, STATUS_TODO_MAX_LINES);
      const color = todoLineColor(themeId, t.status);
      rows.forEach((r, i) => {
        out.push({ text: r.text, color: i === 0 ? color : undefined });
      });
    }
  }
  return out;
}

/** 顶部状态列窗口起点：偏移恒在 [0, max(0, len-rows)] 内 */
function statusStartFor(len: number, offset: number, rows: number): number {
  if (len <= rows || rows <= 0) return 0;
  return Math.min(Math.max(0, offset), len - rows);
}

/** 顶部状态列（右侧列）：输出恰 height 行，每行宽 statusColWidth（末位竖线为分隔竖线边线，
 *  右侧布局下由 buildTopRegion 剥去后重新构图左缘分隔竖线/右缘框列）。
 *  滚动独立于对话区（statusColumnScroll，↑/↓ 仍滚历史，PgUp/PgDn 滚状态列）。 */
export function renderStatusColumn(
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  scroll: number,
  height: number,
  width: number,
  themeId: ThemeId,
): string[] {
  const h = Math.max(1, height);
  const w = Math.max(1, width);
  const body = statusColumnBody(goal, todos, w - 1, themeId);
  const start = statusStartFor(body.length, scroll, h);
  const out: string[] = [];
  for (let r = 0; r < h; r++) {
    const idx = start + r;
    const line = idx < body.length ? body[idx] : undefined;
    const text = (line?.color ?? ((s: string) => s))(line?.text ?? "");
    const inner = truncateToWidth(text, w - 1);
    // 右缘竖线分隔（制表符竖线 │ 跨行连成连续线）：内容后补空格到 (w-1) 再放竖线
    const pad = " ".repeat(Math.max(0, w - 1 - displayWidth(inner)));
    out.push(inner + pad + "│");
  }
  return out;
}
/** 顶部区域：左列对话历史+活动区（可独立滚动）、右侧详细状态列；焦点面板四边框亮色 */
function buildTopRegion(
  state: AppState,
  topHeight: number,
  statusColWidth: number,
  historyWidth: number,
  focusActive: boolean,
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  statusScroll: number,
): RenderLine[] {
  // 焦点框保留格（所有状态恒定，避免内容重排）：顶部边框行始终占 1 行；
  // 左侧框格列（历史/活动区左缘）与右侧框列（状态列右缘）在宽度允许时各占 1 列；
  // 未聚焦/模态态该格留空白占位。
  const contentTopH = Math.max(0, topHeight - FRAME_TOP_ROWS);
  // 历史/活动区在左、详细状态列在右（2026-09-17 对调）：
  // 左缘框格 = 历史/活动区左缘（historyWidth≥2 时预留）；右缘框列 = 状态列右缘（statusColWidth≥2 时预留）
  const useLeftFrame = historyWidth >= FRAME_LEFT_COLS + 1;
  const useRightFrame = statusColWidth >= FRAME_RIGHT_COLS + 1;
  const contentW = Math.max(
    1,
    historyWidth - (useLeftFrame ? FRAME_LEFT_COLS : 0),
  );
  // 活动区可视行数（瞬态显示区高度）：先于 wrapBufferLines 计算，
  // 供思考折叠上限取 min(thinkingMaxLines, activityH)——默认思考可占满活动区
  const activityH = activityHeight(contentTopH);
  const { dialogue, activity } = wrapBufferLines(
    state.buffer,
    contentW,
    Math.min(state.thinkingMaxLines, activityH),
    state.messageGutter,
    state.themeId,
  );
  const dialogueRows = foldDialogue(
    dialogue,
    state.themeId,
    DIALOGUE_KEEP_REPLIES,
  );
  // 对话区获得剩余高度（活动区高度见上方 activityH 定义）
  const dialogueH = Math.max(
    0,
    contentTopH - activityH - (activityH > 0 ? 1 : 0),
  );
  const vp = computeViewport({
    totalRows: dialogueRows.length,
    height: dialogueH,
    followBottom: state.followBottom,
    scrollOffset: state.scrollOffset,
  });
  // 状态列（右侧）：恰「内容行数」行，每行宽 statusColWidth。
  // renderStatusColumn 自带右缘竖线，对调后剥去不用，分隔竖线左缘/右缘框列由本函数构图
  const statusCells = renderStatusColumn(
    goal,
    todos,
    statusScroll,
    contentTopH,
    statusColWidth,
    state.themeId,
  );
  // 边框构图参数：分隔竖线列 = historyWidth（历史区右缘/状态列左缘，
  // 为旧 statusColWidth-1 的镜像）；col0 左缘框格属历史/活动区，
  // 右缘框列 R 属状态列。顶部边框行占 index 0，活动区分隔行自然位于 dialogueH 后一行。
  const statusBodyW = Math.max(
    0,
    statusColWidth - 1 - (useRightFrame ? FRAME_RIGHT_COLS : 0),
  );
  const panel = state.focusedPanel;
  const statusFocused = focusActive && panel === "status";
  const topHistory = focusActive && panel === "history";
  const activityFocused = focusActive && panel === "activity";
  const fc = focusFrameColor(state.themeId);
  const cf = (s: string): string => colorFor(state.themeId, fc)(s);
  const cg = (s: string): string => colorFor(state.themeId, "gray")(s);
  const blank = (n: number): string => " ".repeat(Math.max(0, n));
  // 活动区分隔线：焦点为历史/流输出时亮色框，状态焦点/模态回灰
  const sepFocused = topHistory || activityFocused;
  const sepStr = (): string =>
    colorFor(
      state.themeId,
      sepFocused ? fc : "gray",
    )(ACTIVITY_SEPARATOR.repeat(Math.max(1, contentW)));
  const rows: RenderLine[] = [];
  // 右侧边框列保留格（状态列右缘）：画成框线（┐/│/╝）时亮色着色，否则空白占位
  const rightGlyph = (g: string): string => (g === " " ? " " : cf(g));
  // 顶部边框行（row 0）：history 焦点 → 左侧 `┌`+`─`+分隔列角 `┐`（历史/活动区顶边）；
  // status 焦点 → 分隔列 `┌`+`─`+`┐`（状态列顶边，状态列在右）；其余空白占位、分隔列灰 `│`
  const historyTop = useLeftFrame && topHistory;
  rows.push({
    text:
      (historyTop ? cf("┌") : useLeftFrame ? " " : "") +
      (topHistory ? cf(SEPARATOR.repeat(contentW)) : blank(contentW)) +
      (topHistory ? cf("┐") : statusFocused ? cf("┌") : cg("│")) +
      (statusFocused ? cf(SEPARATOR.repeat(statusBodyW)) : blank(statusBodyW)) +
      (useRightFrame ? rightGlyph(statusFocused ? "┐" : " ") : ""),
  });
  // 内容行（1..contentTopH）：对话区 → 活动区分隔 → 活动区。
  // 中间分隔竖线（历史区右缘/状态列左缘）随焦点面板只亮其垂直边界：
  // status=全行、history=仅对话区、activity=仅分隔行+活动区；模态态全灰。
  const actMaxOffset = Math.max(0, activity.length - activityH);
  const actOffset = Math.min(state.activityScroll, actMaxOffset);
  const act = activity.slice(
    actMaxOffset - actOffset,
    actMaxOffset - actOffset + activityH,
  );
  const topPad = activityH - act.length;
  const divFor = (rc: number): string => {
    // 活动区分隔行两端为面板角字：history=右下角 ┘、activity=右上角 ┐、status=竖线
    if (rc === dialogueH && activityH > 0) {
      const g = panel === "history" ? "┘" : panel === "activity" ? "┐" : "│";
      return colorFor(state.themeId, focusActive ? fc : "gray")(g);
    }
    let bright = focusActive;
    if (focusActive && panel === "history") bright = rc < dialogueH;
    else if (focusActive && panel === "activity") bright = rc >= dialogueH;
    return colorFor(state.themeId, bright ? fc : "gray")("│");
  };
  for (let rc = 0; rc < contentTopH; rc++) {
    // col0：历史/活动区左缘框格——history 焦点亮对话区行+分隔行左下角 `┘`；
    // activity 焦点亮活动区行+分隔行左上角 `┌`；status 焦点空白占位（状态列在右）
    let left = "";
    if (useLeftFrame) {
      if (rc === dialogueH && activityH > 0) {
        left =
          panel === "history"
            ? topHistory
              ? cf("┘")
              : " "
            : panel === "activity"
              ? activityFocused
                ? cf("┌")
                : " "
              : " ";
      } else if (rc < dialogueH) {
        left = topHistory ? cf("│") : " ";
      } else {
        left = activityFocused ? cf("│") : " ";
      }
    }
    // 状态列正文（右侧）：剥去 renderStatusColumn 自带右缘竖线，正文截到 statusBodyW 定宽，
    // 保证右缘框列恒位于 R 列、不紧贴文字末尾
    const rawBody = truncateToWidth(
      statusCells[rc]?.slice(0, -1) ?? "",
      statusBodyW,
    );
    const statusBody = cg(rawBody + blank(statusBodyW - displayWidth(rawBody)));
    let content: string;
    if (rc < dialogueH) {
      // 对话区行：followBottom / scrollOffset 只作用于对话区
      const w = dialogueRows[vp.start + rc];
      content =
        w && vp.start + rc < vp.end ? " ".repeat(w.indent) + w.text : "";
    } else if (rc === dialogueH && activityH > 0) {
      // 活动区分隔行（对话历史 ↔ 流输出边界），两端角字由 col0/divFor 构图
      content = sepStr();
    } else if (activityH > 0) {
      // 活动区行：按滚动偏移取窗口（0=跟随最新显示尾部；上滚看更早）
      const a = rc - dialogueH - 1 - topPad;
      content = a >= 0 ? " ".repeat(act[a]!.indent) + act[a]!.text : "";
    } else {
      content = "";
    }
    // 历史/活动区正文补齐到 contentW：分隔竖线恒位于 D 列（不紧贴文字末尾）
    content += blank(Math.max(0, contentW - displayWidth(content)));
    // 右缘框列（状态列右缘）：status 焦点亮；其余空白占位
    const right = statusFocused ? "│" : " ";
    rows.push({
      text:
        left +
        content +
        divFor(rc) +
        statusBody +
        (useRightFrame ? rightGlyph(right) : ""),
    });
  }
  return rows;
}

export const USER_MIN_LEFT_GUTTER = 4;
export const THINKING_INDENT = 2;
export const THINKING_MORE = "...(更多思考已折叠)";
/** 工具调用历史：仅展示最近 TOOL_MAX_GROUPS 个调用组，更早隐藏（折叠标记） */
export const TOOL_MAX_GROUPS = 4;
export const TOOL_MORE = "...(更早工具调用已隐藏)";
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
      if (l.text.startsWith("○") && groups[groups.length - 1]!.length > 0)
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
    // separator / plain → 对话区（turn 分隔线：先按纯文本换行，再逐行着灰，
    // 避免 ANSI 转义进入 wrapLine 被按显示宽度误计）
    const content =
      line.kind === "separator"
        ? SEPARATOR.repeat(Math.max(1, width))
        : line.text;
    const rows = content === "" ? [""] : wrapLine(content, Math.max(1, width));
    for (const text of rows)
      dialogue.push({
        text:
          line.kind === "separator" ? colorFor(themeId, "gray")(text) : text,
        kind: line.kind,
        indent: 0,
      });
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

/** provider 紫，模型名青，:后缀 灰色；无 "/" 时整体青（占位 "—" 保持无色）。
 *  状态栏段配色约定：相邻段不同色、不用红/黄/绿状态色、不用亮色系（bright*）。 */
function colorModel(themeId: ThemeId, s: string): string {
  const slash = s.indexOf("/");
  if (slash < 0) return s === "—" ? s : colorFor(themeId, "cyan")(s);
  const rest = s.slice(slash + 1);
  const colon = rest.indexOf(":");
  const model = colon < 0 ? rest : rest.slice(0, colon);
  const effort = colon < 0 ? "" : rest.slice(colon);
  return (
    colorFor(themeId, "magenta")(s.slice(0, slash)) +
    colorFor(themeId, "cyan")("/" + model) +
    (effort ? colorFor(themeId, "gray")(effort) : "")
  );
}
/** notice/tool 行 tone → 着色名（error 红 / warn 黄 / muted 灰） */
const NOTICE_TONE_COLOR: Record<NoticeTone, ColorName> = {
  error: "red",
  warn: "yellow",
  muted: "gray",
};

/** 工具行前缀着色：○ 前缀黄（运行中）、工具名黄；✓ 前缀绿；✗/续行原样（✗ 由 tone 整体着红） */
function renderToolText(text: string, themeId: ThemeId): string {
  if (text.startsWith("○ ")) {
    const rest = text.slice(2);
    const sp = rest.indexOf(" ");
    const name = sp < 0 ? rest : rest.slice(0, sp);
    const summary = sp < 0 ? "" : rest.slice(sp); // 含前导空格
    return (
      colorFor(themeId, "yellow")("○") +
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
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  return truncateToWidth(s, w - 1) + "…";
}

/** 路径段按预算截断：保留末尾 + 省略号（路径尾部更有辨识度） */
function fitTail(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
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
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
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
  /** P2 B1+B2 + C：当前活跃会话的 goal/todo/mode/policy（状态栏 goal 徽标 + todo 计数 +
   *  模式徽标三合一 + 审批策略徽标；缺省不显示） */
  session?: {
    goal?: GoalState;
    todos?: TodoItemLike[];
    mode?: ModeState;
    policy?: "ask" | "never";
    /** P3：当前会话 agent 预设 + 运行中任务计数（状态栏短徽标；无值省略） */
    preset?: string;
    jobsCount?: number;
  },
): RenderLine[] {
  const u = usage ? usageStatus(usage) : undefined;
  const ctxSeg = u?.ctx ?? status.contextLen;
  const cacheSeg = u?.cache ?? status.cacheHit;
  // 思考状态并入 model 段（同一段）：provider/model:{后缀}
  // 后缀=on/off/none 或实际等级名（多等级开启如 high/low/max）
  const modelBase = status.model.replace(/:[^:]*$/, "");
  const thinkOn = status.model !== modelBase;
  // modelThinking 显式后缀；缺失时按字符串回退（有 :effort=on，其余 none）
  const thinkState = status.modelThinking ?? (thinkOn ? "on" : "none");
  const modelSeg = `${modelBase}:${thinkState}`;

  // 状态栏按类分组（组间 `|` 分隔、组内 `·` 分隔），行数动态尽量少：
  //   环境组：time · git · cwd            （本机/工作区信息，与会话无关）
  //   会话组：标题                        （当前会话身份）
  //   LLM 组：model:{后缀} · ctx · cache  （最近一次模型调用指标）
  // 宽度足够 → 单行完整显示；放不下 → 按组折行（标题与模型各自成组、组间可折行），单组超宽才组内截断。
  const maxSegW = Math.max(1, cols - 2); // 留首尾各 1 列
  const withTitle = cols >= 24;
  // 默认标题为空（新会话），用 <title> 占位保持段与布局稳定
  const titleText = title.trim() === "" ? "<title>" : title;
  const blue = (s: string) => colorFor(themeId, "blue")(s);
  const cyanTitle = (s: string) => colorFor(themeId, "cyan")(s);
  type Seg = { text: string; color: (s: string) => string };
  const groupWidth = (g: Seg[]): number =>
    g.reduce((acc, s, i) => acc + (i > 0 ? 1 : 0) + displayWidth(s.text), 0);
  // 各组完整版
  // 段配色：time 默认 / git 洋红 / cwd 蓝 / title 青 / provider 紫 / model 青
  //          / 后缀 灰 / ctx 蓝 / cache 默认；会话徽标 mode=灰 / policy=蓝 / preset=洋红 / jobs=青——
  //          相邻段均异色，不用红/黄/绿状态色、不用亮色系
  const magenta = (s: string) => colorFor(themeId, "magenta")(s);
  const gray = (s: string) => colorFor(themeId, "gray")(s);
  // P2 B2：模式徽标三合一（plan→sandbox→permission 固定顺序，组内 · 分隔）。
  // 省略规则（DESIGN:369）：plan 仅 active 显示；sandbox 等于部署默认（workspace-write→wr）省略；
  // permission 缩略与 sandbox 相同省略；三者皆省略整槽消失。窄屏随 session 组级折行。
  const MODE_SHORT: Record<string, string> = {
    "read-only": "ro",
    "workspace-write": "wr",
    "danger-full-access": "full",
  };
  const modeBadge = (m: ModeState | undefined): Seg[] => {
    if (!m) return [];
    const parts: string[] = [];
    if (m.plan === "on") parts.push("plan");
    const sandbox =
      m.sandbox === undefined
        ? undefined
        : (MODE_SHORT[m.sandbox] ?? m.sandbox);
    if (sandbox !== undefined && sandbox !== "wr") parts.push(sandbox);
    const permission =
      m.permission === undefined
        ? undefined
        : (MODE_SHORT[m.permission] ?? m.permission);
    if (permission !== undefined && permission !== sandbox)
      parts.push(permission);
    return parts.length === 0 ? [] : [{ text: parts.join("·"), color: gray }];
  };
  /** 会话状态徽标：goal/todo 已于 2026-09-17 移除（右侧顶部状态列已详显 goal 阶段与
   *  todo 列表，见 statusColumnBody）；此处仅保留无其它展示位的模式/策略/预设/任务徽标 */
  const taskBadges = (): Seg[] => {
    const out: Seg[] = [];
    out.push(...modeBadge(session?.mode));
    // C 阶段：当前审批策略（approval/policy 事件 latest-wins；无该会话事件省略）。
    // ask 直接示 `ask`，never 示 `auto`（两态语义自明、与模式徽标区分）
    if (session?.policy) {
      out.push({
        text: session.policy === "never" ? "auto" : "ask",
        color: blue,
      });
    }
    // P3：agent 预设 + 运行中任务计数（短徽标；无值省略）
    if (session?.preset && session.preset !== "") {
      out.push({ text: "preset:" + session.preset, color: magenta });
    }
    if (session?.jobsCount && session.jobsCount > 0) {
      out.push({ text: "jobs " + session.jobsCount, color: cyanTitle });
    }
    return out;
  };
  const envFull: Seg[] = [
    { text: status.time, color: identity },
    { text: status.git, color: magenta },
    { text: status.cwd, color: blue },
  ];
  const sessionFull: Seg[] = withTitle
    ? [{ text: titleText, color: cyanTitle }, ...taskBadges()]
    : taskBadges();
  const llmFull: Seg[] = [
    { text: modelSeg, color: (s) => colorModel(themeId, s) },
    { text: ctxSeg, color: blue },
    { text: cacheSeg, color: identity },
  ];
  // 各组超宽兜底（单组放不满一行时组内压缩）
  const envFit = (w: number): Seg[] => {
    const gitS = fitHead(status.git, 12);
    const budget = Math.max(
      1,
      w - displayWidth(status.time) - displayWidth(gitS) - 2 - 1,
    );
    return [
      { text: status.time, color: identity },
      { text: gitS, color: magenta },
      { text: fitTail(status.cwd, budget), color: blue },
    ];
  };
  const sessionFit = (w: number): Seg[] => {
    // 组内压缩仅压标题（goal/todo/模式徽标短且新，优先保留）；宽度不足时整组走折行
    const badges = taskBadges();
    const bw =
      badges.reduce(
        (acc, s, i) => acc + (i > 0 ? 1 : 0) + displayWidth(s.text),
        0,
      ) + (badges.length > 0 ? 1 : 0); // 标题与徽标间的 ·
    const tw = Math.max(0, w - bw);
    return [
      ...(withTitle
        ? [{ text: fitHead(titleText, Math.max(0, tw)), color: cyanTitle }]
        : []),
      ...badges,
    ];
  };
  const llmFit = (w: number): Seg[] => {
    const budget = Math.max(
      1,
      w - displayWidth(ctxSeg) - displayWidth(cacheSeg) - 2 - 1,
    );
    return [
      {
        text: fitModel(modelSeg, budget),
        color: (s) => colorModel(themeId, s),
      },
      { text: ctxSeg, color: blue },
      { text: cacheSeg, color: identity },
    ];
  };
  const groups: Array<{
    full: Seg[];
    fit: (w: number) => Seg[];
  }> = [
    { full: envFull, fit: envFit },
    ...(sessionFull.length > 0 ? [{ full: sessionFull, fit: sessionFit }] : []),
    { full: llmFull, fit: llmFit },
  ];

  const renderRow = (row: Seg[][]): RenderLine => ({
    text:
      " " +
      row.map((g) => g.map((s) => s.color(s.text)).join("·")).join("|") +
      " ",
  });

  // 单行完整（宽度足够）→ 各段完整、无省略号
  const fullW = groups.reduce(
    (acc, g, gi) => acc + (gi > 0 ? 1 : 0) + groupWidth(g.full),
    0,
  );
  if (fullW <= maxSegW) return [renderRow(groups.map((g) => g.full))];

  // 折行（尽量少行）：以组为单位依次放入，放不下整组换行。
  // 标题=会话组、模型=LLM 组首段，二者是不同组（组间 `|`），自然允许在它们之间折行。
  // 单组超行宽时才组内压缩（cwd 保尾 / model 保后缀）。
  const lines: Seg[][][] = [[]];
  let used = 0;
  for (const g of groups) {
    let segs = g.full;
    if (groupWidth(segs) > maxSegW) segs = g.fit(maxSegW);
    const gap = used > 0 ? 1 : 0;
    if (used > 0 && used + gap + groupWidth(segs) > maxSegW) {
      lines.push([]);
      used = 0;
    }
    const row = lines[lines.length - 1]!;
    row.push(segs);
    used += (used > 0 ? 1 : 0) + groupWidth(segs);
  }
  return lines.map(renderRow);
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

/** 当前活跃会话的目标/todo/模式/策略/预设/运行中任务数（状态栏与整页高度共用口径） */
function activeSessionFields(state: AppState): {
  goal?: GoalState;
  todos?: TodoItemLike[];
  mode?: ModeState;
  policy?: "ask" | "never";
  preset?: string;
  jobsCount: number;
} {
  const goal = state.activeSessionId
    ? state.goalBySession[state.activeSessionId]
    : undefined;
  const todos = state.activeSessionId
    ? state.todoBySession[state.activeSessionId]
    : undefined;
  const mode = state.activeSessionId
    ? state.modeBySession[state.activeSessionId]
    : undefined;
  // C 阶段：当前活跃会话审批策略（approval/policy 事件 latest-wins；无=undefined 省略徽标）
  const policy = state.activeSessionId
    ? state.policyBySession[state.activeSessionId]
    : undefined;
  // P3：当前活跃会话 agent 预设 + 运行中任务计数（状态栏短徽标）
  const preset = state.activeSessionId
    ? state.presetBySession[state.activeSessionId]
    : undefined;
  const jobsCount = state.jobs.filter(
    (j) => j.status === "running" || j.status === "stopping",
  ).length;
  return { goal, todos, mode, policy, preset, jobsCount };
}

/** 普通输入态（无模态面板）顶部三面板可视行高；PgUp/PgDn 整页滚动页大小 */
export function inputPanelHeights(state: AppState, size: Size): PanelHeights {
  const fullWidth = Math.max(1, size.cols);
  const { goal, todos, mode, policy, preset, jobsCount } =
    activeSessionFields(state);
  const statusLines = renderStatusLine(
    state.systemStatus,
    state.sessionTitle,
    state.themeId,
    fullWidth,
    state.usage,
    { goal, todos, mode, policy, preset, jobsCount },
  );
  const topHeight = metricsFor(size, false, statusLines.length, 1).topHeight;
  const contentTopH = Math.max(0, topHeight - FRAME_TOP_ROWS);
  const activityH = activityHeight(contentTopH);
  const dialogueH = Math.max(
    0,
    contentTopH - activityH - (activityH > 0 ? 1 : 0),
  );
  return { topHeight: contentTopH, activityH, dialogueH };
}

/** 状态栏上方分隔行（焦点四边框的底边）：按焦点面板分段着色 + 角字（╚/╩/╝）；
 * 无焦点/模态态全灰 `─═`。左侧历史/活动区底边（activity 焦点亮、col0 左下角 ╚），
 * 右侧状态列底边（status 焦点亮、R 列右下角 ╝），D 列 ╩ 为共用角。 */
export function buildStatusSeparator(
  cols: number,
  statusColWidth: number,
  themeId: ThemeId,
  sepFocus: "none" | "status" | "activity",
): RenderLine {
  const D = cols - statusColWidth; // 分隔竖线列（历史区右缘/状态列左缘，旧 statusColWidth-1 的镜像）
  const R = cols - 1;
  const useLeftCorner = cols - statusColWidth >= 2; // 历史/活动区左缘框格存在
  const useRightFrame = statusColWidth >= 2; // 状态列右缘框列存在
  const fc = focusFrameColor(themeId);
  const seg = (n: number, ch: string, bright: boolean): string => {
    if (n <= 0) return "";
    const s = ch.repeat(n);
    return bright ? colorFor(themeId, fc)(s) : colorFor(themeId, "gray")(s);
  };
  const leftW = Math.max(0, D - (useLeftCorner ? 1 : 0));
  const rightW = Math.max(0, R - D - 1);
  return {
    text:
      // col0：activity 焦点时为历史/活动区底角 ╚（接左缘框格），否则延续 `═`
      (D > 0
        ? useLeftCorner && sepFocus === "activity"
          ? colorFor(themeId, fc)("╚")
          : colorFor(themeId, "gray")(STATUS_TOP_SEPARATOR)
        : "") +
      seg(leftW, STATUS_TOP_SEPARATOR, sepFocus === "activity") +
      (sepFocus === "none"
        ? colorFor(themeId, "gray")(ACTIVITY_SEPARATOR) // D 列无焦点时延续活动区虚线
        : colorFor(themeId, fc)("╩")) +
      seg(rightW, STATUS_TOP_SEPARATOR, sepFocus === "status") +
      // R 列（状态列右缘框列）：status 焦点右下角 ╝；无右缘框列（statusColWidth=1）时不输出
      (useRightFrame
        ? sepFocus === "status"
          ? colorFor(themeId, fc)("╝")
          : colorFor(themeId, "gray")(STATUS_TOP_SEPARATOR)
        : ""),
  };
}

export function buildFrame(state: AppState, size: Size): RenderLine[] {
  const approval = state.approval;
  const showApproval = approval !== null;
  const picker = state.picker;
  const question = state.question;
  const history = state.history;
  const goalPanel = state.goalPanel;
  const jobsPanel = state.jobsPanel;
  // 状态栏徽标 / 顶部面板只读当前活跃会话字段
  const { goal, todos, mode, policy, preset, jobsCount } =
    activeSessionFields(state);
  const fullWidth = Math.max(1, size.cols);
  // 状态区先算出行数，再让 metrics 以便压缩顶部区域（多行状态栏不溢出帧）
  // 按键提示区仅输入态存在（审批/问答/选择/历史面板自带按键提示），与输入区之间不画横线
  const normalInput =
    !showApproval &&
    !question &&
    !picker &&
    !history &&
    !goalPanel &&
    !jobsPanel;
  const statusLines = renderStatusLine(
    state.systemStatus,
    state.sessionTitle,
    state.themeId,
    fullWidth,
    state.usage,
    { goal, todos, mode, policy, preset, jobsCount },
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
    metrics.statusColWidth,
    metrics.historyWidth,
    normalInput,
    goal,
    todos,
    state.statusColumnScroll,
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
  } else if (goalPanel) {
    footerLines = renderGoalPanel({
      goal,
      todos,
      scroll: goalPanel.scroll,
      height: metrics.footerHeight,
      width: fullWidth,
      themeId: state.themeId,
    });
  } else if (jobsPanel) {
    footerLines = renderJobsPanel({
      jobs: state.jobs,
      index: jobsPanel.index,
      height: metrics.footerHeight,
      width: fullWidth,
      themeId: state.themeId,
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
      "Type a message...",
      fullWidth,
      prompt,
      undefined,
      metrics.footerHeight,
    );
  }

  // 按键提示区（独立区域，与输入区之间不画横线；统一灰色同边框；窄终端按显示宽度截断）。
  // 末尾追加当前面板焦点标签（Tab 切换），标识可滚动的选中面板
  const hintLines: RenderLine[] = normalInput
    ? [
        {
          text: colorFor(
            state.themeId,
            "gray",
          )(
            truncateToWidth(
              HINT_LINE + ` · [面板:${PANEL_LABEL[state.focusedPanel]}]`,
              fullWidth,
            ),
          ),
        },
      ]
    : [];

  // 分隔行（边框统一灰色：先纯文本截断再着色）。状态栏上方用 `═` 强分隔，
  // 下方沿用 `─`；焦点在底部为流输出/状态列时 `═` 用亮色框（钩到面板底边）。
  const makeSep = (ch: string, color: ColorName = "gray"): RenderLine => ({
    text: colorFor(
      state.themeId,
      color,
    )(truncateToWidth(ch.repeat(fullWidth), fullWidth)),
  });
  const statusSepFocus: "none" | "status" | "activity" = normalInput
    ? state.focusedPanel === "status"
      ? "status"
      : state.focusedPanel === "activity"
        ? "activity"
        : "none"
    : "none";
  return [
    ...topRegion,
    buildStatusSeparator(
      fullWidth,
      metrics.statusColWidth,
      state.themeId,
      statusSepFocus,
    ),
    ...statusLines,
    makeSep(SEPARATOR),
    ...footerLines,
    ...hintLines,
  ];
}
