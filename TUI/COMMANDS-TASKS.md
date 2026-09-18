# TUI 命令扩展任务（Commands Tasks）

> 状态：**批次 0 已完成**（5 项 API 合同门全部过门，结论见 §1，含源码文件:行）；四批实现待实施。
> 类型：**[task]**——实施与验收清单；范围 = `COMMANDS-SPEC.md` §1/§2 的**纯 TUI 侧命令**（7 项候选，均已过合同门；宿主服务现成，不改动任何本项目插件）。
> 配套：`COMMANDS-SPEC.md`（规格与 API 签名核实表）、`COMMANDS.md`（命令来源归口）、`NOTICE-LEVELS.md`（提示分级）、`DESIGN.md` / `SPEC.md`（面板与渲染契约）。

## 0. 全景

- **逐命令落点矩阵见 `COMMANDS-SPEC.md` §0.1**：`/stats` 仅 4 类；`/rename` `/settings` 加 `main.ts` 与 adapter 两类；`/fork` 因 `sessions` 已接只需 adapter + 命令两类（无 `main.ts`）；面板型额外追加 `layout.ts` 接线 5 处（§1）。
- **批次 0（API 合同门）已完成**：`/agents` `/tools` `/settings` `/skills` `/fork` 的参数语义与来源均已核实并过门（§1）；四批实现无剩余前置。
- 唯一新基础设施是共享列表面板（`commandPanel` 判别联合 + 单一 Box 生成器）——面板命令共用一套 state/reducer/渲染。

| 批次 | 内容 | 建立的闭环 | 前置 |
|------|------|-----------|------|
| **0** | API 合同门（5 项核实 + 面板接线点普查）✅ 已完成 | 实现前的确定性 | 无 |
| 1 | `/stats`、`/rename` | 命令 + notice（零面板；`/rename` 打通宿主服务调用） | 批次 0 中与二者相关的项（无） |
| 2 | 共享列表面板 + `/skills` ✅ 已完成 | 面板基础设施 + 首个面板命令 | —（批次 0 第 3 项已过门） |
| 3 | `/agents`、`/tools` ✅ 已完成 | 面板 kind 复制 | —（批次 0 第 1、2 项已过门） |
| 4 | `/settings`、`/fork` | 只读展示 / 签名收尾 | —（批次 0 第 4、5 项已过门） |

## 1. 批次 0 · API 合同门

> 目的：把「方法名已核实」推进到「可调用契约已确定」。每条结论写回本表后，对应命令才允许进入实现批次。
> 核实手段：读宿主源码——本机 `@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/lib`（dsh 0.1.5-rc.2）。全部结论已核实并过门。

