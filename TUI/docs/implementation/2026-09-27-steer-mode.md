# 新增 `<` 前缀的 steer 输入模式（接取条目：`TUI/docs/BACKLOG.md`「新增 `<` 前缀触发的输入状态（steer 模式）：提交的消息进 steer 队列」）

状态：规划（决策已通过审阅，待实现）　　开启：2026-09-27　　关闭：——
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 逐条审阅第 4 条（本条），决策**通过**。

## 目标

空输入时按 `<` 进入 steer 模式：该模式提交的消息**不进下一回合队列**，改走宿主 `agent.steer`（= 在当前回合的下一个 step 边界被认领，可续回合）；空闲时 steer 立即起一轮。提示符与既有前缀模式（`$` / `/`）同机制。

## 调研

来源：TUI 源码 + `TUI/docs/DESIGN.md`。

- 前缀模式实现点：类型 `InputMode = "normal" | "shell" | "slash"`（`state.ts:99`）；空输入 + 非 ctrl 时按 `$`/`/` 切模式并吞键、按 Backspace 回退（`index.ts:1799-1808`）；提示符映射在 `layout.ts:2290-2294`；提交分流在 `submit()`（`index.ts:2005` 附近：slash 前缀走命令路由，其余走 followup）。
- 宿主投递面：官方 `agent.steer` 语义 = `send(message, 'next-step', true)`（进 next-step 队列并唤醒）。TUI adapter 现有 `followup`（`adapter/types.ts:783`）与队列显示登记；`steer` 需在 adapter 结构面按宿主能力探测（缺失时降级）。
- 与 rule-engine 的 next-step 注入是同一队列语义（`agent/inbox` next-step），TUI 侧无需额外机制。

## 决策

选项 → 选定（本次实现自定，**待用户审阅**）：

1. 模式符号：`<`（用户条目原文）；`InputMode` 增加 `"steer"`，提示符表加一档。
1. 投递：`submit()` 在 steer 模式下调用 adapter 新增方法（`activeAgent.steer` 优先）；宿主未暴露 `steer` 时 **warning 降级为 `followup`**（保留消息不丢，提示走 notice）。
1. 排队/状态显示：与普通 followup 同口径登记（用户块 + 排队标记），不新造状态。
1. 模式生命周期：与 `$` / `/` 完全一致（提交复位 `>`、空输入 Backspace 回退、同符号幂等）。

## 规划

任务拆分：

1. `src/app/state.ts`：`InputMode` 增 `"steer"`。
1. `src/app/layout.ts`：提示符表增 `<`。
1. `src/app/index.ts`：模式键分支增 `name === "<"`；`submit()` 增 steer 分流（含降级 warning + notice）。
1. `src/app/adapter/types.ts` / `dsh.ts`：adapter 增 `steer(message)` 方法（探测 `agent.steer`，缺失返回不可用标记）。
1. 测试：模式切换与幂等、提示符渲染、提交走 steer（假 adapter 断言调用）、缺 steer 时降级 followup、提交后回退 `>`。

计划改动文件清单（**只改这些**）：

- `TUI/src/app/state.ts`
- `TUI/src/app/layout.ts`
- `TUI/src/app/index.ts`
- `TUI/src/app/adapter/types.ts`
- `TUI/src/app/adapter/dsh.ts`
- `TUI/tests/app.test.ts`（或新建 `TUI/tests/input-mode-steer.test.ts`）
- `TUI/README.md`（输入模式一节口径）
- 本追踪文档

明确不做：不动 `$` shell 模式（其路由属另一条条目）；不改 `/` 命令路由；不做 steer 专用历史队列或多条合并。

## 实现记录

（待实现）

## 测试与证据

（待补：`npm run check` / `npm run test:tui` 输出）

## 收尾

（待补：README / `TUI/docs/DESIGN.md` 输入区口径回写、是否移入 `docs/archived/`）
