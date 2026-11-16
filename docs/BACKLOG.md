# 待开发功能清单

> 职责：待办全集：缺陷 + 功能 + 里程碑 + 插件规划
> 不负责：现状描述（见 `docs/STATUS.md`）
> 过期条件：无

> 本清单只列**未完成**项；已完成项见 `STATUS.md` 状态表（实现与验证证据在各包源码/测试与 git 历史；已完成的实施清单归入 `archive/`），不在此重复。
> 设计依据：`docs/host/AGENT-ARCHITECTURE-ANALOGY.md`（架构与接口对照）、`archive/PI-DSH-FEATURE-COMPARISON.md`（pi→dsh 迁移基线差距，归档调研）。实现时以根目录 `docs/host/DSH-CTX-API.md` 对齐宿主接口。
> 基线：dsh `0.2.2-rc.3`（2026-11-16 已实装：代码迁 `startActivation`、`install.sh` 默认已抬版、宿主与 fff profile 已装 rc.3；对照见 `docs/host/HOST-UPGRADE-0.2.2-rc.3.md`，上一步 `0.2.2-rc.1` 见 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md`）。
> 编号口径：`#N` **仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**（不保证稳定，勿作跨引用）；与其它层 BACKLOG 的编号互不关联，跨层引用须写明文件路径。
> 优先级：**P0** 架构主线；**P1** 核心体验补齐；**P2** 长尾。状态标记：`[x]` 已实现（仅第 1 节索引使用）、`[~]` 部分实现（注明未含部分）、无标记 = 未实现。

## 1. 已完成索引

`[x]` 已实现并合入 main，改动位置如下（单测数与首版边界见状态表）：

- 工具揭示架构重设计（缓存友好，2026-11-14 完成，提交 `cc8d4ee1`）：`tool-consult` 首请求起常驻全量短清单；初始 14 个工具保留完整定义，其余非初始、非条件工具在 agent 作用域 shadow 成短说明；`allowedWhenTools` 白名单外的条件工具由一次静态 `restrict({ deny })` 完全隐藏；揭示只写会话授权并按工具登记 `pinNotes.hold` 投递全文，未揭示的受管工具由 `tools/pre-execute` 以 `TOOL_NOT_REVEALED` 拒绝；catalog 自检 / deny 失败 / schema 残留时不接管。单测 100 + 集成 10 + e2e 3 全绿，全仓 39 包 check / build / test 与 check:docs 全绿；伴随 `fff-test` profile 真机三个会话 header 字节一致，随机 key 下补测「未揭示拒绝 → 揭示 → 再调成功」且 5 步只有 1 条 header；主 profile 待人工安装。追踪文档 `docs/archived/2026-11-13-tool-reveal-redesign.md`。

- 任务控制：task-engine（Frame 状态机、工具族、双重门禁、RET 三级路由、step 裁决、**叶子执行后端**：`executor` 声明 + `task_execute` 工具 + `subagent` / `workflow` / `command` 后端 + 用量计量，追踪文档 `docs/archived/2026-10-02-injection-timing-naming-warn-executor.md`）、fan-out 就绪池、goal-contract、metric-loop；

- 知识库与记忆：memory-base（原名 knowledge-base；两张基表 + 两张 FTS5 虚表、持久记忆 CRUD、**入库规则与隐私 / 容量边界**、**自动巩固**（提升 / 合并 / 淘汰，启动后与 compaction 后触发）；**分层记忆系统**：S / P / U 三库 + 一库一指纹、写入闸门下沉库核心、`project` 派生链、容量寿命控制——实施批次 13 条全部关闭：前 8 条提交 `a81da69` / `0652866` / `55c6382` / `270b2df`，余 5 条于 2026-10-08 关闭）、output-compress、fs-digest（追踪文档 `docs/archived/2026-10-07-knowledge-memory-lifecycle.md`，前身 `docs/archived/2026-10-02-knowledge-events-and-memory-consolidation.md`）；

- 代码与文件：hash-edit、ast-tools、code-map 报告与影响面、结构层索引与候选调用图 + LSP 语义层（callers 的 findReferences 精确裁决，`precision:lsp/structural`；追踪文档 `docs/archived/2026-09-29-codemap-lsp-semantic.md`）；

- 上下文报告：context-report（host-only 投影 `sessionContext` 只折 token 分桶；回合 / 步 / 墙钟读官方 `sessionStats` 投影，2026-10-06 去重 + `context_report` 三档报告）；

- 安全与集成：security-guard 策略层、herdr-integration、herdr-use（把 herdr 终端当可控伪终端层驱动交互式命令：**10 个模型侧工具** `herdr_list` / `herdr_read` / `herdr_info` / `herdr_wait` / `herdr_create` / `herdr_close` / `herdr_label` / `herdr_text` / `herdr_key` / `herdr_run`（旧 `herdr_use` 与 `pane_*` / `tab_*` 动作已删），一个终端 = 一个 tab + 自带 root pane、严格一会话一 workspace、`foreground:false` 落 `dshbg` 后台 lane（缺会话时 `herdr server` 自动拉起），并与进程内 `herdrUse` 服务面共用同一份登记表与写锁；追踪文档 `docs/archived/2026-10-16-herdr-pane-design.md`、本轮终端面重构 `docs/archived/2026-10-23-herdr-use-terminal-surface.md`）；

