# 宿主升级对照：0.1.5-rc.3 → 0.1.7-rc.2

> 用途：本项目 13 个包（TUI + 12 个进程内插件）当前跑在 `dsh 0.1.5-rc.3`（npm dist-tag `latest`）。本文对照下一个 rc（npm dist-tag `next`）的**官方接口变更**与**重大更新**，供升级决策、回归测试取材。
> 口径：宿主源码本地克隆 `~/GithubRepos/deepseek-harness`，工作区 checkout = tag `dsh-v0.1.7-rc.2`（提交 `477b4f42`，2026-09-24，下称 NEW）；对照基线 = tag `dsh-v0.1.5-rc.3`（提交 `a4c74a91`，2026-09-22，下称 OLD）。核对时间 2026-09-25。
> 只记**会影响本仓库**的事实，逐条带证据（`文件:行` / commit / 官方 note）。未核实项单列 §7；复现命令见 §6。

## 0. 摘要

**需要改我方代码（3 项）**

| # | 项 | 后果 |
|---|---|---|
| 1 | `jobs`：`list/kill` 的 caller 由 `Agent` 改为 `SessionId` **字符串**；`onJobsChanged`/`onJobDone` 删除，改 `jobs.events.subscribe(filter, listener)` | TUI `/jobs` 面板恒空、cancel 抛错、实时刷新静默失效 |
| 2 | `subagents.listChildren` 返回结构变化（`SubagentListEntry` → `SubagentCatalogEntry`，无 `kind`/`activity`/`hasChildren`） | TUI `/agents` 面板降级为显示 `id`/`label`/`mode`，诊断行消失 |
| 3 | `codeRuntime` → `ptcRuntime`，且 `run(request)` 拆成 `resolve(request) → spec` + `run(spec)`（Node 提供方要求 spec 带 `cwd`/`sandboxPolicy`） | output-compress 静默回落 `node:vm` 沙箱（失去宿主沙箱隔离） |

**需要改配置 / 升级后必须验证（2 项）**

| # | 项 | 说明 |
|---|---|---|
| 4 | 启动失败语义反转：NEW 只把 7 个硬编码 id 视为「必需」，其余条目 `inject` 未满足只打 stderr warning 并继续启动 | 我方 13 个包 id 全不在必需表内 → **可能「起来了但只挂一半」**；建议 CI 断言启动 stderr 无 `did not activate` |
| 5 | `settings.yaml` 文件后端包删除，settings 命名空间改为「profile 插件条目 id」，写入落 profile 的 `cordis.patch.yml`；旧 `settings.yaml` 启动时改名 `.imported` 逐段导入，**无对应条目的段记 warning 后丢弃** | 升级前确认 `~/.dsh/settings.yaml` 里的模型 provider/凭据段能在 profile 条目落位，否则静默丢失 |

**其余结论**

- **装配机制兼容**：`dsh.profile.bundles` 语义与五层 patch 顺序逐字未变；`cordis.patch.yml` 的 `- id:`（覆盖）/ `- insert:`（新增）方言主体零 diff；插件导出形状（`{name, inject, provide, Config, apply}`）与 `ctx.reflect.get(name, strict)` 完全未变（cordis 4.0.2 → 4.0.4，`reflect.ts` 零 diff）。
- **持久化**：Session 格式 v3 → v4，官方附迁移（读旧会话在**内存**转换、写入时在旧文件旁发布 V4 successor，不就地重写）；同时新增「禁止新的同步事件读取」规则（`Session.eventAt/snapshotEvents/ownEvents` 标 `@deprecated`）——我方未使用这三个同步读。
- **preset 机制**：目录式 roster（`agent-presets` 包）删除，改为 profile YAML 的 `agent-preset-registry` + `@deepseek-ai/dsh-agent-preset` 声明行；与本项目「只用 TUI、走 profile 全局组合、不配 preset」口径同向，`AGENT-COMPOSITION.md` 结论继续成立。
- **官方新增能力面**：deliverables（`present` + `workspace-changes`）、browser-use / computer-use、PTC 运行时、SSH provider 家族、plugin-manager / config-editor / HMR、DeepSeek 账号 PKCE、Web 设置页按命名空间拆分 + 右侧栏终端/浏览器。

### 0.1 实施状态（本项目，2026-09-25）

