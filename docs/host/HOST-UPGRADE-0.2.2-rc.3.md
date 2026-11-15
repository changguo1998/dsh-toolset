# HOST-UPGRADE: 0.2.2-rc.1 → 0.2.2-rc.3 对照记录

> 职责: 记录 `dsh-v0.2.2-rc.1 → dsh-v0.2.2-rc.3` 的接口面增量与本仓影响判定
> 不负责: 包清单全量 (见 `HOST-PACKAGES.md`)、ctx 接口逐条研读 (见 `DSH-CTX-API.md`)
> 过期条件: 出现下一版宿主 (0.2.2-rc.4 及以后、或 0.2.3 线 tag) 时由新对照文档接替; `HOST-PACKAGES.md` 与 §12「待补」在实装升级后刷新

## 0. 版本与来源

- 对比源: 官方 clone `~/GithubRepos/deepseek-harness`, tag `dsh-v0.2.2-rc.1..dsh-v0.2.2-rc.3`。核对时间 2026-11-15。
- tag 与提交: `dsh-v0.2.2-rc.1` = `66491b05e3` (2026-11-04)、`dsh-v0.2.2-rc.2` = `ddac96760b` (2026-11-11)、`dsh-v0.2.2-rc.3` = `38a6a5c965` (2026-11-13)。**无 `dsh-v0.2.3*` tag**。
- 发布通道: npm `@deepseek-ai/dsh` 的 dist-tags 为 `latest = 0.2.2-rc.1`、`next = 0.2.2-rc.3`、`alpha = 0.2.2-alpha.3`。即 rc.2 / rc.3 已发布但只走 `next`, `latest` 未提升。
- 本机状态: 安装树 `@deepseek-ai/dsh` 版本 `0.2.2-rc.3`（**2026-11-16 实装升级**: 用户执行 install.sh；安装树 337 / `dsh-*` 326、`dsh-base` rc.3，实测见 §12）。
- 增量分布: rc.1 → rc.2 = 1568 提交 / 4645 文件 (+160844 −58399); rc.2 → rc.3 = 6 提交 / 515 文件 (+10988 −669)。接口面增量实质发生在 **rc.1 → rc.2**, rc.3 只多一个实验包与若干 CI / 修复。
- rc.2 → rc.3 的 6 个提交: 发布合并 `38a6a5c965`、`release(dsh): 0.2.2-rc.3` (`4c1cf20cb1`)、实验包「导入 DeepSeek 官网对话导出为会话」(`b8c33a1504`)、`fix(ci)` 缓存修复 (`68f83cc992`) 及其分支合并 (`bbad94f927`)、重启状态 / cwd 分支合并 (`ac904e118e`)。
- clone 的 `master` HEAD = `39163dd30f` (rc.3 合入 master): `rc.3..master` 另有 608 个未发版提交 (382 个包目录), 属 0.2.3 线开发, 本文不对照。
- 升级指南: **未新增 `v0.2.2-rc.2` / `v0.2.2-rc.3` 目录**; 最新的 `v0.2.2-rc.1/` 目录下 19 条指南回填了 rc.2 / rc.3 的变更 (`subagent-interrupt-default`、`runtime-context-reminders`、`session-append-overloads`、`plugin-update-method` 等)。本文以代码为准, 指南只作定位线索。

## 1. 增量总览 (按面)

