# 升级适配 0.2.1-rc.2 接口（接取条目：docs/BACKLOG.md「升级适配 0.2.1-rc.2 接口」）

状态：实现　　开启：2026-10-21　　关闭：-
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. 运行基线从 `dsh 0.2.0-rc.2` 升到 `0.2.1-rc.2`：全局安装 + profile 树官方包同步 + 回滚预案。
2. 按 `docs/host/HOST-UPGRADE-0.2.1-rc.2.md` 变更清单逐项适配复核（#1 至 #14），含新增面（working_directory / session-title adapters / python-ptc-sandbox / job-id-identity / model-discovery）与本仓消费面核验。
3. 版本引用同步：`scripts/install.sh` / `scripts/test-install.sh` 默认版本、`HOST-PACKAGES.md` 整体重生成、四处 `smoke` 的 `REQUIRED_VERSION`、根 README 双语与各基线文档。
4. `security-guard` 对 0.2.1 安装树跑 `tool-surface-check`；升级后回查 `ARCHITECTURE-REUSE.md` §0。
5. 全仓 `check` / `test` 通过；真机（重启 dsh）验证装配、标题生成与关键面行为。

## 调研

来源：本仓 `docs/host/HOST-UPGRADE-0.2.1-rc.2.md`（前置调研）、官方克隆 `~/GithubRepos/deepseek-harness`（tag `dsh-v0.2.1-rc.2`，commit `687f282`）的 `docs/upgrade-guide/v0.2.1-alpha.{1..4}/`、本仓源码与 profile 实测。

### 当前环境

- 全局安装：`@deepseek-ai/dsh@0.2.0-rc.2`（`npm -g`，node v24.16.0 / fnm）。
- 上游克隆已 checkout `dsh-v0.2.1-rc.2`，升级指南齐全（`working-directory` / `session-title-adapters` / `python-ptc-sandbox` / `job-id-identity` / `deepseek-model-discovery` / `instruction-home-override` / `plugin-engines-dsh` 均有 `guide.md`）。

### 变更清单逐项对本仓的影响（更新 HOST-UPGRADE 表中「升级时复核」项）

- **#1 invariant 移除（breaking）** → **fff profile 有确定冲突**：`~/.dsh/profiles/fff/cordis.patch.yml` 挂载面扩张块里含 `- id: invariants`（`@deepseek-ai/dsh-invariants`，第 380-381 行）。0.2.1 移除该插件运行期实现后，patch 行会「entry not found」或激活失败，**升级时必须从 profile patch 删除该行**。本仓代码零消费（`grep './invariant'` 零命中），代码面无改动。
- **#2 子路径插件 package.json**：本仓无子路径插件，不涉及。
- **#3 engines.dsh**：官方「优先按 `engines.dsh` 判定插件兼容性」。本仓 29 个包 + TUI 无 `engines.dsh` 声明（走 `cordis.patch.yml` + `dsh.bundle` 契约）；对照结论为「升级时核对」——预期无影响，升级后以装配健康检查确认。
- **#4 stats 拆 activity/usage**：TUI 自带 `/stats` 命令，未覆盖宿主 stats 扩展位，不涉及。
- **#5 Agent Team 直投 Inbox**：`agent-group` 自建通道，不消费官方 team 面，不涉及。
- **#6 both 展示模式移除**：本仓未用 `both`，不涉及。
- **#7 agent-instructions 目录改 DSH_HOME**：本仓未配置逐行 `dshHome`，不涉及。
- **#8 python-ptc-sandbox**：核对 `script-interpreter` —— 其 Python 后端是**自带 `python3` 子进程**（`langs/python.ts`：stdin 直传、绝对路径候选），**不**用官方 `ptc-runtime-python`，故不受 PTC 组合契约影响（官方指南亦明示「Node 运行时不受影响」）。**升级时以装配无 `sandbox-unavailable` 告警复核**。
- **#9 Azure 名称统一**：profile 未用，不涉及。
- **#10 working_directory / 会话工作目录**：官方新增 `cwd` 状态与工具。本仓 `session-paths` 是路径编码纯函数（`sessionDirFor` 用于会话目录），与「会话当前执行目录」概念不同层，无直接冲突；列为观察项。**task-engine** 的 `SubagentsLike.start` 已在 start request 里传 `cwd`（主线 97-102 行；注释 1151 行明言「宿主 SubagentStartRequest 无 cwd 参数 → 声明期即拒绝，不做假装隔离」）——0.2.1 起 SubagentStartRequest **支持 cwd**，该注释将失效：subagent 后端的 worktree 隔离从「声明期拒绝」变为「技术上可落地」。**决策点 D2：本期是否启用该能力**（建议不启，仅核对传参不报错，能力立项另开条目）。
- **#11 Session 状态记录接口（experimental）**：`memory-base` / `context-report` 的可选采纳观察点，不构成升级阻塞；本期不采纳。
- **#12 自动化内置**：官方 `schedule_*` 四工具 preset-owned，fff 无 preset → 官方自动化非开箱即用；本仓 `background-daemon` 自建链路（inject 面 = agents/sessions/commands/tools，非 schedule 服务）不受影响。**复核项：确认 fff 组合不挂 `tool-schedule`**（对照结论一致：工具清单无 `schedule_*`）。
- **#13 模型目录 / pi-ai 1.0.2 / 空目录规则**：fff 用 tollgate provider + profile 内自列模型清单（`llm-pi-ai` 配置段），不依赖官方模型目录；凭证走 `apiKeyEnv` 在位。空目录新规不构成影响。升级后以会话可用性（模型选择 / 请求发起）复核。
- **#14 共享 AGENTS.md（DSH_AGENTS_HOME）**：本仓为项目级 AGENTS.md，无冲突。