| 项 | 状态 | 说明 |
|---|---|---|
| TUI `jobs` / `/agents`、output-compress PTC 三处改造 | **已完成** | 按 §3.2 落地：能力探测择路，0.1.7 与 ≤0.1.5 都能走通（过渡期双栈） |
| 单测与构建 | **已完成** | `npm run check` 全绿；TUI 1087 用例、output-compress 45 用例（含 3 个新增 PTC 用例）通过；`npm run build` + `npm run demo -- --smoke` 通过 |
| `scripts/install.sh` 与 TUI 文档同步 | **已完成** | 默认版本 → `0.1.7-rc.2`；`TUI/DESIGN.md`、`TUI/IMPLEMENTATION.md`、`TUI/COMMANDS-SPEC.md` 记录新契约 |
| 宿主安装 + profile 依赖同步 + settings 迁移 | **已完成** | `dsh --version` = 0.1.7-rc.2（随包 283 个）；profile 的 `dsh-session-title-all-prompts-llm` → 0.1.7-rc.2 且 `pnpm install` 通过（peer 期望随之变为 `cordis ~4.0.4` / `dsh-* 0.1.7-rc.2`）；首次启动完成 settings 迁移：`settings.yaml` → `.imported`、profile patch 写入 `agent-default-model` / `llm-pi-ai` 段 |
| 组合与启动核对 | **已完成** | `--dump-config` 含 `dsh-base` + 13 个 `@dsh-toolset/*` + `tool-ask-user` + `session-title-all-prompts-llm`；关键服务条目在位：`jobs`、`subagent`、`ptc-runtime`（`@deepseek-ai/dsh-ptc-runtime-node`）、`sandbox-policy`；pty 冒烟 15s：TUI 正常渲染、**无 `did not activate` / `startup failed`** |
| 运行时核对（自动） | **已完成** | 重启后本会话即跑在 rc.2：会话目录同时存在旧 `session.v3.jsonl.zstd` 与新 `session.v4.jsonl.zstd`（V4 writer 另存 successor、不改写前代）且会话可继续追加；插件实测：`code_map index` 建成 265 文件 / 5052 符号索引、`context_report` 正常（读的正是跨 V3→V4 迁移后的会话）、`task_engine` 正常、metric-loop 启动注册日志在位、output-compress 产生新分片（48KB / 37KB，`inline-event-text` 触发） |
| 复核中发现的问题（与升级无关） | **已记录，待修** | `fs_digest` 工具在 0.1.5 与 rc.2 上均报 `cannot get property "cwd" without inject`：`fs-digest/src/main.ts:129` 直接读 `ctx.cwd`，但 `cwd` 不是宿主服务，cordis 代理对未 inject 的属性访问即抛错，`?? process.cwd()` 永远走不到。**既有缺陷**，不在本次升级范围内 |
| 交互验收（`/jobs`、`/agents`） | **已通过** | `/jobs`：起一个后台任务后能列出会话自有任务，`Enter` 取消生效（任务在 ~24s 时被 SIGTERM 终止，远早于其 240s 时长）——旧代码传 `{ id }` 会因 owner 不匹配而面板恒空，故这两步同时验证了 caller 与 `kill` 改造；`/agents`：行内显示 `continuable · inactive`，即富条目的 `mode`/`activity` —— 0.1.7 的 `listChildren` 只给投影目录（无 activity），可见 `listDescendants` 优先分支生效 |
| `HOST-PACKAGES.md` 重刷（240 → 283 个随包分发包口径） | **进行中** | 已采集 283 包 + 91 个挂载清单（`tmp/hostdoc/`），按 §6 复现命令重生成 |

升级实际执行记录（2026-09-25，工作区外操作；profile 里的 `package.json` 是指向 `~/fff/config/dsh/profiles/fff/package.json` 的软链，改的是后者）：

```sh
mkdir -p "$HOME/.dsh-upgrade-backup-<ts>" && cp ~/.dsh/{settings.yaml,profiles/fff/package.json,profiles/fff/cordis.patch.yml} "$HOME/.dsh-upgrade-backup-<ts>/"
npm install -g @deepseek-ai/dsh@0.1.7-rc.2            # 88 added / 88 removed / 432 changed
npm pkg set 'dependencies.@deepseek-ai/dsh-session-title-all-prompts-llm=0.1.7-rc.2'  # 在 profile 目录执行
(cd "$HOME/.dsh/profiles/fff" && pnpm install)        # 通过（`pnpm peers check` 只剩「宿主包未装进 profile」的预期提示）
dsh --profile fff --dump-config                       # 成功；rc.2 会顺带清理 profile 的 node_modules 软链投影
dsh --profile fff                                     # 首次启动：settings.yaml → settings.yaml.imported，profile patch 落 agent-default-model / llm-pi-ai
```

仍待人工的交互验收：`/jobs`（能列当前会话任务 + Enter 取消）、`/agents`（mode/activity 列）、output-compress 启动日志的 `sandbox=ptcRuntime`、旧会话 `/session` 恢复（V3→V4 自动迁移）。

## 1. 版本事实

