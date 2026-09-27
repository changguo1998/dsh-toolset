# 输入历史（↑/↓ 翻看已提交输入）（接取条目：`TUI/docs/BACKLOG.md`「输入历史：记录已提交的命令/输入，输入态按 ↑/↓ 翻看前几条」）

状态：关闭（真机确认通过）　　开启：2026-09-27　　关闭：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 逐条审阅第 2 条（本条），决策**通过**。

## 目标

输入态按 `↑` 取上一条已提交内容、`↓` 取更新的条目（到最新条目再按回到当前草稿），可连续翻看前 N 条；`/` 命令与普通输入共用同一份历史；不与既有 `↑/↓` 语义冲突。

## 调研

来源：TUI 源码 + 既有设计文档。

- 按键现状：输入态 `↑/↓` 已被占用——焦点面板滚动（history/activity/status 三面板，`TUI/docs/DESIGN.md`「顶部三面板统一焦点滚动」）与 `/history` 面板移动项；`Tab` 切焦点面板。故新语义必须**按焦点态分流**（仅在无面板/输入区为活动编辑目标时接管 `↑/↓`）。
- 前缀模式与提交路径：空输入时按 `$`/`/` 切模式（`src/app/index.ts:1799-1808` 附近）、类型 `InputMode` 在 `src/app/state.ts:99`、提示符映射在 `src/app/layout.ts:2290-2294`；提交分流在 `submit()`（普通文本走 `followup`，`/` 走命令路由）。历史记录点应落在 `submit()`，两种输入同源。
- 现状无任何输入历史设施：`state.inputHistory` 之类的字段不存在（本次新增）；`tui-state.json` 已有会话态持久化（显示开关等）可作扩展点，但见决策。
- 既有 query 前缀记忆（`/` 命令补全等）与 `/history` 面板是**会话历史**（消息/命令记录），与输入行历史是两回事，不共用。

## 决策

选项 → 选定（本次实现自定，**待用户审阅**）：

1. 历史存放：**进程内、仅当前会话生命周期**（不写 `tui-state.json`）——选定。理由：最小实现、避免跨会话串味；持久化可作为后续独立条目（跨会话翻找输入属另一个需求面）。
1. 单份还是两份：**单份共用**（`/` 命令与普通输入同一数组）——选定。理由：用户条目允许「或分开两份，实现时定」，单份更简单且翻找体验连续。
1. 去重与上限：**相邻重复不入栈 + 上限 200 条**（超出丢最旧）——选定。上限取值可调，先取 200（内存占用可忽略）。
1. 翻看语义：以「距最新条目」为游标；进入翻看时**保存当前草稿**，回到最新条目之下（即游标退出历史）时恢复草稿——选定。理由：避免误吞正在输入的内容（ADHD/可用性口径：不制造意外丢字）。

## 规划

任务拆分：

1. `src/app/state.ts`：新增 `inputHistory: string[]` 与 `inputHistoryCursor: number`（0 = 不在翻看态，n = 距最新第 n 条）与 `inputHistoryDraft: string`（进入翻看前的草稿）；新增 reducer（如 `{type:"input-history", action:"push"|"prev"|"next"}`）承载游标移动与草稿存取（纯函数，便于单测）。
1. `src/app/index.ts`：输入态按键映射——无面板且输入区为编辑目标时，`↑`/`↓` 走 `input-history`；`submit()` 提交成功后 `push`（空串不入栈、与栈顶相同不入栈）。
1. 渲染：翻看态下输入区文本 = 历史条目（沿用现有输入行渲染，无需新样式）。
1. 测试（`TUI/tests/`）：上翻/下翻/到顶/到底恢复草稿/提交入栈/相邻去重/上限裁剪/与面板焦点分派互不干扰——各至少 1 例。

计划改动文件清单（**只改这些**）：

- `TUI/src/app/state.ts`
- `TUI/src/app/index.ts`
- `TUI/tests/app.test.ts`（或按体量新建 `TUI/tests/input-history.test.ts`）
- 本追踪文档

明确不做：不写持久化（`tui-state.json` 不动）；不改 `/history` 面板语义；不动 `$`/`/` 前缀模式的既有行为；不做跨会话历史共享。

## 实现记录

**实现（2026-09-27）**

