# 待开发功能清单

> 职责：待办全集：缺陷 + 功能 + 里程碑 + 插件规划
> 不负责：现状描述（见 `docs/STATUS.md`）
> 过期条件：无

> 本清单只列**未完成**项；已完成项见 `STATUS.md` 状态表（实现与验证证据在各包源码/测试与 git 历史；已完成的实施清单归入 `archive/`），不在此重复。
> 设计依据：`docs/host/AGENT-ARCHITECTURE-ANALOGY.md`（架构与接口对照）、`archive/PI-DSH-FEATURE-COMPARISON.md`（pi→dsh 迁移基线差距，归档调研）。实现时以根目录 `docs/host/DSH-CTX-API.md` 对齐宿主接口。
> 基线：dsh `0.2.1-rc.2`（2026-10-21 升级；对照见 `docs/host/HOST-UPGRADE-0.2.1-rc.2.md`，上一步 `0.2.0-rc.2` 见 `docs/host/HOST-UPGRADE-0.2.0-rc.2.md`）。
> 编号口径：`#N` **仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**（不保证稳定，勿作跨引用）；与其它层 BACKLOG 的编号互不关联，跨层引用须写明文件路径。
> 优先级：**P0** 架构主线；**P1** 核心体验补齐；**P2** 长尾。状态标记：`[x]` 已实现（仅第 1 节索引使用）、`[~]` 部分实现（注明未含部分）、无标记 = 未实现。

## 1. 已完成索引

`[x]` 已实现并合入 main，落点如下（单测数与首版边界见状态表）：

- 任务控制：task-engine（Frame 状态机、工具族、双重门禁、RET 三级路由、step 裁决、**叶子执行后端**：`executor` 声明 + `task_execute` 工具 + `subagent` / `workflow` / `command` 后端 + 用量计量，追踪文档 `docs/archived/2026-10-02-injection-timing-naming-warn-executor.md`）、fan-out 就绪池、goal-contract、metric-loop；

- 知识库与记忆：memory-base（原名 knowledge-base；两张基表 + 两张 FTS5 虚表、持久记忆 CRUD、**入库规则与隐私 / 容量边界**、**自动巩固**（提升 / 合并 / 淘汰，启动后与 compaction 后触发）；**分层记忆系统**：S / P / U 三库 + 一库一指纹、写入闸门下沉库核心、`project` 派生链、容量寿命控制——实施批次 13 条全部关闭：前 8 条提交 `a81da69` / `0652866` / `55c6382` / `270b2df`，余 5 条于 2026-10-08 关闭）、output-compress、fs-digest（追踪文档 `docs/archived/2026-10-07-knowledge-memory-lifecycle.md`，前身 `docs/archived/2026-10-02-knowledge-events-and-memory-consolidation.md`）；

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

- 复用审计：现行结论见 `docs/ARCHITECTURE-REUSE.md`（**31 个包全量：改用 0 / 保留 22 / 并存 9**）；首版（18 包，改用 0 / 保留 12 / 并存 6）与 5 项改造点记录于 `docs/archived/2026-10-02-reuse-audit.md`，重审见 `docs/archived/2026-10-19-reuse-reaudit.md`。

- profile 挂载面：**扩张到 base + 本仓插件 + 10 个官方行**（2026-10-02：`session-stats` / `session-turn-outline` / `session-reference` / `message-feedback` / `workspace-changes` / `file-reference-local` / `terminal` / `terminal-bash` / `invariants` / `workspace`；全部为投影 / 服务 / 事件面扩展，排除口径与第二批选题见 `docs/archived/2026-10-02-profile-mount-expansion.md`）。

- 宿主运行基线：**已升到 `dsh 0.2.1-rc.2`**（2026-10-21；前一步 0.2.0-rc.2 于 2026-10-02：全局安装 + profile 树外加装包 `session-title-all-prompts-llm` 同步 + `scripts/install.sh` 默认版本 + 主要版本引用（含 5 个包 smoke 脚本的宿主门槛）；进程外与进程内验证见追踪文档 `docs/archived/2026-10-02-host-upgrade-execution.md`）。

- install.sh 四条硬化：`.bak` 堆积（内容未变不写不备份）、profile 树外官方插件版本检查、收尾 `--dump-config` 自检（`--skip-verify`）、头注释口径 + 接线一致性校验；新增 `scripts/test-install.sh`（49 例；追踪文档 `docs/archived/2026-10-03-install-sh-followups.md`）。

