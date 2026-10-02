# 宿主升级对照：0.1.7-rc.2 → 0.2.0-rc.2

> 职责：本次升级（0.1.7-rc.2 → 0.2.0-rc.2）的接口对照、重大更新与实施状态
> 不负责：包清单（见 `docs/host/HOST-PACKAGES.md`）
> 过期条件：下次升级时另开新文件，本份移入 `archive/`

> 用途：记录本项目从 `dsh 0.1.7-rc.2`（当前运行版本）到 `0.2.0-rc.2` 的官方接口变更与重大更新，供升级实施与回归测试取材。
> 口径：宿主源码本地克隆 `~/GithubRepos/deepseek-harness`，两侧都取 **tag**——OLD = `dsh-v0.1.7-rc.2`（commit `477b4f4205`，2026-09-24），NEW = `dsh-v0.2.0-rc.2`（commit `639ed01539`，2026-09-29）。核对时间 2026-10-02。
> 主证据源：官方**生成式目录**（`docs/tool-catalog.md`、`docs/capability-seams.md`、`docs/event-producer-consumer.md`、`docs/persistence-catalog.md`）两侧的 diff + `docs/upgrade-guide/v0.1.7-rc.2/`（本次官方迁移指南）；逐包 `src/` diff 作辅证。
> 只记**会影响本仓库**的事实，逐条带证据（`文件:行` / commit / 官方 note）。未核实项单列 §7；复现命令见 §6。

## 0. 摘要

**需要改我方代码（0 项）**

本仓 17 个包消费的宿主服务面（`tools` / `agents` / `sessions` / `jobs` / `subagents` / `commands` / `userQuestions` / `goals` / `sessionTitle` / `sessionProjections` / `sessionQuery` / `skills` / `settings` / `permissionPresets` / `approval` / `workflowEngine` / `ptcRuntime` / `lsp` / `web` / `agentPresets` / `agentDefaultModel` / `profileContext`）在区间内**实现零 diff**（对应包只有 `package.json` 版本号 1 行改动），事件名与工具名两侧集合相同。故本次升级**不需要改代码**，只需部署面动作（安装、`scripts/install.sh` 默认版本、profile 依赖）。

**需要改配置 / 升级后必须验证（3 项）**

| # | 项 | 说明 |
|---|---|---|
| 1 | `bundle/base` 新增 `- id: otel` 行 | 升级后 fff 组合自动多挂一个官方包 `@deepseek-ai/dsh-otel`（新服务 `ctx.otel`）。挂了不报错，但挂载面计数、`HOST-PACKAGES.md` 的「已挂载」标记要跟着更新（条目 #1 步骤①一并实测） |
| 2 | `metric-loop` 的 `schedule_create` 提示指向当前组合里不存在的工具 | 官方 4 个 `schedule_*` 工具两版都在 catalog 内，但既不在 `dsh-base` 也不在 fff 的 bundles / patch；`metric-loop/src/engine.ts:227` 的 `scheduleHint()` 却让模型用它排唤醒。**既有问题**（0.1.7 也一样），0.2.0 只把 schedule 从 Web 组合搬进 optional bundle，与我们无关；修法归条目 #1（挂载面）决定 |
| 3 | `agent-loop` 失败步补写合成 `tool/result`（**活路径**） | 步骤失败收尾时，未回结果的工具调用会得到合成 error 结果（`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`），实时 `session/event` 因此多出工具结果；我方 5 处消费（TUI 渲染 / `output-compress` / `knowledge-base` / `rule-engine` / `context-report`）。不破坏接口，但升级后要真机确认无副作用（§3.7 末条、§5） |

**其余结论**

- **工具面零增删**：模型可见工具 65 → 65（`docs/tool-catalog.md`），无新增、无改名、无删除；只有 4 条**描述**变更（详见 §3.4），`ask_user_question` 的默认 schema 两侧**零 diff**（timed 是官方行的 config、不是模型可见参数，见 §3.4）。
- **服务面 +2、无删除**：`super(<ctx>, '<name>')` 口径 130 → 132，新增 `ctx.otel`（遥测上报通道）与 `ctx.productAnalytics`（Desktop 交互采集）；我方消费的服务全部在位。
- **事件面零增删**：声明事件 89 → 89；变化只在消费者集合（§3.3）。
- **装配契约零 diff**：`dsh.bundle` 类型（`util/package-manifest`）与 patch DSL（`vendor/include`）都无实现变化；启动必需条目表未动——0.1.7 文档里「只有 7 个硬编码 id 必需、其余 pending 只 warn」的结论继续成立。
- **会话格式仍是 V4**：`SESSION_FORMAT_VERSION` 两版都为 `4`，无格式升级、无新迁移库。
- **区间重心在 Desktop / Web / 遥测**：新增 4 个包全部属于遥测、客户端与 schedule 组合，对我们（TUI + 17 插件、走 profile 全局组合）无直接影响。

