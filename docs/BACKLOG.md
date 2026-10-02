# 待开发功能清单

> 职责：待办全集：缺陷 + 功能 + 里程碑 + 插件规划
> 不负责：现状描述（见 `docs/STATUS.md`）
> 过期条件：无

> 本清单只列**未完成**项；已完成项见 `STATUS.md` 状态表（实现与验证证据在各包源码/测试与 git 历史；已完成的实施清单归入 `archive/`），不在此重复。
> 设计依据：`docs/host/AGENT-ARCHITECTURE-ANALOGY.md`（架构与接口对照）、`archive/PI-DSH-FEATURE-COMPARISON.md`（pi→dsh 迁移基线差距，归档调研）。实现时以根目录 `docs/host/DSH-CTX-API.md` 对齐宿主接口。
> 基线：dsh `dsh-v0.2.0-rc.2`（2026-10-02 由 `0.1.7-rc.2` 升级；本次接口对照见 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`）。
> 编号口径：`#N` **仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**（不保证稳定，勿作跨引用）；与其它层 BACKLOG 的编号互不关联，跨层引用须写明文件路径。
> 优先级：**P0** 架构主线；**P1** 核心体验补齐；**P2** 长尾。状态标记：`[x]` 已实现（仅第 1 节索引使用）、`[~]` 部分实现（注明未含部分）、无标记 = 未实现。

## 1. 已完成索引

`[x]` 已实现并合入 main，落点如下（单测数与首版边界见状态表）：

- 任务控制：task-engine（Frame 状态机、工具族、双重门禁、RET 三级路由、step 裁决、**叶子执行后端**：`executor` 声明 + `task_execute` 工具 + `subagent` / `workflow` / `command` 后端 + 用量计量，追踪文档 `docs/archived/2026-10-02-injection-timing-naming-warn-executor.md`）、fan-out 就绪池、goal-contract、metric-loop；

- 知识库与记忆：knowledge-base（两张基表 + 两张 FTS5 虚表、两级写策略与淘汰提升、持久记忆 CRUD、**入库规则与隐私 / 容量边界**、**自动巩固**（提升 / 合并 / 淘汰，启动后与 compaction 后触发），追踪文档 `docs/archived/2026-10-02-knowledge-events-and-memory-consolidation.md`）、output-compress、fs-digest；

- 代码与文件：hash-edit、ast-tools、code-map 报告与影响面、结构层索引与候选调用图 + LSP 语义层（callers 的 findReferences 精确裁决，`precision:lsp/structural`；追踪文档 `docs/archived/2026-09-29-codemap-lsp-semantic.md`）；

- 上下文报告：context-report（host-only 投影 `sessionContext` 折叠会话累计 + `context_report` 三档报告）；

- 安全与集成：security-guard 策略层、herdr-integration；

- 规则触发与符号规范：rule-engine、TUI 符号规则迁移（落点为 symbol-normalizer 插件）、next-step 注入路径、仓库级集成、插件注入消息 `form:'notice'` 一行提示渲染、消费者框架（`registerConsumer` + `evaluate`）、symbol-normalizer 插件；真机验证记录见 `docs/archived/2026-09-27-rule-engine-consumer-and-integration.md`；

- TUI：/workflows 面板、/council、/search 多 provider 聚合、声音提醒，以及 7 项纯 TUI 命令与 A1-A5（`/task` `/guard` `/memory` `/loop` `/contract`）；

- 工程流程与文档：文档体系与变更规范落地（追踪文档 `docs/archived/2026-09-25-docs-workflow-rollout.md`）、`TUI/docs/IMPLEMENTATION.md` 拆分删除（命令/机制 → `TUI/docs/DESIGN.md`「实现要点（机制与命令）」、渲染/排版 → `TUI/docs/SPEC.md` §15、验证 → `TUI/README.md`；追踪文档 `docs/archived/2026-09-29-tui-implementation-doc-split.md`）、根 README 英文化（英文主档 `README.md` + 中文版 `README.zh.md`，`AGENTS.md` 语言约定例外与口径同步；追踪文档 `docs/archived/2026-09-30-readme-i18n.md`）。