- 规则触发与符号规范：rule-engine、TUI 符号规范迁移（实现位置为 symbol-normalizer 插件）、next-step 注入路径、仓库级集成、注入消息呈现（**不带** `source.form:'notice'`：TUI 按用户输入块显示、正文以 `[RULE] ` 前缀标明自动注入）、消费者框架（`registerConsumer` + `evaluate`）、symbol-normalizer 插件；真机验证记录见 `docs/archived/2026-09-27-rule-engine-consumer-and-integration.md`；

- TUI：/workflows 面板、/council、/search 多 provider 聚合、声音提醒，以及 7 项纯 TUI 命令与 A1-A5（`/task` `/guard` `/memory` `/loop` `/contract`）；

- 工程流程与文档：文档体系与变更规范落地（追踪文档 `docs/archived/2026-09-25-docs-workflow-rollout.md`）、`TUI/docs/IMPLEMENTATION.md` 拆分删除（命令/机制 → `TUI/docs/DESIGN.md`「实现要点（机制与命令）」、渲染/排版 → `TUI/docs/SPEC.md` §15、验证 → `TUI/README.md`；追踪文档 `docs/archived/2026-09-29-tui-implementation-doc-split.md`）、根 README 英文化（英文主档 `README.md` + 中文版 `README.zh.md`，`AGENTS.md` 语言约定例外与口径同步；追踪文档 `docs/archived/2026-09-30-readme-i18n.md`）。

- 新包与根级接线：`coagent`（长驻 agent 拉起与收尾：经 `herdrUse` 建终端并发 `fffdsh`，用 `peers` 认领新会话；追踪文档 `coagent/docs/archived/2026-10-22-coagent.md`）、`tool-consult`（按需揭示工具：`tools.restrict` 单条活动遮罩 + `consult_tools` 咨询即授权，缺省 9 核心工具、session / turn 两档揭示；追踪文档 `tool-consult/docs/archived/2026-10-22-tool-consult.md`）、根级接线与 profile 挂载（根 `package.json` 四链、`AGENTS.md`、根 README 双侧、`scripts/*.sh` 枚举、profile 模板；`~/.dsh/profiles/fff` 现为 dsh-base + 33 个包 = 34 个 bundle；追踪文档 `docs/archived/2026-10-23-new-package-wiring.md`）。

- 运行时与宿主：宿主双栈兼容垫片清理（0.1.7-rc.2 单一形态；追踪文档 `docs/archived/2026-09-29-host-single-stack-cleanup.md`）、tmux 断连后 dsh 退出 → 退出前问题面板确认（追踪文档 `docs/archived/2026-09-29-exit-confirm-panel.md`）、跨会话消息通道 `session-channel` 插件（专用 Redis 实例 + unix socket；追踪文档 `docs/archived/2026-09-29-cross-session-intercom.md`）、跨会话共享 KV（session-channel 服务面扩展，last-value + 版本号；追踪文档 `session-channel/docs/archived/2026-09-29-shared-kv.md`）、会话标题参考窗口改为「最近一次 `git commit` 之后」（新包 `session-title-cutoff`，接管 `ctx.sessionTitle` 唯一 provider；追踪文档 `session-title-cutoff/docs/archived/2026-09-29-title-cutoff-provider.md`）、跨会话委托/协调（`session-channel` 任务语义：任务表 + 结果自动/显式回传 + `channel_delegate`/`channel_task`/`channel_task_result` 三工具；追踪文档 `docs/archived/2026-09-30-cross-session-delegation.md`）、模板体系（`command-template`：预案 `/playbook` 统一入口 + 五族模板 + 双源目录 + 模板级模型选择；追踪文档 `docs/archived/2026-09-30-template-system.md`）。

- 已取消/不再立项：rate-guard（不实现，pi 侧已移除，dsh 侧由官方 `llm-retry` 覆盖，见 `archive/PI-DSH-FEATURE-COMPARISON.md` §5.1）；GitHub 仓库克隆、PDF 提取 / 视频理解、密文扫描、安全 issue 上报（用户 2026-09-29 裁定移除，不立项）；近期改动代码审查、preset 机制迁移评估（用户 2026-09-29 裁定直接关闭，不立项）；模型请求路由与速度控制 `llm-router`（2026-10-11 判定不改仓内插件，采用现成开源网关 —— 主选 Bifrost、备选 LiteLLM，见 `docs/archived/2026-10-11-llm-router-decision.md`）；Docker 交互插件（用户 2026-10-19 裁定不做，条目已从 §2 删除）。

- 已取消/不再立项（2026-11-16 用户裁定「删掉, 不考虑; 以后想起来了再说」）：

  - 回合预算调整（会话级请求参数调整插件, 原 §2 暂停条目）: 恢复条件未满足（宿主 `agent/request` 仍弃用、无替代 API, 宿主 master `39163dd30f` 复核）; 调研结论归档 `docs/archived/2026-11-05-request-tuning.md`, 恢复时从该文档「决策」节重新裁定。
  - deepseek-account（DeepSeek 账号登录链, 原 §6 挂起条目）: 恢复条件未满足（官方账号登录仍硬依赖 Host webServer + 浏览器 PKCE, `desktopPlatform` 仍不支持 linux, Linux web/CLI 无登录入口）; 该条目宿主面细节以本节注记为准, 不再单列。

- 宿主面知识：官方 **0.2.0-rc.2 对照汇总**（`docs/host/HOST-UPGRADE-0.2.0-rc.2.md`；工具 / 事件 / 服务面零增删，`docs/host/HOST-PACKAGES.md` 同期刷到 0.2.0 口径，审阅记录见 `docs/archived/2026-10-02-host-upgrade-0.2.0-rc.2.md`）。

