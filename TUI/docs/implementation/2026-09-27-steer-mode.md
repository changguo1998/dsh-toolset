# 新增 `<` 前缀的 steer 输入模式（接取条目：`TUI/docs/BACKLOG.md`「新增 `<` 前缀触发的输入状态（steer 模式）：提交的消息进 steer 队列」）

状态：测试（实现完成；已按真机反馈修复「steer 未接线」缺陷，待复验）　　开启：2026-09-27　　关闭：——
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
- `TUI/tests/steer-mode.test.ts`（新建）
- `TUI/README.md`（输入模式一节口径）
- 本追踪文档

明确不做：不动 `$` shell 模式（其路由属另一条条目）；不改 `/` 命令路由；不做 steer 专用历史队列或多条合并。

## 实现记录

**实现（2026-09-27）**

1. `src/app/state.ts`：`InputMode` 增 `"steer"`（`commands.ts` 的 `InputModeLike` 同步，避免类型不兼容）。
1. `src/app/layout.ts`：`MODE_SYMBOL` 增 `steer: "<"`。
1. `src/app/index.ts`：模式键分支增 `<`（空输入 + 非 ctrl → 切 `steer` 并吞键，与 `$`/`/` 同判定、同幂等）；`submit()` 增 steer 分流——`queued-push` 登记显示 + `adapter.sendMessage(text, sid, "next-step")`，宿主 `canSteer()` 为 false 时**不传 target**（真降级为 followup）并给 warn notice。
1. `src/app/adapter/types.ts` / `dsh.ts`：`DshAgentLike` 增可选 `steer?()`；`DshAdapter.sendMessage` 增第三参 `target?: "next-step"` 与 `canSteer?()`；真机实现按 `typeof activeAgent.steer === "function"` 分派 steer / followup。
1. `tests/helpers/appFakes.ts`：`FakeAdapter.sendMessage` 记录 `target`（新增 `steered`）并增 `steerSupported` / `canSteer()` 开关。
1. `tests/steer-mode.test.ts`：4 例（见「测试与证据」）。

**宿主口径（已核实）**：官方 `dsh-agent` 的 `AgentLoop` 提供 `steer(message)` = 「投递到最近 step 边界；空闲 driver 立即起一轮，运行中在下一 step 认领」（`dsh-agent/lib/types/runtime-types.d.ts:192-200`），不是 `send(m,'next-step',true)` 的手写等价物——直接调用官方方法，语义与宿主一致。

**修复（2026-09-27，真机反馈）**

- 现象：真机 `<` 提交后消息出现在**下一回合**（会话日志 `agent/inbox/spliced` 记录 `target: "next-turn"`），即 steer 从未生效。
- 根因（两处，缺一不可）：
  1. `main.ts` 构造给 adapter 的**瘦 agent** 只转发了 `followup`，没有转发 `steer`；adapter 的 `canSteer()` 只看瘦 agent → 真实会话恒 false → App 走降级 followup 分支（并有降级提示，但用户极易忽略）；
  1. `/session` resume 路径新建的瘦 agent 同样只有 `followup`，即便修了 main.ts 也会再次踩坑。
- 修法：adapter 改为**优先使用已跟踪的原始宿主 agent**（`activeCommandAgent`，随 resume/new 同步切换）派发 steer，瘦 agent 仅作兜底；`canSteer()` 两层都看。App 侧顺带修正两处观察口径：
  - `<` 提交改为**与直发同路径**（立即回显用户块 + 开回合分隔），**不再登记排队块**（排队语义 = 等下一回合，而 steer 属当前回合）；
  - 降级提示移到发送**之后**（此前会被 `turn-begin` 清活动区吃掉）。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `npm run check`（tsc --noEmit） | 通过 |
| `npm test`（TUI 全量） | **1165 例全通过**（1165 pass / 0 fail，含新增 4 例） |

用例清单（`tests/steer-mode.test.ts`）：

1. 空输入按 `<` 进 steer 模式（输入区提示符渲染为 `<`）、同符号幂等不叠加为文本；
1. 提交走 `target='next-step'`（`adapter.steered` 命中）、本机排队显示、提交后回退 normal（下一次普通提交走 followup）；
1. 宿主不支持 steer（`canSteer()` false）→ 消息仍发出、未走 steer 投递、给出降级提示；
1. 空 steer 输入按 Backspace 回退 normal（与 `$`/`/` 同机制）。

## 收尾

- 已回写 `TUI/README.md`（输入模式一节：补 `<` steer 语义与降级口径）与 `TUI/docs/DESIGN.md`（输入区提示符表）；
- 计划外文件：`src/app/commands.ts`（`InputModeLike` 同步 `steer`，类型兼容所需）、`tests/helpers/appFakes.ts`（`sendMessage` 增 target 记录）；
- 真机取证（2026-09-27）：会话日志显示 `<` 提交落 `next-turn`（非 `next-step`）→ 定位并修复；
- 待办：用户复验（真机：运行中 `<` 提交在下一 step 被认领、空闲时立即起一轮）→ 条目转「完成」、本文档移入 `TUI/docs/archived/`。