1. `src/app/state.ts`：`AppState` 增 `inputHistory` / `inputHistoryCursor` / `inputHistoryDraft`（含 `initialState` 初值）；新增导出 `inputHistoryPush`（去重 + 200 上限）、`isInputHistoryBrowse` / `isInputHistoryBrowseAt`、`reduceInputHistory`（push/prev/next）；`setInput` 在文本变更时退出翻看态并把编辑文本存为新草稿。
1. `src/app/index.ts`：`↑/↓` 分派增历史分支（`focusedPanel === null` 且「输入非空或已在翻看态或下按会进入翻看」才接管，否则保持既有面板滚动）；`submit()` 在 trim 后入栈（普通输入与 `/` 命令同点）。
1. `tests/input-history.test.ts`：7 例（App 端到端 5 + reducer 2）。
1. `tests/helpers/appFakes.ts`：把 `app.test.ts` 的 `FakeRenderer` / `FakeAdapter` 抽为共用假件（跨文件 import 会连带把 app.test.ts 的用例再执行一遍，故抽文件而非 import），`app.test.ts` 改从该文件导入，行为不变。
1. `TUI/docs/DESIGN.md`：输入区一节补「输入历史」条（按键分流、共用一份、slash 记提示符口径、进程内、去重与上限、草稿恢复）。

**关键取舍**：

- 接管条件用「`focusedPanel === null` + 输入或历史非空」而不是「无条件接管」——空输入 + 无历史时 `↑/↓` 仍是既有对话区/面板滚动（否则会把顶部面板滚动语义挤掉）。
- 草稿在首次进入翻看时保存；翻看态下手输会经由 `setInput` 覆盖草稿为编辑后的文本，保证「下一次 ↑ 回落的是你最后写的那份」。

**修复（2026-09-27，真机反馈）**

- 现象：回溯只恢复字符串、**丢失输入模式**——用 `/agents`（slash 模式）提交后按 `↑`，输入框变成 `>agents`（普通模式），提交语义随之从「slash 命令」变成「发给模型」。
- 根因：条目只存了提示符口径文本（slash 模式不含前导 `/`），未存当时的 `InputMode`；回溯时只写回 `inputText`，模式仍留在提交后回退的 `normal`。
- 修法：条目升级为 `{ text, mode }`（`InputHistoryEntry`）——push 存 `state.inputMode`；prev/next 恢复文本**与模式**；进入翻看时同时保存草稿**与其模式**（`inputHistoryDraftMode`），回到最新之下时两者一起恢复；相邻重复判据改为「文本 + 模式均相同」（同文本不同模式视为不同条目）。`/` `/` `$` `<` 三种模式与普通输入因此都能原样回溯。
- 边界（有意保留）：命令面板打开时 `↑/↓` 归面板列表（既有语义），要回溯输入历史需先 `Esc` 关面板。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `npm run check`（tsc --noEmit） | 通过 |
| `sh scripts/test.sh tests/input-history.test.ts` | **8 例全通过**（含新增的模式回溯回归用例） |
| `npm test`（TUI 全量） | **1180 例全通过**（1180 pass / 0 fail；含既有 app.test.ts 在假件抽文件后不回归） |

用例清单（`tests/input-history.test.ts`，8 例）：

1. 提交入栈：普通输入与 slash 命令共用一份（slash 记提示符口径 `zzz`）、空提交不入栈；
1. `↑` 上翻逐条、到最早一条停住、`↓` 逐条回来并越过最新回到草稿；
1. 翻看中手输草稿不丢（进入翻看先存草稿，`↓` 恢复）；
1. 翻看态下编辑 → 游标归零、编辑文本成为新草稿；
1. 无历史且输入为空：`↑/↓` 不抢既有滚动语义；
1. reducer：相邻重复不入栈、205 条压到 200 且丢最旧；
1. reducer：push 复位翻看态、空历史时 prev/next 为 no-op。

## 收尾

- 已回写 `TUI/docs/DESIGN.md`（输入区一节补输入历史口径）；
- 计划外文件 `tests/helpers/appFakes.ts` 为测试假件抽取（原因：跨测试文件 import 会重复执行被导入文件的用例），已在本节说明；
- 真机确认（2026-09-27）：用户实测「输入历史功能正常」（含修复后的模式回溯：slash 条目 `↑` 后仍按 slash 语义提交）；
- 原待办：用户复验（真机 `↑/↓` 翻看：slash/`$`/steer 条目的模式是否原样恢复）（已完成，本文档归档于 `TUI/docs/archived/`）。
