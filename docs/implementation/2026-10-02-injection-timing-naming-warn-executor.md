# 注入时机直写 + slash 命名规范 + 插件告警通道 + task-engine 执行扩展（接取条目：`docs/BACKLOG.md`「注入时机调整：会话开始 / 压缩完成后直写，不等步末」；「slash 命令命名规范：不用缩写」；「插件运行期 stderr 告警显示统一（评估）」；「task-engine 执行扩展」）

状态：实现　　开启：2026-10-02　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按用户指令顺序推进四件事（`#8 → #5 → #7 → #1` 的阅读顺序对应上列条目顺序）：

1. **注入时机调整（P1）**：`rule-engine` 规则支持多节点（`source` 接受数组，用户裁定不拆两条规则）；新增「直写节点」能力（声明在某些节点跳过 `dedupeInRecord` 投影判断）；`symbol-normalizer-guide` 消费者改为「`session-start` + `compaction` 直写、`step-end` 判断后写入」；运行时规则 `skill-autoload` 改挂「会话开始 + 压缩完成」。
1. **slash 命名规范**：盘点本地 / 宿主 / 插件命令的缩写与晦涩名，给出改名清单与兼容策略。
1. **插件告警通道（评估）**：评估各插件运行期 stderr 告警是否统一改结构化通知通道（rule-engine `onNotice` / symbol-normalizer `onReview` 模式）与降噪。
1. **task-engine 执行扩展**：叶子 `executor` 声明与后端适配（model / subagent / workflow / command）、模型与预算声明、隔离落地（git worktree）。

## 调研

### #8 现状（2026-10-02 读码）

- `RuleSource` 是**单值**联合类型（`src/types.ts`）；`NormalizedRule.source` 单值；`compileMatcher(spec, source)` 在**编译期**用 `source` 判定「空条件是否无条件命中」（`BOUNDARY_SOURCES` 含 `session-start` / `compaction`），因此多节点必须把这条判定挪到**判定期**（按触发节点）。
- 投影去重（`dedupeInRecord`）在 `engine.#collectRules` / `#collectConsumers` 内：投影里已有 N 条 → 不产出段（仍记本次命中）。「直写」= 在声明的节点上跳过这次投影计数判断。
- 消费者面已支持多节点（`ConsumerRegistration.sources: readonly RuleSource[]`），且 `compaction` 不在对齐表（每次到达都触发）、`session-start` 是 session 尺度 start（注册即唤醒，无窗口幂等）——多节点无需改对齐逻辑。
- 运行时（仓库外）`~/.dsh/rule-engine/rules.json` 现有 1 条 `skill-autoload`（`source: "step-end"` + `delivery: "steer"` + `dedupeInRecord: 1`）；`symbol-normalizer` 的指南消费者注册为 `sources: ["step-end"]` + `dedupeInRecord: 1`（`src/main.ts`）。
- 会话日志取证（BACKLOG 记录）：`compaction/end` 后第一步没有注入、第二步才补——因为 `compaction` 不是指南与 skill 规则的节点，只能等下一次 `step-end`。

### #5 现状（2026-10-02 盘点完成）

命令面全量：TUI 本地 `LOCAL_COMMANDS` 41 条（36 路由 + 5 别名 `/cls` `/exit` `/thinking` `/usage` `/context`）、宿主注册 6 条（`/compact` `/feedback` `/goal` `/permission` `/plan` `/export`，dsh-base 装配）、插件注册 1 条（`command-template` 的 `/playbook`，模板作为子命令）。缩写 / 晦涩候选 9 项提交用户裁定 → D6 / D7 / D8（只删 `/preset`，其余保留；旧名不留别名；只删命令面）。另发现 `command-template` 的 `/tpl` 残留（注释 + 用户可见错误文案 + `reservedNames` 缺省描述）。

### #7 现状与评估（2026-10-02）

**盘点**：运行期 `process.stderr.write` 写点共 28 处——TUI 13 / rule-engine 4 / metric-loop 2 / symbol-normalizer 2 / session-channel 2 / command-template 2 / task-engine・goal-contract・hash-edit・code-map・session-title-cutoff 各 1；无 `console.*` 写点。

**方案 A 已落地**（2026-10-01）：`TUI/src/app/stderr-bridge.ts`（75 行）接管 `process.stderr.write`，按行交 `App.appendExternalLog` 进活动区；tone 由 `externalLogTone()` 按文本**启发式**判定（`error|fatal` → error；`warn(ing)|警告` → warn；其余 log）；含防递归、多参透传、`restore` 残行透传。

**既有结构化通道**：rule-engine 的 `provide("ruleEngine").onNotice(listener)`（tone 结构化 + 装载期缓冲重放 + 无订阅者回退 stderr）、symbol-normalizer 的 `onReview`（消费者审查事件，非通用告警出口）。