- `md-map`：新建第 19 个插件（文档版 `code-map`：标题锚点 / 跨文档链接 / wiki / 代码文件引用 / 被引计数，查询 `callers` / `impact` / `orphans` / `report`；单文件解析复用 `md-logic`；36 例测试；追踪文档 `docs/archived/2026-10-02-md-map-package.md`）。

- `script-interpreter`：新建插件（模型侧脚本解释器：`script_run` 单次执行 Python，脚本经 stdin 送入不落临时文件；围栏走 `ctx.sandboxPolicy` + `ctx.sandbox`，可选服务经 `ctx.get` 受保护读取、能力缺失如实标注；审批缺省关闭，`approval: ask` 走宿主审计对；超限保留尾部 + 全文落盘 0600；73 例测试；追踪文档 `docs/archived/2026-10-16-script-interpreter-design.md`）。

- command-template 终态与回收：`playbook` 等命令的子代理步骤改为**与取消信号竞速**（`start` 与宿主结算面都在竞速内），abort 路径**发起但不等待**回收（宿主 in-process `dispose()` 内部 `await run.result`，等它等于换个地方无界等待）；修掉真机「命令悬挂、无 `command/done`」的根因面（本仓侧任何路径都回终态，文案区分「被调用方取消」/「步骤超时（N ms）」并带子会话 id）；19 例测试（含宿主语义 dispose / start 悬挂 / 迟到 reject 三个退化点），全仓 20 包全绿（追踪文档 `docs/archived/2026-10-02-command-template-terminal-state.md`）。

- task-engine 计量口径（usage → 权威信号）：subagent 用量改读宿主 `tokenUsage` 投影（`sessionProjections.stateOf`＝provider 上报的**累计**输出 token；尚无样本 / 服务缺失 / 抛错时回退 `tokenMeter` 的 pressure 口径），**超预算判定改用宿主权威信号** `stopReason === "max-tokens"`——不做 tokens 数值比较（审阅用真实会话日志回放 12 个 spawn 子会话：totals 6–81,955 vs 实际预算 256/512/4000，数值比较会 10/12 恒真）；72 例单测 + `smoke:executor` 扩 4 条断言，全仓 20 包全绿（追踪文档 `docs/archived/2026-10-02-task-engine-usage-metric.md`）。

- `md-logic`：新建第 18 个插件（Markdown 逻辑结构：节树 + 块 + 链接清单，带行范围；解析用 `marked` 真实 CommonMark），注册模型侧工具 `md_logic`（structure / blocks / links）并与 `fs_digest` 双向指路；接线 9 处（含补齐根 check/build 链与 test-parallel 的既有漏项）；34 例测试 + 全仓 19 包全绿（追踪文档 `docs/archived/2026-10-02-md-logic-package.md`）。

- `ast-tools` 模型侧工具：注册 `ast_query`（action 分派：search / outline / rules，AST 形态与元变量捕获）与 `ast_replace`（默认 dry-run，写回需 `write:true`）；缺 ast-grep 二进制时注册降级版（调用返回含安装指引的 error）；模型侧行号渲染为 1 基，描述里写明与 `grep` / `glob` / `fs_digest` / `code_map` / `hash_edit` 的选择成本（追踪文档 `docs/archived/2026-10-02-ast-tools-model-tools.md`）。

- Markdown 结构视图：`fs_digest` 的 Markdown `outline` 现在给**每节行范围**（含端点、尾空行不计、父子包含）与**块级结构清单**（list / table / code / quote / frontmatter，带 `§L{节}` 归属）；标题树 45 行 + 块清单 15 行两个独立预算；`scanMarkdown` 为 `src/outline.ts` 的**模块级导出**（未透出包入口，`md-logic` 仅对齐口径、无 import 依赖，2026-10-04 复核更正）（追踪文档 `docs/archived/2026-10-02-markdown-structure-view.md`）。

- 复用审计：现行结论见 `docs/ARCHITECTURE-REUSE.md`（**31 个包全量：改用 0 / 保留 22 / 并存 9**）；首版（18 包，改用 0 / 保留 12 / 并存 6）与 5 项改造点记录于 `docs/archived/2026-10-02-reuse-audit.md`，重审见 `docs/archived/2026-10-19-reuse-reaudit.md`。

- profile 挂载面：**扩张到 base + 本仓插件 + 10 个官方行**（2026-10-02：`session-stats` / `session-turn-outline` / `session-reference` / `message-feedback` / `workspace-changes` / `file-reference-local` / `terminal` / `terminal-bash` / `invariants` / `workspace`；全部为投影 / 服务 / 事件面扩展，排除口径与第二批选题见 `docs/archived/2026-10-02-profile-mount-expansion.md`）。

- 宿主运行基线：**已升到 `dsh 0.2.1-rc.2`**（2026-10-21；前一步 0.2.0-rc.2 于 2026-10-02：全局安装 + profile 树外加装包 `session-title-all-prompts-llm` 同步 + `scripts/install.sh` 默认版本 + 主要版本引用（含 5 个包 smoke 脚本的宿主门槛）；进程外与进程内验证见追踪文档 `docs/archived/2026-10-02-host-upgrade-execution.md`）。

