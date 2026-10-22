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

- 知识库与记忆：memory-base（原名 knowledge-base；两张基表 + 两张 FTS5 虚表、持久记忆 CRUD、**入库规则与隐私 / 容量边界**、**自动巩固**（提升 / 合并 / 淘汰，启动后与 compaction 后触发）；**分层记忆系统**：S / P / U 三库 + 一库一指纹、写入闸门下沉库核心、`project` 派生链、容量寿命控制——实施批次 13 条中 8 条已提交（`a81da69` / `0652866` / `55c6382` / `270b2df`），余 5 条见 §2）、output-compress、fs-digest（追踪文档 `docs/archived/2026-10-07-knowledge-memory-lifecycle.md`，前身 `docs/archived/2026-10-02-knowledge-events-and-memory-consolidation.md`）；

- 代码与文件：hash-edit、ast-tools、code-map 报告与影响面、结构层索引与候选调用图 + LSP 语义层（callers 的 findReferences 精确裁决，`precision:lsp/structural`；追踪文档 `docs/archived/2026-09-29-codemap-lsp-semantic.md`）；

- 上下文报告：context-report（host-only 投影 `sessionContext` 只折 token 分桶；回合 / 步 / 墙钟读官方 `sessionStats` 投影，2026-10-06 去重 + `context_report` 三档报告）；

- 安全与集成：security-guard 策略层、herdr-integration、herdr-use（把 herdr pane 当可控伪终端层驱动交互式命令：13 个动作（pane 类 `pane_` 前缀 + tab 三动作）与会话 ↔ workspace 内部绑定 + `herdr_use` 工具 + 库面，CLI 为主、`pane_read` / `stable` 走 socket；追踪文档 `docs/archived/2026-10-16-herdr-pane-design.md`）；

- 规则触发与符号规范：rule-engine、TUI 符号规则迁移（落点为 symbol-normalizer 插件）、next-step 注入路径、仓库级集成、注入消息呈现（**不带** `source.form:'notice'`：TUI 按用户输入块显示、正文以 `[RULE] ` 前缀标明自动注入）、消费者框架（`registerConsumer` + `evaluate`）、symbol-normalizer 插件；真机验证记录见 `docs/archived/2026-09-27-rule-engine-consumer-and-integration.md`；

- TUI：/workflows 面板、/council、/search 多 provider 聚合、声音提醒，以及 7 项纯 TUI 命令与 A1-A5（`/task` `/guard` `/memory` `/loop` `/contract`）；

- 工程流程与文档：文档体系与变更规范落地（追踪文档 `docs/archived/2026-09-25-docs-workflow-rollout.md`）、`TUI/docs/IMPLEMENTATION.md` 拆分删除（命令/机制 → `TUI/docs/DESIGN.md`「实现要点（机制与命令）」、渲染/排版 → `TUI/docs/SPEC.md` §15、验证 → `TUI/README.md`；追踪文档 `docs/archived/2026-09-29-tui-implementation-doc-split.md`）、根 README 英文化（英文主档 `README.md` + 中文版 `README.zh.md`，`AGENTS.md` 语言约定例外与口径同步；追踪文档 `docs/archived/2026-09-30-readme-i18n.md`）。

- 运行时与宿主：宿主双栈兼容垫片清理（0.1.7-rc.2 单一形态；追踪文档 `docs/archived/2026-09-29-host-single-stack-cleanup.md`）、tmux 断连后 dsh 退出 → 退出前问题面板确认（追踪文档 `docs/archived/2026-09-29-exit-confirm-panel.md`）、跨会话消息通道 `session-channel` 插件（专用 Redis 实例 + unix socket；追踪文档 `docs/archived/2026-09-29-cross-session-intercom.md`）、跨会话共享 KV（session-channel 服务面扩展，last-value + 版本号；追踪文档 `session-channel/docs/archived/2026-09-29-shared-kv.md`）、会话标题参考窗口改为「最近一次 `git commit` 之后」（新包 `session-title-cutoff`，接管 `ctx.sessionTitle` 唯一 provider；追踪文档 `session-title-cutoff/docs/archived/2026-09-29-title-cutoff-provider.md`）、跨会话委托/协调（`session-channel` 任务语义：任务表 + 结果自动/显式回传 + `channel_delegate`/`channel_task`/`channel_task_result` 三工具；追踪文档 `docs/archived/2026-09-30-cross-session-delegation.md`）、模板体系（`command-template`：预案 `/playbook` 统一入口 + 五族模板 + 双源目录 + 模板级模型选择；追踪文档 `docs/archived/2026-09-30-template-system.md`）。

