# TUI 命令清单与扩展建议

> 依据：2026-09-18 横向对比 **Claude Code（108 条）/ Codex CLI（55）/ Gemini CLI（38）/ pi（23 内置）** 与本项目现状（本地 35 条含别名 = 31 项 + 4 别名〔`/cls` `/thinking` `/usage` `/context`〕，宿主注册 7 条；2026-10 按 `LOCAL_COMMANDS` 实测刷新）。
> 用途：记录命令面现状与「值得添加的命令」建议，供排期参考；功能级待办以 `docs/DEVELOPMENT-BACKLOG.md` 为准，命令实现细节见 `DESIGN.md` / `IMPLEMENTATION.md`。

## 1. 现状

### 1.1 本地命令（app 层直接处理，不经 adapter）

| 命令 | 用途 |
|------|------|
| `/help` | 本地帮助（命令与快捷键） |
| `/clearscreen`（`/cls`） | 清空显示缓冲（只清 UI，不动会话上下文） |
| `/quit` | 关闭 renderer 退出 |
| `/theme` | 主题切换 dark/light |
| `/verbose` | 活动区详略两态：`on`（缺省）完整折行 / `off` 紧凑（每条目 1 行 + 行尾 `…`）；SPEC §6.8 |
| `/session` | 历史会话面板（浏览/恢复/删除/清理，范围跟随列表） |
| `/copy` | 复制最后一条模型回复（OSC52） |
| `/goal` | goal/todo 提示（详情常驻右侧状态列） |
| `/policy` | 审批策略 ask/never |
| `/permission` | 权限预设（sandbox mode + 审批策略捆绑） |
| `/preset` | agent 预设目录 |
| `/jobs` | 后台任务面板（↑/↓ 选择、PgUp/PgDn 翻页、Enter 取消、Esc 关闭） |
| `/init` | 初始化 `AGENTS.md`（缺失时由模型阅读目录生成） |
| `/model` | 模型选择面板（provider/model/effort 三列） |
| `/provider` | 同面板，焦点预置 provider 列 |
| `/effort`（`/thinking`） | 同面板，焦点预置 effort 列 |
| `/stats`（`/usage` `/context`） | 本回合 token 用量与上下文占比（最近一次模型调用） |
| `/rename` | 重命名当前会话标题 |
| `/skills` | 技能目录面板（Enter 详情、PgUp/PgDn 翻页） |
| `/agents` | 子代理面板（Enter 直接中断选中项、`r` 刷新） |
| `/tools` | 工具目录面板（Enter 详情） |
| `/settings` | 只读展示配置（`ns：value`，secret 脱敏） |
| `/fork` | 分叉当前会话为新会话 |
| `/task` | 任务面板（task-engine 只读：标题/状态） |
| `/guard` | 守卫面板（security-guard：拦截/放行记录，Enter 看策略） |
| `/memory` | 知识库概要（knowledge-base：就绪/路径/chunk·source 计数） |
| `/loop` | 循环面板（metric-loop：活动/历史循环，Enter 详情） |
| `/contract` | 契约概览（goal-contract：当前目标 + Done-when 条款，notice 型） |
| `/workflows` | 工作流运行面板（tool-workflow：只读运行列表） |
| `/council [N]` | 二次意见（并行 N 个评审子代理对当前目标给独立意见，notice 展示） |
| `/search <query>` | 网页搜索（dsh-web 多 provider 聚合；列表展示，Enter 看来源） |

### 1.2 宿主注册命令（`ctx.commands.register`，转发即用）

`/compact`、`/feedback`、`/record`、`/goal`、`/permission`、`/plan`、`/export`（7 条，grep 自 dsh 0.1.5-rc.2 装配包核实）。

补全候选由 `ctx.commands.list(agent)` 自动拉取，本地表与宿主表合并展示。

注：`/goal`、`/permission` 与 §1.1 同名——本地路由优先（面板/提示），带参形态转发宿主命令。

