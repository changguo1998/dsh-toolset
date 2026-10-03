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

- `md-map`：新建第 19 个插件包（文档版 `code-map`：标题锚点 / 跨文档链接 / wiki / 代码文件引用 / 被引计数，查询 `callers` / `impact` / `orphans` / `report`；单文件解析复用 `md-logic`；36 例测试；追踪文档 `docs/archived/2026-10-02-md-map-package.md`）。

- command-template 终态与回收：`playbook` 等命令的子代理步骤改为**与取消信号竞速**（`start` 与宿主结算面都在竞速内），abort 路径**发起但不等待**回收（宿主 in-process `dispose()` 内部 `await run.result`，等它等于换个地方无界等待）；修掉真机「命令悬挂、无 `command/done`」的根因面（本仓侧任何路径都回终态，文案区分「被调用方取消」/「步骤超时（N ms）」并带子会话 id）；19 例测试（含宿主语义 dispose / start 悬挂 / 迟到 reject 三个回归点），全仓 20 包全绿（追踪文档 `docs/archived/2026-10-02-command-template-terminal-state.md`）。

- task-engine 计量口径（usage → 权威信号）：subagent 用量改读宿主 `tokenUsage` 投影（`sessionProjections.stateOf`＝provider 上报的**累计**输出 token；尚无样本 / 服务缺失 / 抛错时回退 `tokenMeter` 的 pressure 口径），**超预算判定改用宿主权威信号** `stopReason === "max-tokens"`——不做 tokens 数值比较（审阅用真实会话日志回放 12 个 spawn 子会话：totals 6–81,955 vs 实际预算 256/512/4000，数值比较会 10/12 恒真）；72 例单测 + `smoke:executor` 扩 4 条断言，全仓 20 包全绿（追踪文档 `docs/archived/2026-10-02-task-engine-usage-metric.md`）。

- `md-logic`：新建第 18 个插件包（Markdown 逻辑结构：节树 + 块 + 链接清单，带行范围；解析用 `marked` 真实 CommonMark），注册模型侧工具 `md_logic`（structure / blocks / links）并与 `fs_digest` 双向指路；接线 9 处（含补齐根 check/build 链与 test-parallel 的既有漏项）；34 例测试 + 全仓 19 包全绿（追踪文档 `docs/archived/2026-10-02-md-logic-package.md`）。

- `ast-tools` 模型侧工具：注册 `ast_query`（action 分派：search / outline / rules，AST 形态与元变量捕获）与 `ast_replace`（默认 dry-run，写回需 `write:true`）；缺 ast-grep 二进制时注册降级版（调用返回含安装指引的 error）；模型侧行号渲染为 1 基，描述里写明与 `grep` / `glob` / `fs_digest` / `code_map` / `hash_edit` 的选择成本（追踪文档 `docs/archived/2026-10-02-ast-tools-model-tools.md`）。

- Markdown 结构视图：`fs_digest` 的 Markdown `outline` 现在给**每节行范围**（含端点、尾空行不计、父子包含）与**块级结构清单**（list / table / code / quote / frontmatter，带 `§L{节}` 归属）；标题树 45 行 + 块清单 15 行两个独立预算；导出 `scanMarkdown` 供 `md-logic` 复用（追踪文档 `docs/archived/2026-10-02-markdown-structure-view.md`）。

- 复用审计：官方包与本仓 18 包逐项对照的「改用 / 保留 / 并存」结论（**改用 0 / 保留 12 / 并存 6**）与 5 项改造点，见 `docs/ARCHITECTURE-REUSE.md`（追踪文档 `docs/archived/2026-10-02-reuse-audit.md`）。

- profile 挂载面：**扩张到 base + 本仓 18 包 + 10 个官方行**（2026-10-02：`session-stats` / `session-turn-outline` / `session-reference` / `message-feedback` / `workspace-changes` / `file-reference-local` / `terminal` / `terminal-bash` / `invariants` / `workspace`；全部为投影 / 服务 / 事件面扩展，排除口径与第二批选题见 `docs/archived/2026-10-02-profile-mount-expansion.md`）。

- 宿主运行基线：**已升到 `dsh 0.2.0-rc.2`**（2026-10-02：全局安装 + profile 树外加装包 `session-title-all-prompts-llm` 同步 + `scripts/install.sh` 默认版本 + 主要版本引用（含 5 个包 smoke 脚本的宿主门槛）；进程外与进程内验证见追踪文档 `docs/archived/2026-10-02-host-upgrade-execution.md`）。

## 2. 未完成项