### 新增面与本仓消费面核对

- **session-title-adapters**（重点）：`session-title-cutoff` 注册 `ctx.sessionTitle` 唯一 provider，运行时加载官方 `@deepseek-ai/dsh-session-title-llm` 的 `generateSessionTitleWithLlm`（`session-title-cutoff/src/main.ts:141-152, 283`）。0.2.1 把模型标题路由改为**经 `ctx.llm.prepareCall()` 生成，组合须注册 adapter**。影响点：官方 helper 的生成路径若走 prepareCall，而组合里没有已注册的 title adapter → 标题生成可能失败。**升级后真机重点验证**：会话标题是否仍能生成；失败则补 `ctx.llm.registerAdapter()`（需查官方该包在 0.2.1 是否自带 adapter 注册面 / 是否需要组合显式挂）。该判断依赖运行态，列为真机验证第一优先。
- **job-id-identity**：宿主 `jobs` 服务 id 改 `<kind>-<16 位 uuid>`，移除 `executionId`。本仓**零消费**：TUI 的 `jobs` 相关是自建 `/jobs` 任务面板（`state.jobs` 事件流，非宿主 jobs 服务）；全仓无 `JobExecutionId` / `<kind>-N` 构造。无代码改动。
- **working_directory / {{cwd}} 变量移除**：本仓 profile / personaSuffix 未用 `{{cwd}}`，无 `dsh-subagent-acp` / `dsh-subagent-dsh-sdk` 的 cwd 配置键。task-engine 见 #10。
- **python-ptc-sandbox**：见 #8，不涉及。
- **model-discovery 空目录**：见 #13。

### 版本引用面（升级时同步）

非归档文件里含 `0.2.0-rc.2` 的：`docs/ARCHITECTURE-REUSE.md`、`docs/BACKLOG.md`（基线行）、`docs/host/HOST-PACKAGES.md`、`docs/host/HOST-UPGRADE-0.2.0-rc.2.md`、`docs/STATUS.md`、`goal-contract/{README.md,smoke/smoke.mjs}`（REQUIRED_VERSION）、`metric-loop/{README.md,smoke/smoke.mjs}`、`output-compress/smoke/smoke.mjs`、`security-guard/{README.md,smoke/smoke.mjs}`、`herdr-integration/README.md`、根 `README.md` / `README.zh.md`、`scripts/install.sh`（3 处）、`scripts/test-install.sh`、`TUI/docs/{COMMANDS.md,DESIGN.md,STATUS.md}`。`HOST-UPGRADE-0.2.1-rc.2.md` 需回写实施状态。`docs/STATUS.md` 由用户择时更新（流程内不改）。