| 项 | 值 |
|---|---|
| 本项目基线 | 运行 `dsh 0.1.5-rc.3`（npm `latest`，published 2026-09-22T05:55Z）→ 升级目标 `0.1.7-rc.2`；代码层已双栈兼容（见 §0.1） |
| 本文对照版本 | `dsh 0.1.7-rc.2`（npm `next`，published 2026-09-24T14:18Z） |
| npm dist-tags | `latest` = 0.1.5-rc.3；`next` = 0.1.7-rc.2；`alpha` = 0.1.7-alpha.2 |
| 源码 tag 顺序 | 0.1.5-rc.3 → 0.1.6-alpha.1 → 0.1.6-alpha.2 → 0.1.7-alpha.1 → 0.1.7-alpha.2 → 0.1.7-rc.1 → 0.1.7-rc.2 |
| 安装 | `npm i -g @deepseek-ai/dsh@0.1.7-rc.2`（或 `@next`） |

注意：`0.1.6-alpha.1/2` 的提交日期（09-15 / 09-17）早于 `0.1.5-rc.3`（09-22），是并行/回移发布线，不是时序后继；OLD 是 NEW 的祖先（`git merge-base --is-ancestor` 成立），无分叉。

## 2. 区间规模与包清单变更

### 2.1 规模

| 指标 | 值 |
|---|---|
| commits / 文件 | 3647 / 8945（`+1,348,721 / -158,189` 行） |
| 包（`@deepseek-ai/dsh-*`） | 267 → 312（新增 52、删除/改名 10） |
| 顶层分类 | 新增 `browser-use/`、`computer-use/`、`ptc-runtime/`、`ssh/`、`deliverables/`；`code-runtime/`、`e2b/` 消失 |

### 2.2 新增包（52，按分类）

| 分类 | 包 |
|---|---|
| preset | `agent-preset`、`agent-preset-registry` |
| api | `api-account-controller`、`api-job-controller`、`api-terminal-controller` |
| browser-use / computer-use | `browser-use`、`computer-use`（实现均在 experimental） |
| ptc-runtime | `ptc-runtime`（抽象缝 `ctx.ptcRuntime`）、`ptc-runtime-node`（沙箱 Node 进程） |
| deliverables | `workspace-changes`（每轮 git 快照差 + 整文件捕获 → `workspace/changes` 事件） |
| boot | `plugin-manager`、`config-editor`、`hmr` |
| credentials / llm | `deepseek-account`、`deepseek-account-platform`（浏览器 PKCE）、`llm-deepseek-account`、`llm-deepseek-api-key` |
| ssh | `ssh`、`fs-ssh`、`sandbox-ssh`、`subprocess-ssh` |
| session | `session-format-v3-to-v4`（V3 → V4 迁移库） |
| compaction / document / skill | `compaction-image-offload`、`office-to-pdf`、`skill-office`、`tool-workspace-dependencies` |
| mcp / host / util / test | `mcp-resources`、`host-product-telemetry-otel`、`lazy-require`、`util-code-language`、`remote-mock` |
| experimental | browser-use 4 个（playwright-mcp / chrome-devtools-mcp / stagehand-native / runtime）、computer-use 2 个（cua-driver-mcp / native）、`ptc-runtime-python`、`speech-to-text`(+sensevoice)、`api-speech-to-text`、`voice-input-bundle`、`client-ui-voice-input`、`auto-review` |
| client | `client-shortcuts`、`ui-shortcuts`、`ui-plugin-manager`、`ui-sidebar-terminal`、`ui-sidebar-browser`、`ui-settings-account/agent-loop/shell/subagent/web-search` |

### 2.3 删除 / 改名包（10）

| 旧包 | 去向 | 我方影响 |
|---|---|---|
| `agent-presets` | 拆为 `agent-preset` + `agent-preset-registry`（服务名 `agentPresets` 不变） | 无（本项目不配 preset；若 patch 按旧包名挂载需改名） |
| `code-runtime` | → `ptc-runtime`（commit `7c9bb5914c`） | **output-compress 需改** |
| `code-runtime-worker-thread` | → `ptc-runtime-node` | 同上 |
| `experimental-code-runtime-python` | → `experimental-ptc-runtime-python` | 无 |
| `workflow-worker-thread` | → `workflow-ptc` | 无 |
| `e2b` / `fs-e2b` / `subprocess-e2b` | 整体删除（commit `c49db8bc8c`，远程执行改由 SSH provider 家族承接） | 无 |
| `settings-file` | 并入 `settings`（实现由 `SettingsProvider` 换为 `SettingsForms`） | **需改配置**（见 §0-5、§3.6） |
| `experimental-agent-team-web-profile` | 收敛为单一 agent-team bundle | 无 |

顶层迁移：`fs/tool-present` → `deliverables/tool-present`（包名不变）。

## 3. 官方接口变更