- 状态列弹性名称行（`h([符号, 名称(fill), 尾部])`）**按设计保留**：分配顺序为 fixed > ratio > auto > fill，故尾部先锁自然宽、名称吃剩余宽度，短名称产生的补白即尾部右对齐（原「不补白」待办 2026-11-07 登记、同日撤销）；Daemon / Group / Flow 三块已用该形态（提交 `3de1a5b1`）。

- install.sh 四条硬化：`.bak` 堆积（内容未变不写不备份）、profile 树外官方插件版本检查、收尾 `--dump-config` 自检（`--skip-verify`）、头注释口径 + 接线一致性校验；新增 `scripts/test-install.sh`（49 例；追踪文档 `docs/archived/2026-10-03-install-sh-followups.md`）。

- goal 状态行补 `activation`（`⟳` 自动续轮开关）：宿主**进程本地**事件 `goal/activation-changed` → `goalActivationBySession`（末条边、按会话隔离、不落盘）+ 展示值 `activeGoalActivation`（仅 `phase === "active"`、无记录 → `disarmed`）；head 行改 `Goal <符号> <phase>`（`▷` active 绿 / `∥` paused 黄 / `△` blocked 黄（**由红改黄**）/ `✓` complete 绿）+ 尾随 `⟳`（armed 绿 / disarmed 灰），`resumeTo` 补清空边（宿主 resume 经 `sessions.prepare` 重建 Session，activation 归 disarmed 且同值早退不发边）；7 例新用例（重启守成测试 / 边序无关 / 端到端帧断言），两轮子代理审阅修订（陈旧 armed、SPEC 口径矛盾、宽度表条目登记），反向验证撤符号渲染 → 7 例红（追踪文档 `docs/archived/2026-10-04-tui-goal-activation-symbol.md`）。

- 三个包改用 `shell-parse`（2026-11-06 并行 worktree 完成）：`security-guard` 删掉命令解析副本、命令位改由 `commandPositions` 提供并保留包装器候选词（161 例）；`auto-approve` 切段 / 分词改包内实现、抹值与段形态留在本包（184 例，迁移前后 `formOfCommand` 基线 10/12 逐字一致，2 条差异为转义处理更正确）；`behavior-correction` 把 python / node 两条规则并为 `no-interpreter-in-bash`，`RuleSpec.match` 新增 `commandNames` 按解析层命令位识别解释器（50 例；追踪文档 `security-guard/docs/archived/2026-11-06-shell-parse-migration.md` / `auto-approve/docs/archived/2026-11-06-shell-parse-migration.md` / `behavior-correction/docs/archived/2026-11-06-interpreter-recognition.md`）。

- 折行策略可配置与折行核统一（2026-11-06 完成）：叶子折行属性从 `wrap?: boolean` 扩成 `WrapSpec`（`mode` / `maxRows` / `hint`，缺省 `char` + `0` + `tail`），全仓 5 份逐字符折行副本收敛为 `TUI/src/app/layout/wrap-core.ts` 一份核；状态列长文本条目改按词断行（Goal / Todo / Agents / Task / Pin / Daemon / Group / Flow），jobs 与 L3 折叠保持单行；提示行、`/collapse`、拼帧兜底、工具行四处行数上限统一走核的预算（工具行首次获得 5 行上限）；新增核用例 21 例 + 状态列 4 例，TUI 全量 1858 例全绿、冒烟 SMOKE_PASS、根 check / build 通过（追踪文档 `docs/archived/2026-11-06-wrap-strategy.md`）。

- 写面围栏核查与三包改造（2026-11-08 完成）：`ast-tools` 的 `ast_replace`、`md-logic` 的 `replace`、`hash-edit` 的 `hash_read` / `hash_edit` 读写面全改走官方 `ctx.fs`（围栏 + 写意图瀑布 + 文件级版本守卫 + `fs/observed`），每包新增 `src/io.ts`（接口 + node 缺省实现）与 `src/ctx-fs-io.ts`（`ctx.fs` 实现），服务缺失不回落 node 并返回可行动错误；跨包核对表 24 行，结论「需改走 3 / 可不走 15 / 非工具面 6」（追踪文档 `docs/archived/2026-11-08-tool-write-path-fence.md`，三包各 89 / 83 / 65 例 + 集成 9 / 10 / 18 例全绿）。

- 工具说明注册表收尾三件（2026-11-13 完成）: `coagent` 接入包装层（直接 `wrapToolDefinition`, 删「不 import 其他包」规矩 5 处, 单测 77 + 集成 18 全绿）、`flow-track` memory 懒解析（服务晚到自愈, `e2e` 补 payload `ok` 断言, 82 例 + e2e 绿）、`scripts/test-install.sh` 第 11 步改 `canonical_pkgs` / `default_pkgs` / 仓库包目录三方比对并补 39 包计数（124 项全过）; `ponytail` e2e 按用户裁定「计划废弃」不改不测（追踪文档 `docs/archived/2026-11-13-tool-followups.md`, 全仓 39 包 check / test 绿）。

- `tool_consult` 指向名统一（2026-11-14 完成, 提交 `c18042cd`）: 模型可见文本里的旧指向名 `tool_consult` 统一为实际注册名 `consult_tools`（`tool-consult/src/tool.ts` `CONSULT_TOOL_NAME`）——tool-surface 包装提示 / tool-consult 未揭示拒绝文案 / flow-track 工具 summary / 各包与根 README 双侧; 纯文本统一, 不改注册名与行为; 追踪文档 `docs/archived/2026-11-14-tool-consult-name-unify.md`（39 包 check / test 全绿, e2e 40/41 唯一红为计划废弃的 ponytail, check:docs 通过）。