### 0.1 实施状态（本项目，2026-10-02）

| 项 | 状态 | 说明 |
|---|---|---|
| 对照文档产出 | **已完成** | 本文件 |
| `docs/host/HOST-PACKAGES.md` 刷新 | **已完成** | 标题 / 口径 / 采集时间 / 差异行 / 新增 4 包 / 服务索引 84 → 86；升级后按 `--dump-config` 实测回写包数（288，`dsh-*` 277）与挂载数（92，另有 TUI 自插的 `tool-ask-user`）；逐行标记复核归条目 #1 |
| 宿主升级执行 | **已执行（2026-10-02）** | `npm i -g @deepseek-ai/dsh@0.2.0-rc.2`（+30 / -13 / 改 508）；profile 树外加装包 `session-title-all-prompts-llm` 升 `0.2.0-rc.2` + `pnpm install`；`dsh --version` = `0.2.0-rc.2`；`--dump-config` 退出码 0、stderr 空、`otel` 行在位；备份在 `~/.dsh-upgrade-backup-2026-10-02/`；进程内真机验证**已完成**（重启后宿主确为 0.2.0；`context_report` / `fs_digest` / `code_map` / `task_engine` 全部通过——见 `docs/archived/2026-10-02-host-upgrade-execution.md`） |
| 我方代码改造 | **不需要** | 见 §0 首段与 §3.2 |
| 子代理审阅（决策后，用户流程要求） | **已完成** | 独立复现 10 项检查，「有条件通过」；5 处事实修正 + 5 处补漏已并入本文件：timed 是行 config 而非模型可见参数、`plugin-manager` / `hmr` 净零 diff、证据路径改仓根 `vendor/include`、投影消费方更正、`sandbox-windows-acl` 非新增包，补 `agent-loop` 活路径 / `loader/volatile-update` / `ui-settings-session-log` / `agentDefaultModel`+`profileContext` / fff 硬钉版本 |

## 1. 版本事实

| 项 | 值 |
|---|---|
| 本文对照版本 | OLD `dsh 0.1.7-rc.2`（tag `477b4f4205`，2026-09-24）→ NEW `dsh 0.2.0-rc.2`（tag `639ed01539`，2026-09-29） |
| 中间 tag | `dsh-v0.2.0-rc.1`（commit `4878cdabd8`，2026-09-28） |
| 本机现状 | 已升级：`dsh 0.2.0-rc.2`（2026-10-02 执行）；源码 clone 工作区 = NEW（`HEAD` = `639ed01539`） |
| cordis 版本 | `vendor/cordis` 两版都是 `4.0.4`（无变化） |
| npm dist-tags（2026-10-02 实测） | `latest` = `0.2.0-rc.2`、`next` = `0.2.0-rc.2`、`alpha` = `0.1.7-alpha.2`；0.2 线只发布过 `0.2.0-rc.1` / `0.2.0-rc.2`。查询用 `npm view --cache /tmp/<dir>` 绕开只读的 `~/.npm` |
| 源码包数 | 321 → 325（public 312 → 316；private 9 → 9） |
| 随包分发（安装树口径，2026-10-02 实测） | 283 → 288（其中 `dsh-*` 272 → 277）；新增 5 个 = 4 个新包 + `host-product-telemetry-otel` 转为随包分发 |
| `packages/` 顶层目录 | 60 → 61（新增 `telemetry/`） |

## 2. 区间规模与包清单变更

### 2.1 规模

| 指标 | 值 |
|---|---|
| commits / 文件 | 448（触碰 `packages/` 的 286；非 merge 提交 307）/ 1638 |
| 行数 | `+52,060 / -82,531`（净减，主要是 Web/客户端与测试重构） |
| 包（源码 `package.json`） | 321 → 325；public 312 → 316 |

