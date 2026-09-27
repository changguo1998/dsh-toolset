# 垂直状态栏新增 Agents 块（只读）（接取条目：`TUI/docs/BACKLOG.md`「垂直状态栏（最左状态列）显示 agents 信息（只读）」）

状态：规划（决策已修订，待用户确认）　　开启：2026-09-27　　关闭：——
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 逐条审阅第 7 条（本条）：提出「需要定时更新状态」并要求澄清「诊断」含义 → 已三次修订决策（定时刷新；诊断与异常态按**红色告警**呈现），待确认。

## 目标

状态列现有 **Goal → Todo → Jobs** 三块，新增 **Agents** 块：只读展示当前会话子代理的 label / id / 状态（运行中·空闲），**定时更新**，沿用既有块样式、块间虚线 `╌`、折叠分级（L0-L3）与「无数据整块省略」口径；纯展示，不吃按键、不提供中断 / 关闭入口。

## 调研

来源：TUI 源码 + 宿主包。

- 状态列块机制：`layout.ts` 的 `StatusBlock`（`id: "mode" | "goal" | "todo" | "jobs"`，含 `head` / `items` / `historyFrom`）、`foldAt(block, level)`（L0-L3：先隐藏已完成、再仅进行中、最后压 1 行）、`statusBlocks(goals, todos, jobs, width)` 组装，块间 `sep()` 出虚线。新增块 = 加一个 `id` + 组装分支。
- 数据源：`adapter/dsh.ts` 的 `refreshAgents()`（`dsh.ts:2843`）已实现「子代理列表归一化」——0.1.7 起 `subagents.listDescendants(activeSessionId)` 取 `depth === 1` 的直接子代（富字段：`label` / `mode` / `activity` / `hasChildren` / `kind`），旧宿主回落 `listChildren`；结果当前只喂 `/agents` 面板（`command-panel-data`）。
- **诊断（diagnostic）语义澄清**：不是「运行时报错」，也**不属于正常状态**——是宿主目录的**告警态**：
  - 判据一（`dsh-subagent/lib/index.js:2126-2138`）：读某子条目目录失败 → `reason: "corrupt"`（会话记录损坏 / 存储源冲突）或 `"unavailable"`（临时不可枚举）；
  - 判据二（同文件 `2140-2146`）：子条目 `mode === "unknown"`（不支持的续接模式）→ `reason: "unsupported"`。
  - 含义：该子代理的会话信息不完整或不可续；正常运行的子代理不会产生诊断条目。TUI 现状：`/agents` 面板显示 `（诊断：<reason>）`、灰显、`payload` 置空（无「可中断 id」）。
- 刷新成本：宿主 `subagents.listDescendants` 为**内存目录遍历**（`dsh-subagent/lib/index.js:2099`：读子会话目录，无磁盘 IO），低频定时刷新开销可忽略。
- 宿主**没有**细粒度子代理活动事件：候选事件词汇表只有 `subagent/start` / `subagent/end`（及少量诊断类事件），故周期刷新是唯一能反映「运行中·空闲」变化的路径。
- 定时设施：现有 `StatusTicker`（`status.ts`）固定间隔 tick、一次合并查询 cwd/git/time（默认 5s）；本项复用其节律（独立 tick 或并入该 ticker，取改动最小者）。
- 会话隔离口径：goal / todo / jobs 均按 `sessionId` 分片（`goalBySession` / `todoBySession` / 顶层 `jobs`），新增块同口径。

## 决策

选项 → 选定（**已按用户审阅意见修订**）：

1. **数据源**：复用 adapter `refreshAgents()` 的归一化结果（不新建第二套列举逻辑），把归一化行同时推一份到状态列切片 `agentsBySession`；`/agents` 面板路径不变。
1. **刷新策略（修订）**：
   - **定时**：复用现有 `StatusTicker` 节律（5s）周期刷新 Agents 块；
   - **事件**：`subagent/start` / `subagent/end` 时即时补拉一次（快速反映启停）；
   - **会话**：切换 / 启动恢复各拉一次；
   - **空闲停止**：块内无子代理（无数据）或状态列被 `Ctrl+S` 隐藏时停止轮询，避免空转；失败静默。
1. **块位置**：排在 Jobs 之后（Goal → Todo → Jobs → Agents）。
1. **块内容**：每行 `label` + 状态语义（`activity` 优先、缺省回落 `mode`：one-shot / continuable）+ 短 id；**色义：运行中黄、空闲灰；一切异常态（诊断条目 / 宿主枚举失败 / 未知状态）红**；**诊断与异常态按红色告警呈现**——行首 `! ` + **红** tone + `reason` 短词（corrupt / unavailable / unsupported），不沿用面板的灰显（第三、四次修订：诊断属异常态，异常一律用红，不用黄）；`depth > 1` 以缩进体现（本项只列 depth=1 直接子代，缩进为后续扩展留位）。
1. **只读**：不吃按键、不提供中断入口（`/agents` 面板仍是唯一中断路径）。

## 规划

任务拆分：

1. `src/app/adapter/types.ts` / `dsh.ts`：`refreshAgents()` 归一化结果增推一个 app 事件（如 `{type:"agents-changed", sessionId, agents}`）；`subagent/start` / `subagent/end` 处触发刷新；暴露可被定时调用的刷新入口。
1. `src/app/status.ts`（或 `index.ts` 定时接线）：按 StatusTicker 节律调用刷新（空闲停止判据：块空 / 状态列隐藏）。
1. `src/app/state.ts`：新增 `agentsBySession: Record<string, AgentRow[]>` 与 reducer 分支；会话切换清 / 读对应分片。
1. `src/app/layout.ts`：`StatusBlock["id"]` 增 `"agents"`；`statusBlocks(...)` 增 Agents 组装分支（运行中 = active、空闲 = done；诊断条目灰 + reason）。
1. 测试：有数据出块 / 无数据省略 / 折叠分级 / 会话隔离 / 定时 tick 触发刷新且空数据时停止 / 事件即时刷新 / 诊断条目**红色告警 + reason 短词**渲染（三种 reason 各 1 例）/ 枚举失败与未知状态的红色降级渲染 / 诊断条目存在时块不省略。

计划改动文件清单（**只改这些**）：

- `TUI/src/app/adapter/types.ts`
- `TUI/src/app/adapter/dsh.ts`
- `TUI/src/app/status.ts`（定时接线，若并入 ticker）
- `TUI/src/app/state.ts`
- `TUI/src/app/layout.ts`
- `TUI/tests/`（新增 `status-column-agents.test.ts`）
- `TUI/docs/DESIGN.md`（状态列块顺序、折叠口径与定时刷新说明回写）
- 本追踪文档

明确不做：状态列内中断 / 关闭子代理；depth > 1 的树形展开；改动 `/agents` 面板；把活动区子代理行并入本块（二者视角不同，保持并存）。

## 实现记录

（待实现）

## 测试与证据

（待补：`npm run check` / `npm run test:tui` 输出）

## 收尾

（待补：DESIGN 回写、是否移入 `docs/archived/`）
