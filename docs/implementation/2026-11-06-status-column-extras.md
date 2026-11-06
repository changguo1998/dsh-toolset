# 状态列增加 task / flow / pin / daemon / group 五块

接取条目：`docs/BACKLOG.md`「状态列增加 task / flow / pin / daemon / group 五块」

## 目标

- 状态列在宿主四块之后追加五块，数据来自本仓插件：
  - Task：`task-engine` 的任务树（活跃帧 / 总数 + 逐帧状态）
  - Flow：`flow-track` 的注入开关 + 最新流程记录（无记录时不显示）
  - Pin：`pin-note` 的保持项（条数 / 合计字数 + 每条标题）
  - Daemon：`background-daemon` 的任务表（运行中 / 总数 + 每条）
  - Group：`agent-group` 的群组（**只显示上级 agent 与直接子 agent，不展开嵌套**）
- 五块都遵循「该项无内容时整块不显示」；有内容时汇总行 + 逐条明细，并按状态列高度走既有 L0→L3 折叠。
- 验收：五种状态分别出现 / 消失；空状态不占行；Group 不显示二级以下成员；单测覆盖块生成与省略规则。

## 调研

- 状态列四块与折叠：`TUI/src/app/components/StatusColumn.ts:222`（`statusColumnBlocks`）、`:183`（`foldBlock`：L1 隐藏 done、L2 只留 active）；块数据入口 `StatusColumnData`（`:115`），组装入口 `TUI/src/app/layout/title-bar.ts:173`（`renderStatusColumn`）。
- 数据面：
  - `task-engine`：`taskEngine.query()` → `{ tasks, frameStack, activeCount, isComplete }`（`flow-track/src/status.ts:19` 同口径）。
  - `flow-track`：服务面 `flowTrack.enabled()`；流程记录落 memory-base 项目层 kind `flow`（`flow-track/src/store.ts:56`）。
  - `pin-note`：保持项入 memory-base 会话层 kind `pin`（`pin-note/src/index.ts:5`）。
  - `background-daemon`：服务面 `backgroundDaemon.status()` → `{ enabled, running, taskCount, inflight, ... }`（`background-daemon/src/service.ts:15`），任务表 `list()`。
  - `agent-group`：内存镜像 kind `agent_group`（`agent-group/src/mirror.ts:44`），群组/成员关系另有只读面可选。
- 懒读先例：`TUI/src/main.ts:939`（`getRuleEngine`）、`:966`（`getGuard`）；TUI 先于插件装载，故一律惰读 + ticker（`TUI/src/app/runtime/lifecycle.ts:294`，1s）。

## 决策

1. 显示粒度：**b 选定（用户 2026-11-06）** —— 汇总 + 逐条明细，按情况展示（复用 L0→L3 折叠：L1 隐藏完成项、L2 只留活跃项）。
2. 空状态：**a 选定（用户裁定）** —— 无内容整块不显示，与 Jobs / Agents 同口径。
3. Group 范围：**a 选定（用户裁定）** —— 只显示上级 agent 与直接子 agent，嵌套层不展开。
4. 数据获取：**a 选定** —— TUI 惰读服务面与 memory-base（kind `flow` / `pin` / `agent_group`），不为显示新增插件写面；flow-track 已有 `flowTrack` 服务面。
5. 刷新：**a 选定** —— 随状态行 `StatusTicker`（1s）异步拉取，值变化才派 action 重绘。

## 计划改动文件清单

- `TUI/src/app/state/types.ts` / `initial.ts` / `actions.ts` / `reducer-view.ts`：`statusExtras` 快照与 action。
- `TUI/src/app/app-deps.ts` / `TUI/src/main.ts`：`getTaskEngine` / `getDaemon` / `knowledge`（memory）/ `getFlowTrack` / `getAgentGroup` 惰读接线。
- `TUI/src/app/runtime/wiring.ts`：`refreshStatusExtras()`（并发读取五个来源 → 归一成块级快照）。
- `TUI/src/app/runtime/lifecycle.ts`：ticker 内调用。
- `TUI/src/app/components/StatusColumn.ts`：五个块的生成（head + items + done/active 标记）。
- `TUI/src/app/layout/title-bar.ts`、`top-region.ts`：透传快照。
- `TUI/tests/*`：块生成 / 省略 / Group 不展开用例。
- 文档：`TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`、`TUI/README.md`。

**明确不做**：不改五个插件的数据模型（Flow 只读已有记录；Pin 只读会话层）；不新增斜杠命令；不做状态列滚动口径变更。

## 实现记录

（实现后补）

## 测试与证据

（实现后补）

## 偏差

（实现后补）

## 收尾

（关闭时补）
