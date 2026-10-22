# 工具咨询插件：按需揭示工具（接取条目：`docs/BACKLOG.md` §2「5. 工具咨询插件…」）

状态：设计定稿（2026-10-22 人工裁定：揭示改为会话级授权、取消回合级收回），待实现指令（本阶段只做调研与设计，未写实现代码）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
条目状态仍为「设计未定稿」，保持不动（由主分支代理回写）。

**协作约定（2026-10-23）**: 本包可**写自己包目录内的代码与文档**（含包内 `docs/`），以及**自己的追踪文档**；共享文档（两级 BACKLOG、`TUI/docs/SPEC.md`、两份 README、`COMMANDS*.md`）与根级接线（根 `package.json`、`AGENTS.md`、`profiles/example/cordis.patch.yml`、用户 profile）**只由主分支代理回写**，见项目级 `docs/BACKLOG.md` §2「7. 共享文档与根级接线」。

## 0. 结论摘要

新增包 `tool-consult`：一个**全局挂载**的插件（本项目 TUI 走 profile 全局组合、无 preset），监听 `agent/created`，为每个代理做两件事：

1. 向该代理的**自身作用域**注册常驻咨询工具 `consult_tools`（自身层注册不受遮罩影响，故永远可见）；
2. 用**一条可替换的 allow 遮罩**（宿主 `tools.restrict`）把其余工具收进「按需揭示」集合，缺省只留 8 个核心工具。

模型用一句话描述需求调用 `consult_tools`，插件用本地关键词索引（BM25 + 中文二元组 + 别名表）返回匹配工具的名称与一句话简述，并把这些工具加入可见集。**揭示即会话级授权**：一次揭示后该工具在本会话内始终可见，`turn/end` 不收回；**授权只增不减**，直到会话结束或 resume / fork（新代理从初始集重建）。`maxRevealed` 改为**新增揭示的硬上限**，达到上限后拒绝新增并提示「结束会话重开」，不会抽走已授权工具。揭示在下一次请求装配时生效（宿主自己会为工具面变化追加 `request/header` 与 `tool-addition` 公告，插件不注入消息），同回合内调不到刚揭示的工具。被遮罩的工具若仍被调用，返回一条可行动文案（先咨询再调用），而不是裸的 unknown tool。任一步失败（服务缺失 / 无会话作用域 / 名称失配 / 重名）都**降级为不遮罩**，咨询工具仍可用，会话不中断。

一句话：**遮罩用 `tools.restrict` 单条替换，揭示即会话级授权（只增不减），匹配先做关键词。**

## 1. 目标与边界

### 1.1 目标

- 工具面按需揭示：模型不必记忆全量工具名，工具描述不再全程占用上下文。
- 咨询即揭示：一次调用返回候选（名称 + 一句话）并让它们可调用。
- 常驻入口：咨询工具自身永远可见（自身层注册豁免遮罩）。
- 不改变其它工具的行为与描述，不引入外部服务或新依赖。

### 1.2 边界（v1 不做）

- 不做语义向量检索与模型重排（留接缝，见 D2）。
- 不做回合级收回：授权一旦给出，会话内一直可见（长会话收益衰减是明确接受的代价，见 D3）。
- 不做跨会话或跨 resume 的揭示状态持久化（每代理内存态，resume 后回到初始集，见 D3 与 §5）。
- 不专门适配 PTC（`run_code`）模式（遮罩本身对它有效，交互收益待测，见 §5）。
- 不改宿主、不新增运行时依赖。
- 不写根级接线（根 `package.json`、`AGENTS.md`、根 README 双侧、profile 模板、`scripts/test-parallel.sh`），由 H 组主分支代理回写。

### 1.3 成功判据

- 缺省工具面从 61 个降到 9 个（8 核心 + 咨询），单请求工具描述体量下降 ≥ 80%。
- 一次常规任务（改一个文件 + 跑测试 + 提交）最多多 1 至 2 次咨询调用。
- 会话内授权只增不减，`turn/end` 不收回；达到 `maxRevealed` 后拒绝新增并给出重开会话的提示。
- 被遮罩工具被误调时返回可行动文案（引导咨询），不是裸的 unknown tool。
- 任何降级路径都不会让会话报错或工具面错乱。

## 2. 调研

宿主基线：本机 `~/GithubRepos/deepseek-harness`，`dsh-v0.2.1-rc.2`（commit `687f282e`，2026-10-17）。以下结论均以该 commit 源码为准，行号供复核。