- AGENTS.md 瘦身整理（2026-11-14 完成, 提交 `8bf32c69`）: 项目根 `AGENTS.md` 从 108 行瘦身到 62 行, 只留每次会话必读的行为规范（语言约定 / 常用命令 / 格式化 / 变更流程 / 内容变更规范简版 / 文档与结构约定 / Git）; 命令全量 / 一键安装 / 构建部署到 profile 外移到新建 `docs/DEVELOPMENT.md`, 39 包逐包职责与 `DESIGN.md` 口径外移到新建 `docs/PACKAGES.md`; 根 `README.md` / `README.zh.md` 文档索引双侧同步（追踪文档 `docs/archived/2026-11-14-agents-md-reorg.md`, check:docs 122 篇通过）。

- 模型观测两任务（2026-11-14 提出, 2026-11-15 完成, 提交 `0188fbf1` / `85364499` / `6d386e79`）: 「缓存命中率监控」新建第 40 个包 `cache-hit-monitor`（`agent/pre-step` 取上下文快照 + `assistant/message.usage` 实际命中率, 偏差超 `tolerance`（缺省 0.3）判缓存失效, 三态 normal/stale/first 经服务面 `cacheHitMonitor.summary` 供 TUI 懒读）; 「TUI 显示当前模型性能」在 TUI 内实现状态行性能槽位（首字节延时 + 解码速率, 最近一步实时值, 收尾归零, 单位 `t/s`, 非流式回落）; 两者共享 `status-line.ts`, 顺序执行不并发, cache 段按三态着色（绿/红/黄, 无数据 `—` 占位）; 追踪文档 `docs/archived/2026-11-14-cache-hit-monitor.md` / `docs/archived/2026-11-14-tui-model-performance.md`（规划 `docs/archived/2026-11-14-model-observe-impl-plan.md`, 39→40 包计数接线; TUI 1889 例与全仓 check / test / check:docs 全绿）。

- 泛化 task-engine: 编排模板框架（2026-11-15 完成, 提交 `200f96c4` / `5e8e5d54` / `86b94803` / `d37b9d2f` / `07c647ec`）: 按用户 2026-11-15 裁定改为「**流程定义插件 + task-engine 节点基础工具**」, 不做声明式模板文件登记。task-engine 增三项节点基础能力——可选**顺序强制**（流程定义级 `enforceOrder`, `implement` / `execute` / `stop` 三入口拦越序）、**编程服务面建树**（`composeFromNodes`, 父帧任意, 走既有双门禁）、**当前节点推送**（取 title / spec / 验收摘要 / 下一步 / 顺序提示, 经 `pinNotes.hold("task")` 动态保持）; flow-track 重构为流程定义方（八阶段改节点数组、`flow_start` 一次建树、阶段模板与推进状态注入退役、`flow_enable` 迁出、命令回执 kind 修正）; 新包 `plan-mode`（探索 / 计划 / 实施三段 + `plan_start`, 插件 id `plan-mode-track`）与 `flow-arbiter`（会话级选中 + `tools/pre-execute` 只拦流程入口, 工具恒注册保缓存）; 包数 40→42, 计数接线与文档全部同步。验证: 各包 check / build / test（task-engine 182→203、flow-track 82→85、plan-mode 11、flow-arbiter 12）+ 三条 e2e（真宿主建树 / 越序拒绝 / 仲裁拦截）+ 全仓 check / build / test / test:tui / check:docs / test-install 全绿。追踪文档 `docs/archived/2026-11-15-task-engine-template-framework.md`。

- 自研 plan 模式的**流程控制部分**（随上一行交付, 2026-11-15 完成, 状态更正见 `docs/archived/2026-11-15-plan-mode-status.md`）: 三段流程定义 `plan-mode`（探索 / 计划 / 实施, 各 `needDecompose` + `enforceOrder`）+ 入口 `plan_start`, 越序由 task-engine `order.ts` 拦截, 计划段 human 门禁复用 acceptance 审批链, 流程选择由 `flow-arbiter` 仲裁; 原 §2「自研 plan 模式（替代官方 plan-mode）」条目据此拆分,**其余部分**已拆成 §2 三条条目（主条目含写工具拦截与阶段策略注入; 段位展示、子代理写继承各一条）, 阶段结构校验列为不做。

- 自研 plan 模式：写面拦截与阶段注入（2026-11-15 完成）: 探索 / 计划段 `tools/pre-execute` 写面拦截（回执 `plan_stage_readonly` + 下一步指引; 命令白名单经 shell-parse, 任务面工具放行）+ 权限预设 `read-only` 切换与五入口恢复（计划段终态 / 切走 / 树完成 / 会话结束 / 插件卸载, `restored` 防重）+ `planStage.current(sessionId)` 只读服务面 + 阶段注入（pinNotes.hold provider 每步, 探索 / 计划只读提示、实施放行）; 单测 53 + e2e 1（探索段写拒与 presetSwitched）全绿, 全仓 check / build / test / check:docs / test-install 通过; 另以隔离 verify-test 软链接装配真机验证（flow_select → plan_start（presetSwitched: true）→ 探索段 write 拒）。追踪文档 `docs/archived/2026-11-15-plan-mode-non-flow-control.md`。