- 已取消/不再立项：rate-guard（不实现，pi 侧已移除，dsh 侧由官方 `llm-retry` 覆盖，见 `archive/PI-DSH-FEATURE-COMPARISON.md` §5.1）；GitHub 仓库克隆、PDF 提取 / 视频理解、密文扫描、安全 issue 上报（用户 2026-09-29 裁定移除，不立项）；近期改动代码审查、preset 机制迁移评估（用户 2026-09-29 裁定直接关闭，不立项）；模型请求路由与速度控制 `llm-router`（2026-10-11 判定不改仓内插件，采用现成开源网关 —— 主选 Bifrost、备选 LiteLLM，见 `docs/archived/2026-10-11-llm-router-decision.md`）；Docker 交互插件（用户 2026-10-19 裁定不做，条目已从 §2 删除）。

- 宿主面知识：官方 **0.2.0-rc.2 对照汇总**（`docs/host/HOST-UPGRADE-0.2.0-rc.2.md`；工具 / 事件 / 服务面零增删，`docs/host/HOST-PACKAGES.md` 同期刷到 0.2.0 口径，审阅记录见 `docs/archived/2026-10-02-host-upgrade-0.2.0-rc.2.md`）。

- `md-map`：新建第 19 个插件包（文档版 `code-map`：标题锚点 / 跨文档链接 / wiki / 代码文件引用 / 被引计数，查询 `callers` / `impact` / `orphans` / `report`；单文件解析复用 `md-logic`；36 例测试；追踪文档 `docs/archived/2026-10-02-md-map-package.md`）。

- `script-interpreter`：新建插件包（模型侧脚本解释器：`script_run` 单次执行 Python，脚本经 stdin 送入不落临时文件；围栏走 `ctx.sandboxPolicy` + `ctx.sandbox`，可选服务经 `ctx.get` 受保护读取、能力缺失如实标注；审批缺省关闭，`approval: ask` 走宿主审计对；超限保留尾部 + 全文落盘 0600；73 例测试；追踪文档 `docs/archived/2026-10-16-script-interpreter-design.md`）。

- command-template 终态与回收：`playbook` 等命令的子代理步骤改为**与取消信号竞速**（`start` 与宿主结算面都在竞速内），abort 路径**发起但不等待**回收（宿主 in-process `dispose()` 内部 `await run.result`，等它等于换个地方无界等待）；修掉真机「命令悬挂、无 `command/done`」的根因面（本仓侧任何路径都回终态，文案区分「被调用方取消」/「步骤超时（N ms）」并带子会话 id）；19 例测试（含宿主语义 dispose / start 悬挂 / 迟到 reject 三个回归点），全仓 20 包全绿（追踪文档 `docs/archived/2026-10-02-command-template-terminal-state.md`）。

- task-engine 计量口径（usage → 权威信号）：subagent 用量改读宿主 `tokenUsage` 投影（`sessionProjections.stateOf`＝provider 上报的**累计**输出 token；尚无样本 / 服务缺失 / 抛错时回退 `tokenMeter` 的 pressure 口径），**超预算判定改用宿主权威信号** `stopReason === "max-tokens"`——不做 tokens 数值比较（审阅用真实会话日志回放 12 个 spawn 子会话：totals 6–81,955 vs 实际预算 256/512/4000，数值比较会 10/12 恒真）；72 例单测 + `smoke:executor` 扩 4 条断言，全仓 20 包全绿（追踪文档 `docs/archived/2026-10-02-task-engine-usage-metric.md`）。

- `md-logic`：新建第 18 个插件包（Markdown 逻辑结构：节树 + 块 + 链接清单，带行范围；解析用 `marked` 真实 CommonMark），注册模型侧工具 `md_logic`（structure / blocks / links）并与 `fs_digest` 双向指路；接线 9 处（含补齐根 check/build 链与 test-parallel 的既有漏项）；34 例测试 + 全仓 19 包全绿（追踪文档 `docs/archived/2026-10-02-md-logic-package.md`）。

- `ast-tools` 模型侧工具：注册 `ast_query`（action 分派：search / outline / rules，AST 形态与元变量捕获）与 `ast_replace`（默认 dry-run，写回需 `write:true`）；缺 ast-grep 二进制时注册降级版（调用返回含安装指引的 error）；模型侧行号渲染为 1 基，描述里写明与 `grep` / `glob` / `fs_digest` / `code_map` / `hash_edit` 的选择成本（追踪文档 `docs/archived/2026-10-02-ast-tools-model-tools.md`）。