### R1 工具面成本：61 个工具约 16.5k tokens / 请求

实测：取本机 TUI 会话（`~/.dsh/sessions/…/session.v4.jsonl.zstd`）首条 `request/header` 事件，统计 `data.header.tools`：

| 指标 | 值 |
| --- | --- |
| 工具数 | 61 |
| 工具定义 JSON 总字符 | 57,798 |
| 估算 tokens（3.5 字符/token） | ≈ 16.5k |
| 单工具平均 | 947 字符（≈ 270 tokens） |
| 最大 5 个 | `herdr_use` 3,904 / `workflow` 3,475 / `rule_update` 3,072 / `md_logic` 3,030 / `rule_add` 2,873 |

复现：解压会话日志，取第一条 `"type":"request/header"` 记录，对 `data.header.tools` 逐项 `JSON.stringify` 后求和。

核心 8 工具（`bash` / `read` / `write` / `edit` / `glob` / `grep` / `todo_write` / `ask_user_question`）合计 8,575 字符（≈ 2.45k tokens）。加咨询工具（约 600 字符）后，缺省面约 9.2k 字符（≈ 2.6k tokens），**比现状少约 48.6k 字符 / 13.9k tokens（-84%）**。

### R2 遮罩能力：仅会话作用域、只遮继承层、自身层豁免、多条取交集

- 口径：`tools.restrict() 仅 agent scope 可用`（`ToolsService.restrict(filter)` 定义在 `packages/core/tools/src/index.ts:1105`；`scopeOf(ctx)` 缺失直接抛错，`:1108`）。上下文全局的遮罩会让所有代理一起失明，宿主明确拒绝。
- 允许 / 拒绝名单在注册时校验：名单里的名字必须出现在 `restrictableNames`（该作用域继承到的全局与祖先层名字）；未知名字抛错（`:1122-1126`）；预留的 PTC 传输名 `run_code` 禁止出现在名单中。
- 解析规则（`view()`，`:1171-1196`）：遮罩只过滤**继承面**（全局层与祖先层），**自身层注册的工具永不受遮罩影响**；多条遮罩**逐条取交集**。
- 由此得到两条硬约束：① 咨询工具必须注册进代理自身层，才能「常驻可见」；② 插件只能维护**一条活动遮罩**，揭示时替换而不是叠加（叠加只会越遮越少）。
- 变更通知：`tools/change` 事件（`:209`，发射于 `:836`）在工具注册 / 注销 / 作用域遮罩变化时触发，可作为索引刷新信号。

### R3 全局插件如何进入每个会话的作用域

- `Agent` 暴露 `ctx`（agent-scoped context，`packages/core/agent/src/runtime-types.ts:173`），该 ctx 由 `createScope(loopCtx, this)` 创建（`packages/core/agent-loop/src/agent.ts:130`），**不挂父代理**（未传 `options.parent`；`bindScopeParent` 只出现在 preset registry，`packages/preset/agent-preset-registry/src/index.ts:266`）。
- 全局插件拿不到 per-agent 的 `apply(ctx)`，但可以监听 `agent/created`：载荷 `{ agent, source, signal? }`（`packages/core/agent/src/runtime-types.ts:261`），由 `ctx.serial` 串行派发（`packages/core/agent/src/index.ts:552`），全部监听器结算后才释放队列。
- 时序保证：`session/created` 与 `agent/created` 都发生在**首次 prompt 装配之前**（`packages/core/agent/src/index.ts:109` 的契约注释）。因此在监听里改遮罩、注册工具都能赶上第一次请求。
- 推论：监听器里调用 `agent.ctx.tools.restrict(...)` / `agent.ctx.tools.register(...)`，Effect 归属该代理，代理销毁时自动撤销，无需手动清理。
- 另外 `ctx.agents.list()` 可拿到已存在的代理，用于插件热挂载时补做。

### R4 揭示后模型如何得知：宿主自己公告，插件不注入消息

