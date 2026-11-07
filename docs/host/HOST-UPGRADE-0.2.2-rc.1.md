# HOST-UPGRADE: 0.2.1-rc.5 → 0.2.2-rc.1 对照记录

> 职责: 记录 `dsh-v0.2.1-rc.5 → dsh-v0.2.2-rc.1` 的接口面增量与本仓影响判定
> 不负责: 包清单 (见 `HOST-PACKAGES.md`)、ctx 接口逐条研读 (见 `DSH-CTX-API.md`)
> 过期条件: 出现下一版宿主 (0.2.2-rc.2 及以后) 时由新对照文档接替

## 0. 版本与来源

- 对比源: 官方 clone `~/GithubRepos/deepseek-harness`, tag `dsh-v0.2.1-rc.5..dsh-v0.2.2-rc.1`, **2623 个提交 / 8120 个文件 / +392647 −717068**。
- 删除量集中在文档: `docs/persistence-changes/**/*.schema.json` 五个文件即约 26 万行, 另有大片 `docs/` 重写与 `snapshots/` 固件变化; 代码面是 `packages` +278695 / −41179, `apps` +29153 / −2515。
- `0.2.2` 线 tag: `dsh-v0.2.2-alpha.2` (`f3803c9697`, 2026-10-28)、`dsh-v0.2.2-alpha.3` (`05b1cae8db`, 2026-11-03)、`dsh-v0.2.2-rc.1` (`66491b05e3`, 2026-11-04)。**rc.1 是当前最新 rc**, 之后主分支到 `fcc0ad4621` (2026-11-04) 又走了 811 个提交但未出新 tag。
- 分段提交数: rc.5 → alpha.2 = 2161, alpha.2 → alpha.3 = 462, alpha.3 → rc.1 = 4 (发布合并)。
- 版本号: 全仓包 `0.2.1-rc.5` → `0.2.2-rc.1`。
- 包目录数 (深度 3 的 `packages/<a>/<b>/package.json`): **343 → 372** (+30 / −1), 增删清单见 §10。
- 升级指南: `docs/upgrade-guide` 的 `guide.md` **44 → 98** (+54 个目录)。其中 `v0.2.2-alpha.2` 13 条属新线; 其余 41 条是 `v0.2.1-alpha.1` / `alpha.2` / `alpha.4` / `rc.1` / `rc.2` / `rc.3` / `rc.4` 的**文档回填**, 描述的多是 rc.5 之前已发布的变更 (如 `conditional-tools` 在 rc.5 树内已存在)。故本次**以代码为准**, 指南只作定位线索。
- 本机状态: `dsh --version` = `0.2.1-rc.5`; 本次只做复核, **未升级安装树、未重装 profile**。

## 1. 增量总览 (按面)

| 面 | 变更 | 影响本仓 |
| --- | --- | --- |
| 工具面 | `dsh-tools` 重构为「共享定义 + 可插拔执行器」: 新增 `tool-executor-native` / `tool-executor-ptc`, 配置字段 `mode` / `maxParallelSubCalls` 删除, `ToolRuntime` 更名 `ToolsService` (别名保留), `register()` 新增可选 `when`; `tool-fs` 新增 `apply_patch` | 需核 (见 §2): 配置面零改动; 类型别名保留; 执行器由 `dsh-base` 提供 |
| 事件面 | 新增 `fs/delete-intent` / `llm/models-updated` / `schedule/input-invalid` / `schedule/target-archived`; `agent/pre-step` 载荷加 `modelSelection`; `agent/request` 标弃用; `session/created` 语义收紧 | 无破坏; TUI 有弃用项 (见 §4) |
| 服务面 | 新增 `agent.model` (`current` / `select`)、`ctx.fs.deleteFile`、`approvalState` 投影; 10 个新服务 (客户端 / 实验面); 投影注册改 `Service.init` 内 `await` | 无破坏; 投影读取方式有弃用项 (见 §5) |
| 投影面 | `cachedSnapshot` 弃用; `snapshot()` 只算返回单元; `session.list` 摘要去 `contextBreakdown` / `contextPressure`; `SessionProjectionStateMap` 撤除 | 弃用项 (见 §5), 运行不中断 |
| fs | `fs-observation-policy` 在 `dsh-base` 改 `disabled: true`; 新增 `apply_patch` 工具, 但 rc.1 的**所有出厂组合**都写 `applyPatch: false` | 行为变化 + 文档口径需改 (见 §6) |
| agent / LLM | `Agent.model.select()` 成为模型与推理档的正规入口; `agent/request` 弃用且 `temperature` / `stop` 无替代; `LlmRequestPurposeMap` 改为合并声明 | 见 §4; 与暂停条目「回合预算调整」直接相关 |
| 调度 | `schedule` 服务与模型工具大改 (target / rrule / 投递历史), `schedule_update` / `schedule_delete` 被 `schedule_edit` 取代 | 不影响 (本仓不挂 `tool-schedule`) |
| 子代理 | `modelSelectionSettings` → `modelSelection`, 新增 `modelDiscovery`; `list-agents` 行移除, `list_agents` 并入 control 行; 新增 `/model-selection-settings` 路由授权 | 待核实 (见 §8) |
| 会话 | 存储会话 append 需 `session/created` 完成播报; `user-questions` 新增 `kind: 'approval'` 意图 | 无破坏 (见 §9) |
| 客户端 / web | 槽契约与实验包增删 (forge / liveshare / action-cards 等) | 无 (TUI 走自有渲染层) |
| 工程 / 测试 | `node 24` 指南回填、`tool-testkit` 新包、`official-bundles` 拆包 | 无 (本仓不 import 这些入口) |

