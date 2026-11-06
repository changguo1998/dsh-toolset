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

- **状态列结构**：`TUI/src/app/components/StatusColumn.ts:222` 逐块生成 `StatusBlock`（`head` + `items` + 可选 `historyFrom`）；`:183` `foldBlock` 对**通用块**按 `item.done` / `item.active` 两级折叠（L1 隐藏 done、L2 只留 active），正好满足「按情况展示」；入口 `:134` `buildStatusColumnBox(data, level)`。
- **数据透传**：`TUI/src/app/layout/title-bar.ts:173` `renderStatusColumn(goals, todos, jobs, scroll, height, width, agents, activation, runTokens, goalRounds)` 收 10 个位置参数；调用点 `TUI/src/app/layout/top-region.ts:307`；`StatusColumnData` 定义在 `StatusColumn.ts:115`。新增五块若继续加位置参数会超长，宜改成「一个 extras 快照对象」。
- **状态来源**：
  - Task：`TUI/src/app/adapter/types/services.ts:16` `TaskEngineQueryLike { tasks, frameStack, activeCount, isComplete }`；服务面 `taskEngine.query()`，`adapter-options.ts:120` 已有 `taskEngine` 惰读字段（`main.ts:857` 一带）。
  - Flow：`flow-track` 服务面 `flowTrack.enabled()`（`flow-track/src/index.ts:212`）；流程记录在内存缓存 `cache.records`，结构 `FlowRecord { id, slug, stage, status, body, createdAt }`（`flow-track/src/store.ts`）。
  - Pin：记录在 **会话层**（`pin-note/src/index.ts:4`）；memory-base 全局面 `list` **跳过会话层**（`memory-base/src/index.ts:388` `isSessionTier`），TUI 现有 `KnowledgeServiceLike.list`（`TUI/src/app/adapter/types/memory.ts:44`）也无法按 sessionId 读 —— 只能由 pin-note 提供只读面。
  - Daemon：`background-daemon` 服务面 `backgroundDaemon.status()` → `{ enabled, running, inflight, taskCount, ... }`（`background-daemon/src/service.ts:15`）与 `list()`；TUI 侧目前无对应惰读字段。
  - Group：`agentGroup.status(managerSessionId)` 返回 `groups[{ name, view }]`（`TUI/src/app/adapter/types/services.ts:89`）；`view.members[{ name, level, role }]`、`view.links[{ from, to, level }]`（`agent-group/src/types.ts:58`、`:63`）。**上级 = `role === "manager"` 的成员；直接子 = `links` 里 `from === 上级名` 的 `to`**，天然满足「不展开嵌套」。
- **刷新面**：状态行 `StatusTicker` 1s（`TUI/src/app/runtime/lifecycle.ts:294`），`apply` 里已有 `refreshModelStatus` / `maybeRefreshAgents` / `maybeRefreshSessionAlias` / `maybeRefreshFlowTrack` 四个同名模式；`wiring.ts:147` 是懒读写法样例。
- **装载顺序**：profile `bundles` 里 `@dsh-toolset/tui` 第 3 位（`~/.dsh/profiles/fff/package.json:48`），task-engine / memory-base / flow-track / pin-note / background-daemon / agent-group 都在其后 —— 一律惰读。

## 决策

01. 显示粒度：**b 选定（用户 2026-11-06）** —— 汇总 + 逐条明细，按情况展示（复用 L0→L3 折叠：L1 隐藏完成项、L2 只留活跃项）。
02. 空状态：**a 选定（用户裁定）** —— 无内容整块不显示，与 Jobs / Agents 同口径。
03. Group 范围：**b 选定（用户修订）** —— 两类组都显示、只到直接关系：
    - 本 agent **加入**的组（它是成员，不是组长）→ 显示 `上级 <直接上级名>`；
    - 本 agent **创建**的组（它是组长）→ 显示 `子 <直接子列表>`；
      两类都不展开更下一层。
