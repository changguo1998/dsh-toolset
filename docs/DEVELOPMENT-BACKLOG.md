# 待开发功能清单

> 本清单只列**未完成**项；已完成项见 `DEVELOPMENT-STATUS.md` 状态表（实现与验证证据在各包源码/测试与 git 历史；已完成的实施清单归入 `archive/`），不在此重复。
> 设计依据：`AGENT-ARCHITECTURE-ANALOGY.md`（架构与接口对照）、`archive/PI-DSH-FEATURE-COMPARISON.md`（pi→dsh 迁移基线差距，归档调研）。实现时以根目录 `DSH-CTX-API.md` 对齐宿主接口。
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
| 22 | `[~]` LSP 语义层：findReferences 精确确认调用关系（结构层候选索引已完成，见 code-map/DESIGN.md 混合架构） | hypa 拆项 3（对比文档 §3.2） | tool-lsp 扩展 | P2 |
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

## 3. 里程碑

1. 里程碑一（P0，引擎三块 + 知识库底座）与里程碑二（P1：#5-#7、#9-#11、#13、#19-#20、#27、#36）均已完成。
1. 里程碑三（P2）剩余：#14、#15（git-worktree）、#17、#22（LSP 语义层）、#23、#25、#26、#28-#32，按需排期；#34 已完成；#35 已取消。
1. 依赖：#17 的模板族与 #32 可共用 workflow/skill 资产；workflow-ext 建包前，工作流相关插件面依赖 task-engine 的契约与执行器；其余相互独立。

## 4. 插件规划（未建包）

> 每个插件 = 本仓库一个包目录（以现有包为模板：`package.json` 的 `dsh.bundle` + `cordis.patch.yml` 集成契约）；命名按功能自定，不沿用 pi 插件名。已建插件与其承载清单项见 `DEVELOPMENT-STATUS.md`。

| 插件 | 承载清单项 | 复用（不新建） |
|------|-----------|----------------|
| `workflow-ext` | #14-#15、#17 | agent-default-model、token-meter、workflow-run；本机本地插件 `dsh-git-worktree` 补完整隔离 |
| `web-ext` | #23、#25-#26 | search provider 扩充、web-fetch-http、shell（git 克隆先行） |
| `session-broker` | #30 | 无等效底座，新建 unix socket 通道 |
| `command-template` | #31 | commands、workflow |
| 内容资产（非插件） | #17、#32 | workflow 脚本 + skill 内容 |

## 5. TUI 侧

- 命令扩展：7 项纯 TUI 命令与 A1-A5 已完成；C6 `/clear`、C7 `/login` `/logout` 裁定维持排除（宿主能力缺口/语义不匹配），C8 `/review` 裁定搁置（需先建 review 编排资产，可随 #17 一并考虑）；9 项候选当前无待办，现状口径见 `TUI/COMMANDS.md`、`TUI/COMMANDS-SPEC.md` §7，实施清单（已完成）见 `archive/TUI-COMMANDS-TASKS.md`。
- 排版重构（Box 模型）与符号统一（白名单/归一/同符号冷却）均已完成，机制与配置见 `TUI/README.md`、`TUI/SPEC.md`、`TUI/IMPLEMENTATION.md`，本清单不再跟踪。
- 开放项（已评估，未排期）：
  - **排版性能**：区域级帧输出 memo（状态列/状态栏/footer，实测仅占单帧 1-4%）与「只测量可见窗口」的懒排版（需块高度前缀和 + 折叠/滚动边界处理）——现有有界缓存 + 同 tick 合帧已缓解主要成本。
  - **`/help` 持续增长**：命令加行后 help 超过一屏，且既有测试存在依赖 help 行数的脆弱断言；改 help 前先检查相关断言（改动后需重跑 `scripts/freeze-focus-frame.mts` 并审查冻结基线）。
  - **`state.usage` 语义**：`/stats` 展示「最近一次模型调用」，不是会话累计；要累计值需另行采集（`tokenMeter.measure` 接入成本高）。
  - **面板占满活动区**：面板打开期间瞬态输出不可见（与 `/jobs` 行为一致），暂不改变。
  - **`/agents` 刷新方式**：宿主无 subagent 状态事件面，现为打开期间每 2s 定时刷新 + `r` 手动；宿主补事件面后可改为事件驱动。
