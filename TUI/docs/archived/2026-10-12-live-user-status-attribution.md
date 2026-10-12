# 实时路径的用户块终态归属：优先人工输入（接取条目：`TUI/docs/BACKLOG.md` 的〈实时路径的终态归属会让注入块抢走人工输入的符号〉）

状态：进行中　　开启：2026-10-12
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

实时渲染时，一个回合的终态符号（`✓` / `✗` / `■`）落在**人工输入**块上；注入块（rule-engine / goal 回合 / 子代理结果 / channel）不参与争抢。恢复侧已在 `b5196c2` 修好，本条补实时侧。

## 现状（口径）

`layout/pipeline/sections.ts` 的 `turn-end` 分支：从最后一节往前找「本世代（`item.generation === sealed.turnEnds`）第一个未定态用户 item」，命中即打标并 `break`。注入块与人工输入同世代、且常排在人工输入之后 → 符号被注入块拿走，人工输入留 `?`。

## 计划改动文件清单

- `TUI/src/app/layout/pipeline/types.ts`：`BlockDelivery` 的 `user` 变体加 `injected?: boolean`；节 item 记录该标记（沿用 `userStatus` / `steerContinued` 的透传方式）。
- `TUI/src/app/index.ts`：`rule-injection` 的交付带 `injected: true`；核对其它「注入型用户块」交付点（频道 / goal 回合 / 启动自检）是否同源。
- `TUI/src/app/layout/pipeline/sections.ts`：`turn-end` 归属改为**优先非注入块**（仍限本世代、仍不覆盖已有终态），找不到再退回现状。
- `TUI/tests/pipeline-sections.test.ts` 或 `pipeline-frame.test.ts`：用例 —— 同回合「人工输入 + 其后注入块」下符号落在人工输入上（改前应红）。
- 本文档 + `TUI/docs/BACKLOG.md`（条目状态）。

## 实现记录

1. `layout/pipeline/types.ts`：`BlockDelivery` 的 `user` 变体加 `injected?: boolean`；`Item` 加 `injected?: boolean`（注释写明用途）。
1. `layout/pipeline/sections.ts`：user 交付分支透传 `injected`；`applyTurnEnd` 的归属改为**两轮扫描** —— 从最后一节往前找本世代未定态用户块（不覆盖已有终态、跳过 `steerContinued`），**第一个命中记为兜底**，遇到 `injected !== true` 的即选中并停止；没有非注入块时退回兜底（旧口径）。
1. `index.ts`：`rule-injection` 的 `deliverLocal({ kind: "user", … })` 带 `injected: true`。核对另 4 处 `kind: "user"` 交付（`sendUserText` 两处、`queued-claim` 两处）都是人工输入 → 不加标记。

## 测试与证据

- 新增 2 条用例（`tests/pipeline-sections.test.ts`）：〈注入块排在人工输入之后也不抢符号（终态优先人工输入）〉〈本世代只有注入块时仍按旧口径落符号（没有人工输入可让）〉。
- **反向验证**：`git stash push -- src/app/layout/pipeline/sections.ts` → 新用例 **fail 1 / pass 107**；恢复后 **pass 108 / fail 0**。
- 验收数字：TUI 全量 `npm test` **1470 / 1470**（+2）；全仓 `npm test` 退出码 0（21 包全 OK）；`npm run check` / `npm run build` 各 0 条 TS 错。
- 真机复核：**待用户确认** —— 下次发消息时，即使 `[RULE]` / channel 等注入块排在你的输入之后，终态符号也应落在你那一行上。

## 审阅记录

（待补）

## 收尾

- **实现**：`8d6c1a2`（`types.ts` 的 `injected` 字段 + `sections.ts` 的两轮归属扫描 + `index.ts` 的 rule-injection 交付标记）。
- **验收对照**：
  1. 「同一回合『人工输入 + 其后注入块』下符号落在人工输入上」✓ —— 新增 2 条用例；反向验证 stash `sections.ts` → fail 1、恢复后 0 失败。
  1. 「真机复核」✓ —— 用户 2026-10-12 重启后确认「看上去没有问题」；另用真机日志做实时路径模拟（探针 `TUI/tmp/probe-live-status.mjs`，走真实 `dist`）：**人工输入带终态由 69 / 82 升到 77 / 82**，注入块相应由 207 / 298 降到 199 / 298（其余无终态的是进行中的回合与非映射原因，按设计不落符号）。
  1. 「全量测试绿 + check 干净 + build 通过」✓ —— TUI **1470 / 1470**、全仓 `npm test` 退出码 0（21 包全 OK）、`npm run check` / `npm run build` 各 0 条 TS 错。
- **遗留（另记 BACKLOG）**：无新增；`step-header` 等冒烟失败属第 2、3 条范围。
- **归档**：本文件移入 `TUI/docs/archived/`；`TUI/docs/BACKLOG.md` 移除该条。