### profile 双目录与外部改动

- 源目录 `~/fff/config/dsh/profiles/fff`（cordis.patch.yml + package.json），运行时目录 `~/.dsh/profiles/fff`（含 node_modules / pnpm-lock / TUI 宽度表）。两者 cordis.patch.yml 内容在当前有差异（.dsh 侧更新）。
- profile `package.json` 钉 `@deepseek-ai/dsh-session-title-all-prompts-llm@0.2.0-rc.2`（注释明示「与宿主同版」）→ 需升 `0.2.1-rc.2` 并 `pnpm install`（参照 0.2.0 升级 D3）。
- profile patch 需删 `invariants` 行（#1）。此为**仓库外**改动，需用户同意。

## 决策（待用户裁定）

- **D1 执行方式（仓库外改动）**：全局安装 `npm i -g @deepseek-ai/dsh@0.2.1-rc.2` + profile 双目录同步（版本钉 + invariants 行 + `pnpm install`）由本任务执行，先备份到 `~/.dsh-upgrade-backup-2026-10-21/`，回滚预案 = 装回 `0.2.0-rc.2` + 还原 profile 文件。选定 **a**（用户 2026-10-21 裁定「D1 可以」）。
- **D2 task-engine subagent worktree 隔离**：0.2.1 起 SubagentStartRequest 支持 cwd。选定 **a 本期不启用**（用户 2026-10-21 裁定「只改注释」）：仅更新 `task-engine/src/main.ts:1151` 附近注释口径（说明 0.2.1 起宿主支持 cwd、隔离能力可另行立项），不发起用逻辑。
- **D3 标题 adapter**：选定 **a 升级后按真机结果决定**（用户 2026-10-21 裁定「可以」）：先升后验，标题生成为真机验证第一优先项；失败再按官方 0.2.1 的 adapter 注册面补最小代码。
- **D4 版本引用更新范围**：选定 **全量一起升级**（用户 2026-10-21 裁定「D4 一起升级」）：四处 smoke `REQUIRED_VERSION` 必须升；`HOST-PACKAGES.md` 整文按 §6 复现命令重生成；**`docs/STATUS.md` 与 `TUI/docs/STATUS.md` 的宿主基线行也在本次一并更新**（用户当次明确要求优先于「STATUS 由用户择时」的项目默认）。

## 规划（任务拆分 + 计划改动文件清单）

任务拆分（执行顺序）：

01. 备份（profile 双目录配置 + 必要的全局包清单）。
02. 全局安装 `@deepseek-ai/dsh@0.2.1-rc.2`（cache 指到可写 tmp），`dsh --version` 核对。
03. profile 树同步：`session-title-all-prompts-llm` 钉 `0.2.1-rc.2`（源目录 `npm pkg set` + 两目录 `pnpm install`）；`cordis.patch.yml` 删 `invariants` 行（两处目录同步）。
04. 装配与健康检查：`dsh --profile fff --dump-config` 退出 0 / stderr 空；PTY 冒烟启动一次（无 activation 失败 / 无 `tool-schedule` 新面）。
05. 版本引用同步（仓库内）：`scripts/install.sh`（3 处）、`scripts/test-install.sh`、四个 smoke 的 `REQUIRED_VERSION` + 相关 README 前置条件、根 `README.md` / `README.zh.md`、`docs/ARCHITECTURE-REUSE.md` 基线行、`docs/host/HOST-UPGRADE-0.2.0-rc.2.md` / `HOST-UPGRADE-0.2.1-rc.2.md` 回写、`docs/BACKLOG.md` 基线行。
06. `HOST-PACKAGES.md` 按 §6 复现命令整体重生成（0.2.1 包目录 / 挂载集合实测）。
07. `security-guard` 对 0.2.1 安装树跑 `scripts/tool-surface-check.mjs`（逐升版差异）。
08. 全仓 `npm run check` + `npm run test`。
09. 真机验证（重启 dsh 后）：标题生成（session-title-adapters 重点）、会话 / 模型请求可用、`tool-surface` 无回归、`daemon_task` 等自建链路正常、`background-daemon` 启动仪式无变化。
10. `ARCHITECTURE-REUSE.md` §0 回查（「是否受 0.2.1 新面影响」标注行）。
11. 关闭收尾（条目清理 / 文档归档）。

