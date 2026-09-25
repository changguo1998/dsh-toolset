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

import type { FrameFocus, FrameRow, FrameSegment } from "../renderer/index.ts";
import type { FrameSection, Size } from "../renderer/index.ts";
import type {
  AppState,
  BufferLine,
  InputMode,
  InputStatus,
  GoalEntry,
  GoalHistory,
  ModeState,
} from "./state.ts";
import { hintLine } from "./layout/hints.ts";
import {
  currentProjectCwd,
  historyVisibleRecords,
  isCompacting,
} from "./state.ts";
import type { ActivityPlacement } from "./config.ts";

import type { Buffer } from "./state.ts";
import type { JobInfo, TodoItemLike, GoalSnapshotLike } from "./adapter/dsh.ts";
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
import { fillToList, fillBoxTree } from "./layout/fill.ts";
import { h, styled } from "./layout/box.ts";
import { focusFrame, focusColor } from "./layout/focus-frame.ts";
import type { PaneId, Rect } from "./layout/box.ts";
import type { ContentRow } from "./layout/fill.ts";
import { charWidth, displayWidth } from "./layout/markdown.ts";
import {
  ACTIVITY_SEPARATOR,
  NOTICE_TONE_COLOR,
  SEPARATOR,
  STATUS_TOP_SEPARATOR,
  TURN_SEPARATOR_CHAR,
  teeGlyph,
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
export { helpTableLines, sortHelpRows } from "./layout/help.ts";

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

/**
 * 视口顶行号：锚点 → 行号；锚点行**在对话行表里不可达**时钉到下一段可用内容。
 *
 * 不可达的几种情形：① 被缓冲上限裁剪（活动区/对话区大量输出时逐行裁掉最旧行）；
 * ② 被压缩摘要遮蔽（`compaction/summary` 的 shadowed 行）；③ 该行改由活动区承载；
 * ④ 锚点就是折叠占位行（`DIALOGUE_MARKER_SEQ`）。
 * 若此时照旧让 `anchorToIndex` 收敛到物化窗口首行，视口就被钉在不断前移的缓冲头上
 * 逐帧往前挪（占位行 ↔ 缓冲头），表现为「活动区输出大量文本时历史区跟着一起上滚」，
 * 用户上翻阅读时阅读位置被持续拽走，还常与压缩摘要互相打架（顶行两处来回跳）。
 * 故改为钉到缓冲中「不早于锚点行的第一条仍可达内容」：位置只由内容本身决定，与新行
 * 到达、窗口扩缩、距底偏移都无关（新内容只从底部追加 → 视口纹丝不动）；内容被裁掉 /
 * 遮蔽时只单调前进到下一段可用内容。全不可达（锚点比表内所有内容都新）时贴底。
 */
export function dialogueTopIdx(
  state: { scrollAnchor: DialogueAnchor | null },
  spans: readonly DialogueSpan[],
  maxTop: number,
): number {
  const anchor = state.scrollAnchor;
  if (anchor === null) return maxTop;
  // 占位行（更早回复已折叠）不是内容行，同样按不可达处理
  const reachable =
    anchor.seq !== DIALOGUE_MARKER_SEQ &&
    spans.some((s) => s.seq === anchor.seq);
  if (!reachable) {
    // 钉到缓冲中「不早于锚点行的第一条仍可达内容」：位置由内容本身决定，与新行到达、
    // 窗口扩缩、距底偏移都无关 —— 新内容只从底部追加，视口因此不再漂移；内容被裁掉/
    // 遮蔽时只前进一格到下一段可用内容（单调，不来回跳）。全不可达时贴底。
    const nextSpan = spans.find(
      (s) => s.seq !== DIALOGUE_MARKER_SEQ && s.seq >= anchor.seq,
    );
    if (nextSpan === undefined) return maxTop;
    return Math.max(
      0,
      Math.min(anchorToIndex(spans, { seq: nextSpan.seq, row: 0 }), maxTop),
    );
  }
  return anchorToIndex(spans, anchor);
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

// 按键提示区文案见 ./layout/hints.ts（唯一来源；面板内不再画提示，全部走提示区）。

export interface FrameMetrics {
  /** 顶部区域行数 = rows - 状态区 - 输入区 - 按键提示区 - 分隔行（剩余高度全给上方两个） */
  topHeight: number;
  /** 系统状态区行数（可 >1：状态内容溢出到多行时按实际行数） */
  statusHeight: number;
  /** 输入区行数 = interaction − 提示区行数（面板态与输入态同高，不随面板开关变化） */
  footerHeight: number;
  /** 按键提示区行数（独立区域，位于输入区下方、之间不画横线；恒 1 行，空文案也占位） */
  hintHeight: number;
  /** 顶部状态列宽（详细 goal/todo；窄列约 25%，含右缘分隔竖线，状态列位于最左侧列） */
  statusColWidth: number;
  /** 历史区（标题栏 + 历史/活动区）宽 = cols - statusColWidth */
  historyWidth: number;
}

export function metricsFor(
  size: Size,
  /** 状态区行数（默认 1；可多行溢出时按实际行数压缩顶部区域） */
  statusHeight = 1,
  /** 按键提示区行数（独立区域，与输入区共同构成交互区；恒 1 行——空文案也占位） */
  hintRows = 1,
  /** 布局配置（tui.config.json；缺省某字段 → 原默认公式） */
  layout?: { footerHeight?: number; statusDivisor?: number },
): FrameMetrics {
  // 「交互区」= 输入区 + 按键提示区，总高恒为 interaction（默认 4 行：输入 3 + 提示 1；
  // 矮终端按 1/5 收缩、保底 2 行）。footer 由 hint 反推是**唯一事实**——面板态与输入态
  // 同高、开关面板不让顶部区域上下跳；不再用「是否有面板」推断 footer（易传错且难察觉）
  const interaction =
    layout?.footerHeight ?? Math.min(4, Math.max(2, Math.floor(size.rows / 5)));
  const footerHeight = Math.max(1, interaction - hintRows);
  // 状态列：窄列约 1/3（含右缘竖线），**最低 20 列**
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
/** 焦点面板四边框的保留格：屏幕最左 1 列（状态列外缘）+ 最右 1 列（历史/活动区外缘）。
 *  所有状态恒定，未聚焦留空白占位，防内容重排。
 *  不保留顶部边框行（标题栏即顶部，焦点顶边用标题栏下划线/状态列顶行兼作）。 */
export const FRAME_LEFT_COLS = 1;
export const FRAME_RIGHT_COLS = 1;

/** 区域 pane **文字**右缘留白（列）：只有**右缘贴着外框列**的文字排版宽需要再收窄。
 *  - 横向排列：历史 pane（左）右缘接内部分隔竖线 → **不留白**（`┃` 紧贴竖线）；
 *    活动 pane（右）右缘贴外缘框列 → 让 1 列。
 *  - 纵向排列：两 pane 同列同宽、共享右缘 → 让 1 列（原为各让 2 列）。
 *  - **只缩文字**：边框/分隔线一概不动——标题栏下划线、活动区分隔线、状态栏框线与
 *    分隔行仍铺满整行（到区域外缘框列 `FRAME_RIGHT_COLS`），焦点框矩形也不变。
 *  - 目的：字形宽度算错（CJK/组合字符宽度估算偏差）时多出的列落在留白里，不顶到
 *    外缘框列、不把整行挤到下一行（整行溢出 = 帧行折行 → 全屏错位）。 */
export const PANE_TEXT_MARGIN_COLS = 1;

/** pane 文字排版宽：`reserve=true` 时扣掉右缘留白（P3：只给右缘贴外框列的 pane 留）。
 *  横向历史 pane 传 false（贴内部分隔竖线），活动 pane 与纵向两 pane 传 true。 */
export function paneTextWidth(paneW: number, reserve = true): number {
  return Math.max(1, paneW - (reserve ? PANE_TEXT_MARGIN_COLS : 0));
}

/** 区域正文宽（标题栏 + 历史/活动区）：historyWidth 扣外缘框格（buildTopRegion 与滚动口径同源） */
export function regionColumnWidth(historyWidth: number): number {
  const useFrame = historyWidth >= FRAME_RIGHT_COLS + 1;
  return Math.max(1, historyWidth - (useFrame ? FRAME_RIGHT_COLS : 0));
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
 * metricsFor/topPaneSplit/regionColumnWidth——历史上多处各算一次，口径漂移会让
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
  /** 顶部状态列宽 / 历史区（标题栏 + 两 pane）宽 */
  statusColWidth: number;
  historyWidth: number;
  /** 区域正文宽（historyWidth − 外缘框格；两 pane 宽度都从它派生） */
  contentW: number;
  /** 屏幕最左列（状态列外缘）/ 最右列（历史区外缘）框格保留列是否存在（各 1 列；宽度不足时不留） */
  leftFrame: boolean;
  rightFrame: boolean;
  /** 排列方式（activityPlacement=auto 的判定结果）与标题栏行数 */
  mode: "vertical" | "horizontal";
  titleRows: number;
  /** 活动 pane / 对话 pane 可视行数（横向两 pane 等高） */
  activityH: number;
  dialogueH: number;
  /** 活动 pane / 对话 pane 正文宽（纵向两 pane 同宽；含文字右缘留白列，边框按它铺满） */
  activityW: number;
  dialogueW: number;
  /** 两 pane **文字**排版宽（正文宽扣右缘留白，见 PANE_TEXT_MARGIN_COLS；边框不受影响） */
  dialogueTextW: number;
  activityTextW: number;
  /** 排队块可见行（右对齐用户块，右缘竖线灰色；钉在对话 pane 底部右下角。
   *  内容 = `AppState.queued`：已交给核心 next-turn 队列、本回合尚未认领的消息 */
  queuedRows: ContentRow[];
  /** 历史视口高 = dialogueH − 排队块行数（语义锚点与滚动上限按它算） */
  viewportH: number;
  /** 分隔竖线列（状态列右缘/历史区左缘；= statusColWidth − 1，恒紧贴状态列正文右侧）。
   *  `Ctrl+S` 隐藏状态列时 statusColWidth = 0 → 本值 -1 = 该列不存在（状态区上方
   *  分隔行不画交点、区域左缘按 0 起算），消费方须按 -1 守卫 */
  dividerCol: number;
  /** 区域正文起始列（= dividerCol + 1，即有效 statusColWidth；隐藏状态列时 = 0；
   *  标题栏与两 pane 正文自该列起算） */
  contentStartCol: number;
  /** 横向排列的内部分隔竖线列（历史 pane 右缘/活动 pane 左缘）；纵向 undefined */
  innerDividerCol?: number;
  /** 活动区分隔行行号（纵向 = 实线分隔行；横向 = 对话 pane 底边下一行，该行无分隔线） */
  activitySepRow: number;
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
  const statusLines = renderStatusLine(
    state.systemStatus,
    cols,
    state.usage,
    state.inputStatus,
    state.runVirt.tokens,
    state.themeId,
  );
  // 交互区总高恒定（见 metricsFor）：提示区恒 1 行（空文案也占位），面板开关不让顶部上下跳
  const metrics = metricsFor(size, statusLines.length, 1, state);
  const contentTopH = Math.max(0, metrics.topHeight);
  // P7：垂直状态列隐藏时（Ctrl+S）该列宽归 0——状态列内容、右缘分隔竖线与
  // 左缘框格都不再绘制，历史区吃满整宽（高度分配不受影响）
  const statusColWidth = state.statusColumnVisible ? metrics.statusColWidth : 0;
  const historyWidth = state.statusColumnVisible ? metrics.historyWidth : cols;
  const contentW = regionColumnWidth(historyWidth);
  // 排列方式与两 pane 宽高同源于 topPaneSplit（auto 判定只看区域正文宽 + 内容行数）
  const split = topPaneSplit(
    contentTopH,
    contentW,
    state.activityDivisor,
    activityTopRowToLine(state.activityTopRow, size.rows),
    state.activityPlacement,
  );
  const horizontal = split.mode === "horizontal";
  // 文字排版宽（P3）：横向历史 pane 不留白（`┃` 紧贴内部分隔竖线）；活动 pane 与
  // 纵向两 pane 各让 1 列（右缘贴外缘框列，字形宽度估算偏差落在留白里）
  const dialogueTextW = paneTextWidth(split.dialogueW, !horizontal);
  const activityTextW = paneTextWidth(split.activityW);
  // 排队块钉在对话 pane 底部：至多占 pane 高 − 1 行（至少留 1 行历史可见）；
  // 超出时取尾部（最新排队内容优先可见）
  const queuedAll = queuedBlockRows(state, dialogueTextW);
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
    statusColWidth,
    historyWidth,
    contentW,
    leftFrame: statusColWidth >= FRAME_LEFT_COLS + 1,
    rightFrame: historyWidth >= FRAME_RIGHT_COLS + 1,
    mode: split.mode,
    titleRows: split.titleRows,
    activityH: split.activityH,
    dialogueH: split.dialogueH,
    activityW: split.activityW,
    dialogueW: split.dialogueW,
    dialogueTextW,
    activityTextW,
    queuedRows,
    viewportH: Math.max(0, split.dialogueH - queuedRows.length),
    // 以下三列一律取**有效**状态列宽（Ctrl+S 隐藏时 = 0）：隐藏后分隔竖线列归 -1
    // （= 该列不存在：状态区上方分隔行不画 ┴、焦点矩形不左移一列）。若取 metrics 的
    // 原始宽，隐藏态会残留"旧列"交点（并排排列下连同内部分隔列共两个）。
    dividerCol: statusColWidth - 1,
    contentStartCol: statusColWidth,
    // 内部分隔列 = 区域正文起始列 + 历史 pane 宽（历史区在左；两 pane 等宽时才与活动 pane 同宽）
    innerDividerCol: horizontal ? statusColWidth + split.dialogueW : undefined,
    activitySepRow: split.titleRows + split.dialogueH,
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

/** 状态列块：head=分隔线/标题等必保行；items=可按优先级折叠的条目（todo/jobs/goal 历史） */
interface StatusBlock {
  id: "mode" | "goal" | "todo" | "jobs";
  head: StatusRow[];
  items: { rows: StatusRow[]; done: boolean; active: boolean }[];
  /** goal 块专用：items[≥ historyFrom] 为历史（旧）goal 条目——L1 只保留首条，L2 起全隐藏 */
  historyFrom?: number;
}

/** 状态列折叠等级（全局统一递增尝试）：
 *  L0 不折叠；L1 隐藏已完成条目（goal 保留最近 1 条历史）；L2 仅保留进行中条目
 *  （goal 压成标题行）；L3 进行中条目也压为 1 行。 */
type FoldLevel = 0 | 1 | 2 | 3;

/** 按折叠等级折叠块：goal 的 items 分「当前 goal 行 + 历史条目」（L1 保留最近 1 条历史、
 *  L2 起压成标题行「Goal <phase>」）；todo/jobs 按 done/active 过滤并带隐藏计数提示；
 *  mode 恒完整。 */
function foldAt(block: StatusBlock, level: FoldLevel): StatusRow[] {
  if (block.id === "goal") {
    // head 末行恒为标题（首块无 sep），L2 起只留标题：删除分隔线、objective 与历史
    if (level >= 2) return [block.head[block.head.length - 1]!];
    let kept = block.items;
    let hidden = 0;
    const from = block.historyFrom ?? kept.length;
    // L1：历史只留最近 1 条（当前 goal 行不受折叠影响）
    if (level >= 1 && kept.length > from + 1) {
      hidden = kept.length - (from + 1);
      kept = kept.slice(0, from + 1);
    }
    const rows = kept.flatMap((it) => it.rows);
    if (hidden > 0) {
      rows.push({
        segments: [
          seg(`…(+${hidden}个历史 goal 已隐藏)`, { fg: NOTICE_TONE_COLOR.log }),
        ],
      });
    }
    return [...block.head, ...rows];
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

/** 当前 goal 的 objective 行（phase=complete 已完成 → 灰 + 删除线，与 todo 完成态同口径） */
function goalObjectiveRows(g: GoalSnapshotLike, width: number): StatusRow[] {
  return wrapLine(g.objective || "（空目标）", Math.max(1, width)).map(
    (text) => ({
      segments: [
        g.phase === "complete"
          ? seg(text, { fg: "gray", strike: true })
          : seg(text),
      ],
    }),
  );
}

/** 历史（旧）goal 行：标题行「Goal <phase>」（灰）+ objective（灰 + 删除线） */
function goalHistoryRows(e: GoalEntry, width: number): StatusRow[] {
  const rows = wrapLine(
    e.goal.objective || "（空目标）",
    Math.max(1, width),
  ).map((text) => ({
    segments: [seg(text, { fg: "gray", strike: true })],
  }));
  return [
    {
      segments: [
        seg("Goal ", { fg: "gray" }),
        seg(e.goal.phase, { fg: "gray" }),
      ],
    },
    ...rows,
  ];
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

/** P7 起：会话开关态（verbose / symbol-unify / 声音提醒）不再由状态列 Mode 块展示，
 *  而是作为**标题栏状态符号**的取值来源（on = 默认前景，off = 灰）。 */
export interface StatusSwitches {
  /** 活动区详略（`/verbose on|off`） */
  verbose: boolean;
  /** 输出符号统一（`/symbol-unify on|off`） */
  symbolUnify: boolean;
  /** 声音提醒总开关（`notify.enabled`，配置项：只读显示当前值） */
  notifyEnabled: boolean;
}

/** 顶部状态列正文行（未按可视高度裁剪；供滚动窗口取窗） */
/** 状态列各块（Goal / Todo / Jobs；完整自然高度，无强制行数上限；
 *  是否折叠由 renderStatusColumn 按窗口总高决定） */
function statusBlocks(
  goals: GoalHistory | undefined,
  todos: TodoItemLike[] | undefined,
  jobs: JobInfo[] | undefined,
  width: number,
): StatusBlock[] {
  const blocks: StatusBlock[] = [];
  const sep = (): StatusRow => ({
    // 虚线分隔与字体同色（不染边框蓝）
    segments: [seg(STATUS_BLOCK_SEPARATOR.repeat(width))],
  });
  // P7：Mode 块已移除（会话运行模式/权限/策略/预设/开关改由标题栏状态符号承载）
  // goal 块非必需；todo/jobs 块独立展示（不早退）
  // 条目布局：[当前 goal（objective，+blocked 原因）] + [历史（旧）goal 至少一条]
  const goalList = goals ?? [];
  if (goalList.length > 0) {
    const current = goalList[0]!;
    const head: StatusRow[] = [];
    if (blocks.length > 0) head.push(sep());
    head.push({
      segments: [
        seg("Goal ", { fg: "blue" }),
        seg(current.goal.phase, {
          fg: GOAL_PHASE_COLOR[current.goal.phase] ?? "green",
        }),
      ],
    });
    const items: StatusBlock["items"] = [
      {
        rows: goalObjectiveRows(current.goal, width),
        done: current.goal.phase === "complete",
        active: current.goal.phase === "active",
      },
    ];
    // blocked → blockedReason.message 黄 tone
    if (
      current.goal.phase === "blocked" &&
      current.goal.blockedReason?.message
    ) {
      items.push({
        rows: [
          {
            segments: [
              seg("阻塞: " + current.goal.blockedReason.message, {
                fg: "yellow",
              }),
            ],
          },
        ],
        done: false,
        active: false,
      });
    }
    const historyFrom = items.length;
    for (const e of goalList.slice(1)) {
      items.push({
        rows: goalHistoryRows(e, width),
        done: true,
        active: false,
      });
    }
    blocks.push({ id: "goal", head, items, historyFrom });
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

/** P7：标题栏状态符号（Nerd Font 私有区字形，宽度实测各 1 列；写成转义便于核对码位）。
 *  - 沙箱：`md-package_variant_closed` U+F03D7（只读）/ `md-package_variant` U+F03D6（可写、全权、其它）
 *  - 审批策略：`md-chat_question_outline` U+F1739（ask）/ `md-chat_remove_outline` U+F1414（never）
 *  - 开关：`fa-route` U+EDA6（plan）/ `md-text_long` U+F09AA（verbose）/
 *    `md-spellcheck` U+F04C6（符号统一）/ `md-bell_ring_outline` U+F009F（声音提醒）
 *  - 预设：`md-puzzle_outline` U+F0A66（后接预设名） */
export const TITLE_ICON = {
  boxClosed: "\u{F03D7}",
  boxOpen: "\u{F03D6}",
  policyAsk: "\u{F1739}",
  policyNever: "\u{F1414}",
  plan: "\u{EDA6}",
  verbose: "\u{F09AA}",
  symbolUnify: "\u{F04C6}",
  bell: "\u{F009F}",
  preset: "\u{F0A66}",
} as const;

/** P7：标题栏首行段数组 = [preset 符号 + 名字] 1 空格 [6 个状态符号（空格分隔）] 2 空格 [标题]。
 *  颜色即语义值：沙箱 ro 绿 / wr 黄 / full 红 / 其它灰；policy ask 黄 / never 绿；
 *  四个开关 on 绿 / off 灰；preset 统一默认前景。`permission` 不再显示。
 *  窄宽让位顺序：① 去掉 preset → ② 截断标题 → ③ 去掉整组符号 → ④ 既有标题栏降级。 */
export function titleBarSegments(
  state: AppState,
  fields: { mode?: ModeState; policy?: "ask" | "never"; preset?: string },
  switches: StatusSwitches,
  width: number,
): FrameSegment[] {
  // preset 段：拼图符号 + 1 空格 + 预设名（统一默认前景）
  const presetSegs: FrameSegment[] =
    fields.preset && fields.preset !== ""
      ? [seg(TITLE_ICON.preset), seg(" "), seg(fields.preset)]
      : [];
  // 状态符号组（空格分隔，顺序固定：sandbox / policy / plan / verbose / 符号统一 / 声音）
  const symSegs: FrameSegment[] = [];
  const push = (text: string, fg?: ColorName): void => {
    if (symSegs.length > 0) symSegs.push(seg(" "));
    symSegs.push(fg === undefined ? seg(text) : seg(text, { fg }));
  };
  const sandbox = fields.mode?.sandbox;
  if (sandbox) {
    const code = MODE_SHORT[sandbox] ?? sandbox;
    const fg: ColorName =
      code === "ro"
        ? "green"
        : code === "wr"
          ? "yellow"
          : code === "full"
            ? "red"
            : "gray";
    push(code === "ro" ? TITLE_ICON.boxClosed : TITLE_ICON.boxOpen, fg);
  }
  if (fields.policy) {
    const never = fields.policy === "never";
    push(
      never ? TITLE_ICON.policyNever : TITLE_ICON.policyAsk,
      never ? "green" : "yellow",
    );
  }
  // 四个开关（plan / verbose / 符号统一 / 声音提醒）：颜色即取值——on 绿 / off 灰
  const on: ColorName = "green";
  const off: ColorName = "gray";
  if (fields.mode?.plan)
    push(TITLE_ICON.plan, fields.mode.plan === "on" ? on : off);
  push(TITLE_ICON.verbose, switches.verbose ? on : off);
  push(TITLE_ICON.symbolUnify, switches.symbolUnify ? on : off);
  push(TITLE_ICON.bell, switches.notifyEnabled ? on : off);

  const rawTitle = (state.sessionTitle ?? "").trim();
  const title = rawTitle === "" ? "<title>" : rawTitle;
  const MIN_TITLE = 8; // 标题至少保留 8 列，不足则按让位顺序收缩符号区
  const GAP = 2; // 符号区与标题之间 2 空格
  const widthOf = (segs: readonly FrameSegment[]): number =>
    segs.reduce((a, x) => a + displayWidth(x.text), 0);
  const compose = (withPreset: boolean): FrameSegment[] => {
    const out: FrameSegment[] = [];
    if (withPreset && presetSegs.length > 0) out.push(...presetSegs);
    if (symSegs.length > 0) {
      if (out.length > 0) out.push(seg(" "));
      out.push(...symSegs);
    }
    return out;
  };
  const used = (head: readonly FrameSegment[]): number =>
    head.length > 0 ? widthOf(head) + GAP : 0;
  let head = compose(true);
  if (head.length > 0 && width - used(head) < MIN_TITLE) head = compose(false); // ① preset 让位
  if (head.length > 0 && width - used(head) < MIN_TITLE) head = []; // ③ 符号组让位
  // ② 标题按剩余宽截断（空标题 `<title>` 占位保持边框色）
  const titleText = truncateToWidth(title, Math.max(1, width - used(head)));
  const out: FrameSegment[] = [...head];
  if (out.length > 0) out.push(seg(" ".repeat(GAP)));
  out.push(rawTitle === "" ? seg(titleText, { fg: "border" }) : seg(titleText));
  return out;
}

/** 顶部状态列（最左侧列）：输出恰 height 行，每行宽 statusColWidth（末位竖线为分隔竖线边线，
 *  由 buildTopRegion 剥去后重新构图左缘外框格/右缘分隔竖线）。
 *  滚动独立于对话区（statusColumnScroll，↑/↓ 仍滚历史，PgUp/PgDn 滚状态列）。 */
export function renderStatusColumn(
  goals: GoalHistory | undefined,
  todos: TodoItemLike[] | undefined,
  jobs: JobInfo[] | undefined,
  scroll: number,
  height: number,
  width: number,
): FrameRow[] {
  const h = Math.max(1, height);
  const w = Math.max(1, width);
  // 状态列折叠策略：无强制行数上限——各块完整渲染，仅当总高度超过窗口高度时
  // 才折叠：高度按块尽量平均分配，块内按「已完成 → 靠后的未完成」优先级隐藏条目
  const blocks = statusBlocks(goals, todos, jobs, w - 1);
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
/** 顶部区域：最左详细状态列、右侧对话历史+活动区（可独立滚动）；焦点面板四边框亮色 */
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
    dialogueTextW,
    activityTextW,
    queuedRows,
    viewportH,
  } = geom;
  // 状态列在最左、历史/活动区在右（自左至右：状态列 ‖ 历史区 ‖ 活动区）：
  // 左缘框格 = 状态列左缘；右缘框列 = 历史/活动区右缘（均非聚焦/模态态留空白占位）
  const useLeftFrame = geom.leftFrame;
  const useRightFrame = geom.rightFrame;
  // 当前活跃会话字段（goal 历史/todo/模式/策略/预设）：状态列与状态栏共用口径
  const { goals, todos, mode, policy, preset } = activeSessionFields(state);
  // 区域顶部为独立标题栏（会话标题行 + 实线下划线）。
  // 排列方式与两 pane 宽高在 frameGeometry 内一次算定（纵向：标题栏行数由对话区
  // 承担；横向：两 pane 等高，中间 1 列内部分隔竖线）。
  const horizontal = geom.mode === "horizontal";
  const diaStart = titleRows; // 内容行中历史区起点（标题栏之后）
  const diaEnd = geom.activitySepRow; // 活动区分隔行（横向无分隔行，此值 = 历史 pane 底边下一行）
  // 渐进窗口：只物化最近 windowGroups 个回合组（缺省 3），更早部分以顶部占位行示意；
  // 上滚接近窗口顶部时由 App 增大 windowGroups 再扩窗（不再每帧全量重排历史）
  const win = dialogueWindow(state.buffer, state.windowGroups);
  const { dialogue, activity } = buildContentRows(
    win.lines,
    {
      themeId: state.themeId,
      gutter: state.messageGutter,
      // 活动区详略两态（SPEC §6.8）：verbose=false → 紧凑（每条目 1 行 + 省略号，/verbose off）
      activityCompact: !state.activityVerbose,
      lineOffset: win.start,
      // P1：用户块首行左侧状态符号（✓/✗/■/? 与活跃块 ●/○/△）
      userStatus: userBlockSymbolResolver(state),
    },
    dialogueTextW,
    // 活动 pane 可用宽：横向与对话 pane 不同宽（P3 起两者差 1 列）；纵向两 pane 同宽
    horizontal ? activityTextW : dialogueTextW,
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
  // 顶行换算见 dialogueTopIdx：锚点行不可达时钉到下一段可用内容，不被拽向缓冲头
  const topIdx = Math.min(dialogueTopIdx(state, spans, maxTop), maxTop);
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

  // 状态列（最左）：恰「内容行数」行，每行宽 statusColWidth。
  // renderStatusColumn 自带右缘竖线，剥去不用，分隔竖线/外缘框格由本函数构图；
  // P7：垂直状态列隐藏（Ctrl+S）时不构建内容（宽度 0，渲染侧也不拼该段）
  const showStatusCol = statusColWidth > 0;
  const statusCells = !showStatusCol
    ? []
    : renderStatusColumn(
        goals,
        todos,
        state.jobs,
        state.statusColumnScroll,
        contentTopH,
        // 只传「状态列正文宽 + 末位竖线」：正文可见列 = statusColWidth − 外缘框格(1)
        // − 分隔竖线(1) = statusColWidth − 2（renderStatusColumn 末位自带竖线，剥去后
        // 与 statusBodyW 同宽）——传满宽会让拼行/折行多算一列，恰好拼满的行被截掉末字符
        statusColWidth - 1,
      );

  // 边框构图参数：分隔竖线列 = statusColWidth-1（状态列右缘/历史区左缘，
  // 为旧 historyWidth 的镜像）；col0 左缘框格属状态列，
  // 右缘框列 R 属历史/活动区。顶部边框行占 index 0，标题栏紧随其后，
  // 活动区分隔行自然位于 diaEnd 后一行。
  const statusBodyW = Math.max(
    0,
    statusColWidth - 1 - (useLeftFrame ? FRAME_LEFT_COLS : 0),
  );
  // 仅 statusFocused 保留（状态列内容偏移 statusCells[rc-1] 与 rc0 顶边占位）；
  // history/activity 焦点态不再影响顶部构图（框线由 focusFrame 统一覆写）
  const statusFocused = !geom.modalOpen && state.focusedPanel === "status";
  // 焦点中性基线：活动区分隔线 / 分隔竖线 / 左缘框格 / 右缘框列全部以灰
  // 边框色或空白占位产出；亮角字/亮边由 buildFrame 末尾的 focusFrame
  // 按焦点态覆写（TUI/docs/DESIGN.md §8，唯一焦点框机制）。
  const sepSegments = (): FrameSegment[] => [
    {
      text: ACTIVITY_SEPARATOR.repeat(Math.max(1, contentW)),
      style: { fg: "border" },
    },
  ];
  const rows: FrameRow[] = [];
  // 右缘边框列保留格（历史/活动区外缘）：无焦点为空白占位（focusFrame history/activity 焦点时覆写）
  const rightGlyph = (g: string): FrameSegment[] =>
    g === " " ? [seg(" ")] : [seg(g, { fg: "border" })];
  // 内容行（0..contentTopH-1）：标题栏 → 对话区 → 活动区分隔 → 活动区。
  // 中间分隔竖线（状态列右缘/历史区左缘）随焦点面板只亮其垂直边界：
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
  const activeBox = buildActivePanelBox(state, activityH, activityTextW);
  const modalPanel: ContentRow[] = activeBox
    ? fillPanelBox(activeBox, activityH, activityTextW, state.themeId)
    : [];
  const divFor = (rc: number): FrameSegment[] => {
    // 焦点中性基线：活动区分隔行 D 列=连接 `├`（竖线贯穿+横线右接入，
    // 与其他框线同为边框色）；titleRows 下划线行 D 列= `├`、其余内容行 D 列= `│`
    // 同为边框色；亮角字/亮边由 focusFrame 按焦点态覆写（status 焦点顶边此处 rc0 给空白占位）。
    if (rc === diaEnd && activityH > 0) return [seg("├", { fg: "border" })];
    if (rc === 0 && statusFocused) return [seg(" ")];
    if (titleRows > 1 && rc === diaStart - 1)
      return [seg("├", { fg: "border" })];
    return [seg("│", { fg: "border" })];
  };
  // 段数组补齐到定宽（横向两 pane 各自补齐，分隔竖线恒落在各自右边界）
  const padTo = (
    segs: FrameSegment[],
    w: number,
    fill = " ",
  ): FrameSegment[] => {
    const used = rowWidth2(segs);
    return used < w ? [...segs, seg(fill.repeat(w - used))] : [...segs];
  };
  /** 历史 pane 内容行（越界或排队块行 → undefined；排队块不属回合分隔线） */
  const dialogueRowAt = (rr: number): ContentRow | undefined =>
    rr >= 0 && rr < viewportH ? dialogueRows[vp.start + rr] : undefined;
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
    // col0：状态列左缘框格（段数组）——焦点中性基线恒空白占位，
    // 竖线/角字由 buildFrame 末尾 focusFrame 按焦点态覆写（DESIGN §8）。
    let left: FrameSegment[] = [];
    if (useLeftFrame) left = [seg(" ")];
    // 状态列正文（最左）：剥去 renderStatusColumn 自带右缘竖线（末段），
    // 正文截到 statusBodyW 定宽、右补空格，保证分隔竖线恒位于 D 列。
    const statusBody: FrameSegment[] = (() => {
      if (!showStatusCol) return [];
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
    // 区域内容（标题栏 / 历史区行 / 活动区分隔 / 活动区行）→ 段数组
    const contentSegs: FrameSegment[] = (() => {
      if (rc < diaStart) {
        // 标题栏：首行标题（空标题 <title> 灰占位保持行稳定）、次行实线下划线
        if (rc === 0) {
          // P7：标题栏首行 = preset 符号+名字 + 状态符号组 + 标题（窄宽按让位顺序收缩）
          return titleBarSegments(
            state,
            { mode, policy, preset },
            {
              verbose: state.activityVerbose,
              symbolUnify: state.symbolUnify,
              notifyEnabled: state.notifyEnabled,
            },
            contentW,
          );
        }
        // 下划线行：横向排列时内部竖线自此下行 → 该列让位 `┬`
        if (horizontal) {
          return [
            seg(SEPARATOR.repeat(Math.max(1, dialogueW)), { fg: "border" }),
            seg("┬", { fg: "border" }),
            seg(SEPARATOR.repeat(Math.max(1, activityW)), { fg: "border" }),
          ];
        }
        return [seg(SEPARATOR.repeat(Math.max(1, contentW)), { fg: "border" })];
      }
      if (horizontal) {
        // 横向：历史 pane（左）| 内部分隔竖线 | 活动 pane（右）——历史 pane 补齐到
        // dialogueW（让分隔竖线恒在固定列；回合分隔线用 ╌ 补齐=横线铺满 pane）；
        // **活动 pane 行尾不补空格**（内容到文字右缘为止，右侧留白列不落字形、
        // 也不画外缘框列）
        const dRow = dialogueRowAt(rc - diaStart);
        return [
          ...padTo(
            dialoguePaneSegs(rc - diaStart),
            dialogueW,
            dRow?.kind === "separator" ? TURN_SEPARATOR_CHAR : " ",
          ),
          seg("│", { fg: "border" }),
          ...activityPaneSegs(rc - diaStart),
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
    // 区域正文补齐到 contentW：右缘框列恒位于 R 列（不紧贴文字末尾）。
    // 例外：**活动区行**不补空格、也不画外缘框列（行到活动区文字右缘为止，
    // 右侧留白列不落任何字形；焦点框同样不画活动区右边框）。
    const actRow = horizontal ? rc >= diaStart : activityH > 0 && rc > diaEnd;
    // 回合分隔线行（kind=separator）属「横线」：铺满区域正文宽、外缘框列补 ╌，
    // 与边框行同口径（文字右缘留白只作用于文本行，横线一律顶到屏幕最右列）
    const ruleRow =
      !actRow && dialogueRowAt(rc - diaStart)?.kind === "separator";
    const contentW2 = rowWidth2(contentSegs);
    const padSegs: FrameSegment[] =
      !actRow && contentW2 < contentW
        ? [
            seg(
              (ruleRow ? TURN_SEPARATOR_CHAR : " ").repeat(
                contentW - contentW2,
              ),
            ),
          ]
        : [];
    // 右缘框列（历史/活动区外缘）：焦点中性基线恒空白占位（history/activity 焦点
    // 由 focusFrame 覆写 ┐/│/┘）；**水平边框行**（标题栏下划线 / 活动区分隔行）
    // 例外——该列补 `─`，横线铺满整行到屏幕最右列（边框不留缺口）。
    const borderRow =
      (titleRows > 1 && rc === diaStart - 1) ||
      (rc === diaEnd && activityH > 0);
    const right = borderRow ? SEPARATOR : ruleRow ? TURN_SEPARATOR_CHAR : " ";
    // 行拼装（自左至右）：状态列外缘框格 ‖ 状态列正文 ‖ 分隔竖线 ‖ 区域正文 ‖ 区域外缘框列
    // P7：垂直状态列隐藏时，左缘框格 / 状态列正文 / 分隔竖线三段都不拼
    const rowSegments: FrameSegment[] = [
      ...(showStatusCol ? left : []),
      ...(showStatusCol ? statusBody : []),
      ...(showStatusCol ? divFor(rc) : []),
      ...contentSegs,
      ...padSegs,
      ...(useRightFrame && !actRow ? rightGlyph(right) : []),
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
  /** 输入状态：非空时在状态栏首行最左侧渲染状态符号（✓/✗/●/○/△/?） */
  inputStatus?: InputStatus,
  /** 运行中 ●/○ 交替相位（本回合虚拟总 token；running 且缺省时回落 ○） */
  runVirtTokens?: number,
  /** 主题（横向 Box fill 折行/着色用；缺省 dark 兼容直接调用方） */
  themeId: ThemeId = "dark",
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

  // 状态栏按类分组（组间 `•` 分隔、组内 `•` 分隔）：
  //   环境组：time • git • cwd            （本机/工作区信息，与会话无关）
  //   LLM 组：model:{后缀} • ctx • cache  （最近一次模型调用指标）
  // 每个「逻辑段」= 多个 FrameSegment（点击色可分多段，如 provider/model/:后缀），
  // 组内逻辑段之间插 `•`、物理段之间不插。
  // P1：状态符号段已迁至**用户块首行左侧**（见 userBlockSymbol），状态栏不再承载符号；
  // 首行行首回到 1 空格留边（与其他行一致）
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

  // 组段（组内逻辑段间插 `•` 圆点；单组超行宽时用组内压缩版）
  const dotJoin = (g: FrameSegment[][]): FrameSegment[] =>
    g.flatMap((s, si) => [
      ...(si > 0 ? [{ text: "•" } as FrameSegment] : []),
      ...s,
    ]);
  const segWidth = (segs: FrameSegment[]): number =>
    segs.reduce((a, x) => a + displayWidth(x.text), 0);
  const fulls = [dotJoin(envFull), dotJoin(llmFull)];
  const fits = [dotJoin(envFit(maxSegW)), dotJoin(llmFit(maxSegW))];
  const pick = (gi: number): FrameSegment[] =>
    segWidth(fulls[gi]!) > maxSegW ? fits[gi]! : fulls[gi]!;

  // 行分组决策（组为整体不拆，放不下整组换行；单组超行宽才组内压缩）：
  // 每行 = 组索引列表，行内组间以横向 Box 框线分隔
  const rowPlan: number[][] = [[]];
  let used = 0;
  for (let gi = 0; gi < fulls.length; gi++) {
    const segs = pick(gi);
    const gap = used > 0 ? 1 : 0;
    if (used > 0 && used + gap + segWidth(segs) > maxSegW) {
      rowPlan.push([]);
      used = 0;
    }
    rowPlan[rowPlan.length - 1]!.push(gi);
    used += (used > 0 ? 1 : 0) + segWidth(segs);
  }

  // 每行 → 横向 Box（组间以 `•` 圆点分隔，占 1 列由 measure/allocate 预留、
  // fill 逐行插圆点）→ 摊平成一行。行首/行尾各留 1 空格（「首尾空格留边」）；
  // P1 起不再有状态符号段（符号迁至用户块首行）
  return rowPlan.map((plan) => {
    const children = plan.map((gi, i) => {
      const segs: FrameSegment[] = [];
      if (i === 0) segs.push({ text: " " }); // 行首留边
      segs.push(...pick(gi));
      if (i === plan.length - 1) segs.push({ text: " " }); // 行尾留边
      return styled(segs, { wrap: false });
    });
    const box = h(
      children,
      plan.length > 1
        ? { separator: { char: "•", color: "plain" as const } }
        : {},
    );
    const out = fillBoxTree(box, 1, cols, themeId);
    return out[0] ?? { segments: [] };
  });
}

/**
 * 状态栏框线竖线（边框色 `│`）在行内的列位置列表（0 基，升序去重）。
 * 覆盖两类竖线：组间框线（纯 `│` 段）与符号右侧分隔竖线（lead 复合段
 * ` │ ` 中的 `│`）。buildFrame 用它在上/下横线对应列画交点（┬/┴），
 * 使竖线两端与横线相接成格。
 */
export function statusBarSeamCols(row: FrameRow | undefined): number[] {
  if (!row) return [];
  const cols: number[] = [];
  let col = 0;
  for (const seg of row.segments) {
    if (seg.style?.fg === "border") {
      const i = seg.text.indexOf("│");
      if (i >= 0) cols.push(col + displayWidth(seg.text.slice(0, i)));
    }
    col += displayWidth(seg.text);
  }
  return [...new Set(cols)].sort((a, b) => a - b);
}

/**
 * 运行中符号交替阈值：每累计 RUN_TOGGLE_TOKENS 个**虚拟 token** 切换一次 ●/○。
 * 虚拟 token 由虚拟速度对时间积分而来（见 nextRunVirt），因此
 * **切换率（toggle/s，每秒符号变化次数）= 虚拟速度 / RUN_TOGGLE_TOKENS**；
 * 相位停留时长 = 其倒数，完整周期（●→○→●）= 2 × 相位停留。
 */
export const RUN_TOGGLE_TOKENS = 16;

// ---- 参数层次（P4）：语义参数（频率/时长）在前，派生量在后，调参只动语义参数 ----

/**
 * 符号切换率下限（toggle/s：**每秒符号变化次数**，非完整周期数——完整周期频率
 * 为该值的一半，即 1 toggle/s ⟺ ●→○→● 一个周期 2s）。真实速率再低也保持此
 * 切换率（防卡死感）：相位停留 1s。
 */
export const RUN_TOGGLE_FREQ_MIN = 1;
/**
 * 符号切换率上限（toggle/s：每秒符号变化次数）：真实速率再高也不超过此切换率
 * （防闪瞎）：相位停留 0.2s，完整周期 0.4s。
 */
export const RUN_TOGGLE_FREQ_MAX = 5;
/** 虚拟速度下限（估算 token/s）= 最低切换率 × 每切换 token 数（相位停留 1s） */
export const VIRT_SPEED_MIN = RUN_TOGGLE_FREQ_MIN * RUN_TOGGLE_TOKENS; // 16
/** 虚拟速度上限（估算 token/s）= 最高切换率 × 每切换 token 数（相位停留 0.2s） */
export const VIRT_SPEED_MAX = RUN_TOGGLE_FREQ_MAX * RUN_TOGGLE_TOKENS; // 80
/** 速率估计窗口时间常数（秒）：指数加权窗口（分子分母分别衰减）——速率估计
 *  的时间尺度与事件频率无关（P1 时间一致），且抗单帧 chunk 噪声（P2） */
export const VIRT_RATE_TAU = 0.5;
/** 虚拟速度从下限爬到上限的过渡时长（秒）：slew 速率 = 速度范围 / 该时长，
 *  使"防突变"与时间尺度无关（P1：速率限制而非每帧绝对量） */
export const RUN_SPEED_RAMP_SECS = 2 / 3;
/** 虚拟速度最大变化率（估算 token/s²）：目标突变时按此速率平滑逼近 */
export const VIRT_SLEW_RATE =
  (VIRT_SPEED_MAX - VIRT_SPEED_MIN) / RUN_SPEED_RAMP_SECS; // 96
/** 虚拟速度无数据时的指数衰减时间常数（秒）：没有流式数据到达时速度按
 *  v(t) = MIN + (v₀ − MIN)·e^(−t/τ) 回落，虚拟总 token 按衰减中的速度持续积分——
 *  闪烁频率逐渐降到最低而不会停止（前提：agent 仍活跃，App 持续发 virt-tick） */
export const VIRT_DECAY_TAU = 6;
/** 估算 token 校准系数范围（P5）：用流末 usage 真值校正启发式估算，限定合理区间 */
export const TOKEN_CALIB_MIN = 0.25;
export const TOKEN_CALIB_MAX = 4;
/** 校准系数 EMA 平滑（新样本权重）：单次 usage 波动大，平滑后跨 step 稳定生效 */
export const TOKEN_CALIB_ALPHA = 0.3;

/**
 * 流式文本 → 估算 token 数（消费端近似，与宿主 token-meter 同族启发式）：
 * 宽字符（CJK/全角/emoji，显示宽 2 列）≈ 1 token，窄字符 ≈ 0.25 token，
 * 零宽不计。全中文 16 字符 ≈ 16 token、全英文 64 字符 ≈ 16 token。
 * 可用流末 usage 真值经 tokenCalib 校正（见 TOKEN_CALIB_*）。
 */
export function estimateOutputTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (w >= 2) tokens += 1;
    else if (w === 1) tokens += 0.25;
  }
  return tokens;
}

/** 运行中闪烁虚拟状态（与真实 tps 解耦的“速度”与“总 token”） */
export interface RunVirtState {
  /** 虚拟速度（估算 token/s；窗口速率估计 + slew 速率限制 + 上下限 clamp） */
  speed: number;
  /** 虚拟总 token（按虚拟速度对时间积分；触发 ●/○ 切换；run 边界见 state.ts） */
  tokens: number;
  /** 上次流式更新时刻（ms；undefined = 本 run 尚无时间基准） */
  lastTime?: number;
  /** 速率估计窗口：指数加权累计数据量（估算 token） */
  winTokens: number;
  /** 速率估计窗口：指数加权累计时长（秒）；速率 = winTokens / winSecs */
  winSecs: number;
}

/** 空虚拟状态（run 开始/用户输入重置用）：速度为下限（保证 speed 恒在
 *  [VIRT_SPEED_MIN, VIRT_SPEED_MAX] 界内，避免首帧被下限 clamp 绕过 slew 跳升） */
export function emptyRunVirt(): RunVirtState {
  return {
    speed: VIRT_SPEED_MIN,
    tokens: 0,
    lastTime: undefined,
    winTokens: 0,
    winSecs: 0,
  };
}

/** 虚拟总 token → 闪烁相位（0 = ●，1 = ○）；App 据此判断是否需要重绘（P5） */
export function runPhase(tokens: number): 0 | 1 {
  return (Math.floor(tokens / RUN_TOGGLE_TOKENS) % 2 === 0 ? 0 : 1) as 0 | 1;
}

/**
 * 每次收到流式输出时推进虚拟状态（时间一致，P1/P2）：
 *  - 速率估计：指数加权窗口（P2）——分子（数据量）与分母（时长）分别按
 *    e^(−Δt/τ) 衰减后累计，速率 = Σw·Δtoken / Σw·Δt；比两点差分抗单帧噪声，
 *    且窗口权重只依赖真实时长（P1，与事件频率无关）
 *  - 目标速度 = clamp(窗口速率, [MIN, MAX])
 *  - 变化率限制（P1）：单帧最多移动 VIRT_SLEW_RATE × Δt（速率限制，非每帧绝对量）
 *  - 虚拟总 token 按虚拟速度积分（与真实速率解耦）
 * 无时间基准或时间未推进时不更新（仅登记基准）。`delta` 为本次估算 token 数
 * （调用方已按 tokenCalib 校正）。
 */
export function nextRunVirt(
  prev: RunVirtState,
  time: number | undefined,
  delta: number,
): RunVirtState {
  if (
    time === undefined ||
    prev.lastTime === undefined ||
    time <= prev.lastTime
  ) {
    return { ...prev, lastTime: time ?? prev.lastTime };
  }
  // P5：Δt 下限 1ms（事件循环批量处理时可能同 tick 多帧，防速率被极端放大）
  const dtSec = Math.max(time - prev.lastTime, 1) / 1000;
  // P2：速率估计窗口（分子分母分别指数衰减 → 加权总速率）
  const decay = Math.exp(-dtSec / VIRT_RATE_TAU);
  const winTokens = prev.winTokens * decay + delta;
  const winSecs = prev.winSecs * decay + dtSec;
  const real = winSecs > 0 ? winTokens / winSecs : 0;
  // 目标速度（clamp 到频率界限）
  const target = Math.min(VIRT_SPEED_MAX, Math.max(VIRT_SPEED_MIN, real));
  // P1：变化率限制（速率化 slew）
  const maxDelta = VIRT_SLEW_RATE * dtSec;
  const stepped =
    prev.speed + Math.min(maxDelta, Math.max(-maxDelta, target - prev.speed));
  const speed = Math.min(VIRT_SPEED_MAX, Math.max(VIRT_SPEED_MIN, stepped));
  return {
    speed,
    tokens: prev.tokens + speed * dtSec,
    lastTime: time,
    winTokens,
    winSecs,
  };
}

/**
 * 无流式数据到达时推进虚拟状态（时间驱动，App 在 running 期间周期性调用）：
 * 虚拟速度按指数衰减回落到下限（v(t) = MIN + (v₀−MIN)·e^(−t/τ)），虚拟总 token
 * 按衰减中的速度**持续积分**（∫v(s)ds = MIN·Δt + (v₀−MIN)·τ·(1−e^(−Δt/τ))）——
 * 即使一段时间没有数据，闪烁也不停止，只逐渐降到最低频率。速率估计窗口同步
 * 按 VIRT_RATE_TAU 衰减（忘记旧数据，避免下次数据到达时速率被长期均值拖住）。
 * 无时间基准或时间未推进时原样返回。
 */
export function virtTick(prev: RunVirtState, time: number): RunVirtState {
  if (prev.lastTime === undefined || time <= prev.lastTime) return prev;
  const dtSec = (time - prev.lastTime) / 1000;
  const decay = Math.exp(-dtSec / VIRT_DECAY_TAU);
  const speed = Math.max(
    VIRT_SPEED_MIN,
    VIRT_SPEED_MIN + (prev.speed - VIRT_SPEED_MIN) * decay,
  );
  const tokens =
    prev.tokens +
    VIRT_SPEED_MIN * dtSec +
    (prev.speed - VIRT_SPEED_MIN) * VIRT_DECAY_TAU * (1 - decay);
  const winDecay = Math.exp(-dtSec / VIRT_RATE_TAU);
  return {
    speed,
    tokens,
    lastTime: time,
    winTokens: prev.winTokens * winDecay,
    winSecs: prev.winSecs * winDecay,
  };
}

/** 运行中状态符号：按虚拟总 token 相位取 ●（偶数段）/ ○（奇数段）；
 *  无计数（直接调用方未提供）时回落空心圆 ○ */
function runningSymbol(runVirtTokens: number | undefined): string {
  if (runVirtTokens === undefined) return "○";
  return runPhase(runVirtTokens) === 0 ? "●" : "○";
}

/** P1：用户块首行左侧状态符号与配色（2 列前缀 = 符号 + 1 空格）：
 *  绿 ✓ 成功 / 红 ✗ 失败 / 灰 ■ 中止；无终态回退默认前景 `?`。 */
const USER_BLOCK_SYMBOL: Record<
  "success" | "failure" | "aborted",
  { text: string; fg: ColorName }
> = {
  success: { text: "✓", fg: "green" },
  failure: { text: "✗", fg: "red" },
  aborted: { text: "■", fg: "gray" },
};

/** P1：用户块首行符号解析器——状态在 layout 侧算定，build-box 只负责画。
 *  - 终态：取本行 `status`（turn-end 时按 reason 打标）；
 *  - 活跃块（buffer 里最后一个 `status` 未定的 user 行）：等待交互（审批/问答面板打开）
 *    显示黄 △；运行中显示黄 ●/○（沿用虚拟 token 交替相位）；
 *  - 其余无终态块回退 `?`（恢复的历史、未收到 turn/end 的块）；
 *  - 排队块（布局层由 `state.queued` 单独渲染）不显示符号。 */
function userBlockSymbolResolver(
  state: AppState,
): (line: BufferLine) => { text: string; fg?: ColorName } | undefined {
  // 活跃块 = **最后一条**用户输入，且其终态未定；不往前找——更早的未终态块（例如上一回合
  // 以 blocked 收尾，宿主没落终态）属历史，只显示 `?`，不该跟着当前运行状态闪 ●/○ 或 △
  let activeSeq: number | undefined;
  for (let i = state.buffer.length - 1; i >= 0; i--) {
    const l = state.buffer[i]!;
    if (l.kind !== "user") continue;
    if (l.status === undefined) activeSeq = l.seq;
    break;
  }
  const waiting =
    state.approval !== null ||
    state.question !== null ||
    state.inputStatus === "waiting";
  // P8：压缩上下文期间也算「忙」（用户块显示运行中 ●/○）
  const running =
    !waiting &&
    (state.agentStatus !== "idle" ||
      state.inputStatus === "running" ||
      isCompacting(state));
  const runSymbol = runningSymbol(state.runVirt.tokens);
  return (line) => {
    if (line.kind !== "user" || line.queued) return undefined;
    if (line.status) return USER_BLOCK_SYMBOL[line.status];
    if (activeSeq !== undefined && line.seq === activeSeq) {
      if (waiting) return { text: "△", fg: "yellow" as ColorName };
      if (running) return { text: runSymbol, fg: "yellow" as ColorName };
    }
    return { text: "?" }; // 无终态
  };
}
/** 提示符 = 当前输入模式符号（normal > / shell $ / slash /；默认前景色，不着色） */
const MODE_SYMBOL: Record<InputMode, string> = {
  normal: ">",
  shell: "$",
  slash: "/",
};

/** 当前活跃会话的目标/todo/模式/策略/预设/运行中任务数（状态栏与整页高度共用口径） */
function activeSessionFields(state: AppState): {
  goals?: GoalHistory;
  todos?: TodoItemLike[];
  mode?: ModeState;
  policy?: "ask" | "never";
  preset?: string;
} {
  const goals = state.activeSessionId
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
  return { goals, todos, mode, policy, preset };
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
 * 无焦点/模态态全边框色 `─`。左侧状态列底边（status 焦点亮、col0 左下角 └），
 * 右侧历史/活动区底边（activity 焦点亮、R 列右下角 ┘），D 列 ┴ 为共用角。
 * seamCols：状态栏框线竖线列（0 基数组）——竖线在横线**下方**（状态栏内），
 * 该列画 `┬` 与竖线相接（竖线自横线向下伸入状态栏）；D 列/内部分隔列竖线在
 * 横线**上方**（topRegion），交点画 `┴`（竖线自横线向上顶住）。 */
export function buildStatusSeparator(
  geom: FrameGeometry,
  themeId: ThemeId,
  sepFocus: "none" | "status" | "activity",
  /** 状态栏框线竖线列（0 基）：该列画 ┬ 与状态栏竖线相接；缺省不画 */
  seamCols?: number[],
): FrameRow {
  // 焦点中性基线：状态区上方分隔行恒灰 `─`（col0 非 status 底角 └、D 列 ┴
  // border、右缘非 activity 右下角 ┘）；亮角字/亮边由 buildFrame 末尾 focusFrame
  // 按焦点态覆写（status 顶/底边、activity 底边 └┘、history 底边 ┴ 等）。
  // sepFocus / themeId 参数保留（契约兼容），焦点绘图不再在此进行。
  void sepFocus;
  void themeId;
  // 尺寸全部取自几何（分隔竖线列/两外缘框列/内部分隔列与帧内其它部分同源）
  const D = geom.dividerCol; // 分隔竖线列（状态列右缘/历史区左缘）
  const R = geom.cols - 1;
  const out: FrameSegment[] = [];
  const segN = (n: number): FrameSegment[] => {
    if (n <= 0) return [];
    return [{ text: STATUS_TOP_SEPARATOR.repeat(n), style: { fg: "border" } }];
  };
  // 内部分隔列（横向排列）只有落在 D 列右侧、R 列之前才是有效交点（否则回落不画）
  const inner =
    geom.innerDividerCol !== undefined &&
    geom.innerDividerCol > D &&
    geom.innerDividerCol <= R
      ? geom.innerDividerCol
      : undefined;
  // 交点列 → 字符：状态栏框线竖线在横线**下方**（`┬`）；D 列/内部分隔列竖线在
  // 横线**上方**（`┴`）；同列两者都有 → `┼`（否则只按一侧选字会让另一侧竖线断开，
  // 如段分隔竖线恰好落在 D 列时状态列右边框出现空白）。
  const upCols = new Set<number>();
  if (inner !== undefined) upCols.add(inner);
  if (D >= 0 && D <= R) upCols.add(D);
  const downCols = new Set<number>();
  for (const c of seamCols ?? []) if (c >= 0 && c <= R) downCols.add(c);
  const cols = [...new Set([...upCols, ...downCols])].sort((a, b) => a - b);
  let cursor = 0;
  for (const col of cols) {
    if (col < cursor) continue;
    out.push(...segN(col - cursor));
    out.push({
      text: teeGlyph(upCols.has(col), downCols.has(col)),
      style: { fg: "border" },
    });
    cursor = col + 1;
  }
  out.push(...segN(Math.max(0, R - cursor)));
  // R 列（历史/活动区外缘框列）：灰 `─`（history/activity 焦点由 focusFrame 覆写 ┴/┘）；
  // 该列已被交点占用（cursor > R）时不再补，保证行宽恒为 cols
  if (cursor <= R)
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

/**
 * 帧段表（纯函数，零排版开销）：由几何推导各**行带**的屏幕行范围。
 * 行带顺序与 buildFrame 的拼接顺序一致——top（活动/对话区 + 状态列）→
 * status（状态栏含其上下两条分隔行）→ footer（交互区）→ hint（按键提示区）。
 * 渲染层用它把「变化行区间」按段切分：多段同时变化时只重写各自段内的变化行，
 * 不跨越中间未变化的段（窗口偏移只影响 top 段内容）。
 */
export function frameSections(geom: FrameGeometry): FrameSection[] {
  const top = Math.max(0, geom.contentTopH);
  // 状态段含上下分隔行（视觉同属状态区边界，且底分隔行的交点列随状态栏变化）
  const status = geom.statusHeight + 2;
  const footer = geom.footerHeight;
  const hint = geom.hintHeight;
  const sections: FrameSection[] = [
    { id: "top", startLine: 0, lineCount: top },
    { id: "status", startLine: top, lineCount: status },
    { id: "footer", startLine: top + status, lineCount: footer },
  ];
  if (hint > 0) {
    sections.push({
      id: "hint",
      startLine: top + status + footer,
      lineCount: hint,
    });
  }
  return sections;
}

/** buildFrame 的可选回填输出（与 report 同模式：避免重复计算几何） */
export interface FrameBuildOutput {
  /** 帧段表（行带范围；渲染层区间重写用，见 frameSections） */
  sections?: FrameSection[];
  /** 输入焦点信息（3.1.3）：App 原样转发给 renderer，决定重写结束后光标收尾 */
  focus?: FrameFocus;
}

export function buildFrame(
  state: AppState,
  size: Size,
  report?: FrameScrollReport,
  out?: FrameBuildOutput,
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
    modalOpen,
  } = geom;
  const topRegion = buildTopRegion(state, geom, report);

  let footerLines: FrameRow[];
  // 审批/问答/模型选择/状态选项/任务/历史会话面板 + 输入补全均上移到流输出（活动区）窗口显示；
  // 输入补全不占输入区（输入行与光标必须可见），其余面板打开时 footer 以空白占位（交互区高度稳定）。
  if (modalOpen) {
    footerLines = Array.from({ length: geom.footerHeight }, () => ({
      segments: [seg(" ".repeat(fullWidth))],
    }));
  } else {
    // 单字符提示符：当前输入模式符号（MODE_SYMBOL[inputMode]，默认前景色不着色）；
    // 上次命令结果/运行状态符号已移至水平状态栏最左侧（STATUS_SYMBOL）。
    // prompt 预先分段，renderTextInput 宽度按未着色文本计算。
    const prompt: FrameSegment[] = [
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
  // 按键提示区恒占 1 行；当前状态文案由 hints.ts 统一提供。
  const hintLines: FrameRow[] = [
    {
      segments: [seg(truncateToWidth(hintLine(state), fullWidth))],
    },
  ];

  // 分隔行（边框统一边框色：先纯文本截断再段化）。状态区上方与其余横线同为 `─`；
  // 焦点在底部为流输出/状态列时该行用亮色框（钩到面板底边）。
  // teeCols：状态栏框线竖线列——竖线在横线**上方**（状态栏内），该列画 `┴`
  // 与竖线相接（竖线自横线向上顶住；上横线交点 ┬ 在 buildStatusSeparator）。
  const makeSep = (
    ch: string,
    color: ColorName = "border",
    teeCols?: number[],
  ): FrameRow => {
    const valid = (teeCols ?? []).filter((c) => c > 0 && c < fullWidth - 1);
    if (valid.length === 0)
      return {
        segments: [
          seg(truncateToWidth(ch.repeat(fullWidth), fullWidth), { fg: color }),
        ],
      };
    const out: FrameSegment[] = [];
    let cursor = 0;
    for (const c of [...new Set(valid)].sort((a, b) => a - b)) {
      out.push(seg(ch.repeat(c - cursor), { fg: color }));
      out.push(seg("┴", { fg: color }));
      cursor = c + 1;
    }
    out.push(seg(ch.repeat(fullWidth - cursor), { fg: color }));
    return { segments: out };
  };
  // 状态区上方分隔行的焦点语义（modal 态无焦点回 none）
  let statusSepFocus: "none" | "status" | "activity" = "none";
  if (!modalOpen) {
    if (state.focusedPanel === "status") statusSepFocus = "status";
    else if (state.focusedPanel === "activity") statusSepFocus = "activity";
  }
  // 状态栏框线竖线列：上横线按首行竖线画交点 ┬（竖线自横线向下伸入状态栏）、
  // 下横线按末行竖线画交点 ┴（竖线自横线向上顶住状态栏），两端相接成格
  const topSeams = statusBarSeamCols(geom.statusLines[0]);
  const lastLine = geom.statusLines[geom.statusLines.length - 1];
  const bottomSeams = statusBarSeamCols(lastLine);
  const rects: Map<PaneId, Rect> = new Map();
  const rows: FrameRow[] = [
    ...topRegion,
    buildStatusSeparator(geom, state.themeId, statusSepFocus, topSeams),
    ...geom.statusLines,
    makeSep(SEPARATOR, "border", bottomSeams),
    ...footerLines,
    ...hintLines,
  ];
  // 焦点框全局覆写：buildTopRegion/buildStatusSeparator 已产出焦点中性基线，
  // 末帧一次扫描按焦点分区矩形（帧坐标，right=x+w-1/bottom=y+h-1）覆写亮
  // 角字/边线（TUI/docs/DESIGN.md §8 / SPEC.md §8 唯一焦点框机制）。模态态（面板打开）
  // 焦点用 null 传入：面板占活动区时无焦点框高亮。
  const underlineRow = Math.max(0, titleRows - 1);
  const diaEnd = geom.activitySepRow; // 纵向=活动区分隔行；横向=历史 pane 底边下一行
  // 区域矩形：左缘 = 分隔竖线列 D（状态列右缘，与状态列共用该框线；隐藏状态列时
  // D = -1 → 左缘取 0，区域吃满整宽）、右缘 = R 列（区域外缘框列）——两 pane 正文
  // 恰在两缘之间（contentW 列）
  const regionX = Math.max(0, geom.dividerCol);
  const regionW = geom.cols - regionX;
  if (geom.mode === "horizontal") {
    // 横向排列：历史 pane 在左、活动 pane 在右、两 pane 等高——顶=标题栏下划线行，
    // 底=状态区上方分隔行 contentTopH；内部分隔列 = history 右缘 / activity 左缘
    const h = Math.max(1, contentTopH - underlineRow + 1);
    const divCol = innerDividerCol ?? geom.cols - 1;
    rects.set("history", {
      x: regionX,
      y: underlineRow,
      w: divCol - regionX + 1,
      h,
    });
    rects.set("activity", {
      x: divCol,
      y: underlineRow,
      w: geom.cols - divCol,
      h,
    });
  } else {
    // history 矩形：顶=标题栏下划线行（titleRows>=2 才有下划线；否则顶=首历史行）、
    // 底=活动区分隔行 diaEnd
    rects.set("history", {
      x: regionX,
      y: underlineRow,
      w: regionW,
      h: Math.max(1, diaEnd - underlineRow + 1),
    });
    // activity 矩形：顶=活动区分隔行 diaEnd、底=状态区上方分隔行 contentTopH
    rects.set("activity", {
      x: regionX,
      y: diaEnd,
      w: regionW,
      h: Math.max(1, contentTopH - diaEnd + 1),
    });
  }
  // status 矩形：x=0（屏幕最左=状态列外缘）、右缘=D 列、顶=帧顶 rc0、底=状态区上方分隔行
  rects.set("status", {
    x: 0,
    y: 0,
    w: statusColWidth,
    h: Math.max(1, contentTopH + 1),
  });
  focusFrame(
    {
      themeId: state.themeId,
      // P7：状态列隐藏时不聚焦 status（宽 0 的焦点框会压掉内容首列）
      focusedPanel: modalOpen
        ? null
        : state.focusedPanel === "status" && statusColWidth === 0
          ? null
          : state.focusedPanel,
      // 结构行号：status 焦点 D 列竖线区分下划线行（灰）与活动分隔行（亮 ├）
      titleUnderlineRow: underlineRow,
      activitySepRow: diaEnd,
      // 横向排列：history 右缘/activity 左缘 = 内部分隔列（缺省走 D 列）
      innerDividerCol,
      // 状态区上方分隔行（buildStatusSeparator）：被焦点覆写为 ─ 后恢复框线交点
      statusSepRow: contentTopH,
      statusSeamCols: topSeams,
    },
    rects,
    rows,
  );
  // 帧段表回填（几何已算定，零额外开销）：渲染层按段切分变化区间
  if (out) out.sections = frameSections(geom);
  // 输入焦点回填（3.1.3）：渲染器据此决定「重写结束后是否把光标定位回输入位置」——
  // 仅输入态（!modalOpen）允许显示光标；位置从帧内输入行直接取（唯一来源）
  if (out) out.focus = frameFocus(rows, !modalOpen);
  return rows;
}

/**
 * 从帧行提取输入焦点信息（3.1.3）：caret 只出现在底部输入行（见 renderTextInput），
 * 扫描帧行取第一个带 caret 的行即为输入位置（**帧内 1 基行号 + 0 基列**）。
 * 面板态 / 无输入行时只回 inputFocus，渲染器据此保持光标隐藏。
 */
export function frameFocus(rows: FrameRow[], inputFocus: boolean): FrameFocus {
  for (let i = 0; i < rows.length; i++) {
    const col = rows[i]?.caret;
    if (col !== undefined) {
      return { inputFocus, caret: { row: i + 1, col } };
    }
  }
  return { inputFocus };
}
