# 无效键提示改到面板左上（BACKLOG: TUI#3.3.6）

状态：关闭　　开启：2026-09-26　　关闭：2026-09-26

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

无效键提示从「底部按键提示区整行替换」改为「**面板内容区左上**（标题行下方第一行、左对齐）」显示；底部提示区始终显示常规按键。

## 决策

- `components/ApprovalPrompt.ts`：`ApprovalView.hint`（非空时在标题行后插入一行，`warn` 黄、左对齐）；该行从面板体行数中**先扣 1 行**再做两窗分配（`bodyRows = maxBody − hintRows`），面板总高不变。
- `layout/hints.ts`：审批态不再优先返回 `state.approvalHint`，底部始终 `approvalHintLine(state)`。
- `layout.ts`：把 `state.approvalHint` 作为 `hint` 传入面板。
- 顺带还原：`src/main.ts` 的 `approvalTimeoutMs` 由 TEMP-TEST 的 10_000 还原为 **60_000**。

## 测试与证据

- 新增 `tests/app.test.ts` 用例「审批无效键：提示画在面板内容区左上，底部提示区保持常规」：断言提示行位于标题行之后、紧贴内容区左边，且底部提示区仍含 `▶选项·[Enter]提交`。
- 全量 `node --experimental-transform-types --test tests/*.test.ts`：**1141 pass / 0 fail**；`demo --smoke` 43 pass / 0 fail；冻结基线重跑无新增差异；`check` / `build` 通过。

## 收尾

- 条目 3.3.6 标「完成」；文档回写 `docs/SPEC.md` §7.1 与 `docs/IMPLEMENTATION.md`；本追踪文档归档 `TUI/docs/archived/`。
- 遗留：无（超时值已还原 60s）。