### 2.2 新增包（4，按分类）

| 分类 | 包 | 一句话定位 |
|---|---|---|
| telemetry | `otel`（`packages/telemetry/otel`） | `ctx.otel`：给上报适配器（产品遥测 / 会话遥测）提供共享的 OTel 通道；**base 组合新增该行** |
| client | `client-product-analytics` | Desktop 交互采集（`ctx.productAnalytics`，只服务 Desktop 面） |
| client | `client-ui-settings-session-log` | 设置页的「Session Log 上传偏好」UI |
| bundle | `experimental-schedule-bundle` | 把 `time-context` / `schedule` / `ui-schedule` 三行从 Web 组合搬出的 optional bundle（缺省关闭） |

### 2.3 删除 / 改名 / 移目录（0）

无删除、无改名、无目录迁移（`packages/` 下逐包名对照为空集差）。上一版文档里 0.1.5 → 0.1.7 的改名清单（`code-runtime` → `ptc-runtime` 等）在本次区间内**没有新增项**。

## 3. 官方接口变更

### 3.1 服务注册表 diff（`super(<ctx>, '<name>')` 口径，排除测试）

OLD 130 / NEW 132。

| 方向 | 服务 |
|---|---|
| 新增（2） | `otel`（`packages/telemetry/otel`）、`productAnalytics`（`packages/client/product-analytics`） |
| 删除（0） | — |
| 改名 / 换包（0） | — |

`docs/capability-seams.md` 同向确认：新增 `ctx.otel`（`service`，被 `host-product-telemetry-otel`、`session-telemetry-otel` 消费）与 `ctx.productAnalytics`（`service`，Desktop 面）；另有既有包 `sandbox-windows-acl`（OLD 即存在，非本次新增）在区间内多了一个角色：作为 `ctx.skills` 的 provider（Windows ACL 诊断技能，未挂载）。

### 3.2 我方消费面逐项判定

判定依据：对每个提供服务面的官方包跑 `git diff --shortstat <old> <new> -- packages/<包>`——**只有 `package.json` 版本号 1 行 diff 即视为实现零变化**。

| 服务（我方消费方） | 区间 diff | 判定 | 证据 |
|---|---|---|---|
| `tools`（全部 17 包的工具注册） | 1 文件 1 行（版本） | 兼容 | `packages/core/tools/package.json` |
| `agents`（herdr-integration、TUI adapter） | 1 文件 1 行 | 兼容 | `packages/core/agent/package.json` |
| **`agentLoop`**（宿主自跑；我们消费其事件面 `tool/result` / `session/event`） | 8 文件 +333/-16（`src/agent.ts`、`src/tool-calls.ts` 实改） | **行为变化（非破坏）**：失败步为未回结果的工具调用补写合成 `tool/result`（§3.7 末条） | `packages/core/agent-loop/src/**` |
| `sessions`（TUI adapter、context-report） | 8 文件（`repair.ts` 重做 + README；`src/index.ts` 仅多导出一个 `ToolCallRecovery`） | 兼容（我们只走 `get`/`list`/`create` 等服务方法） | `packages/core/session/src/repair.ts`、`src/index.ts:32` |
| `jobs`（TUI `/jobs`） | 1 文件 1 行 | 兼容 | `packages/jobs/jobs/package.json` |
| `subagents`（task-engine、command-template 经 `loadHost`） | 1 文件 1 行 | 兼容 | `packages/subagent/subagent/package.json` |
| `commands`（TUI `/playbook` 等） | 1 文件 1 行 | 兼容 | `packages/interaction/commands/package.json` |
| `userQuestions`（goal-contract、task-engine human RET） | 12 文件（新增 timed 模式 / 投影 / 迟到回复） | 兼容（默认阻塞语义未变，新增参数可选） | 见 §3.4、§3.7 |
| `goals`（goal-contract） | 1 文件 1 行 | 兼容 | `packages/goal/goal/package.json` |
| `sessionTitle`（session-title-cutoff 注册 provider） | 三个 title 包各 1 文件 1 行 | 兼容 | `packages/session/session-title*/package.json` |
| `sessionProjections`（context-report） | 1 文件 1 行 | 兼容（宿主新增投影单元 `userQuestions`，不影响既有单元；`rule-engine` 只 inject `agents` / `sessions`，不碰投影） | `packages/session/session-projection/package.json` |
| `sessionQuery`（TUI、context-report） | 1 文件 1 行 | 兼容 | `packages/session-query/session-query/package.json` |
| `skills`（TUI、rule-engine 技能面） | 1 文件 1 行 | 兼容 | `packages/skill/skill/package.json` |
| `settings`（TUI） | 2 文件（版本 + 新增一个测试） | 兼容 | `packages/settings/settings/tests/configuration-inheritance.spec.ts` |
| `permissionPresets` / `approval`（security-guard、task-engine） | 各 1 文件 1 行 | 兼容 | `packages/interaction/*/package.json` |
| `workflowEngine`（task-engine workflow 后端、metric-loop 提示） | 1 文件 1 行 | 兼容 | `packages/workflow/workflow/package.json` |
| `ptcRuntime`（task-engine command 后端） | 1 文件 1 行 | 兼容 | `packages/ptc-runtime/ptc-runtime/package.json` |
| `lsp`（code-map 语义层 `precision:lsp`） | `lsp` / `lsp-stdio` / `tool-lsp` 各 1 文件 1 行 | 兼容 | `packages/lsp/*/package.json` |
| `web`（TUI 的 web 面引用） | 1 文件 1 行 | 兼容 | `packages/web/web/package.json` |
| `agentDefaultModel`（task-engine）/ `profileContext`（TUI 经 `ctx.get` 读） | 各 1 文件 1 行 / provider 实现未改 | 兼容 | `packages/core/agent-default-model/package.json`；`packages/boot/app-boot/src/profile-context.ts` 未在区间内修改 |
| `llm` / `token-meter`（session-title-cutoff、task-engine 计量） | 各 1 文件 1 行 | 兼容（`tokenUsage` 投影口径未变，BACKLOG #8 的前提仍成立） | `packages/llm/token-meter/package.json` |

