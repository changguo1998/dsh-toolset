# pi 已安装功能 → dsh 迁移调研与对比（细粒度）

> **已归档**：本文是 pi → dsh 迁移时的一次性基线快照（pi 侧证据已随上游漂移）。当前覆盖情况见 `docs/DEVELOPMENT-STATUS.md`、剩余缺口见 `docs/DEVELOPMENT-BACKLOG.md`。

> 用途：记录「把 pi-coding-agent 已安装功能迁移到 dsh-toolset」的迁移基线。**对比单位 = 功能（子功能）而非包**；含拆分建议与 dsh 落点，不含实现方案。
> 基线：pi 侧为迁移时的安装清单与工具面（pi 包版本随上游演进，本文不记版本）；dsh 侧为 deepseek-harness `dsh-v0.1.5-rc.2`（commit `fb2c4b9e69`，274 包，包存在性经 `git ls-tree` 核实）。迁移后的覆盖情况与剩余缺口以 `DEVELOPMENT-STATUS.md`、`DEVELOPMENT-BACKLOG.md` 为准，本文不逐项追记。
> 状态标记：**已有** / **部分** / **缺口** / **不适用**。§3 为迁移前的裸基线差距快照，已落地项见 §5.3。

## §1 pi 已安装功能清单（包级）

**pi 包（迁移时）**：

- 任务与编排：pi-goal-list-loop-audit（goal/list/loop/audit，拆 4 项，见 3.1）、@quintinshaw/pi-dynamic-workflows（大规模编排 / /workflows TUI / deep-research，拆 7 项，见 3.1）、pi-subagents（委派 + 多 agent 工作流）、@juicesharp/rpiv-advisor（更强模型二次意见）；
- 上下文与记忆：context-mode（沙箱执行 + FTS5 知识库 + 意图检索，拆 6 项，见 3.2）、pi-hermes-memory（持久记忆 + 会话搜索 + 密文扫描 + 技能，拆 6 项，见 3.2）、@hypabolic/pi-hypa（输出压缩 + 代码索引 + 可恢复证据，拆 4 项，见 3.2）、@mrclrchtr/supi-context（上下文压力/token 报告，迁移时未启用）；
- 代码、搜索与工具：pi-readseek（LINE:HASH 锚定 + 结构导航）、pi-lens（LSP / ast-grep / 结构分析）、pi-web-access（搜索/抓取/克隆/PDF/视频，拆 5 项，见 3.4）、pi-mcp-adapter（MCP 适配）、@firstpick/pi-extension-tools（活动工具管理）、pi-prompt-template-model（提示词模板 + 模型选择）；
- 交互与安全：@juicesharp/rpiv-ask-user-question（结构化问卷）、@juicesharp/rpiv-todo（todo 列表）、pi-autoname（会话命名）、pi-intercom（跨会话经纪人）、pi-defender（危险命令/敏感文件）、@panzenbaby/pi-secure-extension（安全扩展，包描述为空，源码待核对）、pi-powerline-footer（状态栏）、@dietrichgebert/ponytail（懒人编码模式）、pi-simplify（改动代码审查）、pi-dsh-minimal（pi↔DSH 反向适配，不迁移）。

**原生扩展（非 npm）**：percent-compact / notify-sound / lock-default-model / herdr-\* / B2-session-should-compact / hermes-async-shutdown / provider-guard（见 3.7）。

**内容型资产**：skills ×9 / themes / Designer / model-tiers（见 3.6）。

> 上列为迁移时清单；pi 侧依赖此后有增删（如 supi-context、pi-prompt-template-model 已不在当前依赖中），本文不追记。

## §2 dsh 0.1.5-rc.2 已实现功能基线

> 能力域均经 git 核实存在；细节契约见 `docs/host/DSH-CTX-API.md`。0.1.5 确认**没有**的：ast-grep、代码索引、记忆库、auditor、跨会话 broker。0.1.5-rc.2 相对 0.1.2-rc.1 的包增量与新事件（256→274 包）见 `docs/host/DSH-CTX-API.md` §10。

