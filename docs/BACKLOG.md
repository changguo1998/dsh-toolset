# 待开发功能清单

> 职责：待办全集：缺陷 + 功能 + 里程碑 + 插件规划
> 不负责：现状描述（见 `docs/STATUS.md`）
> 过期条件：无

> 本清单只列**未完成**项；已完成项见 `STATUS.md` 状态表（实现与验证证据在各包源码/测试与 git 历史；已完成的实施清单归入 `archive/`），不在此重复。
> 设计依据：`docs/host/AGENT-ARCHITECTURE-ANALOGY.md`（架构与接口对照）、`archive/PI-DSH-FEATURE-COMPARISON.md`（pi→dsh 迁移基线差距，归档调研）。实现时以根目录 `docs/host/DSH-CTX-API.md` 对齐宿主接口。
> 基线：dsh `dsh-v0.1.5-rc.3`（commit `a4c74a91e0`）。
> 优先级：**P0** 架构主线；**P1** 核心体验补齐；**P2** 长尾。状态标记：`[x]` 已实现（仅第 1 节索引使用）、`[~]` 部分实现（注明未含部分）、无标记 = 未实现。

## 1. 已完成索引

`[x]` 已实现并合入 main，落点如下（单测数与首版边界见状态表）：

- 任务控制：#1-#5 task-engine（Frame 状态机、工具族、双重门禁、RET 三级路由、step 裁决）、#13 fan-out 就绪池、#6 goal-contract、#7 metric-loop；
- 知识库与记忆：#8 knowledge-base（两张基表 + 两张 FTS5 虚表）、#9 两级写策略与淘汰提升、#10 持久记忆 CRUD、#11 output-compress、#12 fs-digest；
- 代码与文件：#19 hash-edit、#20 ast-tools、#21 code-map 报告与影响面、#22 结构层索引与候选调用图；
- 上下文报告：#34 context-report（host-only 投影 `sessionContext` 折叠会话累计 + `context_report` 三档报告）；
- 安全与集成：#27 security-guard 策略层、#36 herdr-integration；
- TUI：#16 /workflows 面板、#18 /council、#24 /search 多 provider 聚合、#33 声音提醒，以及 7 项纯 TUI 命令与 A1-A5（`/task` `/guard` `/memory` `/loop` `/contract`）。
- 已取消：#35 rate-guard（不实现，pi 侧已移除，dsh 侧由官方 `llm-retry` 覆盖，见 `archive/PI-DSH-FEATURE-COMPARISON.md` §5.1）。

## 2. 未完成项

### 2.1 子代理与编排（P1-P2）

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 14 | 工作流内模型路由与成本核算 | dynamic-workflows 拆项 2/3（对比文档 §3.1） | agent-default-model、token-meter | P2 |
| 15 | `[~]` git-worktree 完整隔离（resume 已由 task-engine `resumeFromSnapshot` 覆盖；隔离未实现） | dynamic-workflows 拆项 5 | 本机本地插件 `dsh-git-worktree` 补完整隔离（当前仅有 disabled-git-hooks） | P2 |
| 17 | 模板化 pattern 五族（deep-research / code-review / multi-perspective / adversarial-review / codebase-audit） | dynamic-workflows 拆项 7（对比文档 §3.1）；pi-simplify/ponytail 工具族可并入 | workflow 脚本 + skill 内容资产 | P2 |

### 2.2 代码与文件（P2）

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 22 | `[~]` LSP 语义层：findReferences 精确确认调用关系（结构层候选索引已完成，见 code-map/docs/DESIGN.md 混合架构） | hypa 拆项 3（对比文档 §3.2） | tool-lsp 扩展 | P2 |
| 23 | PDF/文档结构视图 | readseek 拆项 4（对比文档 §3.4） | 无底座，新工具 | P2 |

### 2.3 外部接入（P2）

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 25 | GitHub 仓库克隆 | web-access 拆项 3（对比文档 §3.4） | 可先经 shell | P2 |
| 26 | PDF 提取、视频理解 | web-access 拆项 4/5（对比文档 §3.4） | 无底座，新工具 | P2 |

### 2.4 安全治理（P2）

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 28 | 密文扫描 | hermes-memory 拆项 4（对比文档 §3.2） | credentials 面扩展 | P2 |
| 29 | 安全 issue 上报 | pi-defender（对比文档 §3.5） | 无对应 | P2 |

### 2.5 交互与资产（P2）

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 30 | 跨会话 broker（消息/委托/状态同步） | pi-intercom（对比文档 §3.3） | 无底座；webhook/acp/sdk 均非等效，新建 unix socket 通道 | P2 |
| 31 | slash 命令模板（pre-steps/chain/best-of-N）+ 模板级模型选择 | pi-prompt-template-model（对比文档 §3.4） | commands + workflow | P2 |
| 32 | 近期改动代码审查 | pi-simplify（对比文档 §3.6） | 可并入 #17 模板族 | P2 |