## 2. 扩展建议

> 归口口径：命令只用两类来源实现——① **dsh 官方 API/插件**（当前 profile 已挂载的服务）；② **本项目插件**（dsh-toolset）。不引入第三方插件；需额外装配官方可选 bundle（当前未挂载）的项不在本轮范围。

**机制前提（已核实）**：dsh 的「服务」与「slash 命令」是两套独立注册面——服务（cordis Service，当前装配树约 95 个）只提供编程 API（`ctx.<svc>`），**不会自动变成命令**；命令必须显式 `ctx.commands.register({ name, description, input, handler })`，官方当前仅注册 7 条（§1.2）。TUI 只在 `start()` 时拉一次 `ctx.commands.list(agent)` 合并进补全候选，无周期性刷新。

**落点决策**：本轮命令**一律走 TUI 本地命令**（`LOCAL_COMMANDS` + `index.ts` case），不新建宿主命令插件包。理由：可复用面板骨架（ModelPicker / JobsPanel / HistoryPanel）、与既有 `/session` `/preset` `/permission` `/jobs` 同路径、FakeAdapter 测试基建成熟；代价是命令仅在 TUI 可用（其它客户端不可见）。宿主命令插件路线（`dsh-command-toolset`）仅在需要跨客户端时启用。

> 可实现级规格见 `COMMANDS-SPEC.md`——**本轮只覆盖纯 TUI 侧**（宿主服务现成、不需改动任何插件）：候选 `/stats` `/skills` `/agents` `/tools` `/rename` `/settings` `/fork`（**7 项，已全部通过批次 0 API 合同门**）；需插件改造与宿主能力缺口／语义不匹配者在 `COMMANDS-SPEC.md` §3 索引。实施清单见 `COMMANDS-TASKS.md`（批次 0 API 合同门 + 四批实现）。

### 2.1 用 dsh 官方 API（服务已挂载，落点：TUI 本地命令）

| 命令 | 宿主服务 · 方法 | 出现于 | 优先级 |
|------|----------------|--------|--------|
| `/stats`（别名 `/usage` `/context`） | `state.usage`（已接，零新服务）；可选增强 `tokenMeter.measure(session, requestHeader)` | Claude、Codex、Gemini、pi（4/4） | P1 ✅ 本轮已实现（批次 1） |
| `/skills` | `skills.list()` → `SkillSummary[]` / `get(name)` → `SkillDefinition` | Claude、Codex、Gemini | P1 ✅ 本轮已实现（批次 2） |
| `/agents` | `subagents.listChildren(parentSessionId)` / `interrupt(childId, { kind: 'user', parentSessionId })` | Claude、Codex、Gemini | P1 ✅ 本轮已实现（批次 3；C2 定时+`r` 手动刷新） |
| `/tools` | `tools.schemas()`（scope 省略 = 全局视图） / `get(name)` | Gemini | P2 ✅ 本轮已实现（批次 3） |
| `/rename` | `sessionTitle.rename(session, title)`（首参为 live Session 对象） | Claude、Codex、pi | P2 ✅ 本轮已实现（批次 1） |
| `/settings`（`/config`） | `settings.describe()`（枚举 ns + 当前值） / `get(ns)`（第一版只读） | Claude、Gemini、pi | P2 ✅ 本轮已实现（批次 4，只读） |
| `/clear` | ~~`sessions.clear`~~ **暂缓（宿主无对应能力）**：`dsh-session` 类型面无 clear（SPEC §3 索引） | Claude、Codex、Gemini | 暂缓 |
| `/fork` | `sessions.fork(source, boundary?, childSessionId?)`（后两参可省；返回 live Session） | Claude、Codex、pi | P2 ✅ 本轮已实现（批次 4） |
| `/login` `/logout` | ~~`credentials.*`~~ **暂缓（语义不匹配）**：`ctx.credentials` 仅为凭据引用 seam（`resolve`/`describe`/`set`/`unset`），无交互登录流程 API（SPEC §3 索引） | Claude、Codex、pi | 暂缓 |
| `/review`（`/code-review`） | ~~`workflowEngine.start`~~ **暂缓（需工作流资产）**：`start` 存在，但需 review 工作流 `script`/`meta`/`parent: Agent`（SPEC §3 索引） | Claude、Codex | 暂缓 |

