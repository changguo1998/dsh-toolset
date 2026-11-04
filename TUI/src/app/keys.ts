// TUI/src/app/keys.ts — 按键表（唯一分派口径）
//
// 一张表对应一个按键上下文：`Record<键名, 动作名>`。键名取 `KeyEvent.name`（renderer 已把
// 空格归一成 `" "`，此处连带接受 `"space"` 别名）；动作名由 `App.keyActions` 表执行。
//
// 上下文互斥，按原 `handleKey` 的 if 链顺序选取（审批 → 问答 → 选择面板 → 状态选项 →
// 任务面板 → 列表面板 → 历史面板 → 编辑区），查表命中即停。同一上下文内键名不重复，
// 别名（`y`/`1`、`n`/`2`、`" "`/`space`、`d`/`delete`/`backspace`）指向同一动作，故
// 查表与原 if 链的先后顺序等价。
//
// 未进表的特殊分支留在 `App.handleKey`，分三类：
//   1. 组合键与修饰键：Ctrl+D / S / T / E / P / N / L / J / C 与 Ctrl+↑/↓ 半屏，
//      与裸键同名，靠 `ctrl` 标志区分，不能只按 `name` 查表；
//   2. 需要先看面板内部状态的兜底：选择面板的筛选词编辑（按焦点列判是否可筛）、
//      历史面板按阶段（list / view / confirm / error）分表后各阶段的吞键兜底；
//   3. 编辑区的模式键（`$` / `/` / `<` / `!`）与可打印字符，属缺省分支而非具名动作。

/** 按键动作名（`App.keyActions` 表的键；新增动作须同时补表，缺失编译报错） */
export type KeyActionName =
  // 审批面板
  | "approval-allow"
  | "approval-deny"
  | "approval-submit"
  | "approval-switch"
  | "approval-scroll"
  | "approval-tab"
  | "approval-cancel"
  // /model 选择面板
  | "picker-move"
  | "picker-select"
  | "picker-tab"
  | "picker-phase"
  | "picker-submit"
  | "picker-cancel"
  // 通用状态选项面板（/policy /permission）
  | "status-move"
  | "status-select"
  | "status-submit"
  | "status-cancel"
  // /jobs 任务面板
  | "jobs-move"
  | "jobs-page"
  | "jobs-enter"
  | "jobs-close"
  // 共享列表面板（/skills /agents /tools 等）
  | "panel-move"
  | "panel-page"
  | "panel-enter"
  | "panel-refresh"
  | "panel-close"
  // /history 历史会话面板
  | "history-move"
  | "history-enter"
  | "history-scope"
  | "history-mark"
  | "history-mark-all"
  | "history-unmark-all"
  | "history-delete"
  | "history-clean"
  | "history-close"
  | "history-view-scroll"
  | "history-view-page"
  | "history-back"
  | "history-confirm-run"
  | "history-confirm-cancel"
  // 编辑区（无面板）
  | "editor-escape"
  | "editor-tab"
  | "editor-scroll"
  | "editor-page"
  | "editor-home"
  | "editor-end"
  | "editor-left"
  | "editor-right"
  | "editor-backspace"
  | "editor-enter"
  | "editor-paste";

/** 一张按键表：键名 → 动作名 */
export type KeyTable = Readonly<Record<string, KeyActionName>>;

/** 查表：命中返回动作名，未命中返回 undefined（调用方决定兜底语义） */
export function lookupKey(
  table: KeyTable,
  name: string,
): KeyActionName | undefined {
  return table[name];
}

/** 审批模式：y/n 直答、数字键同义、Enter 提交焦点、←/→ 切换焦点、↑/↓ 滚草稿、Tab 切窗、Esc 取消 */
export const APPROVAL_KEYS: KeyTable = {
  y: "approval-allow",
  "1": "approval-allow",
  n: "approval-deny",
  "2": "approval-deny",
  enter: "approval-submit",
  left: "approval-switch",
  right: "approval-switch",
  up: "approval-scroll",
  down: "approval-scroll",
  tab: "approval-tab",
  escape: "approval-cancel",
};

/** 选择面板：↑/↓ 移动、空格选中、Tab 切换列、←/→ 换列、Enter 提交、Esc 清筛/关闭 */
export const PICKER_KEYS: KeyTable = {
  up: "picker-move",
  down: "picker-move",
  " ": "picker-select",
  space: "picker-select",
  tab: "picker-tab",
  left: "picker-phase",
  right: "picker-phase",
  enter: "picker-submit",
  escape: "picker-cancel",
};

/** 状态选项面板：↑/↓ 移动、空格预选、Enter 提交、Esc 取消 */
export const STATUS_PANEL_KEYS: KeyTable = {
  up: "status-move",
  down: "status-move",
  " ": "status-select",
  space: "status-select",
  enter: "status-submit",
  escape: "status-cancel",
};

/** 任务面板：↑/↓ 移动、PgUp/PgDn 整页、Enter 取消任务、Esc 关闭 */
export const JOBS_PANEL_KEYS: KeyTable = {
  up: "jobs-move",
  down: "jobs-move",
  pageup: "jobs-page",
  pagedown: "jobs-page",
  enter: "jobs-enter",
  escape: "jobs-close",
};

/** 共享列表面板：↑/↓ 移动、PgUp/PgDn 整页、Enter 主操作、r 刷新（仅 agents）、Esc 关闭 */
export const COMMAND_PANEL_KEYS: KeyTable = {
  up: "panel-move",
  down: "panel-move",
  pageup: "panel-page",
  pagedown: "panel-page",
  enter: "panel-enter",
  r: "panel-refresh",
  escape: "panel-close",
};

/** 历史面板 list 阶段：↑/↓ 移动、Enter 查看、Tab 切范围、空格标记、a 全选、c 清标记、d 删除、x 清理、Esc 关闭 */
export const HISTORY_LIST_KEYS: KeyTable = {
  up: "history-move",
  down: "history-move",
  enter: "history-enter",
  tab: "history-scope",
  " ": "history-mark",
  space: "history-mark",
  a: "history-mark-all",
  c: "history-unmark-all",
  d: "history-delete",
  delete: "history-delete",
  backspace: "history-delete",
  x: "history-clean",
  escape: "history-close",
};

/** 历史面板 view 阶段：↑/↓ 滚动、PgUp/PgDn 整段、Esc 返回列表 */
export const HISTORY_VIEW_KEYS: KeyTable = {
  up: "history-view-scroll",
  down: "history-view-scroll",
  pageup: "history-view-page",
  pagedown: "history-view-page",
  escape: "history-back",
};

/** 历史面板二次确认：y/Enter 执行、n/Esc 取消（其余键吞掉，避免误触） */
export const HISTORY_CONFIRM_KEYS: KeyTable = {
  y: "history-confirm-run",
  enter: "history-confirm-run",
  n: "history-confirm-cancel",
  escape: "history-confirm-cancel",
};

/** 历史面板 error 阶段：Esc 关闭 */
export const HISTORY_ERROR_KEYS: KeyTable = {
  escape: "history-close",
};

/** 编辑区（无面板）：导航 / 编辑 / 提交；模式键与可打印字符走缺省分支 */
export const EDITOR_KEYS: KeyTable = {
  escape: "editor-escape",
  tab: "editor-tab",
  up: "editor-scroll",
  down: "editor-scroll",
  pageup: "editor-page",
  pagedown: "editor-page",
  home: "editor-home",
  end: "editor-end",
  left: "editor-left",
  right: "editor-right",
  backspace: "editor-backspace",
  enter: "editor-enter",
  paste: "editor-paste",
};
