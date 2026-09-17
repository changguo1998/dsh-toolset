# TUI 命令清单与扩展建议

> 依据：2026-09-18 横向对比 **Claude Code（108 条）/ Codex CLI（55）/ Gemini CLI（38）/ pi（23 内置）** 与本项目现状（本地 17 条含别名 + 宿主注册 6 条）。
> 用途：记录命令面现状与「值得添加的命令」建议，供排期参考；功能级待办以 `docs/DEVELOPMENT-BACKLOG.md` 为准，命令实现细节见 `DESIGN.md` / `IMPLEMENTATION.md`。

## 1. 现状

### 1.1 本地命令（app 层直接处理，不经 adapter）

| 命令 | 用途 |
|------|------|
| `/help` | 本地帮助（命令与快捷键） |
| `/clearscreen`（`/cls`） | 清空显示缓冲（只清 UI，不动会话上下文） |
| `/quit` | 关闭 renderer 退出 |
| `/theme` | 主题切换 dark/light |
| `/session` | 历史会话面板（浏览/恢复/删除/清理，范围跟随列表） |
| `/copy` | 复制最后一条模型回复（OSC52） |
| `/goal` | goal/todo 提示（详情常驻右侧状态列） |
| `/policy` | 审批策略 ask/never |
| `/permission` | 权限预设（sandbox mode + 审批策略捆绑） |
| `/preset` | agent 预设目录 |
| `/jobs` | 后台任务面板（Enter 取消） |
| `/init` | 初始化 `AGENTS.md`（缺失时由模型阅读目录生成） |
| `/model` | 模型选择面板（provider/model/effort 三列） |
| `/provider` | 同面板，焦点预置 provider 列 |
| `/effort`（`/thinking`） | 同面板，焦点预置 effort 列 |

### 1.2 宿主注册命令（`ctx.commands.register`，转发即用）

`/compact`、`/feedback`、`/record`、`/goal`、`/plan`、`/export`。

补全候选由 `ctx.commands.list(agent)` 自动拉取，本地表与宿主表合并展示。

## 2. 扩展建议

> 归口口径：命令只用两类来源实现——① **dsh 官方 API/插件**（当前 profile 已挂载的服务）；② **本项目插件**（dsh-toolset）。不引入第三方插件；需额外装配官方可选 bundle（当前未挂载）的项不在本轮范围。

### 2.1 用 dsh 官方 API（服务已挂载；写命令插件即可，TUI 零改动）

| 命令 | 宿主服务 · 方法 | 出现于 | 优先级 |
|------|----------------|--------|--------|
| `/stats`（别名 `/usage` `/cost` `/context`） | `tokenMeter.measure` / `estimateMessage` + `sessionQuery.listSessions` / `readSurface` | Claude、Codex、Gemini、pi（4/4） | P1 |
| `/skills` | `skills.list` / `snapshot` / `registerProvider` | Claude、Codex、Gemini | P1 |
| `/agents` | `subagents.list` / `interrupt` / `sendMessage` | Claude、Codex、Gemini | P1 |
| `/tools` | `tools.entries` / `schemas` / `get` | Gemini | P2 |
| `/rename` | `sessionTitle.rename` | Claude、Codex、pi | P2 |
| `/settings`（`/config`） | `settings.open` / `mutate` / `describe` / `documentPath` | Claude、Gemini、pi | P2 |
| `/clear` | `sessions.clear`（同服务另有 `create` / `delete`） | Claude、Codex、Gemini | P2 |
| `/fork` | `sessions.fork` | Claude、Codex、pi | P2 |
| `/login` `/logout` | `credentials.describe` / `set` / `unset` / `resolve` | Claude、Codex、pi | P2 |
| `/review`（`/code-review`） | `workflowEngine.start` | Claude、Codex | P2 |

