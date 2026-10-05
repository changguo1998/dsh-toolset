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

- 规则触发与符号规范：rule-engine、TUI 符号规则迁移（落点为 symbol-normalizer 插件）、next-step 注入路径、仓库级集成、注入消息呈现（**不带** `source.form:'notice'`：TUI 按用户输入块显示、正文以 `[RULE] ` 前缀标明自动注入）、消费者框架（`registerConsumer` + `evaluate`）、symbol-normalizer 插件；真机验证记录见 `docs/archived/2026-09-27-rule-engine-consumer-and-integration.md`；

- TUI：/workflows 面板、/council、/search 多 provider 聚合、声音提醒，以及 7 项纯 TUI 命令与 A1-A5（`/task` `/guard` `/memory` `/loop` `/contract`）；

- 工程流程与文档：文档体系与变更规范落地（追踪文档 `docs/archived/2026-09-25-docs-workflow-rollout.md`）、`TUI/docs/IMPLEMENTATION.md` 拆分删除（命令/机制 → `TUI/docs/DESIGN.md`「实现要点（机制与命令）」、渲染/排版 → `TUI/docs/SPEC.md` §15、验证 → `TUI/README.md`；追踪文档 `docs/archived/2026-09-29-tui-implementation-doc-split.md`）、根 README 英文化（英文主档 `README.md` + 中文版 `README.zh.md`，`AGENTS.md` 语言约定例外与口径同步；追踪文档 `docs/archived/2026-09-30-readme-i18n.md`）。

- 运行时与宿主：宿主双栈兼容垫片清理（0.1.7-rc.2 单一形态；追踪文档 `docs/archived/2026-09-29-host-single-stack-cleanup.md`）、tmux 断连后 dsh 退出 → 退出前问题面板确认（追踪文档 `docs/archived/2026-09-29-exit-confirm-panel.md`）、跨会话消息通道 `session-channel` 插件（专用 Redis 实例 + unix socket；追踪文档 `docs/archived/2026-09-29-cross-session-intercom.md`）、跨会话共享 KV（session-channel 服务面扩展，last-value + 版本号；追踪文档 `session-channel/docs/archived/2026-09-29-shared-kv.md`）、会话标题参考窗口改为「最近一次 `git commit` 之后」（新包 `session-title-cutoff`，接管 `ctx.sessionTitle` 唯一 provider；追踪文档 `session-title-cutoff/docs/archived/2026-09-29-title-cutoff-provider.md`）、跨会话委托/协调（`session-channel` 任务语义：任务表 + 结果自动/显式回传 + `channel_delegate`/`channel_task`/`channel_task_result` 三工具；追踪文档 `docs/archived/2026-09-30-cross-session-delegation.md`）、模板体系（`command-template`：预案 `/playbook` 统一入口 + 五族模板 + 双源目录 + 模板级模型选择；追踪文档 `docs/archived/2026-09-30-template-system.md`）。

- 已取消/不再立项：rate-guard（不实现，pi 侧已移除，dsh 侧由官方 `llm-retry` 覆盖，见 `archive/PI-DSH-FEATURE-COMPARISON.md` §5.1）；GitHub 仓库克隆、PDF 提取 / 视频理解、密文扫描、安全 issue 上报（用户 2026-09-29 裁定移除，不立项）；近期改动代码审查、preset 机制迁移评估（用户 2026-09-29 裁定直接关闭，不立项）。

- 宿主面知识：官方 **0.2.0-rc.2 对照汇总**（`docs/host/HOST-UPGRADE-0.2.0-rc.2.md`；工具 / 事件 / 服务面零增删，`docs/host/HOST-PACKAGES.md` 同期刷到 0.2.0 口径，审阅记录见 `docs/archived/2026-10-02-host-upgrade-0.2.0-rc.2.md`）。

- `md-map`：新建第 19 个插件包（文档版 `code-map`：标题锚点 / 跨文档链接 / wiki / 代码文件引用 / 被引计数，查询 `callers` / `impact` / `orphans` / `report`；单文件解析复用 `md-logic`；36 例测试；追踪文档 `docs/archived/2026-10-02-md-map-package.md`）。

