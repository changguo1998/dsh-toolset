# 整理历史代码和文档（接取条目：`docs/BACKLOG.md`「整理历史代码和文档」）

状态：调研　　开启：2026-10-28　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

整理仓库全部代码与文档：内容符合现行规范，清理历史开发过程中遗留的旧账（失效引用、过期结论、重复记录、无引用代码、临时产物），先出清单待确认再分批落地。

## 调研

> 来源：第 1 至 3 节为本仓实测（2026-10-28，脚本 `tmp/scan-*.mjs`，输出 `tmp/*.txt`，未入 git）；第 4 节为官方文档检索，来源链接随条目给出。

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

## 规划

### 计划改动文件清单

### 明确不做

## 实现记录

## 偏差

## 测试与证据

## 收尾