- 实现模板：`dsh-command-goal`（185 行 JS，`ctx.commands.register` + `inject`）；建议合为**一个** `dsh-command-toolset` 包注册多条命令，而非每命令一个包。
- **已可用、无需实现**：`/plan`（`dsh-plan-mode` 注册）、`/export`（`dsh-session-log-export` 注册）。
- 注：`sessions.clear` 的语义（清上下文 or 清会话）实现时需确认；`/clear` 与现有 `/clearscreen`（仅清显示）语义区分。

### 2.2 用本项目插件（需先暴露服务，再写命令）

现状：本项目 10 个插件**均只注册模型工具或 hook，未把服务挂到宿主 ctx** —— 任何命令入口都要先补「服务暴露」这一步。

| 命令 | 本项目插件 · 可支撑能力 | 需补的暴露 | 优先级 |
|------|----------------------|-----------|--------|
| `/memory` | knowledge-base：`search` / `put` / `touch` / `evict` + Memory CRUD（已实现） | `apply` 现为 `void createKnowledgeBundle(...)`（服务对象建完即丢），需把 `kb` / `memory` 挂到 ctx | P1 |
| `/loop` | metric-loop：循环引擎（start / tick / status / plateau / 边界） | 现只注册 `metric_loop` 工具，controller 未挂 ctx | P1 |
| `/task` | task-engine：任务树（decompose / implement / stop / status） | 现只注册工具，需暴露任务树状态面 | P2 |
| `/contract` | goal-contract：Done-when 契约起草 | 现只注册工具 | P2 |
| `/guard` | security-guard：危险命令黑名单 + 敏感文件保护 | 现仅 `createSecurityGuard(ctx)`，需暴露策略/拦截审计面 | P2 |
| `/herdr` | herdr-integration：面板状态/blocked 桥 | 现为 socket 上报，需暴露连接与状态 | P2 |

- 工具性质、命令入口价值低（模型直接用即可）：fs-digest、hash-edit、ast-tools、output-compress。
- TUI 包内实现（非插件）：`/diff`（跑 git 出变更面板）、`/doctor`（自检 TUI / 宿主 / 插件装配）。

### 2.3 已剔除（按当前口径不考虑）

- **需额外装配官方可选 bundle**（当前 profile 未挂载）：`/mcp`（`dsh-mcp-client`）、`/hooks`（`dsh-hooks-claude-code` / `dsh-hooks-codex`）。
- **第三方 / 其他 agent 生态命令**：见 §2.4。

### 2.4 不建议（记录理由，避免重复调研）

- **平台/服务专属，不迁移**：`/stickers` `/radio` `/pets` `/pet` `/passes` `/upgrade` `/mobile` `/chrome` `/desktop` `/teleport` `/remote-control` `/share` `/schedule` `/artifacts` `/design*` `/dataviz` `/deep-research` `/insights` `/recap` `/voice` `/web-setup` `/install-*` `/privacy` `/about` `/powerup` `/team-onboarding` `/run` `/verify` `/batch` `/autofix-pr` `/ultrareview` `/security-review` `/focus` `/color` `/scroll-speed` `/tui` `/plugin` `/plugins` `/extensions` `/apps` `/ide` `/editor` `/docs` `/shells` `/ps` `/archive` `/delete` `/experimental` `/debug` `/debug-config` `/heapdump` `/raw` `/mention` `/pr-comments` `/changelog` `/statusline` `/keybindings` `/keymap`
- **上游已移除**：`/vim`（Claude Code 改由 `/config`）、`/ultraplan`
- **本项目已有等效**：`/compact` `/feedback` `/record` `/goal` `/policy` `/permission` `/preset` `/jobs` `/theme` `/model` `/effort` `/session` `/copy` `/init` `/help` `/quit` `/clearscreen`
- **无底座且收益低**：`/rewind` `/restore`（`dsh-session-checkpoint-policy` 是持久化检查点，非回退）、`/add-dir` `/directory`（会话 cwd 由宿主决定）、`/fast` `/personality`（dsh-persona 未挂载）、`/btw` `/side`（侧聊依赖 0.1.6 的 sidebar 能力，rc.2 无）