## 2. 工具执行器拆分 (`@deepseek-ai/dsh-tools`)

- 新包: `packages/core/tool-executor-native` (原生执行) 与 `packages/core/tool-executor-ptc` (PTC / `run_code` 执行)。`tools` 包把 `ptc*.ts` / `ts-types` / `py-types` 整体迁到 PTC 执行器, 自身拆成 `contracts.ts` / `events.ts` / `executor.ts` / `pipeline.ts` / `batch.ts`。
- 配置面破坏: `tools` 行不再接受 `mode` / `maxParallelSubCalls`, **加载时拒绝**; 执行能力改由 `tool-executor-native` / `tool-executor-ptc` 行提供; `DSH_TOOLS_MODE` 不再被读取 (`sdk` README 明写 ignored, 仍可设置但无效果)。同区间 headless 覆盖层另外给 `sandbox-policy` 加了 `DSH_PERMISSION_MODE` 入口, 与执行器拆分无关。
- 类型面: `ToolRuntime` → `ToolsService`, 但 `index.ts:412` 保留 `export { ToolsService as ToolRuntime }`, 旧 import 仍可编译。
- 注册面: `register(definition, options?)`, 新增可选 `when: (context) => boolean | Promise<boolean>` 做**逐步**工具启用; 省略即启用, 返回 false 从声明与派发同时剔除。
- 限制面: `restrict()` 拒绝命名保留工具 `run_code` (PTC 展示通道), 其余签名与语义不变。
- `dsh-base` 行变化: 新增 `tool-executor-native` (启用) 与 `tool-executor-ptc` (`disabled: true`); 移除 `tool-subagent-list-agents` 行; `fs-observation-policy` 加 `disabled: true`; `tool-fs` 加 `config.applyPatch: false`。
- 覆盖层变化: headless / sdk / acp 的 `tool-fs` 继承 base 的 `applyPatch: false`; web `standard` preset 自己又显式写了 `applyPatch: false`, 并把 `tool-subagent` 的 `modelSelectionSettings` 换成 `modelSelection` + `modelDiscovery`。**官方指南文本称这些组合已打开 `apply_patch`, 与 rc.1 代码不一致, 以代码为准**。
- 本仓影响: 无配置面破坏 (37 个插件与 profile patch 均未设 `mode` / `maxParallelSubCalls`); `ToolRuntime` 别名保留, 现有类型 import 不用改; 执行器由 `dsh-base` 提供, 树外加装包无需处理。可选增量: `register` 的 `when` 可用于按步收窄工具面 (非必须)。

## 3. 工具面与事件面的细项

- `tool-fs` 新增模型侧 `apply_patch` (Codex 风格): 参数只有一个 `input` 字符串 (补丁正文), 文件路径写在补丁文本里 (`*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:`)。rc.1 里所有出厂组合都是 `applyPatch: false`, 要启用在 `tool-fs` 行显式打开。
- `tool-subagent-control` 合并 `send_message` / `interrupt_agent` / `list_agents`, 原 `/list-agents` 导出与 `tool-subagent-list-agents` 行移除; 三工具同生共死, 单工具隐藏改走 `restrict`。
- 新增事件: `fs/delete-intent` (删除前单槽裁决), `llm/models-updated(provider)` (模型目录变化), `schedule/input-invalid` / `schedule/target-archived`。
- 事件面已核**无删除**: 安装树 rc.5 的 29 个事件名里 28 个在 rc.1 源码仍存在 (差的那个 `internal/listener` 属 vendored cordis 的内部派发, 不是宿主包事件); `tools/*` 只是从 `tools/src/index.ts` 移到 `tools/src/events.ts`, 载荷与 `@mode` 未变 (仅 `this` 类型由 `Scoped<ToolRuntime>` 改为 `Scoped<ToolsService>`)。

