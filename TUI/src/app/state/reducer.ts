// TUI/src/app/state/reducer.ts — 纯 reducer 入口：StateAction 到 AppState

import type { AppState } from "./types.ts";
import type { StateAction } from "./actions.ts";
import { reduceStream } from "./reducer-stream.ts";
import { reduceTool } from "./reducer-tool.ts";
import { reduceTurn } from "./reducer-turn.ts";
import { reduceHistory } from "./reducer-history.ts";
import { reduceSession } from "./reducer-session.ts";
import { reducePanel } from "./reducer-panel.ts";
import { reduceInput } from "./reducer-input.ts";
import { reduceView } from "./reducer-view.ts";
import { reduceGoal } from "./reducer-goal.ts";

/** 子 reducer：`undefined` 表示该 action 不归本组处理。 */
type SubReducer = (
  state: AppState,
  action: StateAction,
) => AppState | undefined;

/** 子 reducer 链：组间互斥，命中即停；顺序不影响结果，按可读性排列。 */
const SUB_REDUCERS: readonly SubReducer[] = [
  reduceStream,
  reduceTool,
  reduceTurn,
  reduceHistory,
  reduceSession,
  reducePanel,
  reduceInput,
  reduceView,
  reduceGoal,
];

/** 焦点复位 action 集合：处理完自动回到无焦点（focusedPanel=null）。
 *  **只剩「用户提交输入」两项**（2026-10-15 用户裁定 + 条目验收①：运行中派发 `append` /
 *  `thinking` / `tool-call` / `notice` 等后 `focusedPanel` 保持不变，见 BACKLOG
 *  「模型回复期间区域焦点被内容推进清空」）：
 *  - `user-line`（提交回显）/ `queued-push`（排队登记）——两条都在**提交那一刻**派发，
 *    回无焦点 = 跟随最新（条目期望②）。
 *  **其余一律不复位**：
 *  - 流式内容：`append`（`index.ts` 的 stream 分支直派）/ `thinking` / `tool-*` / `step` /
 *    `subagent` / … —— 回复期间每个 chunk 都到，复位会让 `Ctrl+E` / `Ctrl+T` / `Ctrl+S`
 *    刚聚焦就被清掉、面板滚动随之失效（本条缺陷的现象）。
 *  - 回合边界：`turn-begin` / `turn-end` —— 一次回复可能跨多个回合（核心自发续轮），
 *    同样不能在回复中途把焦点甩掉。
 *  - `queued-claim`：`beginTurnIfNeeded` 在**每个**回合开始都会派发（不只是认领排队消息），
 *    放进集合等于「每个回合清焦点」。
 *  - 「无内容载荷的状态刷新」（`notice` / `goal-change` / `todo-write` / `jobs-changed` /
 *    `permission-catalog` / `agent-preset-catalog`）与 UI 类 action（picker/question/approval/
 *    history/jobs/input/scroll/theme…）同理不复位，避免打断面板内浏览。
 *  退出焦点只剩用户主动动作：idle + 空输入按 `Esc`、再按同一区域键（见 `focus-panel`）。 */
const FOCUS_RESET_ACTIONS: ReadonlySet<string> = new Set([
  "user-line", // 用户消息行（提交回显）
  "queued-push", // 排队消息（agent 运行期间 Enter 提交）
]);

export function reduceState(state: AppState, action: StateAction): AppState {
  let handled: AppState | undefined;
  for (const reduce of SUB_REDUCERS) {
    handled = reduce(state, action);
    if (handled !== undefined) break;
  }
  const next = handled ?? state;
  // 新输入/输出后焦点回到无焦点（null）；其它 action 原样
  return FOCUS_RESET_ACTIONS.has(action.type)
    ? { ...next, focusedPanel: null }
    : next;
}
