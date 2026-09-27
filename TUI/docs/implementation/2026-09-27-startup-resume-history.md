# CLI `--resume` / `-c` 启动恢复后历史区渲染既有消息（接取条目：`TUI/docs/BACKLOG.md`「CLI `--resume` / `-c` 启动恢复后历史区为空（不渲染既有消息）」）

状态：规划（决策已通过审阅，待实现）　　开启：2026-09-27　　关闭：——
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

（待实现）

## 测试与证据

（待补：`npm run check` / `npm run test:tui` 输出 + PTY 真机复现对照）

## 收尾

（待补：DESIGN / README 会话生命周期口径回写、是否移入 `docs/archived/`）