### 3.1 服务注册表 diff（`super(<ctx>, '<name>')` 口径，排除测试）

NEW 107 / OLD 88 个服务名。

| 方向 | 服务 |
|---|---|
| 新增（22） | `accountController`、`browserUse`、`computerUse`、`configEditor`、`configForms`、`deepseekAccount`、`hmr`、`jobController`、`mcpResources`、`officeToPdf`、`pluginManager`、`pluginPackages`、`pluginRegistryProbe`、`productTelemetry`、`ptcRuntime`、`schedule`、`shortcuts`、`speechController`、`speechToText`、`ssh`、`terminalController`、`webTerminals` |
| 删除（3） | `codeRuntime`（→ `ptcRuntime`）、`e2b`、`settingsScope`（→ `configForms`，commit `601d6761e4`） |
| 实现换包（名不变） | `agentPresets`（`agent-presets` → `agent-preset-registry`）、`settings`（`SettingsProvider` + `settings-file` → `SettingsForms`） |

我方消费的服务名全部仍在：`tools`、`sessions`、`sessionProjections`、`userQuestions`、`goals`、`agents`、`jobs`、`commands`、`sessionQuery`、`sessionTitle`、`skills`、`subagents`、`slots`（零引用）、`llm`、`approval`、`permissionPresets`、`agentPresets`、`agentDefaultModel`、`settings`、`web`、`workflowEngine`、`agentLoop`。

### 3.2 我方消费面逐项判定

| 服务 / 接口 | 变更 | 判定 | 证据（NEW / OLD） |
|---|---|---|---|
| `tools`：`register(definition)`、`presentAs`、`restrict`、`guard`、`get`、`schemas`、`executionMode`、`execute` | 方法集一致；`ToolDefinition` 仅新增**可选** `projectContent?`（`ToolSchema` 新增可选 `deferLoading?`） | 兼容 | `packages/core/tools/src/index.ts:204-246,974,1063`；OLD `:214,938,1027` |
| `agents`：`create`/`resume`/`get`/`list`/`roots` | 同名同参；`create/resume` 的 options 字段逐项一致（`sessionId`/`meta.cwd`/`agentOptions`/`setup`/`resumeSessionId`/`signal`） | 兼容 | `packages/core/agent/src/index.ts:63,125,391`；OLD `:62,125` |
| `agents.announce(agent, source, signal?)` / `register()` | `announce` 新增必填参数；`register()` 返回 `() => void` → `ReturnType<Context['effect']>` | 兼容（我方未调用） | NEW `:437,537`；OLD `:434,533` |
| `sessions`：`create/prepare/enter/announce/flush/get/list/fork` | 一致，另新增 `registerMessageProjection` | 兼容 | `packages/core/session/src/index.ts:930,942,1227,1235,1255` |
| `Session.eventAt/snapshotEvents/ownEvents` | **新增 `@deprecated`**（禁止新调用；实现仍保留） | 兼容（我方未使用） | note `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`（OLD 无此 note） |
| `sessionProjections`（register/onChanged/stateOf/snapshot/cachedSnapshot/checkpoint/…） | 完全一致（含行号） | 兼容 | `packages/session/session-projection/src/index.ts:253,301,319,338` |
| `userQuestions.ask/answer` | 一致；request 仅新增可选 `callId?` | 兼容 | `packages/interaction/user-questions/src/index.ts:86` |
| `goals`（get/create/edit/pause/resume/complete/block/clear/disarm） | 完全一致（含行号） | 兼容 | `packages/goal/goal/src/index.ts:251-433` |
| `sessionQuery`（listSessions/readSession/readSurface/readTitle/readTitleSnapshots/listEvents/search…/trace…） | 完全一致 | 兼容 | `packages/session-query/session-query/src/index.ts:140-355` |
| `sessionTitle`（get/rename/refresh/register） | 一致 | 兼容 | `packages/session/session-title/src/index.ts:385,401,430,471` |
| `skills` / `commands` / `llm` / `approval` / `web` / `workflowEngine` / `agentLoop` | 方法集一致 | 兼容 | 各包 `src/index.ts` |
| `slots` | 一致（`snapshot` 返回类型改名） | 兼容（我方零引用） | `packages/client/ui-renderer/src/client/registry.ts:425` |
| `permissionPresets` | 删 `selectFor`，新增 `catalog()`/`registerAuto()`；我方用的 `names/current/defaultPreset/resolve/set/optionOf` 仍在 | 兼容 | NEW `:293,307,343,369,384`；OLD `:308,333` |
| `settings` | 删 `register`/`installSection`/`get`，新增 `configure`；我方只用 `describe()` | 兼容 | NEW `:266,302,347`；OLD `:419,461,505,546` |
| **`subagents.listChildren`** | 返回类型 `SubagentListEntry[]`（含 `kind`/`activity`/`hasChildren`/`reason`）→ `SubagentCatalogEntry[]`（`{id, createdAt} & {mode, label?}`）；另删 `remoteExportList` | **破坏（显示降级）** | NEW `packages/subagent/subagent/src/index.ts:244,374`、`projection-types.ts:10-16`；OLD `:228,349,385`、`control-types.ts:33-74` |
| **`jobs`：`list/get/read/kill/wait` 的 `caller`** | `Agent` → **`SessionId` 字符串**；owner 判定由 `job.owner.id !== caller?.id` 改为 `job.owner.id === caller` | **破坏** | NEW `packages/jobs/jobs/src/index.ts:100,110,117,148,160,173`、`jobs-local/src/index.ts:306-309,406-408`；OLD `index.ts:82-176`、`jobs-local/src/index.ts:192-193,356-357` |
| **`jobs.onJobsChanged` / `onJobDone`** | 删除，改为 `jobs.events.subscribe(filter, listener)`（`filter: {owner} \| {owners:'all'\|'scope'}`）；新增 `readAt`/`remove`、`owner`/`progress`/`output` 字段，删除 `ownerSession`/`reported` | **破坏** | NEW `packages/jobs/jobs/src/types.ts:235-253`、`types/view.ts:67-99`；OLD `jobs-local/src/index.ts:143,167`、`types.ts:99-139` |
| **`ctx.reflect.get('codeRuntime')`**（output-compress 可选依赖） | 服务改名 `ptcRuntime`；接口 `run(CodeRunRequest)` → `resolve(PtcRunRequest) → PtcRunSpec` + `run(PtcRunSpec)`；Node 提供方要求 spec 带 `cwd`/`sandboxPolicy`，缺失直接 throw；失败 kind 新增 `output-limit`/`protocol`/`sandbox-unavailable` | **破坏** | NEW `packages/ptc-runtime/ptc-runtime/src/index.ts:114-150`、`ptc-runtime-node/src/index.ts:128-129`、`types.ts:73,101,137`；OLD `packages/code-runtime/code-runtime/src/index.ts:111,119,134` |

