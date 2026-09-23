# TUI 命令清单与扩展建议

> 用途：记录命令面现状（本地命令 + 宿主注册命令）与「值得添加的命令」建议。
> 命令用法与键位见 `README.md`「Slash 命令」，逐命令实现落点见 `IMPLEMENTATION.md`「命令实现落点」，扩展规格（落点、服务降级、面板契约）见 `COMMANDS-SPEC.md`。

## 1. 现状

### 1.1 本地命令（app 层直接处理，不经 adapter）

单一来源为 `src/app/commands.ts` 的 `LOCAL_COMMANDS`（36 条 = 32 命令 + 4 别名 `/cls` `/thinking` `/usage` `/context`）；路由决策 `routeSlashCommand`，处理分支在 `src/app/index.ts` `handleSlash`。

| 命令 | 用途 |
|------|------|
| `/help` | 本地帮助（命令与快捷键） |
| `/clearscreen`（`/cls`） | 清空显示缓冲（只清 UI，不动会话上下文） |
| `/quit` | 关闭 renderer 退出 |
| `/theme [dark\|light\|toggle]` | 主题切换（仅当前会话，不落盘） |
| `/verbose on\|off` | 活动区详略两态：`on`（缺省）完整折行 / `off` 紧凑（每条目 1 行 + 行尾 `…`）；SPEC §6.8。生效值常驻状态列 Mode 块（`✓`=on / `✗`=off） |
| `/symbol-unify on\|off` | 模型输出符号统一：`on`（缺省）把变体符号替换为推荐符号并提醒模型 / `off` 原样（不替换不提醒）。生效值常驻状态列 Mode 块（`✓`=on / `✗`=off） |
| `/session` | 历史会话面板（浏览/恢复/删除/清理，范围 Tab 切换；`/session clean` 直达清理确认） |
| `/copy` | 复制最后一条模型回复（OSC52） |
| `/goal` | goal/todo 提示（详情常驻左侧状态列） |
| `/policy [ask\|never]` | 审批策略：无参开状态选项面板，带参直接设置 |
| `/permission [预设名]` | 权限预设（sandbox mode + 审批策略捆绑）：无参开面板，带参转发宿主命令 |
| `/preset [预设名]` | agent 预设目录：无参开面板，带参切换 |
| `/jobs` | 后台任务面板（↑/↓ 选择、PgUp/PgDn 翻页、Enter 取消、Esc 关闭） |
| `/init` | 初始化 `AGENTS.md`（缺失时由模型阅读目录生成；已存在则提示退出） |
| `/model [provider/]model` | 无参开模型选择面板（provider/model/effort 三列），带参直接切换 |
| `/provider` | 同面板，焦点预置 provider 列（带参只提示用法） |
| `/effort`（`/thinking`） | 同面板，焦点预置 effort 列 |
| `/stats`（`/usage` `/context`） | 最近一次模型调用的 token 用量与上下文占比 |
| `/rename <标题>` | 重命名当前会话标题（空标题/含换行本地拒绝） |
| `/skills [过滤]` | 技能目录面板（Enter 详情、PgUp/PgDn 翻页） |
| `/agents` | 子代理面板（Enter 直接中断选中项、`r` 手动刷新、打开期间每 2s 定时刷新） |
| `/tools [过滤]` | 工具目录面板（Enter 详情） |
| `/settings` | 只读展示配置（`ns：value`，secret 脱敏） |
| `/fork` | 分叉当前会话为新会话 |
| `/task` | 任务面板（task-engine 只读：标题/状态） |
| `/guard` | 守卫面板（security-guard：拦截/放行记录，Enter 看策略） |
| `/memory` | 知识库概要（knowledge-base：就绪/路径/chunk·source 计数） |
| `/loop` | 循环面板（metric-loop：活动/历史循环，Enter 详情） |
| `/contract` | 契约概览（goal-contract 面优先、内置同构回读兜底；notice 型） |
| `/workflows` | 工作流运行面板（tool-workflow：只读运行列表，面板打开期间定时刷新） |
| `/council [N]` | 二次意见（并行 N 个评审子代理对当前目标给独立意见；默认 2、上限 4） |
| `/search <query>` | 网页搜索（dsh-web 多 provider 聚合；列表展示，Enter 看来源） |

### 1.2 宿主注册命令

`ctx.commands.register` 现注册 6 条（dsh 0.1.5-rc.3 安装树核实）：`/compact` `/feedback` `/goal` `/permission` `/plan` 由 dsh-base 装配的插件注册（dsh-command-compact / dsh-command-feedback / dsh-command-goal / dsh-permission-presets / dsh-plan-mode），`/export` 来自 dsh-session-log-export。本地目录未命中的命令名一律经 `adapter.runCommand` 转发注册表；注册表未命中提示未知命令（fail-close，绝不把 slash 行发给模型）。

- 补全候选 = 本地目录 + `ctx.commands.list(agent)`（`start()` 时拉取一次，无周期刷新）；同名本地优先。
- `/goal` `/permission` 与本地同名：`/permission` 无参走本地面板、带参转发宿主；`/goal` 恒为本地提示（不转发）。

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
| `/clear` | 宿主无会话删除/清理 API（`dsh-session` 公开面无删除，`dsh-session-query` 仅查询）；会话清理诉求已由 `/session` 面板多选批量删除（`Space` 标记 + `d`）/ `x` 清理空会话 + `/session clean` 覆盖 |
| `/login` `/logout` | `ctx.credentials` 仅为凭据引用/记录 seam，无交互登录流程；`/logout` 亦无宿主「登出」概念 |
| `/review` | `workflowEngine.start` 为通用脚本引擎（需自备 `script` / `meta` / `parent: Agent`），包内无 review 资产 |
| `/mcp` `/hooks` | 需额外装配官方可选 bundle（`dsh-mcp-client` / `dsh-hooks-claude-code` / `dsh-hooks-codex`），当前 profile 未挂载 |
| `/diff` `/doctor` | 无宿主服务依赖、可纯 TUI 实现（跑 git / 自检 TUI、宿主、插件装配），尚未排期 |
| 平台/服务专属命令 | 属其他 agent 生态特有（Claude Code / 官方云与 IDE 集成等，如 `/stickers` `/pets` `/voice` `/design*` `/heapdump` `/ide` 一类，数十条），不迁移 |
| 上游已移除 | `/vim` `/ultraplan` |
| 无底座且收益低 | `/rewind` `/restore`（`dsh-session-checkpoint-policy` 是持久化检查点，非回退）、`/add-dir` `/directory`（会话 cwd 由宿主决定）、`/fast` `/personality`（dsh-persona 未挂载）、`/btw` `/side` |
| 本项目已有等效 | `/compact` `/feedback` `/goal` `/policy` `/permission` `/preset` `/jobs` `/theme` `/model` `/effort` `/session` `/copy` `/init` `/help` `/quit` `/clearscreen` |

另不做：`/settings` 写回（真实配置 + 乐观锁，需独立契约）、正则/高级过滤（面板过滤为大小写不敏感子串）、面板增量事件订阅（面板数据为打开时拉取）。
