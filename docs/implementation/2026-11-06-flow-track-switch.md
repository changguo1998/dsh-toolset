# flow-track 注入开关（默认关, 内存态）

接取条目：`docs/BACKLOG.md`「flow-track 注入开关（默认关, 内存态）」

## 目标

- 新增进程内开关，缺省关闭；只有开关打开且 memory-base 中存在未完成阶段的任务时才注入；关闭时连阶段模板与合规提示一起不注入。
- 用户面命令 `/flow-track on|off|status` 与模型面工具 `flow_enable` 都能切换；状态只在内存，进程结束即丢失。

## 调研

- 现有注入：`flow-track/src/index.ts:247` 注册 rule-engine 消费者（`sources` 缺省 `turn-start` + `user-message`），`decide` 里组装 `decideText`；`flow-track/src/inject.ts:50` 把推进状态 / 合规提示 / 最近记录拼成一段，没有任何开关。
- 记录面：`flow-track/src/store.ts:312` 读项目层 kind `flow`，时间正序；`flow-track/src/policy.ts` 已有 `latestStageRecord`（跳过 `-` 备注）与 `stageIndex`，可直接判「最新阶段是不是收尾」。
- 命令注册先例：`background-daemon/src/commands.ts:305`（`ctx.commands.register({ definitionId, name, description, input, handler })`）、`auto-approve/src/command.ts:259`（handler 返回 `{ kind, text }`）。
- 工具面：`flow-track/src/tools.ts` 现有 4 个工具（`flow_record` / `flow_status` / `flow_remove` / `flow_rollback`），`deps` 已含 `store` / `observer` / `snapshot` / `slugFor` / `onRecorded`。

## 决策

1. 活跃任务判据：**b 选定（用户 2026-11-06 裁定）** —— memory-base 的流程记录里最新非 `-` 阶段不是 `收尾` 即算活跃，与 task-engine 阶段树无关；a. 帧栈非空、c. `activeCount > 0` 都被否。
2. 开关作用范围：**a 选定** —— 关闭时阶段模板、合规提示、最近记录一起不注入（同一门槛管全部注入）。
3. 状态存储：**a 选定** —— apply 闭包里的可变对象，不落盘、不进配置；`enabled: false` 配置仍是总闸（配置关则连开关也不看）。
4. 接口命名（用户裁定）：用户面 `/flow-track on|off|status`，模型面 `flow_enable({ enabled })`。
5. 活跃任务的记录范围：**a 选定** —— 项目层全部 slug（用户口径是「memory-base 中有未完成阶段的任务」，未限定本会话）。

## 计划改动文件清单

- `flow-track/src/switch.ts`（新）：进程内开关对象与状态文案。
- `flow-track/src/policy.ts`：新增 `hasActiveFlow(records)`（按 slug 取最新非 `-` 阶段判断是否未到收尾）。
- `flow-track/src/command.ts`（新）：注册 `/flow-track`，子命令 `on` / `off` / `status`。
- `flow-track/src/tools.ts`：新增 `flow_enable`；`flow_status` 回执带开关态。
- `flow-track/src/index.ts`：注入门槛接开关与活跃任务；注册命令；模块头注释同步。
- `flow-track/tests/*`：门槛与命令/工具用例；既有注入用例改为开关打开。
- `flow-track/README.md`、`AGENTS.md`、`README.md`、`README.zh.md`：工具面与开关说明。

**明确不做**：不改 task-engine；不做状态持久化；不改八阶段定义与阶段顺序策略；不动 memory-base。

## 实现记录

（实现后补）

## 测试与证据

（实现后补）

## 偏差

（实现后补）

## 收尾

（关闭时补）