- ponytail 包移除（2026-11-15 完成）: 按用户裁定从项目**整体移除** `ponytail`（连同包目录下的 `src/` / `tests/` / `docs/` / 构建产物与 `e2e/ponytail.test.ts`, 42 包 → 41 包 / 41 插件 → 40 插件）。计数与挂载面全量同步: `AGENTS.md` / 根 `README.md` / `README.zh.md` / `docs/PACKAGES.md` / `docs/ROADMAP.md` / `docs/WORKFLOW-STANDARD.md` / `docs/DEVELOPMENT.md` / `md-logic` 与 `security-guard` README / `dev/standard/index.mjs`（计数校验 42/41 → 41/40）/ `scripts/install.sh` 与 `test-parallel.sh` 枚举 / `scripts/test-install.sh`（夹具换 term-check, 124 项含 41 包断言）/ `scripts/audit-injection-channels.sh`（T4 段与列表移除）/ `profiles/example/cordis.patch.yml` 停挂块 / `profiles/README.md` / `docs/ARCHITECTURE-REUSE.md` / `preference-analysis` README; 调研文档移入 `archive/ponytail-investigation.md`。验证: check / build / test 全绿、e2e 43/43（原 43/44 唯一红消除）、check:docs 122 篇 0 错误、test-install 124 项全过。追踪文档 `docs/archived/2026-11-15-ponytail-removal.md`。残留: `docs/STATUS.md` 由用户择时更新。

- plan 模式段位展示（2026-11-15 完成）: 标题行符号区加 plan 段位——`plan` 图标按段四态着色（灰=未进模式 / 青=探索 / 黄=计划 / 绿=实施）, 数据源懒读 plan-mode 服务面 `planStage.current(sessionId)`（随状态行 ticker 保鲜, 未挂载 / null 按灰）, 不再读宿主 plan/mode; 顺带按用户裁定把工作流符号（plan / flow-track）排到符号区最右、与其余符号（sandbox / policy / verbose / symbol-unify / bell / daemon）以 `•` 圆点分隔。改动: `TUI/src/app/app-deps.ts` / `main.ts` / `state/*`（plan-stage action 三件套）/ `runtime/wiring.ts` / `lifecycle.ts` / `layout/title-bar.ts`, 冻结基线重冻 + title-bar 测试更新。验证: TUI 1891 项全过（含段位四态与分隔新用例）, 全仓 check / build / test 全绿, check:docs 通过。追踪文档 `docs/archived/2026-11-15-plan-stage-display.md`。

- TUI 性能读数显示节奏调整（2026-11-15 完成）: 状态行「首字节延时 + 解码速率」改「计算与显示分离」——计算仍随每条 chunk 快速累积（estTokens / firstChunkTime）, `performance` 事件投递节流从 250ms 拉长到 **1000ms**（数字每秒最多更新 1 次）; 速率口径从「首块以来累计平均」改为 **1s 窗口采样**（上一采样以来的 Δtoken ÷ Δ时间 ≈ 每秒产出 token）, `perf.ts` 增 `lastSampleAt` / `lastSampleTokens`, `emitLivePerformance` 采样写回; TTFB 口径、收尾归零、非流式回落均不变。改动: `TUI/src/app/adapter/perf.ts` / `dsh-events.ts` / `TUI/tests/adapter.dsh.test.ts`（B1 重写 + 新增 B2 窗口速率判定）。验证: TUI 1892 项全过（+1）, 全仓 check / build 全绿, check:docs 通过。追踪文档 `docs/archived/2026-11-15-tui-perf-display-cadence.md`。

- 子代理写调用继承父会话阶段（2026-11-15 完成）: plan-mode 的 `tools/pre-execute` 在直接映射缺失时沿 `parentSession` 父会话链上溯（`ancestor.ts` 新增 `nearestPlanRecord` / `makeParentReader`, 上限 24 跳, 经 `agents` 服务逐级读 `session.header.parentSession`）, 任一祖先落在探索 / 计划只读段 → 按同一判定核拒写, 回执追加「继承自父会话 plan 只读段」; 直接命中优先, `workflow` / `task_execute` 发起硬拦保留, 子进程子代理不覆盖（宿主 sandbox 创建时快照继承兜文件层, 边界记录）。改动: `plan-mode/src/ancestor.ts`（新增）/ `index.ts` / `tests/ancestor.test.ts`（新增 6 例）/ `tests/index.test.ts`（新增 4 例）/ `README.md`。验证: plan-mode 63 例全过, 全仓 check / test / build 全绿, check:docs 通过。追踪文档 `docs/archived/2026-11-15-subagent-stage-inherit.md`。

- 宿主 0.2.2-rc.3 升级与接口对照（2026-11-15 完成）: 确认官方新 rc 为 `0.2.2-rc.2` / `rc.3`（npm `next` 通道, `latest` 仍 rc.1）；对照 rc.1 → rc.3 的包增删（372 → 374, +11 / −9）、事件 +11 无删除、工具面（`wait_agent` / `office_*` / `user_terminal_*`, 出厂关闭 `interrupt_agent`）、工具管线（`ToolGuardDenial` / `block.info` / `ABORTED` 归类）、`Session.append` 数组重载、`subagents` 服务方法增删, 产出 15 行本仓影响判定与无影响面清单；另发现既有退化 `ctx.subagents.start` 自 0.2.1-alpha.1 起已由 `startActivation()` 取代（已另开条目并定为升级前置）。升级未实装（用户裁定先修退化再升级）。追踪文档 `docs/archived/2026-11-15-host-upgrade-0.2.2-rc.3.md`, 对照文档 `docs/host/HOST-UPGRADE-0.2.2-rc.3.md`。