- Markdown 结构视图：`fs_digest` 的 Markdown `outline` 现在给**每节行范围**（含端点、尾空行不计、父子包含）与**块级结构清单**（list / table / code / quote / frontmatter，带 `§L{节}` 归属）；标题树 45 行 + 块清单 15 行两个独立预算；`scanMarkdown` 为 `src/outline.ts` 的**模块级导出**（未透出包入口，`md-logic` 仅对齐口径、无 import 依赖，2026-10-04 复核更正）（追踪文档 `docs/archived/2026-10-02-markdown-structure-view.md`）。

- 复用审计：官方包与本仓 18 包逐项对照的「改用 / 保留 / 并存」结论（**改用 0 / 保留 12 / 并存 6**）与 5 项改造点，见 `docs/ARCHITECTURE-REUSE.md`（追踪文档 `docs/archived/2026-10-02-reuse-audit.md`）。

- profile 挂载面：**扩张到 base + 本仓插件 + 10 个官方行**（2026-10-02：`session-stats` / `session-turn-outline` / `session-reference` / `message-feedback` / `workspace-changes` / `file-reference-local` / `terminal` / `terminal-bash` / `invariants` / `workspace`；全部为投影 / 服务 / 事件面扩展，排除口径与第二批选题见 `docs/archived/2026-10-02-profile-mount-expansion.md`）。

- 宿主运行基线：**已升到 `dsh 0.2.0-rc.2`**（2026-10-02：全局安装 + profile 树外加装包 `session-title-all-prompts-llm` 同步 + `scripts/install.sh` 默认版本 + 主要版本引用（含 5 个包 smoke 脚本的宿主门槛）；进程外与进程内验证见追踪文档 `docs/archived/2026-10-02-host-upgrade-execution.md`）。

- install.sh 四条硬化：`.bak` 堆积（内容未变不写不备份）、profile 树外官方插件版本检查、收尾 `--dump-config` 自检（`--skip-verify`）、头注释口径 + 接线一致性校验；新增 `scripts/test-install.sh`（49 例；追踪文档 `docs/archived/2026-10-03-install-sh-followups.md`）。

- goal 状态行补 `activation`（`⟳` 自动续轮开关）：宿主**进程本地**事件 `goal/activation-changed` → `goalActivationBySession`（末条边、按会话隔离、不落盘）+ 展示值 `activeGoalActivation`（仅 `phase === "active"`、无记录 → `disarmed`）；head 行改 `Goal <符号> <phase>`（`▷` active 绿 / `∥` paused 黄 / `△` blocked 黄（**由红改黄**）/ `✓` complete 绿）+ 尾随 `⟳`（armed 绿 / disarmed 灰），`resumeTo` 补清空边（宿主 resume 经 `sessions.prepare` 重建 Session，activation 归 disarmed 且同值早退不发边）；7 例新用例（重启回归 / 边序无关 / 端到端帧断言），两轮子代理审阅修订（陈旧 armed、SPEC 口径矛盾、宽度表条目登记），反向验证撤符号渲染 → 7 例红（追踪文档 `docs/archived/2026-10-04-tui-goal-activation-symbol.md`）。

## 2. 未完成项

