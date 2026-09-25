# TUI 命令清单与扩展建议

> 职责：命令清单（按本地 / 宿主注册层归属）与扩展裁定索引
> 不负责：命令行为说明（见 `TUI/README.md`）、新命令的硬规格（见 `TUI/docs/COMMANDS-SPEC.md`）
> 过期条件：无

> 用途：记录命令面现状（本地命令 + 宿主注册命令）与「值得添加的命令」建议。
> 命令用法与键位见 `README.md`「Slash 命令」，逐命令实现落点见 `IMPLEMENTATION.md`「命令实现落点」，扩展规格（落点、服务降级、面板契约）见 `COMMANDS-SPEC.md`。

## 1. 现状

### 1.1 本地命令（app 层直接处理，不经 adapter）

单一来源为 `src/app/commands.ts` 的 `LOCAL_COMMANDS`（38 条 = 33 命令 + 5 别名 `/cls` `/thinking` `/usage` `/context` `/exit`）；路由决策 `routeSlashCommand`，处理分支在 `src/app/index.ts` `handleSlash`。

命令的**行为、参数与键位**见 `TUI/README.md`「Slash 命令」一节；逐命令的**落点与降级**见 `TUI/docs/IMPLEMENTATION.md`。本节不重复这两者，只维护上面的「单一来源 + 路由」事实与 §1.2 的宿主注册面。

### 1.2 宿主注册命令

`ctx.commands.register` 现注册 6 条（dsh 0.1.5-rc.3 安装树核实）：`/compact` `/feedback` `/goal` `/permission` `/plan` 由 dsh-base 装配的插件注册（dsh-command-compact / dsh-command-feedback / dsh-command-goal / dsh-permission-presets / dsh-plan-mode），`/export` 来自 dsh-session-log-export。本地目录未命中的命令名一律经 `adapter.runCommand` 转发注册表；注册表未命中提示未知命令（fail-close，绝不把 slash 行发给模型）。

- 补全候选 = 本地目录 + `ctx.commands.list(agent)`（`start()` 时拉取一次，无周期刷新）；同名本地优先。
- `/goal` `/permission` 与本地同名：`/permission` 无参走本地面板、带参转发宿主；`/goal` 无参为本地提示、带参转发宿主（`/goal <目标>` 即新建当前会话 goal）。

## 2. 扩展建议

> 归口：命令只有两类来源——① dsh 官方 API/插件（当前 profile 已挂载的服务）；② 本项目插件（dsh-toolset）。不引入第三方插件；需额外装配官方可选 bundle（当前未挂载）的项不在范围。

**机制前提**：dsh 的「服务」与「slash 命令」是两套独立注册面——服务（cordis Service）只提供编程 API（`ctx.<svc>`），不会自动变成命令；命令须显式 `ctx.commands.register`，官方当前仅 6 条（§1.2）。

**落点决策**：命令一律走 TUI 本地命令（`LOCAL_COMMANDS` + `index.ts` case），不新建宿主命令插件包——可复用面板骨架（ModelPicker / JobsPanel / HistoryPanel）与 FakeAdapter 测试基建，与既有 `/session` `/preset` `/permission` `/jobs` 同路径；代价是命令仅 TUI 可用。需要跨客户端可见时再考虑宿主命令插件路线（`dsh-command-toolset`）。

### 2.1 已实现（索引）

已实现命令的用法与键位见 `README.md`「Slash 命令」，逐命令落点与降级见 `IMPLEMENTATION.md`「命令实现落点」。落点统一：插件侧只提供只读查询面，命令仍在 TUI 侧实现（`ctx.get("<svc>")` → adapter → 本地命令）；`/contract` 例外——goal-contract 只读面优先、缺失时内置同构回读兜底。

- 工具性质、命令入口价值低（模型直接用即可）：fs-digest、hash-edit、ast-tools、output-compress、code-map。

### 2.2 未纳入

| 项 | 理由 |
|----|------|
（`/clear`、`/login` `/logout`、`/review` 三项的**排除裁定与理由**见 `TUI/docs/COMMANDS-SPEC.md` §7，此处不重复；下表只列「未纳入但未裁定排除」的项。）
| `/mcp` `/hooks` | 需额外装配官方可选 bundle（`dsh-mcp-client` / `dsh-hooks-claude-code` / `dsh-hooks-codex`），当前 profile 未挂载 |
| `/diff` `/doctor` | 无宿主服务依赖、可纯 TUI 实现（跑 git / 自检 TUI、宿主、插件装配），尚未排期 |
| 平台/服务专属命令 | 属其他 agent 生态特有（Claude Code / 官方云与 IDE 集成等，如 `/stickers` `/pets` `/voice` `/design*` `/heapdump` `/ide` 一类，数十条），不迁移 |
| 上游已移除 | `/vim` `/ultraplan` |
| 无底座且收益低 | `/rewind` `/restore`（`dsh-session-checkpoint-policy` 是持久化检查点，非回退）、`/add-dir` `/directory`（会话 cwd 由宿主决定）、`/fast` `/personality`（dsh-persona 未挂载）、`/btw` `/side` |
| 本项目已有等效 | `/compact` `/feedback` `/goal` `/policy` `/permission` `/preset` `/jobs` `/theme` `/model` `/effort` `/session` `/copy` `/init` `/help` `/quit` `/clearscreen` |

另不做：`/settings` 写回（真实配置 + 乐观锁，需独立契约）、正则/高级过滤（面板过滤为大小写不敏感子串）、面板增量事件订阅（面板数据为打开时拉取）。