**我方调用点（本次无需改动）**：`TUI/src/app/adapter/dsh.ts`（`jobs` / `agents` / `sessions`）、`task-engine/src/main.ts`（`subagents` / `workflowEngine` / `ptcRuntime` / `sessionProjections`）、`command-template/src/subagent.ts:102`（`loadHost("@deepseek-ai/dsh-subagent")`）、`session-title-cutoff/src/main.ts:185`（`loadHost("@deepseek-ai/dsh-session-title-llm")`）、`code-map/src/semantic/lsp.ts`（`ctx.get("lsp")`）——两个 `loadHost` 目标包都只改了版本号。

### 3.3 事件面

- 声明事件名 89 → 89，**零增删**（`docs/event-producer-consumer.md` 两侧集合相同）；我方订阅/派发的 `session/event`、`agent/pre-step`、`agent/request`、`tools/result`、`compaction/end`、`compaction/summary`、`session/start` 等全部在位。
- 消费者集合变化（只影响官方内部包）：
  - `agent/inbox/claimed` / `agent/inbox/discarded` 新增消费者 `user-questions`（timed 模式的等待与迟到回复需要感知 inbox 声明）；
  - `session/event` 新增消费者 `product-analytics`、`user-questions`；
  - `user-questions/request` 的生产点行号变化（`packages/interaction/user-questions/src/types.ts:88` → `:157`）；
  - 未声明事件表里 `loader/volatile-update` 新增消费者 `product-analytics`（其余 `cordis/*`、`session-telemetry/record` 只是行号漂移）。
- 载荷级差异未逐字段核对（§7）。

### 3.4 工具面（模型可见）

工具集零增删（`docs/tool-catalog.md` 里以 `###` 开头的工具小节标题集合两侧都是 65 项），只有 4 条描述 / 参数变化：

| 工具 | 变化 | 对我方影响 |
|---|---|---|
| `ask_user_question` | 官方新增**行级 config** `mode: 'legacy' \| 'timed'`（缺省 `legacy`，`packages/interaction/tool-ask-user/src/index.ts:17-24`）：切到 timed 后该工具换成另一套 schema（多一个整数秒参数 `timeout`，行 config 缺省 120，`-1` = 无限等待）并产出 pending 结果、允许迟到回复。**默认 legacy 下工具 schema 两侧零 diff**（catalog 的 JSON schema 块无变化可证） | 无（我们未设该 config，仍走 legacy）；将来若在 fff 打开 timed，需处理迟到回复与 `userQuestions` 投影（§3.7） |
| `bash` | 描述新增「删除 / 移动前先核实解析后的绝对路径、变量用 `${VAR:?}` 防未设」 | 无（提示词文案） |
| `pwsh` | 同上 + 「不要给 `$HOME` 之类自动变量赋值，变量名大小写不敏感」 | 无 |
| `cordis_inspect_query` | 客户端查询改为「在配置的超时内等首页响应，否则报 Client 失败或提示重连」 | 无 |