| 维度 | 方案 A（现状） | 逐插件结构化通道 |
| --- | --- | --- |
| 显示位置 | 全部插件已进活动区 ✓ | 同 ✓ |
| tone 准确性 | 启发式（措辞不含关键词时误判） | 精确（结构化 tone） |
| 装载期告警 | 桥安装前的行直写终端（rule-engine 另有自缓冲重放补齐） | 每插件自行缓冲重放 |
| 代码量 | 75 行，一处 | 每插件 15-40 行 + TUI 逐服务接线（10 插件约 300-500 行重复机制） |
| 耦合 | TUI 不需知道插件服务名 | TUI 需逐插件订阅；新增插件都要改 TUI |

**评估结论（建议「不实施」）**：方案 A 已覆盖显示正确性与 headless 兜底，逐插件结构化通道的净增量只有「tone 精确」与「装载期重放」——后者各插件的装载期自证日志本就设计为直写终端（用户可见），前者在现有告警措辞下已被启发式覆盖。若日后出现具体 tone 误判点或需要结构化字段（跨客户端消费），**单点升级**（先例 rule-engine `onNotice`）即可，不必全仓铺开。

### #1 现状（2026-10-02 读码）

- **`executor` 至今零代码**：`task-engine/src`、`tests`、`demo` 全无该字段；只有 `README.md`「边界与外包」把它写成**决策口径**（「叶子可声明 `executor`（`model` = 本会话执行，缺省；后续增补 `subagent` / `workflow` / `command` 后端，由模板或叶子显式声明，引擎不替模型生成脚本）」）。故本条目是绿field 实现，不是改参数。
- **现状可复用的机制**：叶子产出走 `engine.implement(frameId, result)` → `plan/frame-implemented{result}` 事件；验收走 `stop()` → RET（`acceptance.ts`：mechanical 用 `runCommand`、semantic 走 `audit` hook、human 走 `approval`）；`main.ts` 只 `inject: ["tools"]`，其余服务经 `ctx.get()` 读（先例：`approval`）。
- **门禁不含 executor 校验**：`gate.ts#checkDecomposition` 只查粒度四规则 + coverage + deps；新增 `executor` 后其合法性校验（kind 白名单、必填字段、与 `needDecompose: false` 一致）需新增一处，并接入「机械拒绝带反馈打回」通道。
- **计划清单需修正**：`task-engine/docs/{DESIGN,BACKLOG}.md` **不存在**（本包只有根 `README.md`），故 #1 文档落点改为 `README.md`。
- **宿主面**（`docs/host/HOST-PACKAGES.md`）：`subagents`（`start` / `startContinuable` / `registerProvider`…）、`tokenMeter`（`measure` / `estimateMessage`）、`llm` 含 `agentDefaultModel`、`workflowEngine`（该文档一处标「未挂载」，需以 profile 实际装配为准）；逐项调用签名与「能否传模型 / cwd / 取用量」由子代理调研回报后补入（`fac61e62`，2026-10-02）。
- **隔离依赖缺失（重要）**：本机 `dsh-git-worktree` **只有空目录**（`~/.dsh/plugins/dsh-git-worktree/disabled-git-hooks/`，无 `package.json` / 无源码 / 非 git 仓库；profile `fff` 的 dependencies 与 bundles 均未引用）。③「经本机 `dsh-git-worktree`」当前**没有可用底座**，需用户裁定替代方案（见「决策」D13）。

## 决策

