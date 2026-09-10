# 待开发功能清单

> 依据：`AGENT-ARCHITECTURE-ANALOGY.md`（架构设计与接口对照 §16）+ `PI-DSH-FEATURE-COMPARISON.md`（迁移基线 §3/§4）。
> 基线：dsh `0.1.2-rc.1`（a66e470204）；两文档中重叠项已合并（list↔任务树序列化、audit↔RET 验收路由、glla goal↔契约起草）。
> 优先级：**P0** 架构主线（设计文档 §16"自建三块"+ 对比文档 §4.3 前两位）；**P1** 核心体验补齐；**P2** 长尾。

## 1. 任务控制与执行引擎（P0 主线）

设计文档 §16.1 自建三块 + glla 拆分（对比文档 §3.1）合流。

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 1 | **TaskStack 引擎服务**：Frame 状态机、decompose/pop、join 续体、就绪池、并行度上限、bounded retry；帧事件溯源（`plan/node-expanded` + 内存树 + 周期快照） | 设计 §13/§15/§16.1-A | storage-sqlite（快照）、`session.append`+`ignorable`、`SessionSeq` | P0 |
| 2 | **模型侧工具族**：`decompose`/`implement`/`stop`/`status` + 嵌套任务列表（`parent_id`+`order`；tool-todo 仅扁平） | 设计 §10/§16.1-B；pi-glla list 拆项 | `outputSchema` → `SubagentResult.structured` | P0 |
| 3 | **分解双重校验门禁**：粒度四规则（机械）+ coverage 映射（机械拒绝）+ 语义蕴含（audit run 裁决）；拒绝带反馈打回 | 设计 §17.2 | 引擎内实现；语义级复用子代理 audit run | P0 |
| 4 | **RET 验收路由器**（= glla audit）：mechanical（命令退出码）/ semantic（独立 audit run + outputSchema）/ human（approval 链） | 设计 §17.4；pi-glla audit 拆项 | `ctx.approval`（注意 turn-enclosed 约束，后台作业 fail-closed） | P0 |
| 5 | step 级裁决补齐：事件流/决策输出补 `accepted`、`next` 字段与 step 级 validator | 设计 §8/§11.2 | 随引擎落地 | P1 |
| 6 | goal 契约起草：interview 起草、契约 = spec（P）+ acceptance（Q）三级 + verificationContract | 设计 §17.1；pi-glla goal 拆项 | dsh-goal + goal-round-driver + tool-ask-user | P1 |
| 7 | loop 指标驱动自动循环：measure 命令、plateau 停止、边界上限、cadence 唤醒 | pi-glla loop 拆项；设计 §6 | workflow + worker-thread + schedule 拼装 | P1 |

依赖：#2-#4 依赖 #1；#6 的契约结构被 #3/#4 引用。

## 2. 知识库与记忆（P0 主线）

设计文档 §12（L4）+ context-mode / hermes-memory 迁移（对比文档 §3.2）合流。

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 8 | **跨会话知识库**：sources/chunks 四表结构 + 双 FTS5（porter+trigram，external content + TRIGGER 写直达）；接口 `ctx_knowledge: search/put/touch/evict` | 设计 §12.1；context-mode 拆项 2/3 | storage-sqlite、session-query-sqlite（FTS5 底座）、独立 SQLite 库 | P0 |
| 9 | 两级写策略与淘汰提升：写直达（事件过滤器）/ 批量写回（consolidation 锁 + backfill 兜底）；LRU+importance 淘汰、resume top-K 提升 | 设计 §12.2-§12.4；hermes auto-consolidation 拆项 | RET 时经引擎回调写回（设计 §13.3） | P1 |
| 10 | 持久记忆 CRUD 与检索：token-aware memory_add/replace/remove + target/category/项目过滤 | hermes 拆项 1/2 | 知识库同底座（target/category 列） | P1 |
| 11 | 大输出压缩入库：沙箱内派生摘要 + auto-index，原字节不进上下文；确定性压缩 | context-mode 拆项 4；hypa 拆项 1 | code-runtime + output-retention + spill 扩展 | P1 |
| 12 | 上下文感知文件读取：outline/signatures/pruned 模式 | hypa 拆项 2 | tool-fs + tool-lsp | P2 |

依赖：#9-#11 依赖 #8。

## 3. 子代理与编排（P1-P2）

