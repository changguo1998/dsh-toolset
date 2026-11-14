# @dsh-toolset/flow-arbiter

DSH（DeepSeek Harness）进程内集成插件：**流程选择仲裁**——同一会话同一时刻只放行一个流程的入口工具（决策项 7 / 8）。

## 职责

| 件 | 位置 | 说明 |
| --- | --- | --- |
| 选中状态 | `src/state.ts` | 会话 id → 流程 id（进程内内存，不落盘，插件卸载即丢） |
| 选择入口 | `src/tool.ts` + `src/command.ts` | 模型侧 `flow_select` 工具、用户面 `/flow-arbiter status\|select <id>\|off` |
| 入口拦截 | `src/index.ts` | `tools/pre-execute` 监听器：只拦流程入口工具，其它工具一律放行 |

## 规则

- 同一会话**最多选中一个流程**；再选另一个即**顶替**（回执带 `replaced`），不要求先取消。
- 入口工具名 → 流程 id 由登记表给出，内置两条：

| 流程 id | 名称 | 入口工具 |
| --- | --- | --- |
| `standard` | 标准流程八阶段 | `flow_start` |
| `plan` | plan 模式三段 | `plan_start` |

- 未选中流程、或调用的是**别的**流程的入口 → `tools/pre-execute` 返回 `deny` 并说明怎么改（选中 / 切换）；非入口工具一律放行。
- 认不出会话（调用缺 `agent.session.id`）→ 拒绝，不默认放行。

## 缓存友好（决策项 9）

- 工具**恒注册**：`flow_select` 与各流程入口工具都不随选中状态增删，工具面稳定。
- 选中状态是**内存态**，不进 prompt：切换流程只改放行规则，不改上下文 → 不破坏缓存命中。
- 真正改变上下文的是**建树**（流程入口执行成功之后：节点、推进状态、当前节点推送随之变化）。

## 配置

`cordis.patch.yml` 的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `flows` | 内置两条（见上表） | 流程登记表：`[{ id, name, entry }]`；新流程插件在这里登记（或经服务面 `flowArbiter.register`） |

服务面：`ctx.provide("flowArbiter", { register, select, clear, current, flows })`——流程插件可登记自身，调用方可查询当前选择。

## 降级

- `tools` 是硬依赖（装配期注册工具面，`inject: ["tools"]`）。
- `ctx.on` 缺席 → 只告警，拦截不生效（选择工具仍可用）；`ctx.commands` 缺席 → 命令面不出现。