| # | 决策点 | 选定 | 理由 |
|---|--------|------|------|
| D1 | 直写声明字段形态（用户 2026-10-02 裁定） | **A：独立字段 `directWrite: ["session-start", "compaction"]`**（规则与消费者同口径，与 `sources` 并列） | 改动最小；YAML 与工具参数都好写；B（source 项内联对象）令数组项变混类型，C（规则级布尔）表达不了「某些节点直写、`step-end` 仍判断」 |
| D2 | 多节点入参形态（用户 2026-10-02 裁定，BACKLOG 已记） | `source` 接受字符串或字符串数组（**不拆两条规则**）；归一化后字段名 `sources: readonly RuleSource[]` | 单值入参向后兼容；归一化侧用数组，避免「归一化类型里留联合类型」的读侧分支 |
| D3 | 空条件（`match` 省略）语义 | 由编译期判定改为**判定期按触发节点**判定：节点属 `BOUNDARY_SOURCES` 才「无条件命中」 | 一条规则挂多节点时，各节点语义必须独立 |
| D4 | 仓库外运行时 `rules.json`（用户 2026-10-02 裁定） | **现在就改**：`skill-autoload` 改 `sources: ["session-start", "compaction"]` + `directWrite` 两节点；改前把 diff 贴给用户确认 | ③ 是真机复盘的前提；该文件在仓库外，属用户环境配置 |
| D5 | `session-start` 含恢复（`session/created`） | 按需求**不判断、直写** → 恢复会话会再注入一次 | BACKLOG 注记明确要求「不判断」 |
| D6 | slash 命令命名盘点结果（用户 2026-10-02 裁定） | **只删 `/preset`**，其余名字全部保留（`/cls` `/guard` `/contract` `/loop` `/task` `/memory` `/council` `/agents` 均不动） | 用户口述「删掉 preset，其他不变」；盘点清单与理由见「实现记录」 |
| D7 | 改名后的旧名兼容（用户 2026-10-02 裁定） | **立即移除旧名**、不留别名（`/preset` 删后落 registry，未命中即提示「未知命令」） | 用户选定该策略 |
| D8 | `/preset` 删除范围（用户 2026-10-02 裁定） | **只删命令**（条目 / 路由 / case 与处理器 / `selectAgentPreset` 写路径 / help 行 / 文档 / 测试 / demo 断言）；**保留**标题栏 preset 段、状态列可选项等被动展示 | 该 preset 为死路径（AGENTS.md：本项目按 profile 全局组合、不配置 agent preset），而展示链路仍由宿主事件驱动、与本命令无关 |
| D9 | ① executor 后端集合（用户 2026-10-02 裁定） | **`subagent` + `command` + `workflow` 三条都做**（`model` = 现有本会话执行路径，不算新后端） | 用户勾选全量；宿主调研确认 `ctx.workflowEngine` 在本机 profile **已挂载**（`dsh-base` 的 `workflow-ptc` + `tool-workflow` 行，用户层无覆盖） |
| D10 | ① 发起入口（用户 2026-10-02 裁定） | 新增工具 **`task_execute(task_id)`**；`task_implement` 保持 model / 手写路径 | 语义清晰：有无 `result` 不再混两种含义；`model` 后端由 `task_execute` 拒绝并指向 `task_implement` |
| D11 | ③ 隔离落地（用户 2026-10-02 裁定） | **本次不做**，另开 BACKLOG 条目（已追加为 `docs/BACKLOG.md` 当前 #6「executor 隔离落地（git worktree）」） | 本机 `dsh-git-worktree` 不存在实现（空目录 + profile 未挂载；npm registry 有 0.3.1）；本包只留 `cwd` 透传 |
| D12 | executor 声明落点（实现裁定） | `executor` 随 `ChildSpec`（`task_decompose` 的 children 项）与根契约声明 → 物化为 `Frame.executor`；门禁新增 `rule: "executor"`（只允许叶子 + kind 白名单 + 后端必填字段） | 与既有 `deps` / coverage 同通道：机械拒绝带反馈打回，规则随事件流留痕 |
| D13 | ② 模型与预算语义（实现裁定，用户可否决） | 声明了 `model` 才显式传 `agentOptions`（未声明**不传** = 保持宿主「合并父 agent 选项」语义，只把 `agentDefaultModel.currentSelection()` 记进事件事实）；`budget.maxTokens` 映射宿主 `agentOptions.maxTokens`（输出上限语义）＋ 事后 `tokenMeter.measure(子会话)` 计量并标注 `overBudget`，**只标注不据此打回** | BACKLOG ② 原文只要求「接 agentDefaultModel 与 token-meter 计量」；宿主 `tokenMeter` 无预算字段（实测），强制中断无底座；显式传默认值会覆盖宿主按 agent 的合并语义 |

## 规划

### 计划改动文件清单

**#8（rule-engine + symbol-normalizer，跨包）**

| 文件 | 改动 |
|------|------|
| `rule-engine/src/types.ts` | `Rule.source` 接受 `RuleSource \| readonly RuleSource[]`；`Rule.directWrite`；`NormalizedRule.sources` / `directWrite`；`RuleSummary.sources` / `directWrite`；`ConsumerRegistration.directWrite` |
| `rule-engine/src/match.ts` | `compileMatcher(spec, sources)`：空条件判定改为按**触发节点**在 `match(text, source)` 内裁决 |
| `rule-engine/src/rules.ts` | `normalizeRule` 归一 `source`（字符串 / 数组 / 兼容 `sources`）+ `directWrite`；非法节点项记 warning |
| `rule-engine/src/engine.ts` | 多节点命中（`sources.includes(trigger)`）、直写跳过投影去重（规则 + 消费者）、`#needsText` / `evaluate` / `summaries` 同步 |
| `rule-engine/src/tools.ts` | `rule_add` / `rule_update` 的 `source` 支持数组 + 新增 `directWrite` 参数与描述 |
| `rule-engine/README.md`、`rule-engine/docs/DESIGN.md` | 节点表、去重表、消费者面、时序约束口径同步 |
| `rule-engine/tests/{match,rules,engine,main}.test.ts` | 多节点、直写、空条件按节点裁决的用例；既有断言同步 |
| `symbol-normalizer/src/main.ts` | 指南消费者改 `sources: ["session-start", "compaction", "step-end"]` + `directWrite: ["session-start", "compaction"]`（`ConsumerRegistrar` 结构面补 `directWrite`） |
| `symbol-normalizer/README.md`、`symbol-normalizer/docs/DESIGN.md`、`symbol-normalizer/tests/main.test.ts` | 注册口径与断言同步 |
| `TUI/docs/DESIGN.md` | 「解锁后自动加载行为 skill」段：`step-end` → 「会话开始 + 压缩完成」口径同步（供重建） |
| `docs/BACKLOG.md`（条目状态）、本追踪文档 | 流程记录 |
| （仓库外，用户已同意）`~/.dsh/rule-engine/rules.json` | `skill-autoload` 改 `sources` + `directWrite`（改前贴 diff） |