dynamic-workflows 迁移（对比文档 §3.1）；核心并发能力 dsh 已满足（设计文档 §16.2 ✅ 项）。

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 13 | fan-out 编排：shared task DAG 承载并行分支 | dynamic-workflows 拆项 1；设计 §14.2/§15.2 | experimental-agent-team（DAG）、`ctx.subagents.start()` 多 run | P1 |
| 14 | 工作流内模型路由与成本核算 | dynamic-workflows 拆项 2/3 | agent-default-model、token-meter | P2 |
| 15 | resume 断点续跑、git-worktree 完整隔离 | 拆项 4/5 | session 事件源续跑；自研 dsh-git-worktree 插件补隔离 | P2 |
| 16 | /workflows 交互面板（TUI） | 拆项 6 | dsh-toolset TUI 新面板 | P2 |
| 17 | 模板化 pattern（deep-research / code-review 等五族） | 拆项 7；pi-simplify/ponytail 工具族可并入 | workflow 脚本内容 + skill 内容资产 | P2 |
| 18 | advisor / council 二次意见 | 对比 §3.5 | tool-ralph / tool-subagent + 模型路由 | P2 |

## 4. 代码与文件（P1-P2）

readseek / lens / hypa 迁移（对比文档 §3.2/§3.4）。

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 19 | LINE:HASH 锚定编辑（行:哈希校验，防脏写） | readseek 拆项 1 | tool-fs + fs-observation-policy（当前仅版本守卫） | P1 |
| 20 | ast-grep 结构搜索/替换/大纲/规则 | readseek 拆项 2；lens 拆项 3 | 新工具（tool-fs-search 仅 ripgrep 文本） | P1 |
| 21 | 项目/模块报告（结构总览、影响面） | lens 拆项 4 | tool-lsp 符号数据可作底座 | P2 |
| 22 | 代码索引与调用图（callers/graph） | hypa 拆项 3 | tool-lsp 扩展 | P2 |
| 23 | PDF/文档结构视图 | readseek 拆项 4 | 无底座，新工具 | P2 |

## 5. 外部接入（P2）

web-access 迁移（对比文档 §3.4）。

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 24 | 搜索 provider 扩充（多引擎聚合） | web-access 拆项 1 | search-deepseek/exa/perplexity 面上扩 | P2 |
| 25 | GitHub 仓库克隆 | 拆项 3 | 可先经 shell | P2 |
| 26 | PDF 提取、视频理解 | 拆项 4/5 | 无底座，新工具 | P2 |

## 6. 安全治理（P1-P2）

defender 迁移（对比文档 §3.5）。

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 27 | 危险命令黑名单拦截 + 敏感文件保护策略层 | pi-defender | sandbox / bash-sandbox / permission-presets 之上加策略层（当前是沙箱强制，非黑名单语义） | P1 |
| 28 | 密文扫描 | hermes 拆项 4 | credentials 面扩展 | P2 |
| 29 | 安全 issue 上报 | pi-defender | 无对应 | P2 |

## 7. 交互与资产（P1-P2）

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 30 | 跨会话 broker（消息/委托/状态同步） | pi-intercom | 无底座；webhook/acp/sdk 均非等效 | P2 |
| 31 | slash 命令模板（pre-steps/chain/best-of-N）+ 模板级模型选择 | pi-prompt-template-model | commands + workflow | P2 |
| 32 | 近期改动代码审查 | pi-simplify | 可并入 #17 模板族 | P2 |
| 33 | 完成/等待声音提醒 | notify-sound（原生） | TUI 扩展 | P2 |
| 34 | 上下文压力/token 报告 | supi-context | token-meter + session-stats 形态对齐 | P2 |
| 35 | provider 流量控制：限流遥测 + AIMD 咨询守卫（退避等待转 advisory、令牌桶、rate_check 工具） | rate-guard（pi 原生扩展） | llm-retry 上扩展遥测与 AIMD | P2（暂缓，先不实现） |
| 36 | herdr 面板集成：agent 状态 socket 上报、blocked 事件桥（含 ask-user blocked → herdr blocked） | herdr-agent-state / herdr-ask-user-question（pi 原生扩展） | 新建；协议仿 pi 原生（HERDR_ENV / HERDR_SOCKET_PATH / HERDR_PANE_ID + unix socket） | P1 |

## 排序原则与里程碑

1. **里程碑一（P0）**：#1-#4 + #8 —— 引擎三块 + 知识库底座（设计文档 §16.3 结论：其余核心能力 dsh 已有现成服务）；
1. **里程碑二（P1）**：#5-#7、#9-#11、#13、#19-#20、#27、#36 —— 契约/循环/记忆/压缩/锚点/结构搜索/安全策略/herdr 集成；
1. **里程碑三（P2）**：其余长尾，按需排期；#35 流量控制已列入计划、暂缓实现；
1. 不迁移：pi-dsh-minimal（反向桥）、pi 原生 herdr 扩展文件、pi 内部补丁（对比文档 §4.4）；herdr 面板集成以 `herdr-integration` 仿写实现（#36）。

