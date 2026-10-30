# 整理历史代码和文档（接取条目：`docs/BACKLOG.md`「整理历史代码和文档」）

状态：决策　　开启：2026-10-28　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

整理仓库全部代码与文档：内容符合现行规范，清理历史开发过程中遗留的旧账（失效引用、过期结论、重复记录、无引用代码、临时产物），先出清单待确认再分批落地。

## 调研

> 来源：第 1 至 3 节为本仓实测（2026-10-28，脚本 `tmp/scan-*.mjs`，输出 `tmp/*.txt`，未入 git）；本节是当时的实测快照, 后续规范与工具变更不回填。第 4 节为官方文档检索，来源链接随条目给出。

### 1. 代码存在的问题

#### 1.1 代码失效

`src` 里导出、全仓含测试无任何引用的符号共 21 个: 7 个类型、3 个常量、11 个函数。孤立模块 0 个。

| 文件:行 | 符号 | 形态 |
| --- | --- | --- |
| `TUI/src/app/adapter/types.ts:114` | `ToolResultMetaLike` | 类型 |
| `TUI/src/app/state.ts:695` | `PickerOption` | 类型 |
| `TUI/src/app/state.ts:2834` | `isInputHistoryBrowse` | 函数 |
| `auto-approve/src/audit.ts:266` | `AuditRecent` | 类型 |
| `auto-approve/src/decide.ts:270` | `allowedByRisk` | 函数 |
| `auto-approve/src/rules.ts:27` | `RuleInput` | 类型 |
| `background-daemon/src/commands.ts:38` | `Subcommand` | 类型 |
| `background-daemon/src/tz.ts:206` | `daysBetween` | 函数 |
| `coagent/src/herdr.ts:52` | `notesOf` | 函数 |
| `command-template/src/steps.ts:276` | `declaredModels` | 函数 |
| `command-template/src/subagent.ts:335` | `availableProviders` | 函数 |
| `goal-contract/src/types.ts:29` | `GoalContract` | 类型 |
| `herdr-use/src/workspace.ts:255` | `defaultConfig` | 函数 |
| `md-map/src/indexer.ts:450` | `toPosix` | 函数 |
| `memory-base/src/hybrid.ts:15` | `SEARCH_MODES` | 常量 |
| `output-compress/src/digest-db.ts:53` | `DigestPutOutcome` | 类型 |
| `session-channel/src/broker.ts:813` | `countTasks` | 函数 |
| `session-channel/src/keys.ts:94` | `STATE_PATTERN` | 常量 |
| `session-channel/src/keys.ts:97` | `sessionIdFromStateKey` | 函数 |
| `session-channel/src/keys.ts:116` | `TASK_INDEX_PATTERN` | 常量 |
| `session-channel/src/keys.ts:130` | `sessionIdFromTaskIndexKey` | 函数 |

#### 1.2 代码冗余

同一个几十行的兜底与封装被复制进多个包。按出现包数排序:

| 函数 | 包数 | 出现的包 |
| --- | --- | --- |
| `apply` | 25 | `agent-group`、`ast-tools`、`auto-approve`、`behavior-correction`、`clock-base`、`coagent`、`code-map`、`command-template`、`context-report`、`escalation-hint`、`fs-digest`、`goal-contract`、`herdr-use`、`md-logic`、`md-map`、`md-table-check`、`memory-base`、`output-compress`、`ponytail`、`preference-analysis`、`script-interpreter`、`security-guard`、`session-channel`、`session-paths`、`tool-consult` |
| `jsonText` | 13 | `agent-group`、`background-daemon`、`coagent`、`code-map`、`context-report`、`fs-digest`、`goal-contract`、`hash-edit`、`metric-loop`、`preference-analysis`、`rule-engine`、`session-channel`、`task-engine` |
| `resolveConfig` | 11 | `agent-group`、`auto-approve`、`behavior-correction`、`coagent`、`escalation-hint`、`herdr-use`、`md-table-check`、`ponytail`、`preference-analysis`、`session-title-cutoff`、`tool-consult` |
| `systemTimers` | 10 | `agent-group`、`ast-tools`、`auto-approve`、`command-template`、`herdr-integration`、`herdr-use`、`rule-engine`、`script-interpreter`、`session-channel`、`task-engine` |
| `readService` | 10 | `agent-group`、`auto-approve`、`background-daemon`、`coagent`、`command-template`、`herdr-use`、`metric-loop`、`session-channel`、`session-paths`、`task-engine` |
| `attachEffect` | 9 | `ast-tools`、`auto-approve`、`clock-base`、`command-template`、`herdr-integration`、`herdr-use`、`rule-engine`、`script-interpreter`、`task-engine` |
| `delayOf` | 8 | `ast-tools`、`auto-approve`、`command-template`、`herdr-integration`、`herdr-use`、`rule-engine`、`script-interpreter`、`task-engine` |
| `isTimers` | 8 | 同上 8 个包 |
| `readClock` | 8 | 同上 8 个包 |
| `resolveClock` | 8 | 同上 8 个包 |
| `runDisposer` | 8 | 同上 8 个包 |
| `createDeadline` | 8 | 同上 8 个包 |
| `str` | 6 | `TUI`、`ast-tools`、`command-template`、`herdr-use`、`md-logic`、`md-map` |
| `describe` | 6 | `agent-group`、`coagent`、`command-template`、`preference-analysis`、`script-interpreter`、`session-channel` |
| `toToolDef` | 5 | `agent-group`、`coagent`、`code-map`、`metric-loop`、`session-channel` |
| `failure` | 5 | `agent-group`、`auto-approve`、`coagent`、`command-template`、`herdr-use` |
| `fail` | 4 | `background-daemon`、`goal-contract`、`script-interpreter`、`task-engine` |
| `sessionIdOf` | 4 | `context-report`、`preference-analysis`、`rule-engine`、`script-interpreter` |
| `resolveExecCwd` | 4 | `fs-digest`、`hash-edit`、`md-logic`、`md-map` |

其中 `apply` 是各包约定的统一入口名;其余为同名小函数分布在多个包, 定时器那一组 (`systemTimers` / `readClock` / `resolveClock` / `delayOf` / `createDeadline` / `runDisposer` / `attachEffect`) 同时存在 `clock-base` 的服务面与各包自带的兜底。

#### 1.3 注释与代码不一致

注释里引用的 `.ts` 路径共 41 处不是完整路径。其中 35 处是仓内简写, 按字面找不到文件, 需按包内 `src/` 解析才成立:

| 目标 | 次数 | 出现位置 |
| --- | --- | --- |
| `layout/hints.ts` | 14 | `components/ApprovalPrompt.ts:4`、`components/CommandCompletion.ts:6`、`components/CommandListPanel.ts:50`、`:61`、`components/HistoryPanel.ts:12`、`components/JobsPanel.ts:7`、`:21`、`:33`、`components/ModelPicker.ts:12`、`:158`、`components/QuestionPrompt.ts:6`、`:100`、`components/StatusPanel.ts:17`、`:63` |
| `layout/width-symbols.ts` | 9 | `app/index.ts:420`、`:462`、`:1066`、`:1089`、`app/layout/eaw-table.ts:8`、`app/layout/markdown.ts:406`、`app/layout/width-symbols.ts:1`、`main.ts:147`、`:1006` |
| `adapter/local-log.ts` | 3 | `app/config.ts:88`、`:264`、`app/index.ts:422` |
| `adapter/types.ts` | 1 | `app/file-mention.ts:5` |
| `adapter/dsh.ts` | 1 | `app/index.ts:2209` |
| `layout/eaw-table.ts` | 1 | `app/layout/eaw-table.ts:1` |
| `layout/tool-line.ts` | 1 | `app/adapter/dsh.ts:2284` |
| `components/ModelPicker.ts` | 1 | `app/picker-filter.ts:7` |
| `pipeline/types.ts` | 1 | `app/layout/pipeline/ir.ts:4` |
| `src/types.ts` | 1 | `app/adapter/types.ts:931` |
| `src/main.ts` | 1 | `goal-contract/src/index.ts:5` |
| `TUI/src/x.ts` | 1 | `app/layout/tool-line.ts:18` |

另 6 处指向的是宿主或历史仓库的路径, 本就是外部引用, 不算缺陷:`user-approval/src/index.ts` (`adapter/dsh.ts:3163`)、`packages/goal/goal/src/domain.ts` (`adapter/types.ts:27`)、`compaction/src/types.ts` (`adapter/types.ts:90`)、`agent-loop/src/tool-calls.ts` (`escalation-hint/src/main.ts:8`)、`pi/agent/extensions/herdr-agent-state.ts` (`herdr-integration/src/herdr.ts:3`)、`packages/session-query/session-query-sqlite/src/schema.ts` (`memory-base/src/schema.ts:12`)。

数量口径的注释有 6 处:`herdr-use/src/tools.ts:2` 与 `:258` 的「十个工具」、`ast-tools/src/tools.ts:467` 与 `hash-edit/src/main.ts:294` 的「两个工具」、`preference-analysis/src/tools.ts:97` 的「三个工具」、`agent-group/src/main.ts:18` 的「11 个动作」。

#### 1.4 规范不统一

`package.json` 字段有 6 种组合, 差别只在 `types`、`dependencies`、`exports`、`bin` 四项:

| 字段组合 | 包数 | 包 |
| --- | --- | --- |
| 无 `types`、无 `dependencies` (23) | 23 | `agent-group`、`auto-approve`、`background-daemon`、`behavior-correction`、`clock-base`、`command-template`、`context-report`、`escalation-hint`、`fs-digest`、`hash-edit`、`md-table-check`、`memory-base`、`metric-loop`、`output-compress`、`ponytail`、`preference-analysis`、`rule-engine`、`security-guard`、`session-paths`、`session-title-cutoff`、`symbol-normalizer`、`task-engine`、`tool-consult` |
| 有 `types` + `dependencies` (5) | 5 | `code-map`、`herdr-use`、`md-logic`、`md-map`、`session-channel` |
| 只有 `types` (2) | 2 | `ast-tools`、`script-interpreter` |
| 只有 `dependencies` (2) | 2 | `coagent`、`herdr-integration` |
| 加 `exports` (1) | 1 | `goal-contract` |
| 加 `bin` (1) | 1 | `TUI` |

脚本名有 11 种组合:

| 脚本组合 | 包数 | 包 |
| --- | --- | --- |
| `build` / `check` / `test` | 17 | `agent-group`、`background-daemon`、`behavior-correction`、`clock-base`、`code-map`、`command-template`、`context-report`、`escalation-hint`、`md-logic`、`md-map`、`ponytail`、`preference-analysis`、`script-interpreter`、`session-channel`、`session-paths`、`session-title-cutoff`、`tool-consult` |
| 加 `demo` | 4 | `fs-digest`、`hash-edit`、`rule-engine`、`symbol-normalizer` |
| 加 `smoke` | 4 | `goal-contract`、`metric-loop`、`output-compress`、`security-guard` |
| 加 `verify` + `watch` | 2 | `coagent`、`herdr-use` |
| 加 `example:search` / `example:replace` | 1 | `ast-tools` |
| 加 `inspect` | 1 | `auto-approve` |
| 加 `watch` | 1 | `herdr-integration` |
| 加 `check:no-cross-emit` | 1 | `md-table-check` |
| 加 `demo` + `smoke` | 1 | `memory-base` |
| 加 `demo` + `smoke:executor` | 1 | `task-engine` |
| 加 `bench` / `demo:build` / `gen:width-table` / `smoke:pty` / `watch` | 1 | `TUI` |

无 `types` 字段的有 26 个包:`agent-group`、`auto-approve`、`background-daemon`、`behavior-correction`、`clock-base`、`coagent`、`command-template`、`context-report`、`escalation-hint`、`fs-digest`、`hash-edit`、`herdr-integration`、`md-table-check`、`memory-base`、`metric-loop`、`output-compress`、`ponytail`、`preference-analysis`、`rule-engine`、`security-guard`、`session-paths`、`session-title-cutoff`、`symbol-normalizer`、`task-engine`、`tool-consult`、`TUI`。带 `types` 的 8 个包正好是被跨包 import 的那几个, 说明这个字段是「用到才加」而非统一约定。

无 `LICENSE` 的有 5 个包:`coagent`、`code-map`、`command-template`、`herdr-integration`、`session-channel`, 而它们的 `files` 又都列了 `LICENSE`。

`tsconfig.json` 里留着 `"exclude": ["tests/clock.test.ts"]` 的有 8 个包:`ast-tools`、`auto-approve`、`command-template`、`herdr-integration`、`herdr-use`、`rule-engine`、`script-interpreter`、`task-engine`, 而那个文件在这些包里并不存在。选项覆盖也不是统一口径:`noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`、`exactOptionalPropertyTypes`、`noFallthroughCasesInSwitch` 在 34 个包上均为 0;`tests/tsconfig.json` 只有 6 个包有 (`agent-group`、`behavior-correction`、`clock-base`、`escalation-hint`、`md-table-check`、`session-paths`)。

#### 1.5 测试覆盖不足

34 个包都有测试文件, 但 21 个包只有 1 至 5 个测试文件:

| 包 | 测试文件数 |
| --- | --- |
| `ponytail` | 1 |
| `session-title-cutoff` | 1 |
| `behavior-correction` | 2 |
| `clock-base` | 2 |
| `escalation-hint` | 2 |
| `session-paths` | 2 |
| `agent-group` | 3 |
| `command-template` | 3 |
| `context-report` | 3 |
| `metric-loop` | 3 |
| `coagent` | 4 |
| `fs-digest` | 4 |
| `goal-contract` | 4 |
| `hash-edit` | 4 |
| `herdr-integration` | 4 |
| `md-logic` | 4 |
| `security-guard` | 4 |
| `symbol-normalizer` | 4 |
| `code-map` | 5 |
| `md-map` | 5 |
| `output-compress` | 5 |

对照顶端: `TUI` 139、`auto-approve` 15、`background-daemon` 15、`rule-engine` 14、`herdr-use` 12。另有 5 处 `skip` / `todo`:`TUI/tests/app.test.ts:354`、`behavior-correction/tests/contract.test.ts:20`、`security-guard/tests/script.test.ts:509`、`session-title-cutoff/tests/main.test.ts:553`、`tool-consult/tests/retrieval.test.ts:209`。

#### 1.6 测试过时

已删除的 `herdr_use` 仍留在 6 处断言与固件里:

| 位置 | 内容 | 影响 |
| --- | --- | --- |
| `rule-engine/tests/main.test.ts:1008` | 固件 `reason: "bash 里不要跑 herdr 命令: 改用 herdr_use（pane）"` | 断言不校验真实文案 |
| `rule-engine/tests/main.test.ts:1030` | 同上 | 同上 |
| `rule-engine/tests/consumerGuard.test.ts:137` | 固件 `reason: "用 herdr_use"` | 同上 |
| `rule-engine/tests/consumerGuard.test.ts:148` | 同上 | 同上 |
| `behavior-correction/tests/main.test.ts:141` | 正则 `/herdr_use\|pane_\|tab_/` | 靠兜底分支匹配通过 |
| `security-guard/tests/guard.test.ts:2520` | `!TOOL_SURFACE.registered.includes("herdr_use")` | 刻意负断言, 保留 |

这些断言匹配的是旧名与通配分支;当前指路文案已是 `herdr_run` / `herdr_text` / `herdr_key`。

#### 1.7 代码文件过长

311 个 `src` 文件里, 超过 1000 行的有 15 个, 超过 800 行的 20 个, 超过 600 行的 31 个, 超过 400 行的 70 个。最长的一批:

| 文件 | 行数 |
| --- | --- |
| `TUI/src/app/index.ts` | 6601 |
| `TUI/src/app/adapter/dsh.ts` | 4647 |
| `TUI/src/app/state.ts` | 3388 |
| `TUI/src/app/layout.ts` | 2440 |
| `session-channel/src/index.ts` | 1929 |
| `task-engine/src/main.ts` | 1868 |
| `TUI/src/app/adapter/types.ts` | 1803 |
| `security-guard/src/index.ts` | 1378 |
| `rule-engine/src/engine.ts` | 1261 |
| `agent-group/src/core.ts` | 1251 |
| `auto-approve/src/learn.ts` | 1223 |
| `session-channel/src/alias-words.ts` | 1162 |
| `TUI/src/main.ts` | 1090 |
| `herdr-use/src/actions.ts` | 1084 |
| `task-engine/src/engine.ts` | 1051 |

TUI 一个包占了前四名与 `TUI/src/main.ts` 一处, 单文件 6601 行的 `app/index.ts` 为全仓最长; 插件侧的超长文件集中在 `session-channel`(两个)、`task-engine`(两个)与 `security-guard` / `rule-engine` / `agent-group` / `auto-approve` / `herdr-use` 各一个。

#### 1.8 判断散落

同一语义的判断分布在多个位置:条件不在它所属的那一步, 而是出现在调用方、渲染层或另一个包里。扫描口径是同一条 `if` 条件出现在 2 个以上文件, 或同一字符串字面量比较出现在 2 个以上文件(`tmp/scan-conds.mjs`)。仓内较集中的几组:

| 语义 | 判断位置 | 分布 |
| --- | --- | --- |
| 沙箱模式枚举 | `herdr-use/src/types.ts:90` 与 `script-interpreter/src/types.ts:14` 各声明一份 `"read-only" \| "workspace-write" \| "danger-full-access"`;判定在 `herdr-use/src/policy.ts:50`;展示映射在 `TUI/src/app/layout.ts:278` | 4 个文件 / 3 个包 |
| 时钟能力探测 | `clock.now !== "function"`、`clock.scope !== "function"`、`effect !== "function"`、`.then === "function"` 各出现在各包 `src/timers.ts` 一类文件 | 11 / 11 / 9 / 9 个包 |
| 用户消息识别 | `role === "user"` 与 `kind === "user"` 在 `TUI/src/app/index.ts`、`commands.ts`、`adapter/*`;`delivery.kind === "user"` 在 `layout/pipeline/replay.ts:307`、`sections.ts:641` 起 | 34 处 / 2 层 |
| 按键分派 | `name === "…"` 集中在 `TUI/src/app/index.ts` (`down` 在 `:2545`、`:2551`、`:2593` 等处重复) | 72 处 / 1 个文件 |
| 上下文对象守卫 | `ctx === null \|\| typeof ctx !== "object"` 分布在各包入口 | 15 个包 / 18 个文件 |
| 记忆层级判定 | `tier === "session"` 在 `memory-base/src/scope.ts:93`、`:99`、`index.ts:341`、`:385`、`tiers.ts:145` 与 `TUI/src/app/index.ts:5843` | 6 处 / 4 个文件 / 2 个包 |

### 2. 文档存在的问题

#### 2.1 断链

全仓 106 条断链里, 98 条出自已归档文档 (归档按历史原件保留, 不修)。非归档来源的 8 条全部指向 `docs/implementation/…`, 文件已移入 `docs/archived/`:

| 来源文件 | 指向 |
| --- | --- |
| `agent-group/docs/DESIGN.md` | `docs/implementation/2026-10-19-agent-group-tui.md` |
| `auto-approve/README.md` | `docs/implementation/2026-10-23-herdr-terminal-readonly.md` |
| `coagent/README.md` | `docs/implementation/2026-10-22-coagent.md` |
| `coagent/docs/DESIGN.md` | `docs/implementation/2026-10-22-coagent.md` |
| `herdr-use/README.md` | `docs/implementation/2026-10-23-herdr-use-terminal-surface.md` |
| `rule-engine/README.md` | `docs/implementation/2026-10-21-behavior-correction.md` |
| `tool-consult/README.md` | `docs/implementation/2026-10-22-tool-consult.md` |
| `docs/host/HOST-UPGRADE-0.2.1-rc.2.md:106` | `docs/implementation/2026-10-19-dsh-update-check.md` |

成因是同一个动作:追踪文档从 `implementation/` 移入 `archived/` 后, 正文里的引用没跟着改。

#### 2.2 文档与代码不一致

包数口径 7 处仍是旧值:

| 位置 | 写的值 |
| --- | --- |
| `docs/WORKFLOW-STANDARD.md:11` | 28 个插件包 |
| `docs/ROADMAP.md:10` | 28 个插件包 |
| `docs/STATUS.md:14` | 32 个插件 |
| `docs/ARCHITECTURE-REUSE.md:3` | 31 个包 (TUI + 30 插件) |
| `README.zh.md:165` | 31 个包 |
| `md-logic/README.md:55` | 29 个包 (TUI + 28 插件) |
| `docs/host/HOST-PACKAGES.md:864` | 29 个包 |

实测为 34 个包 (TUI + 33 插件)。宿主版本 2 处停在上一版:`README.md:176` 与 `README.zh.md` 的索引仍把 `HOST-UPGRADE-0.2.1-rc.2.md` 当最新升级对照, 而 `rc.3` 那份已存在、`docs/STATUS.md:15` 也已写 `0.2.1-rc.3`。

