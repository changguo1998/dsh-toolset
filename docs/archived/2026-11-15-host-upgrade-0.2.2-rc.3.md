# 宿主 0.2.2-rc.3 升级与接口对照（接取条目：`docs/BACKLOG.md`「宿主 0.2.2-rc.3 升级与接口对照」）

状态：关闭　　开启：2026-11-15　　关闭：2026-11-15
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 在项目级 BACKLOG 登记「宿主 0.2.2-rc.3 升级与接口对照」条目并开工（标〔进行中〕）。
2. 确认官方是否已发布比 `0.2.2-rc.1` 更新的 rc 版本。
3. 对照 `0.2.2-rc.1 → 新 rc` 的接口面增量（事件 / 服务 / 工具 / 投影 / bundle 默认值），判定对本仓 41 个包的影响，产出可据此裁定的对照结论与升级清单。

本次**只做只读调研与文档**：不改任何包源码、不改 profile、不安装新宿主。

## 调研

来源：官方 clone `~/GithubRepos/deepseek-harness`（用户 2026-11-15 拉取，HEAD `39163dd30f`，2026-11-13）；npm 公共注册表 `@deepseek-ai/dsh`；本机安装树 `~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@deepseek-ai/dsh`；本仓既有文档 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md`、`docs/BACKLOG.md`。全部结论来自只读命令（`git log` / `git diff` / `git grep` / `git ls-tree` / `git show`）与注册表读取，未跑 check / build / test，未改宿主。

### 1. 版本事实（有新 rc）

- 官方 tag 现为：`dsh-v0.2.2-rc.1`（`66491b05e3`，2026-11-04）、**`dsh-v0.2.2-rc.2`（`ddac96760b`，2026-11-11）**、**`dsh-v0.2.2-rc.3`（`38a6a5c965`，2026-11-13）**；无 `v0.2.3*` tag。
- npm `@deepseek-ai/dsh` 的 dist-tags：`latest = 0.2.2-rc.1`、`next = 0.2.2-rc.3`、`alpha = 0.2.2-alpha.3`。即 **rc.2 / rc.3 已发布但只在 `next` 通道，`latest` 仍是 rc.1**。
- 本机安装树 `@deepseek-ai/dsh` 版本 = `0.2.2-rc.1`（等于 `latest`，比 `next` 的 rc.3 落后两个 rc）。
- clone 的 `master` HEAD 是「rc.3 合入 master」的合并提交，其后**没有**新 tag：`rc.3..master` 还有 608 个未发版提交（382 个包目录），属 0.2.3 线开发内容。
- 本仓 `docs/host/` 与项目级 BACKLOG 的**声明基线**仍是 `0.2.2-rc.1`（BACKLOG 头部与 `HOST-PACKAGES.md` 未改；`docs/host/` 已新增本文任务的 rc.3 对照文档接替 rc.1 那份）。

### 2. 版本间规模

| 区间 | 提交 | 文件 | 包目录数 |
| --- | --- | --- | --- |
| rc.1 → rc.2 | 1568 | 4645（+160844 / −58399） | 372 → 373 |
| rc.2 → rc.3 | 6 | 515（+10988 / −669） | 373 → 374 |
| rc.3 → master | 608 | 3309（+104100 / −36870） | 374 → 382 |

- rc.2 → rc.3 只有 6 个提交：发布合并 `38a6a5c965`、`release(dsh): 0.2.2-rc.3`（`4c1cf20cb1`）、实验包「导入 DeepSeek 官网对话导出为会话」（`b8c33a1504`）、`fix(ci)` 缓存修复（`68f83cc992`）及其分支合并（`bbad94f927`）、重启状态 / cwd 分支合并（`ac904e118e`）。**接口面增量实质发生在 rc.1 → rc.2**。
- 全仓包版本号 `0.2.2-rc.1` → `0.2.2-rc.3`（如 `packages/core/tools/package.json`）。
- **官方升级指南目录没有新增 `v0.2.2-rc.2` / `v0.2.2-rc.3`**：指南仍以 `v0.2.2-rc.1/` 为最新目录，但其下 19 条指南回填了 rc.2 / rc.3 的变更（`subagent-interrupt-default`、`runtime-context-reminders`、`session-append-overloads`、`plugin-update-method` 等）。故本次以代码为准，指南作定位线索。

### 3. 包增删（rc.1 → rc.3）

新增 11 个：`client/ui-account-notifications`、`client/ui-agent-team`、`document/office-kit`、`document/tool-office`、`experimental/deepseek-chat-import`、`experimental/terminal-panel`、`mcp/mcp-manager`、`team/agent-team`、`team/tool-agent-team`、`util/error`、`util/ripgrep`。

移除 9 个：`api/account-controller`、`credentials/deepseek-account-platform`、`document/office-to-pdf`、`experimental/agent-team`、`experimental/agent-team-profile`、`experimental/client-ui-agent-team`、`experimental/tool-agent-team`、`web/web-search-exa`、`web/web-search-perplexity`。

口径变化：Agent Teams 由 `experimental/*` 毕业为 `team/*`；`office-to-pdf` 被 `office-kit` + `tool-office` 取代；账号平台包去掉 `-platform` 后缀（`credentials/deepseek-account`）；Exa / Perplexity 搜索供应商包移除。

### 4. 事件面（+11 / −0）

以 `packages/**/src/**` 内 `'<域>/<名>'(` 声明形态统计：rc.1 = 97 个，rc.3 = 108 个，**无删除**。新增：

- `account-ui/change`、`account-ui/refresh`
- `mcp-manager/status`
- `web/providers-changed`
- `working-directory/access`
- `workspace/archive-followup-failed`、`workspace/archive-followup-settled`、`workspace/archive-notice`、`workspace/session-archived`、`workspace/session-unarchiving`
- `worktree/cleanup`

载荷变化（指南与源码）：`subagent/start` / `subagent/end` 的 `info` 增加 `parentSessionId`（直接创建者），作用域分发载体从「委派父会话」改为「子代理树根」。

### 5. 工具面

- 新增 `wait_agent`（`tool-subagent-control`，等待调用方收件箱来消息）。
- 新增 `office_convert` / `office_recalculate` / `office_render`（`tool-office`，由 Office 技能激活后上架）。
- 新增 `user_terminal_list` / `user_terminal_read`（`experimental/terminal-panel`，只读用户侧终端）。
- Agent Teams 工具由 9 个缩为 4 个任务板工具（`team_task_create` / `get` / `list` / `update`）；`spawn_teammate` 与团队专用的 `interrupt_agent` / `list_agents` / `send_message` / `wait_agent` 改为复用标准子代理控制工具。
- **出厂默认关闭 `interrupt_agent`**：`dsh-base` 与 Web 三套 preset 的 `tool-subagent-control` 行新增 `config.interrupt: false`（插件自身缺省仍是 `true`）。消息、发现、收件箱等待与 `ctx.subagents` 的中断服务面都保留。
- `apply_patch`：rc.3 的 `dsh-base` 与 `standard` preset 代码仍是 `applyPatch: false`（`base/cordis.patch.yml:296-300`、`standard.patch.yml:27-31`）；而官方 `docs/tool-catalog.md` 与 alpha.2 指南称「base 与 standard 已获得 `apply_patch`」→ **文档与代码第二次不一致，以代码为准**（与 `HOST-UPGRADE-0.2.2-rc.1.md` §6 结论一致）。

### 6. 工具管线（`@deepseek-ai/dsh-tools`）

- 新增 `ToolContextUnavailableError` 与错误码文件 `src/error-codes.ts`（`APPROVAL_REJECTED` / `APPROVAL_CANCELLED` / `APPROVAL_UNAVAILABLE` / `TOOL_CONTEXT_UNAVAILABLE`）。
- `ToolGuard` 返回值从 `string | undefined` 放宽为 `string | ToolGuardDenial | undefined`（`ToolGuardDenial = { reason, info? }`）；`ToolsService.checkGuards` 返回 `ToolGuardDenial`。
- `PostToolDecision` 的 `block` 分支新增可选 `info?: ToolErrorInfo`；审批拒绝路径开始携带 `ApprovalError` 身份。
- 取消归类：体内抛出的中止原因或无名 `AbortError` 归为 `TOOL_ABORTED`。
- `register()` / `restrict()` / `tools/pre-execute` 载荷语义**未变**（`ToolRuntime` 别名仍在）。

### 7. 会话与投影

- `Session.append` 增加**数组重载**（`append(inputs: readonly SessionEventInput[])`），单事件调用照旧；`SurfaceManager` 新增 `prepareBatch`。只影响「替换 / 包装 `Session.append`」的代码与测试替身。
- 会话存储写入门禁（0.2.1-rc.2 起）：存储持有的会话在 `session/created` 播报完成前、以及移除后拒绝追加。
- 投影：`sessionProjections.stateOf(session, key)` **仍是弃用但未删除**（rc.3 仍在 `session-projection/src/index.ts:454-459` 打运行时告警）；注册仍返回 `handle.stateOf(session)`。全仓 `@deprecated` 计数 rc.1 = rc.3 = 13，无新增弃用。
- runtime-context 记录：新 `source.kind: 'runtime-context'` 记录的正文包在 `<system-reminder>` 里，清空标记带 `form: 'snapshot'` 且 `sections: []`；按字面匹配正文的消费者需改按 `source.kind` / `source.sections` 判定。

### 8. 子代理服务（对本仓最关键）

`ctx.subagents` 方法面 rc.1 → rc.3：

- 移除：`waitForChildren(parent)`、`listChildren(parentSessionId)`、`drainChildren(parent, ids)`、`interruptByParent(...)`、`list()`（provider 名枚举）。
- 新增：`rootOf(agent)`、`namesOf(agent)`、`resolveName(caller, name, signal)`、`interruptByUser(childSessionId)`、`waitForTreeWork(root)`；保留 `listDescendants(rootSessionId, signal?)`、`interrupt(targetSessionId, authority)`、`startActivation(spec)`、`getProvider(name)`、`drainDescendants(parents)`。
- 同一服务在更早的版本里**已经删掉 `start()` / `startContinuable()`**：`git show <tag>:packages/subagent/subagent/src/index.ts` 里 `^  start(` 在 `0.1.5-rc.3` / `0.1.7-rc.2` / `0.2.0-rc.2` 各 1 处，`0.2.1-rc.2` 起为 0；官方指南 `v0.2.1-alpha.1/subagent-activations` 明写「replace `ctx.subagents.start()` or `startContinuable()` with `startActivation()`」，`v0.2.1-rc.2/subagent-service-methods` 明写移除 `drainChildren` / `listChildren` / `list`。本机安装的 `0.2.2-rc.1` 类型声明里确认无 `start`（只有 `startActivation` 两个重载）。
- 子代理命名：`subagent-names` 指南（alpha.3）说明控制工具与 Team 任务工具**按名寻址**，`list_agents` 行结构变化，子代理目录载荷版本升到 3；新增 `ROOT_AGENT_NAME` 与 `SubagentMemberNames` 导出。

### 9. bundle 默认值（`dsh-base` / presets）

rc.1 → rc.3 的 `packages/bundle/base/cordis.patch.yml` 实际 diff 只 4 处：

1. `deepseek-account` 行的包名 `@deepseek-ai/dsh-deepseek-account-platform` → `@deepseek-ai/dsh-deepseek-account`（行 id 不变）。
2. 新增 `agent-team`（`maxTasks: 256`）与 `tool-agent-team` 两行。
3. `tool-subagent-control` 行新增 `config.interrupt: false`。
4. `web` 行 `searchProvider: deepseek-official` → `deepseek-search-api`；`web-deepseek-api` 行删除 `config.apiKeyEnv`（改为跟随会话路由的凭据来源）。

`fs-observation-policy` 仍是 `disabled: true`，`tool-fs` 仍是 `applyPatch: false`。

### 10. 本仓影响判定

| # | 项 | 位置 | 性质 |
| --- | --- | --- | --- |
| 1 | `ctx.subagents.start(name, request)` 在 0.2.1-rc.2 起已不存在，本仓仍按旧面调用 | `task-engine/src/host.ts:13`（`SubagentsLike`）、`task-engine/src/subagent.ts:144,230`、`command-template/src/subagent.ts`、`TUI/src/app/adapter/dsh-panels.ts:645-652`（`/council`） | **既有退化（非 rc.3 引入）**：`start` 缺失 → 走「宿主 ctx.subagents 不可用」分支或直接失败；需另开条目裁定迁移到 `startActivation()` |
| 2 | `interrupt_agent` 出厂关闭 | `security-guard/README.md`（宿主工具面清单）、`docs/host/HOST-PACKAGES.md` | 文档口径过期；TUI 的 `/agents` 打断走 `subagents.interrupt(child, {kind:'user'})` 服务面，**不受影响**（rc.3 该签名仍在） |
| 3 | 新工具 `wait_agent` / `office_*` / `user_terminal_*` 未登记 | `security-guard/src/tool-registry.ts`、`escalation-hint/src/index.ts` | 覆盖缺口但风险低：`office_*` 只写 Office 输出暂存目录、路径由工具自管；`wait_agent` / `user_terminal_*` 非写面 |
| 4 | `list_agents` 行与子代理目录按名寻址、载荷版本 3 | `TUI/src/app/adapter/dsh-panels.ts:238-260`（`listDescendants`） | 需核对：rc.3 目录条目在 `external` / `continuable` 两个变体上新增可选 `name`，`id` / `label` / `activity` 保留；变化点是控制工具与 Team 任务工具按名寻址、目录载荷版本升到 3 |
| 5 | 投影 `stateOf(session, key)` 弃用 | `task-engine` / `context-report` / `rule-engine` | 无变化（仍可用，仍打告警），延后迁移 |
| 6 | `apply_patch` 文档与代码不一致 | `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` §6 / §12 | 结论不变：不启用；三处写面清单已含 `apply_patch`（2026-11-08 已补） |
| 7 | 账号两包移除 / 改名（`dsh-api-account-controller`、`dsh-deepseek-account-platform`）、`account-ui/*` 事件新增 | `docs/BACKLOG.md` §6 挂起条目正文、`profiles/example/cordis.patch.yml:228-229` 注释 | 挂起条目的「宿主侧依据」与恢复路径 ①/② 需复核；profile 只用行 id `deepseek-account`，**不需改** |
| 8 | 宿主要求 Node ≥ 24.9（`node-24` 指南，0.2.1-rc.2 起） | 根 `package.json:26-28`（`engines.node: >=22.19.0`） | 声明过时；本机 v24.16.0 满足 |
| 9 | 事件 +11 无删除 | 全仓 | 本仓无这些事件的监听者，无影响 |
| 10 | 工具管线新增 `ToolGuardDenial.info` / `block.info` / `ABORTED` 归类 | `security-guard`、`tool-surface`、各 `post-execute` 消费者 | 向后兼容，零改动；可选增量：`security-guard` 拒绝回执带 `info.code` |
| 11 | `Session.append` 数组重载 | 全仓 | 本仓不替换 `append`（只调单事件），无影响；若将来写替身需实现双重重载 |
| 12 | `BundleInfo.updatable` → `update` | 全仓 | 本仓无 `listBundles` / `updatable` 使用，无影响 |
| 13 | 新服务 `mcpManager` / `officeKit` / `terminalController` / `accountUi` | 全仓 | 本仓不消费，无影响 |
| 14 | runtime-context `<system-reminder>` 框架化 | 全仓 | 本仓无按字面匹配 runtime-context 正文的代码，无影响 |
| 15 | `subagent/start` / `subagent/end` 载荷加 `parentSessionId`、作用域载体改树根 | 全仓 | 本仓无这两个事件的监听者，无影响 |

### 11. 明确无影响面（逐项已核）

`herdr-use` / `herdr-integration` / `coagent` / `session-channel` / `session-paths` / `memory-base` / `pin-note` / `flow-track` / `plan-mode` / `flow-arbiter` / `task-engine`（除 #1）/ `term-check` / `md-table-check` / `symbol-normalizer` / `clock-base` / `shell-parse` / `preference-analysis` / `output-compress` / `fs-digest` / `md-map` / `md-logic` / `code-map` / `ast-tools` / `hash-edit` / `goal-contract` / `metric-loop` / `agent-group` / `background-daemon` / `script-interpreter` / `tool-consult` / `tool-surface` / `behavior-correction` / `auto-approve` / `escalation-hint`（除 #3）/ `cache-hit-monitor` / `context-report`（除 #5）/ `rule-engine`（除 #5）：均不消费本次变更的接口面。

## 决策

> 编号对照：D1-D9 = 决策项 1-9（对外描述用 `D7 = 7b` 这类形式指明改动）；选项一律用小写字母。

- **决策项 1（升级目标版本，D1）**：a) 以 `0.2.2-rc.3` 为目标（选定）— b) 停在 rc.1 只记录 — c) 跟 master 未发版内容。
  选 a：rc.3 是当前最新 rc（`next` 通道），rc.2 → rc.3 只有 6 个提交，增量主体在 rc.1 → rc.2；跟进 master 的 608 个未发版提交不是发布面，成本高且会漂移。
- **决策项 2（本任务范围，D2）**：a) 只做登记与只读调研，实装升级（全局安装 + profile 重建）另行裁定（选定）— b) 本次一并实装升级。
  选 a：用户本次只要求「登记并开工条目、检查新 rc、调研接口变化」；安装宿主与重建 profile 属系统级改动，需单独批准。
- **决策项 3（对照结论落地位置，D3）**：a) 在 `docs/host/` 新建 `HOST-UPGRADE-0.2.2-rc.3.md`，本追踪文档只承载调研过程（选定，时点由决策项 6 定）— b) 只留在追踪文档。
  选 a：`docs/host/` 是宿主面知识的既定位置，且 rc.1 对照文档的「过期条件」已指定由新版接替。
- **决策项 4（`ctx.subagents.start` 退化的处置，D4）**：a) 另开 BACKLOG 条目交后续任务（选定）— b) 并入本任务一起改（需扩大范围并改代码）。
  选 a：属既有缺陷（0.2.1-rc.2 起），与本次升级对照不是同一件事，且改 `/council`、`task-engine` 执行器、`command-template` 三处需要各自验证。
- **决策项 5（master 未发版内容，D5）**：a) 只记事实（608 提交 / 382 包），不逐项对照（选定）— b) 同时对照。
  选 a：未发版内容随时变动，等出 tag 再对照。
- **决策项 6（对照文档何时落地，2026-11-15 用户裁定，D6）**：a) 现在新建 `docs/host/HOST-UPGRADE-0.2.2-rc.3.md`，安装树实测节留作「待升级后补」（选定）— b) 只留追踪文档 — c) 等实装升级后一次性写全。
  选 a：代码面对照已完整，先固化为 `docs/host/` 知识；实测数字依赖安装树，留给升级后补（文档 §12）。
- **决策项 7（是否实装升级，2026-11-15 用户裁定；同日改判，D7）**：a) 立即实装 — b) **先修退化条目再升级（选定，2026-11-15 第二次裁定）** — ~~c) 暂不升级，只保留对照（原选定，已被 b 取代）~~。
  选 b：升级（全局安装 + profile 重建 + 真机验收）以「先接取并修完 `ctx.subagents.start` 退化」为前置，一次真机验收同时覆盖退化修复与版本切换；与决策项 8 不冲突——条目归属仍按 8c 挂 BACKLOG，等排期接取后先修、修完再升。
- **决策项 8（退化条目接取，2026-11-15 用户裁定，D8）**：a) 本会话接取 — b) 交其他 agent — c) 继续挂 BACKLOG 等排期（选定）。
  选 c：条目保留在 `docs/BACKLOG.md` §2，等排期另行接取；按决策项 7 的 b，接取后必须先修完再发起升级。
- **决策项 9（过时口径更正，2026-11-15 用户裁定，D9）**：a) 并入退化条目 — b) 并入升级任务（选定）— c) 另开小条目走快速流程。
  选 b：`engines.node`、`security-guard/README.md` 工具面清单、`profiles/example/cordis.patch.yml:228-229` 账号包名注释三处随升级任务一并改；升级因决策项 7 排到退化修复之后，该项随之推迟，**现已记录、未改**。

## 规划

计划改动文件清单：

- `docs/BACKLOG.md`：新增条目「宿主 0.2.2-rc.3 升级与接口对照」（〔进行中〕）；新增条目「子代理委派改走 `startActivation()`」（交后续任务）。
- `docs/archived/2026-11-15-host-upgrade-0.2.2-rc.3.md`：本追踪文档（撰写时位于 `docs/implementation/`，关闭后归档）。
- `docs/host/HOST-UPGRADE-0.2.2-rc.3.md`：新建对照文档（决策项 6 = a，已写；实测节待升级后补）。
- 关闭时（已随 2026-11-15 关闭完成）：`docs/host/HOST-PACKAGES.md` 加 rc.3 增量注记；BACKLOG 已完成条目移除并在 §1 索引留一行；本追踪文档归档到 `docs/archived/`。

任务拆分：

1. 版本事实确认（已完成）。
2. 接口面增量对照：事件 / 工具 / 服务 / 管线 / 会话 / 投影 / bundle（已完成）。
3. 本仓影响判定 + 无影响面核对（已完成）。
4. 登记新发现的两条后续条目（已完成）。
5. 写 `docs/host/HOST-UPGRADE-0.2.2-rc.3.md`（已完成，决策项 6）。
6. 后续顺序（决策项 7 = b 的约束，不在本任务内执行）：接取 `docs/BACKLOG.md`「子代理委派改走 `startActivation()`」→ 修完三处调用并过 check / build / test 与人工确认 → 再发起 `0.2.2-rc.3` 升级 → 补对照文档 §12 实测与决策项 9 的三处口径。

明确不做（本任务）：不改任何包源码（含 `task-engine` / `command-template` / `TUI`）；不安装 `0.2.2-rc.3`、不重建 `fff` profile、不跑 `pnpm run check / build / test`；不逐项对照 master 的 608 个未发版提交；不改 `docs/STATUS.md`。按决策项 7 = b，安装与 profile 重建归升级任务，且以退化条目修完为前置。

## 实现记录

- 2026-11-15：确认 `~/GithubRepos/deepseek-harness` HEAD = `39163dd30f`（2026-11-13，rc.3 合入 master），tag 最新为 `dsh-v0.2.2-rc.3`；本机安装树版本 `0.2.2-rc.1`；npm dist-tags `latest=0.2.2-rc.1` / `next=0.2.2-rc.3`。
- 2026-11-15：`git rev-list --count` / `git diff --shortstat` 得三区间规模（§2）；`git ls-tree` 得包目录数 372 / 373 / 374 / 382。
- 2026-11-15：事件面用 `git grep -h -oE "^'[a-z0-9-]+/[a-z0-9-]+'\(" <tag> -- 'packages/**/src/**'` 取集合后 `diff`：97 → 108，无删除；rc.2 与 rc.3 事件集合完全相同。
- 2026-11-15：`git diff rc.1 rc.3 -- docs/tool-catalog.md` 得工具增删；`git show rc.3:packages/bundle/base/cordis.patch.yml` 逐行核对 bundle 默认值（`applyPatch: false`、`interrupt: false`、`searchProvider: deepseek-search-api`）。
- 2026-11-15：`git show <tag>:packages/subagent/subagent/src/index.ts | rg -c "^  (async )?start\("` 在 `0.1.5-rc.3` / `0.1.7-rc.2` / `0.2.0-rc.2` 为 1、`0.2.1-rc.2` 起为 0；本机安装的 `dsh-subagent/lib/types/index.d.ts` 只有 `startActivation`。
- 2026-11-15：`git show rc.3:docs/upgrade-guide/...` 读十组指南（`subagent-activations`、`subagent-service-methods`、`subagent-activation-options`、`subagent-names`、`subagent-interrupt-default`、`session-append-overloads`、`plugin-update-method`、`runtime-context-reminders`、`node-24`、`fs-observation-policy-default-off`）核对指南与代码。
- 2026-11-15：本仓侧核对用 `rg` 逐项查 `interrupt_agent` / `apply_patch` / `updatable` / `runtime-context` / `subagents.start` / `system-prompt/assemble` / `SandboxUnsupportedPolicyError` 的引用点。
- 2026-11-15：用户裁定决策项 6 = a、7 = c、8 = c、9 = b；据此新建 `docs/host/HOST-UPGRADE-0.2.2-rc.3.md`（13 节，含 §12「待补」），未动代码、未装宿主。
- 2026-11-15（改判）：用户把决策项 7 从 7c 改为 **7b**（先修退化条目再升级），其余按推荐执行；已在 §决策 原处划掉 7c 并注明被 7b 取代，`docs/BACKLOG.md` 退化条目补「升级前置」注记，`docs/host/HOST-UPGRADE-0.2.2-rc.3.md` §10 #1 同步该前置约束。
- 2026-11-15（收尾）：用户裁定「做完所有任务然后收尾提交」。执行关闭动作——`docs/host/HOST-PACKAGES.md` 增 rc.3 增量注记（源码口径 372 → 374 与接口面要点，行清单仍为 rc.1 安装树，升宿主后重生成）、标题注明源码已到 rc.3；本追踪文档状态改「关闭」并移入 `docs/archived/`；BACKLOG 条目从 §2 移除并在 §1 索引补一行；`format` + `check:docs` 通过后提交关闭提交。

## 偏差

- 未按指南标题逐条复跑，指南只作定位线索：`v0.2.2-rc.1/` 目录下的 19 条指南混有 rc.2 / rc.3 的变更，无法按目录划分版本，故一切结论以 `git diff` / `git show` 的代码事实为准。
- `office_*` 与 `user_terminal_*` 的调用可行性未做真机验证（本机未挂载 `tool-office` / `terminal-panel`，也未装 LibreOffice Kit）——只按 `docs/tool-catalog.md` 与包源码判定「本仓不消费、风险低」。
- `list_agents` 与子代理目录的按名寻址（#4）只核到指南描述与 `projection-types.ts` 的字段面（rc.3 新增可选 `name`，`id` / `label` / `activity` 保留），未核 `namesOf` / `resolveName` 的实际行内容与真机渲染，留给升级任务的真机验收（见 `docs/host/HOST-UPGRADE-0.2.2-rc.3.md` §12 第 3 项）。

## 测试与证据

### 检查与验证

- 本任务为只读调研 + 文档改动，未改代码，因此未跑 `pnpm run check` / `build` / `test`；改动文件为 Markdown，按约定跑 `format` 与 `pnpm run check:docs`：最新一次为 `check:docs 通过: 123 篇现行 Markdown / 1004 个 .ts, 规则 0 项, 错误 0 / 警告 0`（新建对照文档后由 122 升到 123 篇）。
- 核查命令与输出均逐条记在「实现记录」；关键证据路径：`packages/bundle/base/cordis.patch.yml:292-300`（apply_patch / fs-observation-policy）、同上 `:386-390`（interrupt: false）、`packages/session/session-projection/src/index.ts:454-459`（stateOf 弃用未删）、`docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md`（start → startActivation）。

### 审阅记录

- 自审（2026-11-15，无子代理，五个检查点 A-E）：

  - A 一致性：决策项 7 由 7c 改 7b 后，§决策 / §规划 / §实现记录 / §收尾、`docs/BACKLOG.md` 升级前置注记、对照文档 §10 #1 与 §12 均已同步；全文无与 7b 冲突的「暂不升级」表述（仅 §实现记录 保留 7c 的历史条目与改判记录）。
  - B 模板：八节齐全，状态字段单值「调研」。
  - C 事实抽查 4 条，全部与文档一致：`rc.3` base `:386-390` 含 `interrupt: false`；同文件 `:292-300` 含 `fs-observation-policy: disabled: true` 与 `tool-fs: applyPatch: false`；事件集合 rc.1 = 97、rc.3 = 108；`subagent/src/index.ts` 的 `^  start(` 在 `0.2.0-rc.2` = 1，`0.2.1-rc.2` / `0.2.2-rc.1` / `0.2.2-rc.3` = 0。
  - D 术语与符号：禁用旧称 0 命中，无 emoji，符号仅用白名单。
  - E 编号：D1-D9 与决策项 1-9 已加对照行，可用「D7 = 7b」一句话引用。

- 自审问题清单（4 条，均已处理）：

  | # | 问题 | 位置 | 处理 |
  | --- | --- | --- | --- |
  | 1 | 决策项 3 写「关闭时新建」，与决策项 6「现在新建」冲突 | 决策项 3 | 改为「时点由决策项 6 定」（已改） |
  | 2 | §规划缺 7b 的后续顺序，只在 §收尾 出现 | §规划 | 补任务拆分第 6 项，「明确不做」注明升级归属与前置（已改） |
  | 3 | 术语两处：错误码「模块」、正文「过程记录」 | §调研 6、对照文档 §1 / §13 | 改为「错误码文件」「追踪文档」（已改） |
  | 4 | `check:docs` 引用数字过期（122 篇，新建对照文档后为 123 篇） | §测试与证据 | 更新为最新一次输出（已改） |

- 建议项（已采纳）：§决策 增编号对照行，并给 9 个决策项标题各加 D 号，便于跨文档一句话引用。

- 第二轮审阅（2026-11-15，用户要求「再审阅」，仍为自审）：新发现 3 处，均已修正。

  | # | 问题 | 位置 | 处理 |
  | --- | --- | --- | --- |
  | 5 | 事实写反：安装树 rc.1 写成「未落后 `next`」，实际比 `next`（rc.3）落后两个 rc | §调研 1 | 改为「等于 `latest`，比 `next` 的 rc.3 落后两个 rc」（已改） |
  | 6 | #4 的影响判定过宽：写成条目字段「可能从 `id`/`label` 变为带名字」；实测 rc.3 `projection-types.ts` 只是新增可选 `name`，`id` / `label` / `activity` 保留 | §调研 10 #4、§偏差 | 两处均改为精确表述，并同步对照文档 §10 #4（已改） |
  | 7 | §收尾 用「升级推迟」，与 7b 的「排到退化修复之后」口径不一致 | §收尾 | 改为「因升级排到退化修复之后而一并后移」（已改） |

- 第二轮复核：`rc.3` 目录条目字段（`KnownSubagentCatalogFields` 新增 `name?`）、被删账号包名（`@deepseek-ai/dsh-api-account-controller`、`@deepseek-ai/dsh-deepseek-account-platform`，与文中写法一致）均与文档相符。

- 第三轮审阅（2026-11-15，用户要求「重新审阅」，仍为自审）：新发现 3 处，均已修正。

  | # | 问题 | 位置 | 处理 |
  | --- | --- | --- | --- |
  | 8 | 第二轮把 `name` 的范围写窄成「`external` 变体」；实测 rc.3 在 `external` 与 `continuable` 两个变体上都有可选 `name` | §调研 10 #4、对照文档 §10 #4 | 两处改为「`external` / `continuable` 两个变体」（已改） |
  | 9 | `/council` 的代码位置只写 `dsh-panels.ts:645`（那是注释行，`start` 判空在 `:651`） | §调研 10 #1、对照文档 §10 #1、BACKLOG 条目 | 三处统一改为 `:645-652`（已改） |
  | 10 | §调研 1 的「基线仍是 0.2.2-rc.1」与本次已新增 rc.3 对照文档的事实不符 | §调研 1 | 改为「声明基线仍是 rc.1（BACKLOG 头部与 `HOST-PACKAGES.md` 未改），`docs/host/` 已新增 rc.3 对照接替」（已改） |

- 第三轮复核：`KnownSubagentCatalogFields` 三个变体（`one-shot` / `external` / `continuable`）逐条读过——`name?` 仅在 `external` 与 `continuable`；`SubagentCatalogRow` = `id` + `activity` + 该字段集；`task-engine/src/subagent.ts:144` 为 `typeof svc.start !== "function"` 判空；`TUI/src/app/adapter/dsh-panels.ts:645-652` 为 `/council` 注释与 `start` 判空；BACKLOG §6 的账号依据确实写了 `dsh-api-account-controller`。

- 第四轮审阅（2026-11-15，目标轮次 1，仍为自审）：新发现 2 处，均已修正。

  | # | 问题 | 位置 | 处理 |
  | --- | --- | --- | --- |
  | 11 | rc.2 → rc.3 的提交描述不准：写「两个 CI 修复、一个重启状态 / cwd 修复」，实际 6 个提交为发布合并 + release + 实验功能 + `fix(ci)` 及其分支合并 + 重启状态 / cwd 分支合并 | §调研 2、对照文档 §0 | 两处按实际提交逐项列出（含 `38a6a5c965`、`4c1cf20cb1`、`b8c33a1504`、`68f83cc992`、`bbad94f927`、`ac904e118e`）（已改） |
  | 12 | §目标 1 用泛称「宿主新 rc 版本升级与接口对照」，与 BACKLOG 实际条目标题不一致 | §目标 1 | 改为实际标题「宿主 0.2.2-rc.3 升级与接口对照」（已改） |

- 第四轮复核：`docs/upgrade-guide/v0.2.2-rc.1` 目录确为 19 个；`session-persistence-jsonl/src/format.ts` 在 rc.1 → rc.3 无 diff（编码无漂移）；`HOST-PACKAGES.md` 确含 `interrupt_agent` 一处；对照文档 §11 无影响面清单未把受影响的三处（`task-engine` / `security-guard` / `escalation-hint`）误列为无影响。

- 第五轮审阅（2026-11-15，目标轮次 2，仍为自审）：新发现 2 处，均已修正。

  | # | 问题 | 位置 | 处理 |
  | --- | --- | --- | --- |
  | 13 | §偏差 把待核项推给「TUI 侧条目」，但 `TUI/docs/BACKLOG.md` 并无该条目 | §偏差 | 改为「留给升级任务的真机验收（对照文档 §12 第 3 项）」（已改） |
  | 14 | §测试与证据 顺序混乱：证据路径句排在四轮审阅记录之后，与「先验证、再记录审阅」的阅读顺序相反，且与新增内容重复 | §测试与证据 | 拆成「检查与验证 / 审阅记录」两个子节，证据路径句上移（已改） |

- 第五轮复核：`HOST-UPGRADE-0.2.2-rc.3.md` §12 第 3 项确为「真机验收：`interrupt_agent` 缺席后的工具面、`/agents` 面板在按名寻址下的行内容、`/council` 与 `task-engine` 子代理路径」，与 §偏差 的新指向一致。

- 第六轮审阅（2026-11-15，目标轮次 3，仍为自审）：新发现 1 处，已修正。

  | # | 问题 | 位置 | 处理 |
  | --- | --- | --- | --- |
  | 15 | §实现记录 写「读六组指南」，同句却列了 10 条指南名 | §实现记录 | 改为「十组指南」，与所列条数一致（已改） |

- 第六轮复核（收尾检查）：问题编号 1-15 连续无缺；全文无重复段落；禁用旧称仅剩审阅记录里对旧称的引用；`format` 与 `check:docs` 均通过（123 篇，0 错误 0 警告）；八节齐全、状态单值「调研」。

- 第七轮审阅（2026-11-15，目标轮次 4）：**无新问题**，本追踪文档不再需要修改。本轮只做一致性核对——两份文档的关键数字（1568 / 4645 / +160844 / −58399、515 / +10988 / −669、372 / 373 / 374 / 382、608 / 3309 / +104100 / −36870、事件 97 / 108、指南 19 条、`@deprecated` 13）逐项对齐；`docs/BACKLOG.md` 两条条目的标题、状态标记与追踪文档互指一致。

## 收尾

已关闭（2026-11-15，用户裁定「做完所有任务然后收尾提交」）。

关闭动作：

- `docs/BACKLOG.md`：条目「宿主 0.2.2-rc.3 升级与接口对照」标完成并从 §2 移除，§1 已完成索引补一行（含追踪文档与对照文档路径）。
- 本追踪文档：状态改「关闭」，从 `docs/implementation/` 移入 `docs/archived/`。
- `docs/host/HOST-PACKAGES.md`：加 0.2.2-rc.3 增量注记（源码口径 372 → 374、+11 / −9 清单、接口面要点），标题注明源码已到 rc.3；§1 / §2 行清单与计数**仍为 rc.1 安装树实测**，升宿主后按「过期条件」重生成。
- `docs/host/HOST-UPGRADE-0.2.2-rc.3.md`：§12「待补」保留，等升级后补实测数字。

按用户 2026-11-15 裁定：对照文档已新建（决策项 6 = a）；升级顺序定为「先修退化条目、再升级」（7 = b，覆盖原 7c）；退化条目留在 BACKLOG 等排期（8 = c）；过时口径更正随升级任务处理（9 = b，未改，因升级排到退化修复之后而一并后移）。

遗留与后续（均不在本任务内）：

1. 接取 `docs/BACKLOG.md` §2「子代理委派改走 `startActivation()`」，按标准流程另建追踪文档修完三处调用并跑 check / build / test。
2. 修复通过人工确认后，再发起升级（全局安装 `0.2.2-rc.3` + `scripts/install.sh --profile fff --sync` + `--dump-config` 自检），一次真机验收同时覆盖子代理路径与版本切换。
3. 升级后补 `docs/host/HOST-UPGRADE-0.2.2-rc.3.md` §12 的实测数字，并处理决策项 9 的三处过时口径（`engines.node`、`security-guard/README.md` 工具面清单、`profiles/example/cordis.patch.yml:228-229`）。
4. `docs/STATUS.md` 由用户择时更新（流程不改）。
