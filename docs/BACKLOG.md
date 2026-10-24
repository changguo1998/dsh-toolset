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

- 安全与集成：security-guard 策略层、herdr-integration、herdr-use（把 herdr 终端当可控伪终端层驱动交互式命令：**10 个模型侧工具** `herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run`（旧 `herdr_use` 与 `pane_*` / `tab_*` 动作已删），一个终端 = 一个 tab + 自带 root pane、严格一会话一 workspace、`foreground:false` 落 `dshbg` 后台 lane（缺会话时 `herdr server` 自动拉起），并与进程内 `herdrUse` 服务面共用同一份登记表与写锁；追踪文档 `docs/archived/2026-10-16-herdr-pane-design.md`、本轮终端面重构 `docs/archived/2026-10-23-herdr-use-terminal-surface.md`）；

- 规则触发与符号规范：rule-engine、TUI 符号规则迁移（落点为 symbol-normalizer 插件）、next-step 注入路径、仓库级集成、注入消息呈现（**不带** `source.form:'notice'`：TUI 按用户输入块显示、正文以 `[RULE] ` 前缀标明自动注入）、消费者框架（`registerConsumer` + `evaluate`）、symbol-normalizer 插件；真机验证记录见 `docs/archived/2026-09-27-rule-engine-consumer-and-integration.md`；

- TUI：/workflows 面板、/council、/search 多 provider 聚合、声音提醒，以及 7 项纯 TUI 命令与 A1-A5（`/task` `/guard` `/memory` `/loop` `/contract`）；

- 工程流程与文档：文档体系与变更规范落地（追踪文档 `docs/archived/2026-09-25-docs-workflow-rollout.md`）、`TUI/docs/IMPLEMENTATION.md` 拆分删除（命令/机制 → `TUI/docs/DESIGN.md`「实现要点（机制与命令）」、渲染/排版 → `TUI/docs/SPEC.md` §15、验证 → `TUI/README.md`；追踪文档 `docs/archived/2026-09-29-tui-implementation-doc-split.md`）、根 README 英文化（英文主档 `README.md` + 中文版 `README.zh.md`，`AGENTS.md` 语言约定例外与口径同步；追踪文档 `docs/archived/2026-09-30-readme-i18n.md`）。

- 新包与根级接线：`coagent`（长驻 agent 拉起与收尾：经 `herdrUse` 建终端并发 `fffdsh`，用 `peers` 认领新会话；追踪文档 `coagent/docs/archived/2026-10-22-coagent.md`）、`tool-consult`（按需揭示工具：`tools.restrict` 单条活动遮罩 + `consult_tools` 咨询即授权，缺省 9 核心工具、session / turn 两档揭示；追踪文档 `tool-consult/docs/archived/2026-10-22-tool-consult.md`）、根级接线与 profile 挂载（根 `package.json` 四链、`AGENTS.md`、根 README 双侧、`scripts/*.sh` 枚举、profile 模板；`~/.dsh/profiles/fff` 现为 dsh-base + 33 个包 = 34 个 bundle；追踪文档 `docs/archived/2026-10-23-new-package-wiring.md`）。

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

> 2026-10-24 关闭：条目「示例 profile 资产对齐当前 fff 的通用配置（去个人化）」完成并移出清单（`profiles/example/cordis.patch.yml` 删 permission / schedule / invariants，补 fff 通用条目，`rule-engine` 只留启用的 `resumed-notice`，个人模型配置以 `PROVIDER` / `MODEL` 占位，`tui.theme` 改 `dark`；同步 `profiles/README.md`、`scripts/install.sh`（full-ask 提示）、`scripts/test-install.sh`（theme 断言）；`scripts/test-install.sh` 98 项通过；过程记录 `docs/archived/2026-10-24-example-align-fff.md`）。

> 2026-10-24 关闭：条目「安装脚本生成的 profile 与当前 fff 的通用配置对齐」完成并移出清单（实现 `a3f1e3b`：示例 patch 补 theme light / goal 999 / ponytail 停挂，`install.sh` 追加 hmr 生成区（`base` = 仓库根 + `root: ['.']` + 文档忽略，幂等且保留手写 hmr）；`scripts/test-install.sh` 98 项通过；过程记录 `docs/archived/2026-10-24-install-profile-parity.md`；fff 已由用户执行 `--sync` 生效）。