- 子代理委派改走 `startActivation()` + 宿主升级 `0.2.2-rc.3` 与收尾（2026-11-16 完成，提交 `42c03d38` / `f37f9ed9` / `39e8e862` / `06f08dd5`，关闭提交 `ff08cff9`）: 代码面三处 `ctx.subagents.start` → `startActivation(spec)`（`task-engine` / `command-template` / TUI `/council`；计量改经 `agents.get(childId)`、`command-template` 去 `settleRun` / 服务面 `list`、`/council` provider 修正为 `spawn`）；`install.sh` 默认版本与仓库版本串 / 双锁文件抬到 rc.3（根 `engines.node` ≥24.9、profile 账号包名注释同步）；宿主已实装 rc.3（安装树 337 / 326、`dsh-base` rc.3、官方活跃 102）；`HOST-UPGRADE` §12 安装树实测、`HOST-PACKAGES` 计数与 rc.3 挂载复测、`security-guard` 工具面说明同步；check / 全仓 test / e2e（task-engine、command-template）/ startActivation 真宿主探针全过。追踪文档 `docs/archived/2026-11-16-start-activation-upgrade.md`。残留: `HOST-PACKAGES` §2 行清单全量重排（§6 方法学）与 `/council` TUI 实机确认。

- 接入官方 Agent Teams（team）（2026-11-16 完成, 提交 `5afca691` / `f16dc4d0` / `6be9bd01` / `4ef137a4` / `11338de2`）: 配置开关（`profiles/example/cordis.patch.yml` 的 `agent-team` 行 `config.defaultEnabled: true`）+ TUI 标题行 symbol（`fa-users` U+F0C0, 常驻、生效绿 / 未生效灰, 工作流组最右, 懒读 `agentTeams.isEnabled(root)`）+ 工具面放行（tool-consult `plainWhenTools` 条件豁免, `team_task_*` 与 `web_search` / `web_fetch` 按普通工具 shadow + 咨询揭示; security-guard 核对不命中不登记）。验证: 全仓 check / build / test 全绿（TUI 1893、tool-consult 100+11、agent-group 111 等）+ check:docs 通过。追踪文档 `docs/archived/2026-11-16-agent-team-adoption.md`。

- task_stop 人工门禁不弹审批面板（2026-11-16 完成）: 根因 = task-engine 在 **apply 期**同步 `ctx.get("approval")` 快照, 该时刻宿主 approval 服务 fiber 未激活 → 恒 undefined → human 级验收**静默** fail-closed（无 `approval/asked`、无 waterfall、无应答者、无告警）; TUI 桥本身接线完整。修复: `approveVia` 改**执行期惰性解析**（工具 exec ctx → 插件 ctx, 与 `serviceResolver` 同口径）, 并按官方管道口径补传 `exec.signal`。守成测试: `assemble` 加 `late-allowed` 模式（服务 apply 后才注入, 模拟宿主 boot 顺序）+ 集成用例「审批服务 apply 期缺席、执行期到场」; 反向验证旧实现下新用例红。验证: task-engine 203 + 集成（新用例绿）/ 全仓 check / test 全绿; 真实宿主 e2e 复现脚本确认 `approval/request` 应答者被调用、`allowed-once` 后 `{ok:true, next:null}`。追踪文档 `docs/archived/2026-11-16-task-stop-approval.md`。残留: TUI 面板最终真机呈现留人工; 既有失败两条（tool-surface 参数 schema 断言过时）另开条目。

- 修复 flow 流程记录删除失败的外键问题（2026-11-16 完成, 提交 `f35121cd`）: `memory-base` `evict` 重算 `sources.chunk_count` 的遍历面改走枚举库中实际存在的业务分类表（新增 `#kindTables()`, 取 `sqlite_master` 中 `kind_*` 且非 FTS/影子表）, 不再只统计当前进程已注册的 kind——残留未注册分类表仍引用 source 时不再被漏计, 避免 chunk_count 误算 0 后 `DELETE sources` 触发外键失败。复现与修复见追踪文档 `docs/archived/2026-11-16-flow-remove-fk.md`; memory-base 91 例全绿, 全仓 check / test 全绿。

- plan 段位配色调整：探索与计划合并青 / 实施改黄 / 新增「选中未建树」绿（2026-11-16 完成, 未提交）: 修复 `/flow-arbiter select plan` 后标题栏 plan 符号恒灰（根因 = 只读段位, 选中流程不建树 → 服务面返回 null）; plan-mode `planStageCurrent` 无映射分支读 `flowArbiter.current`, 选中 plan → 报带外态 `idle`（绿）; TUI 标题栏配色改四态（灰=未选中 / 绿=idle / 青=explore|plan 合并 / 黄=implement）; 阶段注入与只读拦截文案不改。改动: `plan-mode/src/index.ts` / `TUI/src/app/{layout/title-bar,runtime/wiring,app-deps,state/types}.ts` + 双侧测试。追踪文档 `docs/archived/2026-11-16-plan-stage-color.md`。