- 运行时与宿主：宿主双栈兼容垫片清理（0.1.7-rc.2 单一形态；追踪文档 `docs/archived/2026-09-29-host-single-stack-cleanup.md`）、tmux 断连后 dsh 退出 → 退出前问题面板确认（追踪文档 `docs/archived/2026-09-29-exit-confirm-panel.md`）、跨会话消息通道 `session-channel` 插件（专用 Redis 实例 + unix socket；追踪文档 `docs/archived/2026-09-29-cross-session-intercom.md`）、跨会话共享 KV（session-channel 服务面扩展，last-value + 版本号；追踪文档 `session-channel/docs/archived/2026-09-29-shared-kv.md`）、会话标题参考窗口改为「最近一次 `git commit` 之后」（新包 `session-title-cutoff`，接管 `ctx.sessionTitle` 唯一 provider；追踪文档 `session-title-cutoff/docs/archived/2026-09-29-title-cutoff-provider.md`）、跨会话委托/协调（`session-channel` 任务语义：任务表 + 结果自动/显式回传 + `channel_delegate`/`channel_task`/`channel_task_result` 三工具；追踪文档 `docs/archived/2026-09-30-cross-session-delegation.md`）、模板体系（`command-template`：预案 `/playbook` 统一入口 + 五族模板 + 双源目录 + 模板级模型选择；追踪文档 `docs/archived/2026-09-30-template-system.md`）。

- 已取消/不再立项：rate-guard（不实现，pi 侧已移除，dsh 侧由官方 `llm-retry` 覆盖，见 `archive/PI-DSH-FEATURE-COMPARISON.md` §5.1）；GitHub 仓库克隆、PDF 提取 / 视频理解、密文扫描、安全 issue 上报（用户 2026-09-29 裁定移除，不立项）；近期改动代码审查、preset 机制迁移评估（用户 2026-09-29 裁定直接关闭，不立项）。

- 宿主面知识：官方 **0.2.0-rc.2 对照汇总**（`docs/host/HOST-UPGRADE-0.2.0-rc.2.md`；工具 / 事件 / 服务面零增删，`docs/host/HOST-PACKAGES.md` 同期刷到 0.2.0 口径，审阅记录见 `docs/archived/2026-10-02-host-upgrade-0.2.0-rc.2.md`）。

- 复用审计：官方包与本仓 18 包逐项对照的「改用 / 保留 / 并存」结论（**改用 0 / 保留 12 / 并存 6**）与 5 项改造点，见 `docs/ARCHITECTURE-REUSE.md`（追踪文档 `docs/archived/2026-10-02-reuse-audit.md`）。

- profile 挂载面：**扩张到 base + 本仓 18 包 + 10 个官方行**（2026-10-02：`session-stats` / `session-turn-outline` / `session-reference` / `message-feedback` / `workspace-changes` / `file-reference-local` / `terminal` / `terminal-bash` / `invariants` / `workspace`；全部为投影 / 服务 / 事件面扩展，排除口径与第二批选题见 `docs/archived/2026-10-02-profile-mount-expansion.md`）。

- 宿主运行基线：**已升到 `dsh 0.2.0-rc.2`**（2026-10-02：全局安装 + profile 树外加装包 `session-title-all-prompts-llm` 同步 + `scripts/install.sh` 默认版本 + 主要版本引用（含 5 个包 smoke 脚本的宿主门槛）；进程外与进程内验证见追踪文档 `docs/archived/2026-10-02-host-upgrade-execution.md`）。

## 2. 未完成项

> 扁平清单，**按条目间逻辑依赖排序**（2026-10-02 依赖重排：编号即先后顺序；同层先小后大。编号仅供阅读，随整理重编）。
> 顺序依据（2026-10-02 依赖重排；复用审计完成后重编）：**① 基线链已完成**——接口对照汇总、宿主升级、profile 挂载面扩张、复用官方包审计四件基线工作均已落地（见 §1）。**② 结构能力线 `#1 → #2 → #3 → #4`**——#2 / #3 / #4 都要等 #1（Markdown 结构视图）的落地形态（`fs-digest` 轻量入口与 `md-logic` 深能力的分工已定，但 #3 复用 #2 的解析与结构模型，故在 #2 之后）。**③ 独立修复项 `#5` / `#6`**——仅弱依赖基线，彼此无依赖。**④ `#7`** 阻塞于本机 `dsh-git-worktree` 就绪（外部条件，非本仓可控）。**⑤ `#8`** 为收尾类，需前面状态定稿后才能一次写准。优先级：P0 > P1 > P2。