明确不做：

- 不启用 task-engine subagent worktree 隔离（若 D2=a）；只动注释口径。
- 不采纳 experimental session-state 接口、working_directory 对 session-paths 的重构（观察项）。
- 不迁移官方 automation（`background-daemon` 保持自建；不挂 `tool-schedule`）。
- 不改 agent composition / preset 面。
- 不自动改 `STATUS.md` / `TUI/docs/STATUS.md`（用户择时）；`docs/host/DSH-CTX-API.md`（只读参考）不动。
- 不做 1925 提交全量逐文件 diff（前置调研已判价值低）。

## 实现记录

- 2026-10-21 执行：USER 裁定 D1-D4（D1 由本任务执行外部改动 / D2 只改注释 / D3 真机后定 / D4 全量含 STATUS 一起升）；决策写入本节并经提交点 1 提交（`c02d882`）。
- 2026-10-21 全局安装：`npm i -g @deepseek-ai/dsh@0.2.1-rc.2`（dist-tags 实测 `latest=0.2.1-rc.2`；added 99 / removed 24 / changed 514，~1m），`dsh --version` = `0.2.1-rc.2`。备份在工作区 `tmp/upgrade-backup-2026-10-21/`（profile 双目录配置 + 全局包清单 + 升级前版本）。
- 2026-10-21 profile 树同步：源目录与运行时目录的 `cordis.patch.yml` 删 `invariants` 行（0.2.1 移除，`dsh-base` 装配后 dump 中已无）；`session-title-all-prompts-llm` 版本钉 0.2.0-rc.2 → 0.2.1-rc.2（两处 package.json），运行时目录 `pnpm install` 后实测 node_modules 内 0.2.1-rc.2。共享 `~/.dsh/profiles/node_modules` 的 `dsh-session-title{-llm,first-prompt-llm}` 随全局安装已自动到 0.2.1-rc.2。
- 2026-10-21 装配健康：`dsh --profile fff --dump-config` exit 0 / stderr 空 / 无 `patch: entry` 告警 / 无 `tool-schedule` / 标题相关包在位；活跃官方挂载 100 个（排除无条件 disabled）＝含新面 `working-directory` / `tool-working-directory` / `web-deepseek-api` / `api-remote-access` 四件，`invariants` / `tool-ralph` / `skill-badge` 已不在活跃集。
- 2026-10-21 版本引用同步完成：`scripts/install.sh`（3 处）/ `scripts/test-install.sh`（6 处）/ 四个 `smoke/smoke.mjs` 的 `REQUIRED_VERSION` / `goal-contract` / `metric-loop` / `security-guard` README 前置条件 / 根 `README.md` / `README.zh.md` / `docs/STATUS.md` / `TUI/docs/STATUS.md` / `TUI/docs/COMMANDS.md`（命令面 6 条复核不变）/ `TUI/docs/DESIGN.md` / `metric-loop/README.md` / `HOST-UPGRADE-0.2.1-rc.2.md` 结论回写。
- 2026-10-21 `HOST-PACKAGES.md` 按 §6 口径重生成：随包分发 **288 → 306**（`dsh-*` 277 → 294）；移除 11 包（`client-web` 非独立行除外：`subagent-in-process-driver` / `invariants` / `experimental-schedule-bundle` / `hooks-claude-code` / `hooks-codex` / `webhook` / `webhook-github` / `client-store` / `client-ui-primitives` / `client-ui-slots` / `web-frontend` 改名 `dsh-web-frontend` 故恢复行）；新增 26 行（含 `working-directory` / `tool-working-directory` / `web-deepseek-api` / `tool-schedule` / `tool-session-query` / `tool-terminal` 等）；分类计数重算（项数和 306）；§1 挂载清单按 dump 重导（100 官方活跃 + 树外 all-prompts 注记）；§3 服务索引 86 → **92**（新增 workingDirectory / remoteAccess / cotTranslation / translator / pluginMarket / worktrees，另 6 个 API 控制面服务本已在册）；§0 头部口径与 §6 采集时间更新。
- 2026-10-21 security-guard `tool-surface-check.mjs` 对 0.2.1 安装树：**31 包 / 59 工具 / 需关注 13**（0.2.0 基线 27 / 49 / 8）。新增 4 项 `terminal_open` / `terminal_send`（`dsh-tool-terminal`）与 `session_event_read` / `session_event_trace`（`dsh-tool-session-query`）——两者**均未挂载**（不在 fff 生效面），无需登记；已挂载的 `working_directory` 无 path / command 参数，列入「未覆盖但无相关参数」无需登记。security-guard 无代码改动。
- 2026-10-21 `task-engine/src/main.ts`：`executor 隔离` 注释口径更新（0.2.1 起 `SubagentStartRequest` 支持 `cwd`，本期仍不启用 subagent 后端 worktree 隔离，能力另开条目——决策 D2）。
- 2026-10-21 `docs/ARCHITECTURE-REUSE.md` §0 回查：基线口径更新（294 / 100），升级注记与 `background-daemon` 行保留。