## 4. agent: 模型选择与 `agent/request` 弃用

- 新增 `Agent.model` (`current()` / `select(selection)`): `select` 把 `{ provider, model, reasoningEffort? }` 记为**持久选择**, 对下一步生效; `AgentOptions` 的 `provider` / `model` / `reasoningEffort` 降为路由回落 (Session 有记录后不再生效), `maxTokens` 仍是每次请求输出上限的入口。
- `agent/pre-step` 载荷新增 `modelSelection` (本步已捕获的选择, 重试间保留)。
- `agent/request` 在 rc.1 正式标 `@deprecated` (原文: 保留给既有监听器, **不要新增监听**; 模型与推理档改用 `agent.model.select()`; 输出上限用 `AgentOptions.maxTokens`; 其余请求级覆盖**没有替代 API**)。
- 与暂停条目「回合预算调整」的关系: `temperature` / `stop` 在 rc.1 仍只有弃用通道, 恢复条件未变; 回合预算走 `agent/turn-stopping` 仍然成立。
- 本仓影响: **TUI 是唯一使用者** —— `TUI/src/app/adapter/dsh.ts:234` 注册 `agent/request` 监听, 把会话内模型切换写进请求配置; rc.1 上仍可用但已弃用, 需迁到 `agent.model.select()` (见 §11 跟进项)。

## 5. 投影面: 读法与注册方式

- `ctx.sessionProjections.stateOf(session, key)` **标弃用**, 调用时打运行时警告; 正规读法是用本单元注册时拿到的 `handle.stateOf(session)`, 或对应领域服务。
- 注册表级的 `cachedSnapshot(session, keys)` 标弃用; `snapshot(session, keys)` 现在**只计算返回的单元** (带 `keys`) 或「定义了 `wire` 且非 Host-only」的全部单元, 不能再指望顺带算出别的单元。
- `session.list` 摘要不再带 `contextBreakdown` / `contextPressure`; `sessionStats` 声明为 `SessionProjectionSummaryExcluded`。
- `SessionProjectionStateMap` 撤除 (`goal` / `title` / `titleInput` / `sessionStats` / `userQuestions` 等改走 `SessionProjectionMap`); 注册从构造期迁到 `Service.init` 内 `await` (`goal` / `session-title` / `user-questions` / `subagent` / `permission-presets`)。
- 本仓影响: `task-engine` (`tokenUsage`)、`context-report` (`sessionStats` / `sessionContext`)、`rule-engine` 用 `stateOf(session, key)` 读**宿主单元** → rc.1 上功能不变, 但每会话会打弃用警告; 迁移方向是领域服务 (`ctx.tokenMeter` 等) 或宿主公开的 handle, 本仓不注册投影, 无 `SessionProjectionStateMap` 兼容问题。

## 6. fs: 观察策略缺省关闭 + `apply_patch`

- `dsh-base` 的 `fs-observation-policy` 行改为 `disabled: true`: 官方 `write` 不再要求先读, `edit` 不再校验「读后未变」(不再出 `FS_STALE_VERSION`); `fs/observed` 事件与沙箱围栏不变。
- `apply_patch` 在 rc.1 的**所有出厂组合**里都没打开 (`tool-fs` 的 `applyPatch: false`, base 与 web presets 均显式写 false); 官方指南称 headless / sdk / acp / web-standard 已打开, 与代码不一致。
- 本仓影响:
  - 行为: fff profile 跟随 base, 升级后官方 `write` / `edit` 的读后改前守卫**消失**; 要保留须在 profile patch 写 `- id: fs-observation-policy` + `disabled: false` (决定留待升级时裁定)。
  - 文档口径: `hash-edit/README.md` / `ast-tools/README.md` / `md-logic/README.md` / `docs/ARCHITECTURE-REUSE.md` 均按「base 缺省挂载守卫」表述, rc.1 起过期。
  - 安全面: `apply_patch` 是新的写类工具, 路径藏在 `input` 补丁文本中; `security-guard` 的 `FILE_TOOLS` / `WRITE_FILE_TOOLS` 未登记它 (fff 今天不注册该工具, 打开即漏), `escalation-hint` 的 write / edit 类提示也未覆盖。