工具目录里登记的包（30 个）与工具归属关系两侧相同——没有包改名或工具搬家。

### 3.5 插件作者契约与装配机制

| 机制 | OLD → NEW | 我方影响 | 证据 |
|---|---|---|---|
| `dsh.bundle` 类型与语义（`util/package-manifest`） | 只有版本号 diff | 无 | `packages/util/package-manifest/package.json` |
| `cordis.patch.yml` DSL（仓根 `vendor/include`） | **零 diff** | 无 | `git diff --shortstat <OLD> <NEW> -- vendor/include` 为空（注意不是 `packages/vendor/...`，该路径不存在） |
| 启动必需条目表 / `auditStartupEntries` | `boot/app-boot/src/index.ts` 未动 | 无（0.1.7 文档结论继续成立：非必需条目不激活只 warn） | `packages/boot/app-boot/src/index.ts` |
| optional bundle 名单（`OPTIONAL_BUNDLES`） | 新增 `@deepseek-ai/dsh-experimental-schedule-bundle` | 无（未挂） | `packages/boot/app-boot/src/profile.ts:217` |
| 兼容性预检 / 版本豁免（`plugin-manager`） | `boot/plugin-manager/src` **零 diff**（只动 `package.json` + 4 个测试文件；区间内那条「拒绝单独切换 bundle 行」的特性随后被 revert） | 无（未挂载；`dsh plugin` 语义对普通 profile 未变） | `git diff --shortstat <OLD> <NEW> -- packages/boot/plugin-manager/src` 为空 |
| `hmr` | `boot/hmr/src` **零 diff**（只动 README + tests + `package.json`） | 无（未挂载） | 同上命令（`packages/boot/hmr/src`）为空 |
| CLI（`apps/cli`） | 改动集中在 Desktop 保留 profile（`desktop`）与 plugin-manager 抽取：`parseDshArgs(argv, version, manageDesktopProfile=false)`、`plugin` 分支对 `profile === 'desktop'` 特判 | 无（`--profile <name>` / `plugin add \| remove \| why` 用法不变） | `apps/cli/src/args.ts:145`、`apps/cli/src/plugin.ts` |

### 3.6 配置与组合面

| 项 | OLD → NEW | 我方影响 |
|---|---|---|
| `bundle/base` 组合 | 新增一行 `- id: otel`（`name: '@deepseek-ai/dsh-otel'`）；`session-telemetry-otel` 配置加 `maxRequestBytes: 4000000`，exporter URL 由 `harness-telemetry.deepseeksvc.com` 改为 `dsh-otel-collector.deepseeksvc.com` | **升级后多挂 1 包**；遥测端点变化不影响我们（`DSH_TELEMETRY_MODE` 未设时缺省 `FEEDBACK_ONLY`，不产生上行） |
| `bundle/web-app` 组合 | 移除 `time-context` / `schedule` / `ui-schedule` 三行，改由 `experimental-schedule-bundle` 插入；新增 `- id: ui-settings-session-log` 与 product-analytics 相关行 | 无（不用 Web 组合） |
| `dsh-base` 是否含 schedule | 两版都不含 | 无（但见 §0-2 的 `metric-loop` 既有问题） |

### 3.7 会话持久化与投影

