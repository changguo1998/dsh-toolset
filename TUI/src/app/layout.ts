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

import type { FrameRow, FrameSegment } from "../renderer/index.ts";
import type { Size } from "../renderer/index.ts";
import type {
  AppState,
  InputMode,
  InputStatus,
  GoalState,
  ModeState,
} from "./state.ts";
import { currentProjectCwd, historyVisibleRecords } from "./state.ts";
import type { ActivityPlacement } from "./config.ts";

import type { Buffer } from "./state.ts";
import type { JobInfo, TodoItemLike } from "./adapter/dsh.ts";
import { renderTextInput } from "./components/TextInput.ts";
import { buildModelPickerBox } from "./components/ModelPicker.ts";
import { buildHistoryPanelBox } from "./components/HistoryPanel.ts";
import { buildQuestionPanelBox } from "./components/QuestionPrompt.ts";
import { buildJobsPanelBox, statusMark } from "./components/JobsPanel.ts";
import { buildCommandListPanelBox } from "./components/CommandListPanel.ts";
import { buildStatusPanelBox } from "./components/StatusPanel.ts";
import { buildCommandCompletionBox } from "./components/CommandCompletion.ts";
import type { ColorName, ThemeId } from "../renderer/theme.ts";
import { buildApprovalBox } from "./components/ApprovalPrompt.ts";
import { buildContentRows } from "./layout/build-box.ts";
import { measure } from "./layout/measure.ts";
import { allocate } from "./layout/measure.ts";
import { fillToList } from "./layout/fill.ts";
import { focusFrame, focusColor } from "./layout/focus-frame.ts";
import type { PaneId, Rect } from "./layout/box.ts";
import type { ContentRow } from "./layout/fill.ts";
import { charWidth, displayWidth } from "./layout/markdown.ts";
import {
  ACTIVITY_SEPARATOR,
  NOTICE_TONE_COLOR,
  SEPARATOR,
  STATUS_TOP_SEPARATOR,
} from "./layout/content-rules.ts";
export {
  SEPARATOR,
  STATUS_TOP_SEPARATOR,
  TURN_SEPARATOR_CHAR,
  assistantMaxBodyWidth,
  TOOL_CONT_INDENT,
  USER_MIN_LEFT_GUTTER,
  userMaxBodyWidth,
  wrapToolCallText,
} from "./layout/content-rules.ts";
export {
  charWidth,
  displayWidth,
  parseInlineMarkdown,
  wrapInlineMarkdown,
} from "./layout/markdown.ts";
export {
  rowWidth2,
  seg,
  truncateSegs,
  truncateToWidth,
  wrapLine,
  wrapLines,
} from "./layout/primitives.ts";
export { helpTableLines } from "./layout/help.ts";

/** 行纯文本 = 各段 text 拼接（剥离样式；测试/宽度计算用） */
export function rowText(row: FrameRow): string {
  return row.segments.map((s) => s.text).join("");
}

import {
  rowWidth2,
  seg,
  truncateSegs,
  truncateToWidth,
  wrapLine,
} from "./layout/primitives.ts";

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

// ---------- 语义锚点（视口位置的可重建坐标） ----------

/**
 * 视口顶行的语义锚点：来源 buffer 行的**稳定序号** `seq` + 行内换行序号 `row`（0 基）。
 * `seq = DIALOGUE_MARKER_SEQ` 表示窗口顶部的「更早回复已折叠」占位行。
 *
 * 为什么不用「距底部多少行」或「行下标」：底部新增/流式增长会改变同一偏移所指的
 * 内容（视图被顶走）、resize 重排会让行数变化、渐进窗口向上扩窗会插入行、**回合
 * 切换会清掉瞬态活动行使行下标整体平移**——只有内容身份（稳定行序号 + 行内换行
 * 序号）在所有这几种情况下都指向同一行。
 */
export interface DialogueAnchor {
  seq: number;
  row: number;
}

/** 折叠占位行的锚点序号（不属于任何 buffer 行） */
export const DIALOGUE_MARKER_SEQ = -1;

/** 对话行按来源 buffer 行分组（行序不变，同一行的换行行相邻） */
export interface DialogueSpan {
  seq: number;
  rows: number;
}

/** 对话区滚动几何（帧回填；App 借它把「行位移」换算成锚点、判断是否该扩窗） */
export interface DialogueGeometry {
  /** 物化行数（含折叠占位行） */
  rows: number;
  /** 可视行数 */
  height: number;
  /** 行分组表（offset ↔ anchor 互算、跨组位移） */
  spans: DialogueSpan[];
  /** 本帧视口顶行的绝对行号（0 = 物化窗口首行） */
  topIdx: number;
}

/**
 * 行数组 → 分组表（按 ContentRow.seq 分组）。
 * 行没有稳定序号时（直接构造的 buffer，如单测）回退用行下标：同一份行数组内
 * 口径一致，锚点仍可互算；真实链路 buffer 行恒带序号（见 state.append*）。
 */
export function dialogueSpans(rows: readonly ContentRow[]): DialogueSpan[] {
  const out: DialogueSpan[] = [];
  for (const r of rows) {
    const seq = r.seq ?? r.line ?? DIALOGUE_MARKER_SEQ;
    const last = out[out.length - 1];
    if (last && last.seq === seq) last.rows += 1;
    else out.push({ seq, rows: 1 });
  }
  return out;
}

/** 分组表总行数 */
export function spanRows(spans: readonly DialogueSpan[]): number {
  let n = 0;
  for (const s of spans) n += s.rows;
  return n;
}

/**
 * 锚点 → 物化行数组内的绝对行号（0 基）。
 * 锚点所在行不在表内（该行已被清掉/裁掉，或落在窗口外）时收敛到**空间上最近的
 * 前一行**：序号单调递增，故「比某 span 小」即空间在前（占位行 -1 恒视为窗口顶部）。
 */
export function anchorToIndex(
  spans: readonly DialogueSpan[],
  anchor: DialogueAnchor,
): number {
  let idx = 0;
  let prev = -1; // 最近的「空间在前」span 起点
  for (const s of spans) {
    if (s.seq === anchor.seq) return idx + Math.min(anchor.row, s.rows - 1);
    if (s.seq > anchor.seq) return prev >= 0 ? prev : 0;
    prev = idx;
    idx += s.rows;
  }
  // 晚于窗口内所有行 → 末行（调用方按可视上限 clamp）
  return idx;
}

/** 绝对行号 → 锚点（越界收敛到首/末行） */
export function indexToAnchor(
  spans: readonly DialogueSpan[],
  idx: number,
): DialogueAnchor {
  if (spans.length === 0) return { seq: DIALOGUE_MARKER_SEQ, row: 0 };
  let rest = Math.max(0, idx);
  for (const s of spans) {
    if (rest < s.rows) return { seq: s.seq, row: rest };
    rest -= s.rows;
  }
  const last = spans[spans.length - 1]!;
  return { seq: last.seq, row: last.rows - 1 };
}

/** 锚点 → 「距底部行数」（0 = 已到窗口末行；供状态缓存与既有调用口径使用） */
export function anchorToOffset(
  spans: readonly DialogueSpan[],
  anchor: DialogueAnchor | null,
  height: number,
): number {
  if (anchor === null) return 0;
  const rows = spanRows(spans);
  const top = anchorToIndex(spans, anchor);
  return Math.max(0, rows - height - Math.min(top, Math.max(0, rows - height)));
}

/**
 * 行位移 → 新锚点（纯函数；App 按键经它换算后再写回 state）。
 * delta > 0 = 上滚（视口下移方向相反；与旧「scrollOffset += delta」同向）。
 * 结果顶到窗口末行 → 返回 null（跟随底部，等价于旧 offset = 0）。
 */
export function moveDialogueAnchor(
  anchor: DialogueAnchor | null,
  delta: number,
  geom: DialogueGeometry,
): DialogueAnchor | null {
  const maxTop = Math.max(0, geom.rows - geom.height);
  const cur = anchor === null ? maxTop : anchorToIndex(geom.spans, anchor);
  const next = Math.min(Math.max(0, cur - delta), maxTop);
  if (next >= maxTop) return null; // 回到跟随底部
  return indexToAnchor(geom.spans, next);
}

// ---------- 帧组装 ----------

/** 上/中/下三区之间的横线分隔行数 */
export const SEPARATOR_ROWS = 2;

/** 按键提示区内容（独立区域，位于输入区下方、之间不画横线；窄终端按显示宽度截断；审批/问答/选择面板自带按键提示，不显示该区） */
export const HINT_LINE =
  "[Alt+Enter]打断并发送 · [Ctrl+L]重绘 · [Ctrl+J]输入换行 · [/help]更多命令";

/** 补全候选打开时的按键提示（替换 HINT_LINE；候选面板本身不再占用活动区行放提示） */
export const COMPLETION_HINT_LINE = "[tab]补全 · [↑/↓]选择 · [esc]收起";

/** 历史会话面板各阶段的按键提示（显示于输入区下方提示区；面板标题行不再内嵌键位）。
 *  list=列表移动/范围切换（当前目录⇄全部）/会话切换/删除/清理/关闭、
 *  view=内容滚动/翻页/返回列表、error=错误关闭；
 *  confirm-*=二次确认（y/n）、进行中阶段（deleting/cleaning）与加载类阶段无可用键位
 *  → 空白提示行保持高度稳定 */
export const HISTORY_LIST_HINT_LINE =
  "[↑/↓]移动 · [Tab]范围 · [Enter]切换 · [d]删除 · [x]清理空会话 · [Esc]关闭";
export const HISTORY_VIEW_HINT_LINE =
  "[↑/↓]滚动 · [PgUp/PgDn]翻页 · [Esc]返回列表";
export const HISTORY_ERROR_HINT_LINE = "[Esc]关闭";
export const HISTORY_CONFIRM_HINT_LINE = "[y/Enter]确认 · [n/Esc]取消";
export const HISTORY_LOADING_HINT_LINE = "";