### 2.6 其他观察项（未单独立项）

来自 `archive/PI-DSH-FEATURE-COMPARISON.md` §5.3 的仍缺关键面，暂不单独立项，作为后续可选项：意图/多策略检索（knowledge-base 已双 FTS5，距 BM25+RRF+proximity 一步）、记忆 auto-consolidation（已有两级写回与淘汰提升，语义接近）、MCP 脚本化（mcpScript）、活动工具交互管理、会话事件自动入知识库。

### 2.7 配置与部署（P2）

| # | 功能 | 来源 | dsh 落点（复用） | 优先级 |
|---|------|------|------------------|--------|
| 37 | preset 机制对齐（清理已完成，余迁移评估）：本项目只用 TUI，agent 面由 profile 全局组合提供，preset 配置已于 2026-09-25 从 `Projects/dsh-toolset`、`~/.dsh`、`~/fff/config/dsh` 清除（记录见 `docs/host/AGENT-COMPOSITION.md` §5）。**剩余**：宿主升级到 0.1.7+ 时，若确需「同一 TUI 进程内不同会话用不同组合」，按官方声明式自建——挂 `agent-preset-registry`、以 `@deepseek-ai/dsh-agent-preset` 行声明组合、并像 `web-app` 那样禁用 base 的 agent 面行（切换只对空白会话生效）；不需要则本项直接关闭 | 官方仓库核对 2026-09-25（`master` `477b4f4205` = `dsh-v0.1.7-rc.2`；preset 重写 commit `d1e22a7e24`，TUI 包移除 commit `10bb9cbf4a`） | 现状：profile 用户 patch；若要 preset：`agent-preset-registry` + `agent-preset` | P2 |

| 38 | 宿主双栈兼容垫片清理：0.1.7-rc.2 升级改造为过渡期保留了「按宿主版本择路」的分支——TUI `jobsCallerFor`（jobs caller 形态）与 `refreshAgents` 的 `listDescendants` / `listChildren` 择路、`output-compress` 的 `ptcRuntime` / `codeRuntime` 探测；待 0.1.5-rc.3 彻底退役后删除旧分支与对应旧形态测试用例，回到单一形态 | `docs/host/HOST-UPGRADE-0.1.7-rc.2.md` §0.1 / §3.2（升级改造 2026-09-25） | 无（纯清理） | P2 |

### 2.8 工程流程与文档体系

| # | 功能 | 来源 | 落点 | 优先级 |
|---|------|------|------|--------|
| 39 | **完成（2026-09-25）** 文档体系与变更规范落地：确立「ROADMAP（仅项目级）→ DESIGN（模块）→ BACKLOG 条目 → `docs/implementation/` 追踪文档 → 关闭后移入 `docs/archived/`」的分层与流程；BACKLOG / STATUS 统一短命名（`DEVELOPMENT-BACKLOG.md` → `BACKLOG.md`、`DEVELOPMENT-STATUS.md` → `STATUS.md`）；模块（TUI 与 12 个包）各自 `docs/` 管理 DESIGN / BACKLOG；规范两份（`AGENTS.md` 简版 + `docs/WORKFLOW.md` 详版），含「一个任务可接多个条目」与四个提交询问点 | 用户 2026-09-25 讨论定稿 | 追踪文档（已关闭）`docs/archived/2026-09-25-docs-workflow-rollout.md` | P1 |
| 40 | 待办 **`TUI/docs/IMPLEMENTATION.md` 按新规范拆分后删除**：命令路由与落点 → `TUI/docs/DESIGN.md`；渲染/排版类 → `TUI/docs/SPEC.md`；其余机制与「已评估未采用」→ DESIGN；「验证方式」并入 `AGENTS.md`；拆分后重定向 58 处引用 | #39 的决策（2026-09-25） | 独立条目，另派 agent 接取 | P2 |
| 41 | 待办 **建立 `docs/ROADMAP.md`**：写未来开发方向，内容需维护者提供；建立后与 `docs/BACKLOG.md` §3「里程碑」的分工为「方向在 ROADMAP、进度与排期在 BACKLOG」 | #39 落地时发现（2026-09-25） | 需维护者参与 | P2 |

## 3. 里程碑

1. 里程碑一（P0，引擎三块 + 知识库底座）与里程碑二（P1：#5-#7、#9-#11、#13、#19-#20、#27、#36）均已完成。
1. 里程碑三（P2）剩余：#14、#15（git-worktree）、#17、#22（LSP 语义层）、#23、#25、#26、#28-#32、#37、#38，按需排期；#34 已完成；#35 已取消。
1. 依赖：#17 的模板族与 #32 可共用 workflow/skill 资产；workflow-ext 建包前，工作流相关插件面依赖 task-engine 的契约与执行器；其余相互独立。

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