- 收口 task-engine 集成测试两条过时断言（2026-11-16 完成, 未提交）: 经用户裁定按**路径 A**（tool-surface 包装层语义）只改测试不改产品码——注册面改断言为宽松占位, 完整 schema 改经 `lookupSurface` 从 catalog 断言; 缺必填改断言抛 `ToolArgsError`（`INVALID_ARGS`）, 非法 executor 的 `{ok:false, feedback}` 回执保留。`task-engine/tests/integration/plugin.test.ts`; 追踪文档 `docs/archived/2026-11-16-task-engine-integration-schema.md`; 集成 18 例全绿, 全仓 check 通过。§2 未完成项至此清零。

- TUI slash 命令冲突与过时项清理（2026-11-17 完成, 未提交）: 按用户裁定合并单一入口——删 `/flow-track` 的 `on|off`（进程级注入开关 `switch.ts` 移除）, 注入门槛改「配置 `enabled` ✓ 本会话经 flow-arbiter 选中的流程 ✓ 有未完成流程记录」, 服务面 `enabled(sessionId?)` / `summary(sessionId?)` 按会话派生, TUI 标题栏与状态列按 `activeSessionId` 读取, `/flow-track` 只留 `status`; 全量排查确认唯一其它实质重叠为 `/collapse` 与 `/verbose`, 用户裁定保留两命令仅文案澄清（/help 已对齐实际语法）; `/help` 补 `/new` `/config` `/group` `/detect-char-width`、修 `/collapse` `/verbose`、补 `/session clean`; 文档计数同步（`COMMANDS.md` 44→45 且 §1.2 补本仓插件注册 5 条、`COMMANDS-SPEC.md` 40→45）。验证: flow-track check/build/test（85 例）✓、TUI test:tui 1894 例 ✓、demo --smoke 42 项 PASS ✓、全量 e2e 43/43 ✓、全仓 check/build/test/check:docs ✓。追踪文档 `docs/archived/2026-11-17-tui-command-cleanup.md`。实施中曾受「plan 只读预设恢复未生效」阻塞（另立条目, 用户人工放开权限后续上）。

## 2. 未完成项

> 顺序依据：**修复类置顶 → 依赖链 → 工作量升序**（2026-11-03 用户裁定重排并重新编号, 取代 2026-10-18 的「修复类优先 → 依赖深度升序 → 工作量升序」; 组内先看前置关系, 有前置项排在各自前置之后, 再按工作量升序）；同工时任「缺陷优先于行为改动 → 高优先级优先 → 保持原相对顺序」。前置关系另写在各条行内与「实现顺序」表。模块级条目按标题 + 文件路径引用（如 `md-logic/docs/BACKLOG.md`）。优先级：P0 > P1 > P2 > P3。
> 历史（2026-09 至 2026-10-22）：本节关闭过的条目（含两次清空、多次重排与重编号）追踪文档全在 `docs/archived/`，按主题索引如下；本清单不再逐条保留关闭注记。
>
> - 知识库 / 记忆：`2026-10-07-knowledge-memory-lifecycle.md`、`2026-10-17-output-compress-scope-handle.md`、`2026-10-20-bgdaemon-memory-backend.md`、`2026-10-22-memory-hybrid-retrieval.md`
> - 新插件落地：`2026-10-15-md-table-check.md`、`2026-10-16-auto-approval-design.md`、`2026-10-16-script-interpreter-design.md`、`2026-10-19-timer-plugin.md`、`2026-10-21-behavior-correction.md`、`2026-10-22-herdr-use-rename.md`
> - 审计 / 宿主面：`2026-10-02-reuse-audit.md`、`2026-10-19-reuse-reaudit.md`、`2026-10-02-host-upgrade-0.2.0-rc.2.md`、`2026-10-21-host-upgrade-0.2.1-rc.2.md`
> - 跨会话与通知：`2026-09-30-cross-session-delegation.md`、`2026-10-20-notice-history-query.md`、`2026-10-20-agent-status-board.md`
> - 文档与流程：`2026-10-18-plugin-docs-refresh.md`、`2026-10-22-docs-consistency.md`

### 实现顺序与并行分组（2026-10-24 收束）

2026-10-24 起**没有在跑的并行分组**：A 至 I 各组的条目已全部关闭（条目 4 / 6 / 7 与 TUI `#3`、项目级 `3. coagent` 均在 2026-10-23 至 2026-10-24 关闭）。分组口径与写入范围约定保留在 `docs/WORKFLOW-STANDARD.md`，将来有新条目再按「组内串行、组间并行」重新分组。

- plan 只读预设恢复未生效（2026-11-17 登记, 待处理）：`plan_start` 进入时把会话权限预设从 `workspace-write` 切到 `read-only`（`presetSwitched: true`）；计划段终态后 plan-mode 靠 `pinNotes.hold("plan-mode")` 的轮询 provider 在宿主 agent-loop 每步（pre-step）检查 `planTerminal` 并 `restorePreset` 切回原预设。实测本会话任务树计划段已 done 但 DSH 文件策略仍停留在 `read-only`（写操作被站位档拦、需逐操作提升审批），疑似 provider 在任务帧推进为主的会话里未被触发、或 `ctx.get("taskEngine")` 在插件侧解析不到导致 `planTerminal` 恒 false（两分支均静默不告警）。临时手段：`/permission workspace-write` 手动切回（plan-mode 有"用户手动改过则不覆盖"保护，不会回切）；或 `flow_select` 切走触发「切走」恢复。待查明 provider 未触发的确切原因并补事件/显式触发路径。

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

（当前无挂起项；原 `deepseek-account` 条目已于 2026-11-16 用户裁定删除不立项, 要点见 §1 已取消注记。）