`DESIGN.md` 的规则与现状差一条:豁免名单列 18 个轻量包, 实际没有 `DESIGN.md` 的是 19 个, 差在 `tool-consult`。19 个包是:`ast-tools`、`auto-approve`、`background-daemon`、`behavior-correction`、`clock-base`、`context-report`、`escalation-hint`、`fs-digest`、`goal-contract`、`hash-edit`、`herdr-integration`、`herdr-use`、`md-table-check`、`metric-loop`、`script-interpreter`、`security-guard`、`session-paths`、`session-title-cutoff`、`tool-consult`。

旧包名复核:`herdr-pane` / `intercom` / `knowledge-base` 在现行文档里共 21 处命中 (9 个文件), 逐条看都不是过期使用 —— 2 处 `herdr pane` 指外部工具而非包名, `herdr-use/README.md:7` 引用的是归档文件名本身, 其余是「原名」说明与关闭注记。只有 `docs/host/DSH-CTX-API.md:8` 用旧名 `knowledge-base` 列插件, 该目录按自身规则处理。能力声称与实现的一致性尚未核对 (工具注册写法不统一, 按字符串只能提取到 27 个名字, 与「46 个模型侧工具」口径对不上)。

#### 2.3 重复记录与结构

已归档 378 篇占全部 Markdown 的 76%, 同主题反复成这样:

| 目录 | 主题词 | 篇数 | 文件 |
| --- | --- | --- | --- |
| `docs/archived` | guard | 17 | `2026-10-02-guard-checkseam-hardening`、`-guard-command-layer`、`-guard-plugin-writers`、`-guard-read-tools`、`-guard-receipt-keypath`、`-guard-residuals`、`-guard-truncation-conservative`、`-guard-unknown-tool-escape`、`-guard-unknown-tool-gaps`、`-guard-unknown-tool-policy`、`2026-10-02-tui-guard-read-consistency`、`-tui-local-shell-guard`、`2026-10-04-install-sh-title-guard-decoupling`、`-install-sh-title-guard-residuals`、`2026-10-08-test-install-guard-count`、`2026-10-24-behavior-readonly-view-guard`、`2026-10-24-security-guard-command-position` |
| `docs/archived` | tool | 12 | `2026-10-02-ast-tools-model-tools`、`-guard-read-tools`、`-guard-unknown-tool-escape`、`-guard-unknown-tool-gaps`、`-guard-unknown-tool-policy`、`-newly-surfaced-tools-adjudication`、`-tool-surface-script-boundary`、`2026-10-04-tui-tool-result-empty-placeholder`、`2026-10-24-rule-engine-tool-result-context`、`2026-10-24-tool-description-review`、`2026-10-25-tool-consult-matcher-review`、`2026-10-25-tool-description-lint` |
| `docs/archived` | script | 10 | `2026-10-02-script-invisible-faces`、`-script-known-boundaries`、`-script-name-mismatch`、`-script-name-residuals`、`-script-scan-face-broadening`、`-tool-surface-script-boundary`、`2026-10-16-script-interpreter-design`、`2026-10-22-mcp-script`、`2026-10-24-tool-description-review`、`2026-10-25-tool-description-lint` |
| `docs/archived` | install | 8 | `2026-10-03-install-sh-followups`、`2026-10-04-install-sh-title-guard-decoupling`、`-install-sh-title-guard-residuals`、`-install-sync-prune`、`2026-10-08-install-sync-rename-residue`、`-test-install-guard-count`、`2026-10-24-install-profile-parity`、`2026-10-27-install-dual-profile` |
| `TUI/docs/archived` | question | 10 | `2026-09-26-question-focus-indicator`、`-question-panel-windows-bell-defects`、`-question-source-and-option-format`、`-question-split-ratio`、`2026-09-27-multi-question-symbol-row-color`、`-question-custom-caret`、`-question-source-markdown`、`2026-09-30-question-panel-residue`、`2026-10-01-question-caret-wrap`、`2026-10-07-question-current-symbol-filled` |
| `TUI/docs/archived` | block | 10 | `2026-10-01-code-block-gutter`、`-history-block-split`、`2026-10-10-helper-lines-and-block-merge`、`-user-block-terminal-symbol`、`2026-10-11-block-identity`、`2026-10-12-user-block-status-dedupe`、`2026-10-13-tool-block-display`、`2026-10-18-user-block-balance`、`2026-10-22-code-block-tab`、`-user-block-right-gap` |
| `TUI/docs/archived` | status | 9 | `2026-09-26-status-mark-recommend-symbol`、`2026-09-27-status-column-agents`、`2026-09-29-session-alias-status`、`2026-10-01-status-agents-live-only`、`2026-10-10-restore-status-and-tools`、`2026-10-12-live-user-status-attribution`、`-status-column-boxes`、`-status-column-scroll`、`-user-block-status-dedupe` |
| `TUI/docs/archived` | approval | 7 | `2026-09-26-approval-focus-window`、`-approval-hint-input-area`、`-approval-inline-hint`、`-approval-interaction-batch`、`-approval-timeout-config`、`-approval-timeout-semantics`、`2026-10-16-approval-timeout-audit` |
| `TUI/docs/archived` | width | 7 | `2026-10-01-lazy-width-table`、`2026-10-04-width-table-symbol-range`、`2026-10-12-boxcache-width-override-regression`、`-width-symbols-memory`、`2026-10-16-width-probe-timing`、`2026-10-18-tui-activity-and-width`、`2026-10-27-separator-width` |

文件名省略了统一的后缀 `.md`, 也省略了同一天重复的前缀日期。结构上还留着空目录:`docs/implementation/` 已空, 4 个包 (`auto-approve`、`session-channel`、`task-engine`、`tool-consult`) 仍有空的 `docs/implementation/`。

#### 2.4 符号与格式口径

禁用变体共 20 种, 实测 20 种全部命中, 合计 159 处、涉及 26 个文件。其中 `symbol-normalizer/README.md` 是在正文里列变体作为规则示例, 剔除它之后实际遗漏为 136 处、25 个文件。按变体逐项:

| 变体 | 应为 | 次数 | 文件数 | 涉及文件 |
| --- | --- | --- | --- | --- |
| `✔` | `✓` | 33 | 9 | TUI/README.md、TUI/docs/archived/2026-09-28-init-cwd-resolution.md、TUI/docs/archived/2026-10-16-approval-timeout-audit.md、session-title-cutoff/docs/archived/2026-10-21-title-fallback-config-split.md、symbol-normalizer/README.md、symbol-normalizer/docs/archived/2026-09-29-mask-code-spans.md、symbol-normalizer/docs/archived/2026-09-29-symbol-guide.md、symbol-normalizer/docs/archived/2026-10-07-goal-symbols-regression.md、symbol-normalizer/docs/archived/2026-10-07-guide-punctuation-and-symbol-spacing.md |
| `✅` | `✓` | 36 | 7 | TUI/docs/archived/2026-09-27-symbol-consumer-change.md、TUI/docs/archived/2026-10-16-width-probe-timing.md、archive/TUI-COMMANDS-TASKS.md、archive/TUI-REFACTOR-TASKS.md、docs/archived/2026-09-27-rule-engine-consumer-and-integration.md、docs/archived/2026-10-02-command-layer-residuals.md、symbol-normalizer/README.md |
| `☑` | `✓` | 2 | 2 | TUI/docs/DESIGN.md、symbol-normalizer/README.md |
| `✕` | `✗` | 1 | 1 | symbol-normalizer/README.md |
| `✖` | `✗` | 18 | 10 | TUI/docs/archived/2026-09-28-init-cwd-resolution.md、TUI/docs/archived/2026-10-16-width-probe-timing.md、docs/archived/2026-10-04-bootstrap-kickoff-order.md、docs/archived/2026-10-25-clock-base-parallel-flake.md、hash-edit/docs/archived/2026-10-02-render-arg-order.md、md-table-check/docs/archived/2026-10-16-limit-zero-unbounded.md、md-table-check/docs/archived/2026-10-16-test-coverage-and-tsconfig.md、rule-engine/docs/archived/2026-10-16-session-predicates.md、rule-engine/docs/archived/2026-10-16-test-coverage-and-defects.md、symbol-normalizer/README.md |
| `✘` | `✗` | 1 | 1 | symbol-normalizer/README.md |
| `❌` | `✗` | 16 | 5 | TUI/README.md、symbol-normalizer/README.md、symbol-normalizer/docs/archived/2026-09-29-mask-code-spans.md、symbol-normalizer/docs/archived/2026-09-29-symbol-guide.md、symbol-normalizer/docs/archived/2026-10-07-guide-punctuation-and-symbol-spacing.md |
| `🗙` | `✗` | 1 | 1 | symbol-normalizer/README.md |
| `☒` | `✗` | 2 | 2 | TUI/docs/DESIGN.md、symbol-normalizer/README.md |
| `🗷` | `✗` | 2 | 2 | TUI/docs/DESIGN.md、symbol-normalizer/README.md |
| `🗸` | `✓` | 1 | 1 | symbol-normalizer/README.md |
| `🗹` | `✓` | 2 | 2 | TUI/docs/DESIGN.md、symbol-normalizer/README.md |
| `⚠` | `△` | 9 | 4 | TUI/docs/archived/2026-09-27-noninteractive-backlog-batch.md、TUI/docs/archived/2026-10-01-lazy-width-table.md、symbol-normalizer/README.md、symbol-normalizer/docs/archived/2026-10-07-goal-symbols-regression.md |
| `➔` | `→` | 2 | 1 | symbol-normalizer/README.md |
| `➜` | `→` | 1 | 1 | symbol-normalizer/README.md |
| `➡` | `→` | 17 | 4 | TUI/docs/SPEC.md、TUI/docs/archived/2026-10-01-lazy-width-table.md、TUI/docs/archived/2026-10-16-width-probe-timing.md、symbol-normalizer/README.md |
| `➠` | `→` | 3 | 2 | TUI/docs/archived/2026-10-01-lazy-width-table.md、symbol-normalizer/README.md |
| `➢` | `→` | 3 | 2 | TUI/docs/archived/2026-10-01-lazy-width-table.md、symbol-normalizer/README.md |
| `➣` | `→` | 3 | 2 | TUI/docs/archived/2026-10-01-lazy-width-table.md、symbol-normalizer/README.md |
| `⬅` | `←` | 6 | 3 | TUI/docs/SPEC.md、TUI/docs/archived/2026-10-01-lazy-width-table.md、symbol-normalizer/README.md |

规律很集中:`✔` 与 `✅` 两项就占了一半以上, 且大头在 `archive/` 与 `session-title-cutoff/docs/archived/` 的历史记录里; `➡` / `➠` / `➢` / `➣` / `⬅` 这几项几乎全部来自 `TUI/docs/archived/2026-10-01-lazy-width-table.md` 与 `-10-16-width-probe-timing.md` 两份追踪文档。现行文档中仍有命中: `TUI/README.md`(`✔` `❌`)、`TUI/docs/DESIGN.md`(`☑` `☒` `🗷` `🗹`)、`TUI/docs/SPEC.md`(`➡` `⬅`)。

