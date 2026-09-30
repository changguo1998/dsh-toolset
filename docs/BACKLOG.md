# 待开发功能清单

> 职责：待办全集：缺陷 + 功能 + 里程碑 + 插件规划
> 不负责：现状描述（见 `docs/STATUS.md`）
> 过期条件：无

> 本清单只列**未完成**项；已完成项见 `STATUS.md` 状态表（实现与验证证据在各包源码/测试与 git 历史；已完成的实施清单归入 `archive/`），不在此重复。
> 设计依据：`docs/host/AGENT-ARCHITECTURE-ANALOGY.md`（架构与接口对照）、`archive/PI-DSH-FEATURE-COMPARISON.md`（pi→dsh 迁移基线差距，归档调研）。实现时以根目录 `docs/host/DSH-CTX-API.md` 对齐宿主接口。
> 基线：dsh `dsh-v0.1.7-rc.2`（当前运行版本；旧版接口兼容项见宿主升级对照文档）。
> 编号口径：`#N` 只在本文件内唯一；与其它层 BACKLOG（如 `TUI/docs/BACKLOG.md` 的 `#n`）**互不关联**，跨层引用须写明文件路径。
> 优先级：**P0** 架构主线；**P1** 核心体验补齐；**P2** 长尾。状态标记：`[x]` 已实现（仅第 1 节索引使用）、`[~]` 部分实现（注明未含部分）、无标记 = 未实现。

## 1. 已完成索引

`[x]` 已实现并合入 main，落点如下（单测数与首版边界见状态表）：

- 任务控制：#1-#5 task-engine（Frame 状态机、工具族、双重门禁、RET 三级路由、step 裁决）、#13 fan-out 就绪池、#6 goal-contract、#7 metric-loop；
- 知识库与记忆：#8 knowledge-base（两张基表 + 两张 FTS5 虚表）、#9 两级写策略与淘汰提升、#10 持久记忆 CRUD、#11 output-compress、#12 fs-digest；
- 代码与文件：#19 hash-edit、#20 ast-tools、#21 code-map 报告与影响面、#22 结构层索引与候选调用图 + LSP 语义层（callers 的 findReferences 精确裁决，`precision:lsp/structural`；追踪文档 `docs/archived/2026-09-29-codemap-lsp-semantic.md`）；
- 上下文报告：#34 context-report（host-only 投影 `sessionContext` 折叠会话累计 + `context_report` 三档报告）；
- 安全与集成：#27 security-guard 策略层、#36 herdr-integration；
- 规则触发与符号规范：#42 rule-engine、#43 TUI 符号规则迁移（落点为 #48）、#44 next-step 注入路径、#45 仓库级集成、#46 插件注入消息 `form:'notice'` 一行提示渲染、#47 消费者框架（`registerConsumer` + `evaluate`）、#48 symbol-normalizer 插件；真机验证记录见 `docs/archived/2026-09-27-rule-engine-consumer-and-integration.md`；
- TUI：#16 /workflows 面板、#18 /council、#24 /search 多 provider 聚合、#33 声音提醒，以及 7 项纯 TUI 命令与 A1-A5（`/task` `/guard` `/memory` `/loop` `/contract`）；
- 工程流程与文档：#39 文档体系与变更规范落地（追踪文档 `docs/archived/2026-09-25-docs-workflow-rollout.md`）、#40 `TUI/docs/IMPLEMENTATION.md` 拆分删除（命令/机制 → `TUI/docs/DESIGN.md`「实现要点（机制与命令）」、渲染/排版 → `TUI/docs/SPEC.md` §15、验证 → `TUI/README.md`；追踪文档 `docs/archived/2026-09-29-tui-implementation-doc-split.md`）、#57 根 README 英文化（英文主档 `README.md` + 中文版 `README.zh.md`，`AGENTS.md` 语言约定例外与口径同步；追踪文档 `docs/archived/2026-09-30-readme-i18n.md`）。
- 运行时与宿主：#38 宿主双栈兼容垫片清理（0.1.7-rc.2 单一形态；追踪文档 `docs/archived/2026-09-29-host-single-stack-cleanup.md`）、#49 tmux 断连后 dsh 退出 → 退出前问题面板确认（追踪文档 `docs/archived/2026-09-29-exit-confirm-panel.md`）、#30 跨会话消息通道 `session-channel` 插件（专用 Redis 实例 + unix socket；追踪文档 `docs/archived/2026-09-29-cross-session-intercom.md`）、#55 跨会话共享 KV（session-channel 服务面扩展，last-value + 版本号；追踪文档 `session-channel/docs/archived/2026-09-29-shared-kv.md`）、#56 会话标题参考窗口改为「最近一次 `git commit` 之后」（新包 `session-title-cutoff`，接管 `ctx.sessionTitle` 唯一 provider；追踪文档 `session-title-cutoff/docs/archived/2026-09-29-title-cutoff-provider.md`）、#54 跨会话委托/协调（`session-channel` 任务语义：任务表 + 结果自动/显式回传 + `channel_delegate`/`channel_task`/`channel_task_result` 三工具；追踪文档 `docs/archived/2026-09-30-cross-session-delegation.md`）。
- 已取消/不再立项：#35 rate-guard（不实现，pi 侧已移除，dsh 侧由官方 `llm-retry` 覆盖，见 `archive/PI-DSH-FEATURE-COMPARISON.md` §5.1）；#25 GitHub 仓库克隆、#26 PDF 提取 / 视频理解、#28 密文扫描、#29 安全 issue 上报（用户 2026-09-29 裁定移除，不立项）；#32 近期改动代码审查、#37 preset 机制迁移评估（用户 2026-09-29 裁定直接关闭，不立项）。

