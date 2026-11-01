// src/app/layout/geometry.ts — 帧几何：三区高度、顶部切分、状态列/活动区尺寸

import type { FrameRow } from "../../renderer/index.ts";
import {
  FRAME_LEFT_COLS,
  FRAME_RIGHT_COLS,
  SEPARATOR_ROWS,
  TITLE_BAR_ROWS,
  activityHeight,
  activityTopRowToLine,
  hintRowsFor,
  paneTextWidth,
  regionColumnWidth,
} from "./frame-rows.ts";
import { renderStatusLine } from "./status-line.ts";
import type { Size } from "../../renderer/index.ts";
import type { AppState } from "../state.ts";
import type { ActivityPlacement } from "../config.ts";
import { renderQueuedBlocks } from "./pipeline/rows.ts";
import { layout } from "./measure.ts";
import { h } from "./box.ts";
import { focusFrame } from "./focus-frame.ts";
import type { ContentRow } from "./fill.ts";
import { seg } from "./primitives.ts";

// src/app/layout/geometry.ts — 帧几何：三区高度、顶部切分、状态列/活动区尺寸

export interface FrameMetrics {
  /** 顶部区域行数 = rows - 状态区 - 输入区 - 按键提示区 - 分隔行（剩余高度全给上方两个） */
  topHeight: number;
  /** 系统状态区行数（可 >1：状态内容溢出到多行时按实际行数） */
  statusHeight: number;
  /** 输入区行数 = interaction − 提示区行数（面板态与输入态同高，不随面板开关变化） */
  footerHeight: number;
  /** 按键提示区行数（独立区域，位于输入区下方、之间不画横线；1 至 2 行，空文案也占位） */
  hintHeight: number;
  /** 顶部状态列宽（详细 goal/todo；窄列约 1/3，含右缘分隔竖线，状态列位于最左侧列） */
  statusColWidth: number;
  /** 历史区（标题栏 + 历史/活动区）宽 = cols - statusColWidth */
  historyWidth: number;
}

export function metricsFor(
  size: Size,
  /** 状态区行数（默认 1；可多行溢出时按实际行数压缩顶部区域） */
  statusHeight = 1,
  /** 按键提示区行数（独立区域，与输入区共同构成交互区；1 至 2 行——按文案与宽度由
   *  hintRowsFor 算出，空文案也占位 1 行） */
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

/** 黄金分割比 φ：历史区/活动区排列方式的判定基准（分割后各 pane 的**视觉**宽高比尽量贴近 φ） */
export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

/** 终端字符格高宽比（高 ≈ 2 × 宽）：宽高比拟用视觉口径——列数先按它折成等效高度再比 φ */
export const CELL_ASPECT = 2;

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

/** pane **视觉**宽高比与 φ 的对数偏差（高或宽 ≤ 0 视为无此 pane，不参与比较）。
 *  字符格高约为宽的 CELL_ASPECT 倍，故列数先折成等效高度（w / CELL_ASPECT）再比：
 *  否则判据把字符格当正方形，整体偏向上下排列（等分阈值 φ → 2φ，2026-10-17 校正）。 */
function aspectDeviation(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0;
  return Math.abs(Math.log(w / h / CELL_ASPECT / GOLDEN_RATIO));
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
 * - "auto"：比较两种排列下各 pane **视觉**宽高比与 φ 的对数偏差（取较差 pane），
 *   小者胜出。等分时判据等价于「左列正文宽/可用行数 > 2φ → 左右排列」——
 *   区域比 2φ 更扁（宽而矮）时左右排列更接近黄金矩形（系数 2 = 字符格高宽比 CELL_ASPECT）。
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
  // auto：视觉宽高比偏离 φ 更小者胜（活动区 0 行时不参与比较）
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
   *  内容 = `AppState.queued`：已投递核心、尚未认领的排队项（followup = 等下一回合、
   *  steer = 等本回合下一次 step；渲染顺序 steer 在前，右缘竖线颜色按类型区分，TUI#43） */
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
  // TUI#43：渲染顺序 steer 在前、followup 在后（组内各保持提交顺序）——
  // steer 等的是本回合的下一次 step（更近），followup 等的是下一回合
  const ordered = [
    ...state.queued.filter((q) => q.kind === "steer"),
    ...state.queued.filter((q) => q.kind !== "steer"),
  ];
  return renderQueuedBlocks(
    ordered.map((item) => ({ text: item.text, kind: item.kind })),
    { width, gutter: state.messageGutter },
  );
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
  const statusLines = renderStatusLine(
    state.systemStatus,
    cols,
    state.usage,
    state.inputStatus,
    state.runVirt.tokens,
  );
  // 交互区总高恒定（见 metricsFor）：提示区 1 至 2 行（按当前文案与宽度折行；空文案也占位），
  // 提示行数从 interaction 里反推 footer，面板开关不让顶部上下跳
  const metrics = metricsFor(
    size,
    statusLines.length,
    hintRowsFor(state, cols),
    state,
  );
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
  // #9：Ctrl+T 隐藏下半区（Turn 流 + Tool 面板区）时尺寸归零、空间并入对话区；
  // 活动区内有交互面板打开时仍照常显示（面板临时显示，不改用户的可见性状态）
  if (!state.lowerPanesVisible && !panelShownInActivity(state)) {
    // 视作「只有会话 pane」：整宽 + 整高，且按纵向出图（横向排列下若只把 activityW
    // 归零，内部分隔竖线会紧贴正文、行尾框线不与其它行对齐）
    split.activityW = 0;
    split.activityH = 0;
    split.dialogueW = contentW;
    split.dialogueH = Math.max(0, contentTopH - split.titleRows);
    split.mode = "vertical";
  }
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

/** #9：活动区内是否正在显示交互面板（问答 / 审批 / 模型选择 / 命令面板）——
 *  隐藏下半区时这些面板仍照常显示（临时显示，不改用户的可见性状态）。 */
export function panelShownInActivity(state: AppState): boolean {
  return (
    state.approval !== null ||
    state.question !== null ||
    state.picker !== null ||
    state.statusPanel !== null
  );
}

/** 行级兑底截断：超出预算时保留前 budget-1 行、末行换折叠提示（统计被折叠行数） */
export function capRows(rows: ContentRow[], budget: number): ContentRow[] {
  if (rows.length <= budget) return rows;
  if (budget <= 0) return [];
  if (budget === 1) return [rows[0]!]; // 仅 1 行：内容优先，折叠标记让位
  const hidden = rows.length - budget;
  const kept = rows.slice(0, budget - 1);
  kept.push({ segments: [seg(`…(+${hidden}行)`)] });
  return kept;
}
