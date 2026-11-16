# @dsh-toolset/flow-track

DSH（DeepSeek Harness）进程内集成插件：把本仓「标准流程」做成**流程定义**的插件（决策项 4.4：流程定义方，不再自实现流程推进）。

## 职责边界

| 方 | 负责 |
| --- | --- |
| 本包 | 八阶段**流程定义**（`src/stages.ts` 的节点数组）+ 入口工具 `flow_start`（一次建树）+ 流程记录（`flow_record` / `flow_status` / `flow_remove` / `flow_rollback`）+ 非树级注入（合规提示 / 最近记录） |
| `task-engine` | 按节点数组建树（`composeFromNodes`）、顺序强制校验、RET 验收、状态机与查询 |
| `pin-note` | 把 task-engine 取出的**当前节点内容**保持在上下文（`pinNotes.hold("task")`） |
| `flow-arbiter` | 流程选择仲裁：只有被选中的流程入口能真正建树 |

树级内容（阶段模板 / 推进状态）**不再由本包注入**（决策项 4.4 退役）；本包也不持有流程选择开关与进程级注入开关（都归 `flow-arbiter` 的选中 + 配置 `enabled`，2026-11-17 起）。

## 八阶段定义

每个节点都是**叶子**（段内需要细化时仍可用 `task_decompose`），前置成链，全部声明 `enforceOrder`（前序阶段未完成时 task-engine 拒绝越序操作）。

| 阶段 | spec | 验收 | 门禁 |
| --- | --- | --- | --- |
| 1 目标 | 写清任务目标与验收口径 | 追踪文档含「目标」节且写明验收判据 | semantic |
| 2 调研 | 读相关代码与宿主面并给出带来源的结论 | 调研节有文件行号级来源 | semantic |
| 3 决策 | 按数字列决策项并按字母选定候选 | 每个决策项写明选定字母与理由 | semantic |
| 4 规划 | 写出计划改动文件清单与明确不做 | 含「计划改动文件清单」与「明确不做」 | semantic |
| 5 实现 | 按清单改动并追加实现记录 | 类型检查通过且实现记录已写 | semantic |
| 6 测试 | 跑相关测试并补测试与证据一节 | 测试命令与输出已入档 | semantic |
| 7 审查 | 交审查方审阅 diff 与效果并记录结论 | **human**（`approval.request`，人工确认） | human |
| 8 收尾 | 归档追踪文档并清理 BACKLOG 条目 | 追踪文档已归档且条目已清理 | semantic |

提交询问点（`docs/WORKFLOW-STANDARD.md` §5 的四处）落在阶段内部，阶段 7 的 human 门禁即「人工确认 / 审阅」那一次。

## 工具面

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `flow_start` | `parent_id?`（缺省当轮根） | 按八阶段定义一次性建树：内部调 `taskEngine.composeFromNodes`（走既有双门禁），返回 `flow` / `nodes`（八个帧 id）/ `accepted` / `next` |
| `flow_record` | `slug?`（缺省回退会话 id）、`stage`（八阶段或 `-`）、`status`（start / done / blocked / note）、`body?` | 按顺序写：首条必须是「目标」；之后只能写当前阶段（**替换**该阶段记录）或下一阶段（追加）；跳过与倒回被拒绝 |
| `flow_status` | `slug?` | 读开关态（`enabled`）、是否有未完成流程（`active`）、当前阶段（序号 / 名称 / 门禁 / spec / 帧标题；靠帧标题前缀认阶段）与最近记录 |
| `flow_remove` | `id` 或 `slug`（二选一） | 删流程记录：`id` 删一条、`slug` 删该任务全部（回 `removed` 条数） |
| `flow_rollback` | `slug?`、`stage`（八阶段） | 回退到更早阶段：清掉目标之后的记录与全部 `-` 备注（目标阶段记录保留） |

用户面：`/flow-track status`（无参缺省 status）查看注入状态——配置 / 本会话选中的流程 / 是否有未完成记录；2026-11-17 起不再有 `on|off` 开关，激活由 flow-arbiter 选中（`/flow-arbiter select <id>`）与配置 `enabled` 共同决定。

## 注入（非树级）

`pinNotes.hold("flow", provider)`：每步按 key 比对，正文不变不重投。两类内容按固定顺序合并成一条：

1. **合规提示**（本轮有写类工具调用且没有任何流程记录时）：提示先登记条目 / 建追踪文档或用 `flow_record` 记录，明写「只提示, 不拦截」；
2. **最近记录**：`最近记录：<slug>@<阶段> 状态 <status>：<正文摘要>`。

门槛：配置 `enabled`、本会话经 flow-arbiter 选中的流程、memory-base 里有未完成阶段的流程记录（最新阶段不是「收尾」）三者都满足。不满足 → 不注入（`flowArbiter` 缺席 / 未选中 → 注入关闭）。

## 服务面

`ctx.provide("flowTrack", { enabled(sessionId?), summary(sessionId?) })`——`enabled` 给「配置开启且该会话选中了流程」，`summary(sessionId?)` 返回 `{ enabled, records[{slug, stage, status, active}] }`（每 slug 最新真实阶段，`-` 不参与、收尾不算活跃；不传会话按无选中）；TUI 标题栏与状态列每 tick 懒读（传 `activeSessionId`）。

## 依赖与降级

- `inject: ["tools"]`：装配期要注册工具面，`tools` 是硬依赖。
- `memory` 缺席 → 工具返回可读错误、注入不出现；`taskEngine` 缺席 → `flow_start` 返回可读错误、`flow_status` 认不出阶段树；`pinNotes` 缺席 → 告警且不注入；`flowArbiter` 缺席 → 跳过登记（仲裁侧有内置默认登记），且注入关闭（无选中）。

## 配置

`cordis.patch.yml` 的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否允许注入（`false` 时即使会话选中流程也不注入，工具照常） |

## 插件 id

bundle 里的插件 id 是 `flow-track`（`cordis.patch.yml`）；流程 id 是 `standard`（`stages.ts` 的 `FLOW_ID`，供 `flow-arbiter` 登记与选中）。