- **格式版本不变**：`packages/core/session/src/types.ts:89` 两版都是 `SESSION_FORMAT_VERSION = 4`；无新增 `session-format-*` 迁移包。
- **新增一类消息来源**：`MessageSource` 联合新增 `user-question-reply`（`{ kind, callId, outcome: 'answered' }`，`@persistenceAttribution`）——timed 问题的迟到回复以 `user/message` 形式进入会话，且**没有生产者时也要保留**（读者不得丢弃）。随之变化（`docs/persistence-catalog.md` 的 shape hash）：`Message[]`、`source`、`user/message`、`developer/message`、`agent/inbox/spliced`、`session/title-llm-request`。
- **新增投影单元**：`@deepseek-ai/dsh-session-projection` 的 `SessionProjectionMap` 增加 `userQuestions`（视图 `{ active, settled }`，由 `packages/interaction/user-questions/src/projection.ts` 提供）。我方 `context-report` 只读自有的 `tokenUsage` 等单元，不受影响；`rule-engine` 无投影依赖。
- **会话修复重做**：`packages/core/session/src/repair.ts` 重写并导出 `ToolCallRecovery`——「被打断的工具调用」在会话加载时的收尾策略变化（属宿主内部行为，我们不经手会话日志解析；与下一条的**活路径**补写是两件事）。
- **失败步补写工具结果（活路径，落在我们事件面上）**：`packages/core/agent-loop`（8 文件、+333/-16，`src/agent.ts` + `src/tool-calls.ts`）在**步骤失败收尾时**为未回结果的工具调用补写合成 `tool/result`：已有 `tool/call` 记录的拿 `TOOL_OUTCOME_UNKNOWN`，只有请求没有调用记录的拿 `TOOL_NOT_STARTED`；已提交结果不动、失败轮语义不变（note `.agents/notes/implemented/bug-fix/2026-09-19-failed-step-tool-results.md`）。我方消费 `tool/result` 的 5 处：`TUI/src/app/adapter/dsh.ts:1889`、`output-compress/src/hooks.ts:255`、`knowledge-base/src/hooks.ts:155`、`rule-engine/src/engine.ts:545`、`context-report/src/fold.ts:297`——多出来的只是「失败步里没有结果的调用」，升级后按 §5 真机复现一次中断场景。
- **对方影响**：`session-title-cutoff` 与 `session-title-*` 三个官方 provider 包的**代码零变化**，但 `session/title-llm-request` 的事件数据类型 hash 变了（因内嵌 `Message[]` 变化）——我们只用 `ctx.sessionTitle.register` 与标题服务方法，不引用该事件类型。

## 4. 官方重大更新

| # | 更新 | 一句话说明 | 证据 |
|---|---|---|---|
| 1 | **`user-questions` timed 模式与迟到回复** | `ask_user_question` 可声明 `mode: timed`：前台等待超时后返回 pending 结果，问题仍可回答；回答在之后以 `user-question-reply` 消息注入；新增 `userQuestions` 投影供客户端读「未决 / 已结」状态 | commit 组 `feat(user-questions): support timed waits and late replies`；`packages/interaction/user-questions/src/{timed-wait,projection}.ts`；`interaction/tool-ask-user` +668/-56 |
| 2 | **遥测重构：`ctx.otel` 共享通道 + 字节有界 OTLP 上传** | 抽出 `otel` 服务包供多个上报适配器复用；会话日志上报改字节有界批处理（`maxRequestBytes: 4000000`、串行请求 + 1.5s 看门狗、3s 关停上限）；端点换 `dsh-otel-collector` | `feat(telemetry): upload session log events through byte-bounded OTLP`；`packages/telemetry/otel`；note `.agents/notes/implemented/architecture/2026-09-25-session-log-otel-byte-limits.md`；`bundle/base/cordis.patch.yml` |
| 3 | **Schedule 移入 optional bundle** | Web 组合不再持有 `time-context` / `schedule` / `ui-schedule` 三行；改由 `experimental-schedule-bundle`（插件页「Automation tasks」）插入，缺省关闭；按 id 启用过 schedule 的 profile 升级后会看到 `patch: entry schedule not found` 警告并失去提醒投递 | 官方升级指南 `docs/upgrade-guide/v0.1.7-rc.2/schedule-optional-bundle/guide.md`；`feat(schedule): ship the Schedule switch as an optional bundle` |
| 4 | **Desktop 线** | 内置 CLI 运行时与安装守卫、原生菜单管理本机 dsh 命令、登录 shell 环境、安装器上传命令、product analytics（OTel） | notes `feature/2026-09-27-desktop-cli-runtime.md`、`feature/2026-09-28-desktop-login-shell-environment.md`；`packages/client/product-analytics` |
| 5 | **Web / 客户端显示与性能** | 展示面第二份官方升级指南：旧值 `ui-chat.transcriptView: normal` 与「非 Desktop Web 未设值」从 `standard` 改为 `detailed`（磁盘值不改写）；另有模型选择器模糊搜索 / 分组排序、工作区侧栏文件树、长会话渲染与鲸鱼动画性能、进程行 shimmer | 官方升级指南 `docs/upgrade-guide/v0.1.7-rc.2/transcript-view-legacy-normal/guide.md`；commit 组 `feat(web)` / `perf(client)` |
| 6 | **失败步工具结果与重放保护** | `agent-loop` 在步骤失败收尾时为未回结果的工具调用补写合成结果（`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`），让后续请求拿到配对的工具历史而不自动重试不确定操作；同批 `core/session` 的 `repair.ts` 重做（`ToolCallRecovery`） | `packages/core/agent-loop/src/{agent.ts,tool-calls.ts}`（8 文件 +333/-16）；note `.agents/notes/implemented/bug-fix/2026-09-19-failed-step-tool-results.md`；同批 `packages/core/session/src/repair.ts` 重做（`ToolCallRecovery`） |
| 7 | **插件管理面（净变化为零）** | 区间内出现过「bundle 整体切换保护」等特性，随后被 revert——`plugin-manager` / `hmr` 的 `src` 净零 diff（前者只动 `package.json` + 4 个测试文件，后者只动 README + tests）；`sandbox-windows-acl` 获得 ACL 拒绝诊断技能这一新角色 | `git diff --shortstat <OLD> <NEW> -- packages/boot/plugin-manager/src packages/boot/hmr/src` 为空；`feat(sandbox-windows-acl): ship a diagnosis skill for ACL denials` |