04. Group 数据来源（新增）：**c 选定** —— 现有 `agentGroup.status(managerSessionId)` 只读该会话**创建**的组（store 按管理者目录存 `agent-group.json`，`agent-group/src/store.ts:84`），读不到「加入的组」；镜像也只落会话层（`agent-group/src/mirror.ts:77`），全局面无法列举。故需 agent-group 新增按会话的只读摘要 `summary(sessionId)`，返回 `{ created: [{name, children[]}], joined: [{name, parent}] }`；实现取项目层（可列举）而不是逐会话扫目录，避免 1s ticker 反复读盘。
05. 数据获取：**b 选定（改自初稿）** —— Task / Daemon / Group 走服务面惰读；Flow 由 `flowTrack` 服务面新增只读摘要（避免 TUI 异步读库）；**Pin 由 pin-note 新增只读面**（会话层无法从全局面读）。理由：`memory.list` 跳过会话层（`:388`），Pin 无替代通道；其余走现有/新增服务面比 TUI 解析 memory 行更稳。
06. 刷新：**a 选定** —— 随 `StatusTicker`（1s）异步拉取五个来源，拼成一个 `statusExtras` 快照，值变化才派 action 重绘。
07. 透传形态：**b 选定** —— 不再给 `renderStatusColumn` 加位置参数，改为透传 `statusExtras` 对象（`StatusColumnData.extras`）。
08. 块顺序与标题：**a 选定（2026-11-06 修订）** —— 追加在宿主四块之后，顺序 Task / Flow / Pin / Daemon / Group；标题分别为 `Task <活跃>/<总>`、`Flow <slug@stage>`（**不带开/关**）、`Pin <n> 条 · <字数> 字`、`Daemon <开|关> · <运行>/<总>`、`Group <n> 组`。
09. 条目符号：**b 选定（用户修订）** —— 不用 `-` 前缀，改与状态列既有口径一致的符号（`TODO_MARKER`：`○` 待办 / `●` 进行中黄 / `✓` 完成；`statusMark`：`●` 运行中黄 / `✗` 失败红 / `○` 取消或中性灰 / `✓` 完成），格式 `<符号> <正文>`（符号后一个空格）；Group 两类各一行：本 agent 创建的组 `○ <组名> · 子 <直接子1, 直接子2…>`，本 agent 加入的组 `○ <组名> · 上级 <直接上级>`。
10. Task 明细范围：**b 选定（用户修订）** —— 只显示**当前任务栈**（`frameStack` 自底向顶逐层一行，最上层为当前帧），不铺整棵树；不折行，超长截断。符号：当前帧 `●`（黄）、其余栈层 `○`（灰）。
11. 不折行 + 截断保状态：**a 选定（用户修订）** —— 所有新块明细 `wrap: false`；超宽时只截断「名称/正文」部分并以 `…` 收尾，**尾部状态信息保留**。示例：`● 长slug名字…@阶段 状态`。
12. Flow 明细格式：**a 选定（用户修订）** —— 每 slug 一行，符号按最新记录 status（`●` start 黄 / `✓` done / `✗` blocked 红 / `○` note 灰），正文为 `<slug…>@<阶段> <状态>`；标题行去开/关，只留最新 `slug@阶段`。

## 计划改动文件清单

- `flow-track/src/index.ts`：`flowTrack` 服务面加 `summary()`（开关 + 最新阶段 + 每 slug 最新记录）。
- `pin-note/src/index.ts`：新增 `pinNotes` 服务面 `summary(sessionId)`（条数 / 字数 / 标题）。
- `agent-group/src/index.ts`（+ 镜像或索引）：新增 `agentGroup.summary(sessionId)`，返回 `created[{name, children[]}]` 与 `joined[{name, parent}]`；镜像落点从会话层改项目层（或另建项目层索引）以支持全局面按会话过滤。
- `TUI/src/app/adapter/types/services.ts`：`FlowTrackLike.summary`、`PinNotesLike`、`DaemonLike`、`AgentGroupLike.summary`。
- `TUI/src/app/app-deps.ts` / `TUI/src/main.ts`：`getTaskEngine` / `getDaemon` / `getPinNotes` / `getAgentGroup` / `getFlowTrack` 惰读接线。
- `TUI/src/app/state/types.ts` / `initial.ts` / `actions.ts` / `reducer-view.ts`：`statusExtras` 快照与 action。
- `TUI/src/app/runtime/wiring.ts`：`refreshStatusExtras()`（并发取五源 → 归一）。
- `TUI/src/app/runtime/lifecycle.ts`：ticker 内调用。
- `TUI/src/app/components/StatusColumn.ts`：五个块生成（head + items + done/active 标记）。
- `TUI/src/app/layout/title-bar.ts`、`top-region.ts`：透传 `statusExtras`。
- `TUI/tests/*`：块生成 / 省略 / Group 只到直接子 / 折叠等级用例。
- 文档：`TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`、`TUI/README.md`、`flow-track/README.md`、`pin-note/README.md`。
- `AGENTS.md`：两个包的服务面描述补一句。

**明确不做**：不改 memory-base 会话层读面；不给其余插件加写面；不新增斜杠命令；不做状态列滚动口径变更。

## 实现记录

（实现后补）

## 测试与证据

（实现后补）

## 偏差

（实现后补）

## 收尾

（关闭时补）