| # | 功能 | 来源 | 落点（复用） | 工作量（估） | 优先级 |
|---|------|------|--------------|--------------|--------|
| 1 | **Markdown 结构视图（只做 Markdown；纯文本与 PDF 均不做）**：在 `fs_digest` 现有标题树（`outline`，Markdown = 最大标题级）之上补**块级结构**——列表 / 表格 / 代码块 / 引用——并给每节**行范围**，让模型按节读而不是整篇读。**不做**：纯文本启发式分节（`fs_digest` 对未知语言仍返回 `unsupported_language`）、PDF 与其它二进制文档（本条经两次收窄：先移除 PDF，再移除纯文本）。**与条目 3（`md-logic`）的分工**：本条 = **轻量通用入口**（只读、零新增依赖、与 `outline` / `signatures` / `pruned` 三模式统一），补到「块级 + 行范围」为止；`md-logic` = Markdown 专用深能力（精确解析 / 可查询 / 可选改写）——两者**并存不合并**（先例：`fs-digest.signatures` 与 `ast-tools.outlineFile` 服务同一「代码结构」诉求也未合并，仓库模式是「轻量入口 + 专用深能力」并存） | readseek 拆项 4（对比文档 §3.4，原写「文档结构视图（PDF 等）」）+ 用户 2026-10-02 两次裁定（「先从纯文本 / markdown 开始，不做 pdf」→「纯文本也不做了，只做 markdown」） | `fs-digest`（扩展 `outline` 的 Markdown 解析：块级结构 + 每节行范围；复用现成工具面、LSP 降级链与渲染上限） | 1.5 h | P2 |
| 2 | **`ast-tools` 注册模型侧工具（把语法级结构归纳交到模型手上）**：现状只有库 / 服务面（`searchAst` / `replaceAst` / `outlineFile` / `runRules`），**不注册模型侧工具**——模型够不着语法级查询（「所有 `foo(` 调用点」「某 AST 形态」），只能经 `code-map` 间接用。期望：注册模型侧工具（建议单工具 + action 分派，与 `code_map` 同风格：搜索 / 大纲 / 规则；`replace` 单独且默认 dry-run），保留 `language` / `path` / `strictness` 参数；缺 ast-grep 二进制按现成 `INSTALL_GUIDANCE` fail-closed；工具描述须写清「AST 形态 vs 文本 grep」的选择成本 | 用户 2026-10-02 裁定（代码逻辑结构能力盘点） | `ast-tools/src/main.ts`（+ 工具定义文件与 README） | 1-1.5 h | P2 |
| 3 | **新建 markdown 逻辑结构插件（对标 `ast-tools`，单文件粒度）**：给 Markdown 一份「语法 / 块级结构」能力——标题层级（可参照 `fs-digest` 的原生解析）、列表、表格、代码块、引用、链接、frontmatter，输出**带行范围的结构树**（供模型按节读、按节改）。**与条目 1 的分工**：条目 1 = `fs-digest` 的轻量增强（只读、零依赖、快览，与既有三模式统一）；本条 = 专用深能力（精确解析 / 查询 / 可选改写）——两者**并存不合并**。**模型面选择成本**：`ast-tools` 与 `fs-digest` 不打架的部分原因是它**不注册模型侧工具**；若本条注册模型侧工具，须在工具描述里互相指路（快览 → `fs_digest`，深查 → 本条），否则先只提供服务面（像 `ast-tools` 那样由上层消费）。选型约束：优先复用现成解析器（remark / marked）或标准库，自研轻量解析需说明理由（`AGENTS.md`：不随意新增依赖）；包名定为 `md-logic`（2026-10-02 用户裁定，原名 `md-tools`） | 用户 2026-10-02 裁定「新建一个插件用来处理 markdown 的逻辑结构，与 ast-tools 对标」 | 新包 `md-logic/`（`package.json` 的 `dsh.bundle` + `cordis.patch.yml`，以 `ast-tools` 为模板）+ 文档 | 3-4 h（含解析选型） | P2 |
| 4 | **新建 markdown 项目级结构分析插件（对标 `code-map`）**：索引项目内 `.md` 文件的结构与**关系**——标题锚点、文档间链接（`[x](path#anchor)`）、wiki 链接、对代码 / 文件的引用、被引用计数；查询面建议 `callers`（谁引用了本文档 / 本锚点）、`impact`（改这份文档会波及哪些文档 / 章节）、`orphans`（无人引用的文档）、`report`（文档结构 + 断链报告）。与 `code-map` 的分工须写清（代码 vs 文档；跨类型引用可后续打通）；包名定为 `md-map`（2026-10-02 用户裁定） | 用户 2026-10-02 裁定「分析项目内 markdown 文件的逻辑结构分析、引用和影响面等，对标 code-map」 | 新包 `md-map/`（模板同条目 3）+ 文档 | 3-4 h | P2 |
| 5 | **executor 用量计量接 usage 口径**：`budget.maxTokens` 已映射宿主 `agentOptions.maxTokens`（输出上限），但 subagent 目前只报 `tokensKind: "pressure"`（`tokenMeter.measure` 的上下文压力），故 `overBudget` 对 subagent 一律不判（2026-10-02 真机第二轮发现误报后收紧，用户裁定「另开条目」）。期望：接 `ctx.sessionProjections.snapshot(session, ["tokenUsage"])`（或 `deriveTurnTokenUsage`）取 `outputTokens`，与 `budget.maxTokens` 同口径比较并标 `tokensKind: "usage"` | 「task-engine 执行扩展」真机验证第二轮（2026-10-02） | `task-engine`（`src/main.ts` 计量段 + `src/engine.ts` 判定） | 1 h | P2 |
| 6 | **命令模板的取消/超时终态**：真机发现 `playbook` 命令在子代理死亡或取消后可能**无 `command/done`**（命令悬挂）；且 `stepTimeoutMs`（缺省 600s）触发的 abort 是否真的中止子代理未经真机验证。期望：命令任何路径都回终态（成功/失败/取消），并在子会话结束时回收 | 「模板体系」真机观察（追踪文档 2026-09-30 第三轮） | `command-template`（`src/{steps,subagent,main}.ts`） | P2 |
| 7 | **executor 隔离落地（git worktree）**：叶子 `executor` 已支持 `cwd` 透传，但无隔离；原计划经本机插件 `dsh-git-worktree`，而该插件在本机**不存在实现**（`~/.dsh/plugins/dsh-git-worktree` 只有空目录、profile 未挂载；npm registry 有 `dsh-git-worktree@0.3.1`）。期望：装上 / 实现该插件后，executor 增补 `isolate: "worktree"`（引擎建 / 回收 worktree，路径作为 `cwd` 传给 subagent / command 后端） | 「task-engine 执行扩展」实施期裁定（2026-10-02，用户：③ 另开条目） | `task-engine`（`src/{types,gate,engine,main}.ts`）+ 本机 `dsh-git-worktree` 插件 | 1 h（依赖插件就绪） | P2 |
| 8 | **`docs/STATUS.md` 对齐现状**：该表为用户择时更新的对照文档，当前多处过期——① 「总览」称「12 个插件全部完成」，而状态表缺 `rule-engine` / `symbol-normalizer` / `session-channel` / `session-title-cutoff`（`command-template` 的模板体系也已落地）；② 「剩余 P2 插件（workflow-ext / web-ext / session-broker / command-template）未开始」中 `command-template` 已完成；③ `fs-digest` 行注记「缺陷见 `fs-digest/docs/BACKLOG.md` D1」，而该文件现为「当前无未完成项」；④ 各行单测数为 2026-09 快照（如 knowledge-base 已 39 → 57）。期望：逐包核对后整表回写（含新增包行与单测数），或明确该表只维护 P0/P1 子集 | 「task-engine 执行扩展」收尾审计 + 用户 2026-10-02 指示「更新 backlog」 | `docs/STATUS.md`（用户择时更新；本次仅登记） | 1 h | P2 |