## 5. 对本项目的影响与行动清单

| 对象 | 影响 | 升级前需做 |
|---|---|---|
| 17 个插件包（含 TUI） | **无需改代码**（消费的服务面实现零 diff、工具注册契约未变）；唯一行为面变化是失败步多出的合成 `tool/result`（5 处消费，§3.7） | 真机复现一次「工具中断 / 步骤失败」：TUI 不出现孤立结果行、`output-compress` 不误生成分片、`knowledge-base` 不写入噪声条目 |
| `metric-loop` | `scheduleHint()` 让模型调 `schedule_create`，而当前组合无该工具（既有问题，非本次引入）——2026-10-02 真机确认：`dsh-base` 无 schedule 行、fff patch 无、重启后工具清单也没有 `schedule_create` / `_delete` / `_list` / `_update` | 挂载面决定（条目 #1）：挂 `schedule` 相关行，或把提示改为不依赖宿主 schedule |
| 部署 / profile | `bundle/base` 新增 `otel` 行 → 升级后自动多挂 `@deepseek-ai/dsh-otel` | ① 升级动作本身另立条目（安装 + profile 依赖 + 真机验证）；② `scripts/install.sh` 的 `dsh_version_default="0.1.7-rc.2"` 与提示文案同步到 `0.2.0-rc.2`；③ 升级后跑 `--dump-config` 断言 stderr 无 `did not activate`；④ 树外加装包 `session-title-all-prompts-llm` 在 `~/.dsh/profiles/fff/package.json` 里**硬钉 `0.1.7-rc.2`**，升级 CLI 不会自动跟随，要 `npm pkg set` + `pnpm install` 手动升版 |
| `security-guard` | 宿主升版可能新增「未登记但带路径 / 命令 / 代码参数」的工具（这类工具会绕过敏感文件层 / 命令黑名单层） | 升版后跑一次差异检查：`node security-guard/scripts/tool-surface-check.mjs --root <dsh 包目录>`（**要指 dsh 包目录**，其下含 `node_modules/@deepseek-ai/dsh-tool-*`；指到 `@deepseek-ai` scope 层会纠正提示 + exit 2，缺 `--root` / `DSH_INSTALL` 同样 exit 2）。有「需关注」项 → exit 1（可作门禁）；「名称未解析」行（`name:` 为计算值，如 `workflow`）需人工复核 |
| 文档 | `HOST-PACKAGES.md` 是 0.1.7-rc.2 口径（283 包 / 91 挂载） | 本次已定点刷新（新增 4 包 + 口径行 + `otel` 行提示）；全量挂载标记实测归条目 #1 |
| 将来可选 | 若采用 `ask_user_question` timed 模式：需处理 `user-question-reply` 迟到消息与 `userQuestions` 投影 | 不立项，记为观察项 |