- goal 状态行补 `activation`（`⟳` 自动续轮开关）：宿主**进程本地**事件 `goal/activation-changed` → `goalActivationBySession`（末条边、按会话隔离、不落盘）+ 展示值 `activeGoalActivation`（仅 `phase === "active"`、无记录 → `disarmed`）；head 行改 `Goal <符号> <phase>`（`▷` active 绿 / `∥` paused 黄 / `△` blocked 黄（**由红改黄**）/ `✓` complete 绿）+ 尾随 `⟳`（armed 绿 / disarmed 灰），`resumeTo` 补清空边（宿主 resume 经 `sessions.prepare` 重建 Session，activation 归 disarmed 且同值早退不发边）；7 例新用例（重启回归 / 边序无关 / 端到端帧断言），两轮子代理审阅修订（陈旧 armed、SPEC 口径矛盾、宽度表条目登记），反向验证撤符号渲染 → 7 例红（追踪文档 `docs/archived/2026-10-04-tui-goal-activation-symbol.md`）。

## 2. 未完成项

> 2026-10-23 关闭：条目「其余包接入定时器统一面 `clock`」完成并移出清单（实现 `190ee24`、假时钟与降级用例 `e40f5d0`；过程记录 `docs/archived/2026-10-22-clock-unified-timers.md`）。
> 2026-10-23 关闭：条目「把 `timer` 包改名为 `clock-base`」完成并移出清单（提交 `2d2fbd4`；过程记录 `docs/archived/2026-10-23-clock-base-rename.md`）。
> 2026-10-23 关闭：条目「memory-base 的意图 / 多策略混合检索」完成并移出清单（实现 `28a7a55`、测试 `abc3d14`，74 例全过；过程记录 `docs/archived/2026-10-22-memory-hybrid-retrieval.md`）。
> 2026-10-22 接取：§2 全部 6 条标〔进行中: 2026-10-22〕，各建追踪文档（`tool-consult` 与 `coagent` 的在新包目录内，其余在 `docs/implementation/`）；本次只建文档，调研与实现未开始。

> 顺序依据：**修复类优先 → 依赖深度升序 → 工作量升序**（2026-10-18 用户裁定「修复类的放前面」，在此之前为依赖深度 → 工作量）；同工时任「缺陷优先于行为改动 → 高优先级优先 → 保持原相对顺序」。前置关系另写在各条行内与「实现顺序」表。模块级条目按标题 + 文件路径引用（如 `md-logic/docs/BACKLOG.md`）。优先级：P0 > P1 > P2 > P3。
> 历史（2026-09 至 2026-10-22）：本节关闭过的条目（含两次清空、多次重排与重编号）过程记录全在 `docs/archived/`，按主题索引如下；本清单不再逐条保留关闭注记。
>
> - 知识库 / 记忆：`2026-10-07-knowledge-memory-lifecycle.md`、`2026-10-17-output-compress-scope-handle.md`、`2026-10-20-bgdaemon-memory-backend.md`、`2026-10-22-memory-hybrid-retrieval.md`
> - 新插件落地：`2026-10-15-md-table-check.md`、`2026-10-16-auto-approval-design.md`、`2026-10-16-script-interpreter-design.md`、`2026-10-19-timer-plugin.md`、`2026-10-21-behavior-correction.md`、`2026-10-22-herdr-use-rename.md`
> - 审计 / 宿主面：`2026-10-02-reuse-audit.md`、`2026-10-19-reuse-reaudit.md`、`2026-10-02-host-upgrade-0.2.0-rc.2.md`、`2026-10-21-host-upgrade-0.2.1-rc.2.md`
> - 跨会话与通知：`2026-09-30-cross-session-delegation.md`、`2026-10-20-notice-history-query.md`、`2026-10-20-agent-status-board.md`
> - 文档与流程：`2026-10-18-plugin-docs-refresh.md`、`2026-10-22-docs-consistency.md`