**#5（2026-10-02 盘点后细化）**——按 D6/D7/D8 删除 `/preset` 命令：

| 文件 | 改动 |
|------|------|
| `TUI/src/app/commands.ts` | 删 `SlashRoute` 的 `"preset"` 与 `LOCAL_COMMANDS` 条目（余 40 条 = 35 命令 + 5 别名） |
| `TUI/src/app/state.ts` | `StatusPanelState.kind` 去掉 `"preset"`；相关注释同步 |
| `TUI/src/app/index.ts` | 删 `case "preset"` 与 `handlePresetCommand`；`commitStatusPanel` 去 preset 分支；help 去 `/preset` 行；注释同步 |
| `TUI/src/app/adapter/types.ts`、`dsh.ts` | 删 `selectAgentPreset`（接口声明 + 实现）；`agentPresets` 目录服务保留（状态列可选项仍用） |
| `TUI/src/app/components/StatusPanel.ts`、`TUI/src/app/layout/hints.ts`、`TUI/src/main.ts` | 注释同步 |
| `TUI/demo/main.ts`、`TUI/demo/mockAdapter.ts` | 删 `/preset` 场景与 3 项断言（`preset-catalog` / `preset-select-call` / `preset-notice`）；`preset-badge` 改由 mock 回发 `agent-preset/selected` 事件驱动（`emitPresetSelected`），删除 mock 的 `selectAgentPreset` 与计数器 |
| `TUI/tests/agent-preset.test.ts` | 删 App 命令路径三例与 fake adapter 命令面；保留 reducer 隔离 + DshEvent 归一化；路由断言改为「`/preset` 落 registry」 |
| `TUI/tests/adapter.dsh.test.ts` | 删两条 `selectAgentPreset` 用例 |
| `TUI/README.md`、`TUI/docs/DESIGN.md`、`TUI/docs/COMMANDS.md`、`TUI/docs/COMMANDS-SPEC.md`、`TUI/docs/design/NOTICE-LEVELS.md` | 删 `/preset` 行与提及；smoke 断言项数 43 → 40 |
| `command-template/{src/main.ts,src/registry.ts,src/types.ts,README.md,tests/template.test.ts}` | 同条目的命令注册面清理：源码注释与**用户可见错误文案**仍写废弃缩写 `/tpl`（真实入口 `/playbook`），`reservedNames` 缺省描述与实际不符 → 一并修正 |

**#7（2026-10-02 评估完成）**：建议**不实施**逐插件结构化改造（理由见「调研 §7」），故无计划改动文件；若用户裁定实施，落点为各插件 `src/main.ts`（`onNotice` 式总线 + 装载期缓冲）＋ `TUI/src/main.ts`（逐插件订阅接线）＋ 各包 README / DESIGN ＋ 测试。

**#1（2026-10-02 调研 + 裁定后细化）**——叶子执行后端（① 发起 / ② 模型与计量；③ 不做）：