- 每步请求的工具体来自装配结果（`packages/core/system-prompt/src/index.ts:674`）；装配在每步重新执行，因此遮罩变化在**下一步**生效。
- 工具面变化时 agent-loop 会追加 `request/header`（reason `change`），并在工具名集合有差异时追加 `developer/message`，内容是 `tool-addition` / `tool-removal` 块（`packages/core/agent-loop/src/agent.ts:650-665`）。
- 模型侧路由有三种能力（`ToolUpdate`，`packages/llm/llm/src/types.ts:416-425`）：未声明时每请求重发完整声明；`addition-only` 用历史里的 tool-addition 块激活声明；`in-history` 还能处理 tool-removal。本机 deepseek 路由两种都支持（`packages/llm/llm-deepseek/src/config.ts:81`）。
- 结论：**揭示不需要插件写消息**；插件只改可见集，公告由宿主完成。咨询结果只需给出「名称 + 一句话」，完整参数定义会随下一次请求到达模型。

### R5 `deferLoading` 不能替代遮罩

- `ToolSchema.deferLoading`（`packages/llm/llm/src/types.ts:491-497`）只是把「延迟加载」意图传给模型服务；序列化时仍发送 name / description / input_schema，另加 `defer_loading` 标记（`packages/llm/llm-deepseek/src/serialize.ts:160-166`）。
- 即：deferLoading 不省上下文（本地请求体积不变）；且它依赖服务端语义（`packages/llm/llm/src/content.ts:381-470`：延迟声明要等第一次 tool-addition 才可用）。
- 结论：主机制用 `tools.restrict`（本地就不发）；`deferLoading` 只作为将来的可选优化，不进 v1。

### R6 可见面与执行面一致

- 执行时按 `exec.agent` 解析定义（`packages/core/tools/src/index.ts:1586`），遮罩掉的工具解析不到，抛 `ToolNotFoundError`（`code: 'UNKNOWN_TOOL'`，`:511`）。
- 好处：模型即使凭记忆调用未揭示工具，也只会得到明确的 unknown tool，不会执行隐藏能力。坏处：v1 不做回合级收回，所以这条只在 resume / fork 重建后出现（历史里用过、新代理里又未授权，见 D3）。

### R7 备选机制评估

| 方案 | 能否省本地上下文 | 执行面一致 | 结论 |
| --- | --- | --- | --- |
| `tools.restrict`（选定） | 能（工具不进请求） | 一致（`UNKNOWN_TOOL`） | 采用 |
| `deferLoading` | 不能（定义照发） | 取决于服务端 | 不采用（见 R5） |
| `systemPrompt.tools()` / `system-prompt/assemble` 瀑布过滤 | 能 | **不一致**（执行面仍可调用） | 不采用：只改展示，隐藏工具仍可被调用 |
| 按 profile 行禁用插件 | 能 | 一致 | 太粗：改配置需重启，不能按需揭示 |

（`systemPrompt.tools()` 见 `packages/core/system-prompt/src/index.ts:545`；装配瀑布在同文件 `:677`。）

### R8 与本仓现状的接口面

- 本项目只用 TUI、profile 全局组合、无 preset（见 `docs/host/AGENT-COMPOSITION.md`），工具全在全局层，均可被 `restrict` 点名。
- 全局插件拿不到 agent 级 `apply`，故采用 R3 的 `agent/created` 监听方案。
- 子代理可用 `SessionHeader.origin === 'subagent'` 或 `delegationDepth > 0` 区分（`packages/core/session/src/types.ts:114-124`）；子代理作用域不继承父代理遮罩（R3），需要单独决策（见 D4）。

## 3. 决策

### D0 总体形态

```
agent/created（缺省只处理根代理）
  ├─ 注册 consult_tools 到 agent.ctx（自身层，常驻）
  ├─ 计算 allow = initialTools ∩ 当前可限制名
  ├─ agent.ctx.tools.restrict({ allow })      // 单条活动遮罩
  └─ 登记会话态 { granted: Set, maskDisposer }

consult_tools(query | names, limit, reveal)
  ├─ 检索隐藏工具（关键词索引）
  ├─ reveal 且未超上限时把命中项加入 granted → 替换遮罩（只增不减）
  └─ 返回名称 + 一句话 + 状态 + 剩余名额

会话结束（agent 销毁）
  └─ 状态随之消失；resume / fork 从初始集重建
```

### D1 初始可见集

**模式**：`maskMode: "allowlist" | "denylist" | "off"`，缺省 `allowlist`。

- `allowlist`：只有 `initialTools`（外加常驻的咨询工具）可见，其余全部遮罩。
- `denylist`：只遮 `initialTools` 里列出的，其余可见（保守部署 / 灰度用）。
- `off`：不遮罩，只挂咨询工具（排障用）。

**缺省核心清单（8 个）**：`bash`、`read`、`write`、`edit`、`glob`、`grep`、`todo_write`、`ask_user_question`。