| # | 待核实 | 影响命令 | 结论 |
|---|--------|---------|-------------|
| 1 | `subagents.interrupt(targetSessionId, authority)` 的 **`authority` 从何而来**；`list()` 条目是否带可中断 id | `/agents` | ✅ **过门**。`authority` 为联合类型：`{kind:'user', parentSessionId}` 或 `{kind:'ancestor', agent}`（`dsh-subagent/lib/types/types.d.ts:57-63`）——TUI 用前者，`parentSessionId` 取 `state.activeSessionId`（TUI `src/app/state.ts:227`）。条目列表须用 **`listChildren(parentSessionId, signal?)` → `SubagentListEntry[]`**（`lib/types/index.d.ts:201`），条目含 `id`/`activity`/`mode`/`label?`/`hasChildren` 或 `kind:'diagnostic'`+`reason`（`lib/types/control-types.d.ts:30-70`）。**`list(): string[]`（`index.d.ts:283`）返回 provider 名，不是 agent 列表**。备选同步 API `interruptByParent(childSessionId, parentSessionId, 'continuable')`（`index.d.ts:264`） |
| 2 | `tools.schemas(scope)` 的 **`scope` 来源**；返回结构 | `/tools` | ✅ **过门**。签名 `schemas(scope?: ScopeKey): ToolSchema[]`（`dsh-tools/lib/types/index.d.ts:676`）——**scope 可省略**（`ScopeKey = object`，`dsh-scope/lib/types/index.d.ts:11`）；省略即全局视图：`peek(undefined)→undefined`、`chainLayers(undefined)→[]`（`dsh-scope/lib/index.js:151-167`），`view()` 走 `this.layers.global.tools` 全量可见（`dsh-tools/lib/index.js:2854-2880`）。返回 `{name, description, parameters}`（`index.js:2934` 起）。`get(name, scope?)` 同可省略（`index.d.ts:655`） |
| 3 | `skills.get(candidate)` 的 **`candidate` 形态**；`skills.list()` 条目结构 | `/skills` | ✅ **过门（服务层不接触 candidate）**。`ctx.skills.get(name: string, options?)` → `SkillDefinition \| undefined`（`dsh-skill/lib/types/index.d.ts:286`），`list(options?)` → `SkillSummary[]`（`index.d.ts:268`）——服务层用 **skill 名字符串**。`SkillCandidate`（含 `rank`/`locator`）仅存在于 provider 层（`index.d.ts:61-70`、provider 声明 `:187`）。`SkillSummary` = `name`/`description`/`whenToUse?`/`invocation`/`source`/`provider`/`resourceBase?`（`index.d.ts:44-59`）；`SkillDefinition` 另含 `content` 正文 |
| 4 | `settings.get(ns)` 的 **`ns` 枚举方式**；`options` 形态 | `/settings` | ✅ **过门**。服务面 `ctx.settings: SettingsProvider`（`dsh-settings/lib/types/index.d.ts:111-114`）。**枚举方式 = `describe(options?)` → `SettingsDescriptor[]`**（`index.d.ts:236`），描述符含 `ns`/`schema`/`value`/`revision`/`base?`/`user?`/`applies`/`secrets?`（`:50-73`）——一次调用即得 ns + 当前值。单读 `get(ns)` → `unknown`（`:243`）。注意 `describe` 的 `redactSecrets` 选项（`:75+`）：同进程 UI 可省略，但 `role('secret')` 字段不应明文展示 |
| 5 | `sessions.fork(source, boundary, childSessionId)` 的 **`boundary` / `childSessionId` 可省性与语义**；返回结构 | `/fork` | ✅ **过门**。签名 `fork(source: Session \| SessionId, boundary?: SessionSeq, childSessionId?: SessionId): Session`（`dsh-session/lib/types/index.d.ts:439`）——**后两参皆可省略**：省略 `boundary` = 源会话**当前最后事件**（`:431-433`），省略 `childSessionId` = `SessionStore` 的 id 策略；`source` 可为 id 字符串（`SessionForkSource = Session \| SessionId`，`:294-295`）。**同步返回 live Session 对象**。约束：切片可止于 turn 间事件，**不可落在未闭合 turn 内**；错误码全量 `SessionForkErrorCode`（`:304`）：`SESSION_NOT_FOUND`/`SESSION_NOT_LIVE`/`SESSION_ALREADY_EXISTS`/`INVALID_BOUNDARY`/`OPEN_TURN`（`:296-305`） |

**未过门的处置**：任何一项若核实结果为「必须提供 TUI 侧无法获得的参数」或「需宿主侧改动」，则该命令移入 §7 不在范围，不进入实现批次。

**本轮结果**：5 项**全部过门**，7 项候选无一移出；实现批次无剩余前置（第 1 项副产品：`/agents` 条目列表须用 `listChildren`，SPEC 表述已同步修正）。

**面板接线点普查（已完成）**：新增 `commandPanel` 必须同时改下列 5 处，缺一处即出现「面板显示了但 footer/focus 行为错」：

| # | 位置 | 改动 |
|---|------|------|
| 1 | `layout.ts` `buildActivePanelBox`（L807） | 加 `commandPanel` 分支（插在 `jobsPanel` 之后、`history` 之前） |
| 2 | `layout.ts` `normalInput`（L1515–1521） | 加 `&& !commandPanel` |
| 3 | `layout.ts` `modalOpen`（L1679） | 加 `\|\| commandPanel`（模态态焦点置空） |
| 4 | `layout.ts` `showHint` → `metricsFor(size, hasPanel, …)`（L1524、L1534） | 由 ②③ 自动跟随；**验证**面板态 `footerHeight = interaction`（提示行让位） |
| 5 | `layout.ts` `inputPanelHeights`（L1343，`index.ts:919` 调用） | 确认 PgUp/PgDn 页高取活动区可视行数（与面板窗口同口径） |