表外符号 (`§` 1654、`─` 884、`①` 639、`⟳` 74) 属文档体系自带的排版符号, 与回复侧白名单不是同一套口径。

#### 2.5 术语不统一

这里分三类:同一概念的多种写法、从英文直译来的术语、历史改名留下的双名。

##### 2.5.1 同一概念多种写法

同一概念在现行文档里有两种以上写法的情况:

| 术语对 | 用量 | 同一文件里两种都用 |
| --- | --- | --- |
| 模块 / 包 / 插件包 | 149 / 766 / 10 | `AGENTS.md`、`README.zh.md`、`TUI/README.md`、`TUI/docs/BACKLOG.md`、`TUI/docs/DESIGN.md`、`TUI/docs/SPEC.md` |
| 符号规范 / 符号规则 | 19 / 8 | `TUI/README.md`、`TUI/docs/DESIGN.md`、`docs/BACKLOG.md`、`symbol-normalizer/README.md` |
| 工具面 / 工具集 | 56 / 11 | `AGENTS.md`、`README.zh.md`、`docs/host/` 3 份 |
| 审阅 / 评审 | 28 / 17 | `TUI/README.md` |
| 决策项 / 决策点 | 23 / 1 | 无 (单点例外) |
| 回执 / 返回体 | 86 / 2 | `session-channel/README.md`、`session-channel/docs/DESIGN.md` |
| 过程记录 / 追踪文档 | 39 / 149 | `AGENTS.md`、`TUI/docs/BACKLOG.md`、`auto-approve/docs/BACKLOG.md`、`docs/ARCHITECTURE-REUSE.md`、`docs/BACKLOG.md` 等 8 份 |

「模块 / 包 / 插件包」一组并存的具体形态:`AGENTS.md` 定义「模块 = TUI 与 33 个包」, 同段文字里出现「34 个包」「33 个插件」「33 个包」三种写法, `docs/WORKFLOW-STANDARD.md:11` 写「28 个插件包」。「过程记录 / 追踪文档」在 `docs/archived/` 里指同一份文件的不同阶段, 正文两种都用。数量断言不带单位说明, 单看「33 个包」无法判断是否含 TUI。

##### 2.5.2 翻译腔术语

术语从英文直译而来, 中文读者要额外解释才能对上意思。现用量如下:

| 术语 | 用量 | 来源 |
| --- | --- | --- |
| 回归 | 51 处 / 12 文件 | regression |
| 回执 | 86 处 / 20 文件 | receipt |
| 落盘 | 82 处 / 29 文件 | persist to disk |
| 兜底 | 120 处 / 42 文件 | fallback |
| 服务面 / 工具面 / 事件面 | 109 / 56 / 14 处 | surface |
| 冒烟 | 16 处 / 11 文件 | smoke test |
| 灰区 | 13 处 / 5 文件 | grey area |
| 旁路 | 9 处 / 6 文件 | bypass |
| 收口 | 8 处 / 5 文件 | close out |
| 骨架 | 6 处 / 5 文件 | skeleton |
| 影子 | 4 处 / 3 文件 | shadow |

覆盖最广的是「兜底」(120 处 / 42 文件) 与「落盘」(82 处 / 29 文件), 两者在正文里极少带首次解释。「工具面」「服务面」「事件面」是 surface 的逐字直译, 与中文里的「面」无关联。「挂载」386 处 / 50 文件, 属 dsh 与 cordis 的协议术语。

##### 2.5.3 历史改名留下的双名

同一对象因重构换过称呼, 新旧两种写法都还在现行文档里。

| 同一对象 | 现用名 (与代码对应) | 旧名 / 别名 | 用量 | 两种并存的文件 |
| --- | --- | --- | --- | --- |
| 对话主区域 | 活动区 (`activityH` / `activityW` / `activityScroll`) | 回合区、对话区 | 143 / 18 / 9 | `TUI/README.md`、`TUI/docs/BACKLOG.md`、`TUI/docs/DESIGN.md`、`TUI/docs/SPEC.md` |
| 底部输入区域 | 输入区 (`inputText` / `inputCursor` / `inputMode`) | 输入框 | 42 / 24 | `TUI/README.md`、`TUI/docs/COMMANDS-SPEC.md`、`TUI/docs/DESIGN.md`、`TUI/docs/SPEC.md` |
| 顶部状态区域 | 状态列 (`statusColumn` / `StatusColumn.ts`) | 状态栏 | 89 / 34 | `TUI/README.md`、`TUI/docs/DESIGN.md`、`TUI/docs/SPEC.md`、`TUI/docs/design/AUDIT-colors.md` |
| 底部提示行 | 提示行 | 底部提示 | 15 / 3 | `TUI/README.md`、`TUI/docs/DESIGN.md`、`TUI/docs/SPEC.md` |
| 跨会话消息包 | `session-channel` | `intercom` | 现行文档只剩历史说明 | 无 |
| 记忆包 | `memory-base` | `knowledge-base` | 现行文档只剩「原名」说明 | 无 |
| 终端工具包 | `herdr-use` | `herdr-pane` | 现行文档只剩历史说明与归档文件名 | 无 |
| 定时器包 | `clock-base` | `timer` | 现行文档只剩历史说明 | 无 |

界面四组的代码侧命名分别是 `activity*`、`input*`、`statusColumn` 与 `TUI/src/app/components/StatusColumn.ts`;文档里的「回合区」「对话区」「输入框」「状态栏」在代码中找不到对应标识符。包名四组只出现在历史说明与归档文件名里。

### 3. 当前明确的规范

#### 3.1 变更流程

标准流程由 `AGENTS.md` 与 `docs/WORKFLOW-STANDARD.md` 规定:开工前必须在对应层 `BACKLOG.md` 有可执行条目, 条目写法固定为 `**#n 标题**〔状态: 日期〕（登记日）：现象 → 期望 → 优先级 → 来源`, 编号仅供阅读且每次整理从 1 重排;开工时把接取条目改「进行中」并建 `docs/implementation/<YYYY-MM-DD>-<slug>.md`, 文件头列全部接取条目、先写「计划改动文件清单」;过程中只改清单内文件, 计划外一律不碰;完成时条目标「完成」并从 BACKLOG 移除、追踪文档移入 `archived/`。流程还在四处阻塞询问是否提交:决策后 (仅文档)、代码实现后 (先 `npm run check` + `npm run build` 再提交代码)、测试通过且人工确认后 (代码 + 用例)、关闭后 (剩余全部, 且是本次最后一次提交)。

`docs/WORKFLOW-FAST.md` 管小改动:入口不设硬阈值但 agent 判定后必须先问用户, 提交前用 `git diff --numstat` 复核「文件 ≤ 3 且增删合计 ≤ 50 行」, 不达标须三选一 (转标准流程 / 维持快速流程 / 停手);免 BACKLOG 条目与追踪文档, 唯一记录是 commit message;验证按类型分, 文档类 `format` + 自查 diff, 代码类 `check` + `build` + `test`;同一任务只走一条流程且可升不可降。

#### 3.2 语言与文档形态

语言口径是文档、注释、commit message 写中文, 代码走 TypeScript;根 `README.md` 为英文主档、`README.zh.md` 为中文版, 两侧逐节同构, 改一侧必须同步另一侧;各包 `README.md` 用中文并固定在包根。文档分层为 `docs/` (项目级)、`docs/host/` (宿主面知识, 不参与变更流程, 按自身「过期条件」复核)、`<模块>/docs/` (DESIGN / BACKLOG / implementation / archived)、根 `archive/` (只放根级历史)。`DESIGN.md` 的口径来自 2026-10-04 的裁定:有独立架构与机制沉淀的包必须有, 轻量包豁免并逐名列入 `AGENTS.md`;现状是 15 个包有 `DESIGN.md`、19 个没有, 豁免名单 18 条, 两者差一个 `tool-consult`。

#### 3.3 类型与构建

34 个 `tsconfig.json` 同构:`target` 与 `lib` 为 ES2022, `module` 与 `moduleResolution` 为 NodeNext, 打开 `strict`、`noUncheckedIndexedAccess`、`skipLibCheck`、`esModuleInterop`、`forceConsistentCasingInFileNames`、`declaration`、`sourceMap`、`rewriteRelativeImportExtensions`、`verbatimModuleSyntax`, `rootDir` 为 `.`、`outDir` 为 `dist`, `include` 覆盖 `src` / `tests` / `examples`。每包三个脚本固定:`build` 是 `tsc -p tsconfig.json`、`check` 是同一命令加 `--noEmit`、`test` 是 `node --experimental-transform-types --test 'tests/*.test.ts'`;根 `package.json` 用 `npm --prefix` 把 34 个包串成 `check` / `build` 两条链, `test` 走 `scripts/test-parallel.sh` 并行跑单包。`engines` 也是统一的 `node >= 22.19.0` (34/34)。这套口径能挡住类型错误, 但挡不住未使用符号:8 个包的 `tsconfig.json` 里还留着 `"exclude": ["tests/clock.test.ts"]`, 而那个文件在这些包里并不存在, 属复制遗留, 没有任何检查会发现它。

#### 3.4 格式化

格式化不靠仓库内配置, 靠外部脚本 `/home/guochang/fff/scripts/format` 按扩展名分派:`.ts` / `.tsx` / `.js` / `.mjs` 走 prettier, `.md` 走 mdformat, `.yaml` / `.yml` 走 yq, 无注释 `.json` 走 jq (四空格缩进), 带注释的 JSON 与 JSONC 走 prettier 的 jsonc 解析器。三类文件被显式跳过:手工维护的 dsh patch YAML (`cordis.patch.yml` / `profiles/**`) 因 yq 会吞注释与 `!!js` 标签、首行是 YAML front-matter 的 Markdown 因 mdformat 会把整块改写成水平线、`tests/fixtures/*.json` 因重排会产生大片无意义 diff。提交前对改动文件跑一次, 是这套流程里唯一的格式门禁。

#### 3.5 集成契约与部署