- command-template 终态与回收：`playbook` 等命令的子代理步骤改为**与取消信号竞速**（`start` 与宿主结算面都在竞速内），abort 路径**发起但不等待**回收（宿主 in-process `dispose()` 内部 `await run.result`，等它等于换个地方无界等待）；修掉真机「命令悬挂、无 `command/done`」的根因面（本仓侧任何路径都回终态，文案区分「被调用方取消」/「步骤超时（N ms）」并带子会话 id）；19 例测试（含宿主语义 dispose / start 悬挂 / 迟到 reject 三个回归点），全仓 20 包全绿（追踪文档 `docs/archived/2026-10-02-command-template-terminal-state.md`）。

- task-engine 计量口径（usage → 权威信号）：subagent 用量改读宿主 `tokenUsage` 投影（`sessionProjections.stateOf`＝provider 上报的**累计**输出 token；尚无样本 / 服务缺失 / 抛错时回退 `tokenMeter` 的 pressure 口径），**超预算判定改用宿主权威信号** `stopReason === "max-tokens"`——不做 tokens 数值比较（审阅用真实会话日志回放 12 个 spawn 子会话：totals 6–81,955 vs 实际预算 256/512/4000，数值比较会 10/12 恒真）；72 例单测 + `smoke:executor` 扩 4 条断言，全仓 20 包全绿（追踪文档 `docs/archived/2026-10-02-task-engine-usage-metric.md`）。

- `md-logic`：新建第 18 个插件包（Markdown 逻辑结构：节树 + 块 + 链接清单，带行范围；解析用 `marked` 真实 CommonMark），注册模型侧工具 `md_logic`（structure / blocks / links）并与 `fs_digest` 双向指路；接线 9 处（含补齐根 check/build 链与 test-parallel 的既有漏项）；34 例测试 + 全仓 19 包全绿（追踪文档 `docs/archived/2026-10-02-md-logic-package.md`）。

- `ast-tools` 模型侧工具：注册 `ast_query`（action 分派：search / outline / rules，AST 形态与元变量捕获）与 `ast_replace`（默认 dry-run，写回需 `write:true`）；缺 ast-grep 二进制时注册降级版（调用返回含安装指引的 error）；模型侧行号渲染为 1 基，描述里写明与 `grep` / `glob` / `fs_digest` / `code_map` / `hash_edit` 的选择成本（追踪文档 `docs/archived/2026-10-02-ast-tools-model-tools.md`）。

- Markdown 结构视图：`fs_digest` 的 Markdown `outline` 现在给**每节行范围**（含端点、尾空行不计、父子包含）与**块级结构清单**（list / table / code / quote / frontmatter，带 `§L{节}` 归属）；标题树 45 行 + 块清单 15 行两个独立预算；`scanMarkdown` 为 `src/outline.ts` 的**模块级导出**（未透出包入口，`md-logic` 仅对齐口径、无 import 依赖，2026-10-04 复核更正）（追踪文档 `docs/archived/2026-10-02-markdown-structure-view.md`）。

- 复用审计：官方包与本仓 18 包逐项对照的「改用 / 保留 / 并存」结论（**改用 0 / 保留 12 / 并存 6**）与 5 项改造点，见 `docs/ARCHITECTURE-REUSE.md`（追踪文档 `docs/archived/2026-10-02-reuse-audit.md`）。

- profile 挂载面：**扩张到 base + 本仓 18 包 + 10 个官方行**（2026-10-02：`session-stats` / `session-turn-outline` / `session-reference` / `message-feedback` / `workspace-changes` / `file-reference-local` / `terminal` / `terminal-bash` / `invariants` / `workspace`；全部为投影 / 服务 / 事件面扩展，排除口径与第二批选题见 `docs/archived/2026-10-02-profile-mount-expansion.md`）。

