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

### A 档：共识高 + 底座现成（建议优先）

| 命令 | 出现于 | 本项目底座 | 落点 | 优先级 |
|------|--------|-----------|------|--------|
| `/stats`（别名 `/usage` `/cost` `/context`） | Claude Code、Codex、Gemini、pi（4/4） | `ctx.tokenMeter`（token-meter）+ session-query-sqlite | TUI 本地命令 → notice 或信息面板：token 用量、成本、上下文占比 | P1 |
| `/memory` | Claude Code、Codex、Gemini | **knowledge-base 插件**（跨会话知识库 + 记忆 CRUD 工具已实现） | 缺命令入口：TUI 本地命令直连服务，或新建宿主命令插件（仿 dsh-command-goal） | P1 |
| `/skills` | Claude Code、Codex、Gemini | skill + skill-filesystem + tool-skill | TUI 面板（复用 ModelPicker 骨架） | P1 |
| `/agents` | Claude Code、Codex、Gemini | subagent + tool-subagent-control/list-agents | TUI 面板（复用 JobsPanel 骨架） | P1 |
| `/rename` | Claude Code、Codex、pi | session-title（+ first-prompt-llm 自动命名） | 输入行 → 写会话标题 | P2 |
| `/clear` | Claude Code、Codex、Gemini | 待确认 dsh 是否支持同会话清上下文 | TUI 本地命令；与 `/clearscreen`（仅清显示）语义区分 | P2 |

### B 档：有价值，成本中等

| 命令 | 出现于 | 底座 | 落点 | 优先级 |
|------|--------|------|------|--------|
| `/diff` | Claude Code、Codex | git（TUI StatusTicker 已查询 git 状态） | TUI 面板：工作区变更概览（`git diff --stat`） | P1 |
| `/loop` | Claude Code | **metric-loop 插件**（指标循环引擎已实现） | 宿主命令插件（仿 dsh-command-goal） | P1 |
| `/review`（`/code-review`） | Claude Code、Codex | workflow + subagent（本项目已有 code-review 工作流模板） | 宿主命令转发 workflow | P2 |
| `/settings`（`/config`） | Claude Code、Gemini、pi | settings-file + `tui.config.json` | TUI 面板：编辑布局/主题配置 | P2 |
| `/tools` | Gemini CLI | dsh-tools 注册表 | TUI 列表（只读） | P2 |
| `/mcp` | Claude Code、Codex、Gemini | 需先装配 `dsh-mcp-client`（当前 profile 未挂载） | 先加宿主 bundle，再做 TUI 面板 | P2 |
| `/hooks` | Claude Code、Codex、Gemini | 需先装配 `dsh-hooks-claude-code` / `dsh-hooks-codex` | 同上 | P2 |
| `/fork` | Claude Code、Codex、pi | session 服务（分叉能力待确认） | 宿主命令插件 | P2 |
| `/login` `/logout` | Claude Code、Codex、pi | credentials-local | provider 凭据管理入口 | P2 |
| `/doctor` | Claude Code | 自检：TUI / 宿主 / 插件装配状态 | TUI 本地命令 | P2 |

### C 档：不建议（记录理由，避免重复调研）

- **平台/服务专属，不迁移**：`/stickers` `/radio` `/pets` `/pet` `/passes` `/upgrade` `/mobile` `/chrome` `/desktop` `/teleport` `/remote-control` `/share` `/schedule` `/artifacts` `/design*` `/dataviz` `/deep-research` `/insights` `/recap` `/voice` `/web-setup` `/install-*` `/privacy` `/about` `/powerup` `/team-onboarding` `/run` `/verify` `/batch` `/autofix-pr` `/ultrareview` `/security-review` `/focus` `/color` `/scroll-speed` `/tui` `/plugin` `/plugins` `/extensions` `/apps` `/ide` `/editor` `/docs` `/shells` `/ps` `/archive` `/delete` `/experimental` `/debug` `/debug-config` `/heapdump` `/raw` `/mention` `/pr-comments` `/changelog` `/statusline` `/keybindings` `/keymap`
- **上游已移除**：`/vim`（Claude Code 改由 `/config`）、`/ultraplan`
- **本项目已有等效**：`/compact` `/feedback` `/record` `/goal` `/policy` `/permission` `/preset` `/jobs` `/theme` `/model` `/effort` `/session` `/copy` `/init` `/help` `/quit` `/clearscreen`
- **无底座且收益低**：`/rewind` `/restore`（`dsh-session-checkpoint-policy` 是持久化检查点，非回退）、`/add-dir` `/directory`（会话 cwd 由宿主决定）、`/fast` `/personality`（dsh-persona 未挂载）、`/btw` `/side`（侧聊依赖 0.1.6 的 sidebar 能力，rc.2 无）