**1. `/memory` 的 `replace` 与 `remove` 子命令**〔进行中: 2026-10-22〕（2026-10-22 登记, 来源: 原「后续补条目候选」立项）：**现象 / 现状** —— TUI 的 `/memory` 只有只读面（概要 / `search`；命令描述还写着已移除的 `review` 审阅, 见 `TUI/src/app/commands.ts:319-320`）；memory-base 写侧只经 `registerKind` 句柄（`memory-base/src/scope.ts:46` 的 `forget(refs): Promise<number>`），而 TUI 只持只读 `memory` 面（`TUI/src/main.ts:775-781`），全仓无 `forget` 调用方 → 错误的 U / P 条目没有任何删除路径。**期望** —— 两个子命令：`remove` 删条目、`replace` 先删后写（需定原子性与半途失败回滚）；**先裁定写权归属**：① memory-base 另开一个管理面（不经 kind 句柄），或 ② TUI `registerKind` 一个自己的 kind（语义上不自然）。**落点** —— 先改 memory-base 写面 / 管理面，再改 `TUI/src/app/index.ts` 的 `handleMemoryCommand` 与 `commands.ts` 描述（同步去掉 `review`）；记忆存在 S 层时需按层权限拒绝。**验收** —— 删一条 U / P 条目后 `search` 不可见、计数正确；对不存在的 ref 返回 0；越权（S 层）明确拒绝；包内单测覆盖三条路径。**优先级** —— P2。**状态** —— 未接取。

**3. coagent：基于 herdr-use + agent-group + session-channel 拉起并管理 agent、派发任务**〔进行中: 2026-10-22〕（2026-10-22 登记, 来源: 用户构想）：**现象 / 现状** —— 现有的 agent 拉起面都不满足「干净上下文 + 高控制自由度」：`subagent` / `subagent_fork` 在宿主进程内跑，`subagent_fork` 还继承本会话已完成回合的上下文；`channel_delegate` 只能派给**已经在线**的 dsh 会话（要有人先起进程、且不知道它从哪来）；`herdr-use` 能在 pane 里跑任意命令，但它不知道「怎么起一个 agent、怎么认领它、怎么收尾」。三块能力各自齐备却没有人把它们编排成「按需拉起 → 派任务 → 收结果 → 关闭」的生命周期。**期望** —— 新插件（暂名 `coagent`，能力名同）以 herdr-use 为执行底、session-channel 为通信面、agent-group 为编排面，提供：① **拉起**：在 herdr pane 里起 `dsh headless "<task>"`（一次性、跑完打印结果并退出）或长驻交互会话（可 `--resume`）；可指定 profile / cwd / 模型，pane 打 label 归属；② **认领**：经 session-channel `peers`（sessionId / pid / cwd / profile / startedAt）确认新会话上线，或对 headless 直接读退出码 + stdout；③ **派发**：一次性把任务写进命令行；长驻走 `channel_delegate`（任务表 + 结果自动 / 显式回传）；④ **管理**：`state` 查忙闲、`channel_task cancel` 或发 `ctrl+c` 取消、`pane_read` / `pane_send_text` / `pane_send_keys` 观察与补输入、结束 `pane_close`；⑤ **编排**：多 coagent 用 agent-group 的组 / 成员 / 主从等级与懒判定结算；⑥ **与 subagent 的差异（本条核心）**：coagent 是**独立进程 + 全新会话，上下文零继承**（不喂任何父会话历史），换来更高控制自由度（看屏、实时插话、按键中断、独立 profile / 模型、跨 cwd、可并行多实例）。**待定项** —— 一次性与长驻的默认策略（按任务长短自动选？）；结果回收主路径（headless stdout 解析 vs 统一走 session-channel 回传）；`DSH_HOME` 与凭据是否隔离（现在共享 → 权限面放大）；并发上限与 pane 数量治理；失败 / 超时 / 崩溃残留的判定与清理；是否复用 agent-group 的等级语义。**落点** —— 新包 `coagent/`（`package.json` 的 `dsh.bundle` + `cordis.patch.yml`；依赖 herdr-use 库面与 session-channel / agent-group 服务面，缺任一服务时降级并如实报错），工具 `coagent`（action 分派：`spawn` / `list` / `send` / `wait` / `cancel` / `close`），profile 挂载与 README / DESIGN。**验收** —— 真机跑通「拉起 → 派任务 → 收结果 → 关闭」全链；验证上下文干净（coagent 会话里看不到父会话任何历史）；并行 2 个 coagent 且能单独取消；崩溃 / 超时后无残留 pane；单测用 fake pane + fake channel 覆盖六类失败路径。**优先级** —— P1（新能力，直接补足「干净上下文 agent」缺口）。**状态** —— 未接取，设计待细化（先与用户对齐待定项再动手）。