| 能力域 | 0.1.5-rc.2 代表包 | 说明 |
|--------|------------------|------|
| 会话与持久化 | session、session-persistence(jsonl)、session-checkpoint-policy、session-snapshot | 事件源、JSONL、checkpoint |
| 会话检索/标题 | session-query(+sqlite)、session-title(+llm)、session-stats | FTS5 历史检索；LLM 命名 |
| 审批/问答/反馈 | user-approval、user-questions + tool-ask-user、message-feedback + command-feedback | 审批链、问卷、反馈 |
| 子代理 | subagent + 6 后端（fork/spawn/acp/dsh-sdk/claude-code/codex）+ tool-subagent(+control) | 委派与控制 |
| goal/todo/jobs | goal(+round-driver/command/tool)、tool-todo、jobs(+local/tool) | 目标、todo、后台任务 |
| 记忆与存储 | storage(+sqlite/json)、session-reference、session-query-sqlite | KV、跨会话引用、历史检索 |
| 工作流 | workflow(+worker-thread)、tool-workflow、tool-ralph、experimental-agent-team | 编排、循环、团队 DAG |
| 模型/LLM | llm(+deepseek/pi-ai/replay)、agent-default-model、token-meter、llm-retry | 模型接入、默认模型、计量、重试 |
| 工具层 | tools、tool-fs(+search)、fs-observation-policy、tool-bash/pwsh/terminal/cordis、tool-session-query | 注册执行、文件守卫、shell/PTY |
| 安全/沙箱 | sandbox(+local/policy)、bash-sandbox、permission-presets、user-approval、repeat-tool-reminder | 沙箱、权限、审批、防重复 |
| LSP/静态分析 | lsp(+stdio)、tool-lsp | LSP 能力缝与只读 tool |
| Web | web + tool-web + web-fetch-http + search-deepseek/exa/perplexity | 搜索/抓取（无 PDF/视频） |
| MCP | mcp-client | 客户端桥 |
| 技能 | skill + skill-badge + skill-filesystem + tool-skill | 技能加载 |
| 压缩/输出 | compaction(+basic/tool-result-pruner)、command-compact、output-retention、spill(+local/policy) | 压缩、保留、落盘 |
| 调度 | schedule | after/at/rate |
| 钩子/命令/预设/人格 | hooks-claude-code/codex、webhook、commands、agent-presets、command-goal/compact/feedback、plan-mode、persona | 桥、命令、预设、plan、人格 |
| 外部桥 | acp、sdk-app/sdk-minimal/sdk-client/sdk-jsonrpc-server | JSON-RPC stdio / ACP |
| Web/终端 UI | client-ui-\*（web）+ 本项目 TUI 包 + 本机本地插件（`dsh-git-worktree`、`dsh-better-edit`） | 浏览器端 UI；终端 UI；本地插件 |

## §3 细粒度按功能对比（迁移前快照）

> 下表状态为 **dsh 0.1.5-rc.2 裸基线** 与 pi 的差距；dsh-toolset 已落地的覆盖项见 §5.3。

### 3.1 任务控制类（glla、dynamic-workflows）

**pi-goal-list-loop-audit → 拆 4 项**：

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 1) goal 目标起草与契约 | propose_goal_draft / propose_task_list（objective、verificationContract、interview 起草、确认对话框） | goal + command-goal + tool-goal + goal-round-driver（事件源目标已具备）；缺 interview 起草/验证契约条款 | 部分 |
| 2) list 审计任务队列 | list_add / list_activate / list_status（pool 非 FIFO、逐项激活、每项独立可审计） | 无任务队列插件；近似 goal + jobs/todo（均非「队列 + 逐项激活」语义） | 缺口 |
| 3) loop forever 循环 | propose_loop_draft / propose_loop_refine（metric/spec/project-audit、plateau 停止、边界上限、cadence 唤醒） | workflow + workflow-worker-thread + schedule（after/at/rate）可拼；无「指标驱动自动循环 + plateau 停止」现成语义 | 部分 |
| 4) audit 分离审计 | complete_goal → 独立 auditor 进程用原始证据复核完成声明，不占主 turn | 无审计进程；近似 subagent/外部桥（acp/sdk）可做进程外复核，无既定 audit 协议 | 缺口 |