## 7. LLM 面

- `LlmRequestPurposeMap` 改为合并声明: 共享包不再自带 `compaction` / `session-title`, 由生产者包声明 (`dsh-compaction-basic` / `dsh-session-title-llm`), 插件自建目的须自行 augment。
- 新增 `llm/models-updated(provider)`。
- pi-ai 相关 (模型目录 / 默认容量 / 协议回放 / Azure 路由) 的指南都是回填或部署面配置, 本仓不直接调 LLM 路由 (自动审批与标题走 `ctx.llm` 的宿主封装)。
- 本仓影响: 无 `purpose` 用法; `session-title-cutoff` 走 `ctx.sessionTitle` provider 接口, 服务内部改动 (inject 加 `agents`、注册改 `await`) 不影响 provider 契约。

## 8. 子代理、命令与调度

- 子代理: `@deepseek-ai/dsh-tool-subagent` 的 `modelSelectionSettings` 改名 `modelSelection`, 新增 `modelDiscovery`; `/list-models` 导出移除; `/model-selection-settings` 宿主服务在 Agent 创建时记录授权, **无记录时只允许父路由**, 显式选择其它路由在执行期被拒。
- 命令: `commands` 包新增内置命令身份表 (`goal` / `feedback` / `compact`) 与中英 token 别名; TUI 本地命令优先, 同名不冲突, 只在「未知命令交给宿主」时才可能命中新内置。
- 调度: `schedule` 服务重做 (target / rrule / 投递历史 / 分页), 模型工具改为 `schedule_create` / `list` / `view` / `edit`, 去掉 `update` / `delete` 与时间选择器; 本仓不挂 `tool-schedule`, `background-daemon` 自带 Scheduler, 无影响; 只有 `security-guard/README.md` 里的宿主工具面描述 (`schedule_create` / `schedule_update` 计数) 过期。
- 本仓待核实: `command-template` 模板级模型与 `task-engine` 叶子模型都通过 `ctx.subagents.start` 传 `{ provider, model }`; rc.1 的授权策略是否同样约束**编程式 start** (指南只写模型侧工具与执行期), 需在升级前用 rc.1 实机确认 —— 若受限, 这两处要么在 profile 记录 allowedModels, 要么改为只允许父路由。

## 9. 会话面

- `Session.append`: 存储持有的会话必须等 `session/created` 同步监听全部成功 (`announcement === 'complete'`) 后才能追加, 否则抛错; `session/created` 自身改为只读播报, 期间新事件被拒。
- `user-questions`: 新增 `kind: 'approval'` 意图 (单问题、不支持多选、不接受 `wait`、动作标签互异), 服务面与 `plan-review` 用法不变。
- 本仓影响: 所有插件都不在 `session/created` 期间追加会话记录, 无破坏; TUI 与 `goal-contract` 用的是 `plan-review` 意图, 兼容。

## 10. 包计数与编码漂移

- 新增 30 个包: `core/tool-executor-native`、`core/tool-executor-ptc`、`fs/fs-patch`、`session/message-quotes`、`deliverables/deliverable-file-references`、`test-support/tool-testkit`、`util/{file-drag,official-bundles,plugin-detail}`、`client/{ui-context-menu,ui-file-actions,ui-file-drag}`、`experimental/{action-cards,client-ui-action-cards,client-ui-creation-recommendations,client-ui-forge,client-ui-plugin-recommendations,client-ui-stats,creation-recommendations,cua-bundle,forge,forge-bundle,forge-github,forge-session,liveshare,liveshare-protocol,personalized-recommendations,plugin-recommendations,subagent-oar,tool-subagent-oar}`。
- 移除 1 个: `client/ui-deepseek-model-label-1017`。
- `packages/session/session-persistence-jsonl/src/format.ts` 在该区间**无 diff**, `session-paths` 复刻的 `encodeSegment` / `projectKey` / `projectDir` / `sessionDir` 四函数无漂移。
- `util/official-bundles` 把 `PROFILE_TEMPLATES` / `DEFAULT_PROFILE_BUNDLES` 等从 `dsh-app-boot` 拆出; 本仓不 import, 无影响。

## 11. 本仓影响清单 (按处理优先级)