> 扁平清单，**按条目间逻辑依赖排序**（2026-10-02 依赖重排：编号即先后顺序；同层先小后大。编号仅供阅读，随整理重编）。
> 顺序依据（2026-10-02 重排：编号即先后顺序；先安全现值风险，再独立缺口，后低优先与收尾类）：**① 已完成十件**——接口对照汇总、宿主升级、profile 挂载面扩张、复用官方包审计、Markdown 结构视图、`ast-tools` 模型侧工具、`md-logic` 建包、`md-map` 建包、task-engine 计量口径、command-template 终态与回收（见 §1）。**② `#1`→`#2` 同一特性先行**：`unknownToolPolicy` 逃生门（现值开 deny 会拦死在用的 `present`/`workflow`，P1）→ 两处缺口补齐（口径定稿后写断言，P2）。**③ `#3`** task-engine 命令执行期复查（真实安全缺口，独立可做，P1）。**④ `#4`** executor 自建简易 worktree 隔离（**已解阻**：不依赖第三方插件，用户 2026-10-02 裁定）。**⑤ `#5`** metric-loop 复查缝低优先项（P3）。**⑥ `#6`** `docs/STATUS.md` 对齐（收尾类，需前面状态定稿后一次写准；由用户择时）。**⑦ 模块级建议顺序**：`md-logic` 混合换行（数据破坏风险）→ `hash-edit` 会话 cwd → `md-logic` `content` 校验 → `md-map` ref 口径 → `md-logic` 节级 hash → `task-engine` 裁决 toolFilter → `command-template` 全局预算 → `command-template` `DESIGN.md`。优先级：P0 > P1 > P2。

| # | 功能 | 来源 | 落点（复用） | 工作量（估） | 优先级 |
|---|------|------|--------------|--------------|--------|

**未立项观察项**（暂不单独立项，作为后续可选项）：意图/多策略检索（knowledge-base 已双 FTS5，距 BM25+RRF+proximity 一步）、MCP 脚本化（mcpScript）、活动工具交互管理。

**复用审计产出（`docs/ARCHITECTURE-REUSE.md` §4，未立项）**：A `context-report` 改用已挂的 `sessionStats` / `turnOutline` 投影补轮次 / 墙钟 / 大纲；B `output-compress` 写清与官方 `spill-policy` / `compaction-tool-result-pruner` 的分工与阈值语义（实测**不存在**双重截断）；C `metric-loop` 唤醒链补 `@deepseek-ai/dsh-schedule`（**会新增模型工具面**，需用户裁定；备选是改用已挂的 `tool-ralph` / `goal-round-driver` 承担循环）；D `hash-edit` / `fs-digest` 可选改用 `ctx.fs`（含行为变更：hash-edit 写侧将受 workspace-write 围栏，宜与 render 缺陷同批）；E 「可挂但不该挂」清单一律落非生成型文档（本文件 / `profiles/example` 注释），勿写入会重生成的 `HOST-PACKAGES.md`。观察项：① `knowledge-base` ⇄ `output-compress` 共库直写的隐私边界；② 是否开启 `session-query-sqlite` 的 FTS5（`openAt: first-search`）并与知识库分工；③ `rule-engine` 与官方 `repeat-tool-reminder` 的注入重复度。