**未立项观察项**（暂不单独立项，作为后续可选项）：意图/多策略检索（knowledge-base 已双 FTS5，距 BM25+RRF+proximity 一步）、MCP 脚本化（mcpScript）、活动工具交互管理。

**复用审计产出（`docs/ARCHITECTURE-REUSE.md` §4，未立项）**：A `context-report` 改用已挂的 `sessionStats` / `turnOutline` 投影补轮次 / 墙钟 / 大纲；B `output-compress` 写清与官方 `spill-policy` / `compaction-tool-result-pruner` 的分工与阈值语义（实测**不存在**双重截断）；C `metric-loop` 唤醒链补 `@deepseek-ai/dsh-schedule`（**会新增模型工具面**，需用户裁定；备选是改用已挂的 `tool-ralph` / `goal-round-driver` 承担循环）；D `hash-edit` / `fs-digest` 可选改用 `ctx.fs`（含行为变更：hash-edit 写侧将受 workspace-write 围栏，宜与 render 缺陷同批）；E 「可挂但不该挂」清单一律落非生成型文档（本文件 / `profiles/example` 注释），勿写入会重生成的 `HOST-PACKAGES.md`。观察项：① `knowledge-base` ⇄ `output-compress` 共库直写的隐私边界；② 是否开启 `session-query-sqlite` 的 FTS5（`openAt: first-search`）并与知识库分工；③ `rule-engine` 与官方 `repeat-tool-reminder` 的注入重复度。

