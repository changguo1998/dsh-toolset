# 状态列 Agents 列表：显示别名 + 工作内容，不加状态文字提示（接取条目：`TUI/docs/BACKLOG.md`「垂直状态列 Agents 列表：显示别名 + 工作内容，不加状态文字提示」）

状态：决策　　开启：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

状态列 Agents 块每条显示**别名 + 工作内容**（该 agent 正在做什么），去掉工作状态的**文字**（`运行中 / 空闲 / inactive` 等）；状态语义保留符号与配色；诊断条目的原因保留。

## 调研

- 现状渲染：`layout.ts#agentItemRows`（BACKLOG TUI#39）：`符号 名称 · 状态词 短id`；符号 / 颜色 = `●` 黄（running）/ `○` 灰（inactive）/ `!` 红（诊断）；状态词取 `entry.activity ?? entry.mode`。
- 宿主实测：`dsh-subagent` 的 `listDescendants` 条目 `activity` **就是** `running | inactive`（宿主源码），即「要去掉的状态词」本身；条目字段仅 id / label / mode / activity / hasChildren / 诊断 —— **无任务描述或当前动作**。
- 数据链路：`adapter.refreshAgents()`（`dsh.ts`）→ `subagents.listDescendants(activeSessionId)`（depth=1）→ 归一化 `AgentRowInfo{id,label,status,diagnostic?}` → `agents-changed` → `state.agentsBySession` → 状态列 Agents 块。
- 可用素材：
  - **别名**：`session-channel` 的 `aliasList()`（会话 id → 别名）；App 已有按节拍刷新（现仅缓存**活跃会话**的别名，`index.ts`），可扩为全量映射。
  - **工作内容**：adapter 的宿主事件订阅是**全会话**的（`runtime.on("session/event", (session, event) => …)`）——可按 `session.id` 记录每个子代理会话「最近一次工具调用」（`tool/call` 的 name + 参数摘要），`refreshAgents` 时并入行数据；无记录则省略该段。
- 测试现状：`tests/status-column-agents.test.ts`（状态列 Agents 块）、`tests/command-panel-agents-tools.test.ts`（/agents 面板与静默刷新）。

## 决策

1. **别名**：`AgentRowInfo` 增 `alias?`；App 的别名刷新扩为 `sessionId → alias` 全量映射（同一节拍；活跃会话别名的既有行为不变），构建状态列时按行 `id` 回填。
1. **工作内容**：`AgentRowInfo` 增 `work?`；adapter 在既有 `session/event` 订阅里按会话记录**最近一次 `tool/call`**（`name` + 参数摘要，截断 ≤40 显示列；无参数只显示 name）；`refreshAgents` 时按 `entry.id` 回填，并**清理已离场会话**条目（防无界增长）。
1. **行文本**：`{符号}{别名 ?? label}{work ? " · " + work : ""}`——去掉状态词与短 id（详细仍见 `/agents` 面板）；符号与配色不变（状态由视觉表达）；诊断条目沿用 `! （诊断：reason）` 红行（异常态不算「工作状态」）。
1. 备选（未选）：用宿主 `activity` 当工作内容——实测就是 running/inactive（正是要去的文字）✗；订阅宿主 `workspace/session-activity`——其语义为该会话的**子代清单**，同样不含动作描述 ✗。

## 规划

计划改动文件清单（**只改这些**）：

1. `TUI/src/app/adapter/types.ts`：`AgentRowInfo` 增 `alias?` / `work?`。
1. `TUI/src/app/adapter/dsh.ts`：会话事件里按会话记录「最近工具调用」；`refreshAgents` 回填 `work` 与清理。
1. `TUI/src/app/index.ts`：别名刷新扩为全量映射；状态列构建时回填 `alias`。
1. `TUI/src/app/layout.ts`：`agentItemRows` 行文本改为「别名 + 工作内容」。
1. `TUI/tests/status-column-agents.test.ts`（+ 按需 `TUI/tests/adapter.dsh.test.ts`）：行文本断言 + 回填用例。
1. `TUI/docs/BACKLOG.md`：条目「完成」标记与收尾清理。
1. 本追踪文档。

明确不做：不动 `/agents` 面板（详细视图保留原样）；不改符号 / 配色语义；不做悬挂对齐（「Agents 条目改列表式悬挂对齐」另条）。

## 实现记录

（待写）

## 测试与证据

（待写）

## 收尾

（待写）