每个包在 `package.json` 里用 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`, `files` 固定列 `dist` / `LICENSE` / `README.md` / `cordis.patch.yml`, patch 内容形如 `insert: [{ id: <包名>, name: "@dsh-toolset/<包名>" }]`。部署侧由 `scripts/install.sh` 生成 profile:`fff` 用 `file:` 快照、`fff-test` 用 `link:` 软链, 两个 profile 挂载同一组 34 个 bundle。契约与实物有一处脱节:5 个包 (`coagent` / `code-map` / `command-template` / `herdr-integration` / `session-channel`) 的 `files` 列了 `LICENSE`, 仓库里却没有这个文件。

#### 3.6 符号规范

规则本身很具体:36 个符号的白名单 (`✓` `✗` `△` `→` `←` `▶` `■` `◆` `ⓘ` 等), 禁 emoji 与列宽不定、带填色的字符, 20 条变体映射 (`✔` → `✓`、`✅` → `✓`、`✖` → `✗`、`⚠` → `△`、`➡` → `→` 等), 中文标点改写成 ASCII 标点并在其后留空格, 非 ASCII 符号后也留空格, 行内代码与围栏代码块内的符号不参与审查。执行点只有一个:`symbol-normalizer` 在回复侧做展示归一与回合审查, 文档正文、代码注释、commit message 都不在它的作用范围, 所以 62 处禁用变体与 `§` / `─` / `①` 一类表外符号能在仓库里长期存在。

#### 3.7 缺位

仓库内没有 ESLint / Prettier / markdownlint / `.editorconfig` 任何一份配置, 没有 `.github/workflows` 之类的 CI, 没有断链检查, 也没有 CHANGELOG。可自动判定的门禁只有两套:`tsc --noEmit` 与 `node --test`, 其余规则(条目写法、文档分层、`DESIGN.md` 是否该有、符号白名单、包数口径)全靠人读与 agent 自觉。

### 4. 行业主流规范

#### 4.1 代码静态检查

`typescript-eslint` 提供四档共享配置:`recommended` 只含不需要类型信息的正确性规则, `recommended-type-checked` 在其上增加需要类型信息的规则, `strict` 与 `strict-type-checked` 更主观, 官方声明这三档不受 semver 稳定承诺, 规则集可随次版本变化;用类型档还要在 `languageOptions.parserOptions` 里配 `projectService`, 用编译时间换精度([Shared Configs](https://typescript-eslint.io/users/configs/))。死代码交给 `knip`:它从入口文件出发建引用图, 报告未被任何入口触达的文件、无人 import 的导出、未使用的依赖与 devDependencies、以及 `package.json` 未列却 import 的依赖, workspaces 是一等公民;局限是入口不全或动态 import 会误报, 官方建议在 `knip.json` 补齐入口后渐进接入, 老的 `ts-prune` 与 `depcheck` 已归档, 迁移文档直接指向 `knip`([Issue Types](https://knip.dev/reference/issue-types)、[Comparison](https://knip.dev/explanations/comparison-and-migration))。tsc 自身也有一层廉价兜底:`noUnusedLocals`、`noUnusedParameters`(下划线开头参数豁免)、`noImplicitReturns`、`noFallthroughCasesInSwitch` 都不在 `strict` 里, 需显式打开;它们与 ESLint 同名规则重叠, 只应保留一处报错([TSConfig Reference](https://www.typescriptlang.org/tsconfig/))。Prettier 只管格式、linter 只管缺陷, 官方明确两者分工, 不重叠([Prettier vs. Linters](https://prettier.io/docs/comparison))。本仓现状:34 个 tsconfig 已带类型信息;仓库内无 lint 配置与死代码检查。

#### 4.2 文档质量检查

`markdownlint-cli2` 把规则按 tags 分组(headings / whitespace / links / table / code / accessibility), 配置落在 `.markdownlint-cli2.*` 或 `.markdownlint.*`, 支持 `--fix`;与本仓痛点直接对应的是 MD001 标题层级只升一级、MD013 行宽(默认 80 列, 长 URL 与表格需放宽, 可用 `stern` / `strict` 调严)、MD024 同名标题(`siblings_only` 允许不同父级重名)、MD051 片段锚点指向真实标题、MD056 表格行列数一致([Rules](https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md)、[markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2))。断链工具的口径差别要分清:`lychee` 是 Rust 单二进制, 外链与本地路径一并查, 异步并发、可出 JSON, 连锚点都有专门配方([lychee](https://lychee.cli.rs/));`remark-validate-links` 离线专查仓内相对路径、heading 锚点与引用定义, 不碰外链([README](https://github.com/remarkjs/remark-validate-links));`markdown-link-check` 只看外链 HTTP 存活, 用 `ignorePatterns` / `aliveStatusCodes` 调整, 不校验锚点与相对路径([README](https://github.com/tcort/markdown-link-check))。`mdformat` 已在用, 它是 CommonMark 格式化器, 默认不改换行以兼容语义换行, 不承担链接校验([mdformat](https://mdformat.readthedocs.io/en/stable/))。本仓现状:无断链检查, 8 条非归档断链靠临时脚本扫出。

#### 4.3 文档组织

Diátaxis 按用户需求把文档分四象限:tutorial 面向学习、how-to 面向任务、reference 面向信息查询、explanation 面向理解, 判位靠「行动还是认知、获取还是应用」两问([Diátaxis](https://diataxis.fr/))。本仓 `README` 属 reference、`DESIGN` 属 explanation、`BACKLOG` 与追踪文档属 how-to, 缺 tutorial 与独立的决策记录。ADR 补的正是后者:一个决策一文件, 命名 `docs/decisions/NNNN-title-with-dashes.md`, MADR 模板给出 Context and Problem Statement、Decision Drivers、Considered Options、Decision Outcome、Consequences、Confirmation 六段, 用 front matter 记 `status`([MADR](https://adr.github.io/madr/)、[ADR](https://adr.github.io/));本仓追踪文档里的「决策」节已经是它的雏形, 只是没有独立索引与状态字段。Keep a Changelog 规定 `Unreleased` 置顶、六类 Added / Changed / Deprecated / Removed / Fixed / Security、最新在前、日期用 ISO 8601, 并明确反对拿 `git log` 充当变更记录([Keep a Changelog](https://keepachangelog.com/en/1.1.0/));本仓没有 CHANGELOG。三者共同的底色是 docs-as-code:文档与代码同仓、同评审、同流水线检查([Write the Docs](https://www.writethedocs.org/guide/docs-as-code/))。

#### 4.4 版本与提交

SemVer 2.0.0 规定 MAJOR 为不兼容变更、MINOR 为向后兼容的新增、PATCH 为修复, `0.y.z` 阶段不承诺稳定, 已发布的版本内容不可再改([SemVer](https://semver.org/))。Conventional Commits 1.0.0 规定提交结构为 `type(scope)!: description` 加可选 body 与 footer, 并给出与 SemVer 的对应:`fix` 对应 PATCH、`feat` 对应 MINOR、`BREAKING CHANGE` footer 或 `!` 对应 MAJOR, footer 的 token 用 `-` 代替空格([Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/))。本仓提交已经按这套写, 但 34 个包的版本号统一停在 `0.1.0`, 没有推进规则。多包场景的版本由 changesets 这类工具承担:每次改动写一个 changeset 文件声明受影响包与 bump 级别, 发布时统一改版本、写 CHANGELOG、联动内部依赖;多包策略分 independent(各自版本)、fixed(同组同版本同发)、linked(联动 bump 但保留各自版本号)三种([changesets](https://github.com/changesets/changesets)、[Fixed Packages](https://changesets.dev/guide/fixed-packages)、[Linked Packages](https://changesets.dev/guide/linked-packages))。npm workspaces 是另一条路:根 `workspaces` 字段把子包软链进根 `node_modules`, 一次 install, 用 `-w` 指定包跑脚本, 代价是包间依赖必须显式声明([npm workspaces](https://docs.npmjs.com/cli/v10/using-npm/workspaces));本仓用的是「根脚本逐个 `npm --prefix` 委托」, 与 workspaces 不是同一套机制。本仓现状:无发布流程, 包间依赖走宿主 profile。

#### 4.5 仓库卫生与自动化

`.gitignore` 的规则按目录作用域生效, 支持 `!` 反选, 排查用 `git check-ignore -v`;只对未跟踪文件生效, 已跟踪的产物必须先 `git rm --cached` 才失效([gitignore](https://git-scm.com/docs/gitignore))——本仓现状:`tmp/` 110M 未跟踪。CI 的常见编排是把 ESLint、`tsc --noEmit`、markdownlint、断链检查拆成独立 job 各自缓存;外链检查受网络与限流影响, 宜允许失败或只在 PR 跑, 免得抖动阻塞合并([GitHub Actions](https://docs.github.com/en/actions/get-started/continuous-integration));本仓无 CI。本地钩子是另一层:husky 通过 `core.hooksPath` 装 hook, lint-staged 只对暂存文件跑检查并自动 stash 备份, 但钩子可被 `--no-verify` 绕过、新克隆还要装一次, 所以关键检查仍须在 CI 重复一遍, 全量 `tsc` 与测试留给 CI([husky](https://typicode.github.io/husky/)、[lint-staged](https://github.com/lint-staged/lint-staged))。

### 5. 当前规范与行业规范的差距

把第 3 节的现行规范与第 4 节的行业做法逐维度对齐, 结果如下:

| 维度 | 当前规范 | 行业做法 | 差距 |
| --- | --- | --- | --- |
| 类型检查 | 34 个 tsconfig 统一 strict + noUncheckedIndexedAccess | 同一基线, 另开 noUnusedLocals 等四项 | 未使用符号无人报 |
| 静态检查 | 无 lint 配置 | typescript-eslint 类型档 + knip | 21 处死导出与跨包重复长期存在 |
| 格式 | 外部 `format` 脚本, 按扩展名分派 | Prettier 配置入库, 与 lint 分工 | 依赖仓库外脚本, 版本不可控 |
| Markdown 结构 | 无 | markdownlint-cli2 (MD001 / 024 / 051 / 056) | 标题层级、表格列数、锚点无人查 |
| 断链 | 无, 靠临时脚本手扫 | lychee 或 remark-validate-links 常驻 | 8 条非归档断链长期存在 |
| 文档组织 | 分层 README / DESIGN / BACKLOG / 追踪文档 | Diátaxis 四象限 + ADR | 缺 tutorial, 决策未独立成 ADR |
| 提交 | Conventional Commits | 同名规范 | 已对齐 |
| 版本 | 34 包统一 0.1.0 | SemVer + changesets | 无发布流程, 暂不适用 |
| 依赖与脚本 | 根脚本逐个 `npm --prefix` 委托 | npm workspaces | 依赖走宿主 profile, 暂不适用 |
| 门禁 | `tsc --noEmit` + `node --test` | CI 拆 job + husky / lint-staged | 无 CI, 无钩子 |

对齐得比较好的有三处:提交信息已按 Conventional Commits 写;类型基线(strict + noUncheckedIndexedAccess)与行业建议一致;文档分层与 Diátaxis 的 reference / explanation / how-to 三象限近似, 只差 tutorial 与独立决策记录。

靠文字约定而非工具判定的有五处:条目写法与追踪文档模板、`DESIGN.md` 豁免口径、包数口径、符号白名单、提交前的人工确认。对应的现状是 7 处包数口径停在旧值、`tool-consult` 不在豁免名单。

本仓与四项行业做法有直接差距:tsconfig 未开四个未使用符号选项、无 lint、无死代码检查、无断链检查入口。changesets 与 npm workspaces 两项在本仓没有对应场景:无发布流程, 包间依赖走宿主 profile 的 `file:` / `link:`。

## 决策

### 1. 总体顺序

本轮分四步推进, 后一步以前一步的产物为准。

1. 开发规范与辅助工具:先定规则 —— 符号与标点口径、注释与文档的写法、`export` 的约定、`package.json` 与 `tsconfig.json` 模板、目录与归档的引用规则、格式化与检查入口。后面三步的每一处改动都照这套规则做。
2. 测试锚定:确认要改的代码已被测试覆盖住现有行为;覆盖不到的先把测试补上, 补不了的记条目并调整改法, 不让改动落在没有锚定的行为上。
3. 改代码:死导出、跨包重复、超长文件、判断散落等按第 1 步的规范改;每处改动跑 `pnpm run check` 与 `pnpm run test`, 保证行为不变。
4. 更新注释与文档:以改完的代码为准, 处理注释里的简写路径与过期计数、文档断链、包数口径、符号与术语, 按最终状态一次改完, 避免二次返工。

### 2. 辅助工具

#### 2.1 工具清单

| 工具 | 状态 | 功能 | 接入位置 |
| --- | --- | --- | --- |
| `typescript`(每包 `devDependencies`) | 已有 | `tsc --noEmit` 查类型, `tsc -p` 出 `dist/` 与 `.d.ts` | 各包 `check` / `build` |
| `node --test` | 已有 | 跑 `tests/*.test.ts`, 靠 `--experimental-transform-types` 直接执行 TS | 各包 `test` |
| `scripts/test-parallel.sh` | 已有 | 34 包测试并行, GNU parallel 为主、xargs 兜底 | 根 `test` |
| `TUI/scripts/test.sh` | 已有 | TUI 单包测试, 把 `--test-name-pattern` 插到文件参数之前 | 根 `test:tui` |
| `scripts/install.sh` | 已有 | 构建 34 包并生成 `fff` / `fff-test` 两个 profile | 部署, 不属日常检查 |
| `format`(仓库外脚本) | 已有 | 按扩展名分派 prettier / mdformat / yq / jq | 提交前对改动文件跑 |
| `pnpm` | 本机已有 | 装依赖、跑脚本;profile 侧本来就用它 | 迁移后所有安装与脚本 |
| `symbol-normalizer`(插件) | 已有 | 回复侧符号归一与回合审查 | 只管对话, 不管仓库文件 |
| `md-table-check`(插件) | 已有 | 检查回复正文的表格列数是否一致 | 同上 |
| `knip` | 待加, 本轮不装 | 报未使用导出、未使用依赖、`package.json` 未列的 import | 根 `devDependencies`, 跑 `lint:dead` |
| `dev/standard/` 检查器 | 待写, 本轮不做 | 符号与标点、术语与旧名、断链、表格列数、注释路径与计数、两个 JSON 的字段与路径 | 挂 `check:docs` |

#### 2.2 命令清单

| 命令 | 状态 | 作用 | 何时跑 |
| --- | --- | --- | --- |
| `pnpm run check` | 已有, 写法从 npm 改过来 | 34 包依次 `tsc --noEmit` | 每次改代码后 |
| `pnpm run build` | 同上 | 34 包编译到 `dist/` | 产物性改动后 |
| `pnpm run test` | 同上 | 34 包测试并行 | 改逻辑后 |
| `pnpm install`(在包目录) | 新增写法 | 安装单包依赖并生成 `pnpm-lock.yaml` | 依赖变动时 |
| `pnpm run check:docs` | 待加 | 跑 `dev/standard/` 检查器 | 改文档后, 与 `check` 一起 |
| `pnpm run lint:dead` | 待加 | 跑 knip | 清理死代码时, 稳定后并入 `check` |
| `format <文件...>` | 已有 | 格式化改动文件 | 改动完成与提交前各一次 |
| `pnpm run test:tui` | 已有, 写法改 | TUI 单包测试 | TUI 迭代 |
| `sh scripts/install.sh` | 已有 | 构建并挂进 profile | 需要真机验收时 |

没有钩子与 CI:检查全靠这几条命令由人或 agent 手动跑。

#### 2.3 待加的两项检查

死代码检查采用 knip, 本轮不安装, 只记条目。落地要定的三件事及取向:作为根 `devDependencies` 安装并提交 `pnpm-lock.yaml`;在 `knip.json` 里按目录声明每包入口(各包 `src/index.ts`, `TUI` 另加 `src/main.ts` 与 `bin`), `dist/` 一律忽略;先以独立脚本 `pnpm run lint:dead` 供清理存量, 稳定后再并入 `pnpm run check`。

预期:knip 的清单会比人工扫出的 21 个多(它连未使用依赖、测试内没用的导出一起报), 清理以它的清单为准;报错里会有一类误报 —— `cordis.patch.yml` 按包名装配的入口, 需要列进 `ignore`, 不能照着报错删代码。

文档与注释检查器自己写, 不引依赖, 放在 `dev/standard/`, 本轮只记决定、不实现。

覆盖范围按文件分四类:Markdown 查符号变体与全角标点、术语与旧名、断链、表格列数 —— 符号查全部 496 篇(归档一并归一), 术语与断链只查 109 篇现行;`.ts` 注释查仓内路径是否写成完整路径、过期计数、已删工具名;`package.json` 查 `main` 与 `types` 是否配套、`files` 里的路径是否真实存在;`tsconfig.json` 查 `exclude` 路径是否存在、基线选项是否齐全。

文本范围:标题、段落、列表、表格单元格在内;行内代码、围栏代码块、链接地址、HTML 注释与 front-matter 不在内。

豁免:`docs/host/` 整目录、`symbol-normalizer/README.md` 的变体表、带「原名」「旧称」的行。死导出与测试断言里的旧名不进自动检查 —— 前者要引用图, 后者要人判断该不该保留。

### 3. 已定的规范

按开发活动分组, 每条只写规则本身;支撑这些规则的实测数据在「调研」一节。

#### 3.1 流程、记录与提交

- 标准流程与快速流程沿用 `AGENTS.md` 与 `docs/WORKFLOW-STANDARD.md`;本轮只把命令写法从 `npm` 换成 `pnpm`, 四个提交检查点与「答否则合并到关闭后」的规则不动。
- 提交信息按 Conventional Commits 写中文;scope 用包名(`fix(session-channel): …`), 跨包改动按类型省略 scope。
- 一次提交对应一个逻辑改动, 不把格式重排与行为改动混在同一提交。
- 改本节任一条规范时, 在同一次提交里改 `AGENTS.md` 的对应段与本节, 并在追踪文档记一句改因。

#### 3.2 代码

- 入口: `src/index.ts` 是每个包唯一出口, 放 `name` / `Config` / `apply`, 需要时再 re-export 对外符号, 不再套一层根 `index.ts`。`TUI` 是可执行包, 入口为 `src/main.ts`, `main` 与 `bin` 同指一份。现状三种形状(根 `index.ts` 13 个、`src/index.ts` 15 个、`src/main.ts` 6 个)按此统一, 产物仍是 `dist/src/`, 不引第二份 tsconfig。
- `export` 面: 除入口外的模块只 `export` 同包内部用的符号;新增导出在同一次提交里要有调用方;无人引用的导出按 knip 清单删除。
- 文件命名: kebab-case 名词短语;只固定 `index.ts`(入口)、`tools.ts`(工具定义)、`types.ts`(对外类型)三个名;不设 `utils.ts` / `helpers.ts` / `common.ts`;职责相近按领域词分(`engine.ts` / `match.ts` / `rules.ts`);`TUI` 组件文件保持 PascalCase(`components/StatusColumn.ts`)。
- 失败: 工具失败抛错, 不返回 `isError`(`isError` 与 `content` 由宿主的 registry 生成);错误类照宿主 `HarnessError` 的做法带稳定 `code`(大写字母加下划线), 上层据 `{ name, code }` 分支而不解析文案;131 处 `throw new Error` 与 4 类包内错误类按此补齐;不引入宿主包 import。
- 包间引用: 只从对方 `src/index.ts` 引, 不 import 对方内部模块;引入方在 `dependencies` 写 `link:../<包>`;被引包必须有 `types` 字段;`TUI` 与插件包之间不互相 import, 插件包之间不形成环。
- 文件长度: 暂不设行数上限, 按职责边界拆(状态与纯函数 / 渲染 / 适配, 副作用与纯函数分开), 一次拆一个文件, 拆完跑该包的 `check` 与 `test`;全部拆完再按实际分布定上限, 候选值 800 与 1000。

#### 3.3 工具面

- 每个包一份 `toToolDef`(单工具)或 `toToolDefs`(多工具), 字段对齐宿主 `ToolDefinition`: `name` / `description` / `parameters` / `output.schema` / `output.render` / `execute`, 不另立形状。
- `description` 写中文, 按「用途 / 用法 / 效果 / 边界 / 相关」五段、每段一行;参数说明写「动作 用: 说明」。
- 文案允许中文标点, 符号仍按 3.9 的白名单。

#### 3.4 配置读取

- 配置形状以宿主契约为准(`docs/host/DSH-CTX-API.md`), 宿主给什么就读什么, 不自行加一层包装。
- 宿主未规定的部分, 每包一份 `resolveConfig(config)`, 缺省值写成同文件顶部的常量, 调用处不再散落 `??` 兜底。
- 配置字段改名时, `resolveConfig` 同时接受旧名并标 deprecated, 下个版本再删;`README.md` 的「配置」节写明旧名与退役版本。

#### 3.5 测试

- 改逻辑的提交必须带用例: 先写一条会失败的用例(红), 修好后转绿, 标题或注释标出处(BACKLOG 条目或追踪文档), 与修复同一次提交;断言指路文案时引用导出的常量, 不写字面量。
- `skip` 与 `todo` 必须写明原因与对应条目, 不留无主跳过。
- 测试与真实环境隔离: 时间走 `clock-base` 的 `ManualClock`, 不读真实时钟;等微任务用 `flush()` 一类工具, 单元层禁 `await sleep`, 集成层必须等真实时间时限时并注明;伪随机用固定种子, 不用 `Math.random`;网络与子进程打桩;临时文件落 `os.tmpdir()` 后删, 仓库目录只读;不读仓库外的固定路径, 不依赖家目录形态。

#### 3.6 构建、检查与格式化

- `package.json` 必填 `name` / `version` / `private` / `main` / `types` / `files` / `engines` / `dsh.bundle`;`main` 为 `dist/src/index.js`, `types` 为 `./dist/src/index.d.ts`, `TUI` 取 `dist/src/main.js` 与 `./dist/src/main.d.ts`;`files` 固定列 `dist` / `README.md` / `cordis.patch.yml`, 仓库里有 `LICENSE` 文件时才列;`scripts` 至少 `build` / `check` / `test` 三项;额外脚本按用途起名 —— 验收类 `demo` / `smoke` / `smoke:<对象>` / `bench`, 开发辅助类 `watch` / `verify` / `inspect` / `gen:<产物>` / `example:<动作>`, 专属检查写 `check:<对象>`, 不新造同义词。
- `tsconfig.json` 34 份保持同构, 不引 `@tsconfig/bases`;`noUnusedLocals` 等四项检查另立条目分阶段开;`tests/tsconfig.json` 只在测试需要不同的 `lib` 或 `types` 时添加;`include` 只列真实存在的路径 —— 固定 `src` 与 `tests`, 有执行入口的加该入口文件, 有 `demo` 或 `examples` 的加该目录, 不用 `tests/*.test.ts` 一类 glob 代替目录;`exclude` 不列不存在的文件。
- 格式化仍由仓库外的 `format` 命令承担, 不引入仓内 Prettier / mdformat 配置;`AGENTS.md` 补全它的绝对路径与三类跳过文件(`cordis.patch.yml` 与 `profiles/**`、带 front-matter 的 Markdown、`tests/fixtures/*.json`)。
- 根 `package.json` 只放开发期工具, 不装运行期依赖;包内 `devDependencies` 保持 `@types/node` 与 `typescript`;新增运行期依赖须说明理由。
- 第三方运行期依赖(现为 `marked`、`redis`, 另两条是包间 `link:`)升级后跑该包的 `check` 与 `test`, 并在追踪文档记版本变化与理由;只升补丁级版本。
- 安装与 lockfile 统一用 pnpm: 34 个包各一份 `pnpm-lock.yaml` 并纳入版本控制(`TUI` / `code-map` / `md-map` 已有的保留, `task-engine` 删掉并存的 `package-lock.json`, 27 个换, `behavior-correction` / `command-template` / `session-title-cutoff` 补齐);34 份 `typescript` 由 pnpm 全局仓库硬链接共享。
- 根 `check` 与 `build` 链改成 `pnpm -C <包> run <脚本>`;覆盖率聚合器放 `dev/coverage/`, 只用 Node 标准库, 由根 `test:coverage` 调起;`scripts/install.sh` 只保留 `npm i -g` 与 `npm root -g` 两处 npm;文档与追踪模板里的命令统一写 `pnpm run check` 一类, 归档文档不改。
- `tmp/` 与各包 `dist/` 继续忽略, `tmp/` 的清理另行决定。

#### 3.7 加包与删包

- 新增一个包时, 同一次提交里备齐九项: `package.json`(3.6 的字段加 `private: true` 与 `dsh.bundle`)、`tsconfig.json`(照抄基线)、`cordis.patch.yml`(3.8 的形态)、`README.md`(3.9 的六节)、`src/index.ts`(契约符号)、`tests/`、按 DESIGN 口径决定有无 `docs/`、根 `package.json` 的脚本链、`AGENTS.md` 的包清单与 `scripts/install.sh:44` 的 `canonical_pkgs`。
- 删包反向做, 并确认除 `archive/` 外没有引用残留。

#### 3.8 集成与部署

- `cordis.patch.yml` 照宿主的 patch 语义写(`@deepseek-ai/dsh-app-boot` 的 profile 文档): 文件是操作列表, 本仓每个包一条 `insert`, 行写 `id` 与 `name`, 需要缺省配置时在该行写 `config`;行字段可用 `id` / `name` / `config` / `disabled` / `inject`, 动态值用 `!!js`;`dsh.bundle.patch` 支持单文件或有序数组, 本仓统一单文件。
- patch 按 id 覆盖整行 `config` 而不合并, 所以文档里不能写「按 id 追加同名字段」(`agent-group/cordis.patch.yml:8` 待改)。
- 行顺序不带加载语义、激活由服务可用性驱动, 所以注释里不能写「要排在使用方之前」(`clock-base/cordis.patch.yml:5` 待改)。
- 开发用 `fff-test`(`link:`), 验收用 `fff` 加 `scripts/install.sh --sync` 刷新;产物性改动先 `pnpm run build` 再重启。
- 改 `TUI` 先 `pnpm run demo` 看 mock 效果, 排版类加 `pnpm run demo -- --smoke`, 真机再进 `TUI/` 跑 `pnpm run smoke:pty` 并用 `fff-test` 验收。

#### 3.9 文档

- 符号: 36 个符号的白名单与 20 条变体映射写进 `AGENTS.md`, 管仓库文档、`.ts` 注释与工具描述一类面向模型的字符串;「中文标点改成 ASCII 标点并在其后留空格」只约束模型回复, 文档、注释与工具文案里的中文标点照写, 检查器不查标点;行内代码与围栏代码块内的符号不参与审查;唯一豁免是 `symbol-normalizer/README.md` 里作为规则示例的变体表。
- 注释: 用中文, 以项目现状为准;引用仓内文件时写从仓库根算起的完整路径;数量紧跟导出常量, 或写成「见 `X`」;不写「供测试 / 诊断用」却没有任何测试或调用方。
- 术语: 模块 / 包 / 插件包 用「包」, 过程记录 / 追踪文档 用「追踪文档」, 符号规范 / 符号规则 用「符号规范」, 工具面 / 工具集 用「工具面」, 决策项 / 决策点 用「决策项」;「回归」指行为时写「退化」、指测试时写「回归测试」;「收口」写「收尾」;「影子」写「另一份」;旧名只在首次出现处写一次「原名 `x`」。
- 引用与归档: 移动或重命名文档时, 在同一次提交里改完全部指向它的引用, 引用保持相对路径;归档文档(387 篇)只做符号归一, 不合并、不改写、不修断链;新追踪文档按 `YYYY-MM-DD-slug.md` 命名, 根 `archive/` 下 13 篇旧名保留;`docs/implementation/` 与 4 个包内空的 `docs/implementation/` 保留作占位。
- 数量与版本断言: 包数一律写「34 个包(TUI 与 33 个插件)」;根 `README.md` 与 `README.zh.md` 的宿主升级索引只写最新一份, 升宿主时在同一次提交里改两份;文档不写死工具数量, 需要时指向代码;增删包时在同一次提交里更新 `AGENTS.md` 的包清单与根 `package.json` 的脚本链。
- 模板: 包 `README.md` 固定六节 `## 定位`、`## 能力`、`## 配置`、`## 用法`、`## 边界`、`## 测试`, 无配置项的包可省 `## 配置`;`DESIGN.md` 固定四节 `## 背景`、`## 结构`、`## 机制`、`## 取舍`;34 份 README 首节 14 种写法归并时只改节名, 内容不动。

#### 3.10 宿主升级

- 四步一起收尾: 复核 `docs/host/` 各篇的「过期条件」段、跑 `pnpm run check` 与 `pnpm run test`、`scripts/install.sh --sync` 后在 `fff` 真机验收、更新根 `README.md` 与 `README.zh.md` 的升级索引。

#### 3.11 版本与发布

- 不发布: 34 个包统一 `0.1.0` 不动, 不引 changesets;`private: true` 34 处补齐(现在 0 处), 防误发;将来要发布再补发布字段(3.6 的 `files`, 必要时加 `exports`)。

#### 3.12 持久化与迁移

- 持久化用 Node 自带的 `node:sqlite`, 不引 ORM 或 `better-sqlite3`(`memory-base`、`output-compress` 已在用);建表与迁移集中在各包 `src/schema.ts`, 建表走 `CREATE TABLE IF NOT EXISTS`, 版本写 `PRAGMA user_version`, 字段变更按版本号递增追加迁移函数, 与建表语句同文件。

#### 3.13 脚本

- `scripts/*.sh` 用 `#!/usr/bin/env sh`;默认 `set -eu`, 需要跑完全部再汇总的脚本(如 `test-parallel.sh`)用 `set -u` 并在末尾按累计结果退出;外部工具先 `command -v` 探测再降级(`install.sh` 的 `have()`, `test-parallel.sh` 的 parallel 与 xargs 两路);脚本里出现包清单时做双向校验, 与仓库目录对不上就告警。

#### 3.14 目录与忽略

- 忽略规则收进根 `.gitignore`, 用 `node_modules` / `dist` / `.pnpm-store` / `.pnpm-cache` 四条覆盖所有层级, 原来单独的 `TUI/dist/` 由 `dist` 取代;34 个包内的 `.gitignore` 删除。
- `dev/` 存放开发期的辅助工具与配套规范(如 `dev/standard/` 下的检查器与规则表), 不参与构建、不发布, 也不出现在任何包的 `files` 里;放在这里的工具只用 Node 标准库, 不引入依赖;新增顶层目录时在 `AGENTS.md` 的目录清单里补一行定位说明。

### 4. 测试锚定

#### 4.1 范围

测试阶段分三类任务, 分别补能力、立锚点、清旧账。

| 任务 | 范围 | 边界 |
| --- | --- | --- |
| 一 分层覆盖 | 34 个包全部;单元 / 集成 / 端到端三层, 端到端本轮只 `TUI` | 只用 `node --test` 与内置覆盖率, 不引第三方框架;不设统一覆盖率阈值;33 个插件的端到端记入「后续意向」 |
| 二 逻辑锚点 | 34 个包全部, 以各包的核心算法与判定为对象 | 输入到输出的特性用例, 断言只经公开导出与数据快照, 不 mock 内部函数;重构后不改断言即通过 |
| 三 清理过时 | 34 个包全部;已知项为 11 处 `skip`(本机触发 2 处)、0 处 `todo`、用例里 6 处 `herdr_use`(2 处负断言保留)、8 个夹具 | 删除优先于改写;删掉的在追踪文档记一句;`skip` / `todo` 能恢复的先恢复 |

落实到代码时按失败代价与可见性分五档, 档内先后用「未覆盖行 × 变更次数 × 分支密度」机械排。

| 档 | 类别 | 包含 | 手段 |
| --- | --- | --- | --- |
| P0 | 安全与数据 | `security-guard` 的命令拆解与判定、`auto-approve` 裁定链、`memory-base` 落盘与迁移、`output-compress` 库写入、`session-paths` 编码 | 单元加集成 |
| P1 | 核心算法 | `TUI` 排版与宽度、`md-logic` 节树与块、`md-map` 索引与断链、`rule-engine` 匹配、`hash-edit` 锚点、`ast-tools` 搜索替换 | 单元 |
| P2 | 契约与状态 | 工具 `execute` 的入参校验与返回、`output.render` 投影、事件消费者注入内容、服务面提供与消费、`session-channel` 键与锁、`agent-group` 结算、`task-engine` 生命周期 | 集成 |
| P3 | 边界与配置 | 空输入、超长、非法参数、`exec.signal` 取消、超时、`resolveConfig` 的缺省与覆盖、适配层事件转换、序列化 | 单元加集成 |
| P4 | 跳过 | 纯 re-export、常量表、`types.ts`、工具描述文案、`cordis.patch.yml` / `package.json` / `tsconfig.json`、`dist/`、第三方库自身行为、不可达分支(注明)、视觉细节(交 `smoke:pty`) | 不写 |

判定规则:有分支且对外可见的必测;无分支的转发跳过;介于两者之间按 P3 补边界。

#### 4.2 层级

三层各管一段, 都用 `node --test`, 不引框架;层与层靠目录区分, 入口分开。

| 层级 | 对象 | 位置与装配 | 断言 |
| --- | --- | --- | --- |
| 单元 | 纯函数、判定与数据结构操作 | `<包>/tests/*.test.ts`;不起宿主, 时间用 `ManualClock`, 文件与网络打桩 | 直接断返回值与抛出的 `code`;每个导出、每类分支至少一条 |
| 集成 | 插件的 `apply` 与宿主接线: 工具注册与 `execute`、事件消费者、服务提供与消费 | `<包>/tests/integration/*.test.ts`;用假工具面、假事件面、假服务面拼 `apply`, 装配器放 `tests/` 下且不以 `.test.ts` 结尾 | 工具返回的 canonical 值与 `output.render` 的投影文本;事件注入后的注入内容;落盘写临时目录再断言 |
| 端到端 | 整条链路 | 本轮只 `TUI`: `demo -- --smoke` 的帧断言与 `smoke:pty` 的真 pty;插件侧见「后续意向」 | 帧内容与终端输出 |

分层靠目录, 因为现有 `tests/*.test.ts` 只匹配一层(`tests/integration/b.test.ts` 不会命中), 集成用例放子目录即可与单元层分开, 不必改包的 `test` 脚本。

入口四条: `pnpm run test` 跑单元层, `pnpm run test:integration` 跑 `tests/integration/*.test.ts`, `pnpm run test:e2e` 跑 TUI 端到端, `pnpm run test:coverage` 出覆盖率报告(判定见 4.3)。现有 `scripts/test-parallel.sh` 继续承担并行, 按层传目录与 glob。

- 归属判据: 依赖宿主服务面或走 `apply` 的归集成, 其余归单元;一条用例两种写法都成立时归单元。
- 是否必备: 有工具面、事件消费者或服务面的包必须有集成层;纯函数包(session-paths 一类)只做单元, 原因写进包 `README.md` 的「测试」节。
- 装配器: 各包自建放 `tests/` 下, 不跨包共享;三个假面(工具 / 事件 / 服务)形状统一, 便于换包复用写法。
- 覆盖率范围: 只统 `src`, 装配器与夹具不计入。
- 耗时与并行: 单元层全包并行;集成层按包并行、单包内串行;端到端不设耗时预算, 但必须能单独跳过。
- 文件与标题: 测试文件与被测模块同名再加 `.test.ts`(`tests/app.test.ts` 对 `src/app.ts`), 集成层同前缀放 `tests/integration/`;标题写「对象: 行为, 期望」的中文短句, 能被 `--test-name-pattern` 命中;存量不改名, 只约束新写与重写的用例。
- 可见面: 同包测试可直接 import `src/` 下的模块;跨包只经对端 `src/index.ts`, 缺导出就在对端补(如 `ManualClock` 由 `clock-base` 导出), 现有 9 个包 11 处直取内部文件的写法一并收口。
- 读源码还是读产物: 用例一律跑 `src`;只有发布形态一类用例读 `dist`, 由交付前的 `build` 保证, 不用 `skip` 兜。
- 包级脚本: 34 个包各三条同构 —— `test`、`test:integration`、`test:coverage`;`TUI` 的 `test` 继续走 `scripts/test.sh` 以支持过滤;根脚本按 `pnpm -C <包> run <脚本>` 串联。
- Flake: 不加重试掩盖;偶发失败先查并行共享状态与真实时钟, 修不掉就标 `skip` 并写条目。

#### 4.3 覆盖率判定

- 指标:行覆盖与分支覆盖, 由 `NODE_V8_COVERAGE` 出原始 JSON 再按文件聚合(零依赖, 与 `node --test` 同进程);只统 `src`, 装配器、夹具与端到端不计。
- 门槛压在改动上:本次改动涉及的 `src` 行必须被用例走到, 走不到就补用例或改写法。
- 整包只升不降:每包记行与分支覆盖, 提交前后对比, 下降即按退化处理;唯一例外是删代码, 一并记入追踪文档。
- 不设统一硬阈值:80% 只作参考数, 不进门禁 —— 存量包差距大, 硬线只会逼出凑数用例。
- 例外:不可达的防御分支不计, 需在用例旁注明理由。
- 分层贡献用两轮跑取差:先只跑单元层, 再跑单元加集成, 差值即集成层贡献。
- 另记两个契约面数字:导出覆盖率(`src/index.ts` 的导出名与被 v8 调用到的函数名取交集)、错误码覆盖率(源码里的 `code` 常量与测试断言过的 `code` 取交集)。
- 产物:`pnpm run test:coverage` 输出 JSON 与每包一张「文件 / 行 / 分支 / 未覆盖行」表, 汇总进追踪文档的「测试与证据」节。

#### 4.4 失效与过时用例

`skip` 只留「本机缺某能力」一类, 其余先处置再收尾。

- 长期空转的两种先清: 依赖已关闭任务的(tool-consult 检索「跨会话委托」的 top-1), 与本仓布局下永远不可解析的(behavior-correction 读 `@dsh-toolset/rule-engine` 的契约探针)。前者收窄为「`channel_delegate` 进前二」并去掉 `skip`, 原 top-1 目标立条目移交描述层;后者删除, 因为对端 `rule-engine/tests/rules.test.ts` 已锁 `CONSUMER_SOURCES` 的内容与顺序, 探针在本仓只 `skip` 不跑。
- 条件式 `skip` 保留五类: 缺二进制、缺解释器、缺宿主包、仓库不在家目录、`dist` 未构建。探测表达式在 `tests/` 顶层算一次, 原因写清缺什么与怎么补;交付记录给出当次触发的条数(本机处理前 2 条, 处理后 0 条), 只在环境变化时重现。
- 不写 `todo`: 要么补用例, 要么立条目, 测试代码里保持 0 处。
- 死符号: 负断言保留, 「旧名不得回流」本身是护栏(`behavior-correction` 与 `security-guard` 各一处);用例里自造的拒绝理由(rule-engine 两处)由 `herdr_use` 改为 `herdr_run`, 与 `behavior-correction` 的实际文案一致。
- 夹具: 只放输入与冻结基线;冻结基线重生成时逐条确认 diff, 不静默重冻;无人引用的夹具直接删, 用例里不留指向已删文件的说明。
- 版本号: 宿主版本号不进新用例的标题与断言, 只在注释里说明来源;升宿主按 `engines` 复核, 不逐版本改名。

#### 4.5 补不了的处置

补不了就写清, 不拿空用例凑数。

- 三条阶梯从上往下走: 先打桩(假工具面 / 假事件面 / 假服务面, `ManualClock` 换真实时钟), 再降级为契约断言(只断输入输出形状与 `code`, 不断真实行为), 都不行才豁免。
- 外部依赖不进 `test`: Redis、pty、herdr 面板、真 LLM、真宿主的版本键面一律不在 `test` 里连;真机验证留 `smoke:pty` 与 `scripts/install.sh --sync` 之后的人工验收, 结果记一行进「测试与证据」。
- 豁免台账一条一行, 写「缺什么 / 为什么补不了 / 触发条件 / 交给谁」;只进追踪文档, 不散在代码注释与包 `README.md` 里。
- 三类写法禁止: 只 `assert.ok(x)` 的兜底断言、为覆盖率而调用的空跑、把 `skip` 当结论。
- 不可达的防御分支按 4.3 豁免, 用例旁注明理由, 并说清是哪条前置条件让它不可达。

#### 4.6 交付

产出是几份可核对的东西, 一次交齐。

- 四份产物: 每包一张覆盖率表(文件 / 行 / 分支 / 未覆盖行, 改前改后两列)、新增与删除用例清单、`skip` 计数与豁免台账、四个入口(`test` / `test:integration` / `test:e2e` / `test:coverage`)的实跑输出。
- 门槛: 34 个包的 `check`、`build`、`test` 全绿;没有包的覆盖率下降;`TUI` 的 `demo -- --smoke` 与 `smoke:pty` 通过;本机 `skipped` 为 0, 环境探测类触发时逐条说明。
- 顺序: 先跑全量取基线, 再补用例, 最后跑对比;代码阶段改完再跑一次, 追加到同一张表。
- 记录: 全部落追踪文档「测试与证据」节, 一包一行, 不另开文档;删掉的用例与夹具在那里记一句;每包 `README.md` 的「测试」节写清跑哪几层、三条命令与缺层原因, 缺层只对纯函数包允许。
- 提交: 只含 `tests/` 下的用例与装配器;为可测性动了 `src` 的并入代码阶段的提交。
- 不做: 不接第三方覆盖率服务, 不为数字补用例, 33 个插件的端到端留「后续意向」。

## 规划

### 计划改动文件清单

### 明确不做

### 后续意向

- 插件端到端: 34 个包各一条端到端用例, 形态为进程内起真宿主 —— 根 `devDependencies` 引 `@deepseek-ai/dsh/profile-boot` 的 `runProfile()`, 用只挂 `dsh-base` 必需子集加被测包的独立测试 profile, 经 `ctx` 的工具面执行工具、注入事件并断言落盘结果。用例放仓库根 `e2e/<包>.test.ts`, 由 `pnpm run test:e2e` 单独跑, 不进 `pnpm run test`;宿主版本随 `engines` 钉住。本轮不做, 待此任务关闭后另开条目。

## 实现记录

## 偏差

## 测试与证据

## 收尾