## 2. 未完成项

> 扁平清单，按编号升序（2026-09-29 整理：不再设功能分区）；编号仅在本文件内唯一，仅供阅读。优先级：P0 > P1 > P2。

| # | 功能 | 来源 | 落点（复用） | 优先级 |
|---|------|------|--------------|--------|
| 14 | 工作流内模型路由与成本核算 | dynamic-workflows 拆项 2/3（对比文档 §3.1） | agent-default-model、token-meter | P2 |
| 15 | `[~]` git-worktree 完整隔离（resume 已由 task-engine `resumeFromSnapshot` 覆盖；隔离未实现） | dynamic-workflows 拆项 5 | 本机本地插件 `dsh-git-worktree` 补完整隔离（当前仅有 disabled-git-hooks） | P2 |
| 17 | 模板化 pattern 五族（deep-research / code-review / multi-perspective / adversarial-review / codebase-audit） | dynamic-workflows 拆项 7（对比文档 §3.1）；pi-simplify/ponytail 工具族可并入 | workflow 脚本 + skill 内容资产 | P2 |
| 23 | PDF/文档结构视图 | readseek 拆项 4（对比文档 §3.4） | 无底座，新工具 | P2 |
| 31 | slash 命令模板（pre-steps/chain/best-of-N）+ 模板级模型选择 | pi-prompt-template-model（对比文档 §3.4） | commands + workflow | P2 |
| 51 | **记忆 auto-consolidation（自动巩固）**：把高频 / 高重要度记忆自动提升、合并相似条目、淘汰陈旧项（现状 knowledge-base 已有两级写回与淘汰提升，语义接近但需自动化巩固策略） | `archive/PI-DSH-FEATURE-COMPARISON.md` §5.3（原 §2.6 观察项，用户 2026-09-29 立项） | knowledge-base 记忆层扩展（复用两级写策略 / 淘汰提升机制） | P2 |
| 52 | **会话事件自动入知识库**：会话事件（tool 结果 / 决策 / 结论等）按规则自动入库并可检索（需定义过滤、去重、容量与隐私边界） | `archive/PI-DSH-FEATURE-COMPARISON.md` §5.3（原 §2.6 观察项，用户 2026-09-29 立项） | knowledge-base + TUI/host 事件面（复用 output-compress 的入库与去重模式） | P2 |
| 58 | task-engine executor 策略与后端适配（叶子声明 `executor`，复用宿主 subagent / workflow / llm 面；引擎只做发起 / 证据回填 / 验收） | 边界决策（task-engine/README「边界与外包」2026-09-30） | task-engine（宿主 subagents、workflow、llm 面） | P2 |

**未立项观察项**（暂不单独立项，作为后续可选项）：意图/多策略检索（knowledge-base 已双 FTS5，距 BM25+RRF+proximity 一步）、MCP 脚本化（mcpScript）、活动工具交互管理。

## 3. 里程碑

1. 里程碑一（P0，引擎三块 + 知识库底座）与里程碑二（P1：#5-#7、#9-#11、#13、#19-#20、#27、#36）均已完成。
1. 里程碑三（P2）剩余：#14、#15（git-worktree）、#17、#23、#31、#51、#52，按需排期；已完成项（含 #21-#22、#39、#40、#42-#50、#55）见 §1 索引，已取消 / 不再立项项亦见 §1。
1. 依赖：#17 的模板族（含原 #32 的代码审查能力）可复用 workflow/skill 资产；workflow-ext 建包前，工作流相关插件面依赖 task-engine 的契约与执行器；其余相互独立。

## 4. 插件规划（未建包）

> 每个插件 = 本仓库一个包目录（以现有包为模板：`package.json` 的 `dsh.bundle` + `cordis.patch.yml` 集成契约）；命名按功能自定，不沿用 pi 插件名。已建插件与其承载清单项见 `STATUS.md`。

| 插件 | 承载清单项 | 复用（不新建） |
|------|-----------|----------------|
| `workflow-ext` | #14-#15、#17 | agent-default-model、token-meter、workflow-run；本机本地插件 `dsh-git-worktree` 补完整隔离 |
| `web-ext` | #23、#25-#26 | search provider 扩充、web-fetch-http、shell（git 克隆先行） |
| `session-broker` | #30 | 无等效底座，新建 unix socket 通道 |
| `command-template` | #31 | commands、workflow |
| 内容资产（非插件） | #17、#32 | workflow 脚本 + skill 内容 |

## 5. TUI 侧

→ 已迁至 `TUI/docs/BACKLOG.md`（TUI 的变更优先写 TUI 文档）：命令扩展状态、排版与交互开放项、herdr pane 外部问题取证都在那里；本清单只维护跨包功能项。