**实现落点（逐命令矩阵见 `COMMANDS-SPEC.md` §0.1；最多 6 类，按命令取子集）**：

1. `TUI/src/main.ts` — `ctx.get?.("<svc>") as <Svc>Like | undefined` 取服务，加进 `createRealDshAdapter({...})` 参数（与既有 `sessionQuery` / `sessions` / `agentPresets` / `permissionPresets` / `jobs` 同模式）
1. `TUI/src/app/adapter/types.ts` — 加结构化 `<Svc>Like` 类型（不 import 宿主类型，保持解耦）+ `DshAdapter` 上的可选方法；`adapter/dsh.ts` 实现该方法
1. `TUI/src/app/commands.ts` — **两处**：`SlashRoute` 联合类型加 `"<name>"` **和** `LOCAL_COMMANDS` 加条目（`/init` 实现已证明缺一不可）
1. `TUI/src/app/index.ts` — `case "<name>"` + `run<Name>()`（notice 或面板）+ `helpText` 行
1. 测试与基线 — `tests/app.test.ts` 用例（`FakeAdapter` 注入）+ 文档（本文件、`README.md`）；`helpText` 行变化须重跑 `scripts/freeze-focus-frame.mts` 与 smoke

- **服务缺失必须降级**：沿用既有 `XxxLike | undefined` + 「服务不可用」提示模式（fail-close），照抄即可。
- **已可用、无需实现**：`/plan`（`dsh-plan-mode`）、`/export`（`dsh-session-log-export`）——转发宿主注册命令即可。
- 表内方法名已按 dsh 0.1.5-rc.2 **源码核实为精确签名**（含参数形态）；`/clear` `/login` `/logout` `/review` 因宿主能力缺口／语义不匹配移入**暂缓**（`/clear` 无对应方法；`/login` 无交互流程 API；`/review` 缺工作流资产），索引见 `COMMANDS-SPEC.md` §3（不写规格）。

### 2.2 用本项目插件（仅「无需改造」者可能纳入；本轮全部不纳入）

现状：本项目 10 个插件**均只注册模型工具或 hook，未把服务挂到宿主 ctx** —— 这些命令都要先改插件；本轮实现范围不含它们（`/contract` 除外，它只需复用纯函数）。