**起步顺序（实施建议）**：先打通流程、再上大件、双线并行：

1. **热身 `herdr-integration`（#36）**：最小、零依赖、协议可对照 pi 原生扩展仿写；用它打通新插件脚手架（`cordis.patch.yml` + `dsh.bundle`、构建部署、profile 挂载），为后续所有插件铺路；
1. **主线 `task-engine` 最小闭环（#1-#4）**：架构核心，goal-contract / metric-loop / workflow-ext 都挂其面。首版只做——栈引擎（Frame 状态机 + 就绪池，先单执行器）＋ decompose/implement/stop 工具族与嵌套 todo ＋ 门禁机械部分（粒度四规则 + coverage 映射）＋ RET 路由先上 mechanical / human 两级（semantic 级复用子代理 audit run 后补）；fan-out（#13）留第二迭代；
1. **并行线 `knowledge-base`（#8）**：与 task-engine 零依赖，可完全并行；也是 #9-#11（写回/记忆/压缩入库）的底座，越早落库积累越多；
1. **P1 小件穿插**：hash-edit、ast-tools 独立无依赖，可在主线卡壳时穿插；goal-contract 待 task-engine 契约 schema 稳定后做。

## 插件规划（实现载体）

> 每个插件 = dsh-toolset 仓库内一个包目录（以 `TUI/` 为模板：`package.json` 的 `dsh.bundle` + `cordis.patch.yml` 集成契约）；内容型资产不入插件。**命名按功能自定，不沿用 pi 插件名**（仅 ast-grep 为捆绑的底层二进制名）。#13 fan-out 并入 task-engine 的就绪池执行器（复用 agent-team DAG），不单设编排插件。

| 插件 | 阶段 | 承载清单项 | 复用（不新建） |
|------|------|-----------|----------------|
| `task-engine` | P0 | #1-#5、#13（#5 为 P1 增量） | subagents.start / fork-in-process、outputSchema、depthLimit、session.append + ignorable、SessionSeq、storage-sqlite、experimental-agent-team（DAG） |
| `knowledge-base` | P0→P1 | #8-#10 | storage-sqlite、session-query-sqlite（FTS5 模式）、session-telemetry（事件源） |
| `goal-contract` | P1 | #6 | dsh-goal、goal-round-driver、tool-ask-user；契约 schema 取自 task-engine |
| `metric-loop` | P1 | #7 | workflow + worker-thread、schedule |
| `output-compress` | P1 | #11 | code-runtime、output-retention、spill；写入走 knowledge-base 接口 |
| `fs-digest` | P1-P2 | #12 | tool-fs、tool-lsp |
| `hash-edit` | P1 | #19 | tool-fs、fs-observation-policy |
| `ast-tools` | P1 | #20 | 无（新工具，捆绑 ast-grep 二进制） |
| `security-guard` | P1-P2 | #27-#29 | sandbox、bash-sandbox、permission-presets、credentials |
| `workflow-ext` | P2 | #14-#15 | agent-default-model、token-meter、workflow-run；自研 dsh-git-worktree 补完整隔离 |
| `code-intel` | P2 | #21-#22 | tool-lsp |
| `web-ext` | P2 | #23-#26 | search-deepseek/exa/perplexity（provider 扩充）、web-fetch-http、shell（git 克隆先行） |
| `session-broker` | P2 | #30 | 无等效底座（webhook/acp/sdk 均非），新建 unix socket 通道 |
| `command-template` | P2 | #31 | commands、workflow |
| `context-report` | P2 | #34 | token-meter、session-stats |
| `rate-guard` | P2（暂缓） | #35 | llm-retry；已入计划，暂不实现 |
| `herdr-integration` | P1 | #36 | 无底座，仿 pi 原生扩展协议（unix socket + 环境变量握手） |
| TUI 包扩展 | P2 | #16、#33 | dsh-toolset TUI（新增 /workflows 面板、声音提醒） |
| 内容资产（非插件） | P2 | #17-#18、#32 | workflow 脚本 + skill 内容 |

依赖：goal-contract、metric-loop、workflow-ext 依赖 task-engine（契约/执行器面）；output-compress 依赖 knowledge-base；其余独立可并行。