| # | 项 | 位置 | 性质 |
| --- | --- | --- | --- |
| 1 | `agent/request` 弃用 → 迁 `agent.model.select()` | `TUI/src/app/adapter/dsh.ts:234` 与 `dsh-session.ts` 的会话模型路径 | 弃用, rc.1 仍可用 |
| 2 | 核实 `ctx.subagents.start` 显式路由是否受 `/model-selection-settings` 约束 | `command-template/src/subagent.ts:75`、`task-engine/src/subagent.ts:221` | 待核实, 可能拒绝 |
| 3 | `apply_patch` 写面未登记 (路径在补丁文本) | `security-guard/src/tool-registry.ts:12-22` | 潜在漏拦 (fff 未开该工具) |
| 4 | 宿主工具面清单过期 (`schedule_*` 改名 / `list_agents` 并入 / 新执行器工具) | `security-guard/README.md:214-216` | 文档与扫描面 |
| 5 | `sessionProjections.stateOf(session, key)` 弃用 (运行时警告) | `task-engine` / `context-report` / `rule-engine` | 弃用, 功能不变 |
| 6 | `fs-observation-policy` 缺省关闭的口径 | `hash-edit` / `ast-tools` / `md-logic` README、`docs/ARCHITECTURE-REUSE.md` | 文档口径 |
| 7 | `escalation-hint` 的 write / edit 类提示未含 `apply_patch` | `escalation-hint/src/index.ts:31-32` | 覆盖缺口 (fff 未开该工具) |

无影响面 (已逐项核): `herdr-use` / `herdr-integration` / `coagent` / `session-channel` / `session-paths` / `memory-base` / `pin-note` / `flow-track` / `term-check` / `md-table-check` / `symbol-normalizer` / `clock-base` / `shell-parse` / `preference-analysis` / `output-compress` / `fs-digest` / `md-map` / `code-map` / `goal-contract` / `metric-loop` / `agent-group` / `background-daemon` / `script-interpreter` / `tool-consult` (`restrict` 只多一条保留名拒绝) / `behavior-correction` / `auto-approve` (判定表是配置驱动, 无硬编码工具名)。`rule-engine` 只落在 #5 的投影读法弃用, 事件载荷未变。

## 12. 升级安装树前要做的判断 (本次未做)

1. 是否保留官方「读后改前」守卫: profile patch 加 `fs-observation-policy` + `disabled: false`。
2. 是否启用 `apply_patch`: `tool-fs` 行 `config.applyPatch`, 打开前先补 `security-guard` 的写面登记。
3. 是否给 `ctx.subagents.start` 的显式路由记录授权 (见 §8), 或把模板 / 叶子模型收回到父路由。
4. 树外插件 `session-title-all-prompts-llm` 与 fff 的 patch 行 (无 `mode` / 无 `list-agents` 行) 已确认不冲突, 重装后按 `--dump-config` 复核执行器两行。

## 13. 依据

- `git -C ~/GithubRepos/deepseek-harness fetch --tags origin` → 新 tag `dsh-v0.2.2-rc.1`; `git merge --ff-only origin/master`。
- `git rev-list --count dsh-v0.2.1-rc.5..dsh-v0.2.2-rc.1` = 2623; `git diff --shortstat` = 8120 files, +392647 −717068。
- `git ls-tree -r --name-only <tag> | grep -E '^packages/[^/]+/[^/]+/package.json$'`: rc.5 = 343, rc.1 = 372。
- `git diff ... -- packages/core/agent/src/runtime-types.ts` (agent/request 弃用、modelSelection、Agent.model)。
- `git diff ... -- packages/core/tools/src/**` 与新增 `packages/core/tool-executor-*/**`; `docs/upgrade-guide/v0.2.1-rc.2/tool-executor-plugins/guide.md`。
- `git diff ... -- packages/bundle/base/cordis.patch.yml` 与 headless / web-app presets。
- `git grep -h -oE "'[a-z0-9-]+/[a-z0-9-]+'\(this"`: rc.5 的 29 个事件名里 28 个在 rc.1 仍存在 (余 `internal/listener` 属 vendored cordis), 新增 4 个。
- `git diff ... -- packages/session/session-projection/src/index.ts` (`stateOf` / `cachedSnapshot` 弃用)、`packages/session/session-stats/**`。
- `git diff ... -- packages/interaction/user-questions/**`、`packages/interaction/user-approval/src/index.ts`、`packages/fs/fs/src/index.ts`、`packages/fs/tool-fs/src/apply-patch.ts`。
- `git diff --stat ... -- packages/session/session-persistence-jsonl/src/format.ts` = 空 (无漂移)。
- 过程记录: `docs/implementation/2026-11-07-host-rc-interface-review.md`。