（`fillPanelBox` / `modalPanel`（L982）与活动区渲染（L1051）由 `buildActivePanelBox` 返回值驱动，无需额外改动。）

## 2. 批次 1 · notice 型（`/stats`、`/rename`）

### 2.1 `/stats`（别名 `/usage` `/context`）

- **落点 4 处**：`commands.ts`（`SlashRoute` 加 `"stats"` + `LOCAL_COMMANDS` 三条别名）、`index.ts`（`case` + `handleStatsCommand()`）、测试、文档。**不改 adapter。**
- 输出：读 `state.usage`（`{ input, output, cacheRead, contextWindow? }`）→ info 三行：tokens 分解 / 上下文 `input+cacheRead`（占窗口百分比）/ 缓存命中率。
- 边界：`contextWindow` 缺失或 0 → 只显绝对量，不除零。
- **新增 notice 调用点**（须同步 `NOTICE-LEVELS.md` A 表）：`暂无 token 用量数据（本回合尚未发生模型调用）` → info。

### 2.2 `/rename`

- **落点 5 处**：`commands.ts`、`index.ts`、`main.ts`（`ctx.get("sessionTitle")`）、`adapter/types.ts` + `adapter/dsh.ts`（`SessionTitleLike` + `renameSession?`）、测试/文档。
- 服务调用：`sessionTitle.rename(session, title)`（**首参为 session 对象**）。
- 参数处理：缺参 → 用法提示；空标题/含换行 → 拒绝（不发调用）；成功 → success。
- **新增 notice 调用点**：`用法：/rename <标题>` → info；`已重命名为「<title>」` → success；`sessionTitle 服务不可用` → warn；空标题/换行 → error。

### 2.3 批次 1 收尾

- `NOTICE-LEVELS.md` A 表补上述调用点（共 5 条）。
- 测试：`/stats`（有 usage / 无 usage / `contextWindow` 缺失）；`/rename`（成功 / 缺参 / 空标题拒绝 / 服务缺失 warn）。
- 基线：`helpText` 加两行 → 重跑 `node --experimental-transform-types scripts/freeze-focus-frame.mts`（diff 审查）+ smoke（先例：`/init` 加行曾挤掉候选可视窗口并触发脆弱断言）。
- **本批验证全绿后自动提交**（见 §8；用户已授权，无需停下等确认）。

## 3. 批次 2 · 共享列表面板 + `/skills`

### 3.1 面板基础设施

- `state.ts`：`commandPanel: { kind: "skills" | "agents" | "tools"; index: number; rows: CommandPanelRow[]; loading?: boolean; error?: string } | null` + reducer 四件套（`command-panel-open` / `-move` / `-close` / `-data`，数据 last-write-wins）。
- 新组件 `components/CommandListPanel.ts`：`buildCommandListPanelBox(panel, height, width): Box` + `renderCommandListPanel(...)`（结构照 `JobsPanel.ts`：首行标题青 + 计数 + 右侧灰提示、`> ` 高亮前缀、空态灰占位、窗口随 index 平移、`truncateToWidth`、叶子 `wrap:false`）。
- **面板接线 5 处**（§1 表，含 `normalInput` / `modalOpen` / `hasPanel` 验证 / `inputPanelHeights`）。
- `index.ts`：键位段（↑/↓、PgUp/PgDn、Enter、Esc、其余吞掉）+ 面板互斥（照 `handleJobsCommand` 关闭 `history` / `picker` / `jobsPanel` / 其他 `commandPanel`）。

### 3.2 `/skills`