> 2026-10-23 关闭：条目「`/memory` 的 `replace` 与 `remove` 子命令」完成并移出清单（实现 `02d79c0`、合并 `6ab5b43`；过程记录 `docs/archived/2026-10-22-memory-edit-subcommands.md`；复核：根 check 通过、memory-base 82/82、TUI 1745/1745；真机验收未做）。
> 2026-10-23 关闭：条目「其余包接入定时器统一面 `clock`」完成并移出清单（实现 `190ee24`、假时钟与降级用例 `e40f5d0`；过程记录 `docs/archived/2026-10-22-clock-unified-timers.md`）。
> 2026-10-23 关闭：条目「MCP 脚本化（mcpScript）」按「不立项」关闭并移出清单（用户 2026-10-23 裁定: 本工作先不做, 等真正需要再做; 设计定稿见 `docs/archived/2026-10-22-mcp-script.md`，重开触发条件与两档预案在该文件）。
> 2026-10-23 关闭：条目「把 `timer` 包改名为 `clock-base`」完成并移出清单（提交 `2d2fbd4`；过程记录 `docs/archived/2026-10-23-clock-base-rename.md`）。
> 2026-10-23 关闭：条目「memory-base 的意图 / 多策略混合检索」完成并移出清单（实现 `28a7a55`、测试 `abc3d14`，74 例全过；过程记录 `docs/archived/2026-10-22-memory-hybrid-retrieval.md`）。
> 2026-10-23 关闭：条目「coagent」完成并移出清单（实现 `ca2ee4d` + 测试 `90fd019`（`31/31`）+ 文档 `f9d0262`，合并 `3a99d90`；根级接线 `e99b863`、服务注入修复 `231f26a`；过程记录 `coagent/docs/archived/2026-10-22-coagent.md`；真机验收通过：`spawn` 4.4 s 认领、`close` 走 `/quit` 子会话下线、服务面与工具面同源，证据见 `docs/archived/2026-10-23-real-machine-verification.md` #12 至 #14）。
> 2026-10-24 关闭：条目「6. 共享文档与根级接线」完成并移出清单（根四链、`AGENTS.md`、README 双侧、`scripts/*.sh` 枚举、profile 模板全部落地；`~/.dsh/profiles/fff` 现为 dsh-base + 33 个包 = 34 个 bundle；过程记录 `docs/archived/2026-10-23-new-package-wiring.md`）。
> 2026-10-24 关闭：条目「7. herdr-use 终端面重构（10 个工具）与共用服务面」完成并移出清单（实现合并 `8de0816`，后台 lane 自动拉起在 `herdr-use/src/background.ts`；真机 #1–#7 通过，未了的 #8 / #9 / #10 记在 `docs/archived/2026-10-23-real-machine-verification.md`；过程记录 `docs/archived/2026-10-23-herdr-use-terminal-surface.md`）。
> 2026-10-24 关闭：条目「4. 工具咨询插件（按需揭示工具）」完成并移出清单（实现 + 遮罩接线合并；真机验证：9 核心 + `consult_tools` 生效、揭示链路可用、未揭示调用被拦并给可行动文案；期间修掉 `tools/change` 自激死循环与 3 处工作流文案缺陷，提交 `105bb23` / `4d68858`；包内 49 例通过；过程记录 `tool-consult/docs/archived/2026-10-22-tool-consult.md`）。
> 2026-10-22 接取：§2 全部 6 条标〔进行中: 2026-10-22〕，各建追踪文档（`tool-consult` 与 `coagent` 的在新包目录内，其余在 `docs/implementation/`）；本次只建文档，调研与实现未开始。

> 顺序依据：**修复类优先 → 依赖深度升序 → 工作量升序**（2026-10-18 用户裁定「修复类的放前面」，在此之前为依赖深度 → 工作量）；同工时任「缺陷优先于行为改动 → 高优先级优先 → 保持原相对顺序」。前置关系另写在各条行内与「实现顺序」表。模块级条目按标题 + 文件路径引用（如 `md-logic/docs/BACKLOG.md`）。优先级：P0 > P1 > P2 > P3。
> 历史（2026-09 至 2026-10-22）：本节关闭过的条目（含两次清空、多次重排与重编号）过程记录全在 `docs/archived/`，按主题索引如下；本清单不再逐条保留关闭注记。
>
> - 知识库 / 记忆：`2026-10-07-knowledge-memory-lifecycle.md`、`2026-10-17-output-compress-scope-handle.md`、`2026-10-20-bgdaemon-memory-backend.md`、`2026-10-22-memory-hybrid-retrieval.md`
> - 新插件落地：`2026-10-15-md-table-check.md`、`2026-10-16-auto-approval-design.md`、`2026-10-16-script-interpreter-design.md`、`2026-10-19-timer-plugin.md`、`2026-10-21-behavior-correction.md`、`2026-10-22-herdr-use-rename.md`
> - 审计 / 宿主面：`2026-10-02-reuse-audit.md`、`2026-10-19-reuse-reaudit.md`、`2026-10-02-host-upgrade-0.2.0-rc.2.md`、`2026-10-21-host-upgrade-0.2.1-rc.2.md`
> - 跨会话与通知：`2026-09-30-cross-session-delegation.md`、`2026-10-20-notice-history-query.md`、`2026-10-20-agent-status-board.md`
> - 文档与流程：`2026-10-18-plugin-docs-refresh.md`、`2026-10-22-docs-consistency.md`

### 实现顺序与并行分组（2026-10-24 收束）

2026-10-24 起**没有在跑的并行分组**：A 至 I 各组的条目已全部关闭（条目 4 / 6 / 7 与 TUI `#3`、项目级 `3. coagent` 均在 2026-10-23 至 2026-10-24 关闭）。分组口径与写入范围约定保留在 `docs/WORKFLOW-STANDARD.md`，将来有新条目再按「组内串行、组间并行」重新分组。

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