> 与 dynamic-workflow 结合建议：list → 工作流任务 DAG（experimental-agent-team 已有 shared task DAG）；loop → workflow 编排 + schedule 驱动；audit → workflow 模板 + 外部桥；goal → 直接用 dsh-goal。

**pi-dynamic-workflows → 拆 7 项**：

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 1) fan-out 大规模编排 | workflow 工具扇出到数百子代理 | workflow + workflow-worker-thread + tool-workflow + experimental-agent-team（implicit-root DAG） | 部分 |
| 2) 真实模型路由 | 按子代理/流程路由模型 | agent-default-model + llm 面 + model/selection 事件；缺「工作流内 per-step 路由」 | 部分 |
| 3) token/成本核算 | token/cost accounting | token-meter 计量；无成本核算 | 部分 |
| 4) resume 断点续跑 | 工作流可恢复 | session 事件源可续；0.1.5 有 client/ui-workflow-run（浏览器端面板，进程内工作流仍由 workflow + worker-thread 承载） | 部分 |
| 5) git-worktree 隔离 | 每 fan-out 独立 worktree | 本机本地插件 `dsh-git-worktree` 仅有 disabled-git-hooks，需补完整隔离 | 部分 |
| 6) /workflows 交互 TUI | /workflows 面板、成员披露 | dsh 基线无 workflows 面板；已由本项目 TUI `/workflows` 面板落地（#16，见 §5.3） | 已有（本项目 TUI） |
| 7) 模板化 pattern（deep-research / adversarial-review / code-review / multi-perspective / codebase-audit） | workflow-patterns skill | 无现成模板；可做成 workflow 脚本内容 | 缺口 |

### 3.2 上下文与记忆类（context-mode、hermes-memory、hypa、supi-context）

**context-mode → 拆 6 项**：

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 1) 沙箱代码执行 | ctx_execute / ctx_execute_file | code-runtime + code-runtime-worker-thread | 已有 |
| 2) FTS5 知识库（索引+检索） | ctx_index / ctx_search | storage-sqlite + session-query-sqlite；目标是「跨会话统一知识库」，session-query 仅会话内 | 部分 |
| 3) 意图/多策略检索 | ctx_search（BM25+trigram+RRF+proximity） | session-query FTS5（简单词法匹配） | 部分 |
| 4) 大输出压缩进库 | 沙箱内派生摘要、auto-index，原字节不进上下文 | output-retention + spill（保留/落盘，不做摘要入库） | 部分 |
| 5) 会话事件自动捕获 | hooks 写入知识库（决策/错误/计划 26 类） | session-telemetry(+otel)（事件捕获/重定向） | 部分 |
| 6) 运维面（doctor/upgrade/purge/stats/insight） | ctx_doctor/upgrade/purge/stats/insight | 无对应（低优先） | 缺口 |

**pi-hermes-memory → 拆 6 项**：

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 1) 持久记忆 CRUD（token-aware policy-only） | memory_add/replace/remove | storage（KV 域）；无记忆策略语义 | 部分 |
| 2) 记忆检索（target/category/项目过滤） | memory_search | 无「记忆库」检索（session-query 是会话历史） | 缺口 |
| 3) 会话搜索 | session_search | session-query-sqlite（FTS5） | 已有 |
| 4) 密文扫描 | secret scanning（hook） | credentials（凭据缝，非扫描） | 缺口 |
| 5) 程序化技能 | skill_manage | skill + skill-badge + skill-filesystem + tool-skill | 已有 |
| 6) auto-consolidation | 记忆自动整合 | compaction（上下文压缩，语义不同） | 缺口 |