> 顺序依据：**修复类优先 → 依赖深度升序 → 工作量升序**（2026-10-18 用户裁定「修复类的放前面」，在此之前为依赖深度 → 工作量）；同工时任「缺陷优先于行为改动 → 高优先级优先 → 保持原相对顺序」。前置关系另写在各条行内与「实现顺序」表。模块级条目按标题 + 文件路径引用（如 `md-logic/docs/BACKLOG.md`）。优先级：P0 > P1 > P2 > P3。
> 2026-10-08：**§2 已清空**——全部条目（分类注册、闸门下沉、派生链、文档索引、提升链 I → S → P → U、TUI 侧改造、output-compress 自持 `digest.db`）完成并关闭；过程记录见 `docs/archived/2026-10-07-knowledge-memory-lifecycle.md`（完成后归档 `docs/archived/`）。后续可选项见下方「后续补条目候选 / 未立项观察项 / 复用审计产出」。
>
> 2026-10-14：新增条目 1（检查回复正文表格列数一致性的新插件，条目正文见下）。
> 2026-10-15：新增条目 2（后台常驻守护机制的设计，条目正文见下）。
> 2026-10-15：条目 1（检查回复正文表格列数一致性的新插件）完成并关闭 —— 新建包 `md-table-check`（第 21 个插件），追踪文档归档 `docs/archived/2026-10-15-md-table-check.md`；编号按当前顺序重排（原条目 2 → 1）。
> 2026-10-16：条目 2（助手正文「三面一致」核对）完成并关闭 —— 追踪文档归档 `docs/archived/2026-10-16-three-surface-text-consistency.md`; 核对结论: 2 个缺陷登记到 `rule-engine/docs/BACKLOG.md`（超长截断漏检 / replace 语义不一致）, 1 条宿主依赖写入 `rule-engine/README.md`（每回合必须发 `turn/start`）; 编号按当前顺序重排（无待办条目变化）。
> 2026-10-16：新增条目 2（自动审批插件，用户意向，条目正文见下）；原条目 2 已关闭，编号按当前顺序重排（原条目 2 → 1；后续新增条目以此类推）。
> 2026-10-16：**§2 重新排序并重编号**（用户指示「重新排序」；依据仍为工作量升序，同工时缺陷优先于行为改动 → 高优先级优先 → 保持原相对顺序）：原 1-8 → 新 1-8 映射为 1→1 / 2→2 / 3→3 / 4→4 / 7→5 / 5→6 / 8→7 / 6→8；正文内条目间引用（「条目 N」）已同步改为新编号；上一条目的「待细化」与依赖注记随行保留。
> 2026-10-16：接取 5 条（自动审批插件 / 脚本语言解释器插件 / 基于 herdr 的交互式命令扩展 / 偏好分析 / 同事模型群组的编排协议）并标〔进行中: 2026-10-16〕（用户指示：先在 BACKLOG 标进行中，再分 worktree）。
> 2026-10-17：新增条目 9 / 10 / 11（读完五份新插件设计文档后补的跨包项：仓库清单与包计数统一、§5 herdr 取证指向修正、条目 5 的〔进行中〕标记核正），按追加顺序编号，待下次整理重排；同日按「需要变更的模块各自登记」新建 `security-guard/docs/BACKLOG.md` 与 `memory-base/docs/BACKLOG.md`、在 `session-channel/docs/BACKLOG.md` 补一条功能条目。
> 2026-10-18：条目「自动审批插件（工具调用的审批链自动裁定）」**完成并关闭** —— 新建包 `auto-approve`（第 22 个插件），过程记录与证据归档 `docs/archived/2026-10-16-auto-approval-design.md`；已从 §2 条目正文与「实现顺序」表清理。其余条目编号未重排（编号仅供阅读，留待下次整理统一）。
> 2026-10-18：条目「`output-compress` 接入 memory-base 作用域句柄（`promote` 取消后的 I→S 推送路径重定）」**完成并关闭** —— 过程记录与证据归档 `docs/archived/2026-10-17-output-compress-scope-handle.md`；已从 §2 条目正文与「实现顺序」表清理，真机验证与 smoke 脚本更新另立条目（现为本节第 2 条）。其余条目编号未重排（编号仅供阅读，留待下次整理统一）。