- 宿主运行基线：**已升到 `dsh 0.2.0-rc.2`**（2026-10-02：全局安装 + profile 树外加装包 `session-title-all-prompts-llm` 同步 + `scripts/install.sh` 默认版本 + 主要版本引用（含 5 个包 smoke 脚本的宿主门槛）；进程外与进程内验证见追踪文档 `docs/archived/2026-10-02-host-upgrade-execution.md`）。

- install.sh 四条硬化：`.bak` 堆积（内容未变不写不备份）、profile 树外官方插件版本检查、收尾 `--dump-config` 自检（`--skip-verify`）、头注释口径 + 接线一致性校验；新增 `scripts/test-install.sh`（49 例；追踪文档 `docs/archived/2026-10-03-install-sh-followups.md`）。

- goal 状态行补 `activation`（`⟳` 自动续轮开关）：宿主**进程本地**事件 `goal/activation-changed` → `goalActivationBySession`（末条边、按会话隔离、不落盘）+ 展示值 `activeGoalActivation`（仅 `phase === "active"`、无记录 → `disarmed`）；head 行改 `Goal <符号> <phase>`（`▷` active 绿 / `∥` paused 黄 / `△` blocked 黄（**由红改黄**）/ `✓` complete 绿）+ 尾随 `⟳`（armed 绿 / disarmed 灰），`resumeTo` 补清空边（宿主 resume 经 `sessions.prepare` 重建 Session，activation 归 disarmed 且同值早退不发边）；7 例新用例（重启回归 / 边序无关 / 端到端帧断言），两轮子代理审阅修订（陈旧 armed、SPEC 口径矛盾、宽度表条目登记），反向验证撤符号渲染 → 7 例红（追踪文档 `docs/archived/2026-10-04-tui-goal-activation-symbol.md`）。

## 2. 未完成项

> 扁平清单，**按条目间逻辑依赖排序**（2026-10-04 整理：编号即先后顺序；键序 = 依赖 → 优先级 → 工作量，同层先小后大。编号仅供阅读，随整理重编）。
> 顺序依据（2026-10-04 整理；键序 = 依赖 → 优先级 → 工作量，同层先小后大；编号仅供阅读，随整理重编）：跨层推荐顺序按优先级分组（P2 → P3 → 收尾），同级内按工作量升序；模块级条目按标题 + 文件路径引用（如 `md-logic/docs/BACKLOG.md`）。优先级：P0 > P1 > P2 > P3。