- **落点 6 处**：`main.ts`（`ctx.get("skills")`）、`adapter/types.ts`（`SkillsLike { list?(); get?(name: string) }`，`list()` **无参**）、`adapter/dsh.ts`（`refreshSkills?()` → 归一化为 `CommandPanelRow[]`）、`commands.ts`、`index.ts`、测试/文档。
- 行为：服务缺失 → warn 且**不开面板**；带参 `<filter>` 在归一化阶段过滤；Enter → `skills.get(name)` 详情（批次 0 第 3 项已定：服务层用 **skill 名字符串**）。
- **新增 notice 调用点**：`skills 服务不可用` → warn；详情多行 → info。

### 3.3 批次 2 收尾

- 测试：面板渲染单测（行数恒等 `height`、空态、超宽截断、窗口平移）+ 路由/降级/过滤/键位。
- `helpText` 加行 → freeze + smoke。
- 文档：`README.md`、`IMPLEMENTATION.md`（`commandPanel` 机制）、`NOTICE-LEVELS.md` A 表（2 条）。
- **验证全绿后自动提交**（见 §8）。

## 4. 批次 3 · 面板 kind 复制（`/agents`、`/tools`）

### 4.1 `/agents`（前置：批次 0 第 1 项）

- `types.ts` 加 `SubagentsLike { list?(); interrupt?(targetSessionId, authority) }`；`adapter/dsh.ts` 加 `refreshAgents?()` / `interruptAgent?()`。
- 面板 kind `agents`；行含 label / mode / provider-model / 状态（`Record<string, unknown>` 宽松读取）。
- Enter = **直接中断 + 结果 notice**（照 `/jobs` 先例）；条目无会话 id 或 `authority` 无法获得 → **该行不可中断**（灰显 + 说明 notice），不发调用。
- **新增 notice 调用点**：`subagents 服务不可用` → warn；中断成功 → success；中断失败 → error；条目不可中断 → info。

### 4.2 `/tools`（前置：批次 0 第 2 项）

- `types.ts` 加 `ToolsLike { schemas?(scope?); get?(name, scope?) }`（**无 `entries`**）；`adapter/dsh.ts` 加 `refreshTools?()`。
- 面板 kind `tools`；必须支持 PgUp/PgDn（数十条）；Enter → `tools.get(name, scope)` 详情。
- **新增 notice 调用点**：`tools 服务不可用` → warn；详情多行 → info。

### 4.3 批次 3 收尾

- 测试：路由 / 降级 / Enter 调用与入参 / 缺 id 分支 / 翻页键位。
- `helpText` 加两行 → freeze + smoke；`NOTICE-LEVELS.md` A 表（6 条）同步。
- **验证全绿后自动提交**（见 §8）。

## 5. 批次 4 · 收尾（`/settings`、`/fork`）

### 5.1 `/settings`（前置：批次 0 第 4 项）

- `types.ts` 加 `SettingsLike { get?(ns); describe?(options?) }`（**无 `current` / `mutate` / `yaml`**）。
- 输出：notice 多行（`ns：key = value`，超长截断）。
- 写回（公开路径 `settings.update` / `replace` / `mutate` + `expectedRevision` 乐观锁；`write` 为 private）**不在本批范围**（真实配置 + 乐观锁，另立规格）。
- **新增 notice 调用点**：`settings 服务不可用` → warn；读取结果 → info。

### 5.2 `/fork`（前置：批次 0 第 5 项）

- 过门后按结论实现：可省参 → 无参 `/fork`（success notice + 必要时提示 `/session` 切换）；必填且需用户输入 → 改带参形态（`/fork <boundary>`）或并入 `/session` 面板；**结论为「不可得」→ 移入 §7**。
- **新增 notice 调用点**：`sessions 服务不可用` → warn；分叉成功 → success；分叉失败 → error。

### 5.3 批次 4 收尾

- `helpText` 加两行 → freeze + smoke；`NOTICE-LEVELS.md` A 表（5 条：`/settings` 2 + `/fork` 3）+ `README.md` / `IMPLEMENTATION.md` / `COMMANDS.md` 状态列同步。
- **验证全绿后自动提交**（见 §8）。

## 6. 验收

基线命令（已核实存在，`TUI/package.json` 与根 `package.json`）：