## 偏差

（待实现完成后填写）

## 测试与证据

- 全局安装：`npm i -g @deepseek-ai/dsh@0.2.1-rc.2`（`dsh --version` = `0.2.1-rc.2`；`npm ls -g` 确认）。
- 装配：`dsh --profile fff --dump-config` exit 0 / stderr 空 / 无 `patch: entry`；活跃官方挂载 100（含新面 4 件，无 invariants / tool-ralph / skill-badge）。
- profile：`session-title-all-prompts-llm` = 0.2.1-rc.2（两处 package.json + 运行时 node_modules 实测）；`invariants` 行已从两处 patch 删除（`grep -c` 0）。
- 版本引用：`scripts/test-install.sh` 84 项全通过（含 fake dsh 0.2.1-rc.2 与树外 pin 判定）；四个 smoke 的 `REQUIRED_VERSION` 已升（smoke 本体需模型凭据，真机阶段跑）。
- `HOST-PACKAGES.md`：306 包 / 294 `dsh-*` / §3 92 服务；§2 行数与 §0 口径自洽（分类和 306）；文档↔安装树名字级 diff 余差仅为 vendor 前缀记法（`cordis-*` / `dsh-cordis-*`），无实质缺失。
- security-guard `tool-surface-check`：0.2.1 树 31 包 / 59 工具 / 需关注 13（0.2.0 基线 27 / 49 / 8）；新增 4 为未挂载包工具，fff 生效面无登记缺口。
- 全仓 `npm run check`：30 包通过（exit 0）。
- 全仓 `npm run test`：30 包全绿（exit 0；background-daemon 165 / TUI 1679 等）。
- 真机（待用户重启确认，按「D3 标题 adapter 优先」）：① 标题仍能生成（session-title-adapters 最可能出问题，失败则补 `llm.registerAdapter` 最小改）；② 会话 / 模型请求可用；③ `daemon_task` / 自建链路启动仪式正常；④ 无 `sandbox-unavailable` / `ERR_MODULE_NOT_FOUND` / activation 失败。

## 收尾

（待关闭时填写）
