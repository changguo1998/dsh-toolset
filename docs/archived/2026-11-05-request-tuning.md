# 会话级请求参数调整与回合预算插件（接取条目：docs/BACKLOG.md「回合预算调整」）

状态：调研（暂停；2026-11-05 用户裁定「不定, 条目暂停」，恢复条件写在本文件「决策」节）　　开启：2026-11-05　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。
插件名待裁定（下文暂称「本插件」）。

## 目标

把「请求可调、但宿主会话层没有入口」的参数收成一个插件，按会话可配；并让回合有上限，不出现「长推理一次性做大步、到顶不停」。

- 参数面：`temperature` / `stop` / 思考预算 / 回合预算；`provider` / `model` / `reasoningEffort` / `maxTokens` 宿主已有入口，本插件不重复提供。
- 回合面：回合内步数（或输出 token）达上限即止，并给出可读的终止原因。

## 调研（来源：宿主源码 `~/GithubRepos/deepseek-harness` @ `8bd073392e`，2026-11-03，对应 0.2.1-rc.5 口径；本仓既有条目与包）

### 1. 请求参数面（宿主）

- `LlmCallControls = { reasoningEffort?, temperature?, maxTokens?, stop? }`（`packages/llm/llm/src/call-config.ts:16-21`）；`LlmCallConfig` 另加 `provider` / `model`（同文件 `:31-34`）。
- `GenerateOptions` 同名四字段（`packages/llm/llm/src/types.ts:564-593`）；`temperature` 由适配器序列化（`llm-deepseek/src/serialize.ts:158`、`llm-pi-ai/src/adapter.ts:462`），`stop` 各适配器自映射（同文件 `:589-593` 注释），故**只要值进到 `LlmCallConfig` 就生效**。
- 会话层现有入口：`provider` / `model` / `reasoningEffort` 由 `AgentOptions` 与 `agent-default-model`（`packages/core/agent-default-model/src/index.ts:24-31`，只有这三个字段）供给；`maxTokens` 由 `AgentOptions.maxTokens` 与 `task-engine` 预算供给。
- 会话层**没有**入口的：`temperature`、`stop`、请求级思考预算、回合预算。

### 2. 三条候选注入通道（实测结论与 BACKLOG 候选路线的出入）

- **`agent/request`（waterfall，`packages/core/agent/src/runtime-types.ts:371-373`；调用点 `agent-loop/src/agent.ts:630-633`）**：每个 step 请求前询问，入参 `{agent, turn, step, signal}`，返回 `LlmCallConfig`。可改任意 controls；`provider` / `model` / `reasoningEffort` 若被改动，loop 直接抛错（`agent.ts:635-640`）。**该事件已标 `@deprecated`（`runtime-types.ts:362`），文档明写「do not add new listeners」「Other per-request control overrides have no replacement API」（`:363-365`）**。今天生效，但属「已知会被移除的通道」。
- **`ConfigureCall`（`call-config.ts:45-48`；入口 `llm/src/index.ts:963` `prepareCall(config, signal, configure?)`）**：第三个参由**调用方**传入；`agent-loop` 调用时没传（`agent.ts:644` `prepareCall(proposedConfig, signal)`）→ **插件无法经 `ConfigureCall` 改写 loop 发起的请求**。BACKLOG 候选路线 3 把它当作「请求冻结前改写点」，这一前提在当前宿主不成立，需在决策里更正。
- **`agent/turn-stopping`（serial，`runtime-types.ts:417`；调用点 `agent.ts:394-399`）**：在「本可结束的 turn 关闭前」运行，入参 `{agent, turn, signal}`；监听器可 `agent.steer(message)` 使回合继续（`/loop` 同款用法），也可 `agent.cancel({kind:'hook', reason})` 中止（`AgentCancelCause`，`packages/core/session/src/types.ts:194-198`）。宿主自述「**没有内置轮次预算**，要限回合须从该扩展点自建策略」（`agent-loop/README.md:220`）。

### 3. 思考预算

- `thinkingTokenBudgetField` 是 `llm-pi-ai` 的**模型外观配置**（`OpenAICompletionsCompat` 字段，见宿主 `docs/config-catalog.md:2180`），请求面没有对应字段（`packages/llm` 内无该实现）。
- → 请求级思考预算**无法注入**；只能走 profile 里模型条目的配置（`$var: thinking.budget` 一类），属部署侧调参，不是本插件能做的事。

