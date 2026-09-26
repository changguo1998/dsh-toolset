# 审批超时语义（BACKLOG: TUI#3.3.5）

状态：关闭　　开启：2026-09-26　　关闭：2026-09-26

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. **完全无操作**到超时 → 裁定 **`rejected`**（默认拒绝，替代原 `cancelled`）并提示「审批已超时（按默认拒绝处理）」。
1. 面板内**按过任意键**（含无效键）→ 停止超时计时，此后不再自动裁定、倒计时隐藏（与问答面板「人在场就不催」一致）。
1. 手动 `Esc` 仍为 `cancelled`（与超时区分）。

## 调研

- 原实现（3.3.2）：超时一律 `settle(id, "cancelled", "timeout")` → 发 `approval-closed` → App 关面板 + 提示。人工验收指出两点不符预期：超时应为**拒绝**语义；且用户已在操作时不应到点自动关面板（问答面板从不自动关闭，只靠响铃催促）。

## 决策

- `adapter/types.ts`：新增可选 `stopApprovalTimeout?(id)`（缺省实现可无此能力）。
- `adapter/dsh.ts`：超时分支 outcome 改 `rejected`（reason 仍 `timeout`）；实现 `stopApprovalTimeout(id)` → `clearTimeout(pending.timer)`（已裁定时 pending 不存在，天然幂等）。
- `state.ts`：新增 `approval-no-timeout` action → 把 `approvalDeadline` 置 `null`（隐藏倒计时；真正的计时停止在 adapter 侧）。
- `index.ts`：审批态按键分发**之前**统一调用 `stopApprovalTimeout?.(id)` 并清空 deadline —— 含无效键（「有任何操作」即算）。

## 实现记录

- 上述四处改动；测试更新：`tests/adapter.dsh.test.ts` 的超时用例断言改 `rejected`、新增「stopApprovalTimeout 后不再自动裁定（超时值 30ms 等待 70ms 仍无 `approval-closed`，显式应答仍生效）」；`tests/app.test.ts` 的超时提示断言语更新、新增「按过任意键后停止超时并隐藏倒计时（`(30s)` 消失、面板保持打开、fake 记录 stopApprovalTimeout 调用）」。

## 测试与证据

- 全量 `node --experimental-transform-types --test tests/*.test.ts`：**1140 pass / 0 fail**。
- `npm run demo -- --smoke`：**43 pass / 0 fail**；冻结基线重跑无新增差异；`npm run check` / `npm run build` 通过。
- 人工复验点：无操作 10s → 面板自动关闭且提示「按默认拒绝处理」；打开后立即按任意键 → 倒计时消失、面板不再自动关闭。

## 收尾

- 条目 3.3.5 标「完成」；文档回写 `docs/SPEC.md` §7.1 与 `docs/IMPLEMENTATION.md`；本追踪文档归档 `TUI/docs/archived/`。
- 遗留：`src/main.ts` 的 `approvalTimeoutMs` 仍是 **10s（TEMP-TEST）**，人工验收完成后还原 60_000。

## 人工复验结果（2026-09-26，重启后）

- **通过**：面板打开后**无操作**，10s 到点自动关闭，并提示「审批已超时（按默认拒绝处理）」；随后工具调用返回 `rejected`（命令未执行，无残留）。
- **按键路径全部通过**（2026-09-26）：① 按任意键后拒绝项倒计时立即消失、面板不再自动超时；② `Tab` 切焦点窗且描述窗左侧列变黄；③ `↑/↓` 随焦点窗分派（选项窗移项 / 草稿窗滚动）；④ 无效键显示 `[无效键] …`；⑤ `Esc` 取消生效（工具调用返回 `cancelled`）。
- 新需求（同日反馈）：**无效键提示不要放在底部按键提示区，改为从左上开始显示** —— 见 BACKLOG 3.3.6。