| 命令 | 本项目插件 · 可支撑能力 | 需补的暴露 | 优先级 |
|------|----------------------|-----------|--------|
| `/memory` | knowledge-base：`getSummary()` / `whenReady()`（C4 已实现并挂 `ctx.provide("knowledge")`；概要=就绪/路径/chunk·source） | provide 只读查询面 ✅ 已完成 | P1 ✅ A3 已实现（TUI 接线） |
| `/loop` | metric-loop：`list()`（C5 已实现并挂 `ctx.provide("metricLoop")`；LoopSummary=id/状态/目标/指标/updatedAt） | provide 只读查询面 ✅ 已完成 | P1 ✅ A4 已实现（TUI 接线） |
| `/contract` | goal-contract：入口 re-export `buildObjective`/`parseContract`（C2 前置）；**不 expose ctx 服务** → TUI 内置同构回读兜底（service 优先钩子预留） | 包入口直读评估：TUI 无跨包依赖/根无 workspaces → 不可行；改内置回读支路 ✅ | P1 ✅ A5 已实现（TUI 接线） |
| `/workflows` | tool-workflow 会话事件流（runId 分组）+ `ctx.workflowEngine` 挂载探测；dsh-workflow 无只读查询面 | adapter 维护 runs 集合 + refreshWorkflows；TUI 面板打开定时刷新 | P2 ✅ #16 已实现（只读运行列表） |
| `/council [N]` | `ctx.subagents.start`（dsh-subagent one-shot 启动面）+ 当前目标源 | adapter.council 并行 allSettled + 失败降级；notice 展示 | P2 ✅ #18 已实现（二次意见） |
| `/search <query>` | `ctx.web.search`（dsh-web provider-selecting seam，非聚合）+ `options.searchProviders` | adapter 并行多 provider 合并/去重/排序；Enter 来源 URL；listPanel | P2 ✅ #24 已实现（网页搜索聚合） |
| `/task` | task-engine：`query()` / `frameStack()`（C1 已实现并挂 `ctx.provide("taskEngine")`） | provide 只读子集 ✅ 已完成 | P2 ✅ A1 已实现（TUI 接线） |
| `/contract` | goal-contract：纯函数**未从包入口导出**（`index.ts` 仅 `name`/`inject`/`apply`） | 需给该包加 re-export（属插件包改动） | P2（本轮不纳入） |
| `/guard` | security-guard：`recent()` / `policy()`（C3 已实现并挂 `ctx.provide("guard")`） | provide 只读查询面 ✅ 已完成 | P2 ✅ A2 已实现（TUI 接线） |

- 工具性质、命令入口价值低（模型直接用即可）：fs-digest、hash-edit、ast-tools、output-compress。
- 落点与 §2.1 相同：插件侧补齐「服务暴露」后，命令仍在 TUI 侧实现（`ctx.get("<svc>")` → adapter → 本地命令）。
- `/diff`、`/doctor` 无宿主服务依赖，同为 TUI 包内实现（跑 git / 自检 TUI、宿主、插件装配）。

### 2.3 已剔除（按当前口径不考虑）

- **需额外装配官方可选 bundle**（当前 profile 未挂载）：`/mcp`（`dsh-mcp-client`）、`/hooks`（`dsh-hooks-claude-code` / `dsh-hooks-codex`）。
- **第三方 / 其他 agent 生态命令**：见 §2.4。

### 2.4 不建议（记录理由，避免重复调研）

- **平台/服务专属，不迁移**：`/stickers` `/radio` `/pets` `/pet` `/passes` `/upgrade` `/mobile` `/chrome` `/desktop` `/teleport` `/remote-control` `/share` `/schedule` `/artifacts` `/design*` `/dataviz` `/deep-research` `/insights` `/recap` `/voice` `/web-setup` `/install-*` `/privacy` `/about` `/powerup` `/team-onboarding` `/run` `/verify` `/batch` `/autofix-pr` `/ultrareview` `/security-review` `/focus` `/color` `/scroll-speed` `/tui` `/plugin` `/plugins` `/extensions` `/apps` `/ide` `/editor` `/docs` `/shells` `/ps` `/archive` `/delete` `/experimental` `/debug` `/debug-config` `/heapdump` `/raw` `/mention` `/pr-comments` `/changelog` `/statusline` `/keybindings` `/keymap`
- **上游已移除**：`/vim`（Claude Code 改由 `/config`）、`/ultraplan`
- **本项目已有等效**：`/compact` `/feedback` `/record` `/goal` `/policy` `/permission` `/preset` `/jobs` `/theme` `/model` `/effort` `/session` `/copy` `/init` `/help` `/quit` `/clearscreen`
- **无底座且收益低**：`/rewind` `/restore`（`dsh-session-checkpoint-policy` 是持久化检查点，非回退）、`/add-dir` `/directory`（会话 cwd 由宿主决定）、`/fast` `/personality`（dsh-persona 未挂载）、`/btw` `/side`（侧聊依赖 0.1.6 的 sidebar 能力，rc.2 无）