```sh
npm --prefix TUI run check             # tsc -p tsconfig.json --noEmit
npm --prefix TUI run test              # node --experimental-transform-types --test 'tests/*.test.ts'
npm --prefix TUI run build             # tsc -p tsconfig.json（产物更新，profile 经 link: 生效）
npm --prefix TUI run demo -- --smoke   # 帧断言 SMOKE_PASS 36/36
```

批次间（每批完成）：上面前四条全绿；改动 `helpText` 的批次另需重跑 freeze 脚本并 diff 审查基线。
全批完成后（最终门）：根级 `npm run build`（TUI + 10 个插件包全部 tsc 通过）+ `dsh --profile fff` 真机试用已实现的全部命令（含服务缺失降级场景）。
每批自测通过即自动提交（用户已授权本清单范围的自动化提交，见 §8）；项目 `AGENTS.md` 的「人工确认后才允许提交」要求由该授权覆盖。

## 7. 不在范围

| 命令 | 原因 |
|------|------|
| `/memory` `/loop` `/task` `/guard` | 需先改动本项目插件（服务暴露 / 新增能力） |
| `/contract` | `goal-contract` 包入口（`dist/src/index.js`）**未 re-export** `buildObjective` / `parseContract`（已核实：`index.ts` 仅导出 `name`/`inject`/`apply`；包无 `exports` 字段）→ 公开依赖需给该包加 re-export（属插件包改动）；深路径 import 内部实现文件不稳；内联复制会漂移。**故本轮不做** |
| `/clear` `/login` `/logout` `/review` | 宿主能力缺口／语义不匹配（`dsh-session` 无 `clear`；`ctx.credentials` 仅为凭据引用 seam，无交互登录流程；`workflowEngine.start` 存在但 `/review` 缺工作流资产）——逐条理由见 `COMMANDS-SPEC.md` §3 |
| 批次 0 未过门者 | 见 §1 处置规则 |

其他不做：`/settings` 写回、宿主命令插件包（`dsh-command-toolset`）、正则/高级过滤、面板增量事件订阅（本轮为打开时拉取）。

## 8. 提交拆分与协议

四个可独立回归的提交（**批次 0 不产生提交**，其结论写入本文档）：

1. `feat(tui): 新增 /stats 与 /rename 命令`
1. `feat(tui): 共享列表面板 + /skills 命令`
1. `feat(tui): 新增 /agents 与 /tools 面板命令`
1. `feat(tui): 新增 /settings 与 /fork 命令`

**协议（硬性）**：每批实现 → 自测通过（§6 验收命令全绿）→ **自动提交该批** → 直接进入下一批。用户已显式授权本清单范围的自动化提交（2026-09），无需逐批停下等人工确认；提交前仍须自查 diff、跑 `/home/guochang/fff/scripts/format` 格式化改动文件。

## 9. 待决清单

| # | 问题 | 备注 |
|---|------|------|
| 1 | 批次 0 五项结论 | ✅ 已核实、全部过门（§1 表，附源码文件:行）；无命令移出范围 |
| 2 | PgUp/PgDn 是否回头补给既有 `/jobs` 面板 | 共享面板新增能力，统一体验则后续补 |
| 3 | `commandPanel` 的 kind 扩张 | 插件改造完成后 `/memory` `/task` 等是否并入同一判别联合（倾向并入） |
| 4 | `/agents` 是否需要事件驱动刷新 | 本轮打开时拉取；若状态变化频繁再接 `subagent/*` 事件（事件面已接） |

## 10. 开放点

- **`helpText` 持续增长**：多条命令加行后 help 超过一屏，既有测试存在依赖行数的脆弱断言（`/init` 那次已踩坑）——改 help 前先检查相关断言。
- **`state.usage` 语义边界**：`/stats` 展示「最近一次模型调用」，与用户可能预期的「会话累计」不同；若要累计值需另行采集（`tokenMeter.measure(session, requestHeader)` 可用但接入成本高）。
- **面板挤占活动区**：面板占满活动区窗口（`activityH`），期间瞬态输出不可见——与既有 `/jobs` 一致，暂不改变。