**@hypabolic/pi-hypa → 拆 4 项**：

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 1) shell 输出确定性压缩 | hypa_shell（改写命令、本地压缩、可恢复证据） | output-retention + spill（保留/落盘 ≠ 压缩编码） | 部分 |
| 2) 上下文感知文件读取 | hypa_read（smart/full/outline/signatures/pruned） | tool-fs + tool-lsp（无文件大纲/签名模式） | 部分 |
| 3) 代码索引与符号图 | hypa code index / symbols / graph（callers） | 无代码索引（lsp 约等于符号查询，无索引/图） | 缺口 |
| 4) MCP 代理（search/schema/invoke/batch） | hypa_mcp | mcp-client | 已有 |

**supi-context**：上下文压力/token 报告 → token-meter + session-stats（形态需对齐）→ 部分（迁移时未启用）。

### 3.3 交互类（ask-user-question、todo、autoname、intercom）

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 结构化问卷（2-4 选项/preview/multiSelect） | ask_user_question | user-questions + tool-ask-user（协议细节需对齐） | 已有 |
| todo 列表（事件源快照 + live 覆盖层） | todo | tool-todo（事件源会话日志） | 已有 |
| LLM 会话命名 | autoname（自动 hook） | session-title + session-title-llm 提供方 | 已有 |
| 跨会话消息通道（broker 守护、unix socket） | intercom | 无；近似 webhook / acp / sdk（均非等效） | 缺口 |
| 跨会话委托/协调（planner-worker、共享上下文） | pi-intercom skill | subagent + workflow（进程内）；跨进程会话无通道 | 缺口 |
| 跨会话扩展状态同步 | extension-state | 无 | 缺口 |

### 3.4 代码、搜索与工具类（readseek、lens、web-access、mcp、extension-tools、prompt-template）

**pi-readseek → 拆 4 项**：

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 1) LINE:HASH 锚定读写/编辑 | readSeek_digest/edit（行:哈希锚点） | tool-str-replace-editor（字面替换/行插入，无 LINE:HASH 锚定）+ tool-fs + fs-observation-policy（version-guarded） | 部分 |
| 2) AST 结构搜索 | readSeek_search（ast-grep 风格） | tool-fs-search（ripgrep 文本）；无 AST 搜索 | 缺口 |
| 3) 符号定义/引用/重命名 | readSeek_def/refs/rename | tool-lsp（goToDefinition/findReferences） | 已有 |
| 4) 文档结构视图（PDF 等） | readSeek_view | 无 | 缺口 |

**pi-lens → 拆 4 项**：

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 1) LSP 诊断/导航 | lsp_diagnostics / lsp_navigation | lsp + lsp-stdio + tool-lsp | 已有 |
| 2) 实时 lint/格式化/类型反馈（inlay/mark） | lens_diagnostics / lens_diagnostic_mark | lsp 诊断面（无独立 lint 插件，可经 LSP 语义） | 部分 |
| 3) ast-grep 搜索/替换/大纲 | ast_grep_search/dump/outline/replace | 无（ripgrep 文本搜索仅） | 缺口 |
| 4) 项目/模块报告与符号导航 | module_report / project_report / source_check / read_symbol / symbol_search / read_enclosing | tool-lsp（符号导航有）；报告类无对应 | 部分 |

**pi-web-access → 拆 5 项**：

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 1) 联网搜索（多 provider 20+） | web_search | web-search-deepseek/exa/perplexity（provider 少） | 部分 |
| 2) URL 抓取/内容提取 | fetch_content / get_search_content | web-fetch-http | 部分 |
| 3) GitHub 仓库克隆 | repo clone | 无 git 工具包（可经 shell 实现） | 部分 |
| 4) PDF 提取 | pdf 提取 | 无 | 缺口 |
| 5) YouTube/本地视频理解 | 视频分析 | 无 | 缺口 |

