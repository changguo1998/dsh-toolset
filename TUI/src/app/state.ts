// TUI/src/app/state.ts — 状态层入口（状态模型 + 纯 reducer）
//
// buffer 持有会话文本行（无界，超出 MAX_BUFFER_LINES 裁剪旧行）。
// 滚动状态：followBottom 跟随底部；scrollOffset = 上滚的行单位偏移。
//
// 本文件只做入口重导出，实现按层拆在 `./state/` 下：
//  - `state/types.ts`：状态模型（类型、常量、纯查询与默认值）
//  - `state/initial.ts`：初始状态装配
//  - `state/updates.ts`：状态更新入口（缓冲追加、面板开关、光标移动）
//  - `state/actions.ts`：reducer 的 action 联合类型
//  - `state/reducer.ts`：`reduceState` 本体
//  - `state/panels.ts`：面板 / 输入历史 / 滚动的 action 实现
//
// 拆出的模块只从这里重导出，不新增对外入口。

export {
  ACTIVITY_COMPACT_DEFAULT,
  ACTIVITY_SHOW_DEFAULT,
  DEFAULT_MESSAGE_GUTTER,
  MAX_BUFFER_LINES,
  TURN_SEPARATOR,
  activeGoalSnapshot,
  cleanableSessionIds,
  currentProjectCwd,
  deletableSession,
  goalActivationDisplay,
  historyVisibleRecords,
  markableSessionIds,
  startupCleanableIds,
} from "./state/types.ts";
export type {
  ActivityCategory,
  ActivitySwitches,
  AppState,
  Buffer,
  BufferKind,
  BufferLine,
  CommandPanelState,
  CompletionState,
  GoalEntry,
  GoalHistory,
  HistoryPhase,
  HistoryPanelState,
  HistoryRow,
  HistoryRowKind,
  InputHistoryEntry,
  InputMode,
  InputStatus,
  ModeState,
  PanelId,
  PickerState,
  QuestionPanelItem,
  QuestionPanelState,
  QueuedItem,
  StatusPanelState,
  StreamKind,
  SystemStatus,
  TurnEndReason,
} from "./state/types.ts";

export { initialState } from "./state/initial.ts";

export {
  appendNotice,
  appendNoticeLines,
  appendShellLines,
  appendStream,
  appendThinking,
  appendToolLine,
  clearBuffer,
  focusApproval,
  inputLineBounds,
  inputLineMove,
  isCompacting,
  isUserMessage,
  sanitizeText,
  setAgentStatus,
  setApproval,
  setApprovalHint,
  setSessions,
  setSystemStatus,
  toggleApprovalWindow,
} from "./state/updates.ts";
export type { NoticeLine } from "./state/updates.ts";

export type { StateAction } from "./state/actions.ts";

export { reduceState } from "./state/reducer.ts";

export {
  inputHistoryPush,
  isFallbackOption,
  isInputHistoryBrowseAt,
  reduceInputHistory,
  scrollBy,
} from "./state/panels.ts";