依据：

1. 每个任务都可能用到（读文件、改文件、跑命令、列待办、问用户），隐藏它们的平均代价最高（几乎每次任务都要多一次咨询）。
2. 合计 8,575 字符（R1），加咨询工具后仍只占现状的 16%。
3. 其余 53 个工具是领域工具（任务树、规则、群组、通道、herdr、记忆、工作流等），单次任务命中率低，适合按需揭示。

**配置**：`initialTools: string[]`，支持通配（`task_*`、`*_log`）。未知名与零匹配模式只告警不报错（降级见 D4）。咨询工具名由插件隐式保证可见，不需要用户配置，也不能被遮罩（见 D4）。

**边界**：`initialTools: []` 合法（全部遮罩，只剩咨询工具）；`initialTools: ["*"]` 等价于不遮罩。

**收益测算（基线取 R1 实测值）**：

| 口径 | 工具数 | 字符 | ≈ tokens | 相对基线 |
| --- | --- | --- | --- | --- |
| 现状（全量） | 61 | 57,798 | 16.5k | — |
| 初始可见集（8 核心 + 咨询工具约 600 字符） | 9 | 9,175 | 2.6k | -84% |
| 揭示 12 个后（示例，按平均 947 字符/个） | 21 | 20,539 | 5.9k | -64% |

- 单请求起步节省 48,623 字符（≈ 13.9k tokens）。
- 取值口径：一个工具被隐藏后，每次使用要多一次咨询往返（一次工具调用 + 一轮模型推理）。8 个核心工具属于「几乎每个任务都用」的一类，隐藏它们净亏；其余 53 个属于「多数任务不用」的一类，隐藏才划算。这条分界线就是 8 个高频工具的量化依据（单工具平均 947 字符 ≈ 270 tokens/请求）。
- 注意：表中的「揭示 12 个后」只是缺省上限处的快照；由于授权只增不减，上限调高时长会话末段会逼近全量，见 D3 的衰减说明。

**不采用的方案**：

- 全量可见 + 靠模型自觉（不解决问题）。
- 按任务类型动态切换预设清单（需要分类器，v1 过重）。
- 以 `denylist` 作缺省（省得少：要么手工维护「冷门工具」清单，要么几乎不省）。

### D2 匹配方式

**两方案对比**：

| 维度 | 关键词索引（本地） | 模型语义匹配 |
| --- | --- | --- |
| 延迟 | 小于 1 ms（内存） | 0.5 至 2 s（一次模型往返） |
| 成本 | 0 | 每次 1 至 2k tokens |
| 确定性 | 完全确定，可写断言 | 不稳定，难断言 |
| 词汇鸿沟 | 有（靠别名与中文二元组缓解） | 小 |
| 失败面 | 无外部依赖 | 路由 / 超时 / 额度，需降级 |
| 多语言 | 需中文分词 | 天然 |

**缺省选择**：关键词索引。理由：语料只有几十条，工具描述本身就是关键词密集的功能说明（本仓工具描述还是中文）；咨询发生在工具循环内，延迟敏感；确定性可测试；失败面为零。语义方案留作阶段二的可选重排。

**关键词方案要点（可实现口径）**：

1. 文档构造：每个工具一条文档 = 名称分词 + 名称前缀 + 描述 + 参数名 + 别名。字段权重：名称 6 / 前缀 3 / 别名 4 / 描述 2 / 参数名 1。
2. 分词：ASCII 按 `[^a-z0-9]+` 与驼峰切分后小写；CJK 取**二元组**（长度 1 的取单字）；英文停止词不入索引。
3. 打分：BM25（k1 = 1.2，b = 0.75）逐字段加权求和；查询整体是某工具名的子串时加 10 分，是描述子串时加 4 分。
4. 排序：分数降序，同分按名称字典序（稳定）。
5. 阈值与上限：只返回分数大于 0 的项；`limit` 缺省 5、上限 20。
6. 别名：包内维护一张小表（约 20 个工具，每工具 2 至 4 个中文 / 英文口语词，如 `session_channel`：跨会话、发消息、通知；`task_decompose`：拆任务、分解、待办树），随工具演进维护。
7. 无匹配回退：返回按前缀分组的**名称索引**（`task_* (5): task_decompose, task_implement, …`），只给名字不给描述（约 1 至 2k 字符），并提示换更宽泛的词或用 `names` 精确指定。
8. 精确通道：`names` 参数直接按名揭示，跳过匹配（模型已知名字、只想要可见性的场景）。
9. 索引刷新：`tools/change` 时重建（几十条文档，成本可忽略）。