> 2026-10-18：**§2 整理**（清理重复与逻辑矛盾）：关闭并移出 10 条 —— 自动审批插件 / 脚本语言解释器插件 / 偏好分析 / 同事模型群组的编排协议 / 五个新插件落地时的清单与计数统一 / 修正 §5 取证指向 / 核正 Docker 条目标记 / 修正脚本解释器设计文档表述 / 新增 `session-paths` 插件 / 重复的 Docker 条目（关闭记录见各自追踪文档与 git 历史）；编号按当前顺序从 1 重排。
> 2026-10-18：条目「插件文档事实校正、去重与精简（29 个模块的文档一致性）」**完成并关闭** —— 追踪文档归档 `docs/archived/2026-10-18-plugin-docs-refresh.md`；遗留项见本节「后续补条目候选」。
> 2026-10-19：Docker 交互插件按用户裁定不做，条目已从 §2 删除（取消记录见 §1「已取消 / 不再立项」）；编号按当前顺序重排（原条目 3 → 2）。
> 2026-10-19：原「复用审计产出（未立项）」改为编号条目 3「重新审计：本仓插件与官方包的复用关系」—— 旧审计过时（2026-10-02 基线仅入表 22 模块、7 包未审，其后又有新包与变更），原 §4 B / D / E 与 FTS5 观察项并入重审范围。
> 2026-10-19：新增条目 4「检查官方 deepseek-harness 更新（新 rc 版本与接口约定变动）」—— 用户要求核查官方是否有新 rc 及工具 / 事件 / 服务面约定是否变动。
> 2026-10-19：接取 4 条并标〔进行中: 2026-10-19〕（background-daemon 真机验证 / 新增定时插件 / 重新审计 / 检查官方更新），每条各一份追踪文档：`docs/implementation/2026-10-19-background-daemon-verification.md` / `2026-10-19-timer-plugin.md` / `2026-10-19-reuse-reaudit.md` / `2026-10-19-dsh-update-check.md`。
> 2026-10-19：新增条目 5「模型按需检索 notice 历史原文（compaction 后取回）」—— 来源：TUI 任务「允许模型查看 notice 信息」的调研结论（模型实时已可见 notice 原文，缺口仅在压缩出保留尾段后的按需取回；见 `TUI/docs/implementation/2026-10-19-notice-model-view.md`）；按追加顺序编号，待下次整理重排。
> 2026-10-19：条目「新增定时插件（统一 timer 原语）」完成并关闭（追踪文档归档 `docs/archived/2026-10-19-timer-plugin.md`），条目从本节移除；其余包裸定时器接入统一面记入候选。
> 2026-10-20：条目「background-daemon 真机验证（已挂载，发现 timer 适配缺陷）」**完成并关闭** —— 追踪文档归档 `docs/archived/2026-10-19-background-daemon-verification.md`；四条端到端真机各一次通过（E1 文本投递 / E2 命令执行 / E3 重启恢复含启动补发复验 / E4 skipped）；E5 `records: memory` 与 tasks.json 多实例共享覆盖按主分支最终裁定**本期不修**，分别登记为新条目 5 / 6，原条目从本节移除。
> 2026-10-20：新增条目 5「background-daemon E5：memory 底座取不到（严格模式 readService 需可选注入 / 惰性解析）」与条目 6「background-daemon tasks.json 多实例共享整文件覆盖（明确单实例边界或加锁合并）」—— 来源：「background-daemon 真机验证」收尾移入；按追加顺序编号，待下次整理重排。
> 2026-10-20：接取 —— 条目 3「检查官方 deepseek-harness 更新」由主会话承接（延续其〔进行中〕状态）；条目 5 / 6 按二次裁定绑同一分支（background-daemon）一并接取，修法以条目 5 已丢弃原型为基（可选注入 / 惰性解析），任务表迁 memory（SQLite, 库级锁）后条目 6 覆盖竞态随之消除、验收并入条目 5。
> 2026-10-20：二次裁定 —— 条目 2「重新审计」与条目 3「检查官方更新」**绑同一任务一并处理**（用户指定）：以条目 3 的最新基线口径（升级则 0.2.1-rc.2）重跑复用审计, 对照记录与审计共用基线。
> 2026-10-20：条目 2「重新审计：本仓插件与官方包的复用关系」**完成并关闭** —— `ARCHITECTURE-REUSE.md` §0 总表全量 29 行（7 个缺审包补齐），结论分布改用 0 / 保留 21 / 并存 8；§4 的 B 已执行、D / E / FTS5 观察项明示关闭；基线维持 0.2.0-rc.2，升级回查门随升级流程后置（见归档追踪文档）。条目从本节移除。

> 2026-10-20：条目 3「检查官方 deepseek-harness 更新」**完成并关闭** —— 调研产出 `docs/host/HOST-UPGRADE-0.2.1-rc.2.md`（官方最新 `0.2.1-rc.2`, 2026-10-17；26 消费包类型名只增无删，`ToolExecution` / `sessions` / `sandboxPolicy.resolve` / `llm` 定点零 diff；1925 提交）；升级裁定与复用审计续作并入条目 2（绑同任务）。条目从本节移除。

> 2026-10-20：条目 5「background-daemon E5：memory 底座取不到（严格模式 readService 需可选注入 / 惰性解析）」与条目 6「background-daemon tasks.json 多实例共享整文件覆盖（明确单实例边界或加锁合并）」**完成并关闭** —— 追踪文档归档 `docs/archived/2026-10-20-bgdaemon-memory-backend.md`：memory 底座经 `ctx.inject` 子分叉晚挂挂载, 任务表迁入 memory(SQLite), tasks.json 停写, 覆盖竞态消除；真实挂载确认通过。条目从本节移除。
> 2026-10-20：条目「模型按需检索 notice 历史原文（compaction 后取回）」**完成并关闭** —— 承载 TUI 包内, 模型侧工具 `notice_history` 读宿主持久日志（多帧 zstd 解压）按需取回被折叠的 notice 原文（最近 N + `source.kind` 过滤, 会话非法 / 目录未定位 / 日志缺失三态报错, 纯只读不落库）; 追踪文档归档 `docs/archived/2026-10-20-notice-history-query.md`; 真实 fff profile 注册面待主分支合并后复验。条目从本节移除。

> 2026-10-20：条目「agent 状态检查（待机 / 工作 / 卡死, 跨进程状态牌）」**完成并关闭** —— session-channel 发布 / 读数面（dsh/session-channel 分支）+ agent-group 消费端（判据③ + 2b 组长轮询 + close_group, dsh/agent-group 分支）全部落地并随主分支合并; 追踪文档归档 `docs/archived/2026-10-20-agent-status-board.md`; 真机 ≥2 会话四态（待机 / 工作 / 疑似卡死 / 离线）+ 心跳不刷 at + 离线不依赖对端全部通过; 同任务「轮次与终止的三个细节（#4）」按裁定落地组关闭语义, rounds 追踪文档归档 `agent-group/docs/archived/2026-10-19-agent-group-rounds.md`。条目从本节移除。

