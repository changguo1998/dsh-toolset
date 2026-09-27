# CLI `--resume` / `-c` 启动恢复后历史区渲染既有消息（接取条目：`TUI/docs/BACKLOG.md`「CLI `--resume` / `-c` 启动恢复后历史区为空（不渲染既有消息）」）

状态：测试（实现完成、机械验证通过，待用户人工确认）　　开启：2026-09-27　　关闭：——
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 逐条审阅第 8 条（本条），决策**通过**。

## 目标

CLI 启动即恢复会话（`--resume <id>` / `-c`）时，历史区直接渲染该会话既有消息，无需手动 `/session` 再切一次。

## 调研

来源：TUI 源码。

- 启动路径：`main.ts` 在 App 创建前走 `agents.resume`（`--resume`：`main.ts:~390`；`-c`：`pickRecentSession` → 同一 `resumeSession`），随后 `new App(...)` 组装；`App` 构造末尾只调 `restoreSessionState()`（`index.ts:484`）。
- `restoreSessionState()`（`index.ts:649`）只回填 model / mode / goal / todo / 开关（`adapter.restoreSessionState` → `session-ui-state`），**不含**历史消息折叠。
- 历史行折叠目前只在 `/session` 切换路径发生：`resumeToSession` 成功 → `history-resume-ok` + `rows: surfaceToBuffer(view.messages)`（`index.ts:2655-2670`），且该路径要求面板处于 `resuming` 态（stale guard）。
- 结果：CLI 恢复会话时 agent 侧上下文已恢复，但 TUI 历史区为空（P9 的 step 概要折叠逻辑本身已实现，缺的只是启动路径的触发）。
- 既有能力可复用：`adapter.readSurface?`（`/session` 路径用）、`surfaceToBuffer`（`commands.ts:64`）、`history-resume-ok` reducer（`state.ts:1568`）。

## 决策

选项 → 选定（本次实现自定，**待用户审阅**）：

1. **触发点**：在 `App` 侧「启动即恢复」路径补一次 surface 折叠——adapter 暴露启动恢复标记（如 `startedFromResume: boolean` 或启动即发出「会话已恢复」信号），`App` 据此调用与 `/session` 路径同一段折叠逻辑（`surfaceToBuffer` + `history-resume-ok` 的等价动作）。
1. **不新建并行渲染路径**：复用 `history-resume-ok`（含 `queued-clear` 等既有语义），避免两条折叠口径分叉。
1. **失败降级**：surface 读取失败 / 服务缺失 → 保持现状（空历史）并 notice 提示，不阻塞启动。
1. **范围**：只处理「启动即恢复」；`/continue` 在会话内的路径已正常，不动。

## 规划

任务拆分：

1. `src/app/index.ts`：新增启动恢复后的历史折叠（在 `restoreSessionState()` 之后或同期触发；带 disposed / stale 守卫）。
1. `src/app/adapter/types.ts` / `dsh.ts`：暴露「本次启动为恢复」标记（或让 App 直接按 `adapter.sessionId` 与启动参数判定——实现时取改动最小者）；必要时复用 `readSurface`。
1. 测试：假 adapter 模拟「启动即恢复 + surface 有消息」→ 断言 `history-resume-ok` 等价动作被调用、buffer 出现历史行；无 surface 能力时降级不抛错；非恢复启动不触发。

计划改动文件清单（**只改这些**）：

- `TUI/src/app/index.ts`
- `TUI/src/app/adapter/types.ts`
- `TUI/src/app/adapter/dsh.ts`
- `TUI/src/main.ts`（如需传「本次启动为恢复」标记）
- `TUI/tests/`（补 `app.test.ts` 或新增 `startup-resume-history.test.ts`）
- 本追踪文档

明确不做：改 `/session` 面板既有路径；改宿主 `agents.resume` 行为；启动时自动滚动 / 高亮策略调整（沿用跟随底部默认）。

## 实现记录

**实现（2026-09-27）**

1. `src/app/adapter/types.ts`：`DshAdapter` 增 `readonly resumedAtLaunch?: boolean`；`RealAdapterOptions` 增同名选项。
1. `src/app/adapter/dsh.ts`：适配器实例暴露 `resumedAtLaunch: opts.resumedAtLaunch === true`。
1. `src/main.ts`：启动分支记账 `startedFromResume`（`--resume` 成功 / `-c` 命中并成功恢复才置真，失败回落新建不算），经 `createRealDshAdapter({ resumedAtLaunch })` 下传。
1. `src/app/state.ts`：新增 action `history-restore`（`id` / `title` / `rows`）与 reducer 分支——折叠行入 buffer + 分配 `seq` + `followBottom` + 复位滚动锚点；与 `history-resume-ok` 的区别是**不依赖 `/session` 面板状态机**（启动路径没有面板），但保留「会话已切走则丢弃」的陈旧守卫；`usage` / `usageTotals` 不在本动作里重置（启动即会话，无上一会话可言）。
1. `src/app/index.ts`：新增 `restoreStartupHistory()`，在 `start()` 的 `restoreSessionState()` 之后调用；仅当 `adapter.resumedAtLaunch === true` 才读 `readSessionSurface`，成功后 `surfaceToBuffer` → `history-restore` + `queued-clear` + paint；`disposed` / 会话已切走 / 空会话一览早退；读取失败 → warn notice（不阻塞启动）。
1. 测试：新增 `tests/startup-resume-history.test.ts`（4 例）；`tests/helpers/appFakes.ts` 的 `FakeAdapter` 增 `resumedAtLaunch`（缺省 false，复用既有 `readSessionSurface` / `sessionSurfaces`）。

**口径说明**：折叠逻辑与 `/session` 切换共用 `surfaceToBuffer`（P9 的 step 概要折叠、空消息不产行等规则一并生效），只是入口动作不同——避免两条折叠口径分叉。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `npm run check`（tsc --noEmit） | 通过 |
| `npm test`（TUI 全量） | **1179 例全通过**（1179 pass / 0 fail，含新增 4 例） |

新增用例（`tests/startup-resume-history.test.ts`）：

1. `resumedAtLaunch = true` + surface 有消息 → 启动后 buffer 出现 user / assistant 历史行、`activeSessionId` 确立为恢复的会话、标题本地兜底（首条用户消息）、`followBottom = true`；
1. 非恢复启动（缺省 false）→ **不读** surface、历史区保持空；
1. 恢复但会话为空 → 不折叠任何行（不产生空行）；
1. 读取失败 → buffer 出现 warn notice「启动恢复：既有消息读取失败」、无历史行、提示上屏、不抛。

真机待确认：`tui --resume <id>` / `tui -c` 启动后历史区**直接**显示既有会话内容（无需再 `/session` 切一次）。

## 收尾

- `TUI/docs/DESIGN.md` 已在「会话生命周期」一节记 `/session` 与 CLI 恢复口径（`pickRecentSession` / `apply()` 解析 `--resume`），本轮补齐「启动恢复也折叠历史」的差异说明（见该节末句）；
- 计划外文件：`tests/helpers/appFakes.ts`（假件补 `resumedAtLaunch`，测试基础设施）；
- 待办：用户人工确认（真机 `--resume` / `-c`）→ 条目转「完成」、本文档移入 `TUI/docs/archived/`。