**接缝**：检索实现为纯函数 `Matcher`（输入文档集与查询，输出排序结果），配置 `matcher: "keyword"`；将来加 `"hybrid"`（关键词召回 top 20 → 模型重排 top 5）不影响其它模块。

**不采用的方案**：纯模型语义（延迟、成本、不确定性）；向量嵌入（宿主没有内置嵌入服务，要自带模型依赖）。

### D3 揭示即会话级授权（只增不减）

**授权语义**：

- 触发：`consult_tools` 调用且 `reveal !== false`，或 `names` 直指。
- 一次揭示 = 本会话内**永久授权**：该工具从下一次请求装配起可见，直到会话结束；`turn/end` 不做任何收回，没有 TTL、没有 LRU、没有 `pin` 例外。
- 幂等：已授权则不变，不占新增名额，返回「已可见」。
- 作用域与生命周期：每代理（= 每会话）一份内存态 `Set<toolName>`，**不持久化**。会话结束（agent 销毁）即消失；resume / fork 是新代理，重新从初始集开始，需要时再咨询一次（理由：持久化要读会话日志，而宿主已把 `snapshotEvents` 标弃用）。
- 初始集优先级：初始集永远可见、不占新增名额、不属于授权集合。

**上限（maxRevealed）**：

- 语义：**新增揭示的硬上限**（缺省 12），不是「同时可见数」。
- 已达上限时**拒绝新增**：不改变可见集、不产生副作用，返回可行动文案：

```
已达新增揭示上限（12 / 12），本次未揭示新工具。
已授权的工具不受影响；如确需更多，请结束会话重开（resume 不继承授权集合）。
```

- 不抽走已授权工具换取名额：这是 2026-10-22 人工裁定的核心取舍——宁可拒绝新增，也不做不可预期的撤回。
- `maxRevealed: 0` 表示只检索不揭示（咨询工具退化为只读目录）。

**同回合语义（保留）**：

- 揭示在**下一次请求装配**时生效（R4）；同一步内不能立刻调用刚揭示的工具（工具调用只能下一步发起）。
- 宿主会为工具面变化追加 `request/header` 与 `tool-addition` 公告，插件不注入消息。

**收益随时间衰减（接受的代价）**：

- 授权只增不减，可见面随会话推进单调增长；每授权一个工具，后续每个请求多带它的 schema（平均 947 字符 ≈ 270 tokens）。
- 以缺省上限 12 计：最多长到约 20.5k 字符（≈ 5.9k tokens，-64%）。若把上限调高，长会话末段会逐步逼近全量：61 个工具 / 57,798 字符 / ≈ 16.5k tokens，**收益趋近于零**。
- 这是明确接受的代价：换取「授权后不再消失」的可预期性，避免回合边界撤回造成的废步与反复咨询。会话结束重开即可回到初始面，这也是达到上限时提示重开会话的原因。

**会话结束 / resume 与 fork**：

- 会话结束：状态随 agent 销毁一起消失。
- resume / fork：新代理从初始集重建；宿主会话日志**不改写**——已发生的 tool/call 与 tool/result 记录原样保留（审计与回放完整），只是这些工具在新代理里暂不可见，模型需要时再咨询。
- 因此 v1 中「不再可见」只剩会话边界这一种情形，不存在回合级撤回。

**被遮罩工具被调用时**：

- 机制：在代理作用域注册一条 `tools/pre-execute` 监听器，对「全局存在但当前被遮罩」的名字返回 `{ kind: "deny", reason }`（决策形状见 `packages/core/tools/src/index.ts:608-612`）。宿主对未知名字仍会走策略管线（`:1408-1414` 的注释明确「policy listeners still see every name」），所以遮罩中的调用能被拦到。
- 文案（进会话的可行动错误，形态为 `Error: …`）：

```
工具 "task_decompose" 当前不可见（被 tool-consult 收纳）。
先调用 consult_tools 咨询（例如 query: "拆任务"），揭示后即可调用；
已知名字时也可用 names 直接指定。
```

- 该监听器在审批判定之前执行，因此不会为不可见的工具弹出审批。
- 兜底：监听器未注册或自身异常时，退回宿主原生 `unknown tool "<name>"`（`UNKNOWN_TOOL`），行为与未装插件一致。