**我方调用点（升级时要改的代码）**：`TUI/src/app/adapter/dsh.ts:2342`（`list({id})`）、`:2353`（`kill(id,{id})`）、`:3242-3244`（`onJobsChanged`）、`:2602,2614`（`listChildren` 结果按 `kind`/`activity`/`hasChildren` 取字段）；`output-compress/src/index.ts:82`（反射名）、`src/sandbox.ts:66-84`（`run({program, bindings})`）。测试里写死了 caller 形状：`TUI/tests/adapter.dsh.test.ts:3270-3287`。

### 3.3 事件面

我方订阅/派发的宿主事件名两版都存在：`session/event`、`system-prompt/assemble`、`agent/request`、`agent/status`、`agent/pre-step`、`agent/inbox/inserted`、`agent/assistant-stream`、`tools/pre-execute`。NEW 新增 `tools/change`（注册表变化广播，可选）。载荷级差异未逐字段核对（§7）。

### 3.4 工具注册契约

普通工具注册者**无需改代码**：`ToolDefinition` 由 8 字段变为同 8 字段 + 可选 `projectContent?`；`ctx.tools.register(definition)` 签名逐字相同；`presentAs` 两版都是 `ctx.tools` 的方法而非 `ToolDefinition` 字段；未声明呈现字段两版都降级为 generic 卡。附带变化：`SECTION_ORDERS` 删除 `TOOL_CORDIS` 具名顺序（我方无引用）。

### 3.5 插件作者契约与装配机制