| 文件 | 改动 |
|------|------|
| `task-engine/src/types.ts` | `ExecutorKind` / `ExecutorSpec`；`ChildSpec.executor` / `Frame.executor` / `RootSpec.executor`；`PlanEvent` 新增 `plan/frame-executed`；`NestedTaskItem.executorKind` |
| `task-engine/src/gate.ts` | `EXECUTOR_KINDS` + `validateExecutor()`；`GateRule` 增 `"executor"`（只允许叶子声明、kind 白名单、`command` 必给 command、`workflow` 必给 script、`model` 覆盖须给全 provider/model、`budget.maxTokens` 须为正数） |
| `task-engine/src/events.ts` | 物化 `executor` 到 `Frame`；`toNested` 带 `executorKind`；`plan/frame-executed` 审计分支（不落树字段） |
| `task-engine/src/engine.ts` | `ExecutorRunner` / `ExecuteRequest` / `ExecuteOutcome` / `ExecuteResult`；`execute()`（发起 → 证据回填 `plan/frame-implemented` → 失败走 `rejectFrame` bounded retry → 用量 / `overBudget` 标注） |
| `task-engine/src/tools.ts` | 新增 `task_execute`；children 解析 `executor`（非法给精确反馈）；`ToolExecuteCtx.makeExecutor`（按当前工具调用的 agent 构造适配器） |
| `task-engine/src/main.ts` | 三类后端接线：`ctx.subagents.start`（`spawn` + `agentOptions` + `parent` + `signal`，取 `result.output` 后 `dispose`）、`ctx.workflowEngine.start`（script / meta / parent → `result.value`）、command 走 `/bin/sh -c`；`agentDefaultModel` 取默认事实、`tokenMeter` 计量；缺面一律 fail-closed + 告警 |
| `task-engine/tests/{gate,engine}.test.ts`、新增 `tests/tools.test.ts` | 门禁 executor 规则 7 例；engine execute 6 例（成功 / fail-closed / model 拒绝 / 打回与 failed / 超预算 / 非叶子）；工具面 3 例（解析反馈、证据与用量透出、缺参） |
| `task-engine/demo/main.ts` | 演示 13：executor 发起 → 证据回填 → 用量标注 → RET 验收 |
| `task-engine/README.md` | 能力新增「叶子执行后端」段、工具表加 `task_execute`、事件表加 `plan/frame-executed`、配置示例带 `executor`、边界与外包标注 ③ 未实现、测试计数 42 → 58 |
| `docs/BACKLOG.md` | 追加「executor 隔离落地（git worktree）」条目；里程碑三剩余项更新 |
| （无 `task-engine/docs/*`） | 该包**没有** `docs/` 目录（原计划清单里的 `docs/{DESIGN,BACKLOG}.md` 不存在），文档落点为包根 `README.md` |

### 明确不做

- 不拆规则（用户已裁定）。
- 不动 `turn-end` 的违规审查（符号规范）。
- 不改 `STATUS.md`（由用户择时更新）。

## 实现记录

2026-10-02（#8，按条目顺序第一件）：

1. `docs/BACKLOG.md` 四条目标「进行中（2026-10-02）」；本追踪文档建立（含决策与计划改动文件清单）。
1. 用户裁定 D1（A 形态）与 D4（现在就改运行时 `rules.json`）。
1. **仓库内代码（17 个文件，全部在计划清单内）**：
   - `rule-engine/src/types.ts`：`Rule.source` 接受单节点或节点数组 + `Rule.sources`（持久化回流写法）+ `Rule.directWrite`；`NormalizedRule.sources` / `directWrite`；`RuleSummary.sources` / `directWrite`；`ConsumerRegistration.directWrite`。
   - `rule-engine/src/match.ts`：`compileMatcher(spec)`（去掉 source 入参）；`CompiledMatcher.match(text, source)`——空条件语义改为**判定期按触发节点**裁决。
   - `rule-engine/src/rules.ts`：新增 `normalizeRuleSources`（单值 / 数组 / `sources` 三类入参；非法项与空数组报错，错误信息仍含「source 非法」；重复节点去重并 warning）与 `normalizeDirectWrite`（越界 / 非法项丢弃并 warning）。
   - `rule-engine/src/engine.ts`：多节点命中（`sources.includes(trigger)`）、判定传触发节点、`directWrite` 节点跳过投影去重判断（规则 + 消费者两处）、`#needsText` / `evaluate` / `summaries` 同步、`update()` 处理 `source` / `sources` 覆盖并新增 `directWrite` 键、消费者侧 `normalizeDirectWriteNodes` 校验。
   - `rule-engine/src/tools.ts`：`rule_add` / `rule_update` 的 `source` 参数改 `string | array`，新增 `directWrite` 参数，`ruleFromArgs` 带上 `directWrite`。
   - `symbol-normalizer/src/main.ts`：指南消费者改 `sources: ["session-start", "compaction", "step-end"]` + `directWrite: ["session-start", "compaction"]`（`ConsumerRegistrar` 结构面补 `directWrite`）。
   - 文档：`rule-engine/README.md`（节点表数组说明、去重表新增 `directWrite` 行、工具族参数、消费者面、配置示例新增 `session-guide` 多节点示例、单测计数 76 → 83）、`rule-engine/docs/DESIGN.md`（§4 多节点、§6 `directWrite`、§10 注册字段）、`symbol-normalizer/{README.md,docs/DESIGN.md,src/guide.ts}`、`TUI/docs/DESIGN.md`（skill 承载段追加 2026-10-02 口径）。
   - 测试：`rule-engine/tests/{match,rules,engine}.test.ts`（空条件按节点裁决、多节点 + 直写、消费者直写、越界告警）、`symbol-normalizer/tests/main.test.ts`（sources + directWrite 断言）。
