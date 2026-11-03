# TUI 拆 `reduceState` 状态机

> 接取条目: `TUI/docs/BACKLOG.md` #1（2026-11-03 开工）
> 层级: TUI

## 计划改动文件清单

| 文件 | 作用 |
| --- | --- |
| `TUI/src/app/state/reducer.ts` | 收成入口：按组调用子 reducer 链，保留焦点复位逻辑 |
| `TUI/src/app/state/reducer-stream.ts` | 流式内容、通知、状态行改动与排队（`append` / `queued-*` / `notice` …） |
| `TUI/src/app/state/reducer-tool.ts` | 工具与回合内过程（`tool-*` / `step` / `compaction*` / `retry` / `usage` …） |
| `TUI/src/app/state/reducer-turn.ts` | 回合边界与模式（`turn-*` / `mode` / `pipeline-state` / `clear-stripped`） |
| `TUI/src/app/state/reducer-history.ts` | 历史会话浏览（`history-*` 的列表 / 标记 / 查看 / 返回） |
| `TUI/src/app/state/reducer-session.ts` | 历史会话恢复与删除、切换（`history-resume*` / `session-*` …） |
| `TUI/src/app/state/reducer-panel.ts` | 面板与弹窗（`approval*` / `picker-*` / `question-*` / `*-panel-*` …） |
| `TUI/src/app/state/reducer-input.ts` | 输入区与补全（`input*` / `move-cursor`） |
| `TUI/src/app/state/reducer-view.ts` | 视图与滚动（`status` / `set-theme` / `activity-*` / `focus-panel` …） |
| `TUI/src/app/state/reducer-goal.ts` | 目标 / 待办 / 目录类刷新（`goal-*` / `todo-write` / `*-catalog` …） |
| `TUI/docs/BACKLOG.md` | 条目标进行中、关闭移除 |

## 调研

- `reducer.ts` 1266 行，只有两个顶层定义：`FOCUS_RESET_ACTIONS`（字符串集合）与 `reduceState`（内含一个 `switch`，包在立即执行的箭头函数里）。除 `reduceState` 外没有对外导出的辅助函数，拆分不影响其它模块的 import。
- `switch` 共 133 个 `case` 块（含 `queued-claim` / `queued-claim-steer`、`approval-scroll` / `question-close` 这类 fallthrough 共用块）；各块的 `case` 标签天然按前缀聚簇，因此按前缀切文件不需要改写任何分支体。
- `reduceState` 的收尾逻辑与具体 action 无关：命中 `FOCUS_RESET_ACTIONS` 时把 `focusedPanel` 置空。这段留在入口。
- 调用面：`TUI/src/app/index.ts` 等只依赖 `reduceState`（导出名与签名不变）。

## 决策

1. 每个子 reducer 签名 `(state: AppState, action: StateAction): AppState | undefined`，`undefined` 表示「不归本组处理」，`default` 分支统一返回 `undefined`；原 `default: return state` 的语义由入口兜底（全部返回 `undefined` 时用原 `state`）。用 `undefined` 而不是返回 `state` 作哨兵，是为了区分「命中但结果就是原状态」（例如 `queued-claim-steer` 空批次早退）与「未命中」。
2. 入口按固定顺序串联子 reducer，命中即停，再走焦点复位。分组互斥（每个 `case` 标签只出现在一个文件），故顺序语义与原单 `switch` 等价；脚本校验标签唯一性。
3. 文件按扩展现有约定命名 `reducer-<组>.ts`，与 `reducer.ts` 同目录，不改变目录结构。
4. 行为与帧内容不变，不新增测试：由 TUI 既有 1829 例、`demo -- --smoke` 帧断言与全仓 `check` / `test` / `test:e2e` 覆盖。

## 实现记录

- 分支体按原文整块搬移，未改写任何判断或注释；脚本按 6 空格缩进的 `case` 切块，逐块只做整体缩进减 2（少一层立即执行函数），并用「块文本逐字节比对」确认 133 个块与原文完全一致。
- 组划分（块数 / 行数）：`stream` 12 / 96（`append` `user-line` `thinking` `notice` `shell-lines` `clear-buffer` `agent-status` `virt-tick` `queued-*`）、`tool` 16 / 233（`tool-*` `step` `subagent` `compaction*` `retry*` `usage` `workflow` `command` `code-dispatch` `hook` `schedule` `feedback`）、`turn` 6 / 76（`turn-*` `mode` `pipeline-state` `clear-stripped`）、`history` 16 / 196（列表 / 标记 / 查看 / 返回）、`session` 13 / 238（`history-resume*` `history-restore` `session-*` `history-confirm-*` `history-delete*` `history-clean*`）、`panel` 43 / 218（`approval*` `picker-*` `question-*` `status-panel-*` `completion-*` `*-panel-*` `sessions`）、`input` 5 / 42、`view` 13 / 144（`status*` `set-theme` `lower-panes` `activity-*` `focus-panel` `symbol-unify` `*-scroll` `window-grow` `dialogue-scroll`）、`goal` 9 / 108（`goal-*` `todo-write` `agents-changed` `jobs-changed` `model-selection` `agent-preset*` `permission-catalog`）。
- 入口 `reducer.ts` 68 行：`SUB_REDUCERS` 链按上面顺序排列，命中即停，随后套用原 `FOCUS_RESET_ACTIONS` 焦点复位；`reduceState` 的导出名与签名不变，调用方（`TUI/src/app/index.ts` 等）零改动。
- 反向核对：脚本统计新文件 `case` 标签 133 个、去重 133、与原文集合完全相同（无缺失 / 无重复 / 无多余），保证组间互斥、语义等价。
- 各文件 import 由原 import 列表按实际使用名字裁剪并按模块合并（含 `import type` 分组），无人工遗漏调用。

## 测试与证据

- `pnpm -C TUI run check` 退出 0。
- `pnpm -C TUI run test`: 1829 例全过（fail 0 / skipped 0 / todo 0）。
- `pnpm -C TUI run demo:build -- --smoke`: `SMOKE_OK`（42 条 `SMOKE_PASS`，帧断言与拆分前一致）。
- `pnpm -C TUI run build` 退出 0。
- 全仓 `pnpm run check` 退出 0；全仓 `pnpm run test` 退出 0（34 包，各包 pass / fail 0）。
- 行数：`reducer.ts` 1266 行 → 入口 68 行 + 9 个分组文件（最大 238 行），合计 1419 行（增量来自各文件的 import 头与 9 个 `default` 分支）。

## 偏差

1. `history-*` 组按职责再切两文件（浏览 / 恢复删除切换），否则单文件约 395 行、与「拆小文件」目的相背；两条目的前缀仍是 `history-` / `session-`，未跨主题混装。
2. 入口用子 reducer 链而非「单个 switch 调 9 个函数」：`switch` 只能按 `action.type` 字面量分派，133 个标签要写两遍易漏；链式分派一处维护，`undefined` 哨兵区分「未命中」与「命中但状态未变」。
3. 未新增测试：行为不变，按条目验收由既有用例与帧基线覆盖（重跑无变化即守成通过）。
4. 回写 `TUI/docs/DESIGN.md` 的 `app/` 文件树一行：原条目写 `state.ts`（拆分前即与目录结构不符），改为 `state/` 并补 `reducer.ts` / `reducer-*.ts` 两行；只动这三行，树里其它过期项未捎带修改。