## 6. 复现命令

```sh
R=~/GithubRepos/deepseek-harness   # 本地 clone；两侧都取 tag，不用工作区
OLD=dsh-v0.1.7-rc.2; NEW=dsh-v0.2.0-rc.2

# 版本事实与规模
git -C $R log -1 --format='%H %ad %s' --date=short $OLD
git -C $R log -1 --format='%H %ad %s' --date=short $NEW
git -C $R rev-list --count $OLD..$NEW
git -C $R diff --shortstat $OLD $NEW

# 包清单增删（按 name，含 public/private 计数）
for T in $OLD $NEW; do git -C $R ls-tree -r --name-only $T packages | grep 'package.json$' |
  while read -r p; do git -C $R show "$T:$p" | grep -m1 '"name"'; done | sed -E 's/.*"name": *"([^"]+)".*/\1/' | sort -u; done

# 服务注册表 diff
comm -13 <(git -C $R grep -h -o -E "super\([A-Za-z_][A-Za-z0-9_]*, *'[a-zA-Z][A-Za-z0-9]*'" $OLD -- 'packages/**/*.ts' | sed -E "s/.*'([a-zA-Z][A-Za-z0-9]*)'/\1/" | sort -u) \
         <(git -C $R grep -h -o -E "super\([A-Za-z_][A-Za-z0-9_]*, *'[a-zA-Z][A-Za-z0-9]*'" $NEW -- 'packages/**/*.ts' | sed -E "s/.*'([a-zA-Z][A-Za-z0-9]*)'/\1/" | sort -u)

# 工具名 / 事件名集合 diff（官方生成式目录）
git -C $R show $OLD:docs/tool-catalog.md | grep -oE '^### `[^`]+`' | sort -u > /tmp/t.old
git -C $R show $NEW:docs/tool-catalog.md | grep -oE '^### `[^`]+`' | sort -u > /tmp/t.new
comm -3 /tmp/t.old /tmp/t.new                      # 空 = 零增删
git -C $R diff $OLD $NEW -- docs/tool-catalog.md docs/capability-seams.md docs/event-producer-consumer.md

# 我方消费面是否有实现变化（以 tools / jobs / lsp 为例；1 文件 1 行 = 只有版本号）
git -C $R diff --shortstat $OLD $NEW -- packages/core/tools packages/jobs/jobs packages/lsp/lsp
git -C $R diff $OLD $NEW -- packages/core/tools   # 应只看到 package.json 的 version 行

# 装配契约与组合面
git -C $R diff $OLD $NEW -- packages/util/package-manifest packages/boot/app-boot/src vendor/include
git -C $R diff $OLD $NEW -- packages/bundle/base/cordis.patch.yml

# 官方迁移指南（本次唯一目录）
git -C $R ls-tree -r --name-only $NEW -- docs/upgrade-guide
```

## 7. 未确认项

1. **timed 模式的客户端行为**：迟到 `user-question-reply` 消息在 TUI 的呈现、`userQuestions` 投影在非 Web 客户端的行为未实测（我们不启用 timed，暂不影响）。
1. **`repair.ts` 重做的行为差异**：`ToolCallRecovery` 对「旧会话断点续跑 / 打断的工具调用」的具体差异未实测。
1. **事件载荷级差异**：事件名与消费者集合已核对，字段级未逐项比对（`user/message`、`developer/message`、`agent/inbox/spliced` 的 shape hash 变化已记录，来源是新增的 `user-question-reply`）。
1. **Web / Desktop 面**：新增与变更（product analytics、CLI 内置、设置页拆分等）未逐项核对——本项目不使用，仅记入 §4。
1. **性能基线**：区间净减 3 万行、包数 +4，对装配耗时的影响未测量。
1. **`agent-loop` 失败步合成 `tool/result` 的行为未真机复现**：升级后没有构造「工具中断 / 步骤失败」场景，5 处消费点（`TUI/src/app/adapter/dsh.ts:1889`、`output-compress/src/hooks.ts:255`、`knowledge-base/src/hooks.ts:155`、`rule-engine/src/engine.ts:545`、`context-report/src/fold.ts:297`）的「不误分片 / 不写噪声条目」未断言（§3.7 末条、§5）。