**其余工具类**：

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| MCP 客户端连接/工具注册 | mcp | mcp-client | 已有 |
| MCP 脚本化 | mcpScript（mcp-scripting skill） | mcp-client 无脚本界面 | 部分 |
| 交互式活动工具启停 | @firstpick/pi-extension-tools | tools（注册/执行）；无交互管理面 | 部分 |
| slash 命令模板（pre-steps/chain/subagent/best-of-N） | pi-prompt-template-model | commands + workflow（可编排 chain/subagent） | 部分 |
| 模板级模型选择 | 同包 | model/selection 面 | 部分 |

### 3.5 代理与安全类（subagents、advisor、defender、secure-extension）

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 单 agent 委派 | subagent | tool-subagent（多后端） | 已有 |
| 并行/监督多 agent 工作流 | subagent_supervisor / subagent_wait | workflow + tool-subagent-control | 部分 |
| 顾问委员会（council-mode） | council-mode skill | 可经 ralph/workflow 近似 | 部分 |
| 更强模型二次意见 | advisor（转发全上下文） | tool-ralph（fresh-agent）/ tool-subagent；缺「更强模型」路由语义 | 部分 |
| 危险命令拦截（黑名单） | pi-defender | sandbox + bash-sandbox（沙箱强制，非黑名单语义） | 部分 |
| 敏感文件保护 | pi-defender | fs 守卫 + sandbox-policy | 部分 |
| 安全 issue 上报 | pi_defender_create_issue | 无 | 缺口 |
| secure-extension 安全面 | 包描述为空 | sandbox/permission 面 | 部分 |

### 3.6 UI、模式与内容资产类（powerline、ponytail、simplify、notify-sound、skills、themes、Designer）

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 状态栏分段（model/thinking/path/git/queue/token/cost/context%/time） | pi-powerline-footer | TUI 状态区（环境/LLM 组） | 已有 |
| 可配置 layout/placement/separator | 同包 | TUI 自有配置 | 已有 |
| 简洁编码模式（lite/full/ultra） | ponytail | persona（人格配置表达） | 部分 |
| 审查/债务/收益工具族 | ponytail-review/audit/debt/gain | 无（可作 workflow 模板/skill 内容） | 缺口 |
| 近期改动代码审查 | pi-simplify | 无 | 缺口 |
| 完成/等待声音提醒 | notify-sound.ts | dsh 基线无；已由本项目 TUI 完成/等待声音提醒落地（#33，见 §5.3） | 已有（本项目 TUI） |
| 技能内容 ×9（迁移时快照） | skills 目录 | skill + skill-filesystem + skill-badge（机制有，内容搬运） | 已有（内容待迁移） |
| 主题 fffdark/ffflight | themes | TUI 已内置 | 已有 |
| Designer 预设 agent | agents/Designer.md | agent-presets（配置树） | 已有 |

### 3.7 原生扩展与工程类

| 子功能 | pi 载体 | dsh 0.1.5-rc.2 对应 / 差距 | 状态 |
|--------|---------|---------------------------|------|
| 自动压缩触发策略 | percent-compact.ts（本机 50%/256K，源码兜底常量 30%/128K） | compaction + compaction-basic + tool-result-pruner + command-compact + spill（官方内置，无需新插件，见 §5.2） | 已有 |
| provider 速率退避/守卫 | provider-retry/retry（pi 核心内建）+ 扩展 provider-guard（rate-guard 已移除，见 §5.1） | llm-retry | 已有 |
| 错误等待下限 + quota 救助（长时间等待后恢复） | provider-guard.ts | 仅 llm-retry 普通退避；缺 quota 长等待/恢复通知/溯源条目 | 部分 |
| 默认模型锁定 | lock-default-model.ts | agent-default-model | 已有 |
| 模型分层配置 | workflows/model-tiers.json | workflow 模型路由面需对齐 | 部分 |
| pi↔DSH 反向适配 | pi-dsh-minimal | 方向相反 | 不适用 |
| Herdr 集成 / pi 内部补丁 / 配置数据 | herdr-\*、B2-\*.patch、hermes-async-\*.patch、subagent/config | 不迁移 | 不适用 |

