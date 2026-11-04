// TUI/src/app/layout/frame-rows.ts — 帧行基础（行文本 / 提示行折行 / 窗口常量 / 滚动量）

import type { FrameRow } from "../../renderer/index.ts";
import type { AppState } from "../state.ts";
import { isUserMessage } from "../state.ts";
import { hintLine } from "./hints.ts";
import { focusColor } from "./focus-frame.ts";
import { displayWidth } from "./markdown.ts";
import { wrapLine } from "./primitives.ts";

// TUI/src/app/layout/frame-rows.ts — 帧行基础（行文本 / 提示行折行 / 窗口常量 / 滚动量）

/** 行纯文本 = 各段 text 拼接（剥离样式；测试/宽度计算用） */
export function rowText(row: FrameRow): string {
  return row.segments.map((s) => s.text).join("");
}

// ---------- 会话区视口 ----------

/** 会话区可见窗口（`buildTopRegion` 内回填 `FrameScrollReport` 与 pane 取行用）。
 *  旧的 `ViewportInput` / `computeViewport`（followBottom + scrollOffset 模型）已随
 *  六步流水线退场，2026-10-10 删除；本结构只剩「段表算定后的窗口四个字段」。 */
export interface Viewport {
  start: number; // segTable 内可见起始下标
  end: number; // 结束下标（不含）
}

// ---------- 帧组装 ----------

/** 上/中/下三区之间的横线分隔行数 */
export const SEPARATOR_ROWS = 2;

// 按键提示行文案见 ./layout/hints.ts（唯一来源；面板内不再画提示，全部走提示行）。

/**
 * 提示行折行（2026-10-14 用户裁定：提示行允许 2 行、超宽折行，不再截断）。
 * 优先在 ` · ` 边界折行（键位与标签不被拆开）；单个条目本身超宽时先按显示宽度硬折，
 * 尾行再继续接纳后续条目（极窄终端下退化得可控：` · ` 允许被拆到两行）。
 * 空串 → 一行空串（占位语义不变）。
 */
export function wrapHintLine(
  text: string,
  width: number,
  /** 提示行最多占几行（契约「1 至 2 行」；超出部分截断——极窄终端下不吞掉正文区） */
  maxRows = 2,
): string[] {
  if (text === "") return [""];
  if (width <= 0) return [text];
  const parts = text.split(" · ");
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const sep = i > 0 ? " · " : "";
    const sepW = displayWidth(sep);
    const partW = displayWidth(part);
    if (cur === "" || curW + sepW + partW <= width) {
      cur += sep + part;
      curW += sepW + partW;
      continue;
    }
    rows.push(cur);
    cur = part;
    curW = partW;
  }
  if (cur !== "") rows.push(cur);
  // 单条目本身超宽（极窄终端）：按显示宽度硬折，保证每行都不超宽
  const out: string[] = [];
  for (const row of rows) {
    if (displayWidth(row) <= width) out.push(row);
    else out.push(...wrapLine(row, width));
  }
  return out.length > 0 ? out.slice(0, Math.max(1, maxRows)) : [""];
}

/** 当前状态提示行占用行数（frameGeometry 用它定提示行高；至少 1 行，空文案也占位） */
export function hintRowsFor(state: AppState, width: number): number {
  return Math.max(1, wrapHintLine(hintLine(state), width).length);
}
/** 渐进窗口：默认物化最近 DIALOGUE_KEEP_REPLIES 个回合组，上滚接近窗口顶部时按步长扩窗 */
export const DIALOGUE_KEEP_REPLIES = 3;
/** 渐进窗口增窗步长（上滚触发时一次多物化的回合组数） */
export const WINDOW_GROW_STEP = 3;
export const DIALOGUE_MORE = "...(更早回复已折叠)";

/**
 * 回合组切分（渐进窗口的物化单位）：组起点 = 用户消息行，或进入会话区的
 * **final assistant 段首行**（无用户消息前缀的恢复会话/agent 自发回合按回复切分，
 * 保证「最近 N 组回复」在任何 buffer 形态下都能切开——否则永不折叠）。
 * **非 final 的 assistant（思考/工具之间的回合区中间输出）不算组起点**：
 * 否则 agent 持续输出会撑大组数、把历史旧回复挤出物化窗口（历史被回合区“推着滚动”）。
 * 首行不属于任何起点时补一个 0 起点（头部残段自成一组）。
 */
export function turnGroupStarts(
  local: readonly { kind: string; final?: boolean | undefined }[],
): number[] {
  const starts: number[] = [];
  for (let i = 0; i < local.length; i++) {
    const line = local[i]!;
    const kind = line.kind;
    const prev = i > 0 ? local[i - 1]!.kind : undefined;
    const userStart = isUserMessage(kind) && !isUserMessage(prev);
    // 与历史一致：紧邻 user 的答复并入该用户组；无 user 前缀的 final 回复自成一组
    const replyStart =
      kind === "assistant" &&
      line.final === true &&
      prev !== "assistant" &&
      !isUserMessage(prev);
    if (userStart || replyStart) starts.push(i);
  }
  if (starts.length === 0 || starts[0]! > 0) starts.unshift(0);
  return starts;
}
export const FRAME_LEFT_COLS = 1;
export const FRAME_RIGHT_COLS = 1;