| # | 功能 | 来源 | 落点（复用） | 工作量（估） | 优先级 |
|---|------|------|--------------|--------------|--------|
| 1 | **重新设计长期记忆（知识库 / 持久记忆）模块逻辑**：现状是「先做能力、后补边界」的叠加结果，已暴露的问题都指向同一层——**记忆的生命周期与边界没有统一设计**。归入项（均已随之从本清单移除）：① **写入闸门挂在调用方而非库核心**——`knowledge-base` 的闸门在事件钩子（`hooks.ts:301,304`），核心 `put()` 无过滤（`knowledge.ts:234`）；`output-compress` 经自有 `SharedKbWriter`（`kb-write.ts:183`）直写同组表、**完全不过闸**（闸门上线后仍写入 290 行）；② **分区与作用域未落地**——`project` 未配置，全库只有 1 个值 `default`（缺省见 `index.ts:136`），多目录 / 多会话（304 个 session ref）摘要在检索面**不隔离**；③ **容量与淘汰不设限**——`maxTokensPerProject` 缺省 0（`index.ts:66`），库已 533 MB / ≈4.98 万 chunks 且只增不减；④ **存量无清理路径**——91 行闸门上线前的凭据形态条目从未回扫清理；⑤ 与官方 `session-query-sqlite` 的 FTS5 分工未定（观察项）。期望：以「记忆生命周期」为主线重梳并定稿设计——写入面（谁写 / 哪条路 / 闸门在哪层）、分区与作用域（`project` / `target` / session 语义与检索隔离）、容量与淘汰（预算 / 降级 / 硬淘汰 / 存量回扫）、检索面（双 FTS5 / fuzzy / 与官方分工）、与 `output-compress` 的共库契约。验收：`knowledge-base/docs/DESIGN.md` 修订定稿并经用户确认；由它拆出的实施条目各自可独立验收（回扫后全库零命中 / 跳 project 检索不串 等）。 | 2026-10-05 插件冲突排查与库实测的归纳（用户指示：连原「共库直写无统一口径」条目一并吸收；调研过程记录见 `docs/archived/2026-10-05-kb-shared-write-parity.md`） | `knowledge-base/docs/DESIGN.md`（设计定稿）、`knowledge-base/README.md` | 设计 1-2 h（不含实施） | P1 |
| 2 | **`tools/pre-execute` 拦截顺序无契约**：`security-guard` 在该点拦命令（`security-guard/src/index.ts:72` provide `guard`），官方同点另有 6 个包监听（`dsh-tools` / `dsh-scope` / `dsh-bash-local` / `dsh-tool-bash` / `dsh-tool-jobs` / `dsh-workspace-changes`）；「先于官方策略」只是当前实现事实，无显式顺序契约。期望：确认真实顺序并写入 README（附证据）；若顺序不可依赖，改为不依赖顺序的判定。验收：README 写明顺序依据；结论为「不可依赖」时有对应代码或测试。 | 2026-10-05 插件冲突排查 | `security-guard/README.md`、必要时 `security-guard/src/index.ts` | 1-2 h | P2 |
| 3 | **[进行中]** **TUI `/goal` 与官方命令双注册**：TUI `LOCAL_COMMANDS` 注册 `goal`（`TUI/src/app/commands.ts:261`），官方 `dsh-command-goal` 亦注册 `goal`；本地表经 `routeSlashCommand` 隐式优先，带参时转发宿主，无断言与显式优先级声明。期望：显式化覆盖语义（注释 + 转发断言）或改名避让。验收：官方命令缺失 / 改名时转发有可见降级而非静默失配，补一条测试。 | 2026-10-05 插件冲突排查 | `TUI/src/app/commands.ts`、`TUI/src/app/state.ts`（转发路径） | 30 min | P3 |
| 4 | **[进行中]** **`rule-engine` 与官方 `repeat-tool-reminder` 注入重复度未量化**（**调研已更正前提**）：本条目原写「两者都挂 `agent/pre-step`」——**不成立**：`rule-engine` 不订阅该点，其节点为 session / turn / step / tool 边界 + compaction（`rule-engine/src/engine.ts:110-121`）；官方 reminder 才挂 `agent/pre-step`，默认阈值 `[3,5,8]`。非同点竞争，预算也不互挤（`maxInjectionsPerTurn` 只计本引擎段，`engine.ts:791-805`）。真会话实测（最大 dsh-toolset 会话 2131 条记录）官方 reminder **零触发**、rule-engine 注入 3 次，**未观测到双注入**；局限：只能看见经 `agent/inbox/spliced` 落盘的注入。期望：据实收窄——更正前提并在 README 写明与官方 reminder 的分工。验收：条目前提更正 + 分工口径落 README。 | 2026-10-05 插件冲突排查（观察项 ③ 升为条目）；前提已由本任务调研更正 | `rule-engine/README.md`、`docs/BACKLOG.md`（前提更正） | 1 h | P3 |
| 5 | **[进行中]** **`context-report` 重复折叠官方已有投影**：官方 `session-stats` / `session-turn-outline` 已于 2026-10-02 挂载，本包仍自折叠 turns / 墙钟（`context-report/src/fold.ts:4` 注释自认与 `sessionStats` / `turnOutline` 口径重合）。期望：轮次 / 墙钟 / 大纲改用官方投影，保留 token 与上下文占用口径；先对齐单位与「首 token / decode」口径。验收：轮次 / 墙钟取自官方投影（不再自折叠），`context-report` 单测更新后全绿。 | `docs/ARCHITECTURE-REUSE.md` §4 A 升为条目 | `context-report/src/fold.ts`、`context-report/src/main.ts` | 1 h | P3 |
| 6 | **[进行中]** **`metric-loop` 与官方两套循环机制并存且分工未裁定**（**调研已更正前提**）：官方两条中 `goal-round-driver` 随 dsh-base 挂载；`tool-ralph` 在 base 里是 `disabled: true` 且 fff 无 overlay → **实际未挂载**（`dsh-base/cordis.patch.yml:447-448`，与 `ARCHITECTURE-REUSE.md:28` 口径均需更正）。三方能力对照与「只有 metric-loop 有」的清单已备齐（见追踪文档）。期望：**需用户裁定**——保留本包「指标测量 + 边界停止 + 跨进程状态」并写清边界，或改用官方承担循环、本包只留测量，或维持现状仅书面写明分工。验收：裁定记录 + 落点文档写明分工（或改造完成）。 | `docs/ARCHITECTURE-REUSE.md` §4 C 升为条目（需用户裁定）；前提已由本任务调研更正 | `metric-loop/README.md`、`docs/ARCHITECTURE-REUSE.md` §4 C | 0.5-1 h | P3 |
| 7 | **`metric-loop` 的 `schedule` 续排提示结构性不可执行**：`metric-loop/src/engine.ts:233-234` 返回的续排提示为 `{ after_seconds, prompt }`，而官方 `schedule_create` 的 `title` 是 `required: true`（`dsh-schedule/lib/index.js:2126`）→ 即便挂上 schedule，按该提示调用也会被 `invalid_prompt` 拒绝（`dsh-schedule/lib/types/tools.js:212`）。即当前提示是「看着可调、实则必错」。期望：补 `title`（或对齐其余必填字段）使提示可用，或明确降级为纯文案并去掉「可直接调用」的措辞。验收：提示字段与官方 `schedule_create` 入参 schema 一致（或文档写明降级口径），并补一条断言提示字段的用例。 | 2026-10-05 条目「`metric-loop` 与官方两套循环机制并存」调研中的新发现 | `metric-loop/src/engine.ts`、`metric-loop/README.md` | 15 min | P3 |