## §4 结论（迁移前）

### 4.1 已有等效（仅对齐，无需迁移）

ask-user-question、todo、会话命名、subagents 委派、MCP 客户端、沙箱执行（code-runtime）、会话搜索（FTS5）、程序化技能、LSP 诊断/符号导航、自动压缩策略、默认模型锁定、状态栏、主题、技能机制、agent 预设、审批/权限/沙箱、web 抓取基础、MCP 代理面。

### 4.2 部分覆盖（以插件形式按缺口补齐）

- glla：goal（补起草/契约形态）；loop（补指标驱动/plateau）；list、audit 见 4.3。
- dynamic-workflows：fan-out（agent-team DAG）、模型路由、token 核算、resume、git-worktree 隔离（自研插件仅 hooks）、/workflows TUI（缺口）。
- context-mode：跨会话知识库与意图检索（session-query 仅会话内）、摘要入库（spill 仅落盘）。
- hermes-memory：持久记忆 CRUD、auto-consolidation。
- hypa：文件大纲读取、确定性压缩。
- readseek：LINE:HASH 锚点编辑（fs-observation-policy 只到版本守卫）。
- lens：ast-grep（缺口）、项目/模块报告。
- web-access：多 provider 搜索、GitHub 克隆。
- advisor/council：以 ralph/子代理表达。
- defender：命令黑名单/敏感文件策略层。
- prompt-template/extension-tools/supi-context：命令形态、交互管理、压力报告。

### 4.3 完全缺口（迁移候选，按优先级）

1. context-mode 知识库组合（跨会话知识库 + 压缩型工具 + 意图检索）。
1. glla 拆分项：list（任务队列）、audit（分离审计），建议与 dynamic-workflow 结合——list 以 workflow 任务 DAG / 任务队列插件实现（experimental-agent-team 的 shared task DAG 可作底座）；audit 以 workflow 复核模板 + acp/sdk 外部桥做进程外 auditor；goal 复用 dsh-goal，loop 复用 workflow+schedule。
1. dynamic-workflows：/workflows TUI、deep-research 等模板。
1. pi-intercom（跨会话 broker 与状态同步）。
1. 代码面：ast-grep 结构搜索、代码索引、readSeek_view（PDF 视图）。
1. web 面：PDF 提取、视频理解。
1. 审查/提醒：pi-simplify、notify-sound、ponytail 工具族。
1. defender：issue 上报。

### 4.4 不迁移

pi-dsh-minimal（反向桥）、herdr 集成、pi 内部补丁、配置数据。所有新增实现以 `docs/host/DSH-CTX-API.md`（基线 `dsh-v0.1.5-rc.2`）对齐宿主接口。

## §5 迁移落地与决策记录

### 5.1 rate-guard 取消（不迁移）

- pi 侧已移除：依赖清单、启用列表与 `~/.pi/agent/extensions/` 中均无 rate-guard。
- 能力拆两部分承接：一般重试/退避 → pi 核心内建（可重试错误分类、`retry-after`、指数退避 + 抖动）；长时间等待后恢复 + quota 救助 → 扩展 provider-guard（按错误类强制等待下限，quota 经错误文本改写接入 pi 重试管线，恢复后 notify + 写 `quota-recovered` 溯源条目）。
- 结论：dsh 侧取消 rate-guard 迁移（backlog #35）；`llm-retry` 覆盖一般退避面；若复刻「等待后恢复」语义，参照 provider-guard，主要缺口是 quota 长等待、恢复通知与溯源记录。