> 2026-10-20：新增条目 1「工具咨询插件（按需揭示工具, 避免模型记忆大量工具名）」—— 用户提出的新插件构想, 设计讨论中未定稿, 等用户指令继续设计。

> 2026-10-22：新增条目 4「herdr-pane 插件与工具改名」—— 用户指出该包能力面已扩到 tab 与会话 workspace 绑定, 旧名不再贴合; 新名由用户自定 `herdr-use`（工具 `herdr_use`）; 条目已接取（编号按追加顺序, 待下次整理重排）。

**4. herdr-pane 插件与工具改名（`herdr-pane` / `herdr_pane` → `herdr-use` / `herdr_use`）**〔进行中: 2026-10-22〕（2026-10-22 登记, 来源: 用户指出该包能力面已扩展, 旧名不再贴合）：**现象 / 现状** —— 包名 `@dsh-toolset/herdr-pane`、插件 id `herdr-pane`、模型侧工具 `herdr_pane`、目录 `herdr-pane/` 仍按「pane」命名, 而工具面已是 13 个动作（pane 读写 + `tab_create` / `tab_list` / `tab_close` + 会话 ↔ workspace 内部绑定）。**期望** —— 全量改名: 目录 `herdr-use/`、包名 `@dsh-toolset/herdr-use`、插件 id `herdr-use`、工具 `herdr_use`、导出符号 `HerdrPane*` → `HerdrUse*`; 现行代码 / 测试 / 文档 / profile 挂载同步, 归档文档保留旧名。**优先级** —— P2。**状态注记** —— 已接取, 追踪文档 `docs/implementation/2026-10-22-herdr-use-rename.md`。

**5. tab_create 之后不必再建 pane（临时寄存于项目级, 待改名任务完成后回注模块）**（2026-10-22 登记, 来源: 用户实机使用发现）：**现象 / 现状** —— `herdr tab create` 建 tab 时 herdr 已默认开好一个 pane, 插件也读回来了 (`src/actions.ts:542-568` 取 `.result.root_pane.pane_id`, 登记并作为回执 `pane_id` 返回), 但工具描述只写「tab_create 建 tab」(`src/tools.ts:283`、`:324`), 没有说明这个 pane 可直接用于 `run` / `send_text` / `read`; 实际使用中出现先 `tab_create` 再 `create`, 同一个 tab 里多出一个 pane。**期望** —— 工具描述与 `tab_create` 回执写明「新 tab 自带 root pane, 回执里的 `pane_id` 就是操作目标, 无需再 `create`」; `create` 的描述补一句「在活动 pane 上切兄弟 pane, 刚建完 tab 时不必调用」。**优先级** —— P2。**状态注记** —— 未接取; 本属模块级条目, 因改名任务正在挪动 `herdr-pane/` 目录, 先临时寄存在本节, 待改名完成后移入 `herdr-use/docs/BACKLOG.md`（届时动作名按 `pane_*` 口径）。

**1. 工具咨询插件（按需揭示工具, 避免模型记忆大量工具名）**（2026-10-20 登记, 来源: 用户提出的新插件构想, 设计讨论中未定稿）：**现象 / 现状** —— 模型工具面全量暴露, 需记忆大量工具名且全程占用上下文; 没有「描述功能需求 → 返回可用工具」的按需发现入口。**期望** —— 新插件提供「工具咨询」: 模型描述要用的功能 → 插件返回匹配工具（名称 + 简述）并使其对当前会话可见（`tools.restrict` 遮罩 + 单条活动 mask 替换揭示）; 咨询工具本身常驻可见（own-layer 注册豁免 restrict）; 待定项: 初始可见集、匹配方式（关键词索引 vs LLM 语义）、揭示与收回语义。**优先级** —— 待定（设计未定稿）。**状态注记** —— 未接取, 等用户指令继续设计。

**3. docs/ARCHITECTURE-REUSE.md 的模块口径随 behavior-correction 加包同步**（2026-10-22 登记, 来源: `docs/implementation/2026-10-21-behavior-correction.md` 实施时发现）：**现象 / 现状** —— 该文件多处写「本仓 29 个模块」「已审计 29 个全量」，新增 `behavior-correction`（第 30 个插件）后少 1；本次任务清单只含 `AGENTS.md` 与根 README，未改该文件。**期望** —— 模块总数改成 30、「已审计 / 未入表」口径与 22 条审计行一致（新增包未入表）。**优先级** —— P2。**状态** —— 未接取。