/** 区域 pane **文字**右缘留白（列）：只有**右缘贴着外框列**的文字排版宽需要再收窄。
 *  - 横向排列：会话区（左）右缘接内部分隔竖线 → **不留白**（`┃` 紧贴竖线）；
 *    回合区（右）右缘贴外缘框列 → 让 1 列。
 *  - 纵向排列：两 pane 同列同宽、共享右缘 → 让 1 列（原为各让 2 列）。
 *  - **只缩文字**：边框/分隔线一概不动——标题栏下划线、回合区分隔线、状态行框线与
 *    分隔行仍铺满整行（到区域外缘框列 `FRAME_RIGHT_COLS`），焦点框矩形也不变。
 *  - 目的：字形宽度算错（CJK/组合字符宽度估算偏差）时多出的列落在留白里，不顶到
 *    外缘框列、不把整行挤到下一行（整行溢出 = 帧行折行 → 全屏错位）。 */
export const PANE_TEXT_MARGIN_COLS = 1;

/** pane 文字排版宽：`reserve=true` 时扣掉右缘留白（P3：只给右缘贴外框列的 pane 留）。
 *  横向会话区 传 false（贴内部分隔竖线），回合区 与纵向两 pane 传 true。 */
export function paneTextWidth(paneW: number, reserve = true): number {
  return Math.max(1, paneW - (reserve ? PANE_TEXT_MARGIN_COLS : 0));
}

/** 区域正文宽（标题栏 + 历史/回合区）：historyWidth 扣外缘框格（buildTopRegion 与滚动口径同源） */
export function regionColumnWidth(historyWidth: number): number {
  const useFrame = historyWidth >= FRAME_RIGHT_COLS + 1;
  return Math.max(1, historyWidth - (useFrame ? FRAME_RIGHT_COLS : 0));
}

/** 左列顶部标题栏行数：标题行 + 实线下划线（置于会话会话区上方；
 *  极矮终端由 topPaneHeights 自适应收缩到 1/0 行） */
export const TITLE_BAR_ROWS = 2;

/** 焦点框色（语义色名 `focus`，取色由渲染层经主题 semantics 解析）。
 * re-export focus-frame.focusColor（单一实现，避免焦点色映射双源）。 */
export const focusFrameColor = focusColor;

/**
 * 回合区可视行数（= 顶部区域「内容行数」= topHeight-边框行的一半；
 * 在 buildTopRegion/frameGeometry 中经 topPaneHeights 先扣标题栏行数后应用）
 */
export function activityHeight(contentTopH: number, divisor?: number): number {
  // 回合区高 = contentTopH / divisor（tui.config.json；默认 2 ≈ 原 1/2 比例）
  return contentTopH <= 0
    ? 0
    : Math.max(1, Math.floor(contentTopH / (divisor ?? 2)));
}

/**
 * 回合区分隔行锚定 → 目标行号（0 基，屏幕行）：
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

/** 会话区 ↑/↓ 半屏翻页的行数（至少 1 行；向下取整保证上/下对称） */
export function dialogueHalfPage(rows: number): number {
  return Math.max(1, Math.floor(rows / 2));
}

/**
 * 会话区用户输入跳转（PgUp/PgDn）：返回目标视口首行**行号**（`undefined` = 无目标）。
 * dir=1 上一条（PgUp）、-1 下一条（PgDn）；基准 = 当前视口首行 `topIdx`。
 * 目标消息块后文本不足一屏时收敛到底对齐（多出的空屏由更早历史填充）。
 * 目标行来自本帧行缓冲的 `dialogueUserRows`（用户块首行的绝对行号，含占位行偏移），
 * 故只扫已物化范围——更早的历史先按 ↑ 扩窗再翻页。
 */
export function userRowJump(
  userRows: readonly number[],
  topIdx: number,
  viewportH: number,
  totalRows: number,
  dir: 1 | -1,
): number | undefined {
  if (viewportH <= 0 || userRows.length === 0) return undefined;
  const maxStart = Math.max(0, totalRows - viewportH);
  const align = (first: number): number =>
    Math.min(Math.max(0, first), maxStart);
  if (dir === 1) {
    // 上一条：最后一个位于当前视口首行之上的用户块
    let target: number | undefined;
    for (const row of userRows) {
      if (row < topIdx) target = row;
      else break;
    }
    return target === undefined ? undefined : align(target);
  }
  // 下一条：第一个位于当前视口首行之下的用户块；无则该方向无目标
  const next = userRows.find((row) => row > topIdx);
  return next === undefined ? undefined : align(next);
}
