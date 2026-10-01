# 待开发功能清单

> 职责：待办全集：缺陷 + 功能 + 里程碑 + 插件规划
> 不负责：现状描述（见 `docs/STATUS.md`）
> 过期条件：无

> 本清单只列**未完成**项；已完成项见 `STATUS.md` 状态表（实现与验证证据在各包源码/测试与 git 历史；已完成的实施清单归入 `archive/`），不在此重复。
> 设计依据：`docs/host/AGENT-ARCHITECTURE-ANALOGY.md`（架构与接口对照）、`archive/PI-DSH-FEATURE-COMPARISON.md`（pi→dsh 迁移基线差距，归档调研）。实现时以根目录 `docs/host/DSH-CTX-API.md` 对齐宿主接口。
> 基线：dsh `dsh-v0.1.7-rc.2`（当前运行版本；旧版接口兼容项见宿主升级对照文档）。
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

## 2. 未完成项

> 扁平清单，**按依赖与工作量排序**（2026-09-30 调整：先解锁项、同层先小后大；编号仅供阅读，随整理重编）。
> 顺序依据：「命令模板的取消/超时终态」为真机遗留缺陷；「executor 隔离落地」依赖本机 `dsh-git-worktree` 就绪、「executor 用量计量」依赖宿主 `sessionProjections` 投影面；「`docs/STATUS.md` 对齐现状」为文档类收尾；「PDF/文档结构视图」无依赖但工作量最大、需解析方案选型。优先级：P0 > P1 > P2。

| # | 功能 | 来源 | 落点（复用） | 工作量（估） | 优先级 |
|---|------|------|--------------|--------------|--------|
| 1 | PDF/文档结构视图 | readseek 拆项 4（对比文档 §3.4） | 无底座，新工具 | 4 h+（解析方案待选型） | P2 |

| 2 | **命令模板的取消/超时终态**：真机发现 `playbook` 命令在子代理死亡或取消后可能**无 `command/done`**（命令悬挂）；且 `stepTimeoutMs`（缺省 600s）触发的 abort 是否真的中止子代理未经真机验证。期望：命令任何路径都回终态（成功/失败/取消），并在子会话结束时回收 | 「模板体系」真机观察（追踪文档 2026-09-30 第三轮） | `command-template`（`src/{steps,subagent,main}.ts`） | P2 |

| 3 | **executor 隔离落地（git worktree）**：叶子 `executor` 已支持 `cwd` 透传，但无隔离；原计划经本机插件 `dsh-git-worktree`，而该插件在本机**不存在实现**（`~/.dsh/plugins/dsh-git-worktree` 只有空目录、profile 未挂载；npm registry 有 `dsh-git-worktree@0.3.1`）。期望：装上 / 实现该插件后，executor 增补 `isolate: "worktree"`（引擎建 / 回收 worktree，路径作为 `cwd` 传给 subagent / command 后端） | 「task-engine 执行扩展」实施期裁定（2026-10-02，用户：③ 另开条目） | `task-engine`（`src/{types,gate,engine,main}.ts`）+ 本机 `dsh-git-worktree` 插件 | 1 h（依赖插件就绪） | P2 |

| 4 | **executor 用量计量接 usage 口径**：`budget.maxTokens` 已映射宿主 `agentOptions.maxTokens`（输出上限），但 subagent 目前只报 `tokensKind: "pressure"`（`tokenMeter.measure` 的上下文压力），故 `overBudget` 对 subagent 一律不判（2026-10-02 真机第二轮发现误报后收紧，用户裁定「另开条目」）。期望：接 `ctx.sessionProjections.snapshot(session, ["tokenUsage"])`（或 `deriveTurnTokenUsage`）取 `outputTokens`，与 `budget.maxTokens` 同口径比较并标 `tokensKind: "usage"` | 「task-engine 执行扩展」真机验证第二轮（2026-10-02） | `task-engine`（`src/main.ts` 计量段 + `src/engine.ts` 判定） | 1 h | P2 |

| 5 | **`docs/STATUS.md` 对齐现状**：该表为用户择时更新的对照文档，当前多处过期——① 「总览」称「12 个插件全部完成」，而状态表缺 `rule-engine` / `symbol-normalizer` / `session-channel` / `session-title-cutoff`（`command-template` 的模板体系也已落地）；② 「剩余 P2 插件（workflow-ext / web-ext / session-broker / command-template）未开始」中 `command-template` 已完成；③ `fs-digest` 行注记「缺陷见 `fs-digest/docs/BACKLOG.md` D1」，而该文件现为「当前无未完成项」；④ 各行单测数为 2026-09 快照（如 knowledge-base 已 39 → 57）。期望：逐包核对后整表回写（含新增包行与单测数），或明确该表只维护 P0/P1 子集 | 「task-engine 执行扩展」收尾审计 + 用户 2026-10-02 指示「更新 backlog」 | `docs/STATUS.md`（用户择时更新；本次仅登记） | 1 h | P2 |

**未立项观察项**（暂不单独立项，作为后续可选项）：意图/多策略检索（knowledge-base 已双 FTS5，距 BM25+RRF+proximity 一步）、MCP 脚本化（mcpScript）、活动工具交互管理。

## 3. 里程碑

1. 里程碑一（P0，引擎三块 + 知识库底座）与里程碑二（P1：goal-contract / metric-loop、知识库记忆层与淘汰提升、fan-out 就绪池、hash-edit / ast-tools、security-guard / herdr-integration 等）均已完成。
1. 里程碑三（P2）剩余（按依赖与工作量排序）：命令模板取消/超时终态、executor 隔离落地（git worktree）、executor 用量计量接 usage 口径、`docs/STATUS.md` 对齐现状、PDF/文档结构视图，按需排期；已完成项与已取消 / 不再立项项见 §1 索引。
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