**后续补条目候选**（随 TUI 侧改造条目产出记录）：`/memory replace|remove` 子命令（`forget` 服务面已就绪、全仓无调用方——错误 U/P 条目的唯一删除路径）。**未立项观察项**（暂不单独立项，作为后续可选项）：意图/多策略检索（memory-base 已双 FTS5，距 BM25+RRF+proximity 一步）、MCP 脚本化（mcpScript）、活动工具交互管理。 **2026-10-18 文档整理遗留**（未立项）：① `TUI/docs/DESIGN.md` 仍有约 15 处 `TUI#n` 旧任务编号（属历史溯源, 需按标题改写）；② `scripts/test-parallel.sh:8` 注释「11 包子包测试各自独立」与现状 30 包不符；③ `docs/ARCHITECTURE-REUSE.md` 的 8 个包（`herdr-use` / `md-table-check` / `background-daemon` / `preference-analysis` / `session-paths` / `script-interpreter` / `agent-group` / `behavior-correction`）待补审计行；④ `agent-group/src/main.ts:6-8` 头部注释仍写「任一不可用 → 不注册工具」, 与代码实况（工具照常注册、调用期报错）不符；⑤ 用户 profile（`~/.dsh/profiles/fff`）里 output-compress 的过渡 `sessionDir` 行待删（工作区外只读, 需在有写权限的环境执行）。 另一项：其余有裸定时器 / 自行排期的包（`herdr-integration` / `herdr-use` / `script-interpreter` / `rule-engine` / `preference-analysis` / `task-engine` / `auto-approve` / `ast-tools` / `command-template` 及 TUI 内部其它定时器）可选接入定时器统一面 `clock`（由 timer 插件提供；本期明确不做）。

### 实现顺序（2026-10-18 重排：修复类 > 依赖深度 > 工作量）

排序：**先修复类，再按依赖深度升序，同深度按工作量升序**；条目一律按标题引用。

| 顺位 | 条目 | 深度 | 工作量 | 前置（顺位） |
| --- | --- | --- | --- | --- |

单线程约 **0.5 至 1 天**（本条待估）。

## 3. 里程碑

1. 里程碑一（P0，引擎三块 + 知识库底座）与里程碑二（P1：goal-contract / metric-loop、知识库记忆层与淘汰提升、fan-out 就绪池、hash-edit / ast-tools、security-guard / herdr-integration 等）均已完成。
2. 里程碑三（P1/P2）剩余项即 §2 清单（排序依据见 §2「顺序依据」与「实现顺序」表；实际开工顺序以表为准），按需排期；已完成项与已取消 / 不再立项项见 §1 索引。
3. 依赖：条目间依赖与用户门见各条正文与 §2 顺序依据。

## 4. 插件规划（未建包）

> 每个插件 = 本仓库一个包目录（以现有包为模板：`package.json` 的 `dsh.bundle` + `cordis.patch.yml` 集成契约）；命名按功能自定，不沿用 pi 插件名。已建插件与其承载清单项见 `STATUS.md`。

| 插件 | 承载清单项 | 复用（不新建） |
|------|-----------|----------------|
| 内容资产（非插件） | 模板体系③ | workflow 脚本 + skill 内容 |
| behavior-correction（暂定名） | §2 条目 2（该用专用工具却走 shell 的拦截与指路） | rule-engine 消费者 guard 面 + 自带轻量匹配器（关键词 / 正则） |

## 5. TUI 侧

→ 已迁至 `TUI/docs/BACKLOG.md`（TUI 的变更优先写 TUI 文档）：命令扩展状态、排版与交互开放项都在那里（herdr pane 外部问题的取证见 `TUI/docs/STATUS.md` 与 `TUI/docs/archived/2026-09-27-herdr-pane-size-external-issue.md`）；本清单只维护跨包功能项。

## 6. 挂起（未来计划，暂不接取）

> 用户裁定挂起、暂不接取；**保留调研结论备查**，避免以后重复排查。每条写明恢复条件；恢复后再挪回 §2 并重新排序编号。

### DeepSeek 账号路由 `deepseek-account`

**挂起裁定（2026-10-06，用户核实）**：账号登录（浏览器 PKCE）**仅桌面版（Desktop）支持**；**Linux web / CLI 只支持 API key**。本项目当前形态（TUI + Linux）落在后者，故 `deepseek-account` 不可用，且非本项目可解。**恢复条件**：官方在 Linux web / CLI 开放账号登录，或本项目改用 Desktop 版。

