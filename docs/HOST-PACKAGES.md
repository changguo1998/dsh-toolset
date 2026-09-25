# 可用官方包清单（DSH 0.1.5-rc.3）

> 来源：本地安装的官方 deepseek-harness（全局 dsh `0.1.5-rc.3`，`~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）；与源码 clone（`~/GithubRepos/deepseek-harness`，`dsh-v0.1.5-rc.3` = commit `a4c74a91e0`）同版本。
> 用途：与 `DSH-CTX-API.md` 配套——该文件记「接口怎么用」，本文件记「有哪些包、每个包提供什么服务」；供 dsh-toolset 各插件选型与集成对齐。
> 版本口径：只记 `0.1.5-rc.3` 实际随包分发的内容；服务名与描述由安装目录实测提取（见文末复现命令）。宿主升级后需重新生成。
> rc.2 → rc.3 只有发布改动（版本号 + vendor 家族依赖由 `workspace:^` 改为 `workspace:*` 精确钉版），随包分发的 240 个包、描述、服务名与 fff 挂载集合均逐项实测一致，故清单内容未变。
> 升级提示（2026-09-25 核对官方 `master` `477b4f4205` = `dsh-v0.1.7-rc.2`）：preset 机制已重写——目录式 roster（`agent-presets`）删除，改为 profile YAML 里的 `agent-preset-registry` + `@deepseek-ai/dsh-agent-preset` 声明；「TUI 不使用 preset、走 profile 全局组合」的结论不变（见 `AGENT-COMPOSITION.md`）。升级后本文件需重新生成。

## 0. 怎么读这份清单

- 每行格式：`包名`（`ctx.<服务名>`，已挂载） — 官方一句话定位。
- **`（ctx.x）` 表示该包注册了这个 host 服务**，是我们插件 `inject` 的对象；没有的包是工具/后端/客户端资产，通过别的服务被消费。
- **`已挂载`** 指 `fff` profile（`dsh-base` bundle）启动时会加载它；未标记的包虽已随 dsh 安装、但该 profile 不加载。
- **`树外加装`** 指该包未随 dsh 分发，由 `fff` profile 自行安装（`dsh plugin add`，落到 profile 的 `node_modules`）并在其 `cordis.patch.yml` 用 `- insert:` 挂载；当前仅 `session-title-all-prompts-llm` 属此类（不随装、按需启用）。
- **`agent-presets` 未挂载是设计结果，不是缺配置**：官方只让 Web 面（`web-app` bundle）禁用 base 的 agent 面行并挂 preset registry，TUI 这类单组合面保持 base 的进程级 agent 组合（`packages/bundle/web-app/cordis.patch.yml` 的 "composes its agent process-wide" 注释、`packages/client/ui-user-questions/README.md` 的 "the TUI composition, which has no presets"）。依据、验证与版本断层见 `AGENT-COMPOSITION.md`；要改 agent 面请落 profile 用户 patch。
- 包名省略 `@deepseek-ai/dsh-` 前缀与作用域（`cordis-*` 来自 vendored cordis）。

## 1. 现成可用（fff 已挂载，82 个）

```
agent agent-default-model agent-instructions agent-loop api-gateway attachment-local bash-sandbox command-compact command-feedback command-goal commands compaction-basic compaction-tool-result-pruner cordis-plugin-hmr cordis-plugin-timer credentials-local deepseek-llm-api-extensions fs-observation-policy fs-sandbox goal goal-round-driver jobs-local llm llm-deepseek llm-pi-ai llm-retry permission-presets plan-mode plugin-package-inventory-deepseek pwsh-sandbox repeat-tool-reminder sandbox-local sandbox-policy session session-checkpoint-policy session-log-deepseek session-persistence-jsonl session-projection session-projection-cache session-query-sqlite session-telemetry-otel session-title session-title-first-prompt-llm settings-file shell-env skill skill-badge skill-filesystem spill-local spill-policy storage storage-domain storage-json subagent subagent-fork-in-process subagent-spawn-in-process subprocess-local system-prompt token-meter tool-bash tool-call-timeout-policy tool-fs tool-fs-search tool-goal tool-jobs tool-pwsh tool-ralph tool-skill tool-subagent tool-subagent-control tool-todo tool-web tool-workflow tools typert-loader typert-registry user-approval user-questions web web-fetch-http web-search-deepseek workflow-worker-thread
```

另有 1 个树外加装包未计入上表：`session-title-all-prompts-llm`（会话标题 provider，见 §2「会话 / 上下文 / 存储」）。

## 2. 全部分组清单（240 个）

### agent 与编排（23，已挂载 18）

- `agent`（`ctx.agents`，已挂载） — agent 接口与注册表：`ctx.agents`（create/resume/register/get/list/roots、initiator 作用域、agent/created 等事件词汇）；`CreateAgentOptions.meta.cwd` 是唯一能指定会话工作目录的公开参数
- `agent-default-model`（`ctx.agentDefaultModel`，已挂载） — `ctx.agentDefaultModel`：各 agent 入口共享的默认模型选择（currentSelection/saveSelection）
- `agent-instructions`（已挂载） — 工作区上下文加载器：读取 AGENTS.md / CLAUDE.md 指令文件注入提示
- `agent-loop`（`ctx.agentLoop`，已挂载） — `ctx.agentLoop`：具体的 agent 回合驱动（create/createAgent/resume）；`create(id, options, meta?: Pick<SessionHeader,'cwd'>)` 直吃 cwd
- `agent-presets`（`ctx.agentPresets`） — `ctx.agentPresets`：按预设 cordis.yml 做会话级 agent 组合（list/resolve/composeFrom/select/mount）；本 profile 不挂载（TUI 不走 preset，见 §0），且该目录式机制自 0.1.7-alpha.1 起被 `agent-preset-registry` + `agent-preset` 的声明式取代
- `agent-tool-presentation` — agent 面工具呈现选择器：把一个 agent 的工具组合成 PTC / native / 两者（presentAs）
- `goal`（`ctx.goals`，已挂载） — `ctx.goals`：同会话目标状态与生命周期（create/edit/pause/resume/complete/block/clear），事件源
- `goal-round-driver`（已挂载） — 目标轮次驱动：带竞态护栏的自主续跑（一轮一拍）
- `jobs`（`ctx.jobs`） — `ctx.jobs`：后台作业注册表（start/list/get/read/kill/wait/onJobDone/onJobsChanged），跨 agent 共享 id、owner 隔离
- `jobs-local`（已挂载） — jobs 缝的进程内实现（作业留在宿主进程）
- `plan-mode`（`ctx.planMode`，已挂载） — `ctx.planMode`：按 agent 记录的 plan 模式（get/set）+ 退出流程，落会话日志
- `subagent`（`ctx.subagents`，已挂载） — `ctx.subagents`：命名 provider 注册表与委派编排（registerProvider/getProvider/start/startContinuable/sendMessage/interrupt/listChildren）——扩展点
- `subagent-fork-in-process`（已挂载） — 同进程 fork 后端：子 agent 以父会话 completed-turn 前缀为 seed（继承对话上下文）
- `subagent-in-process-driver` — 同进程运行共享驱动 `startInProcessRun`：驱动 ctx.agents 上的子 agent；内部写死 `meta = childSessionMeta(parent,…)`，故请求级 cwd 传不进去
- `subagent-spawn-in-process`（已挂载） — 同进程 spawn 后端：全新子 agent，不带父上下文（45 行 provider 壳）
- `tool-goal`（已挂载） — 模型面同会话目标工具（带执行期权限校验）
- `tool-jobs`（已挂载） — 模型面后台作业工具：job_output / job_list / job_kill（走 ctx.jobs）
- `tool-ralph`（已挂载） — 模型面 fresh-agent Ralph 循环（基于 workflow + subagent 缝）
- `tool-subagent`（已挂载） — 模型面子代理委派工具 `subagent` / `subagent_fork`（走 ctx.subagents）
- `tool-subagent-control`（已挂载） — 全局命名工具：send_message / interrupt_agent / list_agents（走 continuable 子代理）
- `tool-workflow`（已挂载） — 模型面 workflow 工具：跑 JavaScript 编排脚本；`agent()` 的 `isolation` 选项被显式拒绝（宿主留位未实现）
- `workflow`（`ctx.workflowEngine`） — `ctx.workflowEngine`：workflow 运行缝（start）、运行词汇与 workflow/\* 事件
- `workflow-worker-thread`（已挂载） — worker-thread workflow 引擎：脚本在宿主事件循环之外执行，agent() 回桥到 ctx.subagents（执行隔离，非目录隔离）

### 会话 / 上下文 / 存储（38，已挂载 19）

- `attachment`（`ctx.attachments`） — `ctx.attachments`：不可变附件存储缝
- `attachment-local`（已挂载） — 附件存储的本机实现（DSH_HOME 下内容寻址）
- `chunked-list` — 持久化的 append-only 分块列表（有界复制 + JSON checkpoint 校验）
- `compaction`（`ctx.compaction`） — `ctx.compaction`：上下文压缩缝（compactIfNeeded/compactNow/compactRegion）
- `compaction-basic`（已挂载） — token-meter 驱动的压缩策略 + LLM 摘要后端；fff 把 thresholdRatio 覆盖为 0.5
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
- `session-log-deepseek`（已挂载） — 官方 DeepSeek LLM API 的增量无损会话日志请求扩展
- `session-log-export` — Web 侧会话日志导出命令与下载对话框
- `session-persistence`（`ctx.sessionPersistence`） — `ctx.sessionPersistence`：持久化会话缝
- `session-persistence-jsonl`（已挂载） — 会话持久化的 JSONL 后端
- `session-projection`（`ctx.sessionProjections`，已挂载） — `ctx.sessionProjections`：会话状态投影注册表（register/onChanged/stateOf/snapshot/checkpoint/restore）；本项目 context-report 的接入面
- `session-projection-cache`（`ctx.sessionProjectionCache`，已挂载） — `ctx.sessionProjectionCache`：投影落盘缓存（session_projcache 存储域，惰性 buildCell、缓存恢复时校验 stateSchema）
- `session-query`（`ctx.sessionQuery`） — `ctx.sessionQuery`：会话查询服务（searchSessions/searchEvents/listEvents/traceSession/readSession/readSurface）
- `session-query-sqlite`（已挂载） — 会话查询的 SQLite FTS5 后端
- `session-reference`（`ctx.sessionReferenceResolver`） — `ctx.sessionReferenceResolver`：跨会话快照引用与持久化的不可信模型上下文（只读）
- `session-stats` — 整日志统计投影 `sessionStats`：对话轮次与墙钟时间
- `session-telemetry`（`ctx.sessionTelemetry`） — `ctx.sessionTelemetry`：会话事件采集/投影/脱敏与上报缝
- `session-telemetry-otel`（已挂载） — 遥测的 OpenTelemetry 后端（交给 OTel JS SDK 日志管道）
- `session-title`（`ctx.sessionTitle`，已挂载） — `ctx.sessionTitle`：基于日志的会话标题服务与 provider 注册（get/rename/refresh/register）
- `session-title-all-prompts-llm`（已挂载，树外加装） — 标题 provider：聚合**全部**符合条件的用户消息经 LLM 生成/更新标题（每条用户消息触发一次修订、随会话演进；`messageSeqs` 即聚合到的消息序号）；fff 以 `provider: ustc` / `model: deepseek-v4-flash` / `maxInputBytes: 32768` 覆盖——聚合输入超 `maxInputBytes` 即请求失败并**保留旧标题**（不截断历史），`ctx.sessionTitle.refresh()` 为显式重试
- `session-title-first-prompt-llm`（已挂载，fff 禁用） — 标题 provider：用首条消息经 LLM 生成标题（只在首条人类消息时触发一次）；因 `ctx.sessionTitle` 只允许注册一个 provider（二次注册抛错），fff 在 patch 层置 `disabled: true` 后改挂 all-prompts 变体
- `session-title-llm` — 标题 provider 共享的 LLM 生成策略
- `session-turn-outline` — 整日志投影 `turnOutline`：回合大纲
- `spill`（`ctx.spillStore`） — `ctx.spillStore`：超大输出的落盘存储缝（saveText → 取回定位符）
- `spill-local`（已挂载） — spill 缝的本机实现（会话私有文件）
- `spill-policy`（已挂载） — 工具结果落盘策略：超大纯文本结果替换为保留预览 + spill 文件路径
- `storage`（`ctx.storage`，已挂载） — `ctx.storage`：命名后端注册表 + 挂载的数据形式（mount/form/domain）
- `storage-domain`（已挂载） — `ctx.storage.domain`：schema 校验、可发事件的 KV 数据域
- `storage-json`（已挂载） — 存储 hub 的 JSON 文件 KV 后端
- `token-meter`（`ctx.tokenMeter`，已挂载） — `ctx.tokenMeter`：可重放的 token/上下文计量（measure/estimateMessage，返回 surface/pressure/nodes）

### 工具与工具基建（15，已挂载 9）

- `tool-ask-user` — 模型面提问工具（ask_user_question），走 ctx.userQuestions
- `tool-bash`（已挂载） — 模型面 bash 工具（bash -c，每次新壳）；`workdir` 解析顺序 = 沙箱策略根 > 调用参数 > 会话 cwd
- `tool-bash-persistent` — 模型面持久 shell：跨调用保状态（变量/函数/当前目录）
- `tool-call-timeout-policy`（已挂载） — 工具调用超时策略（按工具设上限并中止）
- `tool-cordis` — 模型面 cordis 自省/操作工具（挂载在 ctx.cordisInspect 上）
- `tool-fs`（已挂载） — 模型面文件工具 read/write/edit/rm；写入经 fs-sandbox 校验，相对路径基准为会话 cwd
- `tool-fs-search`（已挂载） — 模型面文件搜索工具（glob / grep）
- `tool-present` — 模型面呈现工具（把工件交给用户/界面）
- `tool-pwsh`（已挂载） — 模型面 PowerShell 工具
- `tool-pwsh-persistent` — 模型面持久 PowerShell 会话
- `tool-skill`（已挂载） — 模型面技能工具（加载并执行 skill）
- `tool-str-replace-editor` — 模型面字面替换编辑器（str_replace 风格）
- `tool-todo`（已挂载） — 模型面 todo 列表工具（todo_write）
- `tool-web`（已挂载） — 模型面 web 工具（搜索/抓取，走 ctx.web）
- `tools`（`ctx.tools`，已挂载） — `ctx.tools`：工具注册表与执行管道（register/restrict/guard/get/schemas/execute/presentAs）；本工具集所有工具都经它注册

### 文件 / 进程 / 沙箱（18，已挂载 8）

- `bash-local` — bash 执行器的本机实现（spawn bash -c，可交给沙箱包装）
- `bash-sandbox`（已挂载） — 受沙箱约束的 shell 执行器：把命令包装进 ctx.sandbox 后执行
- `code-runtime`（`ctx.codeRuntime`） — 代码执行运行时（多语言、隔离执行）
- `code-runtime-worker-thread` — 代码执行运行时的 worker_thread 隔离后端
- `fs`（`ctx.fs`） — `ctx.fs`：文件系统缝（resolve/read/write/edit/listDir/stat/contains…）
- `fs-local` — 文件系统缝的本机实现
- `fs-observation-policy`（已挂载） — 读前/写前的观察策略（版本守卫等），本工具集 obs policy 的基础
- `fs-sandbox`（已挂载） — 文件沙箱：`checkedTarget` 重新解析路径并校验 containment，越界抛 FS_SANDBOX_DENIED
- `pwsh-local` — PowerShell 执行器本机实现
- `pwsh-sandbox`（已挂载） — 受沙箱约束的 PowerShell 执行器
- `sandbox`（`ctx.sandbox`） — `ctx.sandbox`：子进程文件效果限制缝（confine）
- `sandbox-local`（已挂载） — 本地沙箱后端：Linux 走 bwrap（`--ro-bind / /` + 只 bind workspaceRoot，/tmp 为 tmpfs）
- `sandbox-policy`（`ctx.sandboxPolicy`，已挂载） — `ctx.sandboxPolicy`：沙箱策略唯一所有者（resolve/overrideOf/defaultMode）；`resolve()` 以 `session.header.cwd` 为写入根
- `sandbox-windows-acl` — Windows ACL 沙箱后端（临时/工作区写权限句柄）
- `shell`（`ctx.shell`） — `ctx.shell`：shell 能力缝（run/start/resolve）
- `shell-env`（`ctx.shellEnv`，已挂载） — `ctx.shellEnv`：shell 环境变量注册表（register/collect/list）
- `subprocess`（`ctx.subprocess`） — `ctx.subprocess`：子进程能力缝（spawn/spawnTerminal）
- `subprocess-local`（已挂载） — 子进程缝的本机实现（本机进程 + 沙箱包装）

### LLM 与模型（6，已挂载 6）

- `deepseek-llm-api-extensions`（`ctx.deepseekLlmApiExtensions`，已挂载） — DeepSeek LLM API 的扩展面（请求/响应附加能力）
- `llm`（`ctx.llm`，已挂载） — `ctx.llm`：模型运行时（registerAdapter/stream/listProviders/discoverModels/resolveModelInfo/prepareCall）
- `llm-deepseek`（已挂载） — DeepSeek 官方 provider
- `llm-pi-ai`（已挂载） — pi-ai provider（兼容多家 OpenAI 式路由；fff 的 ustc 路由走它）
- `llm-retry`（已挂载） — 模型调用失败重试（一般退避）
- `repeat-tool-reminder`（`ctx.llm`，已挂载） — 同工具重复调用提醒（防打转）

### 技能 / 命令 / Web / 集成（21，已挂载 10）

- `command-compact`（已挂载） — slash 命令：手动触发压缩
- `command-feedback`（`ctx.sessionFeedback`，已挂载） — slash 命令：消息反馈（评分/备注），服务 `ctx.sessionFeedback`
- `command-goal`（已挂载） — slash 命令：目标的创建/查看/控制
- `commands`（`ctx.commands`，已挂载） — `ctx.commands`：slash 命令注册与执行（register/list/find/execute）
- `hooks-claude-code` — Claude Code hooks 兼容桥（外部钩子协议接入）
- `hooks-codex` — Codex hooks 兼容桥
- `mcp-client` — MCP 客户端桥（以 MCP 方式接入外部工具）
- `persona` — 人格/角色提示资产
- `schedule` — 调度能力：after / at / rate 触发（写作 `schedule/change` 事件）
- `skill`（`ctx.skills`，已挂载） — `ctx.skills`：技能注册表（registerProvider/register/list/get/snapshot）
- `skill-badge`（已挂载） — 技能徽标/来源标注（呈现层）
- `skill-filesystem`（已挂载） — 从文件系统加载技能（SKILL.md）
- `time-context` — 向上下文注入当前时间（模型面的时间意识）
- `timeout` — 超时工具/策略组件
- `web`（`ctx.web`，已挂载） — `ctx.web`：搜索/抓取 provider 注册表与执行（registerSearchProvider/registerFetchProvider/search/fetch）
- `web-app` — Web 应用入口（浏览器端 app 组合）
- `web-fetch-http`（已挂载） — HTTP 抓取 provider
- `web-frontend` — Web 前端静态资源/构建入口
- `web-search-deepseek`（已挂载） — DeepSeek 搜索 provider
- `webhook`（`ctx.webhookRuntime`） — `ctx.webhookRuntime`：webhook 运行时（外部事件入口）
- `webhook-github` — GitHub webhook 适配

### 权限 / 安全 / 设置（9，已挂载 5）

- `anonymous-user-id` — 匿名用户 id 生成（遥测/统计用匿名标识）
- `authorization`（`ctx.authorization`） — `ctx.authorization`：授权流程注册与执行（registerFlow/begin/describe/cancel）
- `credentials`（`ctx.credentials`） — `ctx.credentials`：凭据 provider 缝（resolve/describe/set/unset/listRecords）
- `credentials-local`（已挂载） — 凭据的本机实现（设置文件/环境变量）
- `permission-presets`（`ctx.permissionPresets`，已挂载） — `ctx.permissionPresets`：权限预设（read-only / workspace-write / danger-full-access；resolve/current/set）
- `settings`（`ctx.settings`） — `ctx.settings`：设置读写缝（get/update/replace/mutate/register/describe）
- `settings-file`（已挂载） — 设置的 YAML 文件后端（`~/.dsh/settings.yaml`）
- `user-approval`（`ctx.approval`，已挂载） — `ctx.approval`：审批服务（request/setPolicy/overrideOf）——沙箱升级必经此门
- `user-questions`（`ctx.userQuestions`，已挂载） — `ctx.userQuestions`：向用户提问（ask）；TUI/客户端渲染选项

### API 控制面（6，已挂载 1）

- `api-gateway`（`ctx.typertGateway`，已挂载） — `ctx.typertGateway`：remote/typert 网关（客户端↔宿主能力调用）
- `api-remotes` — 远端能力（remote export）注册与调用
- `api-session-controller`（`ctx.sessionFileReferences/sessionSkillCatalog/sessionController`） — 会话控制器：客户端侧会话操作（`ctx.sessionController`、技能目录、文件引用）
- `api-settings-controller`（`ctx.credentialsController/settingsController`） — 设置控制器：客户端侧设置与凭据管理
- `api-workspace-controller`（`ctx.directoryPickerController/workspaceController`） — 工作区控制器：工作区列表/切换与目录选择（`ctx.workspaceController`、`ctx.directoryPickerController`）
- `api-workspace-files`（`ctx.workspaceFiles`） — `ctx.workspaceFiles`：客户端侧工作区文件读取与变更（read/list/stat/changes）

### 客户端 UI（web / 桌面）（47，已挂载 0）

- `client-connection`（`ctx.connection`） — 客户端连接管理（`ctx.connection`：传输/会话订阅）
- `client-file-upload`（`ctx.fileUploads`） — 客户端文件上传（`ctx.fileUploads`）
- `client-hmr` — 客户端 HMR（前端热更新）
- `client-locale` — 客户端语言/本地化
- `client-modules`（`ctx.clientModules`） — `ctx.clientModules`：客户端侧模块加载（浏览器端插件）
- `client-resources` — 客户端静态资源服务
- `client-ui-agent-preset` — Web UI 面板：agent 预设选择
- `client-ui-approval` — Web UI 面板：审批请求
- `client-ui-attachment` — Web UI 面板：附件
- `client-ui-brand-official` — Web UI：官方品牌资源
- `client-ui-chat` — Web UI：聊天主视图
- `client-ui-commands` — Web UI：slash 命令
- `client-ui-conversation` — Web UI：对话渲染
- `client-ui-cordis` — Web UI：cordis 自省面板
- `client-ui-deliverables` — Web UI：交付物呈现
- `client-ui-directory-picker-browse` — Web UI：目录选择（浏览式）
- `client-ui-directory-picker-native` — Web UI：目录选择（原生对话框）
- `client-ui-goal` — Web UI：目标面板
- `client-ui-input-trigger` — Web UI：输入触发（@ / / 提及）
- `client-ui-jobs` — Web UI：后台作业面板
- `client-ui-layout` — Web UI：布局
- `client-ui-message-feedback` — Web UI：消息反馈
- `client-ui-model-selection` — Web UI：模型选择
- `client-ui-open-in-app` — Web UI：在外部应用打开
- `client-ui-permission-presets` — Web UI：权限预设切换
- `client-ui-plan` — Web UI：plan 模式面板
- `client-ui-reference` — Web UI：引用（文件/会话引用）
- `client-ui-renderer` — Web UI：渲染器
- `client-ui-schedule` — Web UI：调度
- `client-ui-session` — Web UI：会话视图
- `client-ui-settings` — Web UI：设置
- `client-ui-settings-general` — Web UI：通用设置页
- `client-ui-settings-models` — Web UI：模型设置页
- `client-ui-settings-plugin-inventory` — Web UI：插件清单设置页
- `client-ui-settings-plugins` — Web UI：插件管理设置页
- `client-ui-sidebar` — Web UI：侧栏
- `client-ui-sidebar-documentpreview` — Web UI：侧栏文档预览
- `client-ui-sidebar-files` — Web UI：侧栏文件树
- `client-ui-sidebar-right` — Web UI：右侧栏
- `client-ui-skill` — Web UI：技能
- `client-ui-subagent` — Web UI：子代理视图
- `client-ui-theme` — Web UI：主题
- `client-ui-tool` — Web UI：工具调用呈现
- `client-ui-trajectory` — Web UI：轨迹（trajectory）视图
- `client-ui-user-questions` — Web UI：用户提问面板
- `client-ui-workflow-run` — Web UI：workflow 运行面板
- `client-ui-workspace` — Web UI：工作区视图

### 插件 / 启动 / 基础设施（50，已挂载 6）

- `acp` — ACP（Agent Client Protocol）实现：`NewSessionRequest.cwd` 必填且须绝对路径，用于建会话/一致性校验（进程外对接面）
- `acp-app` — 以 ACP 方式暴露本宿主（供外部编辑器/客户端接入）
- `app-boot` — profile 组合与启动：解析 `dsh.bundle.patch` → `cordis.patch.yml`，逐层 patch 后启动
- `atomic-write` — 原子写文件工具（临时文件 + rename）
- `base` — `@deepseek-ai/dsh-base` bundle：base-backed profile 的第一层 patch（fff 唯一的官方 bundle）
- `brand` — 品牌/版本标识
- `cmdline` — 命令行解析组件
- `cordis` — vendored `@deepseek-ai/cordis`：Context / Service / Fiber / inject 容器本体
- `cordis-client-runner` — 客户端侧 cordis 运行器（`ctx.timer` 等客户端服务）
- `cordis-host-runner`（`ctx.cordisInspect/dynamicCordisRunner`） — 宿主侧 cordis 运行器：动态加载与自省（`ctx.dynamicCordisRunner`、`ctx.cordisInspect`）
- `cordis-plugin-group` — cordis 分组插件
- `cordis-plugin-hmr`（`ctx.hmr`，已挂载） — cordis 热重载插件（base 里默认 disabled）
- `cordis-plugin-include` — cordis include 插件（引入外部配置）
- `cordis-plugin-loader` — cordis 加载器（按配置装配插件树）
- `cordis-plugin-timer`（`ctx.timer`，已挂载） — cordis 定时器插件（服务 `ctx.timer`）
- `cosmokit` — cosmokit 工具库（cordis 依赖）
- `deque` — 双端队列工具库（cordis 依赖）
- `headless` — headless 应用入口：一次性任务执行（`dsh --profile headless "任务"`）
- `home-paths` — DSH_HOME 路径解析（dshHomePath 等）
- `host-directory-picker`（`ctx.directoryPicker`） — `ctx.directoryPicker`：目录选择宿主能力缝
- `host-directory-picker-auto` — 目录选择：自动后端选择
- `host-directory-picker-browse` — 目录选择：浏览式后端
- `host-directory-picker-native` — 目录选择：原生对话框后端
- `host-frontend-static` — 宿主内置前端静态资源服务
- `host-open-in-app` — 在外部应用打开路径
- `host-plugin-inventory`（`ctx.pluginInventory`） — `ctx.pluginInventory`：已装插件清单查询
- `host-webserver`（`ctx.webServer`） — `ctx.webServer`：宿主内嵌 web 服务器
- `http-proxy` — HTTP 代理支持（环境代理/自建代理）
- `launch-environment` — 启动环境快照（宿主启动参数与环境）
- `native-command` — 原生命令执行组件
- `node-addon-system` — Node 原生插件(native addon)系统入口
- `node-addon-system-linux-x64` — Node 原生插件的 linux-x64 预编译产物
- `package-manifest` — 包清单解析（package.json 元数据）
- `plugin-package-inventory-deepseek`（已挂载） — DeepSeek 官方插件包清单数据（供插件面板展示/安装）
- `schemastery` — 配置 schema 校验库（cordis 生态）
- `scope` — 作用域工具（ScopeKey 等）
- `sdk-app` — SDK 应用入口（外部程序内嵌宿主）
- `sdk-jsonrpc-server` — SDK 的 JSON-RPC over stdio 服务端（进程外对接面）
- `sdk-minimal` — 最小 SDK 宿主（裁剪版内嵌）
- `sdk-protocol` — SDK 协议定义（请求/事件词汇）
- `system-prompt`（`ctx.systemPrompt`，已挂载） — `ctx.systemPrompt`：系统提示与运行时上下文贡献面（section/context/variable/tools/assemble）
- `typert-loader`（已挂载） — typert 远程能力加载器
- `typert-protocol` — typert 远程协议（客户端↔宿主）
- `typert-registry`（`ctx.typert`，已挂载） — `ctx.typert`：远程能力注册表（register/get/resolve/list/getPackage）
- `util-crypto` — 加密工具（哈希/随机）
- `util-time` — 时间工具（格式化/时区）
- `util-values` — 通用值处理工具
- `util-workspace-path` — 工作区路径工具（规范化/相对化）
- `win32-process` — Windows 进程管理组件
- `workspace`（`ctx.workspaceRegistry`） — `ctx.workspaceRegistry`：工作区注册表与归档（create/list/archive/resolveByPath）

### 终端（2，已挂载 0）

- `terminal`（`ctx.terminals`） — `ctx.terminals`：终端会话服务（spawn/read/startSend/signal/kill/registerBackend）
- `terminal-bash` — 终端后端：把 bash 作为持久终端会话运行（对比一次性 tool-bash）

### 其他（5，已挂载 0）

- `file-reference`（`ctx.fileReferences`） — `ctx.fileReferences`：文件引用解析（@文件提及）
- `file-reference-local` — 文件引用解析的本机实现
- `hook-protocol` — 钩子协议定义（外部钩子接入契约）
- `output-retention` — 输出保留策略（长输出保留/裁剪）
- `tmux-context`（`ctx.llm`） — tmux 上下文注入（在 tmux 中运行时补充环境事实）

## 3. 服务索引（`ctx.<服务名>` → 归属包）

| 服务 | 归属包 |
|------|--------|
| `ctx.agentDefaultModel` | `agent-default-model` |
| `ctx.agentLoop` | `agent-loop` |
| `ctx.agentPresets` | `agent-presets` |
| `ctx.agents` | `agent` |
| `ctx.approval` | `user-approval` |
| `ctx.attachments` | `attachment` |
| `ctx.authorization` | `authorization` |
| `ctx.clientModules` | `client-modules` |
| `ctx.codeRuntime` | `code-runtime` |
| `ctx.commands` | `commands` |
| `ctx.compaction` | `compaction` |
| `ctx.connection` | `client-connection` |
| `ctx.cordisInspect` | `cordis-host-runner` |
| `ctx.credentials` | `credentials` |
| `ctx.credentialsController` | `api-settings-controller` |
| `ctx.deepseekLlmApiExtensions` | `deepseek-llm-api-extensions` |
| `ctx.directoryPicker` | `host-directory-picker` |
| `ctx.directoryPickerController` | `api-workspace-controller` |
| `ctx.dynamicCordisRunner` | `cordis-host-runner` |
| `ctx.fileReferences` | `file-reference` |
| `ctx.fileUploads` | `client-file-upload` |
| `ctx.fs` | `fs` |
| `ctx.goals` | `goal` |
| `ctx.hmr` | `cordis-plugin-hmr` |
| `ctx.invariants` | `invariants` |
| `ctx.jobs` | `jobs` |
| `ctx.llm` | `llm` `repeat-tool-reminder` `tmux-context` |
| `ctx.messageFeedback` | `message-feedback` |
| `ctx.permissionPresets` | `permission-presets` |
| `ctx.planMode` | `plan-mode` |
| `ctx.pluginInventory` | `host-plugin-inventory` |
| `ctx.sandbox` | `sandbox` |
| `ctx.sandboxPolicy` | `sandbox-policy` |
| `ctx.sessionController` | `api-session-controller` |
| `ctx.sessionFeedback` | `command-feedback` |
| `ctx.sessionFileReferences` | `api-session-controller` |
| `ctx.sessionPersistence` | `session-persistence` |
| `ctx.sessionProjectionCache` | `session-projection-cache` |
| `ctx.sessionProjections` | `session-projection` |
| `ctx.sessionQuery` | `session-query` |
| `ctx.sessionReferenceResolver` | `session-reference` |
| `ctx.sessions` | `session` |
| `ctx.sessionSkillCatalog` | `api-session-controller` |
| `ctx.sessionTelemetry` | `session-telemetry` |
| `ctx.sessionTitle` | `session-title` |
| `ctx.settings` | `settings` |
| `ctx.settingsController` | `api-settings-controller` |
| `ctx.shell` | `shell` |
| `ctx.shellEnv` | `shell-env` |
| `ctx.skills` | `skill` |
| `ctx.spillStore` | `spill` |
| `ctx.storage` | `storage` |
| `ctx.subagents` | `subagent` |
| `ctx.subprocess` | `subprocess` |
| `ctx.systemPrompt` | `system-prompt` |
| `ctx.terminals` | `terminal` |
| `ctx.timer` | `cordis-plugin-timer` |
| `ctx.tokenMeter` | `token-meter` |
| `ctx.toolResultPruner` | `compaction-tool-result-pruner` |
| `ctx.tools` | `tools` |
| `ctx.typert` | `typert-registry` |
| `ctx.typertGateway` | `api-gateway` |
| `ctx.userQuestions` | `user-questions` |
| `ctx.web` | `web` |
| `ctx.webhookRuntime` | `webhook` |
| `ctx.webServer` | `host-webserver` |
| `ctx.workflowEngine` | `workflow` |
| `ctx.workspaceController` | `api-workspace-controller` |
| `ctx.workspaceFiles` | `api-workspace-files` |
| `ctx.workspaceRegistry` | `workspace` |

## 4. 0.1.5-rc.3 里没有的（与我们的待办相关）

- **没有 git worktree 集成包**：全量 240 个包中不存在按 agent 隔离工作目录的实现（对应待办 #15）。
- **没有跨会话消息包**：不存在 broker / intercom / socket / IPC 类的 agent 间通道；进程内只有 `ctx.subagents.sendMessage`（相邻 agent），跨会话只有只读的 `session-query` / `session-reference`（对应待办 #30）。
- **没有跨进程 subagent provider**：`subagent` 家族在本版本只有 `spawn` / `fork` 两个进程内 provider（`subagent-acp` / `subagent-dsh-sdk` / `subagent-claude-code` / `subagent-codex` 只存在于源码仓库，不在随包分发里）。

## 5. 对本项目的落点

- **本项目 12 个插件不在这 240 个里**：`@dsh-toolset/*` 以 `link:` 依赖 + bundle 行挂进 profile（`package.json` 的 `dsh.profile.bundles` + 各自的 `cordis.patch.yml`），与官方包「已装但未挂载」的形态不同。
- **我们 inject 的服务**：`tools`（全部工具注册）、`systemPrompt`（提示/上下文贡献）、`sessionProjections`（context-report 的 `sessionContext` 投影）、`sessions`、`tokenMeter`、`agents`、`fs`、`shell`、`subagents`、`userQuestions`（herdr-integration 桥接 blocked）、`approval`。接口怎么用见 `DSH-CTX-API.md`。
- **启用未挂载的官方包不需要安装**：包已随 dsh 装在共享 `node_modules`，在 profile 的 `cordis.patch.yml` 加一行（或 `dsh plugin --profile <p> add <包名>`）即可。
- **升级注意**：fff 的官方包全部是指向全局 dsh 安装的软链，升级 CLI 后 profile 无需动作即换版本；因此本清单与 `DSH-CTX-API.md` 需随升级复核。
- **升级方式**：`npm i -g @deepseek-ai/dsh@<显式版本>`（rc.3 用 `@0.1.5-rc.3` 或 `@next`），**不要用 `npm update -g`**——npm 的 `latest` 停在 `0.1.5-rc.2`，而 rc.2 的 vendor 依赖是 caret 范围（`cordis ^4.0.2` 等），`npm update -g` 会把它们浮动到未配套的 vendor 版本（实测会装出 cordis 4.0.4 与 loader/timer/schemastery 各两份的混合树）；rc.3 起 vendor 家族为精确钉版，不再浮动。

## 6. 复现命令（宿主升级后重新生成）

```sh
D=~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
# 包列表 + 描述 + 版本
for d in "$D"/*/; do node -p "const j=require('$d/package.json'); [j.name, j.version, (j.description||"").replace(/\s+/g," ")].join("\t")"; done
# 服务名（每包里 super(ctx, "name") 的注册名）
grep -rhoE 'super\(ctx, "[a-zA-Z]+"' "$D"/*/lib/index.js | sed 's/super(ctx, "//;s/"//' | sort -u
# fff 挂载的包（解析 bundle patch 的 name 行）
{ grep -rhoE "name: '@deepseek-ai/[^']+'" ~/.dsh/profiles/fff/cordis.patch.yml "$D/dsh-base/cordis.patch.yml"; } | sed "s/name: '//;s/'$//" | sort -u
```

核对口径：

- **服务名只取包的主入口 `lib/index.js`**：客户端面（`lib/client.js`，如 `slots`、`uiSession`）与未挂载的子路径入口（如 `tool-subagent/model-selection-settings` 的 `subagentModelSelection`）注册的服务不算该包的 host 服务。
- **挂载清单要去子路径条目**：patch 里会出现同一包的第二入口（如 `@deepseek-ai/dsh-tool-subagent-control/list-agents`），按包名前缀归并后才是 82 个。
- `dsh --profile fff --dump-config` 在只读 profile 目录下会因写 `cordis.yml` 失败（EROFS）；改用上面的解析方式核对，或在可写环境下用它交叉验证（实测同为 82 个官方包）。