**不采用的方案**：

- 回合末 LRU / TTL 收回（2026-10-22 人工裁定取消：会抽走刚用过的工具，造成废步与再咨询）。
- 不设上限（长会话无界逼近全量，且没有「重开」的提示点）。
- 上限触发时抽走最久未用（不可预期，模型无法预判）。

### D4 与 tools.restrict 的配合与失败降级

**遮罩口径**：

- 单条活动 mask：每个代理**只有一条**遮罩，`allow = (initialTools ∪ grantedNames) ∩ 可限制名`；变更时「先 dispose 旧遮罩、再 restrict 新名单」，绝不同时挂两条（交集会越收越少）。授权只增不减，所以遮罩只会单调放宽。
- 可限制名口径：用 `schemas()`（全局视图，`packages/core/tools/src/index.ts:1268`）重建允许名单，过滤掉已注销 / 未注册的名字，避免未知名抛错。
- **咨询工具不能出现在 allow 名单里**：它注册在代理自身层，不在可限制名集合中（R2），点名会触发「unknown global tool」。
- `allow: []` 合法（意味着全遮），此时只剩自身层工具（咨询工具）。

**调用点与归属**：

- 在 `agent/created` 监听里对 `agent.ctx` 调用；Effect 归代理所有，代理销毁自动撤销（R3）。
- 插件加载时对 `ctx.agents.list()` 里的既有代理补做一次（热挂载）。

**与其它遮罩消费者的关系**：

- 宿主 `subagent` 的 `toolFilter` 也是 `restrict`（`packages/subagent/subagent/src/child-agent.ts:217`）。两条遮罩**取交集**：父级（我方）遮掉的工具，子代理即使被显式 allow 也拿不到。
- 因此缺省 `applyTo: "roots"`：只遮根代理（`header.origin !== 'subagent'` 且 `delegationDepth` 缺省），子代理保持调用方给定的工具面。配置 `applyTo: "all"` 可覆盖（此时子代理也会多一个咨询工具，且其 `toolFilter` 结果会与我方遮罩取交集）。

**失败与降级（三种必答场景）**：

1. **agent scope 不可用**（旧宿主，或 `ctx` 没有 scope 标签）：`restrict` 会抛「requires a scoped context」。插件捕获后把该代理标记 `unmasked`：不遮罩、不报错，咨询工具退化为全局目录检索（只讲有哪些工具，不改可见性）。会话行为与未装插件一致。
2. **`restrict` 抛错**（名单含未知全局名、工具在应用瞬间被注销等）：先按 `schemas()` 过滤名单重试一次；仍失败则 `unmasked`，写一条告警（每代理一次）。咨询工具保持可用；此后揭示只记本地、不生效，返回值里注明「本次揭示未生效」。
3. **服务缺失**（`tools` 或 `agents` 服务未挂载）：插件整体不启用，`apply` 直接返回；不订阅事件、不注册工具、不产生任何副作用。

完整矩阵：

| 失败 | 判定 | 降级行为 | 告警 |
| --- | --- | --- | --- |
| `tools` 服务缺失 | apply 时 `ctx.get("tools")` 为空 | 插件整体不启用 | 一次 |
| 无会话作用域（旧宿主 / 非 agent ctx） | `agent.ctx` 无 scope，或 `restrict` 抛 “requires a scoped context” | 该代理不遮罩；改注册一个全局咨询工具，只做目录检索、不改可见性（仍可用） | 每插件一次 |
| `restrict` 抛错（未知全局名 / 名称失配） | 抛 unknown global tool | 用 `schemas()` 过滤后重试一次；仍失败则该代理标记 unmasked，揭示不生效并在返回值注明 | 每代理一次 |
| 咨询工具重名 | 自身层 `register` 抛 duplicate | 该代理不注册咨询工具，遮罩照常 | 每代理一次 |
| 代理销毁 / 插件卸载 | Effect dispose | 遮罩与工具自动撤销，状态表清理 | 无 |
| 索引为空 | 无全局工具 | 咨询工具返回「无可用工具」 | 无 |

**注册表变化**：

- `tools/change` → 重建索引。
- 新注册的全局工具**缺省隐藏**（不在 allow 名单里）；若落在 `initialTools` 的通配范围内，下次应用遮罩时自动纳入。
- 已授权工具被注销 → 从 granted 中静默移除（不报错）。

