# flow-track 注入开关（默认关, 内存态）

接取条目：`docs/BACKLOG.md`「flow-track 注入开关（默认关, 内存态）」

## 目标

- 新增进程内开关，缺省关闭；只有开关打开且 memory-base 中存在未完成阶段的任务时才注入；关闭时连阶段模板与合规提示一起不注入。
- 用户面命令 `/flow-track on|off|status` 与模型面工具 `flow_enable` 都能切换；状态只在内存，进程结束即丢失。

## 调研

- 现有注入：`flow-track/src/index.ts:247` 注册 rule-engine 消费者（`sources` 缺省 `turn-start` + `user-message`），`decide` 里组装 `decideText`；`flow-track/src/inject.ts:50` 把推进状态 / 合规提示 / 最近记录拼成一段，没有任何开关。
- 记录面：`flow-track/src/store.ts:312` 读项目层 kind `flow`，时间正序；`flow-track/src/policy.ts` 已有 `latestStageRecord`（跳过 `-` 备注）与 `stageIndex`，可直接判「最新阶段是不是收尾」。
- 命令注册先例：`background-daemon/src/commands.ts:305`（`ctx.commands.register({ definitionId, name, description, input, handler })`）、`auto-approve/src/command.ts:259`（handler 返回 `{ kind, text }`）。
- 工具面：`flow-track/src/tools.ts` 原有 4 个工具（`flow_record` / `flow_status` / `flow_remove` / `flow_rollback`），`deps` 含 `store` / `observer` / `snapshot` / `slugFor` / `onRecorded`。

## 决策

1. 活跃任务判据：**b 选定（用户 2026-11-06 裁定）** —— memory-base 的流程记录里最新非 `-` 阶段不是 `收尾` 即算活跃，与 task-engine 阶段树无关；a. 帧栈非空、c. `activeCount > 0` 都被否。
2. 开关作用范围：**a 选定** —— 关闭时阶段模板、合规提示、最近记录一起不注入（同一门槛管全部注入）。
3. 状态存储：**a 选定** —— apply 闭包里的可变对象，不落盘、不进配置；`enabled: false` 配置仍是总闸。
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

- `flow-track/src/switch.ts`（新）：`FlowSwitch`（`{ enabled: boolean }`）+ `createFlowSwitch()` 缺省关闭 + `describeSwitch` / `describeGate` 文案。
- `flow-track/src/policy.ts`：新增 `hasActiveFlow(records)` —— 按 slug 取最新非 `-` 阶段，任一不是「收尾」即算活跃（项目层全部 slug）。
- `flow-track/src/command.ts`（新）：`/flow-track on|off|status`；`dispatchFlowCommand` 可脱离宿主直接测；注册走 `ctx.commands.register`，返回的 dispose 并入 `disposers`。
- `flow-track/src/tools.ts`：新增 `flow_enable({ enabled })`；`flow_status` 回执加 `enabled` / `active`；`ToolDeps` 加 `switcher` 与 `active()`；工具面变 5 个（顺序 `flow_record` / `flow_status` / `flow_enable` / `flow_remove` / `flow_rollback`）。
- `flow-track/src/index.ts`：`createFlowSwitch()` 放 apply 闭包（不落盘）；`decide` 增加两道门槛（开关、`hasActiveFlow(cache.records)`）；`commands` 服务缺席时告警且不影响工具面。
- `flow-track/tests/main.test.ts`：接线用例改为「开关缺省关闭 → 恒 null」，新增「开关开但无记录 → 不注入」「开关开 + 未完成流程 → 注入」「走到收尾 → 不再注入」「`/flow-track` 命令回执」「`flow_enable` 参数校验」；`flow-track/tests/policy.test.ts` 加 `hasActiveFlow` 用例。

## 测试与证据

```sh
pnpm -C flow-track run check   # tsc --noEmit 通过
pnpm -C flow-track run build   # 通过
pnpm -C flow-track run test    # tests 77 / pass 77 / fail 0（阶段 6 + 状态 7 + 存储 13 + 观测 6 + 注入 9 + 顺序 12 + 接线 24）
pnpm run check                 # 全包类型检查通过
pnpm run check:docs            # 错误 0 / 警告 0
```

## 偏差

- **阶段模板与合规提示实际不可达**：门槛要求「有未完成阶段的流程记录」，而合规提示的前提是「没有任何流程记录」，模板又只在合规提示成立时才拼入（`flow-track/src/inject.ts:56`）。两段代码与单测保留，但经本开关后不会再出现在注入里；是否改造（例如把模板移进 `flow_status` / `flow_enable` 回执）留给后续条目。
- 活跃流程按**项目层全部 slug** 判定（用户口径未限定本会话）：别的会话未走完的流程也会让本会话满足门槛。
- 真机未验证：需 `scripts/install.sh --profile fff --sync` 后重启会话才能看到 `/flow-track`、`flow_enable` 与新门槛。

## 收尾

- 条目已从 `docs/BACKLOG.md` 移除；本文件已移入 `docs/archived/`。
- 同步文档：`flow-track/README.md`、`AGENTS.md`、`README.md` / `README.zh.md`。
