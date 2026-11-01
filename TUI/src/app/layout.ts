// src/app/layout.ts — 布局层入口（视口切分 + 帧组装，纯函数，可单测）
//
// 语义（DESIGN scrollback 行为）：
//  - 长行按列宽软换行（wrapping）
//  - 视口 = 换行后行数组上裁剪出的可见窗口
//  - followBottom=true 跟随底部；用户上滚后 followBottom=false，
//    scrollOffset 表示距底部多少行，up/down/PageUp/PageDown 移动它
//  - buffer 超 2000 行裁剪由 state.ts 负责（MAX_BUFFER_LINES）
//
// markdown 子集渲染（行内/块级）与宽度原语见 ./layout/markdown.ts；本文件只做入口重导出，
// 帧组装实现按层拆在 ./layout/ 下：
//  - `layout/frame-rows.ts`：行文本、提示区折行、渐进窗口常量、半屏与用户块跳转量
//  - `layout/geometry.ts`：三区高度、顶部切分、FrameGeometry
//  - `layout/title-bar.ts`：标题栏状态符号与状态列渲染
//  - `layout/top-region.ts`：顶部区域装配（状态列 + 会话区 + 活动区面板选型）
//  - `layout/status-line.ts`：底部状态栏渲染
//  - `layout/run-virt.ts`：运行指示（虚拟速度 / 虚拟 token / ●○ 与用户块符号）
//  - `layout/frame-build.ts`：分区、滚动回落、buildFrame 与焦点
//
// 拆出的模块只从这里重导出，不新增对外入口。

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

export {
  DIALOGUE_KEEP_REPLIES,
  DIALOGUE_MORE,
  FRAME_LEFT_COLS,
  FRAME_RIGHT_COLS,
  PANE_TEXT_MARGIN_COLS,
  SEPARATOR_ROWS,
  TITLE_BAR_ROWS,
  WINDOW_GROW_STEP,
  activityHeight,
  activityTopRowToLine,
  dialogueHalfPage,
  focusFrameColor,
  hintRowsFor,
  paneTextWidth,
  regionColumnWidth,
  rowText,
  turnGroupStarts,
  userRowJump,
  wrapHintLine,
} from "./layout/frame-rows.ts";
export type { Viewport } from "./layout/frame-rows.ts";

export {
  CELL_ASPECT,
  GOLDEN_RATIO,
  MIN_HORIZONTAL_PANE_COLS,
  MIN_HORIZONTAL_PANE_ROWS,
  frameGeometry,
  metricsFor,
  topPaneHeights,
  topPaneSplit,
} from "./layout/geometry.ts";
export type {
  FrameGeometry,
  FrameMetrics,
  TopPaneHeights,
  TopPaneSplit,
} from "./layout/geometry.ts";

export {
  TITLE_ICON,
  renderStatusColumn,
  titleBarSegments,
} from "./layout/title-bar.ts";
export type { StatusSwitches } from "./layout/title-bar.ts";

export {
  modelLabel,
  renderStatusLine,
  statusBarSeamCols,
} from "./layout/status-line.ts";

export {
  RUN_SPEED_RAMP_SECS,
  RUN_TOGGLE_FREQ_MAX,
  RUN_TOGGLE_FREQ_MIN,
  RUN_TOGGLE_TOKENS,
  TOKEN_CALIB_ALPHA,
  TOKEN_CALIB_MAX,
  TOKEN_CALIB_MIN,
  VIRT_DECAY_TAU,
  VIRT_RATE_TAU,
  VIRT_SLEW_RATE,
  VIRT_SPEED_MAX,
  VIRT_SPEED_MIN,
  emptyRunVirt,
  estimateOutputTokens,
  nextRunVirt,
  runPhase,
  virtTick,
} from "./layout/run-virt.ts";
export type { RunVirtState } from "./layout/run-virt.ts";

export {
  buildFrame,
  buildStatusSeparator,
  frameBands,
  frameFocus,
  frameSections,
} from "./layout/frame-build.ts";
export type {
  FrameBuildOutput,
  FrameScrollReport,
} from "./layout/frame-build.ts";