### 4. 结论（对条目的修正）

1. `temperature` / `stop` 今天唯一的插件侧通道是**已弃用**的 `agent/request`；用它就要在追踪文档里记下「依赖弃用通道」的偏差与失效风险。
2. `ConfigureCall` 不可用（loop 不传第三参），条目里该路线作废。
3. 回合预算有正规通道：`agent/turn-stopping` + `agent.steer` / `agent.cancel`，无需碰弃用面。
4. 思考预算只能落 profile 配置，不能由插件按会话调。

## 决策

- 决策项 1（用户 2026-11-05 裁定）= **暂停**, 四项候选均未选定（答复原话「不定, 条目暂停」）。条目状态同步为「暂停」并沉到 `docs/BACKLOG.md` §2 末尾, 恢复条件写在那里。
  - 恢复条件: 宿主为 `temperature` / `stop` 提供正式（非弃用）注入入口, 或用户重新指定取向（只做回合预算 / 只做 profile 调参）。
  - 恢复时从下方决策项 1 至 4 的候选重新裁定。
- 决策项 1 = 是否新建插件、叫什么（未裁定, 随暂停挂起）
  - a. 新建插件 `request-tune`（动词+对象，与 `flow-track` / `term-check` 同构；只管请求控制项）
  - b. 新建插件 `turn-budget`（只做回合预算，不碰弃用通道）
  - c. 不建插件：只做 profile 参数调优 + 文档说明，放弃会话级入口
- 决策项 2 = `temperature` / `stop` 的注入通道（未裁定）
  - a. 用 `agent/request`（弃用通道，记偏差，宿主移除时随之下线）
  - b. 不做这两项，插件只覆盖回合预算（避开弃用面）
  - c. 等宿主给出替代 API 再接（条目转挂起）
- 决策项 3 = 回合预算的实现档（未裁定）
  - a. 硬档：`agent/turn-stopping` 里按步数记账，达上限 `agent.cancel({kind:'hook', reason:"..."})`，正文提示「回合预算用尽」
  - b. 软档：达上限注入一条提醒并放行（不强制）
  - c. 双档可配（缺省软档，可切硬档）
- 决策项 4 = 会话级配置入口形态（未裁定）
  - a. 模型侧工具（如 `request_tune` 设 / 查 / 清），不改 TUI
  - b. 配置文件（profile 或项目 `.dsh/`）+ 只读工具
  - c. 命令模板 / slash 命令（需动 `command-template`）

## 规划（**暂停期间不实施**；恢复并裁定决策项后细化）

候选实现路径（按决策项 2 的取向分叉）：

1. 包骨架：新建包目录（`package.json` 的 `dsh.bundle` + `cordis.patch.yml`），参照轻量插件模板。
2. 注入面：决策项 2 = a 时挂 `agent/request`（并在 README 写明弃用依赖）；决策项 2 = b 时不挂。
3. 回合预算：挂 `agent/turn-stopping`，按 `step/start` 事件或 `turn-start` 记步数；达上限按决策项 3 处理。
4. 配置入口：按决策项 4 给出工具或配置读取。
5. 配套：单测（注入生效 / 未超限零动作 / 超限终止路径）、`pnpm run check` / `build` / `test` / `check:docs` 全绿。

计划改动文件清单：

- `docs/BACKLOG.md`（条目状态: 已标进行中）
- 本追踪文档
- 新包目录（按裁定命名；`package.json` / `cordis.patch.yml` / `README.md` / `src/` / `tests/`）
- 根 `package.json`（委托链与包枚举）、`scripts/install.sh`（包枚举）、`AGENTS.md`（插件清单与包计数）、根 `README.md` / `README.zh.md`（包清单）
- `profiles/example/*`（若需挂载示例）

明确不做：

- 不改 `agent-loop` / `dsh-llm` 等宿主包（依赖弃用通道时只在 README 记偏差）
- 不在插件里做思考预算（属 profile 模型配置）
- 不动 `STATUS.md`（用户择时更新）

## 实现记录

（待写）

## 偏差

（待写）

## 测试与证据

（待写）

## 收尾

（待写）