/** 历史面板阶段 → 提示区文案（未列出的阶段按加载类处理：空白） */
export const HISTORY_HINTS: Record<string, string> = {
  list: HISTORY_LIST_HINT_LINE,
  view: HISTORY_VIEW_HINT_LINE,
  error: HISTORY_ERROR_HINT_LINE,
  "confirm-delete": HISTORY_CONFIRM_HINT_LINE,
  "confirm-clean": HISTORY_CONFIRM_HINT_LINE,
};

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
  /** 布局配置（tui.config.json；缺省某字段 → 原默认公式） */
  layout?: { footerHeight?: number; statusDivisor?: number },
): FrameMetrics {
  // 「交互区」（输入框 3 行 + 按键提示区 1 行）固定为 4 行；
  // 不足时至少 2 行（输入 1 + 提示 1）。面板态（审批/问答/选择）整体占据
  // 交互区（面板自带最底行按键提示、无独立提示区），与输入态同高——
  // 面板开关不改变交互区高度，避免顶部区域上下跳动
  // 输入框固定 3 行(+按键提示 1 行 → 交互区 4 行)；矮终端按 1/5 比例收缩保底每区 ≥1 行
  // 交互区：tui.config.json footerHeight 绝对行数优先；缺省自动 1/5 上限 4
  const interaction =
    layout?.footerHeight ?? Math.min(4, Math.max(2, Math.floor(size.rows / 5)));
  const footerHeight = hasPanel ? interaction : interaction - 1;
  // 状态列：窄列约 1/3（含右侧竖线），**最低 20 列**
  // （内容列宽 = cols/divisor，不足 20 时提到 20），
  // 但仍受「历史区保底 10 列」上限约束（cols < 30 时历史区优先，状态列让位）
  const statusColWidth = Math.min(
    Math.max(20, Math.floor(size.cols / (layout?.statusDivisor ?? 3))),
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

/** 渐进窗口：默认物化最近 DIALOGUE_KEEP_REPLIES 个回合组，上滚接近窗口顶部时按步长扩窗 */
export const DIALOGUE_KEEP_REPLIES = 3;
/** 渐进窗口增窗步长（上滚触发时一次多物化的回合组数） */
export const WINDOW_GROW_STEP = 3;
export const DIALOGUE_MORE = "...(更早回复已折叠)";

/**
 * 回合组切分（渐进窗口的物化单位）：组起点 = 用户消息行，或进入历史区的
 * **final assistant 段首行**（无用户消息前缀的恢复会话/agent 自发回合按回复切分，
 * 保证「最近 N 组回复」在任何 buffer 形态下都能切开——否则永不折叠）。
 * **非 final 的 assistant（思考/工具之间的活动区中间输出）不算组起点**：
 * 否则 agent 持续输出会撑大组数、把历史旧回复挤出物化窗口（历史被活动区“推着滚动”）。
 * 首行不属于任何起点时补一个 0 起点（头部残段自成一组）。
 */
export function turnGroupStarts(
  buffer: readonly { kind: string; final?: boolean }[],
): number[] {
  const starts: number[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer[i]!;
    const kind = line.kind;
    const prev = i > 0 ? buffer[i - 1]!.kind : undefined;
    const userStart = kind === "user" && prev !== "user";
    // 与历史一致：紧邻 user 的答复并入该用户组；无 user 前缀的 final 回复自成一组
    const replyStart =
      kind === "assistant" &&
      line.final === true &&
      prev !== "assistant" &&
      prev !== "user";
    if (userStart || replyStart) starts.push(i);
  }
  if (starts.length === 0 || starts[0]! > 0) starts.unshift(0);
  return starts;
}

/** 渐进窗口切片（尾部 groups 个回合组；groups 至少 1） */
export interface DialogueWindow {
  /** 物化的 buffer 切片（buildBox 输入） */
  lines: Buffer;
  /** 切片在原始 buffer 中的起始行号（0 = 未切） */
  start: number;
  /** 被切掉的更早行数（> 0 → 顶部加「更早回复已折叠」占位行） */
  dropped: number;
  /** buffer 内回合组总数（增窗上限） */
  totalGroups: number;
}

/**
 * 取 buffer 尾部 groups 个回合组作为物化窗口。
 * 只物化窗口内的行是「渐进定位」的一半：布局成本与物化行数成正比，
 * 用户上滚时再逐步向前扩窗（另一半是语义锚点——扩窗会在视口上方插入行，
 * 只有锚点能保证视图不被顶走）。
 */
export function dialogueWindow(buffer: Buffer, groups: number): DialogueWindow {
  const starts = turnGroupStarts(buffer);
  const totalGroups = starts.length;
  const keep = Math.max(1, Math.min(Math.floor(groups), totalGroups));
  const start = starts[totalGroups - keep] ?? 0;
  return {
    lines: start > 0 ? buffer.slice(start) : buffer,
    start,
    dropped: start,
    totalGroups,
  };
}
/** 状态列内 goal/todo/jobs 块间分隔：点更少的虚线（double dash，窗口内部板块分隔保留虚线） */
export const STATUS_BLOCK_SEPARATOR = "╌";

/** 权限/沙箱等级缩写（状态列 Mode 块与旧状态栏徽标共用） */
const MODE_SHORT: Record<string, string> = {
  "read-only": "ro",
  "workspace-write": "wr",
  "danger-full-access": "full",
};

/** 权限等级配色名（红色=高危险 / 黄=可写 / 绿=只读安全）：ro 绿、wr 黄、full 红，其余灰 */
function permColor(code: string): ColorName {
  if (code === "ro") return "green";
  if (code === "wr") return "yellow";
  if (code === "full") return "red";
  return "gray";
}
/** 焦点面板四边框的保留格：左侧 1 列、右侧 1 列（所有状态恒定，未聚焦留空白占位，防内容重排）。
 *  不保留顶部边框行（标题栏即顶部，焦点顶边用标题栏下划线/状态列顶行兼作）。 */
export const FRAME_LEFT_COLS = 1;
export const FRAME_RIGHT_COLS = 1;

/** 左列（历史/活动区）正文宽：historyWidth 扣左缘框格（buildTopRegion 与滚动口径同源） */
export function leftColumnWidth(historyWidth: number): number {
  const useLeftFrame = historyWidth >= FRAME_LEFT_COLS + 1;
  return Math.max(1, historyWidth - (useLeftFrame ? FRAME_LEFT_COLS : 0));
}

/** 左列顶部标题栏行数：标题行 + 实线下划线（置于会话历史区上方；
 *  极矮终端由 topPaneHeights 自适应收缩到 1/0 行） */
export const TITLE_BAR_ROWS = 2;

/** 焦点框色（L4 强调级）：dark=bright[7] 白、light=ansi[0] 黑。
 * re-export focus-frame.focusColor（单一实现，避免焦点色映射双源）。 */
export const focusFrameColor = focusColor;

/**
 * 活动区可视行数（= 顶部区域「内容行数」= topHeight-边框行的一半；
 * 在 buildTopRegion/frameGeometry 中经 topPaneHeights 先扣标题栏行数后应用）
 */
export function activityHeight(contentTopH: number, divisor?: number): number {
  // 活动区高 = contentTopH / divisor（tui.config.json；默认 2 ≈ 原 1/2 比例）
  return contentTopH <= 0
    ? 0
    : Math.max(1, Math.floor(contentTopH / (divisor ?? 2)));
}

/**
 * 活动区分隔行锚定 → 目标行号（0 基，屏幕行）：
 * "half" = 屏幕中线行 floor(rows/2)；number = 绝对行号（非负截断）；未配置 → undefined。
 * 返回 undefined 表示走 activityHeightDivisor 比例分配（锚定未开启）。
 */
export function activityTopRowToLine(
  config: "half" | number | undefined,
  rows: number,
): number | undefined {
  if (config === "half") return Math.max(0, Math.floor(rows / 2));
  if (typeof config === "number" && Number.isFinite(config) && config >= 0) {
    return Math.floor(config);
  }
  return undefined;
}

/** 顶部左列面板行数划分（标题栏 + 对话区 + 活动区；buildTopRegion 与 frameGeometry 同口径） */
export interface TopPaneHeights {
  /** 标题栏行数（标题行 + 实线下划线；极矮终端自适应收缩到 1/0 行） */
  titleRows: number;
  /** 活动区可视行数 */
  activityH: number;
  /** 对话区可视行数 */
  dialogueH: number;
}

/**
 * 顶部左列行数划分：标题栏优先 TITLE_BAR_ROWS=2 行（标题行 + 实线下划线）；
 * 若对话区将不足 1 行（矮终端）则降级为 1 行（仅标题行），仍不足则省略标题栏
 * （0 行）——保证对话区/活动区至少可展开不溢出。
 * 活动区 = 顶部内容行数的一半（不因标题栏收缩），对话区取剩余；标题栏行数由
 * 对话区承担，故活动区高度不随标题栏位置变化。
 *
 * topRow 参数（非 undefined）：活动区分隔行锚定——历史区与活动区之间的分隔行
 * 恰好落在 topRow 行（0 基，屏幕行；"half"/绝对行号经 activityTopRowToLine 换算）。
 * 有剩余空间时 activityH = contentTopH - topRow - 1（对话区止于 topRow）；
 * 剩余不足（contentTopH <= topRow + 1）则活动区 0 行、对话区吃满剩余，
 * 与 divisor 模式共用降级与保底语义。
 */
export function topPaneHeights(
  contentTopH: number,
  divisor?: number,
  topRow?: number,
): TopPaneHeights {
  // 锚定模式：活动区分隔行固定在 topRow；先判剩余能否容纳活动区（>0 才有分隔行）
  if (topRow !== undefined) {
    const activityH = contentTopH - topRow - 1;
    if (activityH > 0) {
      // 有活动区：标题栏降级逻辑同 divisor 模式，对话区止于 topRow（活动区分隔行）
      let titleRows = 0;
      for (const t of [TITLE_BAR_ROWS, 1, 0]) {
        if (t === 0 || topRow - t >= 1) {
          titleRows = t;
          break;
        }
      }
      const dialogueH = Math.max(0, topRow - titleRows);
      return { titleRows, activityH, dialogueH };
    }
    // 无活动区空间：对话区吃满剩余（活动区分隔行不存在）
    let titleRows = 0;
    for (const t of [TITLE_BAR_ROWS, 1, 0]) {
      if (t === 0 || contentTopH - t >= 1) {
        titleRows = t;
        break;
      }
    }
    return {
      titleRows,
      activityH: 0,
      dialogueH: Math.max(0, contentTopH - titleRows),
    };
  }
  const activityH = activityHeight(contentTopH, divisor);
  let titleRows = 0;
  for (const t of [TITLE_BAR_ROWS, 1, 0]) {
    const dialogueH = Math.max(
      0,
      contentTopH - t - activityH - (activityH > 0 ? 1 : 0),
    );
    if (t === 0 || dialogueH >= 1) {
      titleRows = t;
      break;
    }
  }
  const dialogueH = Math.max(
    0,
    contentTopH - titleRows - activityH - (activityH > 0 ? 1 : 0),
  );
  return { titleRows, activityH, dialogueH };
}

/** 黄金分割比 φ：历史区/活动区排列方式的判定基准（分割后各 pane 宽高比尽量贴近 φ） */
export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

/** 左右排列（横向）时单个 pane 的最小列数：低于此宽度退化回上下排列 */
export const MIN_HORIZONTAL_PANE_COLS = 20;

/** 左右排列（横向）时两 pane 的最小行数：顶部区域过矮时退化回上下排列 */
export const MIN_HORIZONTAL_PANE_ROWS = 2;

/** 顶部左列划分结果（含排列方式与两 pane 的宽高；宽度仅横向排列有意义） */
export interface TopPaneSplit {
  /** 排列方式：vertical = 历史区在上/活动区在下；horizontal = 左右并排 */
  mode: "vertical" | "horizontal";
  /** 标题栏行数（两种排列共用；标题栏恒横跨左列全域） */
  titleRows: number;
  /** 对话区可视行数（横向模式下 = 可用行数，两 pane 等高） */
  dialogueH: number;
  /** 活动区可视行数（横向模式下 = dialogueH） */
  activityH: number;
  /** 对话区正文宽（纵向模式 = 左列正文宽；横向模式 = 去掉内部分隔列后的左 pane 宽） */
  dialogueW: number;
  /** 活动区正文宽（纵向模式 = 左列正文宽；横向模式 = 右 pane 宽） */
  activityW: number;
}

/** 标题栏行数：TITLE_BAR_ROWS 起逐级降级（1 行 / 0 行），保证下方至少 minRows 行内容 */
function topTitleRows(contentTopH: number, minRows: number): number {
  for (const t of [TITLE_BAR_ROWS, 1, 0]) {
    if (t === 0 || contentTopH - t >= minRows) return t;
  }
  return 0;
}

/** pane 宽高比与 φ 的对数偏差（高或宽 ≤ 0 视为无此 pane，不参与比较） */
function aspectDeviation(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0;
  return Math.abs(Math.log(w / h / GOLDEN_RATIO));
}

/**
 * 顶部左列划分（排列方式 + 两 pane 宽高），buildTopRegion 与 focusFrame 矩形同源调用
 * （均读 frameGeometry，口径必须一致）。
 *
 * - vertical：沿用 topPaneHeights（activityHeightDivisor 比例或 activityTopRow 锚定），
 *   两 pane 共占左列正文宽。
 * - horizontal：两 pane 左右并排、等高（contentTopH − 标题栏）；活动区宽 =
 *   floor(正文宽 / divisor)（与高度同一「总:目标」语义，缺省 1/2），
 *   对话区取剩余，中间保留 1 列内部分隔竖线。
 * - "auto"：比较两种排列下各 pane 宽高比与 φ 的对数偏差（取较差 pane），
 *   小者胜出。等分时判据等价于「左列正文宽/可用行数 > φ → 左右排列」——
 *   区域比 φ 更扁（宽而矮）时左右排列更接近黄金矩形。
 * - 不可行时（横向 pane 宽不足 MIN_HORIZONTAL_PANE_COLS、或没有可用行）回落 vertical。
 */
export function topPaneSplit(
  contentTopH: number,
  contentW: number,
  divisor?: number,
  topRow?: number,
  placement: ActivityPlacement = "vertical",
): TopPaneSplit {
  const w = Math.max(1, Math.floor(contentW));
  const v = topPaneHeights(contentTopH, divisor, topRow);
  const vertical: TopPaneSplit = {
    mode: "vertical",
    titleRows: v.titleRows,
    dialogueH: v.dialogueH,
    activityH: v.activityH,
    dialogueW: w,
    activityW: w,
  };
  if (placement === "vertical" || contentTopH <= 0) return vertical;
  // 横向尺寸：活动区宽沿用同一 divisor（缺省 1/2），两侧各保底最小宽度
  const titleRows = topTitleRows(contentTopH, 1);
  const availH = Math.max(0, contentTopH - titleRows);
  const maxActW = w - 1 - MIN_HORIZONTAL_PANE_COLS;
  if (availH < MIN_HORIZONTAL_PANE_ROWS || maxActW < MIN_HORIZONTAL_PANE_COLS)
    return vertical;
  const activityW = Math.min(
    Math.max(Math.floor(w / (divisor ?? 2)), MIN_HORIZONTAL_PANE_COLS),
    maxActW,
  );
  const dialogueW = w - activityW - 1;
  const horizontal: TopPaneSplit = {
    mode: "horizontal",
    titleRows,
    dialogueH: availH,
    activityH: availH,
    dialogueW,
    activityW,
  };
  if (placement === "horizontal") return horizontal;
  // auto：宽高比偏离 φ 更小者胜（活动区 0 行时不参与比较）
  const vDev = Math.max(
    aspectDeviation(w, v.dialogueH),
    v.activityH > 0 ? aspectDeviation(w, v.activityH) : 0,
  );
  const hDev = Math.max(
    aspectDeviation(dialogueW, availH),
    aspectDeviation(activityW, availH),
  );
  return hDev < vDev ? horizontal : vertical;
}

/**
 * 单帧排版几何：**唯一尺寸来源**。buildFrame/buildTopRegion/buildStatusSeparator
 * 与 App 的翻页/半屏/跳转（`frameGeometry`）全部读这一份，不再各自重算
 * metricsFor/topPaneSplit/leftColumnWidth——历史上多处各算一次，口径漂移会让
 * 「帧里看到的 pane 高度」与「滚动用的 pane 高度」不一致。
 */
export interface FrameGeometry {
  /** 终端尺寸（帧总行/列） */
  cols: number;
  rows: number;
  /** 顶部区域内容行数（rows − 状态区 − 交互区 − 提示区 − 分隔行；不含任何边框行） */
  contentTopH: number;
  /** 状态区行数 / 交互区行数 / 按键提示区行数（帧底部三段；提示区输入态为 1） */
  statusHeight: number;
  footerHeight: number;
  hintHeight: number;
  /** 顶部状态列宽 / 历史区（左列）宽 */
  statusColWidth: number;
  historyWidth: number;
  /** 左列正文宽（历史区宽 − 左缘框格；两 pane 宽度都从它派生） */
  contentW: number;
  /** 左缘/右缘焦点框保留格是否存在（各 1 列；宽度不足时不留） */
  leftFrame: boolean;
  rightFrame: boolean;
  /** 排列方式（activityPlacement=auto 的判定结果）与标题栏行数 */
  mode: "vertical" | "horizontal";
  titleRows: number;
  /** 活动 pane / 对话 pane 可视行数（横向两 pane 等高） */
  activityH: number;
  dialogueH: number;
  /** 活动 pane / 对话 pane 正文宽（纵向两 pane 同宽） */
  activityW: number;
  dialogueW: number;
  /** 排队块可见行（右对齐用户块，右缘竖线灰色；钉在对话 pane 底部右下角。
   *  内容 = `AppState.queued`：已交给核心 next-turn 队列、本回合尚未认领的消息 */
  queuedRows: ContentRow[];
  /** 历史视口高 = dialogueH − 排队块行数（语义锚点与滚动上限按它算） */
  viewportH: number;
  /** 分隔竖线列（历史区右缘/状态列左缘；= cols − statusColWidth） */
  dividerCol: number;
  /** 横向排列的内部分隔竖线列（活动 pane 右缘/历史 pane 左缘）；纵向 undefined */
  innerDividerCol?: number;
  /** 活动区分隔行行号（纵向 = 实线分隔行；横向 = 对话 pane 底边下一行，该行无分隔线） */
  activitySepRow: number;
  /** 按键提示区是否显示（输入态/历史面板 1 行；模态面板 0 行） */
  showHint: boolean;
  /** 模态面板是否打开（焦点框置空 + footer 空白占位） */
  modalOpen: boolean;
  /** 状态栏行（整屏宽；buildFrame 直接拼接，避免二次计算） */
  statusLines: FrameRow[];
}

/**
 * 排队块行：按对话 pane 宽排版（右对齐用户块 + 灰色右缘竖线）。
 * 每条排队消息各自成块（官方流程逐条入队、逐条认领，**不合并**）；消息内含
 * 显式换行时保留在同一块内（与历史用户行一致：块内行首左对齐、块宽 = 最长行）。
 */
function queuedBlockRows(state: AppState, width: number): ContentRow[] {
  if (state.queued.length === 0) return [];
  const lines: Buffer = state.queued.map((text) => ({
    text,
    kind: "user",
    queued: true,
  }));
  return buildContentRows(
    lines,
    { themeId: state.themeId, gutter: state.messageGutter },
    width,
  ).dialogue;
}

/** 单帧几何（纯函数）：终端尺寸 + state 的布局/模态/排队信息 → FrameGeometry */
export function frameGeometry(state: AppState, size: Size): FrameGeometry {
  const cols = Math.max(1, size.cols);
  // 模态面板：审批/问答/模型选择/状态选项/任务/共享列表 = 自带按键提示且 footer 空白占位；
  // 历史会话面板额外占按键提示区（与输入态同高）
  const modalOpen =
    state.approval !== null ||
    state.question !== null ||
    state.picker !== null ||
    state.statusPanel !== null ||
    state.jobsPanel !== null ||
    state.commandPanel !== null ||
    state.history !== null;
  const normalInput = !modalOpen;
  const showHint = normalInput || state.history !== null;
  const statusLines = renderStatusLine(state.systemStatus, cols, state.usage);
  // 面板态/输入态交互区总高恒定（见 metricsFor）：开关面板不让顶部区域上下跳
  const metrics = metricsFor(
    size,
    !showHint,
    statusLines.length,
    showHint ? 1 : 0,
    state,
  );
  const contentTopH = Math.max(0, metrics.topHeight);
  const contentW = leftColumnWidth(metrics.historyWidth);
  // 排列方式与两 pane 宽高同源于 topPaneSplit（auto 判定只看左列正文宽 + 内容行数）
  const split = topPaneSplit(
    contentTopH,
    contentW,
    state.activityDivisor,
    activityTopRowToLine(state.activityTopRow, size.rows),
    state.activityPlacement,
  );
  const horizontal = split.mode === "horizontal";
  // 排队块钉在对话 pane 底部：至多占 pane 高 − 1 行（至少留 1 行历史可见）；
  // 超出时取尾部（最新排队内容优先可见）
  const queuedAll = queuedBlockRows(state, split.dialogueW);
  const maxQueued = Math.max(0, split.dialogueH - 1);
  const queuedRows =
    queuedAll.length > maxQueued
      ? queuedAll.slice(queuedAll.length - maxQueued)
      : queuedAll;
  return {
    cols,
    rows: size.rows,
    contentTopH,
    statusHeight: metrics.statusHeight,
    footerHeight: metrics.footerHeight,
    hintHeight: metrics.hintHeight,
    statusColWidth: metrics.statusColWidth,
    historyWidth: metrics.historyWidth,
    contentW,
    leftFrame: metrics.historyWidth >= FRAME_LEFT_COLS + 1,
    rightFrame: metrics.statusColWidth >= FRAME_RIGHT_COLS + 1,
    mode: split.mode,
    titleRows: split.titleRows,
    activityH: split.activityH,
    dialogueH: split.dialogueH,
    activityW: split.activityW,
    dialogueW: split.dialogueW,
    queuedRows,
    viewportH: Math.max(0, split.dialogueH - queuedRows.length),
    dividerCol: cols - metrics.statusColWidth,
    // 内部分隔列 = 左缘框格 + 活动 pane 宽（活动区在左；两 pane 等宽时才与对话 pane 同宽）
    innerDividerCol: horizontal
      ? metrics.historyWidth - contentW + split.activityW
      : undefined,
    activitySepRow: split.titleRows + split.dialogueH,
    showHint,
    modalOpen,
    statusLines,
  };
}

/** goal 阶段 → 标题 phase 状态色：active/complete 绿、paused 黄、blocked 红 */
const GOAL_PHASE_COLOR: Record<string, "green" | "yellow" | "red"> = {
  active: "green",
  paused: "yellow",
  blocked: "red",
  complete: "green",
};

const TODO_MARKER: Record<TodoItemLike["status"], string> = {
  pending: "○ ", // 待办：空心圆
  in_progress: "● ", // 进行中：实心圆（黄）
  completed: "✓ ",
};

/** 状态列行（段数组；样式已内联到各段） */
interface StatusRow {
  segments: FrameSegment[];
}

/** 状态列块：head=分隔线/标题等必保行；items=可按优先级折叠的条目（todo/jobs） */
interface StatusBlock {
  id: "mode" | "goal" | "todo" | "jobs";
  head: StatusRow[];
  items: { rows: StatusRow[]; done: boolean; active: boolean }[];
}

/** 状态列折叠等级（全局统一递增尝试）：
 *  L0 不折叠；L1 隐藏已完成条目；L2 仅保留进行中条目（goal 压成标题行）；
 *  L3 进行中条目也压为 1 行。 */
type FoldLevel = 0 | 1 | 2 | 3;

/** 按折叠等级折叠块：goal 无条目概念（L2 起压成标题行「Goal <phase>」）；
 *  todo/jobs 按 done/active 过滤并带隐藏计数提示；mode 恒完整。 */
function foldAt(block: StatusBlock, level: FoldLevel): StatusRow[] {
  if (block.id === "goal" && level >= 2) {
    // head 末行恒为标题（首块无 sep），L2 起只留标题，删除分隔线与 objective
    return [block.head[block.head.length - 1]!];
  }
  if (block.id === "todo" || block.id === "jobs") {
    let kept = block.items;
    let hidden = 0;
    if (level >= 1) {
      const rest = kept.filter((it) => !it.done);
      hidden += kept.length - rest.length;
      kept = rest;
    }
    if (level >= 2) {
      const rest = kept.filter((it) => it.active);
      hidden += kept.length - rest.length;
      kept = rest;
    }
    const rows =
      level >= 3
        ? kept.map((it) => it.rows[0]!)
        : kept.flatMap((it) => it.rows);
    if (hidden > 0) {
      rows.push({
        segments: [seg(`…(+${hidden}项已隐藏)`, { fg: NOTICE_TONE_COLOR.log })],
      });
    }
    return [...block.head, ...rows];
  }
  // mode：无折叠语义，恒完整
  return [...block.head, ...block.items.flatMap((it) => it.rows)];
}

/** 行级兑底截断：超出预算时保留前 budget-1 行、末行换折叠提示（统计被折叠行数） */
function capRows(rows: StatusRow[], budget: number): StatusRow[] {
  if (rows.length <= budget) return rows;
  if (budget <= 0) return [];
  if (budget === 1) return [rows[0]!]; // 仅 1 行：内容优先，折叠标记让位
  const hidden = rows.length - budget;
  const kept = rows.slice(0, budget - 1);
  kept.push({ segments: [seg(`…(+${hidden}行)`)] });
  return kept;
}

/** todo 条目渲染行（首行带标记，续行缩进对齐） */
function todoItemRows(t: TodoItemLike, width: number): StatusRow[] {
  const body = t.content === "" ? "（空项）" : t.content;
  const mark = TODO_MARKER[t.status];
  const rows = wrapLine(body, Math.max(1, width - 2));
  if (t.status === "completed") {
    // 对号（灰，无线）不被删除线覆盖；正文/续行灰+删除线
    return rows.map((r, i) =>
      i === 0
        ? {
            segments: [
              seg(TODO_MARKER.completed, { fg: "gray" }),
              seg(r, { fg: "gray", strike: true }),
            ],
          }
        : {
            segments: [seg(r, { fg: "gray", strike: true })],
          },
    );
  }
  if (t.status === "in_progress") {
    // 换行后颜色不丢失：整项（含续行）同色；所有进行中项均为黄色
    return rows.map((r, i) => ({
      segments: [seg((i === 0 ? mark : "  ") + r, { fg: "yellow" })],
    }));
  }
  return rows.map((r, i) => ({
    segments: [seg((i === 0 ? mark : "  ") + r)],
  }));
}

/** job 条目渲染行（✓ 完成灰+删除线，其余按状态色） */
function jobItemRows(job: JobInfo): StatusRow[] {
  const mark = statusMark(job.status);
  const label = job.label || job.kind || job.id || "（未命名任务）";
  if (mark.symbol === "✓") {
    return [
      {
        segments: [
          seg("✓ ", { fg: "gray" }),
          seg(label, { fg: "gray", strike: true }),
        ],
      },
    ];
  }
  return [{ segments: [seg(mark.symbol + " " + label, { fg: mark.color })] }];
}

/** 状态列 Mode 块：列出会话运行模式/权限/审批策略的所有可选项，生效项着色强调、其余灰。
 *  plan=青（on/off）；sandbox、permission=ro 绿 / wr 黄 / full 红；policy=ask 绿 / auto 红；
 *  preset=洋红（动态值无可枚举，仅显示当前值）。无会话数据时整块省略。 */
/** 段集按显示宽度折行（token=多段数组；放不下强制折行、不截断）。
 *  同行相邻 token 之间插入分隔 sep（如竖线），token A 与 B 之间发生折行时不加
 *  分隔（行尾不残留竖线）。宽度按各段 text 显示宽计。返回 FrameRow[]（纯文本段）。 */
function wrapSegs(
  tokens: readonly FrameSegment[][],
  width: number,
  /** 同行相邻 token 之间的分隔（默认单空格段） */
  sep: FrameSegment = { text: " " },
): FrameRow[] {
  const rows: FrameRow[] = [];
  let row: FrameSegment[] = [];
  let rowW = 0;
  const visW = (segs: FrameSegment[]): number =>
    segs.reduce((acc, s) => acc + displayWidth(s.text), 0);
  // token 超宽时按词级在内部折行（保留各段样式；空格拆分后同词段合并）
  const splitOverflow = (segs: FrameSegment[]): FrameSegment[][] => {
    const words = segs
      .flatMap((s) => s.text.split(" "))
      .filter((w) => w !== "");
    const lines: FrameSegment[][] = [];
    let line: FrameSegment[] = [];
    let lw = 0;
    for (const wd of words) {
      const style = segs.find((s) => s.text.includes(wd))?.style;
      const ww = charWidth(wd[0] ?? "");
      const gap = line.length === 0 ? 0 : 1;
      if (line.length !== 0 && lw + gap + ww > Math.max(1, width)) {
        lines.push(line);
        line = [];
        lw = 0;
      }
      line.push({ text: (line.length === 0 ? "" : " ") + wd, style });
      lw += gap + displayWidth(wd);
    }
    if (line.length > 0) lines.push(line);
    return lines.length > 0 ? lines : [segs];
  };
  const pushToken = (segs: FrameSegment[]): void => {
    const w = visW(segs);
    if (row.length === 0) {
      if (w <= Math.max(1, width)) {
        row = segs;
        rowW = w;
      } else {
        for (const l of splitOverflow(segs)) rows.push({ segments: l });
      }
      return;
    }
    const gap = visW([sep]);
    if (rowW + gap + w <= Math.max(1, width)) {
      row.push(sep, ...segs); // 同行：插入竖线分隔
      rowW += gap + w;
      return;
    }
    // 折行：上一项行尾不带竖线
    rows.push({ segments: row });
    row = [];
    rowW = 0;
    if (w <= Math.max(1, width)) {
      row = segs;
      rowW = w;
    } else {
      for (const l of splitOverflow(segs)) rows.push({ segments: l });
    }
  };
  for (const token of tokens) pushToken(token);
  if (row.length > 0) rows.push({ segments: row });
  return rows;
}

/** 状态列 Mode 块：会话运行模式/权限/审批策略。各项目（plan/sandbox/permission/
 *  policy/preset）以竖线 ` | ` 分隔连续排布（同水平状态栏段间分隔），放不下才折行；
 *  每项目列出全部可选项、生效项着色强调、其余灰。无会话数据时整块省略。 */
function modeBlock(
  mode: ModeState | undefined,
  policy: "ask" | "never" | undefined,
  preset: string | undefined,
  width: number,
  /** 权限预设目录（原始预设键；缺省/空 → 降级标准三档） */
  permissionOptions?: readonly string[],
  /** agent 预设目录（id 列表；缺省/空 → 只显示当前值） */
  presetOptions?: readonly string[],
): StatusRow[] {
  const out: StatusRow[] = [];
  const has =
    mode !== undefined ||
    policy !== undefined ||
    (preset !== undefined && preset !== "");
  if (!has) return out;
  out.push({ segments: [seg("Mode", { fg: "blue" })] });
  // 各项目 token（标签默认前景 + 全部可选项，生效项 act 强调色、未生效值灰）。
  // 项目之间的竖线 ` | ` 由 wrapSegs 在「同行的相邻项目」之间插入（灰色），
  // 折行处不加竖线——属性名恒默认前景、只有未生效的属性值才灰
  const tokens: FrameSegment[][] = [];
  const add = (
    tag: string,
    options: readonly string[],
    current: string | undefined,
    act: (option: string) => ColorName,
  ): void => {
    const segs: FrameSegment[] = [seg(tag + " ")];
    options.forEach((o, i) => {
      // 选项间分隔空格独立无色段（同 BASE join(" ") 语义：空格不在色码内）
      if (i > 0) segs.push(seg(" "));
      segs.push(seg(o, o === current ? { fg: act(o) } : { fg: "gray" }));
    });
    tokens.push(segs);
  };
  if (mode) {
    if (mode.plan) add("plan", ["off", "on"], mode.plan, () => "cyan");
    if (mode.sandbox) {
      // 可选项 = 静态三档；目录（宿主）暂无 sandbox 可选项源，三档外生效值
      // （如 custom）始终补入列表并高亮（洋红），保证「生效值必显示」
      const raw = mode.sandbox;
      const code = MODE_SHORT[raw] ?? raw;
      const opts = ["ro", "wr", "full"].includes(code)
        ? ["ro", "wr", "full"]
        : [...["ro", "wr", "full"], code];
      add("sandbox", opts, code, () =>
        raw in MODE_SHORT ? permColor(code) : "magenta",
      );
    }
    // permission 独立列出全部可选项（不因与 sandbox 相同而省略——用户要求逐项全列）
    if (mode.permission) {
      // 可选项 = 目录（若已同步）?? 标准三档；三档外生效值（如 custom）始终
      // 补入列表并高亮，保证「生效值必显示」
      const base =
        permissionOptions && permissionOptions.length > 0
          ? permissionOptions
          : ["read-only", "workspace-write", "danger-full-access"];
      const raw = mode.permission;
      // 当前生效值始终补入（无论目录是否为空/降级）：能显示出来才谈得上高亮
      const opts = base.includes(raw) ? base : [...base, raw];
      const curDisp = MODE_SHORT[raw] ?? raw;
      // 生效色：名在三档内按危险等级 ro/wr/full；自定义预设（目录外值）用洋红强调
      add(
        "permission",
        opts.map((o) => MODE_SHORT[o] ?? o),
        curDisp,
        () => (raw in MODE_SHORT ? permColor(curDisp) : "magenta"),
      );
    }
  }
  if (policy)
    add("policy", ["ask", "auto"], policy === "never" ? "auto" : "ask", (o) =>
      o === "ask" ? "green" : "red",
    );
  if (preset && preset !== "") {
    // 可选项 = agent 预设目录（若已同步）；否则只显示当前值；目录不含当前值时补入
    const opts =
      presetOptions && presetOptions.length > 0
        ? presetOptions.includes(preset)
          ? presetOptions
          : [...presetOptions, preset]
        : [preset];
    add("preset", opts, preset, () => "magenta");
  }
  // 项目竖线属边框：前景色；未生效值仍 gray
  out.push(
    ...wrapSegs(tokens, width, { text: " | ", style: { fg: "border" } }),
  );
  return out;
}

/** 顶部状态列正文行（未按可视高度裁剪；供滚动窗口取窗） */
/** 状态列各块（完整自然高度，无强制行数上限；是否折叠由 renderStatusColumn 按窗口总高决定） */
function statusBlocks(
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  jobs: JobInfo[] | undefined,
  width: number,
  mode?: ModeState,
  policy?: "ask" | "never",
  preset?: string,
  permissionOptions?: readonly string[],
  presetOptions?: readonly string[],
): StatusBlock[] {
  const blocks: StatusBlock[] = [];
  const sep = (): StatusRow => ({
    // 虚线分隔与字体同色（不染边框蓝）
    segments: [seg(STATUS_BLOCK_SEPARATOR.repeat(width))],
  });
  // Mode 块（水平状态栏迁来）：放在最前，独立于 goal 是否存在
  const modeRows = modeBlock(
    mode,
    policy,
    preset,
    width,
    permissionOptions,
    presetOptions,
  );
  if (modeRows.length > 0)
    blocks.push({ id: "mode", head: modeRows, items: [] });
  // goal 块非必需；todo/jobs 块独立展示（不早退）
  if (goal && goal.status !== "cleared") {
    const g = goal.goal;
    const head: StatusRow[] = [];
    if (blocks.length > 0) head.push(sep());
    head.push({
      segments: [
        seg("Goal ", { fg: "blue" }),
        seg(g.phase, { fg: GOAL_PHASE_COLOR[g.phase] ?? "green" }),
      ],
    });
    const items: StatusBlock["items"] = [
      {
        rows: wrapLine(g.objective || "（空目标）", Math.max(1, width)).map(
          (text) => ({ segments: [seg(text)] }),
        ),
        done: false,
        active: false,
      },
    ];
    // blocked → blockedReason.message 黄 tone
    if (g.phase === "blocked" && g.blockedReason?.message) {
      items.push({
        rows: [
          {
            segments: [
              seg("阻塞: " + g.blockedReason.message, { fg: "yellow" }),
            ],
          },
        ],
        done: false,
        active: false,
      });
    }
    blocks.push({ id: "goal", head, items });
  }
  // todo 块：标题（完成数/总数，蓝）+ 列表（每条完整折行，不设强制行数上限）
  const list = todos ?? [];
  if (list.length > 0) {
    const head: StatusRow[] = [];
    if (blocks.length > 0) head.push(sep());
    const done = list.filter((t) => t.status === "completed").length;
    head.push({
      segments: [seg(`Todo ${done}/${list.length}`, { fg: "blue" })],
    });
    blocks.push({
      id: "todo",
      head,
      items: list.map((t) => ({
        rows: todoItemRows(t, width),
        done: t.status === "completed",
        active: t.status === "in_progress",
      })),
    });
  }
  // jobs 块：只在有任务时显示；标题 `Jobs 运行中/总数`（蓝）+ 每任务一行
  if (jobs && jobs.length > 0) {
    const head: StatusRow[] = [];
    if (blocks.length > 0) head.push(sep());
    const active = jobs.filter(
      (j) => j.status === "running" || j.status === "stopping",
    ).length;
    head.push({
      segments: [seg(`Jobs ${active}/${jobs.length}`, { fg: "blue" })],
    });
    blocks.push({
      id: "jobs",
      head,
      items: jobs.map((j) => ({
        rows: jobItemRows(j),
        done: statusMark(j.status).symbol === "✓",
        active: j.status === "running" || j.status === "stopping",
      })),
    });
  }
  return blocks;
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
  jobs: JobInfo[] | undefined,
  scroll: number,
  height: number,
  width: number,
  /** 会话运行模式/权限/策略（缺省 undefined：Mode 块省略） */
  mode?: ModeState,
  policy?: "ask" | "never",
  preset?: string,
  /** 权限/agent 预设目录（可选值列表；缺省 Mode 块降级） */
  permissionOptions?: readonly string[],
  presetOptions?: readonly string[],
): FrameRow[] {
  const h = Math.max(1, height);
  const w = Math.max(1, width);
  // 状态列折叠策略：无强制行数上限——各块完整渲染，仅当总高度超过窗口高度时
  // 才折叠：高度按块尽量平均分配，块内按「已完成 → 靠后的未完成」优先级隐藏条目
  const blocks = statusBlocks(
    goal,
    todos,
    jobs,
    w - 1,
    mode,
    policy,
    preset,
    permissionOptions,
    presetOptions,
  );
  // 状态列折叠策略：无强制行数上限——从 L0 到 L3 依次尝试折叠等级，
  // 首次放下即采用；全部等级用尽仍放不下（mode/goal 大头）→ 整列行级截断兜底
  let body: StatusRow[] = [];
  for (const level of [0, 1, 2, 3] as const) {
    body = blocks.flatMap((b) => foldAt(b, level));
    if (body.length <= h) break;
  }
  if (body.length > h) body = capRows(body, h);
  const start = statusStartFor(body.length, scroll, h);
  const out: FrameRow[] = [];
  for (let r = 0; r < h; r++) {
    const idx = start + r;
    const line = idx < body.length ? body[idx] : undefined;
    const segments = line ? [...line.segments] : [];
    // 内容截到 (w-1)：段级截断（不切半个 CJK）
    const inner = truncateSegs(segments, w - 1);
    // 右缘竖线分隔（竖线 │ 跨行连成连续线）：内容后补空格到 (w-1) 再放竖线。
    // 此竖线在 buildTopRegion 被剥去后重画（边框灰/亮由框架构图决定），故保持无色便于剥离
    const innerW = rowWidth2(inner);
    if (innerW < w - 1) inner.push(seg(" ".repeat(w - 1 - innerW)));
    inner.push(seg("│"));
    out.push({ segments: inner });
  }
  return out;
}
/** 顶部区域：左列对话历史+活动区（可独立滚动）、右侧详细状态列；焦点面板四边框亮色 */
/** 当前激活的活动区面板 Box（approval/question/picker/statusPanel/jobs/
 * history/completion 多分支选型；无面板返回 null——活动区显示瞬态行）。
 * 各面板组件导出 buildXxxBox（Box 生成器），这里统一选型。 */
function buildActivePanelBox(
  state: AppState,
  activityH: number,
  contentW: number,
): import("./layout/box.ts").Box | null {
  if (state.approval)
    return buildApprovalBox(state.approval, activityH, contentW);
  if (state.question)
    return buildQuestionPanelBox(state.question, activityH, contentW);
  if (state.picker)
    return buildModelPickerBox({
      picker: state.picker,
      height: activityH,
      width: contentW,
    });
  if (state.statusPanel)
    return buildStatusPanelBox(state.statusPanel, activityH, contentW);
  if (state.jobsPanel)
    return buildJobsPanelBox(
      state.jobs,
      state.jobsPanel.index,
      activityH,
      contentW,
    );
  if (state.commandPanel)
    return buildCommandListPanelBox(state.commandPanel, activityH, contentW);
  if (state.history)
    return buildHistoryPanelBox({
      history: state.history,
      records: historyVisibleRecords(state),
      totalCount: state.history.records.length,
      projectCwd: currentProjectCwd(state),
      height: activityH,
      width: contentW,
    });
  if (state.completion)
    return buildCommandCompletionBox({
      completion: state.completion,
      height: activityH,
      width: contentW,
      themeId: state.themeId,
    });
  return null;
}

/** 面板 Box 生成器 → 活动区 ContentRow[]（measure/allocate/fill 统一摊平） */
function fillPanelBox(
  box: import("./layout/box.ts").Box,
  height: number,
  width: number,
  themeId: ThemeId,
): ContentRow[] {
  const w = Math.max(1, width);
  const rect = { x: 0, y: 0, w, h: Math.max(1, height) };
  const st = measure(box, { maxW: w });
  const rects = allocate(st, rect);
  return fillToList({ themeId, viewportWidth: w }, box, rect, rects);
}

/**
 * 顶部区域（标题栏 + 历史/活动 pane + 状态列）构帧。
 * 尺寸全部取自 geom（FrameGeometry，唯一来源）；state 只用于内容与主题。
 *
 * @param report 回填两 pane 可滚动上限与对话区滚动几何（App 用于收敛偏移）
 */
function buildTopRegion(
  state: AppState,
  geom: FrameGeometry,
  report?: FrameScrollReport,
): FrameRow[] {
  const {
    contentTopH,
    statusColWidth,
    historyWidth,
    contentW,
    titleRows,
    activityH,
    dialogueH,
    dialogueW,
    activityW,
    queuedRows,
    viewportH,
  } = geom;
  // 历史/活动区在左、详细状态列在右：
  // 左缘框格 = 历史/活动区左缘；右缘框列 = 状态列右缘（均非聚焦/模态态留空白占位）
  const useLeftFrame = geom.leftFrame;
  const useRightFrame = geom.rightFrame;
  // 当前活跃会话字段（goal/todo/模式/策略/预设）：状态列与状态栏共用口径
  const { goal, todos, mode, policy, preset } = activeSessionFields(state);
  // 左列顶部为独立标题栏（会话标题行 + 实线下划线）。
  // 排列方式与两 pane 宽高在 frameGeometry 内一次算定（纵向：标题栏行数由对话区
  // 承担；横向：两 pane 等高，中间 1 列内部分隔竖线）。
  const horizontal = geom.mode === "horizontal";
  const diaStart = titleRows; // 内容行中对话区起点（标题栏之后）
  const diaEnd = geom.activitySepRow; // 活动区分隔行（横向无分隔行，此值 = 对话 pane 底边下一行）
  // 渐进窗口：只物化最近 windowGroups 个回合组（缺省 3），更早部分以顶部占位行示意；
  // 上滚接近窗口顶部时由 App 增大 windowGroups 再扩窗（不再每帧全量重排历史）
  const win = dialogueWindow(state.buffer, state.windowGroups);
  const { dialogue, activity } = buildContentRows(
    win.lines,
    {
      themeId: state.themeId,
      gutter: state.messageGutter,
      activityWidth: horizontal ? activityW : undefined,
      // 活动区详略两态（SPEC §6.8）：verbose=false → 紧凑（每条目 1 行 + 省略号，/verbose off）
      activityCompact: !state.activityVerbose,
      lineOffset: win.start,
    },
    horizontal ? dialogueW : contentW,
  );
  // 顶部占位行（line = -1）：窗口未覆盖最旧内容时提示更早回复已折叠
  const markerRow: ContentRow | null =
    win.dropped > 0
      ? {
          segments: [seg(DIALOGUE_MORE, { fg: NOTICE_TONE_COLOR.log })],
          kind: "plain",
          indent: 0,
          seq: DIALOGUE_MARKER_SEQ,
        }
      : null;
  const dialogueRows: ContentRow[] = markerRow
    ? [markerRow, ...dialogue]
    : dialogue;
  // 语义锚点：视口顶行 = (buffer 行, 行内换行序号)；followBottom（anchor=null）时贴窗口底。
  // 视口高 = viewportH（对话 pane 高扣掉底部排队块占位）——滚动上限/锚点换算同此口径
  const spans = dialogueSpans(dialogueRows);
  const maxTop = Math.max(0, dialogueRows.length - viewportH);
  const topIdx =
    state.scrollAnchor === null
      ? maxTop
      : Math.min(anchorToIndex(spans, state.scrollAnchor), maxTop);
  const vp: Viewport = {
    start: topIdx,
    end: Math.min(dialogueRows.length, topIdx + viewportH),
    followBottom: topIdx >= maxTop,
    scrollOffset: maxTop - topIdx,
  };
  // 回填滚动几何与收敛后的锚点：App 用它把「行位移」换算成锚点并同步 state
  if (report) {
    report.dialogueMaxScroll = maxTop;
    report.dialogueGeometry = {
      rows: dialogueRows.length,
      height: viewportH,
      spans,
      topIdx,
    };
    report.dialogueTop = indexToAnchor(spans, topIdx);
  }

  // 状态列（右侧）：恰「内容行数」行，每行宽 statusColWidth。
  // renderStatusColumn 自带右缘竖线，对调后剥去不用，分隔竖线左缘/右缘框列由本函数构图
  const statusCells = renderStatusColumn(
    goal,
    todos,
    state.jobs,
    state.statusColumnScroll,
    contentTopH,
    statusColWidth,
    mode,
    policy,
    preset,
    state.permissionOptions,
    state.presetOptions,
  );
  // 边框构图参数：分隔竖线列 = historyWidth（历史区右缘/状态列左缘，
  // 为旧 statusColWidth-1 的镜像）；col0 左缘框格属历史/活动区，
  // 右缘框列 R 属状态列。顶部边框行占 index 0，标题栏紧随其后，
  // 活动区分隔行自然位于 diaEnd 后一行。
  const statusBodyW = Math.max(
    0,
    statusColWidth - 1 - (useRightFrame ? FRAME_RIGHT_COLS : 0),
  );
  // 仅 statusFocused 保留（状态列内容偏移 statusCells[rc-1] 与 rc0 顶边占位）；
  // history/activity 焦点态不再影响顶部构图（框线由 focusFrame 统一覆写）
  const statusFocused = !geom.modalOpen && state.focusedPanel === "status";
  // 焦点中性基线：活动区分隔线 / 分隔竖线 / 左缘框格 / 右缘框列全部以灰
  // 边框色或空白占位产出；亮角字/亮边由 buildFrame 末尾的 focusFrame
  // 按焦点态覆写（DESIGN.md §8，唯一焦点框机制）。
  const sepSegments = (): FrameSegment[] => [
    {
      text: ACTIVITY_SEPARATOR.repeat(Math.max(1, contentW)),
      style: { fg: "border" },
    },
  ];
  const rows: FrameRow[] = [];
  // 右侧边框列保留格（状态列右缘）：无焦点为空白占位（focusFrame status 焦点时覆写）
  const rightGlyph = (g: string): FrameSegment[] =>
    g === " " ? [seg(" ")] : [seg(g, { fg: "border" })];
  // 内容行（0..contentTopH-1）：标题栏 → 对话区 → 活动区分隔 → 活动区。
  // 中间分隔竖线（历史区右缘/状态列左缘）随焦点面板只亮其垂直边界：
  // status=全行、history=仅对话区、activity=仅分隔行+活动区；模态态全回流边框色。
  const actMaxOffset = Math.max(0, activity.length - activityH);
  if (report) report.activityMaxScroll = actMaxOffset;
  const actOffset = Math.min(state.activityScroll, actMaxOffset);
  const act = activity.slice(
    actMaxOffset - actOffset,
    actMaxOffset - actOffset + activityH,
  );
  // 内容不足一屏时底部对齐（两种排列一致）：流从 pane 底部往上长，最新一行贴 pane 底边，
  // 逐渐填满整块 pane 后才开始折叠最早内容——折叠点恒为「pane 高」而不是「一半」
  const topPad = activityH - act.length;
  // 「有问题交互」面板（审批/问答/模型选择）显示位置=流输出（活动区）窗口顶部：
  // 底部交互区不再承载（footer 空白占位保持交互区高度稳定）；面板占满活动区可视
  // 行，活动区瞬态行（thinking/tool/notice）在面板存在时本帧让位
  // 活动区面板 Box 生成器统一入口（buildActivePanelBox 多分支选型）
  const activeBox = buildActivePanelBox(state, activityH, activityW);
  const modalPanel: ContentRow[] = activeBox
    ? fillPanelBox(activeBox, activityH, activityW, state.themeId)
    : [];
  const divFor = (rc: number): FrameSegment[] => {
    // 焦点中性基线：活动区分隔行 D 列=连接 `┤`（竖线贯穿+横线左接入，
    // 与其他框线同为边框色）；titleRows 下划线行 D 列= `┤`、其余内容行 D 列= `│`
    // 同为边框色；亮角字/亮边由 focusFrame 按焦点态覆写（status 焦点顶边此处 rc0 给空白占位）。
    if (rc === diaEnd && activityH > 0) return [seg("┤", { fg: "border" })];
    if (rc === 0 && statusFocused) return [seg(" ")];
    if (titleRows > 1 && rc === diaStart - 1)
      return [seg("┤", { fg: "border" })];
    return [seg("│", { fg: "border" })];
  };
  // 段数组补齐到定宽（横向两 pane 各自补齐，分隔竖线恒落在各自右边界）
  const padTo = (segs: FrameSegment[], w: number): FrameSegment[] => {
    const used = rowWidth2(segs);
    return used < w ? [...segs, seg(" ".repeat(w - used))] : [...segs];
  };
  // 对话 pane 行：历史视口（viewportH 行）之后是排队块（钉在 pane 底部右下角，始终可见）
  const dialoguePaneSegs = (rr: number): FrameSegment[] => {
    if (rr < 0 || rr >= dialogueH) return [];
    if (rr >= viewportH) {
      const q = queuedRows[rr - viewportH];
      return q ? [...q.segments] : [];
    }
    const w = dialogueRows[vp.start + rr];
    if (!w || vp.start + rr >= vp.end) return [];
    return [...w.segments];
  };
  // 活动 pane 行：交互面板存在时显示面板（顶部对齐），否则按滚动偏移取瞬态窗口（底部对齐）
  const activityPaneSegs = (rr: number): FrameSegment[] => {
    if (rr < 0 || rr >= activityH) return [];
    if (modalPanel.length > 0)
      return rr < modalPanel.length ? [...modalPanel[rr]!.segments] : [];
    const a = rr - topPad;
    return a < 0 || a >= act.length ? [] : [...act[a]!.segments];
  };
  for (let rc = 0; rc < contentTopH; rc++) {
    // col0：历史/活动区左缘框格（段数组）——焦点中性基线恒空白占位，
    // 竖线/角字由 buildFrame 末尾 focusFrame 按焦点态覆写（DESIGN §8）。
    let left: FrameSegment[] = [];
    if (useLeftFrame) left = [seg(" ")];
    // 状态列正文（右侧）：剥去 renderStatusColumn 自带右缘竖线（末段），
    // 正文截到 statusBodyW 定宽、右补空格，保证右缘框列恒位于 R 列。
    const statusBody: FrameSegment[] = (() => {
      if (statusFocused && rc === 0) {
        // 状态列顶边：焦点中性基线以灰 `─` 铺占位（亮色由 focusFrame 覆写）；
        // D 列交点 ┌ 由 focusFrame 覆写，此处 rc0 顶边只画状态列横线部分
        return statusBodyW > 0
          ? [seg(SEPARATOR.repeat(statusBodyW), { fg: "border" })]
          : [];
      }
      const cell = statusCells[statusFocused ? rc - 1 : rc];
      if (!cell) return [seg(" ".repeat(Math.max(0, statusBodyW)))];
      // 剥末段竖线 → 截断到 statusBodyW → 右补空格
      const inner = truncateSegs(cell.segments.slice(0, -1), statusBodyW);
      const innerW = rowWidth2(inner);
      if (innerW < statusBodyW)
        inner.push(seg(" ".repeat(statusBodyW - innerW)));
      return inner;
    })();
    // 左区内容（标题栏 / 对话区行 / 活动区分隔 / 活动区行）→ 段数组
    const contentSegs: FrameSegment[] = (() => {
      if (rc < diaStart) {
        // 标题栏：首行标题（空标题 <title> 灰占位保持行稳定）、次行实线下划线
        if (rc === 0) {
          const rawTitle = (state.sessionTitle ?? "").trim();
          const titleText = truncateToWidth(
            rawTitle === "" ? "<title>" : rawTitle,
            contentW,
          );
          // 会话标题用正常前景色；空标题 <title> 占位保持边框色
          return [
            rawTitle === "" ? seg(titleText, { fg: "border" }) : seg(titleText),
          ];
        }
        // 下划线行：横向排列时内部竖线自此下行 → 该列让位 `┬`
        if (horizontal) {
          return [
            seg(SEPARATOR.repeat(Math.max(1, activityW)), { fg: "border" }),
            seg("┬", { fg: "border" }),
            seg(SEPARATOR.repeat(Math.max(1, dialogueW)), { fg: "border" }),
          ];
        }
        return [seg(SEPARATOR.repeat(Math.max(1, contentW)), { fg: "border" })];
      }
      if (horizontal) {
        // 横向：活动 pane（左）| 内部分隔竖线 | 对话 pane（右）——两 pane 同高、各自补齐定宽
        return [
          ...padTo(activityPaneSegs(rc - diaStart), activityW),
          seg("│", { fg: "border" }),
          ...padTo(dialoguePaneSegs(rc - diaStart), dialogueW),
        ];
      }
      if (rc < diaEnd) {
        // 对话区行：followBottom / scrollOffset 只作用于对话区
        return dialoguePaneSegs(rc - diaStart);
      }
      if (rc === diaEnd && activityH > 0) {
        // 活动区分隔行
        return sepSegments();
      }
      if (activityH > 0) {
        // 活动区行：交互面板存在时显示面板，否则按滚动偏移取瞬态窗口
        return activityPaneSegs(rc - diaEnd - 1);
      }
      return [];
    })();
    // 历史/活动区正文补齐到 contentW：分隔竖线恒位于 D 列（不紧贴文字末尾）
    const contentW2 = rowWidth2(contentSegs);
    const padSegs: FrameSegment[] =
      contentW2 < contentW ? [seg(" ".repeat(contentW - contentW2))] : [];
    // 右缘框列（状态列右缘）：焦点中性基线恒空白占位（status 焦点由
    // focusFrame 覆写 ┐/│/┘）
    const right = " ";
    const rowSegments: FrameSegment[] = [
      ...left,
      ...contentSegs,
      ...padSegs,
      ...divFor(rc),
      ...statusBody,
      ...(useRightFrame ? rightGlyph(right) : []),
    ];
    rows.push({ segments: rowSegments });
  }
  return rows;
}

/**
 * 工具调用行折行（含续行缩进）：整体首行不缩进、可用全宽；其余行——同段软换行的
 * 续行、参数内显式换行后的各行——统一缩进 TOOL_CONT_INDENT 列，且折行宽度扣掉缩进，
 * 保证缩进后每行总宽不超 width（行首超宽字符仍强制放下，不丢字符）。
 * 参数内空行保留（与 split("\n") 语义一致）；窄窗口（width ≤ 缩进）降级不缩进，
 * 避免缩进本身溢出。
 */

/** 模型段标签：provider/model[:reasoningEffort]，无 effort 时不带冒号后缀 */
export function modelLabel(sel: {
  provider: string;
  model: string;
  reasoningEffort?: string;
}): string {
  return `${sel.provider}/${sel.model}${sel.reasoningEffort ? ":" + sel.reasoningEffort.toLowerCase() : ""}`;
}

/** provider 紫，模型名青，:后缀 正常前景色；无 "/" 时整体青（占位 "—" 保持无色）。
 *  状态栏段配色约定：相邻段不同色、不用红/黄/绿状态色、不用亮色系（bright*）。 */
function colorModel(s: string): FrameSegment[] {
  const slash = s.indexOf("/");
  if (slash < 0) return s === "—" ? [seg(s)] : [seg(s, { fg: "cyan" })];
  const rest = s.slice(slash + 1);
  const colon = rest.indexOf(":");
  const model = colon < 0 ? rest : rest.slice(0, colon);
  const effort = colon < 0 ? "" : rest.slice(colon);
  const out: FrameSegment[] = [
    seg(s.slice(0, slash), { fg: "magenta" }),
    seg(`/${model}`, { fg: "cyan" }),
  ];
  if (effort) out.push(seg(effort));
  return out;
}
/** notice/tool 行 tone → 着色名（log 灰 / info 蓝 / warn 黄 / error 红 / success 绿） */

/** 活动行是否为视觉空白：纯文本无可见字符（空思考/notice 拖尾行） */
function formatTokens(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** state.usage → 状态栏 contextLen/cacheHit 段（total<=0 或无用量时 undefined，保留占位） */
function usageStatus(u: {
  input: number;
  output: number;
  cacheRead: number;
  contextWindow?: number;
}): { ctx: string; cache: string } | undefined {
  const total = u.input + u.cacheRead;
  if (total <= 0) return undefined;
  const pct = Math.round((u.cacheRead / total) * 100);
  // 上下文占用百分比 = total / 模型上下文窗口（窗口未知/未披露时省略，保持仅绝对大小）
  const win = u.contextWindow;
  const ctxPct =
    win && win > 0
      ? `(${Math.min(100, Math.round((total / win) * 100))}%)`
      : "";
  return {
    ctx: `ctx ${formatTokens(total)}${ctxPct}`,
    cache: `cache ${pct}%`,
  };
}

/** 段文本按预算截断：过长保留开头 + 省略号（w<=3 视作不截断，交给换行兜底） */
function fitHead(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  return `${truncateToWidth(s, w - 1)}…`;
}

/** git 段在 env 组超宽时的预算列数（分支 + 尾部统计符号；比 cwd 更需要完整） */
const GIT_FIT_WIDTH = 20;

/**
 * git 段按预算截断：分支名开头 + 尾部统计符号簇（`↑N ↓N +N ~N -N`）都要保。
 * 符号在尾部（`main ↑1 +2 ~3`），整体截头会把新信息全砍掉——故分支名中段省略、
 * 符号簇整体保留；符号簇本身就放不下时才退回按头截断。
 */
function fitGit(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  // 分支名不含空格，统计符号以空格分隔 → 第一个空格起是符号簇
  const sp = s.indexOf(" ");
  const branch = sp >= 0 ? s.slice(0, sp) : s;
  const tail = sp >= 0 ? s.slice(sp) : "";
  if (tail !== "") {
    const tailW = displayWidth(tail);
    if (tailW + 2 <= w) {
      const branchW = Math.max(1, w - 1 - tailW); // 留 1 列省略号
      return `${truncateToWidth(branch, branchW)}…${tail}`;
    }
  }
  return fitHead(s, w);
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
  return `…${kept}`;
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
  return `${truncateToWidth(body, bodyW)}…${effort}`;
}

export function renderStatusLine(
  status: AppState["systemStatus"],
  cols: number,
  /** 最新一次模型调用 token 用量（有且 total>0 时覆盖 contextLen/cacheHit 占位） */
  usage?: AppState["usage"],
): FrameRow[] {
  const u = usage ? usageStatus(usage) : undefined;
  const ctxSeg = u?.ctx ?? status.contextLen;
  const cacheSeg = u?.cache ?? status.cacheHit;
  // 思考状态并入 model 段（同一逻辑段）：provider/model:{后缀}
  // 后缀=on/off/none 或实际等级名（多等级开启如 high/low/max）
  const modelBase = status.model.replace(/:[^:]*$/, "");
  const thinkOn = status.model !== modelBase;
  const thinkState = status.modelThinking ?? (thinkOn ? "on" : "none");
  const modelSeg = `${modelBase}:${thinkState}`;

  // 状态栏按类分组（组间 `|` 分隔、组内 `·` 分隔）：
  //   环境组：time · git · cwd            （本机/工作区信息，与会话无关）
  //   LLM 组：model:{后缀} · ctx · cache  （最近一次模型调用指标）
  // 每个「逻辑段」= 多个 FrameSegment（点击色可分多段，如 provider/model/:后缀），
  // 组内逻辑段之间插 `·`、物理段之间不插。
  const maxSegW = Math.max(1, cols - 2); // 留首尾各 1 列
  // 段配色：time 默认 / git 洋红 / cwd 蓝 / title 青 / provider 紫 / model 青
  //          / 后缀 正常前景 / ctx 蓝 / cache 默认
  const envFull: FrameSegment[][] = [
    [{ text: status.time }],
    [{ text: status.git, style: { fg: "magenta" } }],
    [{ text: status.cwd, style: { fg: "blue" } }],
  ];
  const llmFull: FrameSegment[][] = [
    [...colorModel(modelSeg)],
    [{ text: ctxSeg, style: { fg: "blue" } }],
    [{ text: cacheSeg }],
  ];
  // 各组超宽兜底（单组放不满一行时组内压缩）
  const envFit = (w: number): FrameSegment[][] => {
    const gitS = fitGit(status.git, GIT_FIT_WIDTH);
    const budget = Math.max(
      1,
      w - displayWidth(status.time) - displayWidth(gitS) - 2 - 1,
    );
    return [
      [{ text: status.time }],
      [{ text: gitS, style: { fg: "magenta" } }],
      [{ text: fitTail(status.cwd, budget), style: { fg: "blue" } }],
    ];
  };
  const llmFit = (w: number): FrameSegment[][] => {
    const budget = Math.max(
      1,
      w - displayWidth(ctxSeg) - displayWidth(cacheSeg) - 2 - 1,
    );
    return [
      [...colorModel(fitModel(modelSeg, budget))],
      [{ text: ctxSeg, style: { fg: "blue" } }],
      [{ text: cacheSeg }],
    ];
  };
  const groups: Array<{
    full: FrameSegment[][];
    fit: (w: number) => FrameSegment[][];
  }> = [
    { full: envFull, fit: envFit },
    { full: llmFull, fit: llmFit },
  ];

  const groupWidth = (g: FrameSegment[][]): number =>
    g.reduce(
      (acc, s, i) =>
        acc + (i > 0 ? 1 : 0) + s.reduce((a, x) => a + displayWidth(x.text), 0),
      0,
    );

  // 组集 → one FrameRow：组间 `|`、组内逻辑段间 `·`、物理段直拼、首尾空格留边
  const renderRow = (row: FrameSegment[][][]): FrameRow => ({
    segments: [
      { text: " " },
      ...row.flatMap((g, gi) => [
        ...(gi > 0 ? [{ text: "|" } as FrameSegment] : []),
        ...g.flatMap((seg, si) => [
          ...(si > 0 ? [{ text: "·" } as FrameSegment] : []),
          ...seg,
        ]),
      ]),
      { text: " " },
    ],
  });

  // 单行完整（宽度足够）→ 各段完整、无省略号
  const fullW = groups.reduce(
    (acc, g, gi) => acc + (gi > 0 ? 1 : 0) + groupWidth(g.full),
    0,
  );
  if (fullW <= maxSegW) return [renderRow(groups.map((g) => g.full))];

  // 折行（尽量少行）：以组为单位依次放入，放不下整组换行。
  // 单组超行宽时才组内压缩（cwd 保尾 / model 保后缀）。
  const lines: FrameSegment[][][][] = [[]];
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
  // P3：当前活跃会话 agent 预设（状态列 Mode 块显示当前值）
  const preset = state.activeSessionId
    ? state.presetBySession[state.activeSessionId]
    : undefined;
  return { goal, todos, mode, policy, preset };
}

/** 对话区 ↑/↓ 半屏翻页的行数（至少 1 行；向下取整保证上/下对称） */
export function dialogueHalfPage(rows: number): number {
  return Math.max(1, Math.floor(rows / 2));
}

/**
 * 对话区用户输入跳转（PgUp/PgDn）：把上一条/下一条用户消息块首行翻到视口顶行。
 * dir=1 上一条（PgUp）、-1 下一条（PgDn）；基准 = 当前视口首行（物化窗口坐标）。
 * 目标消息块后文本不足一屏时回退「底对齐」（多出的空屏由更早历史填充）。
 * 返回目标行的语义锚点（视口顶行）；无跳转目标返回 null（视口不动）；PgDn 无下一
 * 条 → 返回 null 表示应回到底部（调用方按 dir 区分处理）。
 *
 * 窗口感知：只扫「渐进窗口内」的行（与帧内物化范围一致，boundary 之上暂未物化），
 * 行号转锚点用同一份分组表口径（锚点与换行宽度/窗口大小解耦）。
 */
export function userInputJump(
  buffer: Buffer,
  width: number,
  gutter: number,
  themeId: ThemeId,
  dialogueH: number,
  topIdx: number,
  lineOffset: number,
  dir: 1 | -1,
  markerRows = 0,
): DialogueAnchor | null {
  if (dialogueH <= 0) return null;
  const { dialogue } = buildContentRows(
    buffer,
    { themeId, gutter, lineOffset },
    width,
  );
  // 行身份（锚点）在原对话行上的坐标；占位行（markerRows）由调用方在数组前置
  const spans = dialogueSpans(dialogue);
  const idx0 = Math.min(
    Math.max(0, topIdx - markerRows),
    Math.max(0, dialogue.length - 1),
  );
  const total = dialogue.length;
  if (total === 0) return null;
  const maxStart = Math.max(0, total - dialogueH);
  // 用户消息块 = 连续 kind==="user" 的 wrapped 行；只记块首行
  const blockStarts: number[] = [];
  for (let i = 0; i < total; i++) {
    if (
      dialogue[i]!.kind === "user" &&
      (i === 0 || dialogue[i - 1]!.kind !== "user")
    )
      blockStarts.push(i);
  }
  if (blockStarts.length === 0) return null;
  const aligned = (first: number): DialogueAnchor =>
    // 顶对齐；后文不足一屏时收敛到底对齐（多出的空屏由更早历史填充）
    indexToAnchor(spans, Math.min(first, maxStart));
  if (dir === 1) {
    // 上一条：最后一个位于当前视口首行之上的用户块
    let target = -1;
    for (const st of blockStarts) {
      if (st < idx0) target = st;
      else break;
    }
    if (target < 0) return null;
    return aligned(target);
  }
  // 下一条：第一个位于当前视口首行之下的用户块；无则 null（回到底部跟随最新）
  const next = blockStarts.find((st) => st > idx0);
  if (next === undefined) return null;
  return aligned(next);
}

/** 状态栏上方分隔行（焦点四边框的底边）：按焦点面板分段着色 + 角字（└/┴/┘）；
 * 无焦点/模态态全边框色 `─`。左侧历史/活动区底边（activity 焦点亮、col0 左下角 └），
 * 右侧状态列底边（status 焦点亮、R 列右下角 ┘），D 列 ┴ 为共用角。 */
export function buildStatusSeparator(
  geom: FrameGeometry,
  themeId: ThemeId,
  sepFocus: "none" | "status" | "activity",
): FrameRow {
  // 焦点中性基线：状态区上方分隔行恒灰 `─`（col0 非 activity 底角 └、D 列 ┴
  // border、右缘非 status 右下角 ┘）；亮角字/亮边由 buildFrame 末尾 focusFrame
  // 按焦点态覆写（status 顶/底边、activity 底边 └┴、history 底边 ┘ 等）。
  // sepFocus / themeId 参数保留（契约兼容），焦点绘图不再在此进行。
  void sepFocus;
  void themeId;
  // 尺寸全部取自几何（分隔竖线列/右缘框列/内部分隔列与帧内其它部分同源）
  const D = geom.dividerCol; // 分隔竖线列（历史区右缘/状态列左缘）
  const R = geom.cols - 1;
  const out: FrameSegment[] = [];
  const segN = (n: number): FrameSegment[] => {
    if (n <= 0) return [];
    return [{ text: STATUS_TOP_SEPARATOR.repeat(n), style: { fg: "border" } }];
  };
  const inner =
    geom.innerDividerCol !== undefined &&
    geom.innerDividerCol > 0 &&
    geom.innerDividerCol < D
      ? geom.innerDividerCol
      : undefined;
  if (D > 0) out.push({ text: STATUS_TOP_SEPARATOR, style: { fg: "border" } });
  out.push(...segN(Math.max(0, (inner ?? D) - 1)));
  // 内部分隔竖线（横向排列）：与水平实线交汇 → 灰 ┴
  if (inner !== undefined) out.push({ text: "┴", style: { fg: "border" } });
  out.push(...segN(Math.max(0, D - (inner ?? D) - 1)));
  // D 列交点恒与水平实线相交（灰 ┴；status/activity 焦点由 focusFrame 覆写亮 ┴）
  out.push({ text: "┴", style: { fg: "border" } });
  out.push(...segN(Math.max(0, R - D - 1)));
  // R 列（状态列右缘框列）：灰 `─`（status 焦点由 focusFrame 覆写 ┘）
  if (geom.rightFrame)
    out.push({ text: STATUS_TOP_SEPARATOR, style: { fg: "border" } });
  return { segments: out };
}
/**
 * 帧构建回填的可滚动上限（行单位，均 ≥ 0）：对话区按**未折叠**全量行数计，
 * 活动区按可视行数计。App 用它把 scrollOffset/activityScroll 收敛到真实范围
 * （否则越界偏移会累积成"按了没反应"的假死，见 state.ts scrollBy 注释）。
 */
export interface FrameScrollReport {
  dialogueMaxScroll: number;
  activityMaxScroll: number;
  /** 对话区滚动几何（渐进窗口 + 语义锚点；App 经 paneMaxes() 回填或就地补算） */
  dialogueGeometry: DialogueGeometry;
  /** 本帧实际渲染的视口顶行锚点（收敛后；App 用它同步 state.scrollAnchor） */
  dialogueTop: DialogueAnchor;
}

export function buildFrame(
  state: AppState,
  size: Size,
  report?: FrameScrollReport,
): FrameRow[] {
  // 尺寸唯一来源：几何一次算定（顶部内容行数/两 pane 宽高/排列/排队块占位/状态栏行）
  const geom = frameGeometry(state, size);
  const {
    cols: fullWidth,
    contentTopH,
    statusColWidth,
    historyWidth,
    titleRows,
    innerDividerCol,
    showHint,
    modalOpen,
  } = geom;
  const history = state.history;
  const topRegion = buildTopRegion(state, geom, report);

  let footerLines: FrameRow[];
  // 审批/问答/模型选择/状态选项/任务/历史会话面板 + 输入补全均上移到流输出（活动区）窗口显示；
  // 输入补全不占输入区（输入行与光标必须可见），其余面板打开时 footer 以空白占位（交互区高度稳定）。
  if (modalOpen) {
    footerLines = Array.from({ length: geom.footerHeight }, () => ({
      segments: [seg(" ".repeat(fullWidth))],
    }));
  } else {
    // 两字符提示符：左字符 = 上次提交所用模式符号（MODE_SYMBOL[lastSubmitMode]，
    // 颜色随状态绿/黄/红），右字符 = 当前输入模式符号（MODE_SYMBOL[inputMode]，
    // 默认前景色不着色）；prompt 预先分段，renderTextInput 宽度按未着色文本计算。
    // 输入区为多行框：文本按宽度换行、顶部对齐，光标行超出区域时跟随。
    const prompt: FrameSegment[] = [
      seg(MODE_SYMBOL[state.lastSubmitMode] ?? ">", {
        fg: STATUS_PROMPT_COLOR[state.inputStatus],
      }),
      seg(MODE_SYMBOL[state.inputMode] ?? ">"),
      seg(" "),
    ];
    footerLines = renderTextInput(
      state.inputText,
      state.inputCursor,
      "Type a message...",
      fullWidth,
      prompt,
      geom.footerHeight,
    );
  }

  // 按键提示区（独立区域，与输入区之间不画横线；正常前景色；窄终端按显示宽度截断）。
  // 补全候选打开时改为补全键位（面板本身不再占活动区行放提示）；
  // 历史会话面板的按键提示也在此显示（面板标题行不再内嵌键位，避免活动区顶部堆提示）。
  const historyHint = history
    ? (HISTORY_HINTS[history.phase] ?? HISTORY_LOADING_HINT_LINE)
    : null;
  const hintLines: FrameRow[] = showHint
    ? [
        {
          segments: [
            seg(
              truncateToWidth(
                historyHint ??
                  (state.completion ? COMPLETION_HINT_LINE : HINT_LINE),
                fullWidth,
              ),
            ),
          ],
        },
      ]
    : [];

  // 分隔行（边框统一边框色：先纯文本截断再段化）。状态区上方与其余横线同为 `─`；
  // 焦点在底部为流输出/状态列时该行用亮色框（钩到面板底边）。
  const makeSep = (ch: string, color: ColorName = "border"): FrameRow => ({
    segments: [
      seg(truncateToWidth(ch.repeat(fullWidth), fullWidth), { fg: color }),
    ],
  });
  // 状态区上方分隔行的焦点语义（modal 态无焦点回 none）
  let statusSepFocus: "none" | "status" | "activity" = "none";
  if (!modalOpen) {
    if (state.focusedPanel === "status") statusSepFocus = "status";
    else if (state.focusedPanel === "activity") statusSepFocus = "activity";
  }
  const rects: Map<PaneId, Rect> = new Map();
  const rows: FrameRow[] = [
    ...topRegion,
    buildStatusSeparator(geom, state.themeId, statusSepFocus),
    ...geom.statusLines,
    makeSep(SEPARATOR),
    ...footerLines,
    ...hintLines,
  ];
  // 焦点框全局覆写：buildTopRegion/buildStatusSeparator 已产出焦点中性基线，
  // 末帧一次扫描按焦点分区矩形（帧坐标，right=x+w-1/bottom=y+h-1）覆写亮
  // 角字/边线（DESIGN.md §8 / SPEC.md §8 唯一焦点框机制）。模态态（面板打开）
  // 焦点用 null 传入：面板占活动区时无焦点框高亮。
  const underlineRow = Math.max(0, titleRows - 1);
  const diaEnd = geom.activitySepRow; // 纵向=活动区分隔行；横向=对话 pane 底边下一行
  if (geom.mode === "horizontal") {
    // 横向排列：活动 pane 在左、对话 pane 在右、两 pane 等高——顶=标题栏下划线行，
    // 底=状态区上方分隔行 contentTopH；内部分隔列 = activity 右缘 / history 左缘
    const h = Math.max(1, contentTopH - underlineRow + 1);
    const divCol = innerDividerCol ?? 0;
    rects.set("activity", { x: 0, y: underlineRow, w: divCol + 1, h });
    rects.set("history", {
      x: divCol,
      y: underlineRow,
      w: historyWidth - divCol + 1,
      h,
    });
  } else {
    // history 矩形：顶=标题栏下划线行（titleRows>=2 才有下划线；否则顶=首对话行）、
    // 底=活动区分隔行 diaEnd；覆盖左缘框列 + 正文 + D 列
    rects.set("history", {
      x: 0,
      y: underlineRow,
      w: historyWidth,
      h: Math.max(1, diaEnd - underlineRow + 1),
    });
    // activity 矩形：顶=活动区分隔行 diaEnd、底=状态区上方分隔行 contentTopH
    rects.set("activity", {
      x: 0,
      y: diaEnd,
      w: historyWidth,
      h: Math.max(1, contentTopH - diaEnd + 1),
    });
  }
  // status 矩形：x=D（分隔竖线列）、顶=帧顶 rc0、底=状态区上方分隔行 contentTopH
  rects.set("status", {
    x: geom.dividerCol,
    y: 0,
    w: statusColWidth,
    h: Math.max(1, contentTopH + 1),
  });
  focusFrame(
    {
      themeId: state.themeId,
      focusedPanel: modalOpen ? null : state.focusedPanel,
      // 结构行号：status 焦点 D 列竖线区分下划线行（灰）与活动分隔行（亮 ┤）
      titleUnderlineRow: underlineRow,
      activitySepRow: diaEnd,
      // 横向排列：history 右缘/activity 左缘 = 内部分隔列（缺省走 D 列）
      innerDividerCol,
    },
    rects,
    rows,
  );
  return rows;
}