**HMR / 重复 apply**：状态表按 agentId 幂等；重复 apply 先 dispose 旧 Effect 再建新的。

## 4. 接口与配置

### 4.1 咨询工具 `consult_tools`

参数：

| 参数 | 类型 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `query` | string | — | 自然语言描述要做什么（中英文均可） |
| `names` | string[] | — | 直接按名揭示；与 `query` 二选一 |
| `limit` | number | 5 | 匹配返回数量，1 至 20 |
| `reveal` | boolean | true | false = 只预览，不改变可见性 |

返回内容（渲染为文本）：已揭示项（名称 + 一句话 + 状态）、未揭示候选、名额提示；无匹配时给分组名称索引；超过 `maxRevealed` 时返回拒绝新增的文案。

示例一（命中并揭示）：

```
已揭示（本会话内持续可见，下一次请求起可调用）：
- session_channel：跨会话消息通道：列在线会话 / 发消息 / 查收件箱。
- channel_delegate：把任务委托给本机另一个会话执行并回收结果。

名额：已揭示 2 / 12（新增上限）。授权只增不减，本会话内不会收回。
提示：完整参数定义随下一次请求送达，直接调用即可。
```

示例二（无匹配）：

```
没有匹配的工具。可用的工具分组：
- task_*（5）：task_decompose, task_implement, task_execute, task_stop, task_status
- rule_*（4）：rule_add, rule_update, rule_remove, rule_list
- herdr_*（2）：herdr_use, herdr_list

请换更宽泛的词，或用 names 精确指定。
```

示例三（已可见）：返回「已在可见集中，直接调用即可」，不重复计数。

示例四（达到上限）：

```
已达新增揭示上限（12 / 12），本次未揭示新工具。
已授权的工具不受影响；如确需更多，请结束会话重开（resume 不继承授权集合）。
```

工具描述（模型可见部分）要写清：何时用、一次调用即揭示、授权只增不减、名额上限与拒绝行为、已可见的工具不重复计数。

### 4.2 配置表

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `maskMode` | `allowlist` | `allowlist` / `denylist` / `off` |
| `initialTools` | 8 核心清单 | 支持通配 |
| `applyTo` | `roots` | `roots` / `all` |
| `maxRevealed` | 12 | 新增揭示的**硬上限**（不是同时可见数）；超限拒绝新增并提示重开会话 |
| `matcher` | `keyword` | 预留 `hybrid` |
| `maxResults` | 5 | 单次返回上限（`limit` 不得超过它） |
| `audit` | false | 是否向会话写 `tool-consult/*` 审计事件（ignorable） |

### 4.3 状态机

每个代理一条状态：

```
created → masked（restrict 成功）
        → unmasked（任一失败，降级）
masked --consult(reveal)--> masked（替换遮罩，granted 只增）
masked --consult(超上限)--> masked（拒绝新增，无副作用）
disposed → 清状态（Effect 自动撤销）
```

### 4.4 插件接线契约

- `export const name = "tool-consult"`、`inject = ["tools", "agents"]`（`agents` 用于热挂载时列已有代理）。
- 订阅：`agent/created`（建遮罩与咨询工具）、`agent/disposed`（清状态）、`tools/change`（重建索引）；另在代理作用域注册 `tools/pre-execute` 拦截器（被遮罩工具的可行动文案，见 D3）。不做 `turn/end` 处理（授权不撤回）。
- 所有注册都经 `ctx.effect` / `agent.ctx`，插件卸载时自动撤销；状态表按 `agentId` 幂等，重复 apply 先 dispose 旧 Effect。

## 5. 风险与已知限制