1. **仓库外运行时（用户 2026-10-02 同意，改前已贴 diff）**：`~/.dsh/rule-engine/rules.json` 的 `skill-autoload` 改为 `source: ["session-start", "compaction"]` + `directWrite: ["session-start", "compaction"]`（保留 `dedupeInRecord: 1` 作无直写节点时的兜底，`description` 重写，**正文未改**）。原件备份 `tmp/rules.json.orig`，拟稿 `tmp/rules.json.proposed`。首次 `cp` 被只读沙箱拒绝，经用户授权以 `danger-full-access` 重试成功（2026-10-02 02:34）。
1. `format` 跑过全部改动文件（其中 `rule-engine/tests/engine.test.ts`、`rule-engine/tests/match.test.ts` 被 prettier 整形）。
1. **#8 关闭（2026-10-02）**：用户重启 `dsh --profile fff` 后确认「已自动注入」，真机证据见「测试与证据」；条目标「完成」并从 `docs/BACKLOG.md` 清理，本追踪文档继续承载 #5 / #7 / #1（按用户裁定「只关 #8，然后继续做下一个」）。
1. **#5 盘点（2026-10-02）**：命令面全量盘点——TUI 本地 `LOCAL_COMMANDS` 41 条（36 路由 + 5 别名 `/cls` `/exit` `/thinking` `/usage` `/context`）、宿主注册 6 条（`/compact` `/feedback` `/goal` `/permission` `/plan` `/export`）、插件注册 1 条（`command-template` 的 `/playbook` + 5 个模板子命令 `adversarial-review` / `codebase-audit` / `code-review` / `deep-research` / `multi-perspective`）。缩写 / 晦涩候选 9 项（`/cls`、`/preset`、`/agents`、`/guard`、`/contract`、`/loop`、`/task`、`/memory`、`/council`）连同建议名提交用户裁定 → D6 / D7 / D8。
1. **#5 实施（2026-10-02）**：按 D6 / D7 / D8 删除 `/preset` 命令与 `selectAgentPreset` 写路径（文件清单见「规划」）；`/help` 少一行 → 重跑冻结基线脚本（无 diff）+ smoke（断言项数 43 → 40，全绿）；`command-template` 的 `/tpl` 残留（注释、用户可见错误文案、`reservedNames` 缺省描述）一并修正。
1. **#7 评估（2026-10-02）**：核实运行期告警写点 28 处、方案 A 的 tone 启发式判定、既有结构化通道（rule-engine `onNotice` / symbol-normalizer `onReview`）；收益 / 成本对比与结论见「调研 §7」，**建议不实施**逐插件改造 → 待用户裁定（实施 or 关闭条目）。
1. **#1 调研（2026-10-02）**：读码确认 `executor` 目前零代码（只有 README 的口径）；宿主签名由子代理并行调研并回报（`subagents.start` 的 `agentOptions` / `parent` / `signal` / `capabilities.agentOptions`、`SubagentRun.result` + `dispose`、`workflowEngine.start`（**本机已挂载**）、`tokenMeter.measure`（**无预算字段**）、`agentDefaultModel.currentSelection`、**subagent 无 `cwd` 入参**）——据此定稿 D9-D13，并把 ③ 依赖缺失写实。
1. **#1 实施（2026-10-02）**：按 D9-D13 落地叶子执行后端（文件清单见「规划」）：类型 / 门禁 / 事件物化 / `engine.execute()` / `task_execute` 工具 / `main.ts` 三类后端接线 / 测试 / demo 演示 13 / README；③ 未做并另开条目。

## 测试与证据

2026-10-02 已跑（命令 + 结果）：

| 命令 | 结果 |
| --- | --- |
| `cd rule-engine && npm run check` | 通过（无错误输出） |
| `cd rule-engine && npm run build` | 通过（先修掉一处测试侧类型错：`directWrite: ["step-end", "nope"]` 需 `as unknown as RuleSource[]`） |
| `cd rule-engine && npm test` | `tests 83 / pass 83 / fail 0` |
| `cd symbol-normalizer && npm run check` / `npm run build` | 通过 |
| `cd symbol-normalizer && npm test` | `tests 38 / pass 38 / fail 0` |
| 根 `npm run check`（17 包串行） | `exit 0`，`error TS` 计数 0 |

顺序说明（供复核）：首轮单测在 `format` **之前**跑；`format` 后按用户指令**重跑全部测试**（下表），结论不变。

