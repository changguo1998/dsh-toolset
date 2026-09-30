# 状态列 Agents 列表：显示别名 + 工作内容，不加状态文字提示（接取条目：`TUI/docs/BACKLOG.md`「垂直状态列 Agents 列表：显示别名 + 工作内容，不加状态文字提示」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
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
- 数据流核实（2026-10-01 实施前）：状态列数据由 `layout.ts` 纯函数从 `state.agentsBySession` 读出，**App 的别名缓存没有同步通道注入行数据** → 别名改为在 `refreshAgents` 快照内落行（adapter 经 `RealAdapterOptions.sessionChannel` 只读面懒读；`main.ts` 加访问器）。原「App 侧全量映射回填」方案作废（见规划修订）。

## 决策

1. **别名**：`AgentRowInfo` 增 `alias?`；adapter 在 `refreshAgents` 快照内按行 `id` 回填（别名清单经 `sessionChannel` 只读面懒读，失败静默不阻塞；不经过 App 状态）。
1. **工作内容**：`AgentRowInfo` 增 `work?`；adapter 在既有 `session/event` 订阅里按会话记录**最近一次 `tool/call`**（`name` + 参数摘要，截断 ≤40 显示列；无参数只显示 name）；`refreshAgents` 时按 `entry.id` 回填，并**清理已离场会话**条目（防无界增长）。
1. **行文本**：`{符号}{别名 ?? label}{work ? " · " + work : ""}`——去掉状态词与短 id（详细仍见 `/agents` 面板）；符号与配色不变（状态由视觉表达）；诊断条目沿用 `! （诊断：reason）` 红行（异常态不算「工作状态」）。
1. 备选（未选）：用宿主 `activity` 当工作内容——实测就是 running/inactive（正是要去的文字）✗；订阅宿主 `workspace/session-activity`——其语义为该会话的**子代清单**，同样不含动作描述 ✗。

## 规划

计划改动文件清单（**只改这些**）：

1. `TUI/src/app/adapter/types.ts`：`AgentRowInfo` 增 `alias?` / `work?`；`RealAdapterOptions` 增 `sessionChannel?`。
1. `TUI/src/app/adapter/dsh.ts`：会话事件里按会话记录「最近工具调用」；`refreshAgents` 回填 `alias` / `work` 与清理。
1. `TUI/src/main.ts`：适配器选项加 `sessionChannel` 访问器（1 处）。
1. `TUI/src/app/layout.ts`：`agentItemRows` 行文本改为「别名 + 工作内容」。
1. `TUI/tests/status-column-agents.test.ts`（+ 按需 `TUI/tests/adapter.dsh.test.ts`）：行文本断言 + 回填用例。
1. `TUI/docs/BACKLOG.md`：条目「完成」标记与收尾清理。
1. 本追踪文档。

明确不做：不动 `/agents` 面板（详细视图保留原样）；不改符号 / 配色语义；不做悬挂对齐（「Agents 条目改列表式悬挂对齐」另条）。

## 实现记录

1. 2026-10-01 按规划实施（含 1 处数据流修正：别名改在 `refreshAgents` 快照内落行，不经过 App，见调研末条）：
   - `adapter/types.ts`：`AgentRowInfo` 增 `alias?` / `work?`；`RealAdapterOptions` 增 `sessionChannel?`（只读面访问器）。
   - `adapter/dsh.ts`：`onSessionEvent` 在活跃会话过滤**之前**按 `session.id` 记录 `tool/call`（`workSummary` = name + `summarizeToolArguments` 摘要，截 ≤40 字符）；`refreshAgents` 懒读 `aliasList`（失败静默）并按 id 回填 `alias` / `work`，随后清理离场会话的摘要（防无界增长）。
   - `main.ts`：适配器选项加 `sessionChannel` 访问器（1 处）。
   - `layout.ts`：`agentItemRows` 行文本 = `{符号}{别名 ?? label}{" · " + work}`；删去状态词与短 id。
1. 测试：`tests/status-column-agents.test.ts` 更新行文本断言（不带状态词/短 id）+ 新增「显示别名 + 工作内容」用例；`tests/adapter.dsh.test.ts` 新增「状态列行带别名与工作内容（子会话 tool/call；离场清理）」用例。
1. 途中修正：测试内 `AdapterServices.sessionChannel` 的类型先误写为服务态、后改为访问器；`Entry` 类型经 `NonNullable` 取非可选方法返回值。

## 测试与证据

- 单测：`npm run test:tui -- status-column-agents.test.ts` → 7 pass / 0 fail；`npm run test:tui -- adapter.dsh.test.ts` → 180 pass / 0 fail（含新增用例）。
- 全量：`npm run test` → 16 包全绿（TUI 1227 / 0 fail）。
- 机械门禁：`npm run check` exit 0；`npm run build` exit 0。
- 真机确认（2026-10-01，点 3 前）：重启载入新构建 + 起 90 秒验证子代理 → 目视状态列 Agents 块：**行文本内容正确**（`● 名字 · 工具摘要`，无状态词、无短 id）✓。用户同时指出**续行换行仍与首字符对齐**——即 `TUI/docs/BACKLOG.md`「Agents 条目改列表式悬挂对齐」条目，另条处理（非本任务范围）。

## 收尾

- 回写：无需（`TUI/docs/DESIGN.md` / `SPEC.md` 未描述该块行文本口径；`/agents` 面板未变）。
- BACKLOG 清理：TUI 条目「垂直状态列 Agents 列表：显示别名 + 工作内容，不加状态文字提示」已标「完成」（2026-10-01）并移除。
- 归档：本追踪文档移入 `TUI/docs/archived/`。
- 残留检查：`git status` 无计划外文件；`tmp/` 无任务临时文件。
- 遗留项：无（真机发现的**续行对齐**症状属 `TUI/docs/BACKLOG.md`「Agents 条目改列表式悬挂对齐」条目，另条处理）。