**未立项观察项**（暂不单独立项，作为后续可选项）：意图/多策略检索（knowledge-base 已双 FTS5，距 BM25+RRF+proximity 一步）、MCP 脚本化（mcpScript）、活动工具交互管理。

**复用审计产出（`docs/ARCHITECTURE-REUSE.md` §4，未立项）**：B `output-compress` 写清与官方 `spill-policy` / `compaction-tool-result-pruner` 的分工与阈值语义（实测**不存在**双重截断）；D `hash-edit` / `fs-digest` 可选改用 `ctx.fs`（含行为变更：hash-edit 写侧将受 workspace-write 围栏；原「宜与 render 缺陷同批」的前置已随该缺陷关闭归档而失效）；E 「可挂但不该挂」清单一律落非生成型文档（本文件 / `profiles/example` 注释），勿写入会重生成的 `HOST-PACKAGES.md`。观察项：① 是否开启 `session-query-sqlite` 的 FTS5（`openAt: first-search`）并与知识库分工。（A / C 与观察项「共库直写的隐私边界」「与 `repeat-tool-reminder` 的注入重复度」已于 2026-10-05 升为 §2 条目。）

## 3. 里程碑

1. 里程碑一（P0，引擎三块 + 知识库底座）与里程碑二（P1：goal-contract / metric-loop、知识库记忆层与淘汰提升、fan-out 就绪池、hash-edit / ast-tools、security-guard / herdr-integration 等）均已完成。
1. 里程碑三（P1/P2）剩余项即 §2 清单（编号即先后顺序；2026-10-03 起按「依赖 → 优先级 → 工作量」排序，详见 §2 顺序依据），按需排期；已完成项与已取消 / 不再立项项见 §1 索引。
1. 依赖：条目间依赖与用户门见各条正文与 §2 顺序依据；原「近期改动代码审查」能力并入命令模板体系③。

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