| 命令（2026-10-02 补跑，`format` 之后） | 结果 |
| --- | --- |
| `cd rule-engine && npm test` | `tests 83 / pass 83 / fail 0` |
| `cd symbol-normalizer && npm test` | `tests 38 / pass 38 / fail 0` |
| `node tmp/injection-timing-smoke.mjs`（dist 级：真实 `rule-engine/dist` + `symbol-normalizer/dist` 接线） | `SMOKE_PASS`，exit 0，告警 0。四步：① `session-start` 合并直写一条（`sourceId = skill-autoload+consumer:symbol-normalizer-guide`）② `step-end` 不注入 ③ `compaction` 直写（投影已有仍发）④ 投影清空后步末补回一条 |
| 根 `npm run test`（`scripts/test-parallel.sh`） | `exit 0`；16 包全 `OK`，合计 `pass 1910 / fail 0` |

**真机复盘（2026-10-02，用户重启 `dsh --profile fff` 后「已自动注入」）**：

- 证据路径：`~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/tui-8a585495-e038-4fbd-a1cf-fe764d3a6021/session.v4.jsonl.zstd`（`zstd -dc` 解到 `tmp/session-latest.jsonl`，623 事件；临时探针 `tmp/session-evidence.mjs` 跑完已删）。
- 两条 rule-engine 注入（`#27` / `#575`）均为**合并消息**：`source.summaries = ["解锁后加载 i-have-adhd / karpathy-guidelines", "符号规范（会话开局指南）"]`。
- 触发节点判定为 `session-start`：`skill-autoload` 此刻只挂 `session-start` / `compaction`，而本会话日志无 `compaction/end`——若触发点是 `step-end`（指南的兜底节点），合并消息里不会出现该 skill 规则。
- `#575` 出现在 `session/end-seed` 之后的又一段会话建立（恢复 / 再建）→ 与「`session-start` 含恢复、直写不判断，故会再注入一次」口径一致。
- **未覆盖**：压缩面（`compaction/end` 后第一步即带注入）本会话未发生，该路径由 dist 冒烟（第 ③ 步）覆盖。

**#5（删除 `/preset` 命令）证据（2026-10-02）**：

| 命令 | 结果 |
| --- | --- |
| `cd TUI && npm run check` | 通过（删除后剩 2 处测试侧编译错，随用例删除一并消除） |
| `cd TUI && npm test` | `tests 1290 / pass 1290 / fail 0`（原 1295：删 3 例命令用例 + 2 例 adapter 用例；路由断言改为「落 registry」） |
| `cd TUI && node --experimental-transform-types scripts/freeze-focus-frame.mts` + `git diff -- tests/fixtures/focus-frame-legacy.json` | 冻结基线**无 diff**（`/help` 行变化不影响该 fixture） |
| `cd TUI && npm run demo -- --smoke` | `exit 0`，40 项全 `SMOKE_PASS`（先删 3 项 `/preset` 断言、`preset-badge` 改由 mock 回发 `agent-preset/selected` 驱动；修复前为 `SMOKE_FAIL n=4`） |
| `cd command-template && npm run check` / `npm run build` / `npm test` | 通过 / 通过 / `tests 13 / pass 13 / fail 0` |
| 根 `npm run check` / 根 `npm run test` | `exit 0`（`error TS` 计数 0）/ `exit 0`，16 包全 `OK`（含 TUI `pass 1290`） |

**#5 真机确认（2026-10-02）**：用户重启 `dsh --profile fff` 后裁定「可以，收尾 #5 和 #7」→ 视为真机行为通过。留证说明：本会话日志（解压到 `tmp/session-latest.jsonl`，1170 事件）未出现用户手输 `/preset` 的记录，命令行为由用户口头确认替代（非机械证据）。

**#7（评估条目）证据**：评估为**只读分析**——无代码改动、无新增测试；写点盘点（28 处）与收益 / 成本对比见「调研 §7」，用户 2026-10-02 裁定「可以」= 采纳「不实施」建议。

**#1（叶子执行后端 ① ②）证据（2026-10-02）**：

| 命令 | 结果 |
| --- | --- |
| `cd task-engine && npm run check` / `npm run build` | 0 error（含门禁 / 引擎 / 工具 / 宿主接线的全部新增类型） |
| `cd task-engine && npm test` | `tests 58 / pass 58 / fail 0`（原 42：+7 门禁 executor 规则、+6 engine execute、+3 工具面） |
| `cd task-engine && npm run demo` | `DEMO_OK`（新增演示 13：executor 发起 → 证据回填 → 超预算标注 → RET 验收完成整树） |
| `node tmp/task-executor-smoke.mjs`（dist 级：真实 `task-engine/dist` 的 `apply()` + 假宿主面 `subagents` / `workflowEngine` / `agentDefaultModel` / `tokenMeter`） | `SMOKE_PASS`（9 步：工具族含 `task_execute` / 四叶子声明 executor 过门禁 / subagent 模型覆盖 + 预算 → `agentOptions{provider,model,maxTokens}` 且证据 + 用量（`overBudget:false`）回填 / 未声明模型**不传** `agentOptions` / command 真跑 `/bin/sh -c` / workflow 的 `script`+`meta`+`parent` 透传并回填 `value` / `execute → stop → join` 整树 done 且 status 暴露 `executorKind` / provider 能力位不足 fail-closed（不静默降级）/ 执行失败带反馈打回且 `next` 指本帧） |
| 根 `npm run check` / 根 `npm run test` | `exit 0`（`error TS` 计数 0）/ `exit 0`（16 包全 `OK`，`fail 0`；含 task-engine `pass 58`） |