| 机制 | OLD | NEW | 我方影响 | 证据 |
|---|---|---|---|---|
| `dsh.profile.bundles` 语义与层顺序 | bundles 顺序 → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` → telemetry | 五层顺序**逐字相同** | 无 | NEW `packages/boot/app-boot/src/profile-context.ts:65-74` |
| `dsh.bundle.patch` 类型 | **仅 `string`**（传数组 `join()` 抛 TypeError → 整树启动失败） | `string \| string[]`（按序应用） | 无（我方全为 string） | NEW `util/package-manifest/src/types.ts:69-72` + `profile.ts:58-64`；OLD `types.ts:27-30` + `profile.ts:792-797` |
| **`inject` 未满足的启动语义** | 任何非 ACTIVE 条目（含 pending）→ 抛错，**硬失败** | 只有 7 个硬编码 id 是必需（`agent-loop`/`webserver`/`modules`/`connection`/`headless-runner`/`acp`/`sdk-jsonrpc-server`），其余 pending/failed → stderr warning 后继续 | **需验证**：我方 13 个包 id 均不在必需表内 | NEW `packages/boot/app-boot/src/index.ts:745-757`（必需表）、`:925-939`（`auditStartupEntries`）；OLD `:722-755` |
| `Profile.skippedBundles`（commit `0a6de62671`） | 不存在；bundle 失败 = 硬失败 | 跳过失败 bundle + 一行 stderr `skipping profile bundle …`，启动继续 | **需验证**（挂错不再阻塞） | NEW `profile.ts:101-122,663-682`；OLD `:789-798` |
| 兼容性预检（peerDeps） | 无 | NEW 新增 `plugin-compatibility` / `compatibility-preflight`：`@deepseek-ai/dsh*` peer 不满足 → 跳过 bundle 或行级 `disabled: true` | 无（我方 13 包**无 peerDependencies**） | NEW `plugin-compatibility.ts:61-88`、`compatibility-preflight.ts:74-118` |
| `dsh.profile.patchReload` | 存在（`live`/`startup`） | **字段整体删除**，写了静默忽略 | 无（我方未写） | NEW `types.ts:74-78`；OLD `types.ts:33-41` + `profile.ts:782-788` |
| patch 热重载 | CLI 按 `patchReload` 装 watch-only HMR | 移入 `dsh-hmr` 服务（无条件监听）；条目 `hmr` 的 name 由 `@deepseek-ai/cordis-plugin-hmr` → `@deepseek-ai/dsh-hmr` | 无 | NEW `packages/boot/hmr/src/index.ts:206-236`、`bundle/base/cordis.patch.yml:28-29` |
| `cordis.patch.yml` DSL（`- id:` / `- insert:`） | 支持 | **主体零 diff**（仅空补丁快路径由深拷贝改浅拷贝；Include 热重载失败由抛出改为 warning + 保留上棵好树） | 无 | `vendor/include/src/index.ts:57-127`(NEW) vs `:58-128`(OLD) |
| 插件导出形状 / `ctx.reflect.get(name, strict)` | — | cordis 4.0.2 → 4.0.4，`reflect.ts`/`service.ts`/`context.ts`/`registry.ts` **零 diff** | 无 | `vendor/cordis/src/reflect.ts:233-242` |
| CLI：`--profile` | 可重复 | 重复即报错 `select a profile only once` | 无 | NEW `apps/cli/src/args.ts:78-81,167` |
| CLI：`plugin` 子命令位置 | 任意位置 | **仅 `argv[0]==='plugin'`** 才注册（非首参会被当 app 参数静默吞） | 无（我方文档均为首参形式） | NEW `args.ts:186-195`；OLD `:165-177` |
| CLI 其它 | `dsh web` 硬编码别名；无 schema dump | 别名删除（任意 `dsh <name>` = `--profile <name>`）；新增 `--dump-config-schema`；`plugin` 新增 `allow-version`/`revoke-version`/`version-exemptions` | 无 | NEW `args.ts:13,45,168-172`、`apps/cli/src/plugin.ts:12-50` |
| 启动失败诊断 | — | 新增 `StartupError` 写 `$DSH_HOME/logs/startup-*.log` 并 exit 1；pending 文案 `pending (waiting for services: …)` | 无 | NEW `apps/cli/src/startup-diagnostics.ts:30-80` |

### 3.6 配置面：settings.yaml → profile patch（**部署面破坏性**）

| 机制 | OLD | NEW | 证据 |
|---|---|---|---|
| 存储位置 | 全局 `<DSH_HOME>/settings.yaml`（`packages/settings/settings-file`） | 该包**整体删除**；命名空间 = **profile 插件条目 id**，写入落 profile 的 `cordis.patch.yml` | NEW `packages/settings/settings/src/index.ts:223,231,347-350`；OLD `settings-file/src/index.ts:23,57` |
| 旧文件迁移 | — | 启动时 `importLegacyDocument()`：`settings.yaml` 改名 `.imported`，逐段 `update(ns, values)`；**无对应条目的段仅 warning 后丢弃**（`LEGACY_SECTION_ENTRIES` 只映射 `ui-developer-tools`/`ui-onboarding`/`shell`） | NEW `settings/src/index.ts:200-206,241-258` |
| preset 默认值 | 命名空间 `agent-presets.default`（settings 段） | 命名空间改 `agent-preset-registry`（`default` 必填 + `selectedDefault` volatile）；`agent-presets` **不在迁移映射表内** ⇒ 旧段被丢弃 | NEW `preset/agent-preset-registry/src/index.ts:51-56,74` |
| settings 服务方法 | `describe`/`register`/`installSection`/`get`/`update`/… | `describe`/`update`/`replace`/`mutate`/`configure`/`writable`/`documentPath`/`prepareDocument`（删 `register`/`installSection`/`get`） | NEW `:266-367` |

**对本项目**：`scripts/install.sh` 现状提示「模型 provider 与凭据在 `$DSH_HOME/settings.yaml`（本脚本不动该文件）」。升级到 rc.2 后该文件退化为一次性导入源，且**内容必须能落到同名 profile 条目**才不丢；provider 相关条目 id 与落位方式需实测确认（§7）。

### 3.7 会话持久化格式 V3 → V4

- **版本常量**：`SESSION_FORMAT_VERSION` 由 `3`（OLD `packages/core/session/src/types.ts:88`）改为 `4`（NEW 同文件 `:89`）。
- **新增/变更**（官方 `docs/persistence-changes/2026-09-16-session-format-v4.md`）：一等 tool-role 结果消息（`toolCallId`/`isError`）、producer-owned 消息来源（`tools-ptc` → `ptc-mode`）、`turn/end.reason` 新增 `forked`、developer-role 会话变更（带 `headerSeq`）与延迟加载 schema 标记；`request/header.system` 记为 `system?: never`（禁止）。
- **兼容路径**：迁移库 `packages/session/session-format-v3-to-v4/src/migration.ts:15-27`；**read open 只在内存 prepare（不写盘），write open 才在旧文件旁发布 V4 successor（不改写 predecessor）**，v0–v2 逐边链式升级；比当前代更新的格式被旧读者拒绝。
- **我方影响**：TUI 读会话走宿主服务（`sessionQuery.readSurface/readSession`、`sessions.get`），不解析 JSONL → 无影响。唯一残余风险：`TUI/src/app/adapter/session-ui-state.ts:15` 注释仍写 `session.v3.jsonl.zstd`（注释口径，非逻辑），且外部脚本若硬编码该文件名会失效。

## 4. 官方重大更新

| # | 更新 | 一句话说明 | 证据 |
|---|---|---|---|
| 1 | **preset 声明式化** | 目录 roster → profile YAML 声明（`agent-preset-registry` 持运行时 revision，编辑落当前 profile 用户 patch）；旧目录机制连同包删除 | commit `d1e22a7e24`；note `.agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.md` |
| 2 | **deliverables 一等化** | `present` 工具声明交付文件（记录路径不拷贝内容）+ 新 `workspace-changes`（每轮 git 快照差 → `workspace/changes` 事件 → 客户端变更卡片） | commit `f800ea46e5`；`docs/persistence-changes/2026-09-14-workspace-changes-event.md` |
| 3 | **浏览器 / 计算机使用** | `browser-use`（provider 走 Playwright/Chrome DevTools/Stagehand 实验包，跨 turn 保持状态）+ `computer-use`（Cua Driver MCP/native）；Web 新增右侧栏浏览器/终端标签 | `e1612c2fdc`、`af4ad05845`、`e15a9b1bec`；`docs/subsystems/{browser-use,computer-use}.md` |
| 4 | **沙箱 / PTC 运行时 + SSH 家族** | `code-runtime` 词汇全面退役（`ctx.ptcRuntime` + 沙箱 Node 进程）；E2B 三 provider 整体删除，远程执行由 `ssh` 家族承接 | `7c9bb5914c`、`c49db8bc8c`、`4fb0fdac68`；note `.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.md` |
| 5 | **宿主运维面** | `plugin-manager`（CLI/Web/agent 共同管理当前 profile 的插件与 bundle）、`config-editor`、`hmr`、DeepSeek 账号 PKCE 登录、三个 Remote controller（account/job/terminal） | `98b92b683c`、`d06e6b5519`、`048297321a` |
| 6 | **客户端 / Web 面** | `packages/client/` 56 → 66 包：设置页按命名空间拆成插件 + 快捷键体系 + 右侧栏插件化 | `efdf8e5b6d`、`98b92b683c` |
| 7 | **持久化与多模态** | Session V3→V4 + 图片卸载（超预算图片换占位并重试）+ Office→PDF 链 + 语音输入（本地 SenseVoice）+ 实验性 auto-review（逐工具 LLM 授权审查） | `669b724a78`、`docs/persistence-changes/2026-09-14-image-offload.md`、`55e53907ab` |

## 5. 对本项目的影响与行动清单

| 对象 | 影响 | 升级前需做 |
|---|---|---|
| `TUI` | `/jobs` 面板恒空 + cancel 抛错 + 实时刷新失效；`/agents` 面板字段降级；其余服务与命令不受影响 | ① `jobs.list/kill` 的 caller 改传会话 id 字符串，同步改 `TUI/tests/adapter.dsh.test.ts:3270-3287`；② 订阅改 `jobs.events.subscribe({owner: sessionId}, …)`（或退回轮询）；③ `/agents` 按 `SubagentCatalogEntry` 取字段并去掉诊断行逻辑 |
| `output-compress` | 反射取不到 `codeRuntime` → 静默回落 `node:vm`（无宿主沙箱隔离） | 反射名改 `ptcRuntime`（保留 `codeRuntime` 回退）；调用改 `resolve({program, bindings, cwd?, timeoutMs?}) → run(spec)`；`error.kind` 容错更多取值（`message` 拼接不变）。改动点：`src/index.ts:82`、`src/sandbox.ts:66-84` |
| `context-report` | 无（`sessionProjections.register/stateOf`、`sessions.get` 均不变） | 无 |
| `goal-contract` | 无（`userQuestions.ask`、`goals.*` 不变） | 无 |
| `herdr-integration` | 无（`agents` 不变） | 无 |
| 其余 9 包 | 无（仅 `tools.register`，`ToolDefinition` 只新增可选字段） | 无 |
| 部署 / profile | `settings.yaml` 不再作为配置后端（§3.6）；启动失败语义变化（§3.5） | ① 核对 `~/.dsh/settings.yaml` 的 provider/凭据段能否落到同名 profile 条目；② 升级后跑一次 `--dump-config` 并断言启动 stderr 无 `did not activate`；③ `scripts/install.sh` 的 `dsh_version_default` 与「凭据在 settings.yaml」提示需同步 |
| 文档 | `docs/HOST-PACKAGES.md` 绑定 0.1.5-rc.3（240 包挂载口径） | 升级时按 312 包重刷 |

## 6. 复现命令

```sh
cd ~/GithubRepos/deepseek-harness   # master = dsh-v0.1.7-rc.2