## 3. 里程碑

1. 里程碑一（P0，引擎三块 + 知识库底座）与里程碑二（P1：goal-contract / metric-loop、知识库记忆层与淘汰提升、fan-out 就绪池、hash-edit / ast-tools、security-guard / herdr-integration 等）均已完成。
1. 里程碑三（P1/P2）剩余（2026-10-02 复用审计完成后重编，编号即顺序）：Markdown 结构视图（与 `md-logic` 分工并存）→ `ast-tools` 模型侧工具 → 新建 `md-logic` → 新建 `md-map` → executor 用量计量接 usage 口径 → 命令模板取消/超时终态 → executor 隔离落地（阻塞于外部插件）→ `docs/STATUS.md` 对齐现状，按需排期；已完成项与已取消 / 不再立项项见 §1 索引。
1. 依赖：「executor 隔离落地」依赖本机 `dsh-git-worktree` 插件就绪（本机当前不存在实现）；「executor 用量计量接 usage 口径」依赖宿主 `ctx.sessionProjections` 的 `tokenUsage` 投影面；原「近期改动代码审查」能力并入命令模板体系③；其余相互独立。

## 4. 插件规划（未建包）

> 每个插件 = 本仓库一个包目录（以现有包为模板：`package.json` 的 `dsh.bundle` + `cordis.patch.yml` 集成契约）；命名按功能自定，不沿用 pi 插件名。已建插件与其承载清单项见 `STATUS.md`。

| 插件 | 承载清单项 | 复用（不新建） |
|------|-----------|----------------|
| `task-engine`（既有包扩展，非新包） | task-engine 执行扩展 | 宿主 subagents / workflow / llm / token-meter 面；本机本地插件 `dsh-git-worktree` 补隔离 |
| `web-ext` | PDF / 文档结构视图（另有已取消的仓库克隆 / PDF 提取候选） | search provider 扩充、web-fetch-http、shell（git 克隆先行） |
| `session-broker` | 跨会话消息通道（已由 `session-channel` 落地） | 无等效底座，新建 unix socket 通道 |
| `command-template` | 模板体系①②（已落地） | commands（宿主入口）、workflow（宿主执行） |
| 内容资产（非插件） | 模板体系③ | workflow 脚本 + skill 内容 |

## 5. TUI 侧

→ 已迁至 `TUI/docs/BACKLOG.md`（TUI 的变更优先写 TUI 文档）：命令扩展状态、排版与交互开放项、herdr pane 外部问题取证都在那里；本清单只维护跨包功能项。
