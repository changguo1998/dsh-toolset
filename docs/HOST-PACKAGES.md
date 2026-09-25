# 可用官方包清单（DSH 0.1.7-rc.2）

> 来源：本地安装的官方 deepseek-harness（全局 dsh `0.1.7-rc.2`，`$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）；与源码 clone（`~/GithubRepos/deepseek-harness`，`dsh-v0.1.7-rc.2` = commit `477b4f42`）同版本。
> 用途：与 `DSH-CTX-API.md` 配套——该文件记「接口怎么用」，本文件记「有哪些包、每个包提供什么服务」；供 dsh-toolset 各插件选型与集成对齐。
> 版本口径：只记 `0.1.7-rc.2` 实际随包分发的内容（283 个包）；版本与描述取自各包 `package.json`，服务名与 fff 挂载集合由安装目录与 profile 实测提取（见文末复现命令）。宿主升级后需重新生成。
> 采集时间：2026-09-25（宿主 `dsh --version` = `0.1.7-rc.2`）。接口与包增删的逐项对照见同目录 `HOST-UPGRADE-0.1.7-rc.2.md`。
> 与上一版清单（`0.1.5-rc.3`）的差异：随包分发包 240 → 283、fff 已挂载 82 → 91；分类结构沿用旧版，逐行按新数据重写。

## 0. 怎么读这份清单

- 每行格式：`包名`（`ctx.<服务名>`，已挂载） — 官方一句话定位（中文改写）。
- **`（ctx.x）` 表示该包注册了这个 host 服务**，是我们插件 `inject` 的对象；没有的包是工具/后端/客户端资产，通过别的服务被消费。
- **`已挂载`** 指 `fff` profile 启动时会加载它（等价于 `dsh-base` bundle 行 + profile 用户 patch 行）；未标记的包虽已随 dsh 安装、但该 profile 不加载。
- **`树外加装`** 指该包未随 dsh 分发，由 `fff` profile 自行安装（`dsh plugin add` 或 profile 的 `package.json` + `pnpm install`，落到 profile 的 `node_modules`）并在 profile 的 `cordis.patch.yml` 挂载；当前仅 `session-title-all-prompts-llm` 属此类（不随装、按需启用）。
- **`agent-preset` 家族未挂载是设计结果，不是缺配置**：官方只让 Web 面（`web-app` bundle）禁用 base 的 agent 面行并挂 preset registry，TUI 这类单组合面保持 base 的进程级 agent 组合（`packages/bundle/web-app/cordis.patch.yml` 的 "for the TUI, which is single-session and composes its agent process-wide" 注释、`packages/client/ui-user-questions/README.md` 的 "the TUI composition, which has no presets"）。依据、验证与版本断层见 `AGENT-COMPOSITION.md`；要改 agent 面请落 profile 用户 patch。
- **包名省略 `@deepseek-ai/dsh-` 前缀与作用域**。少数包本就不带该前缀：`cordis` / `cordis-plugin-*` / `cosmokit` / `schemastery` 来自 vendored cordis 生态，`libreoffice-kit*` / `node-addon-system*` 是预编译资产包——这 11 个 + `web-frontend`（构建产物）共 12 个包在 `packages/` 下没有源码目录，行内已注明 vendor / 构建产物。
- **归类与计数口径**：分组沿用旧版 12 个分类，按宿主源码目录（`packages/` 下路径）归口，少数跨面包沿用旧版口径（`command-*` 归「技能 / 命令 / Web / 集成」；编排类 `tool-*`（goal / jobs / subagent / workflow / agent-team）归「agent 与编排」；`client-*` 全部归「客户端 UI」；`util-*` 与 vendor 归「插件 / 启动 / 基础设施」）；`experimental-` 前缀包剥掉前缀后按同一规则落位。
- **小计自洽性**：各分类包数之和 = **283**；各分类「已挂载」之和 = **91**，其中 90 个在 §2 的 283 个之内，另 1 个是树外加装包 `session-title-all-prompts-llm`（归入「会话 / 上下文 / 存储」，不占该分类的 41 个名额）。

## 1. 现成可用（fff 已挂载，91 个）

```
cordis-plugin-timer agent agent-default-model agent-instructions agent-loop api-gateway
attachment-local authorization bash-sandbox command-compact command-feedback command-goal
commands compaction-basic compaction-image-offload compaction-tool-result-pruner config-editor
credentials-local deepseek-account-platform deepseek-llm-api-extensions fs-observation-policy
fs-sandbox goal goal-round-driver hmr jobs-local llm llm-deepseek-account llm-deepseek-api-key
llm-pi-ai llm-retry mcp-resources permission-presets plan-mode plugin-manager
plugin-package-inventory-deepseek ptc-runtime-node pwsh-sandbox repeat-tool-reminder
sandbox-local sandbox-policy session session-checkpoint-policy session-log-deepseek
session-persistence-jsonl session-projection session-projection-cache session-query-sqlite
session-telemetry-otel session-title session-title-all-prompts-llm
session-title-first-prompt-llm settings shell-env skill skill-badge skill-filesystem spill-local
spill-policy storage storage-domain storage-json subagent subagent-fork-in-process
subagent-spawn-in-process subprocess-local system-prompt token-meter tool-bash
tool-call-timeout-policy tool-fs tool-fs-search tool-goal tool-jobs tool-pwsh tool-ralph tools
tool-skill tool-subagent tool-subagent-control tool-todo tool-web tool-workflow typert-loader
typert-registry user-approval user-questions web web-fetch-http web-search-deepseek workflow-ptc
```

其中 **90 个**随 dsh 分发（在 §2 的 283 个之内），**1 个**是树外加装包 `session-title-all-prompts-llm`（会话标题 provider，见 §2「会话 / 上下文 / 存储」）。上表不含本项目 13 个 `@dsh-toolset/*` 包与 TUI bundle 自行 `- insert:` 的 `tool-ask-user`（口径见 §6）。

## 2. 全部分组清单（283 个）

### agent 与编排（27，已挂载 18）

- `agent`（`ctx.agents`，已挂载） — agent 接口与注册表：`ctx.agents`（create/resume/register/get/list/roots、initiator 作用域、agent/created 等事件词汇）；`CreateAgentOptions.meta.cwd` 是唯一能指定会话工作目录的公开参数
- `agent-default-model`（`ctx.agentDefaultModel`，已挂载） — `ctx.agentDefaultModel`：各 agent 入口共享的默认模型选择（currentSelection/saveSelection）
- `agent-instructions`（已挂载） — 工作区上下文加载器：读取 AGENTS.md / CLAUDE.md 指令文件注入提示
- `agent-loop`（`ctx.agentLoop`，已挂载） — `ctx.agentLoop`：具体的 agent 回合驱动（create/createAgent/resume），cwd 经 `meta` 直吃
- `agent-preset` — 声明式 preset 的声明侧：在 Cordis YAML 里描述一个 agent 能力组合（取代 0.1.5 的目录式 roster）
- `agent-preset-registry`（`ctx.agentPresets`） — `ctx.agentPresets`：声明式 agent preset 注册表 + 落当前 profile 用户 patch 的编辑面；服务名沿用旧 `agent-presets`，本 profile 不挂载（TUI 走 profile 全局组合，见 §0）
- `agent-tool-presentation` — agent 面工具呈现选择器：把一个 agent 的工具组合成 PTC / native / 两者（presentAs）
- `persona` — 组合声明的部署人格（persona）提示段
- `goal`（`ctx.goals`，已挂载） — `ctx.goals`：同会话目标状态与生命周期（create/edit/pause/resume/complete/block/clear/disarm），事件源
- `goal-round-driver`（已挂载） — 目标轮次驱动：带竞态护栏的自主续跑（一轮一拍）
- `jobs`（`ctx.jobs`） — `ctx.jobs`：后台作业注册表（start/list/get/read/kill/wait、`jobs.events.subscribe`），跨 agent 共享 id、owner 隔离；0.1.7 起 caller 是会话 id 字符串
- `jobs-local`（已挂载） — jobs 缝的进程内实现（作业留在宿主进程）
- `plan-mode`（`ctx.planMode`，已挂载） — `ctx.planMode`：按 agent 记录的 plan 模式（get/set）+ 用户复核的退出流程，落会话日志
- `subagent`（`ctx.subagents`，已挂载） — `ctx.subagents`：命名 provider 注册表与委派编排（registerProvider/getProvider/start/startContinuable/sendMessage/interrupt/listChildren）——扩展点
- `subagent-fork-in-process`（已挂载） — 同进程 fork 后端：子 agent 以父会话日志前缀为 seed（继承对话上下文）
- `subagent-in-process-driver` — 同进程运行共享驱动：在 ctx.agents 上驱动子 agent（spawn / fork 两个后端共用）
- `subagent-spawn-in-process`（已挂载） — 同进程 spawn 后端：全新子 agent，不带父上下文
- `tool-goal`（已挂载） — 模型面同会话目标工具（带执行期权限校验）
- `tool-jobs`（已挂载） — 模型面后台作业工具：job_output / job_list / job_kill（走 ctx.jobs）
- `tool-ralph`（已挂载） — 模型面 fresh-agent Ralph 循环（基于 workflow + subagent 缝）
- `tool-subagent`（已挂载） — 模型面子代理委派工具 `subagent` / `subagent_fork`（走 ctx.subagents）
- `tool-subagent-control`（已挂载） — 全局命名工具：send_message / interrupt_agent / list_agents（走 continuable 子代理）
- `tool-workflow`（已挂载） — 模型面 workflow 工具：跑 JavaScript 编排脚本（走 ctx.workflowEngine）
- `workflow`（`ctx.workflowEngine`） — `ctx.workflowEngine`：workflow 运行缝（start）、运行词汇与 workflow/\* 事件
- `workflow-ptc`（已挂载） — workflow 引擎（旧 `workflow-worker-thread` 改名）：脚本跑在共享的沙箱 Node PTC 运行时里
- `experimental-agent-team`（`ctx.agentTeams`） — 实验包：单会话内的 Agent Teams 花名册、持久 peer mailbox 与共享任务 DAG（需持久会话存储；不提供 worktree / 跨进程）
- `experimental-tool-agent-team` — 实验包：模型面 Agent Teams 工具（建 teammate / 发消息 / 任务板，走 ctx.agentTeams）

### 会话 / 上下文 / 存储（41，已挂载 21）

- `attachment`（`ctx.attachments`） — `ctx.attachments`：不可变附件存储缝
- `attachment-local`（已挂载） — 附件存储的本机实现（DSH_HOME 下内容寻址）
- `chunked-list` — 持久化的 append-only 分块列表（有界复制 + JSON checkpoint 校验）
- `compaction`（`ctx.compaction`） — `ctx.compaction`：上下文压缩缝（compactIfNeeded/compactNow/compactRegion）
- `compaction-basic`（已挂载） — token-meter 驱动的压缩策略 + LLM 摘要后端；fff 把 thresholdRatio 覆盖为 0.5
- `compaction-image-offload`（已挂载） — 图片卸载：超预算的请求图片换成占位并重试（面向支持图片的路由）
- `compaction-tool-result-pruner`（`ctx.toolResultPruner`，已挂载） — `ctx.toolResultPruner`：工具结果 surface 节点的 head/middle/tail 裁剪（免模型、可重放安全）
- `invariants`（`ctx.invariants`） — `ctx.invariants`：各包自有的运行时不变量注册表（register）
- `message-feedback`（`ctx.messageFeedback`） — `ctx.messageFeedback`：对已定稿 assistant 消息的会话日志评分/备注
- `session`（`ctx.sessions`，已挂载） — `ctx.sessions`：事件源会话仓库（create/prepare/enter/announce/flush/get/list/fork）；`Session.append(type,data)` + `header`（含 cwd）
- `session-checkpoint-policy`（已挂载） — 会话持久化检查点策略：在模型请求与工具有副作用前打语义检查点
- `session-format` — 会话日志格式迁移机制
- `session-format-catalog` — 构建期固定的首方会话格式 codec 与迁移目录
- `session-format-v0-to-v1` — 已发布 v0 会话 codec 与身份迁移到 v1
- `session-format-v1-to-v2` — 已发布 v1 会话 codec 与 assistant-stream 迁移到 v2
- `session-format-v2-to-v3` — 流式 system-prompt、规范 envelope 与 PTC 迁移到 v3
- `session-format-v3-to-v4` — 流式 tool-role 消息与投递校验：会话格式 V3 → V4（0.1.7 现行格式）
- `session-log-deepseek`（已挂载） — 官方 DeepSeek LLM API 的增量无损会话日志请求扩展
- `session-log-export` — Web 侧会话日志导出命令与共享下载对话框
- `session-persistence`（`ctx.sessionPersistence`） — `ctx.sessionPersistence`：持久化会话缝
- `session-persistence-jsonl`（已挂载） — 会话持久化的 JSONL 后端
- `session-projection`（`ctx.sessionProjections`，已挂载） — `ctx.sessionProjections`：会话状态投影注册表（register/onChanged/stateOf/snapshot/checkpoint/restore）；本项目 context-report 的接入面
- `session-projection-cache`（`ctx.sessionProjectionCache`，已挂载） — `ctx.sessionProjectionCache`：投影落盘缓存（session_projcache 存储域、节流写回与缓存列表读）
- `session-query`（`ctx.sessionQuery`） — `ctx.sessionQuery`：会话查询服务（searchSessions/searchEvents/listEvents/traceSession/readSession/readSurface）
- `session-query-sqlite`（已挂载） — 会话查询的 SQLite FTS5 后端
- `session-reference`（`ctx.sessionReferenceResolver`） — `ctx.sessionReferenceResolver`：跨会话快照引用与持久化的不可信模型上下文（只读）
- `session-stats` — 整日志统计投影 `sessionStats`：对话轮次与墙钟时间
- `session-telemetry`（`ctx.sessionTelemetry`） — `ctx.sessionTelemetry`：会话事件采集/投影/脱敏与上报缝
- `session-telemetry-otel`（已挂载） — 遥测的 OpenTelemetry 后端（交给 OTel JS SDK 日志管道）
- `session-title`（`ctx.sessionTitle`，已挂载） — `ctx.sessionTitle`：基于日志的会话标题服务与 provider 注册（get/rename/refresh/register）
- `session-title-all-prompts-llm`（已挂载，树外加装） — 标题 provider：聚合**全部**符合条件的用户消息经 LLM 生成/更新标题（每条用户消息触发一次修订）；fff 以 `provider: ustc` / `model: deepseek-v4-flash` / `maxInputBytes: 32768` 覆盖——聚合输入超 `maxInputBytes` 即请求失败并**保留旧标题**（不截断历史），`ctx.sessionTitle.refresh()` 为显式重试；不随 dsh 分发，由 profile 自行安装（不计入 283）
- `session-title-first-prompt-llm`（已挂载，fff 禁用） — 标题 provider：用首条消息经 LLM 生成标题（只在首条人类消息时触发一次）；因 `ctx.sessionTitle` 只允许注册一个 provider（二次注册抛错），fff 在 patch 层置 `disabled: true` 后改挂 all-prompts 变体
- `session-title-llm` — 标题 provider 共享的 LLM 生成策略
- `session-turn-outline` — 整日志投影 `turnOutline`：回合大纲
- `spill`（`ctx.spillStore`） — `ctx.spillStore`：超大输出的落盘存储缝（saveText → 取回定位符）
- `spill-local`（已挂载） — spill 缝的本机实现（会话私有文件）
- `spill-policy`（已挂载） — 工具结果保留策略：超 token 预算的文本/图片结果转为可恢复路径（带预览）
- `storage`（`ctx.storage`，已挂载） — `ctx.storage`：命名后端注册表 + 挂载的数据形式（mount/form/domain）
- `storage-domain`（已挂载） — `ctx.storage.domain`：schema 校验、可发事件的 KV 数据域
- `storage-json`（已挂载） — 存储 hub 的 JSON 文件 KV 后端
- `token-meter`（`ctx.tokenMeter`，已挂载） — `ctx.tokenMeter`：可重放的 token/上下文计量（measure/estimateMessage，返回 surface/pressure/nodes）
- `workspace-changes` — 每轮工作区文件变更（从 git 工作树快照 + 整文件捕获记录，带逐文件对比）——deliverables 的数据面

### 工具与工具基建（16，已挂载 9）

- `tool-ask-user` — 模型面提问工具（ask_user_question），走 ctx.userQuestions
- `tool-bash`（已挂载） — 模型面 bash 工具（bash -c，每次新壳）；可选通用后台作业与沙箱升级支持
- `tool-bash-persistent` — 模型面持久 bash 工具：owner 作用域的 PTY 会话（走 ctx.terminals）
- `tool-call-timeout-policy`（已挂载） — 工具调用超时策略：`tools/execute` 包装器，按工具给 exec.signal 装截止时间并返回 TOOL_TIMEOUT
- `tool-cordis` — 模型面 cordis 运行时只读自省工具（插件开发用）
- `tool-fs`（已挂载） — 模型面文件工具 read/write/edit；写入经 fs-sandbox 校验，相对路径基准为会话 cwd
- `tool-fs-search`（已挂载） — 模型面文件搜索工具（glob / grep，底层是随包的 ripgrep 二进制）
- `tool-present` — 模型面交付声明工具：把工作区文件登记为交付物（只记路径、不拷内容）
- `tool-pwsh`（已挂载） — 模型面 pwsh 工具（走 bash 执行器缝）
- `tool-pwsh-persistent` — 模型面持久 PowerShell 工具：owner 作用域的 PTY 会话
- `tool-skill`（已挂载） — 模型面技能工具（加载并执行 skill）
- `tool-str-replace-editor` — 模型面字面替换编辑器：查看 / 创建 / 字面替换 / 行插入
- `tool-todo`（已挂载） — 模型面 todo 列表工具（todo_write，落事件源会话日志）
- `tool-web`（已挂载） — 模型面 web 工具（web_search / web_fetch，走 ctx.web）
- `tool-workspace-dependencies` — 模型面 load_workspace_dependencies 工具：给出随包 Python / Node.js / pnpm 载荷的绝对路径
- `tools`（`ctx.tools`，已挂载） — `ctx.tools`：工具注册表与执行管道（register/restrict/guard/get/schemas/execute/presentAs）；本工具集所有工具都经它注册

### 文件 / 进程 / 沙箱（19，已挂载 9）

- `bash-local` — bash 执行器的本机实现（spawn bash -c，可交给沙箱包装）
- `bash-sandbox`（已挂载） — 受沙箱约束的 shell 执行器：每条命令经 ctx.sandbox，回报拒绝/生效事实
- `fs`（`ctx.fs`） — `ctx.fs`：文件系统缝（文本 IO + 可选版本守卫的原子改动 + fs/\* 策略事件词汇）
- `fs-local` — 文件系统缝的本机实现
- `fs-observation-policy`（已挂载） — 读前/写前的观察策略（已观察状态、读后编辑、版本守卫写），本工具集 obs policy 的基础
- `fs-sandbox`（已挂载） — 文件沙箱：按每次调用的沙箱模式围住 write/edit（read-only 拒绝改动、workspace-write 限定工作区 + 临时根），读取放行
- `ptc-runtime`（`ctx.ptcRuntime`） — PTC 代码执行运行时缝（0.1.5 的 `code-runtime` 改名）
- `ptc-runtime-node`（已挂载） — PTC 运行时的沙箱 Node 进程实现（旧 `code-runtime-worker-thread` 的去向）
- `pwsh-local` — PowerShell 执行器的本机实现
- `pwsh-sandbox`（已挂载） — 受沙箱约束的 PowerShell 执行器
- `sandbox`（`ctx.sandbox`） — `ctx.sandbox`：子进程文件效果限制缝（同世界 confinement 词汇 + SandboxProvider 契约）
- `sandbox-local`（已挂载） — 本地沙箱后端：bwrap、npm 分发的 landlock-run、macOS Seatbelt、Windows ACL 受限令牌，功能探测后 fail-closed
- `sandbox-policy`（`ctx.sandboxPolicy`，已挂载） — `ctx.sandboxPolicy`：沙箱策略唯一所有者（resolve/overrideOf/defaultMode）；`resolve()` 以 `session.header.cwd` 为写入根
- `sandbox-windows-acl` — Windows ACL 写限制沙箱后端（受限令牌 + capability-SID 写白名单）
- `shell`（`ctx.shell`） — `ctx.shell`：shell 能力缝（run/start/resolve）
- `shell-env`（`ctx.shellEnv`，已挂载） — `ctx.shellEnv`：DSH\_\* shell 环境变量注册表（register/collect/list）
- `subprocess`（`ctx.subprocess`） — `ctx.subprocess`：子进程能力缝（进程组托管、有界 spill 输出、升级 kill）
- `subprocess-local`（已挂载） — 子进程缝的本机实现（本机进程 + 沙箱包装）
- `win32-process` — Windows 低层进程 / stdio / Job Object 原语

### LLM 与模型（9，已挂载 8）

- `deepseek-llm-api-extensions`（`ctx.deepseekLlmApiExtensions`，已挂载） — 官方 DeepSeek LLM API 适配器的附加请求字段注册表
- `llm`（`ctx.llm`，已挂载） — `ctx.llm`：provider 无关的模型服务（registerAdapter/stream/listProviders/discoverModels/resolveModelInfo/prepareCall）
- `llm-deepseek` — DeepSeek Messages 适配器
- `llm-deepseek-account`（已挂载） — DeepSeek 账号 provider 的认证与发现（走账号凭据）
- `llm-deepseek-api-key`（已挂载） — DeepSeek api-key provider 的认证与发现
- `llm-pi-ai`（已挂载） — pi-ai provider（兼容多家 OpenAI 式路由；fff 的 ustc 路由走它）
- `llm-retry`（已挂载） — 按 provider 路由的模型调用重试策略
- `plugin-package-inventory-deepseek`（已挂载） — 官方 DeepSeek LLM API 请求携带「当前 Loader 已装插件清单」的库存数据
- `repeat-tool-reminder`（`ctx.llm`，已挂载） — 同工具重复调用提醒（防打转）

### 技能 / 命令 / Web / 集成（26，已挂载 11）

- `command-compact`（已挂载） — slash 命令：手动触发压缩
- `command-feedback`（`ctx.sessionFeedback`，已挂载） — slash 命令：消息反馈（评分/备注）+ sessionFeedback Host Remote
- `command-goal`（已挂载） — slash 命令：目标的创建/查看/控制
- `commands`（`ctx.commands`，已挂载） — `ctx.commands`：slash 命令注册与执行（register/list/find/execute）
- `hook-protocol` — Claude Code / Codex 钩子线协议（匹配器、stdio/退出码编解码、多钩子合并、hook/\* 会话事件）
- `hooks-claude-code` — Claude Code hooks.json / settings 钩子配置的接入桥
- `hooks-codex` — Codex hooks.json 钩子配置的接入桥
- `mcp-client` — MCP 客户端桥：连 MCP server 并把其工具注册到 ctx.tools
- `mcp-resources`（`ctx.mcpResources`，已挂载） — 作用域化的 MCP 资源发现与读取（经共享模型工具）
- `office-to-pdf`（`ctx.officeToPdf`） — Office → PDF 共享转换（有界队列 + 缓存）
- `schedule`（`ctx.schedule`） — 宿主级持久提醒：统一管理 + 回到原会话投递
- `skill`（`ctx.skills`，已挂载） — `ctx.skills`：技能注册表（registerProvider/register/list/get/snapshot）
- `skill-badge`（已挂载） — 内置 badge 技能 provider
- `skill-filesystem`（已挂载） — 从文件系统加载技能（SKILL.md）
- `skill-office` — 内置 Word / PowerPoint / Excel 工作流与结构检查技能
- `time-context` — 每步的持久上下文：当前时间与已耗时
- `timeout` — 零依赖超时/截止原语（clampTimeout/deadline/timeoutOf，只做计时与分类）
- `web`（`ctx.web`，已挂载） — `ctx.web`：搜索/抓取 provider 注册表与执行（registerSearchProvider/registerFetchProvider/search/fetch）
- `web-app` — `@deepseek-ai/dsh-web-app` bundle：dsh-base 之上的浏览器面 patch 层 + 运行时胶水（前端 dist 服务、web-surface 提示、bash 运行时变量）
- `web-fetch-http`（已挂载） — 匿名公开 HTTP(S) 抓取 provider
- `web-frontend` — Web 应用入口构建（vite build `@deepseek-ai/dsh-client-web`，dist 由 `dsh web` 提供）——构建产物，无 `packages/` 源码
- `web-search-deepseek`（已挂载） — DeepSeek 搜索 provider（经 Anthropic 兼容 API 的原生 web_search）
- `webhook`（`ctx.webhookRuntime`） — `ctx.webhookRuntime`：fire-and-forget webhook 规则运行时（可创建 Workspace 支撑的会话）
- `webhook-github` — 带签名校验的 GitHub webhook 适配
- `libreoffice-kit` — 预编译 LibreOffice：Office 文档转换、重算与渲染——vendor 资产，无 `packages/` 源码
- `libreoffice-kit-wasm` — Linux Node WebAssembly OOXML→PDF 引擎资产——vendor 资产，无 `packages/` 源码

### 权限 / 安全 / 设置（11，已挂载 7）

- `anonymous-user-id` — 遥测与反馈关联用的匿名用户标识
- `authorization`（`ctx.authorization`，已挂载） — `ctx.authorization`：授权流程注册与执行（registerFlow/begin/describe/cancel）——经与人的对话取得凭据；`DECLINED` 是流程拒绝码而非服务名（见 §6）
- `credentials`（`ctx.credentials`） — `ctx.credentials`：凭据 provider 缝（settings 持引用、provider 持值）
- `credentials-local`（已挂载） — 凭据的本机实现（`$DSH_HOME/.env` + 活着的进程环境）
- `deepseek-account`（`ctx.deepseekAccount`） — 读取账号状态并解析官方 API 凭据
- `deepseek-account-platform`（已挂载） — 经浏览器 PKCE 授权 DeepSeek 账号
- `permission-presets`（`ctx.permissionPresets`，已挂载） — `ctx.permissionPresets`：权限预设（read-only / workspace-write / danger-full-access）；0.1.7 删 `selectFor`、新增 `catalog()` / `registerAuto()`
- `settings`（`ctx.settings`，已挂载） — `ctx.settings`：设置读写缝；0.1.7 起命名空间 = profile 插件条目 id，旧的 `settings-file` 文件后端已并入本包
- `user-approval`（`ctx.approval`，已挂载） — `ctx.approval`：审批服务（request/setPolicy/overrideOf）——沙箱升级必经此门，默认 fail-closed
- `user-questions`（`ctx.userQuestions`，已挂载） — `ctx.userQuestions`：向用户提问（ask）；TUI/客户端渲染选项
- `experimental-auto-review` — 实验包：Auto 权限预设下的逐工具 LLM 授权审查

### API 控制面（10，已挂载 1）

- `api-gateway`（`ctx.typertGateway`，已挂载） — `ctx.typertGateway`：remote/typert 网关（客户端↔宿主能力调用）
- `api-account-controller`（`ctx.accountController`） — 客户端侧账号安全操作（经认证 Remote）
- `api-job-controller`（`ctx.jobController`） — 作业 Remote 观察流 + 引用计数的客户端作业输出服务
- `api-remotes` — 远端能力（remote export）装配与调用
- `api-session-controller`（`ctx.sessionFileReferences/sessionSkillCatalog/sessionController`） — 会话控制器：客户端侧会话命令、冷读与实时控制传输
- `api-settings-controller`（`ctx.credentialsController/settingsController`） — 设置控制器：配置面的 Remote 归属（挂在设置域缝之上）
- `api-terminal-controller`（`ctx.terminalController`） — 会话私有交互终端：shell 发现、屏幕恢复与类型化 Remote 控制
- `api-workspace-controller`（`ctx.directoryPickerController/workspaceController`） — 工作区控制器：工作区 Remote 命令与可重连状态传输
- `api-workspace-files`（`ctx.workspaceFiles`） — 客户端侧工作区文件读取与变更（有界读、目录列举、活跃元数据）
- `experimental-api-speech-to-text`（`ctx.speechController`） — 实验包：浏览器客户端的认证语音转写

### 客户端 UI（web / 桌面）（62，已挂载 0）

- `client-connection`（`ctx.connection`） — 客户端连接管理：认证 RPC 传输与世代生命周期
- `client-file-upload`（`ctx.fileUploads`） — agent 作用域的浏览器文件上传、流式接收与暂存回执
- `client-hmr` — 客户端插件图同步与重建 bundle 的重载传输
- `client-locale` — 客户端语言/本地化：宿主侧偏好、可扩展语言目录、浏览器回落与内置词典
- `client-modules`（`ctx.clientModules`） — 客户端模块系统双面：宿主半组 `__DSH_BOOT__` 入口图，浏览器半是懒加载 CJS 模块表
- `client-resources` — 统一客户端资源模型：协议注册的 provider 把 URL 变成活值，经 useResource 消费
- `client-shortcuts` — 应用键盘命令注册表与物理键路由
- `client-store` — 免 React 的可观察/快照 store 契约 + 共享 Zustand/Immer 引擎
- `client-ui-agent-preset` — Web UI：agent 预设面（后续会话默认、本会话席位、组合编辑器）
- `client-ui-approval` — Web UI：审批请求接管（经作用域化 Remote 事件瀑布）
- `client-ui-attachment` — Web UI：附件动态呈现（输入区、消息图片、轨迹图片 slot）
- `client-ui-brand-official` — Web UI：侧栏 slot 的官方品牌资源
- `client-ui-chat` — Web UI：聊天主视图（会话目标、节点定义、渲染器与详情面）
- `client-ui-commands` — Web UI：slash 命令面（全局目录缓存、"/" 来源、三种命令 UI 与 popupSelect 注册表）
- `client-ui-conversation` — Web UI：与目标无关的会话装配（外壳、composer、队列与视图导航）
- `client-ui-cordis` — Web UI：cordis 动态插件定义卡（cordis_define 工具行 + 启停开关）
- `client-ui-deliverables` — Web UI：变更文件卡与逐文件对比 tab、交付卡、终答里的可点文件引用
- `client-ui-directory-picker-browse` — Web UI：应用内目录浏览面（渲染宿主的列举/创建原语）
- `client-ui-directory-picker-native` — Web UI：原生目录选择面（驱动 Desktop 或宿主 OS 选择器）
- `client-ui-goal` — Web UI：目标面（composer 上方的 GoalBar，读 goal 会话投影）
- `client-ui-input-trigger` — Web UI：输入触发管线（"/" 与 "@" 检测、候选菜单、路由到已注册来源）
- `client-ui-jobs` — Web UI：会话头后台作业列表与按需流式记录面板
- `client-ui-layout` — Web UI：三栏 AppFrame 外壳 + `ctx.layout` 视图状态服务（导航与面板）
- `client-ui-message-feedback` — Web UI：逐消息 Like/Dislike、反馈对话框（/feedback），背后是 messageFeedback 与 sessionFeedback Remote
- `client-ui-model-selection` — Web UI：模型选择（共享模型目录 + 会话投影 + session.selectModel）
- `client-ui-open-in-app` — Web UI：「在外部应用打开」控件（会话头打开工作区目录、预览打开单文件）
- `client-ui-permission-presets` — Web UI：权限面（通用设置里的新会话默认 + 当前会话 /permission 弹层）
- `client-ui-plan` — Web UI：plan 模式控件、持久 plan 卡与侧栏 Markdown 预览
- `client-ui-plugin-manager`（`ctx.pluginRegistryProbe`） — Web UI：侧栏插件面板（装/启/停/重试/组合已装插件包）
- `client-ui-primitives` — Web UI 纯 React 原子（控件、图标、Markdown、JSON 检视；零 cordis）
- `client-ui-reference` — Web UI：统一的 @文件 与 @会话 引用来源
- `client-ui-renderer` — 浏览器 UI 渲染器：React slot 绑定、ctx.uiRenderer 与应用装配根
- `client-ui-schedule` — Web UI：宿主任务管理页与会话提醒目录
- `client-ui-session` — Web UI：会话控制器适配器与按会话的 slot
- `client-ui-settings` — Web UI：设置域基础插件（共享配置表单与 settings slot 类型契约）
- `client-ui-settings-account` — Web UI：DeepSeek 登录管理与 Platform 账单页
- `client-ui-settings-agent-loop` — Web UI：agent-loop 命名空间设置页（并行工具调用上限）
- `client-ui-settings-general` — Web UI：通用设置段与产品引导（含版本化欢迎提示）
- `client-ui-settings-models` — Web UI：模型设置页与共享引导对话框
- `client-ui-settings-plugin-inventory` — Web UI：只读的 Cordis Loader 清单页（Web 插件设置里）
- `client-ui-settings-plugins` — Web UI：内置插件设置段（设置导航入口与 tab 外壳）
- `client-ui-settings-shell` — Web UI：shell 命名空间设置页（命令超时、单流输出上限）
- `client-ui-settings-subagent` — Web UI：Subagent 委派设置页（递归深度、并行容量、可选模型）
- `client-ui-settings-web-search` — Web UI：DeepSeek web 搜索 provider 设置页（API key、endpoint、单次搜索预算）
- `client-ui-shortcuts` — Web UI：快捷键速查、录制与本地偏好编辑
- `client-ui-sidebar` — Web UI：侧栏（会话多级树、搜索、分组、状态点）
- `client-ui-sidebar-browser` — Web UI：右侧栏的沙箱浏览器标签
- `client-ui-sidebar-documentpreview` — Web UI：侧栏文档预览（Office、表格、Markdown、代码、图片、PDF、HTML、纯文本）
- `client-ui-sidebar-files` — Web UI：右侧栏工作区文件树（经 workspaceFiles Remote 懒加载目录）
- `client-ui-sidebar-right` — Web UI：右侧栏停靠面（会话绑定状态、面板与展开控件）
- `client-ui-sidebar-terminal` — Web UI：右侧栏的交互 shell 标签
- `client-ui-skill` — Web UI：技能引用与专用技能工具行
- `client-ui-slots` — slot 注册表纯内核（类型化 Slots 与可复用 Component Factory、renderer 安装）
- `client-ui-subagent` — Web UI：子代理会话目录、续聊路由与 "@" 引用来源
- `client-ui-theme` — Web UI：主题（pre-plugin 调色板引导 + 免 DOM 的 ThemeRuntime + `--dsw-*` token）
- `client-ui-tool` — 客户端工具调用树渲染与逐工具呈现 slot
- `client-ui-trajectory` — Web UI：轨迹事件账本 + 交互式时序总览
- `client-ui-user-questions` — Web UI：ask_user_question 接管与 plan 复核呈现
- `client-ui-workflow-run` — Web UI：持久 workflow 运行会话节点与嵌套成员展开
- `client-ui-workspace` — Web UI：工作区选择器（注册进侧栏与空态 workspace slot）
- `experimental-client-ui-agent-team` — 实验 Web UI：Agent Teams 花名册、任务板与队友导航
- `experimental-client-ui-voice-input` — 实验 Web UI：录音并把可编辑文本插入对话草稿

### 插件 / 启动 / 基础设施（53，已挂载 7）

- `acp` — ACP（Agent Client Protocol）服务端：经 JSON-RPC stdio 驱动宿主 agent（进程外对接面）
- `acp-app` — `@deepseek-ai/dsh-acp-app` bundle：dsh-base 之上的 ACP profile 层（JSON-RPC stdio + 进程生命周期）
- `app-boot`（`ctx.pluginPackages`） — profile 组合与启动胶水：.env 加载、fail-loud Loader 守卫、快照感知的配置解析与启动序列
- `atomic-write` — 零依赖原子文件替换（独占创建随机后缀临时文件 + rename，带调用方声明的权限）
- `base` — `@deepseek-ai/dsh-base` bundle：base-backed profile 的第一层 patch（fff 唯一的官方 bundle）
- `brand` — 品牌化标量类型原语（无状态）
- `cmdline` — 不可变命令行交接（launcher → 任何 inject cmdlineArgs 的 app 插件）
- `config-editor`（`ctx.configEditor`，已挂载） — 经 profile patch 与 Loader 对账持久化插件配置
- `cordis` — vendored `@deepseek-ai/cordis`：Context / Service / Fiber / inject 容器本体（vendor，无 `packages/` 源码）
- `cordis-client-runner` — 双半插件包的浏览器半：事件订阅、闭包求值、guard 门面与 loader 条目
- `cordis-host-runner`（`ctx.cordisInspect/dynamicCordisRunner`） — 双半插件包的宿主半：动态包定义注册、沙箱生命周期与调用处理器表
- `cordis-plugin-group` — cordis 分组插件（vendor）
- `cordis-plugin-include` — cordis include 插件（引入外部配置，`- id:` / `- insert:` patch DSL 的实现侧）（vendor）
- `cordis-plugin-loader` — cordis 加载器（按配置装配插件树）（vendor）
- `cordis-plugin-timer`（`ctx.timer`，已挂载） — cordis 定时器插件（vendor）
- `cosmokit` — 通用工具集合（cordis 依赖，vendor）
- `deque` — 零依赖环形双端队列（均摊常数时间端操作、有界空闲空间）
- `headless` — `@deepseek-ai/dsh-headless` bundle：一次性任务执行（`dsh --profile headless "任务"`）
- `hmr`（`ctx.hmr`，已挂载） — 模块与 profile 配置的协调热重载（旧 `cordis-plugin-hmr` 改名）
- `home-paths` — DSH_HOME 路径解析（dshHomePath 等）
- `host-directory-picker`（`ctx.directoryPicker`） — `ctx.directoryPicker`：目录选择宿主能力缝
- `host-directory-picker-auto` — 目录选择：启动时按宿主情形选原生或浏览后端并挂载
- `host-directory-picker-browse` — 目录选择：应用内浏览后端（宿主文件系统的列举/创建原语）
- `host-directory-picker-native` — 目录选择：原生对话框后端
- `host-frontend-static` — Web 外壳的 SPA dist 服务（占用 webserver 回落席位，拒绝路径穿越）
- `host-open-in-app` — open-in-app 宿主半：解析出的应用目录、图标与三个 webServer 路由
- `host-plugin-inventory`（`ctx.pluginInventory`） — 只读的当前 Cordis Loader 插件状态 Remote 投影
- `host-webserver`（`ctx.webServer`） — `ctx.webServer`：宿主内嵌 web 服务器（HTTP/upgrade 路由、index 变换、静态回落）
- `http-proxy` — 进程级出站 HTTP 代理策略（从启动环境解析并装为 undici 全局 dispatcher）
- `launch-environment` — 不可变的启动环境快照（记录每个值由哪一层提供）
- `lazy-require` — 调用方相对、成功缓存的懒加载（面向 CJS 兼容的宿主依赖）
- `native-command` — 宿主原生命令与路径打开（免 shell 执行、取消、桌面探测、WSL 交接）
- `node-addon-system` — Node 原生插件系统入口（预编译系统原语：Linux Landlock launcher 与异步 POSIX flock）——vendor 预编译产物，无 `packages/` 源码
- `node-addon-system-linux-x64` — 同上 linux-x64 二进制（静态 Landlock launcher + glibc/musl flock addon）——vendor 预编译产物，无 `packages/` 源码
- `package-manifest` — package.json 的 `dsh` 配置字段共享类型声明
- `plugin-manager`（`ctx.pluginManager`，已挂载） — 当前 profile 的插件与 bundle 管理（CLI / Web / agent 工具共用）
- `schemastery` — 类型驱动的 schema 校验库（cordis 生态，vendor）
- `scope` — 作用域注册原语（scope 标签、按作用域过滤的事件派发）
- `sdk-app` — `@deepseek-ai/dsh-sdk-app` bundle：stdio JSON-RPC 服务与进程生命周期
- `sdk-jsonrpc-server` — 进程外 SDK 客户端的 stdio JSON-RPC 服务端
- `sdk-minimal` — `@deepseek-ai/dsh-sdk-minimal` bundle：JSON-RPC + 一个 DeepSeek 适配器 + 持久 shell + JSONL 会话
- `sdk-protocol` — SDK 线协议（换行分隔 JSON-RPC stdio 传输与请求/结果/通知类型）
- `system-prompt`（`ctx.systemPrompt`，已挂载） — `ctx.systemPrompt`：系统提示与运行时上下文贡献面（section/context/variable/tools/assemble）
- `typert-loader`（已挂载） — 生成的 Typert 包贡献物的 Loader 集成
- `typert-protocol` — 与编译器无关的 Remote 元数据与 Typert provider 协议
- `typert-registry`（`ctx.typert`，已挂载） — `ctx.typert`：生成的包反射与 Zod schema 的运行时注册表（register/get/resolve/list/getPackage）
- `util-code-language` — 文件扩展名 → 语法高亮语言的单表（客户端代码面与宿主 read 卡共用）
- `util-crypto` — 浏览器安全的 UUID 与字节编码助手（零依赖）
- `util-time` — 线边界共用的时间词汇（IANA 时区校验与规范化）
- `util-values` — 防重复安装的值原语
- `util-workspace-path` — 浏览器安全的工作区路径与展示助手
- `workspace`（`ctx.workspaceRegistry`） — `ctx.workspaceRegistry`：工作区实体注册表与归档（create/list/archive/resolveByPath）
- `experimental-agent-team-profile` — 实验 bundle：Agent Teams 协作、工具与 Web UI 打包一处（默认关闭，仅显式启用）

### 终端（2，已挂载 0）

- `terminal`（`ctx.terminals`） — `ctx.terminals`：持久 PTY 会话缝（owner 作用域 id、后端注册、交互发送/读/信号/等待清理）
- `terminal-bash` — 基于 subprocess 终端原语的持久 shell PTY 后端

### 其他（7，已挂载 0）

- `file-reference`（`ctx.fileReferences`） — 文件引用发现契约与共享 @file 语法
- `file-reference-local` — 本机文件系统的 ctx.fileReferences provider（有界模糊索引）
- `output-retention` — 零依赖有界保留原语（ItemRetainer/TextRetainer + 中性提示：留了什么、略了什么）
- `tmux-context`（`ctx.llm`） — 每步注入本 agent 的 tmux pane/window 位置（需显式开启）
- `experimental-speech-to-text`（`ctx.speechToText`） — 实验包：语音识别（provider 可独立选择）
- `experimental-speech-to-text-sensevoice` — 实验包：本地 SenseVoice ONNX 转写（托管 sherpa-onnx 进程）
- `experimental-voice-input-bundle` — 实验 bundle：本地 SenseVoice 语音输入（首次使用下载运行时）

## 3. 服务索引（`ctx.<服务名>` → 归属包）

共 **84** 个服务名（`super(<ctx>, "name")` 口径；提取正则另会命中 `DECLINED` 这个错误码，已剔除，见 §6）。多归属的按「包名，挂载状态」逐项列出；同一个包注册多个服务时不重复列包。

- `accountController`（`api-account-controller`，未挂载） — 客户端侧账号安全操作
- `agentDefaultModel`（`agent-default-model`，已挂载） — 各 agent 入口共享的默认模型选择
- `agentLoop`（`agent-loop`，已挂载） — 具体 agent 回合驱动
- `agentPresets`（`agent-preset-registry`，未挂载） — 声明式 agent preset 注册表与编辑面
- `agentTeams`（`experimental-agent-team`，未挂载） — 单会话 Agent Teams 花名册、持久信箱与任务板
- `agents`（`agent`，已挂载） — agent 接口与注册表
- `approval`（`user-approval`，已挂载） — 审批服务（沙箱升级必经）
- `attachments`（`attachment`，未挂载） — 不可变附件存储缝
- `authorization`（`authorization`，已挂载） — 授权流程注册与执行
- `clientModules`（`client-modules`，未挂载） — 客户端模块加载（浏览器端插件）
- `commands`（`commands`，已挂载） — slash 命令注册与执行
- `compaction`（`compaction`，未挂载） — 上下文压缩缝
- `configEditor`（`config-editor`，已挂载） — 经 profile patch 持久化插件配置
- `connection`（`client-connection`，未挂载） — 客户端连接（传输/会话订阅）
- `cordisInspect`（`cordis-host-runner`，未挂载） — cordis 运行时自省
- `credentials`（`credentials`，未挂载） — 凭据 provider 缝
- `credentialsController`（`api-settings-controller`，未挂载） — 客户端侧凭据管理
- `deepseekAccount`（`deepseek-account`，未挂载） — DeepSeek 账号状态与官方凭据解析
- `deepseekLlmApiExtensions`（`deepseek-llm-api-extensions`，已挂载） — 官方 DeepSeek API 的附加请求字段
- `directoryPicker`（`host-directory-picker`，未挂载） — 目录选择宿主能力缝
- `directoryPickerController`（`api-workspace-controller`，未挂载） — 客户端侧目录选择控制
- `dynamicCordisRunner`（`cordis-host-runner`，未挂载） — 动态 cordis 包加载
- `fileReferences`（`file-reference`，未挂载） — 文件引用解析（@文件提及）
- `fileUploads`（`client-file-upload`，未挂载） — 客户端文件上传
- `fs`（`fs`，未挂载） — 文件系统缝
- `goals`（`goal`，已挂载） — 同会话目标状态与生命周期
- `hmr`（`hmr`，已挂载） — 模块与 profile 配置热重载
- `invariants`（`invariants`，未挂载） — 包自有运行时不变量注册表
- `jobController`（`api-job-controller`，未挂载） — 作业 Remote 观察流与客户端输出服务
- `jobs`（`jobs`，未挂载） — 后台作业注册表
- `llm`（`llm`，已挂载；`repeat-tool-reminder`，已挂载；`tmux-context`，未挂载） — 模型运行时；后两者在其上挂 hook/上下文
- `mcpResources`（`mcp-resources`，已挂载） — MCP 资源发现与读取
- `messageFeedback`（`message-feedback`，未挂载） — 已定稿消息的评分/备注
- `officeToPdf`（`office-to-pdf`，未挂载） — Office → PDF 转换
- `permissionPresets`（`permission-presets`，已挂载） — 权限预设（含 0.1.7 的 `catalog()`/`registerAuto()`）
- `planMode`（`plan-mode`，已挂载） — 按 agent 记录的 plan 模式
- `pluginInventory`（`host-plugin-inventory`，未挂载） — 已装插件清单查询
- `pluginManager`（`plugin-manager`，已挂载） — 当前 profile 的插件/bundle 管理
- `pluginPackages`（`app-boot`，未挂载） — 启动期的包清单解析面
- `pluginRegistryProbe`（`client-ui-plugin-manager`，未挂载） — 客户端插件管理所需的注册表探针
- `ptcRuntime`（`ptc-runtime`，未挂载） — PTC 代码执行运行时缝（旧 `codeRuntime`）
- `sandbox`（`sandbox`，未挂载） — 子进程文件效果限制缝
- `sandboxPolicy`（`sandbox-policy`，已挂载） — 沙箱策略唯一所有者
- `schedule`（`schedule`，未挂载） — 宿主级持久提醒
- `sessionController`（`api-session-controller`，未挂载） — 客户端侧会话操作
- `sessionFeedback`（`command-feedback`，已挂载） — 会话反馈 Remote（评分/备注）
- `sessionFileReferences`（`api-session-controller`，未挂载） — 会话文件引用
- `sessionPersistence`（`session-persistence`，未挂载） — 持久化会话缝
- `sessionProjectionCache`（`session-projection-cache`，已挂载） — 投影落盘缓存
- `sessionProjections`（`session-projection`，已挂载） — 会话状态投影注册表
- `sessionQuery`（`session-query`，未挂载） — 会话查询服务
- `sessionReferenceResolver`（`session-reference`，未挂载） — 跨会话快照引用（只读）
- `sessionSkillCatalog`（`api-session-controller`，未挂载） — 客户端侧技能目录
- `sessionTelemetry`（`session-telemetry`，未挂载） — 会话事件采集/脱敏/上报缝
- `sessionTitle`（`session-title`，已挂载） — 会话标题服务与 provider 注册
- `sessions`（`session`，已挂载） — 事件源会话仓库
- `settings`（`settings`，已挂载） — 设置读写缝（命名空间 = profile 插件条目 id）
- `settingsController`（`api-settings-controller`，未挂载） — 客户端侧设置管理
- `shell`（`shell`，未挂载） — shell 能力缝
- `shellEnv`（`shell-env`，已挂载） — DSH\_\* shell 环境变量注册表
- `skills`（`skill`，已挂载） — 技能注册表
- `speechController`（`experimental-api-speech-to-text`，未挂载） — 浏览器端语音转写控制面
- `speechToText`（`experimental-speech-to-text`，未挂载） — 语音识别缝
- `spillStore`（`spill`，未挂载） — 超大输出落盘缝
- `storage`（`storage`，已挂载） — 命名后端注册表与数据形式
- `subagents`（`subagent`，已挂载） — 命名 provider 注册表与委派编排
- `subprocess`（`subprocess`，未挂载） — 子进程能力缝
- `systemPrompt`（`system-prompt`，已挂载） — 系统提示与上下文贡献面
- `terminalController`（`api-terminal-controller`，未挂载） — 会话私有交互终端控制面
- `terminals`（`terminal`，未挂载） — 持久 PTY 会话服务
- `timer`（`cordis-plugin-timer`，已挂载） — cordis 定时器
- `tokenMeter`（`token-meter`，已挂载） — 可重放的 token/上下文计量
- `toolResultPruner`（`compaction-tool-result-pruner`，已挂载） — 工具结果 head/middle/tail 裁剪
- `tools`（`tools`，已挂载） — 工具注册表与执行管道
- `typert`（`typert-registry`，已挂载） — 远程能力注册表（register/get/resolve/list/getPackage）
- `typertGateway`（`api-gateway`，已挂载） — remote/typert 网关
- `userQuestions`（`user-questions`，已挂载） — 向用户提问
- `web`（`web`，已挂载） — 搜索/抓取 provider 注册表与执行
- `webServer`（`host-webserver`，未挂载） — 宿主内嵌 web 服务器
- `webhookRuntime`（`webhook`，未挂载） — webhook 运行时
- `workflowEngine`（`workflow`，未挂载） — workflow 运行缝
- `workspaceController`（`api-workspace-controller`，未挂载） — 客户端侧工作区操作
- `workspaceFiles`（`api-workspace-files`，未挂载） — 客户端侧工作区文件读取与变更
- `workspaceRegistry`（`workspace`，未挂载） — 工作区实体注册表

## 4. 0.1.7-rc.2 里没有的（与我们的待办相关）

- **仍然没有 git worktree 隔离包（成立）**：283 个随包分发包里没有按 agent 隔离工作目录的实现（对应待办 #15），官方源码树里也没有 worktree 类包。0.1.7 新增的 `experimental-agent-team` 明确不做：其 README 写「成员共享 cwd，修改立即可见」「本包不提供 worktree、远端成员、merge 或文件锁」，并把「通过 worktree 实现文件系统隔离」列进**未承诺**的未来方向。
- **跨会话消息：跨会话仍没有，但同会话内的 agent 间持久信箱有了（旧结论需改写）**：旧版三条之一的「不存在 broker / intercom / socket / IPC 类的 agent 间通道」，对「跨会话」这半仍成立——跨会话依旧只有只读的 `session-query` / `session-reference`。但 0.1.7 新增 `experimental-agent-team`（`ctx.agentTeams`）+ `experimental-tool-agent-team`：在一个会话内提供 Lead/teammate 花名册、**持久 peer mailbox**（成员离线时消息排队、恢复后投递）与共享任务 DAG，需持久会话存储才能激活。它明确不跨进程（「跨进程 mailbox 事务」列为未来方向），也不给成员独立工作目录。故：待办 #30 若指「跨会话/跨进程」，结论不变；若指「同一会话里多 agent 互发持久消息」，已有官方实验实现可直接取用。
- **仍然没有跨进程 subagent provider（成立）**：283 个里 `packages/subagent/` 只分发 6 个包——`subagent`（缝）+ `subagent-fork-in-process` + `subagent-spawn-in-process` + `subagent-in-process-driver` + 2 个工具包；provider 仍只有 `spawn` / `fork` 两个**进程内**实现。`subagent-acp` / `subagent-dsh-sdk` / `subagent-claude-code` / `subagent-codex` 仍只存在于官方源码仓库（`packages/subagent/` 下共 10 个包），不在随包分发里。
- **0.1.7 新增能力面（可选清单）**：deliverables（`tool-present` 交付声明 + `workspace-changes` 每轮变更记录，客户端有 `client-ui-deliverables` 变更卡）、PTC 运行时（`ptc-runtime` + `ptc-runtime-node`，取代 `code-runtime` 家族）、Agent Teams 与语音输入（均 experimental）、宿主运维面（`plugin-manager` / `config-editor` / `hmr`）、`compaction-image-offload`（图片卸载）、`session-format-v3-to-v4`（V3→V4 迁移库）、`mcp-resources`、`schedule`、`office-to-pdf` + `skill-office` + `libreoffice-kit*` 文档链、`deepseek-account-platform`（PKCE 登录）。逐条说明与证据见 `HOST-UPGRADE-0.1.7-rc.2.md` §4。
- **官方源码有、随包分发没有的（想要得自己找）**：SSH 家族（`ssh` / `fs-ssh` / `sandbox-ssh` / `subprocess-ssh`）、`browser-use` / `computer-use` 及 6 个实验 provider、LSP 三件套（`lsp` / `lsp-stdio` / `tool-lsp`）、`subagent-acp` / `subagent-claude-code` / `subagent-codex` / `subagent-dsh-sdk`、`storage-sqlite`、`tool-terminal`、`tool-session-query`、`web-search-exa` / `web-search-perplexity`、`session-snapshot`、`experimental-ptc-runtime-python` 等（官方源码 312 个 `@deepseek-ai/dsh-*` 包 vs 随包分发 272 个）。`session-title-all-prompts-llm` 同属这一类，但它是 fff 自己装进 profile 的——本清单 §1 的 91 个里唯一一个不随 dsh 分发。

## 5. 对本项目的落点

- **本项目 13 个包不在这 283 个里**：`@dsh-toolset/*`（TUI + 12 个进程内插件）以 `link:` 依赖 + bundle 行挂进 profile（`package.json` 的 `dsh.profile.bundles` + 各自的 `cordis.patch.yml`），与官方包「已装但未挂载」的形态不同。
- **我们 inject / 读取的宿主服务**：`inject` 里显式声明 6 个——`tools`（全部工具注册）、`agents`、`sessions`、`sessionProjections`（context-report 的 `sessionContext` 投影）、`userQuestions`、`goals`；其余经 `ctx.get()` 读取——`jobs`、`commands`、`sessionQuery`、`sessionTitle`、`skills`、`subagents`、`llm`（含 `agentDefaultModel`）、`agentPresets`、`settings`、`permissionPresets`、`web`、`workflowEngine`、`lsp`；另有事件面消费（TUI 订 `approval/policy`、`skill/*` 等）。`slots` 零引用（客户端面）。接口怎么用见 `DSH-CTX-API.md`；0.1.7 的逐项兼容判定见 `HOST-UPGRADE-0.1.7-rc.2.md` §3.2。
- **启用未挂载的官方包不需要安装**：包已随 dsh 装在共享 `node_modules`，在 profile 的 `cordis.patch.yml` 加一行（或 `dsh plugin --profile <p> add <包名>`）即可。例外是 §4 的「源码有、不分发」包与树外加装包——那些要自己装。
- **升级注意（0.1.7 的事实）**：
  - `codeRuntime` → `ptcRuntime`：服务改名，且 `run(request)` 拆成 `resolve(request) → spec` + `run(spec)`（Node 提供方要求 spec 带 `cwd` / `sandboxPolicy`）。output-compress 已改为反射 `ptcRuntime` 并保留 `codeRuntime` 回退（双栈过渡）。
  - `dsh-settings-file` 删除：settings 命名空间改为 **profile 插件条目 id**，写入落 profile 的 `cordis.patch.yml`；旧 `~/.dsh/settings.yaml` 退化为一次性导入源（启动时改名 `.imported` 逐段导入，无对应条目的段 warning 后丢弃）。fff 首次启动已把 `agent-default-model` / `llm-pi-ai` 段落进 profile patch。
  - preset 机制改声明式：目录式 roster（`agent-presets` 包）删除，改为 profile YAML 的 `agent-preset-registry`（服务名 `agentPresets` 不变）+ `agent-preset` 声明行。「TUI 不用 preset、走 profile 全局组合」的结论不变（见 `AGENT-COMPOSITION.md`）；两包在本 profile 均不挂载，属预期。
  - 启动失败语义反转：只有 7 个硬编码 id 是必需条目，其余 `inject` 未满足只打 stderr warning 后继续启动——升级后建议断言启动 stderr 无 `did not activate`（本次实测无）。
  - 会话格式 V3 → V4（读旧会话在内存转换、写入时才在旧文件旁发布 successor）；`Session.eventAt/snapshotEvents/ownEvents` 标 `@deprecated`（我方未使用）。
- **升级方式**：`npm i -g @deepseek-ai/dsh@0.1.7-rc.2`（或 `@next`；`scripts/install.sh` 的默认版本已同步为 `0.1.7-rc.2`）。**不要用 `npm update -g`**——npm 的 `latest` 仍停在 `0.1.5-rc.3`（dist-tags：`next` = `0.1.7-rc.2`、`alpha` = `0.1.7-alpha.2`），`npm update -g` 只会把 CLI 停在/拉回 0.1.5-rc.3。升级 CLI 后 fff 的官方包软链随安装树整体换版本，但**树外加装包（`session-title-all-prompts-llm`）要自己升版**（profile 目录里 `npm pkg set` 后 `pnpm install`）。

## 6. 复现命令（宿主升级后重新生成）

```sh
D=$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai
# 1) 包列表 + 描述 + 版本
for d in "$D"/*/; do node -p "const j=require('$d/package.json'); [j.name, j.version, (j.description||'').replace(/\s+/g,' ')].join('\t')"; done
# 2) 服务名（每包里 super(<ctx>, "name") 的注册名）
grep -rhoE 'super\([a-zA-Z_]+, *"[a-zA-Z,]+"' "$D"/*/lib/index.js | sed -E 's/.*"([^"]*)"/\1/' | tr ',' '\n' | sort -u
# 3) fff 挂载的包（解析 profile 用户 patch + dsh-base bundle patch 的 name 行）
{ grep -rhoE "name: '@deepseek-ai/[^']+'" ~/.dsh/profiles/fff/cordis.patch.yml "$D/dsh-base/cordis.patch.yml"; } | sed "s/name: '//;s/'$//" | sed -E 's#^(@deepseek-ai/[^/]+).*#\1#' | sort -u
```

本文件由 **2026-09-25** 那次采集生成：宿主 `dsh --version` = `0.1.7-rc.2`，安装树在 `$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai` 下共 283 个包（工作区 checkout = tag `dsh-v0.1.7-rc.2`）。

核对口径：

- **服务名只取包的主入口 `lib/index.js`**：客户端面（`lib/client.js`，如 `slots`、`uiSession`）与未挂载的子路径入口（如 `tool-subagent/model-selection-settings` 的 `subagentModelSelection`）注册的服务不算该包的 host 服务。
- **第 2 条正则有两个需要手工收拾的地方**：它会命中错误类的 `super(message, "DECLINED")`（授权流程的拒绝码）——本版 85 个候选里 84 个是服务名，`DECLINED` 须剔除；`repeat-tool-reminder` 与 `tmux-context` 打出的 `llm` 是改写 `ctx.llm` 的 hook 面，按旧版口径与 `llm` 同列一行。
- **第 3 条要按包名前缀归并子路径条目**（patch 里会出现同一包的第二入口，如 `@deepseek-ai/dsh-tool-subagent-control/list-agents`）→ 91 个，含树外加装包 `session-title-all-prompts-llm`（它来自 profile 用户 patch，不随 dsh 分发）。不要把 profile `package.json` 的 `dsh.profile.bundles` 行也算进来——那会多出 `dsh-base` 这个 bundle 名。上表同样不含本项目 13 个 `@dsh-toolset/*` 行，也不含 TUI bundle 自行 `- insert:` 的 `@deepseek-ai/dsh-tool-ask-user`。
- `dsh --profile fff --dump-config` 可交叉验证（本次升级记录里成功执行过）；若 profile 目录只读，它会因写 `cordis.yml` 失败（EROFS），此时以上面的解析方式为准。