**4. 工具咨询插件（按需揭示工具, 避免模型记忆大量工具名）**〔进行中: 2026-10-22〕（2026-10-20 登记, 来源: 用户提出的新插件构想, 设计讨论中未定稿）：**现象 / 现状** —— 模型工具面全量暴露, 需记忆大量工具名且全程占用上下文; 没有「描述功能需求 → 返回可用工具」的按需发现入口。**期望** —— 新插件提供「工具咨询」: 模型描述要用的功能 → 插件返回匹配工具（名称 + 简述）并使其对当前会话可见（`tools.restrict` 遮罩 + 单条活动 mask 替换揭示）; 咨询工具本身常驻可见（own-layer 注册豁免 restrict）; 待定项: 初始可见集、匹配方式（关键词索引 vs LLM 语义）、揭示与收回语义。**优先级** —— 待定（设计未定稿）。**状态注记** —— 未接取, 等用户指令继续设计。

**5. MCP 脚本化（mcpScript）**〔进行中: 2026-10-22〕（2026-10-22 登记, 来源: 原「未立项观察项」立项；**形态未定**）：**现象 / 现状** —— 宿主有 `dsh-mcp-client`（MCP 客户端桥：连 server 并把工具注册进 `ctx.tools`）与 `dsh-mcp-resources`（作用域化资源发现与读取）；base 只挂了后者（`dsh-base/cordis.patch.yml:492-493`），仓内无 MCP 相关代码。所谓「mcpScript」到底是把 MCP 工具**以脚本方式一次跑多步**（结果结构化回传）还是把 MCP 资源读取脚本化，尚未定义。**期望** —— 先补设计再动手：定清目标场景、与 `script-interpreter` 的关系（扩展它 vs 新包）、是否需要挂 `mcp-client` 与凭据边界。**落点** —— 待设计定稿（候选：新包，或 `script-interpreter` 扩展 + 挂 `mcp-client`）。**验收** —— 待设计定稿后补。**优先级** —— 待定（形态未定）。**状态** —— 未接取，等用户指令继续设计。

**6. 共享文档与根级接线（由主分支代理承接）**〔进行中: 2026-10-22〕（2026-10-22 登记, 来源: 用户约定「新包只改自己包目录内的文件, 项目级文件交给主分支上的代理」）：**现象 / 现状** —— 三个新包（`coagent` / `tool-consult`，以及形态待定的 MCP 若最终定为新包）若各自去改根级接线文件，会与并行开发的其它线在 `package.json`、`AGENTS.md`、根 README 双侧、`profiles/example/cordis.patch.yml` 上互相踩踏。**期望** —— 并行任务只写**自己范围内的文件**（新包写包内目录；TUI 任务写自己的 `src/` 与 `tests/`）外加**自己的追踪文档**；**共享文档**与**根级接线**一律由主分支代理统一回写。共享文档清单：`docs/BACKLOG.md`、`TUI/docs/BACKLOG.md`（状态与关闭注记）、`TUI/docs/SPEC.md`、`TUI/README.md`、`TUI/docs/COMMANDS.md` / `COMMANDS-SPEC.md`、根 `README.md` / `README.zh.md`。**接线清单（每个新包一份）** —— ① 根 `package.json`：`check` / `build` / `test` / `demo` 链加入新包；② `AGENTS.md`：包清单（30 → 31 …）与「结构与约定」一行说明；③ 根 `README.md` / `README.zh.md`：包数与功能行（双侧同构）；④ `profiles/example/cordis.patch.yml` 与用户 profile（工作区外，需明确授权）；⑤ `scripts/test-parallel.sh` 的包枚举（若为硬编码）。**优先级** —— P1（不接线则新包不进构建与测试链）。**状态** —— 由主分支代理承接；新包只负责在包内把 `package.json` 的 `dsh.bundle` 契约与 `cordis.patch.yml` 写好。

**未立项观察项**：活动工具交互管理（暂不立项, 作为后续可选项）。

### 实现顺序与并行分组（2026-10-23 改版：组 = 串行链，组间可并行；组按 A 至 Z 编号）

**分组口径**: **组内串行**——同一组改同一批文件（或同一包），只能排队做；**不同组可并行**——文件互不重叠。因此**能并行的条目一定落在不同组**（新包各占一组）。组号 A、B、C … 表示可并行的轨道，不代表优先级。条目按标题引用，TUI 条目见 `TUI/docs/BACKLOG.md`；工作量 = 单线程人日（含测试与文档）。