### 5.2 自动压缩：官方已内置，无需自研插件

- 官方实现（dsh 0.1.5-rc.2，随 dsh-base 装配）：`dsh-compaction`（自动阈值 + 强制压缩）、`dsh-compaction-basic`（触发策略 + LLM 摘要后端）、`dsh-compaction-tool-result-pruner`、`dsh-command-compact`（/compact）、`dsh-spill` 系列。
- 默认参数（dsh-compaction-basic）：`thresholdRatio = 0.8`（占用窗口 80% 触发）、摘要 `maxTokens = 8192`、`retention` 保留比例、`modelPolicies` 按模型覆盖。
- 结论：不需要本项目再实现压缩插件——直接用官方功能，需要调整时在自己的 `cordis.patch.yml` 给 `dsh-compaction-basic` 配置官方参数（如 50% 触发设 `thresholdRatio: 0.5`）。注意官方无 pi percent-compact 的 `min_tokens` 绝对下限语义，`max(50%, 256K)` 中的 256K 下限需自行扩展才有等价项。

### 5.3 迁移落地索引（原缺口 → 落地插件）

| 原缺口（§） | pi 功能 | 落地插件（backlog #） |
|-------------|---------|----------------------|
| 3.1-1 goal 起草/契约 | propose_goal_draft 等 | goal-contract（#6） |
| 3.1-2 list 任务队列 | list_add / activate / status | task-engine（#1-#4：Frame 树 + 机械/语义门禁 + RET 路由） |
| 3.1-3 loop 指标循环 | propose_loop_draft | metric-loop（#7） |
| 3.1-4 audit 分离审计 | complete_goal 复核 | task-engine semantic 验收（audit run，#4） |
| 3.2-2 跨会话知识库 | ctx_index / ctx_search | knowledge-base（#8：四表 + 双 FTS5） |
| 3.2-2 hypa 文件读取 | hypa_read smart/outline/signatures/pruned | fs-digest（#12） |
| 3.2-4 大输出压缩入库 | ctx 摘要 + auto-index | output-compress（#11） |
| 3.4-1 LINE:HASH 锚定 | readSeek_digest/edit | hash-edit（#19） |
| 3.4-2 / 3.4-3 ast-grep | readSeek_search / ast_grep\_\* | ast-tools（#20：搜索/替换/大纲/规则） |
| 3.5 危险命令/敏感文件 | pi-defender | security-guard（#27：pre-execute 黑名单 + 敏感文件策略层） |
| 3.7 / 4.4 herdr 桥 | herdr-\* 原生扩展 | herdr-integration（#36：unix socket + 环境变量握手） |
| 3.6 状态栏/主题/技能机制 | powerline / themes / skills | TUI（状态区、fffdark/fflight、技能加载机制） |
| 4.3 dynamic-workflows | /workflows TUI、fan-out | TUI `/workflows` 面板（#16）、task-engine fan-out（#13） |
| 4.3 advisor/council | council-mode / advisor | TUI `/council`（#18） |
| 3.4 多 provider 搜索 | web_search | TUI `/search` 多 provider 聚合（#24） |
| 3.6 声音提醒 | notify-sound | TUI 完成/等待声音提醒（#33） |
| 3.2 / 3.4 代码索引与报告 | hypa code index / module_report | code-map（#21-#22：结构层索引 + 报告；LSP 语义层为增量） |

仍缺关键面（未单独立项，作为后续可选项）：意图/多策略检索（knowledge-base 已双 FTS5，距 BM25+RRF+proximity 一步）；记忆 auto-consolidation（knowledge-base 已有两级写回与淘汰提升，语义接近）；MCP 脚本化（mcpScript）、活动工具交互管理（extension-tools）、会话事件自动入知识库。其余未落地项见 `DEVELOPMENT-BACKLOG.md`。