| 面 | 变更 | 影响本仓 |
| --- | --- | --- |
| 包 | +11 / −9, 372 → 374; Agent Teams 由 `experimental/*` 毕业为 `team/*`; `office-to-pdf` → `office-kit` + `tool-office`; 账号平台包去 `-platform` 后缀; Exa / Perplexity 搜索包移除 | 无 (本仓不 import 这些包) |
| 事件 | +11 个, **无删除** (97 → 108) | 无 (本仓无监听) |
| 工具面 | 新增 `wait_agent`、`office_convert` / `office_recalculate` / `office_render`、`user_terminal_list` / `user_terminal_read`; Agent Teams 工具 9 → 4 (只留任务板); **base 出厂关闭 `interrupt_agent`** | 文档口径过期 (见 §5 / §10) |
| 工具管线 | 新增 `ToolContextUnavailableError` 与错误码文件 `src/error-codes.ts`; `ToolGuard` 可返回 `ToolGuardDenial { reason, info? }`; `PostToolDecision.block` 新增 `info`; 取消归为 `ABORTED` | 向后兼容, 零改动 |
| 会话 | `Session.append` 增数组重载; `SurfaceManager.prepareBatch`; 存储会话写入门禁 (0.2.1-rc.2 起) | 无 (本仓不替换 `append`) |
| 投影 | `stateOf(session, key)` 仍弃用未删除; 注册返回 `handle.stateOf(session)` | 既有弃用项不变 (见 §10 #5) |
| 子代理 | 再删 `waitForChildren` / `listChildren` / `drainChildren` / `interruptByParent` / `list`; 新增 `rootOf` / `namesOf` / `resolveName` / `interruptByUser` / `waitForTreeWork`; 控制工具改按名寻址 | **既有退化** (见 §8 / §10 #1) |
| bundle 默认值 | base 加 `agent-team` / `tool-agent-team` 两行; `tool-subagent-control` 加 `interrupt: false`; web 搜索默认改 `deepseek-search-api`; `deepseek-account` 行换包名 | 见 §7 |
| 运行时要求 | Node ≥ 24.9 (`node-24` 指南, 0.2.1-rc.2 起) | 根 `engines` 声明过时 (见 §10 #8) |
| 客户端 / web | 账号通知、上下文菜单、窗口 drag region、终端侧边栏等客户端面变更 | 无 (TUI 走自有渲染层) |

## 2. 包增删

新增 11 个: `client/ui-account-notifications`、`client/ui-agent-team`、`document/office-kit`、`document/tool-office`、`experimental/deepseek-chat-import`、`experimental/terminal-panel`、`mcp/mcp-manager`、`team/agent-team`、`team/tool-agent-team`、`util/error`、`util/ripgrep`。

移除 9 个: `api/account-controller`、`credentials/deepseek-account-platform`、`document/office-to-pdf`、`experimental/agent-team`、`experimental/agent-team-profile`、`experimental/client-ui-agent-team`、`experimental/tool-agent-team`、`web/web-search-exa`、`web/web-search-perplexity`。

- 包目录数: rc.1 = 372、rc.2 = 373、rc.3 = 374 (rc.2 → rc.3 只加 `experimental/deepseek-chat-import`)。
- 编码漂移: 本仓 `session-paths` 复刻的 `encodeSegment` / `projectKey` / `projectDir` / `sessionDir` 在 rc.2 / rc.3 无 diff, 无漂移。
- `util/error` 与 `util/ripgrep` 是新的共享工具包; `util/ripgrep` 供 `tool-fs-search` 打包二进制 (本仓 `grep` / `glob` 走宿主工具, 已核实 0.2.2-rc.1 起如此, 无变化)。

## 3. 事件面 (+11 / −0)

统计口径: `packages/**/src/**` 内 `'<域>/<名>'(` 声明形态, rc.1 = 97, rc.3 = 108。rc.2 与 rc.3 的事件集合完全相同。

新增:

- `account-ui/change`、`account-ui/refresh`
- `mcp-manager/status`
- `web/providers-changed`
- `working-directory/access`
- `workspace/archive-followup-failed`、`workspace/archive-followup-settled`、`workspace/archive-notice`、`workspace/session-archived`、`workspace/session-unarchiving`
- `worktree/cleanup`

载荷变化: `subagent/start` / `subagent/end` 的 `info` 增加 `parentSessionId` (直接创建者); 作用域分发载体由「委派父会话」改为「子代理树根」, 根作用域的监听者现在能看到整棵树的激活。本仓无这两个事件的监听者。

## 4. 工具面

- `tool-subagent-control` 新增 `wait_agent` (等待调用方收件箱来消息); 该行同时新增配置 `interrupt: false` (见 §7)。
- `tool-office` 新增 3 个工具: `office_convert` / `office_recalculate` / `office_render`。它们由 Office 技能激活后上架, 写入自管的 Office 输出暂存目录 (参数只给输入路径与目标格式, 不给输出路径)。
- `experimental/terminal-panel` 新增 `user_terminal_list` / `user_terminal_read` (只读用户侧终端; `readUserTerminals: false` 可移除)。
- Agent Teams: `tool-agent-team` 只保留 4 个任务板工具 (`team_task_create` / `get` / `list` / `update`); `spawn_teammate` 与团队专用的 `interrupt_agent` / `list_agents` / `send_message` / `wait_agent` 改为复用标准子代理控制工具。
- `apply_patch`: rc.3 的 `dsh-base` 与 Web `standard` preset 代码仍是 `applyPatch: false` (`packages/bundle/base/cordis.patch.yml:296-300`、`packages/bundle/web-app/presets/standard.patch.yml:27-31`); 而官方 `docs/tool-catalog.md` 与 alpha.2 指南称「base 与 standard 已获得 `apply_patch`」。**文档与代码第二次不一致, 以代码为准** (与 `HOST-UPGRADE-0.2.2-rc.1.md` §6 / §12 裁定一致: 不启用)。

## 5. 工具管线 (`@deepseek-ai/dsh-tools`)

- 新增 `src/error-codes.ts`: `APPROVAL_ERROR_NAME`、`APPROVAL_REJECTED` / `APPROVAL_CANCELLED` / `APPROVAL_UNAVAILABLE`、`TOOL_CONTEXT_UNAVAILABLE`。
- 新增 `ToolContextUnavailableError` (工具体内缺上下文时抛, 不由模型改参数修正)。
- `ToolGuard` 返回值放宽为 `string | ToolGuardDenial | undefined`; `ToolsService.checkGuards` 返回 `ToolGuardDenial` (内层字符串自动包成 `{ reason }`)。
- `PostToolDecision` 的 `block` 分支新增可选 `info?: ToolErrorInfo`, 落进 `ToolExecutionResult.error.info`; 审批拒绝路径开始带 `ApprovalError` 身份。
- 取消归类: 体内抛出的中止原因或无名 `AbortError` (无 `HarnessError` 身份) 归为 `AbortError` + `TOOL_ABORTED`; 其余错误保持原样。
- `register()` / `restrict()` / `tools/pre-execute` 载荷语义未变 (`ToolRuntime` 别名仍在)。

## 6. 会话、存储与投影

- `Session.append` 新增数组重载 (`append(inputs: readonly SessionEventInput[])`), 单事件调用照旧; `SurfaceManager` 新增 `prepareBatch(events)` 批量校验与提交。只影响包装 / 替换 `append` 的代码与测试替身 (指南 `session-append-overloads`)。
- 存储会话写入门禁 (0.2.1-rc.2 起, 本次未变): `session/created` 播报完成前与移除后拒绝追加。
- 投影: `sessionProjections.stateOf(session, key)` 仍是弃用未删除 (`packages/session/session-projection/src/index.ts:454-459`, 调用打运行时告警); 正规读法是注册返回的 `handle.stateOf(session)` 或领域服务。全仓 `@deprecated` 计数 rc.1 = rc.3 = 13, **无新增弃用**。
- runtime-context 记录 (指南 `runtime-context-reminders`): 新 `source.kind: 'runtime-context'` 记录正文包在 `<system-reminder>` 里; 清空标记带 `form: 'snapshot'` 且 `sections: []`; 旧记录在下次受理请求时刷新一次, 不改写既有请求前缀。按字面匹配正文的消费者须改按 `source.kind` / `source.sections`。

## 7. bundle 默认值 (`dsh-base` / presets)

rc.1 → rc.3 的 `packages/bundle/base/cordis.patch.yml` 实际 diff 只有 4 处:

1. `deepseek-account` 行的包名 `@deepseek-ai/dsh-deepseek-account-platform` → `@deepseek-ai/dsh-deepseek-account` (**行 id 不变**)。
2. 新增 `agent-team` (`config.maxTasks: 256`) 与 `tool-agent-team` 两行。
3. `tool-subagent-control` 行新增 `config.interrupt: false` — 模型侧不再收到 `interrupt_agent` (含 Team 模式); 消息、发现、收件箱等待与 `ctx.subagents` 的中断服务面全部保留; 插件自身缺省仍是 `true`, 独立组合不写该配置时仍启用。
4. `web` 行 `searchProvider: deepseek-official` → `deepseek-search-api`; `web-deepseek-api` 行删除 `config.apiKeyEnv`, 凭据改为跟随会话路由 (账号路由发账号 token, 否则用 DeepSeek API key 路由的 key)。

未变: `fs-observation-policy` 仍 `disabled: true`; `tool-fs` 仍 `applyPatch: false`; `tool-fs-search` 的 `sampleOverCapGlobResults: false` 仍保留。

## 8. 子代理服务 (本仓关键面)

`ctx.subagents` 方法面 rc.1 → rc.3:

- 移除: `waitForChildren(parent)`、`listChildren(parentSessionId)`、`drainChildren(parent, ids)`、`interruptByParent(child, parent, 'continuable')`、`list()` (provider 名枚举)。
- 新增: `rootOf(agent)`、`namesOf(agent)`、`resolveName(caller, name, signal)`、`interruptByUser(childSessionId)`、`waitForTreeWork(root)`。
- 保留: `startActivation(spec)`、`sendMessage`、`interrupt(targetSessionId, authority)`、`interruptById` 语义的 `interruptByUser`、`drainDescendants(parents)`、`listDescendants(rootSessionId, signal?)`、`prompt`、`registerProvider` / `getProvider`。
- **`start()` / `startContinuable()` 更早就不存在了**: `git show <tag>:packages/subagent/subagent/src/index.ts | rg -c "^  start\("` 在 `0.1.5-rc.3` / `0.1.7-rc.2` / `0.2.0-rc.2` 为 1, `0.2.1-rc.2` 起为 0; 指南 `v0.2.1-alpha.1/subagent-activations` 明写改用 `startActivation()` 并把任务选项平铺 (指南 `v0.2.1-rc.2/subagent-activation-options` 注明嵌套 `request` 字段已删)。本机安装的 `0.2.2-rc.1` 类型声明只有 `startActivation` 两个重载。
- 命名: 指南 `v0.2.2-alpha.3/subagent-names` 说明控制工具与 Team 任务工具**按名寻址**, `list_agents` 行结构变化, 子代理目录载荷版本升到 3; 新增 `ROOT_AGENT_NAME` 与 `SubagentMemberNames` 导出。
- 直接子代目录的替代读法 (指南 `v0.2.1-rc.2/subagent-service-methods`): `ctx.sessionQuery.observeSession(parentSessionId, { signal })` + `observation.projections?.values.subagentCatalog`; 递归发现继续用 `listDescendants()`。

## 9. 官方指南与代码不一致项

| 项 | 指南 / 文档说法 | rc.3 代码 | 取谁 |
| --- | --- | --- | --- |
| `apply_patch` 出厂默认 | `docs/tool-catalog.md` 与 `fs-observation-policy-default-off` 指南称 base 与 Web standard 已启用 | base 与 standard 均 `applyPatch: false` | 代码 (不启用) |
| 升级指南目录 | 无 `v0.2.2-rc.2` / `v0.2.2-rc.3` 目录 | 变更记录在 `v0.2.2-rc.1/` 下的回填指南里 | 代码 + 指南作线索 |

## 10. 本仓影响清单 (按处理优先级)

| # | 项 | 位置 | 性质 |
| --- | --- | --- | --- |
| 1 | `ctx.subagents.start(name, request)` 已不存在 (0.2.1-rc.2 起), 本仓仍按旧面调用 | `task-engine/src/host.ts:13`、`task-engine/src/subagent.ts:144,230`、`command-template/src/subagent.ts`、`TUI/src/app/adapter/dsh-panels.ts:645-652` | **既有退化**, 非本次引入; 已登记 BACKLOG「子代理委派改走 `startActivation()`」, 并按 2026-11-15 裁定成为**升级前置** (先修完再升级) |
| 2 | `interrupt_agent` 出厂关闭 | `security-guard/README.md`、`docs/host/HOST-PACKAGES.md` | 文档口径过期; TUI `/agents` 打断走 `subagents.interrupt` 服务面, 不受影响 |
| 3 | 新工具 `wait_agent` / `office_*` / `user_terminal_*` 未登记 | `security-guard/src/tool-registry.ts`、`escalation-hint/src/index.ts` | 覆盖缺口, 风险低 (`office_*` 只写自管暂存目录) |
| 4 | `list_agents` 与子代理目录按名寻址 (目录条目在 `external` / `continuable` 变体上新增可选 `name`, `id` / `label` / `activity` 保留) | `TUI/src/app/adapter/dsh-panels.ts:238-260` | 待核真机行内容 (见 §12) |
| 5 | 投影 `stateOf(session, key)` 弃用 | `task-engine` / `context-report` / `rule-engine` | 无变化, 延后迁移 |
| 6 | `apply_patch` 文档与代码不一致 | 本文 §4 / §9 | 结论不变: 不启用; 三处写面清单已含它 |
| 7 | 账号两包移除、`deepseek-account` 换包名、`account-ui/*` 事件新增 | `docs/BACKLOG.md` §6 挂起条目、`profiles/example/cordis.patch.yml:228-229` 注释 | 挂起条目的依据与恢复路径需复核; profile 只用行 id, **不需改** |
| 8 | 宿主要求 Node ≥ 24.9 | 根 `package.json:26-28` (`>=22.19.0`) | 声明过时; 本机 v24.16.0 满足 |
| 9 | 工具管线新增 `info` / `ABORTED` 归类 | `security-guard`、`tool-surface`、各 `post-execute` 消费者 | 向后兼容, 零改动; 可选增量: 拒绝回执带 `info.code` |

## 11. 无影响面 (逐项已核)

`herdr-use` / `herdr-integration` / `coagent` / `session-channel` / `session-paths` / `memory-base` / `pin-note` / `flow-track` / `plan-mode` / `flow-arbiter` / `term-check` / `md-table-check` / `symbol-normalizer` / `clock-base` / `shell-parse` / `preference-analysis` / `output-compress` / `fs-digest` / `md-map` / `md-logic` / `code-map` / `ast-tools` / `hash-edit` / `goal-contract` / `metric-loop` / `agent-group` / `background-daemon` / `script-interpreter` / `tool-consult` / `tool-surface` / `behavior-correction` / `auto-approve` / `cache-hit-monitor`: 不消费本次变更的接口面。

另: `BundleInfo.updatable` → `update`、新服务 `mcpManager` / `officeKit` / `terminalController` / `accountUi`、`Session.append` 数组重载、runtime-context 框架化 — 本仓均无引用点。

## 12. 安装树实测（2026-11-16 实装升级后补）

> 前置（2026-11-15 裁定）：升级以 BACKLOG「子代理委派改走 `startActivation()`」修完为前提。2026-11-16 该退化条目已修并通过 check / build / test，用户执行 `scripts/install.sh` 实装 `0.2.2-rc.3` 后本节补写。

1. 安装树数字（2026-11-16 实测）：
   - 全局 `dsh --version` = `0.2.2-rc.3`。
   - 安装树 `@deepseek-ai/dsh/node_modules/@deepseek-ai` 下 **337** 个包（其中 `dsh-*` **326** 个；rc.1 为 330 / 319，净 +7）。
   - `dsh-base` 版本 = `0.2.2-rc.3`。
   - fff profile `dsh.profile.bundles` = **42** 个（dsh-base + 41 个 `@dsh-toolset/*`）。
   - `dsh --profile fff --dump-config`：**883** 行、**152** 个顶层 `- id:` 行，其中官方（`@deepseek-ai/*`）**110** 条、本仓（`@dsh-toolset/*`）**42** 条 → 无条件 `disabled: true` **8** 条（tool-plugin-manager / session-title-llm / deepseek-account / fs-observation-policy / plan-mode / tool-executor-ptc / llm-deepseek-account / session-title-all-prompts-llm，全为官方行）、条件式 `disabled: !!js` 8 条 → 官方活跃项 **102** 条（rc.1 为 101）。
   - 首行 `patch: entry "ponytail" not found`（fff profile 的 `cordis.patch.yml` 仍带指向已移除 `ponytail` 的 patch 条目；install.sh 按设计保留已有 patch 文件未覆盖，属陈旧配置告警，不致命）。
2. 类型面：根依赖与 `tool-surface` 已抬到 `0.2.2-rc.3` 并重生成锁文件，物化后 `pnpm run check` 通过（**41 包全绿**，含 tool-surface 对 `dsh-tools@0.2.2-rc.3` 的类型核验）。
3. 真机验收（2026-11-16，升级后一次覆盖）：`/council` 与 `task-engine` 子代理路径（影响 #1）走 `startActivation(provider='spawn')`；`interrupt_agent` 出厂关闭后的工具面（影响 #2）；`/agents` 面板按名寻址（影响 #4）。**待补**：用户真机确认与本档状态行。
4. `HOST-PACKAGES.md` 已刷新 rc.3 口径（2026-11-16）：头部/版本口径/§1 计数按 337/326 与本次 dump 更新，官方活跃 102；§2 行清单按 rc.3 安装树增补（见该文件「rc.3」注记）。

## 13. 依据

- `git -C ~/GithubRepos/deepseek-harness log -1 --format='%H %ad' <tag>` 取 tag 提交与日期; `git rev-list --count` 与 `git diff --shortstat` 取三区间规模。
- `git ls-tree -r --name-only <tag> | awk '/^packages\/[^\/]+\/[^\/]+\/package.json$/'` 取包目录集合后 `comm` 得增删 (372 / 373 / 374 / 382)。
- 事件面: `git grep -h -oE "^'[a-z0-9-]+/[a-z0-9-]+'\(" <tag> -- 'packages/**/src/**'` 取集合后 `diff` (97 → 108, 无删除)。
- 工具面: `git diff <rc.1> <rc.3> -- docs/tool-catalog.md`; `git show <rc.3>:packages/bundle/base/cordis.patch.yml` 逐行核对默认值。
- 工具管线: `git diff <rc.1> <rc.3> -- packages/core/tools/src/{contracts,index,error-codes,pipeline}.ts`。
- 会话 / 投影: 同法 diff `packages/core/session/src/{index,types,surface}.ts`、`packages/session/session-projection/src/index.ts`。
- 子代理: `git show <tag>:packages/subagent/subagent/src/index.ts | rg -c "^  start\("` 跨 6 个 tag 对照; 本机 `dsh-subagent/lib/types/index.d.ts` 实读。
- 指南: `git show <rc.3>:docs/upgrade-guide/<版本>/<条目>/guide.md` 读 `subagent-activations`、`subagent-service-methods`、`subagent-activation-options`、`subagent-names`、`subagent-interrupt-default`、`session-append-overloads`、`plugin-update-method`、`runtime-context-reminders`、`node-24`、`fs-observation-policy-default-off`。
- 追踪文档: `docs/archived/2026-11-15-host-upgrade-0.2.2-rc.3.md` (关闭后归档)。