# 版本事实
git describe --tags master ; git log -1 --format=%cd dsh-v0.1.7-rc.2
git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git | tail -5

# 包清单增删
comm -13 <(git ls-tree -r --name-only dsh-v0.1.5-rc.3 -- packages | grep 'package.json$' | sort) \
         <(git ls-tree -r --name-only HEAD -- packages | grep 'package.json$' | sort)

# 服务注册表 diff（各版本 super() 首参写法可能不同，故用宽松正则）
comm -13 <(git grep -h -o -E "super\([A-Za-z_][A-Za-z0-9_]*, *'[a-zA-Z][A-Za-z0-9]*'" dsh-v0.1.5-rc.3 -- 'packages/**/*.ts' | sed -E "s/.*'([a-zA-Z][A-Za-z0-9]*)'/\1/" | sort -u) \
         <(grep -rhoE "super\([A-Za-z_][A-Za-z0-9_]*,[[:space:]]*'[a-zA-Z][A-Za-z0-9]*'" --include=*.ts packages | sed -E "s/.*'([a-zA-Z][A-Za-z0-9]*)'/\1/" | sort -u)

# 单服务方法集对比（示例：jobs）
git show dsh-v0.1.5-rc.3:packages/jobs/jobs/src/index.ts | grep -nE "^  (abstract )?(async )?[a-z]"
grep -nE "^  (abstract )?(async )?[a-z]" packages/jobs/jobs/src/index.ts