1. **模型误判「工具不存在」**：遮罩后模型看不到工具，可能改用 `bash` 绕路（用 shell 代替专用工具）。缓解：咨询工具描述写明「先咨询再动手」；核心集保留通用工具。
2. **多一次往返**：隐藏工具首次使用要多一次咨询。缓解：核心集覆盖高频工具；一次咨询可揭示 5 个。
3. **长会话收益衰减（接受的代价）**：授权只增不减，可见面单调增长；缺省上限 12 把增长封顶在约 5.9k tokens，但上限调高或会话很长时，末段会逼近全量 16.5k tokens，收益趋近于零。这是换取「授权后不再消失」的代价；缓解手段是缺省上限与「结束会话重开」的提示。
4. **resume / fork 丢授权**：新代理从初始集重建，历史里提到过的工具可能不可见。缓解：模型可再咨询；后续可用审计事件重放（见 §7）。
5. **缓存失效**：揭示会改变工具声明列表；`in-history` 路由靠 tool-addition 增量，`addition-only` 路由重写列表。收回已取消，所以头部变更次数 = 揭示次数，不再有回合级的反复失效。
6. **PTC（`run_code`）模式**：PTC 下模型只看见 `run_code` 与 SDK 投影，遮罩对 SDK 内可见工具同样生效（`sdkSchemas` 走同一 `view`），但「咨询后揭示」的收益与交互需另测；v1 不做专门适配。
7. **子代理**：缺省不遮子代理；若配置 `applyTo: "all"`，与调用方 `toolFilter` 取交集可能让子代理缺工具，需人工确认。
8. **工具名稳定性**：`initialTools` 里的名字被上游改名会静默失效（告警一次），需随宿主升级维护。
9. **一句话简述的粒度**：取自工具描述首句截断（如 80 字符），可能不足以判断；可再咨询，或看揭示后的完整定义。

## 6. 规划

### 6.1 计划改动文件清单（包内；根级接线归 H 组）

- `tool-consult/package.json`（`dsh.bundle.patch` 契约）
- `tool-consult/cordis.patch.yml`（插入自身行 + 缺省配置）
- `tool-consult/index.ts`（re-export）
- `tool-consult/src/main.ts`（`apply`、`agent/created` 监听、遮罩管理、遮罩中调用拦截）
- `tool-consult/src/tokenize.ts`（英文 / CJK 分词）
- `tool-consult/src/matcher.ts`（BM25 打分、别名、回退）
- `tool-consult/src/aliases.ts`（别名表）
- `tool-consult/src/state.ts`（每代理授权集合、上限判定、遮罩替换）
- `tool-consult/src/tool.ts`（`consult_tools` 定义与渲染）
- `tool-consult/tests/*.test.ts`（分词 / 打分 / 状态机 / 宿主假件）
- `tool-consult/README.md`；机制较厚时补 `tool-consult/docs/DESIGN.md`

（不含根 `package.json`、`AGENTS.md`、根 README 双侧、`profiles/example/cordis.patch.yml`、`scripts/test-parallel.sh`。）

### 6.2 分阶段实现

1. 阶段一（纯函数）：分词 + 打分 + 别名 + 回退，配单测（不碰宿主）。
2. 阶段二（状态机）：granted 集合、上限拒绝、替换式遮罩应用（假宿主单测）。
3. 阶段三（接线）：`apply` + `agent/created` + `tools/change` + 工具注册与渲染。
4. 阶段四（真机）：本 profile 挂载，实测工具面与咨询命中率，人工确认。

### 6.3 实现期验收

- 机械：包内 `npm run check`、`npm run build`、`npm run test` 通过。
- 行为：缺省会话首请求工具数 = 初始集 + 1；咨询「跨会话发消息」命中 `session_channel`；揭示后下一步可调用，且其后各回合持续可见（`turn/end` 不减）。
- 上限：第 13 次新增揭示被拒绝，文案含「结束会话重开」，可见集保持不变。
- 重置：resume / fork 后新代理回到初始集。
- 降级：伪造 `restrict` 抛错，会话不中断且告警一次。
- 规模：单请求工具描述体量相比现状下降 ≥ 80%（脚本可复算）。

### 6.4 测试样例（实现期可运行）

- 纯函数：固定文档集，断言「查询 → 期望首位」；断言中文二元组命中；断言同分稳定排序。
- 状态机：断言授权只增不减（重复 reveal 与跨回合不减少）；断言超上限时拒绝新增且集合不变；断言幂等返回「已可见」。
- 假宿主：记录 `restrict` 调用序列，断言「替换而非叠加」；断言代理销毁后 dispose 被调用。

## 7. 未决与后续

- 语义 / 混合匹配（`matcher: "hybrid"`）是否值得开：等阶段四的真机命中率数据。
- 长会话末段收益衰减：是否需要「按任务重开会话」的提示，或把会话内授权改为可选的回合级（当前裁定为只增不减）。
- resume 后的授权连续：可用 `tool-consult/reveal` 审计事件 + 启动重放，但宿主读日志接口已弃用，需要先找替代（`sessionQuery` 服务）再定。
- PTC 模式适配。
- 与 `skill` 目录的关系：skill 也是「名称 + 简介 → 加载」，两者是否合并成统一发现入口，待观察。