未做（交接给后续）：

1. `rule-engine/demo` 未跑（可选）。
1. **#1 真机未验**：`task_execute` 的三条后端在真机上需模型在一次会话里主动调用才会触发（dist 冒烟已用假宿主面覆盖调用链）；若要真机复核，建议在会话里对叶子声明 `executor` 后让模型 `task_decompose` → `task_execute`。

## 交接（2026-10-02 中断点）

**当前状态**：条目 #8「注入时机调整」、#5「slash 命令命名规范」、#7「插件运行期 stderr 告警显示统一（评估）」**均已关闭并清理**；仅 #1「task-engine 执行扩展」未开工（BACKLOG 仍标「进行中（2026-10-02）」，本文件不归档）。

**工作区**：三次提交已落盘——`feat(rule-engine,symbol-normalizer): 注入时机支持多节点与直写`、`docs(rule-engine): 关闭「注入时机调整」条目并补真机复盘证据`、`feat(TUI)!: 删除 /preset 命令（旧名不留别名）`；#5 / #7 的关闭文档变更随本次收尾提交。`tmp/` 仅保留 `rules.json.orig`（运行时规则原件备份，勿删）。

**下一步**：接 #1「task-engine 执行扩展」——读 `task-engine` 源码与 README「边界与外包」段，细化三段（叶子 `executor` 声明与后端适配 / 模型与预算声明 / git worktree 隔离），经用户裁定后实施。

**注意**：本任务接取的是四条（BACKLOG 均已标「进行中（2026-10-02）」），关闭时四条一起处理；`STATUS.md` 不由流程改；提交按 `docs/WORKFLOW-STANDARD.md` §5 的四个询问点征得同意。

## 收尾

**条目状态变更（2026-10-02）**：

- 「注入时机调整：会话开始 / 压缩完成后直写，不等步末」：标「完成」并清理（记录见「实现记录」「测试与证据」；实现落点 commit `feat(rule-engine,symbol-normalizer): 注入时机支持多节点与直写`，运行时规则改动在仓库外 `~/.dsh/rule-engine/rules.json`）。
- 「slash 命令命名规范：不用缩写」：标「完成」并清理。裁定 D6 / D7 / D8（只删 `/preset`、旧名不留别名、只删命令面）→ 实施落点 commit `feat(TUI)!: 删除 /preset 命令（旧名不留别名）`；盘点覆盖 TUI 本地 41 条 + 宿主 6 条 + 插件 1 条；同条目清理了 `command-template` 的 `/tpl` 残留。
- 「插件运行期 stderr 告警显示统一（评估）」：标「完成」并清理。结论 = **不实施**（「调研 §7」：方案 A 已覆盖显示位置与 headless 兜底；逐插件结构化通道净增量仅 tone 精确与装载期重放，成本为 300-500 行重复机制 + TUI 逐插件耦合）——用户 2026-10-02 裁定「可以」采纳。
- 「task-engine 执行扩展」：**本任务继续接取**，BACKLOG 保持「进行中（2026-10-02）」；本文件**不归档**（留 `docs/implementation/`），待其完成后一并关闭。

**中途范围说明**（流程要求）：2026-10-02 用户两次裁定——「只关 #8，然后继续做下一个」、「可以，收尾 #5 和 #7」：在开放任务内逐条关闭，未新增 / 移除条目。

**回写**：`rule-engine/README.md`、`rule-engine/docs/DESIGN.md`、`symbol-normalizer/{README.md,docs/DESIGN.md}`、`TUI/docs/DESIGN.md`（#8）；`TUI/{README.md,docs/DESIGN.md,docs/COMMANDS.md,docs/COMMANDS-SPEC.md,docs/design/NOTICE-LEVELS.md}`、`command-template/{README.md,src/types.ts}`（#5）；#7 无代码改动、无需回写；`STATUS.md` 不由流程改。

**临时物清理**：`tmp/session-latest.jsonl`、`tmp/session-evidence.mjs`、`tmp/rules.json.proposed`、`tmp/check.log`、`tmp/test-all.log`、`tmp/injection-timing-smoke.mjs` 已删；保留 `tmp/rules.json.orig`（运行时规则原件备份，用于回退对照）。