| 组 | 顺位 | 条目 | 工作量 | 组内串行原因 |
| --- | --- | --- | --- | --- |
| A 渲染 | A2 | `#2 用户块折行后右侧大片留白`（TUI） | 约 0.5 至 1 天 | 同改 `layout/build-box.ts`（另涉 `fill.ts`、`content-rules.ts`） |
| A 渲染 | A3 | `#3 表格与正文内容不一致`（TUI） | 约 1 天（调研为主） | 同改 `layout/build-box.ts`（另涉 `table.ts`） |
| B 应用 | B1 | `#4 给 TUI 接 config-editor`（TUI） | 约 1 天 | 同改 `TUI/src/main.ts`、`app/index.ts`、`app/commands.ts` |
| B 应用 | B2 | `#5 非 TUI 行的 HMR 重载不退出会话`（TUI） | 约 1 至 1.5 天 | 同改 `TUI/src/main.ts`（另涉 `renderer/`） |
| B 应用 | B3 | `1. /memory 的 replace 与 remove 子命令`（项目级） | 约 1 至 2 天 | 同改 `app/index.ts`、`app/commands.ts`（另涉 `memory-base/src` 写面） |
| E coagent | E1 | `3. coagent`（项目级） | 约 3 至 4 天 | 单条; **只改 `coagent/`**（根级接线属 H 组） |
| F tool-consult | F1 | `4. 工具咨询插件`（项目级） | 约 3 至 5 天 | 单条; **只改 `tool-consult/`**（根级接线属 H 组） |
| G MCP | G1 | `5. MCP 脚本化`（项目级） | 未定（估计 ≥ 5 天） | 单条; 形态定稿前不动其它包; 若选扩展 `script-interpreter` 则并入其所在组 |
| H 共享文档与接线 | H1 | `6. 共享文档与根级接线`（项目级, 主分支代理） | 约 1 天 | 单条; **独占两级 BACKLOG、`TUI/docs/SPEC.md`、两份 README、`COMMANDS*.md`、根 `package.json`、`AGENTS.md`、profile 模板** |

**写入范围（2026-10-23 约定）**: 各组任务可写**自己的代码与测试**（新包：包内目录；TUI：自己的 `src/` 与 `tests/`）以及**自己的追踪文档**; 共享文档（两级 BACKLOG、`TUI/docs/SPEC.md`、两份 README、`COMMANDS*.md`）与根级接线（根 `package.json`、`AGENTS.md`、profile 模板）**只由 H 组（主分支代理）回写**。因此 A、B 两组虽然都属 TUI，但代码文件互不重叠、共享文档单写者，故**可并行**。
**可并行度**: 余下 A / B / E / F / G / H **六组互不重叠，理论可六路并行**; 实际受机器资源与评审带宽限制。
**H 组前置**: 需对应新包的 `package.json`（`dsh.bundle`）与 `cordis.patch.yml` 就绪, 故通常在各新包编排提交后收尾; 但不与它们争文件。
**组内顺序不是优先级**: 优先级仍以各条目的 P 值为准（P1: TUI `#3`、TUI `#5`、项目级 `3. coagent`、项目级 `6. 新包根级接线`）。

## 3. 里程碑

1. 里程碑一（P0，引擎三块 + 知识库底座）与里程碑二（P1：goal-contract / metric-loop、知识库记忆层与淘汰提升、fan-out 就绪池、hash-edit / ast-tools、security-guard / herdr-integration 等）均已完成。
2. 里程碑三（P1/P2）剩余项即 §2 清单（排序依据见 §2「顺序依据」与「实现顺序」表；实际开工顺序以表为准），按需排期；已完成项与已取消 / 不再立项项见 §1 索引。
3. 依赖：条目间依赖与用户门见各条正文与 §2 顺序依据。

## 4. 插件规划（未建包）

> 每个插件 = 本仓库一个包目录（以现有包为模板：`package.json` 的 `dsh.bundle` + `cordis.patch.yml` 集成契约）；命名按功能自定，不沿用 pi 插件名。已建插件与其承载清单项见 `STATUS.md`。

| 插件 | 承载清单项 | 复用（不新建） |
|------|-----------|----------------|
（当前无未建包插件；`behavior-correction` 已于 2026-10-22 建包并关闭，模板体系③随 `command-template` 交付。）

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