| 1 | **`docs/STATUS.md` 对齐现状**：该表为用户择时更新的对照文档，当前多处过期——① 「总览」称「12 个插件全部完成」，而状态表缺 `rule-engine` / `symbol-normalizer` / `session-channel` / `session-title-cutoff`（`command-template` 的模板体系也已落地）；② 「剩余 P2 插件（workflow-ext / web-ext / session-broker / command-template）未开始」中 `command-template` 已完成；③ `fs-digest` 行注记「缺陷见 `fs-digest/docs/BACKLOG.md` D1」，而该文件现为「当前无未完成项」；④ 各行单测数为 2026-09 快照（如 knowledge-base 已 39 → 57）。期望：逐包核对后整表回写（含新增包行与单测数），或明确该表只维护 P0/P1 子集 | 「task-engine 执行扩展」收尾审计 + 用户 2026-10-02 指示「更新 backlog」 | `docs/STATUS.md`（用户择时更新；本次仅登记） | 1 h | P2 |
| 2 | **dsh 启动告警：`1 entry did not activate. message-feedback ValidationError`（用户 2026-10-02 报）**：定位 —— `message-feedback` 是**官方宿主插件** `@deepseek-ai/dsh-message-feedback`，由本仓「挂载面扩张」工作挂进 profile：`~/.dsh/profiles/fff/cordis.patch.yml:503-504`（示例见 `profiles/example/cordis.patch.yml:112`；记录见 `docs/archived/2026-10-02-profile-mount-expansion.md` 与 `docs/host/HOST-PACKAGES.md:45`）。该 entry **激活失败（配置校验 ValidationError）** → 功能未生效。排查方向：① 读宿主包的类型/README 确认其 Config schema 必修字段；② 对照示例挂载与我们的 config 差异（可能缺字段或字段类型不符）；③ 修 profile patch（在 `~/.dsh` 下，需用户授权的写权限）或调整挂载；④ 复跑 `dsh --profile fff` 确认告警消失、功能可用；⑤ 把结论回写 `docs/host/HOST-PACKAGES.md` 的挂载清单 | 用户报障（起因：profile 挂载面扩张） | `~/.dsh/profiles/fff/cordis.patch.yml`（用户侧）+ 宿主 `@deepseek-ai/dsh-message-feedback` + `docs/host/` | 1-2 h | P2 |
| 3 | **TUI：工具调用成功后总是「对勾 +（无结果）」（用户 2026-10-02 报）—— 核对设计意图与实现是否一致**：现象 —— 成功但无文本输出的工具（如 `write` / `edit` / `hash_edit` 一类）在完成行显示 `✓`（或等价状态符）同时带「（无结果）」字样，观感像「失败了没输出」。要做的：① 找设计意图 —— 读 `TUI/docs/SPEC.md`（渲染规格）、`TUI/docs/COMMANDS-SPEC.md`、`TUI/docs/DESIGN.md` 中关于**工具结果区 / 空结果 / 完成行文案**的约定（是否有「空结果不显示」或「无结果属正常提示」的明文）；② 核对实现 —— `TUI/src/renderer/` 与 `TUI/src/app/` 里工具结果/完成行的渲染分支（空字符串 vs 无 output 字段 vs 仅 status）；③ 结论两态：若实现与设计**一致** → 说明设计意图是否合理（考虑把「（无结果）」改为更中性的文案或仅在失败时显示），走设计变更；若**不一致** → 按设计修实现，并补测试（成功 + 空 output、成功 + 有 output、失败 三态）；④ 反向验证（撤修复 → 用例必红） | 用户报障（疑似观感问题；先判定再动手） | `TUI/docs/SPEC.md` + `TUI/src/renderer/` + `TUI/src/app/` | 1-2 h | P2 |
| 4 | **goal 状态行只显示 `phase`，需同时显示 `activation`（用状态符号）（用户 2026-10-02 提）**：现象 —— 状态位只给 `active`/`paused` 一类生命周期值，**看不出宿主是否会自动续轮**（armed = 自动接续；disarmed = 需用户驱动，重启/恢复后宿主默认 disarm）。要做的：① 找渲染 goal 状态的组件（疑似 `TUI/src/app/state.ts` / `layout.ts` / `renderer/` 的状态栏；亦查 `goal-contract/` 与 `context_report` 的 goal 视图——当前 `TUI/src` 内**没有** `activation`/`armed` 字样，说明该维度未接）；② **符号方案（用户 2026-10-02 定稿中）**：`phase` —— **`▷`** = active（空心右三角，**绿色**）、**`⏸`（U+23F8，**黄色**）** = paused（用户定；因该字符 `Emoji_Presentation=false`，默认文本呈现，**可着色**；实现时建议紧随 `U+FE0E`（VS15）请求文本呈现，防终端自行彩色化）、**`✓`** = complete（**绿色**）；**`△`（U+25B3 空心上三角，**黄色**）= blocked（用户定；无 emoji 属性、单列可着色）**；`activation`（armed/disarmed）**符号待定**；③ 取值口径（已核宿主机码 `@deepseek-ai/dsh-goal`）：phase = `active` / `paused` / `blocked` / **`complete`**（注意是 complete，非 completed）；activation = `armed` / `disarmed`。**`blocked` 语义**（勿当错误退出）：目标因**具体外部阻塞条件**卡住而停止推进，须带 `blocked_reason`（`{code: lower-kebab-case, message}`）；按流程约束，同一阻塞条件需**连续 ≥3 轮**才允许标记，且「困难 / 不确定 / 还有活干」不算 blocked。**可恢复**：`resume`（**须人类直接请求**）可重新激活，但受「合法相位转换 + 轮次预算未耗尽」约束（宿主拒绝时报 `invalid phase transition or exhausted round budget`）；④ 覆盖三态测试：选定符号的两态 + resume 后转 armed；⑤ 反向验证（撤显示 → 用例必红）；⑥ 文案与 `docs/STATUS.md` 口径一致（该文件仍由用户择时更新） | 用户提（起因：会话重启后 goal 被 disarm，界面上看不出来） | `TUI/src/app/` + `TUI/src/renderer/` + `TUI/docs/SPEC.md` | 2-3 h | P2 |

## 3. 里程碑

1. 里程碑一（P0，引擎三块 + 知识库底座）与里程碑二（P1：goal-contract / metric-loop、知识库记忆层与淘汰提升、fan-out 就绪池、hash-edit / ast-tools、security-guard / herdr-integration 等）均已完成。
1. 里程碑三（P1/P2）剩余（2026-10-02 command-template 终态条目完成后重编，编号即顺序）：executor 隔离落地（`#1`，阻塞于外部插件）→ `docs/STATUS.md` 对齐现状（`#2`），按需排期；已完成项与已取消 / 不再立项项见 §1 索引。
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