**已同步卸载登录链（2026-10-06）**：本机 fff profile 用户层 patch（`~/.dsh/profiles/fff/cordis.patch.yml`）与仓库模板 `profiles/example/cordis.patch.yml` 均新增两条 `- id: <条目>` + `disabled: true`：`deepseek-account`（`dsh-deepseek-account-platform`，PKCE 登录 + `/oauth/callback`）与 `llm-deepseek-account`（账号 LLM 路由，未登录恒空目录）。**影响面已核**：`ctx.deepseekAccount` 在本 profile 内的消费者只有后者与 `web-search-deepseek`（仅当会话 provider 为 `deepseek-account` 时才取账号 token，见其 `resolveAccountToken` 的 `ACCOUNT_PROVIDER` 判定）→ 禁用后 web 搜索回落 `resolveApiKey`，无回归。**验证**：`dsh --profile fff --dump-config` 输出里两条均带 `disabled: true`（2026-10-06 实测）。桌面版部署需删掉这两条。

**已查证结论（备查，2026-10-06）**：官方两条路由 = `deepseek-official`（API key，`@deepseek-ai/dsh-llm-deepseek-api-key`，`lib/index.js:36` `PROVIDER = "deepseek-official"`，走 `x-api-key`）与 `deepseek-account`（账号，`@deepseek-ai/dsh-llm-deepseek-account`，`:11`，走 `x-dsh-auth-token`）。**两条插件行都已挂载**（`dsh-base/cordis.patch.yml:522-529`；组合树 dump `tmp/hostdoc-020/dump-020.yml:761-764`，0.2.0-rc.2 + fff profile），所以“没接入”**不是挂载问题**，缺口在登录通路：① 该 provider 只从 `ctx.deepseekAccount.resolveToken(baseURL)` 取 token（`lib/index.js:16-20`），拿不到抛 `ACCOUNT_SIGN_IN_REQUIRED`，且未登录时 `discoverModels` 返回**空目录**（`:49-56`）→ 模型选择器里无模型；② `ctx.deepseekAccount` 由 `@deepseek-ai/dsh-deepseek-account-platform`（base 行 id `deepseek-account`）提供，登录走浏览器 PKCE，`startSignIn` 内部 `this.ctx.get("webServer")`，**无 webServer 直接抛 `PlatformAuthError("protocol")`**（`:950-953`）并需注册 `/oauth/callback`（`:970`）；③ fff profile 不挂 host-webserver；④ 凭据库无账号 grant（`~/.dsh/.credentials.yaml` 仅 `client-connection/browser-session` 一条）；⑤ 现成登录入口只有 Web / Desktop 面（`dsh-api-account-controller` + `dsh-client-ui-settings-account`，即 `dsh-web-app` bundle 的 `ui-settings-account` 行），TUI 侧 grep `account` / `login` 零命中。
**若将来恢复**，原候选路径不变（懒 → 重）：① 用带 Web UI 的 profile 登录一次 → grant 落共享的 `$DSH_HOME/.credentials.yaml`（`dsh-credentials-local`）→ 回 TUI 即用（约 10 min）；② profile 自足（加 `@deepseek-ai/dsh-host-webserver` + 一个能触发 `authorization` 流的调用方；注意非 desktop profile 下 `desktopPlatform` 为 null → `x-client-platform: web`，回调 origin 需浏览器可达，含 SSH 转发端口）；③ 仅把 `ACCOUNT_SIGN_IN_REQUIRED` 渲染成可读提示（`turnEndNotice`，`TUI/src/app/adapter/dsh.ts:478-511`）。
**宿主侧依据**：`dsh-llm-deepseek-account/lib/index.js`、`dsh-llm-deepseek-api-key/lib/index.js`、`dsh-deepseek-account-platform/lib/index.js` 与 README（`desktopPlatform` / `webServer` / callback origin 口径）、`dsh-base/cordis.patch.yml`、`tmp/hostdoc-020/dump-020.yml`。

> 2026-10-22 关闭：「新插件 behavior-correction（暂定名：该用专用工具却走 shell 时拦截并指路）」已完成并**从本清单移除** —— 追踪文档归档为 `docs/archived/2026-10-21-behavior-correction.md`。真机验收（合并后另起新会话、profile 挂载本包）：`bash` 跑 `herdr pane list` 与 `echo herdr` 均被拒，回执指向 `herdr_pane`；`ls -la` 放行；活动区两条 `[rule-engine] warn: 消费者 "behavior-correction" 拒绝工具 bash`。包内 24 例（+1 skip）、全仓 check/build 通过；真机发现并修正一处缺陷（`inject` 升为 `["ruleEngine"]`，提交 `5abd190`）。