# 启动必需条目表 / settings 迁移行为
sed -n '745,757p;925,945p' packages/boot/app-boot/src/index.ts
sed -n '200,206p;241,258p' packages/settings/settings/src/index.ts
```

## 7. 未确认项

1. **provider/凭据段在 rc.2 的落位**：`settings.yaml` 逐段导入依赖「同名 profile 条目」；本项目 provider/凭据字段的实际条目 id 与导入结果未实测（§3.6）。
1. **`jobs.events.subscribe` 的事件负载字段**：只确认接口与语义（owner 过滤 + 提交后同步派发），未比对载荷结构。
1. **事件载荷级差异**：`agent/status`、`agent/request`、`tools/pre-execute`、`session/event` 等事件名两版都在，但载荷字段未逐项核对。
1. **`ptcRuntime` Node 提供方的运行时约束**：已知 `resolve` 出的 spec 需带 `cwd`/`sandboxPolicy`，但沙箱策略的具体取值与失败行为（`sandbox-unavailable`）未实测。
1. **resume 链路触发 write open 的具体函数**：确认「read 不写盘、write 才发布 successor」，但 resume 内部哪一步触发 write open 未追踪。
1. **客户端第二处 `jobs` 注册**：NEW `packages/api/job-controller/src/client/service.ts:108` 也注册 `jobs`（Remote 流式形状）；我方 TUI 是宿主侧插件，判断不受影响，但若被加载进浏览器客户端组合会撞形状（未实测）。
1. **experimental 包对外可见性**：区间内官方多次调整实验包的发布策略，最终可安装集合未确认。
1. **性能基线**：区间 +135 万行、包数 +17%，对构建与 profile 装配耗时的影响未测量。
