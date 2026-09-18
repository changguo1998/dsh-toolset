# TUI 命令扩展规格（Commands Spec）

> 依据：`COMMANDS.md`（命令来源归口与落点决策）、`DESIGN.md`（四区域布局、面板/焦点约定）、`NOTICE-LEVELS.md`（提示分级）、`SPEC.md`（Box 渲染与排版契约）。
> 口径：**只覆盖纯 TUI 侧可实现的命令**——宿主服务现成、不需要改动本项目任何插件。**方法签名**已读源码核实（§0.7）；**可调用契约**（参数语义与来源）由 `COMMANDS-TASKS.md` §1「批次 0 · API 合同门」把关，未过门的命令不进入实现。
> 状态：**7 项候选全部通过批次 0 API 合同门**（`/skills` `/agents` `/tools` `/settings` `/fork` 的前置结论见 `COMMANDS-TASKS.md` §1，附源码文件:行），可直接进入实现批次。需插件改造的 5 项（含 `/contract`）与宿主能力缺口／语义不匹配的 4 项列入 §3 索引，不写规格。

## 0. 通用规格

### 0.1 落点（按命令取子集，最多 6 类）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/main.ts` | `ctx.get?.("<svc>") as <Svc>Like \| undefined` 取宿主服务，加进 `createRealDshAdapter({...})`（与既有 `sessionQuery` / `sessions` / `agentPresets` / `permissionPresets` / `jobs` 同模式） |
| 2 | `src/app/adapter/types.ts` | 加结构化 `<Svc>Like` 类型（宽松返回 + 方法可选，风格照 `JobsLike`）+ `DshAdapter` 上的可选方法（`refresh<Name>?()` / `<verb><Name>?()`） |
| 3 | `src/app/adapter/dsh.ts` | 实现该方法：调服务、归一化返回值；异常内部消化为 `undefined` / `[]` 并经 notice 上报，不抛穿 |
| 4 | `src/app/commands.ts` | **两处**：`SlashRoute` 联合类型加 `"<name>"` **和** `LOCAL_COMMANDS` 加条目（`/init` 实现已证明二者缺一不可） |
| 5 | `src/app/index.ts` | `case "<name>"` 分支 + `handle<Name>Command()` + 键位段（若为面板）+ `helpText` 行 |
| 6 | 测试与基线 | `tests/app.test.ts` 用例 + `help` 行变化时重跑 freeze 脚本与 smoke（§0.5） |

**逐命令落点矩阵**（✓ = 需改，— = 不需；口头数量表述以本表为准）：

| 落点 | `/stats` | `/rename` | `/settings` | `/fork` | `/skills` | `/agents` | `/tools` |
|------|---------|-----------|-------------|---------|-----------|-----------|----------|
| `main.ts`（取服务） | — | ✓ | ✓ | —（`sessions` 已接） | ✓ | ✓ | ✓ |
| `adapter/types.ts` | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `adapter/dsh.ts` | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `commands.ts`（`SlashRoute` + `LOCAL_COMMANDS`） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `index.ts`（case + handler + 键位） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `layout.ts`（面板接线 5 处，§0.4） | — | — | — | — | ✓ | ✓ | ✓ |
| 测试与基线（freeze / smoke） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 文档同步（NOTICE-LEVELS / README / IMPLEMENTATION / COMMANDS） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

> 服务获取走 `ctx.get()`，**无需**改本插件的 `inject` 声明——既有做法即如此（`agentDefaultModel` / `commands` / `sessionQuery` 等均未在 `inject` 中声明，见 `src/main.ts` 注释）。

### 0.2 服务获取与降级（硬约定）

- **服务缺失**（`ctx.get` 返回 undefined 或 `adapter.<method>` 不存在）→ `notice("<svc> 服务不可用", "warn")` 后 return，**不开空面板**（`/jobs` 先例）。
- **调用失败**（Promise reject / 同步抛错）→ `catch` 后同一提示（warn），面板保持原状，不崩。
- **级别**遵循 `NOTICE-LEVELS.md`：服务不可用 = warn；命令结果失败 = error；成功且重要 = success；信息展示 = info；进度 = log。新增 notice 调用点须在同一变更补入该文件 A 表。

### 0.3 输出三型

| 型 | 形态 | 命令 | 实现 |
|----|------|------|------|
| notice | 活动区瞬态行（info / log / warn / error） | `/stats` `/rename` `/settings` | `this.notice(text, tone)` |
| 面板 | 活动区窗口内的列表面板（见 §0.4） | `/skills` `/agents` `/tools` | 共享 `buildCommandListPanelBox`（§0.4） |

> 预填型（`reduceState(s, { type: "input", … })`）本轮无命令使用，为后续命令预留。**各命令的实际落点见下方逐命令矩阵**（口头数量表述一律以矩阵为准）。

### 0.4 面板通用契约

**渲染位置（已核实，重要）**：面板渲染在**活动区窗口**，不是底部交互区。

- 选型点在 `layout.ts` `buildActivePanelBox(state, activityH, contentW)`，优先级：`approval` > `question` > `picker` > `statusPanel` > `jobsPanel` > `history` > `completion`；返回 `null` 时活动区显示瞬态行。
- 面板用**活动区高度 `activityH` 与内容宽度 `contentW`** 构建并 fill 进活动区窗口。
- 底部交互区：`footerHeight = hasPanel ? interaction : interaction - 1`（面板态输入框保留完整 `interaction` 行，按键提示行让位——面板自带提示）；面板开关不改变交互区高度（避免顶区上下跳动）。
- 注：`JobsPanel.ts` 头注释「占满固定交互区」措辞与实际渲染区域不符（实为活动区窗口），实现时以 `buildActivePanelBox` 为准。

**接线点（5 处，缺一处即出现「面板显示了但 footer/focus 行为错」）**：

| # | 位置 | 改动 |
|---|------|------|
| 1 | `layout.ts` `buildActivePanelBox`（L807） | 加 `commandPanel` 分支（插在 `jobsPanel` 之后、`history` 之前） |
| 2 | `layout.ts` `normalInput`（L1515–1521） | 加 `&& !commandPanel` |
| 3 | `layout.ts` `modalOpen`（L1679） | 加 `\|\| commandPanel`（模态态焦点置空） |
| 4 | `layout.ts` `showHint` → `metricsFor(size, hasPanel, …)`（L1524 / L1534） | 由 ②③ 自动跟随；验证面板态 `footerHeight = interaction`（提示行让位） |
| 5 | `layout.ts` `inputPanelHeights`（L1343，`index.ts:919` 调用） | 确认翻页页高取活动区可视行数（与面板窗口同口径） |

（`fillPanelBox` / `modalPanel`（L982）与活动区渲染（L1051）由 `buildActivePanelBox` 返回值驱动，无需额外改动。）

**共享面板模型（不复制 N 套 state/reducer）**：三个列表面板（`/skills` `/agents` `/tools`）共用一个判别联合与一套实现：

```ts
// state.ts
commandPanel:
  | { kind: "skills" | "agents" | "tools";
      index: number;
      rows: CommandPanelRow[];      // 归一化后的行（标题/副文本/符号）
      loading?: boolean;
      error?: string; }
  | null;

// reducer：单一三件套 + 数据推送
"command-panel-open"   // { kind }
"command-panel-move"   // { delta }   （↑/↓；clamp + 窗口平移）
"command-panel-close"
"command-panel-data"   // { kind, rows, loading?, error? }
```

- 渲染：单一 `buildCommandListPanelBox(panel, height, width): Box` + `renderCommandListPanel(panel, ...)` 薄包装 `fillBoxTree`。
- 键位：↑/↓ 移动、Enter 主操作（各 kind 自己的语义）、Esc 关闭、其余按键吞掉；长列表 kind（`tools` / `skills`）新增 PgUp/PgDn 翻页——既有 `/jobs` 面板只有 ↑/↓，本次作为共享面板的新增能力。
- 行样式：首行标题（青）+ 计数，右侧按键提示（灰，`truncateToWidth` 按剩余宽截断）；行 = `> ` 高亮前缀 + 状态符号 + 主文本；符号着色沿用 `JobsPanel.statusMark` 口径（● 黄 / ✗ 红 / ○ 灰 / ✓ 默认前景）。
- 空态：灰占位 `（无 <对象>）`，仍输出恰 `height` 行；超宽 `truncateToWidth`，不切半个 CJK。
- 互斥：打开时关闭 `history` / `picker` / `jobsPanel` / 其他 `commandPanel`（照 `handleJobsCommand` 的切换逻辑；重复调用同 kind = 关闭）。
- 数据：打开时经 `adapter.refresh<Name>()` 拉一次写入 `command-panel-data`；无事件源的 kind 不做增量订阅（不引入轮询）。

### 0.5 命名、冲突与 help

- 命令名规则 `^/([a-z][a-z0-9_-]*)`；别名在 `LOCAL_COMMANDS` 内以独立条目指向同一 route（先例 `/clearscreen`+`/cls`）。
- 与宿主注册命令同名时**本地优先**（先例 `/goal`、`/permission`）；本地未消费的形态应转发宿主。
- `helpText` 必须同步加行；help 行数变化会改变冻结基线（`tests/fixtures/focus-frame-legacy.json`）→ 重跑 `node --experimental-transform-types scripts/freeze-focus-frame.mts` 并 diff 审查，随后 `npm run demo -- --smoke` 断言 SMOKE_PASS 36/36。

### 0.6 测试口径（每条命令必备）

| 层面 | 断言 |
|------|------|
| 命令路由 | `FakeAdapter` 注入 stub 服务 → 提交 `/<name>` → 断言 notice 文本与级别 / 面板开启 / state 变化 |
| 降级 | 移除 stub → 断言 warn 提示、不开面板、不抛 |
| 面板渲染 | 直测 `buildCommandListPanelBox`：行数恒等 `height`、空态占位、超宽截断、高亮窗口平移 |
| 键位 | 面板开启时 ↑/↓/Enter/Esc → 断言 state 与适配器调用（先例 `app.test.ts` 的 jobs 用例） |
| 基线 | help 行变化 → 重跑 freeze 脚本 + smoke（§0.5） |

### 0.7 API 核实结果（读源码，非推测）

**已核实（可直接使用）**：

| 服务 | 精确签名 | 提供包 |
|------|---------|--------|
| `skills` | `list(options?)` → `SkillSummary[]`、`get(name, options?)` → `SkillDefinition`（**服务层用名字符串**；`candidate` 只在 provider 层） | `dsh-skill` |
| `subagents` | `listChildren(parentSessionId, signal?)` → `SubagentListEntry[]`（**列 agent 用这个**，条目含 `id`）、`interrupt(targetSessionId, authority)`（`authority` = `{kind:'user',parentSessionId}`）、`interruptByParent(child, parent, 'continuable')`、`start` / `sendMessage`；`list()` 返回 provider 名 | `dsh-subagent` |
| `tools` | `schemas(scope?)` → `ToolSchema[]`、`get(name, scope?)`、`view(scope?)`（**scope 省略 = 全局视图**，已核实）、`register` / `restrict` | `dsh-tools` |
| `sessionTitle` | `get(session)`、`rename(session, title)`（**首参为 session 对象**） | `dsh-session-title` |
| `sessions` | `list()`、`get(id)`、`create(id, options)`、`fork(source, boundary?, childSessionId?)` → `Session`（**后两参可省**：省 boundary = 尾事件、省 id = store 策略） | `dsh-session` |
| `settings` | `describe(options?)` → `SettingsDescriptor[]`（**枚举 ns 的方式**，含 `ns`/`value`/`revision`）、`get(ns)` → unknown、写入 **`update(ns, patch, expectedRevision?)` / `replace(ns, section, expectedRevision?)` / `mutate(ns, ops, expectedRevision?)`**（`write` 为 private，不可调用）、`register` | `dsh-settings` |
| `tokenMeter` | `measure(session, requestHeader)`、`estimateMessage(message)` | `dsh-token-meter` |

其他已核实事实：cordis 服务挂载 API 为 `ctx.provide(name, value)`（宿主多处用法）；输入预填 action `{ type: "input", text, cursor }`；`state.usage = { input, output, cacheRead, contextWindow? }`（**最近一次模型调用**，非会话累计）；面板渲染位置与优先级见 §0.4。

**§3 排除项的源码核实**：`/clear` —— `dsh-session` 类型面确无 `clear`；`/login` `/logout` —— `ctx.credentials` **存在**（`resolve`/`describe`/`set`/`unset`，`dsh-credentials/lib/types/index.d.ts:129/136/145/152`）但仅为凭据**引用** seam，无交互登录流程；`/review` —— `workflowEngine.start` **存在**（`dsh-workflow/lib/types/index.d.ts:119`）但需自备 `script`/`meta`/`parent: Agent` 工作流资产（`runtime-types.d.ts:15-29`）。三者均按能力／语义缺口排除，**非**「API 未找到」。

## 1. P1 命令（3 项候选，纯 TUI 侧）

### 1.1 `/stats`（别名 `/usage` `/context`）

| 项 | 规格 |
|----|------|
| 参数 | 无（别名完全等价）；**不含 `/cost`**——无价格数据源，避免承诺不可用信息 |
| 数据来源 | `state.usage`（已接，**语义 = 最近一次模型调用的 token 用量**，非会话累计）；可选增强 `tokenMeter.measure(session, requestHeader)`（签名已核实，接入成本较高，第一版不做） |
| 输出 | notice 多行，info |
| 内容 | `本回合 tokens：输入 X · 输出 Y · 缓存读 Z`；`上下文：input+cacheRead = N / 窗口（P%）`（与状态栏 `ctx` 段同口径；`contextWindow` 缺失时只显绝对量、省略百分比）；`缓存命中率：cacheRead/(input+cacheRead)` |
| 降级 | `state.usage` 为 undefined → `notice("暂无 token 用量数据（本回合尚未发生模型调用）", "info")` |
| 落点 | 只需 `index.ts`（`case` + `handleStatsCommand()`）；不新增服务 |
| 测试 | 注入 usage → 文本含分解数与百分比；无 usage → info 提示；`contextWindow` 缺失/为 0 → 不除零、只显绝对量 |

### 1.2 `/skills`（前置：批次 0 第 3 项 ✅ 已过门）

| 项 | 规格 |
|----|------|
| 参数 | 可选 `<filter>`（对名称/描述不区分大小写子串过滤） |
| 服务 | `skills.list()` → `SkillSummary[]`（`name`/`description`/`provider`）、`skills.get(name)` → `SkillDefinition`（含 `content` 正文；Enter 详情用） |
| 输出 | 面板（kind `skills`，共享 `commandPanel`；PgUp/PgDn 页高 = 活动区可视行数） |
| 行内容 | `名称 — 描述首行`；来源 provider 作后缀（若条目含） |
| 键位 | ↑/↓/PgUp/PgDn、Enter 显示详情（notice 多行；**先关面板再提示**——面板占满活动区会遮住瞬态 notice，与 `/jobs` 一致）、Esc |
| 降级 | `skills` 服务缺失 → warn「skills 服务不可用」 |
| 落点 | `types.ts` 加 `SkillsLike { list?(): ReadonlyArray<Record<string, unknown>>; get?(name: string): unknown }`；`main.ts` 接 `ctx.get("skills")` |
| 测试 | stub 返回 2 条 → 面板行含名称；filter 生效；服务缺失 → warn；空列表 → 占位行 |

### 1.3 `/agents`（前置：批次 0 第 1 项 ✅ 已过门）

| 项 | 规格 |
|----|------|
| 参数 | 无（面板内操作） |
| 服务 | `subagents.listChildren(parentSessionId, signal?)` → `SubagentListEntry[]`（**列 agent 用这个**；`parentSessionId` 取 `state.activeSessionId`）、`subagents.interrupt(childId, { kind: 'user', parentSessionId })` |
| 输出 | 面板（kind `agents`） |
| 行内容 | `label · mode · activity · hasChildren`（`SubagentListEntry` 已核实字段：`id`/`activity`/`mode`/`label?`/`hasChildren`；`kind:'diagnostic'` 条目显示 `reason`） |
| 键位 | ↑/↓ 移动、Enter 中断选中项、Esc 关闭 |
| 破坏性动作 | **定死为「直接执行 + 结果 notice」**（照 `/jobs` 面板 Enter 取消任务的既有先例；面板内高亮即选择，不再引入二次确认，避免同一 UI 两套交互）。中断目标为条目携带的 `id`，`authority` 用 `{ kind: 'user', parentSessionId: state.activeSessionId }`；条目为 `kind:'diagnostic'`（无可中断 id）时该行不可中断（灰显 + notice 说明）；**中断与不可中断两种 Enter 都先关面板再 notice**——面板占满活动区会遮住瞬态 notice（与 `/jobs` 一致） |
| 降级 | 服务缺失 → warn |
| 与 `/preset` 的区别 | `/preset` 是 `agentPresets`（持久化预设目录，可切换）；本命令是实际存在的子代理（运行中/可续接），**不能互相替代** |
| 测试 | stub 返回 2 条 → 面板行含 label；Enter → 断言 `interrupt` 收到会话 id；条目缺 id → 不调服务并提示；缺失 → warn |

## 2. P2 命令（4 项候选，纯 TUI 侧）

### 2.1 `/tools`（前置：批次 0 第 2 项 ✅ 已过门）

| 项 | 规格 |
|----|------|
| 参数 | 可选 `<filter>`（工具名子串） |
| 服务 | `tools.schemas()`（**scope 省略 = 全局视图**，返回 `ToolSchema[]`：`name`/`description`/`parameters`）、`tools.get(name)`（Enter 详情） |
| 输出 | 面板（kind `tools`，必须支持 PgUp/PgDn——工具数量通常数十条） |
| 行内容 | `名称 — 描述首行` |
| 键位 | ↑/↓/PgUp/PgDn、Enter 详情（**先关面板再 notice**，同上）、Esc |
| 降级 | 服务缺失 → warn |

### 2.2 `/rename`

| 项 | 规格 |
|----|------|
| 参数 | `<title>`；缺参 → `notice("用法：/rename <标题>", "info")` |
| 服务 | `sessionTitle.rename(session, title)`（**首参为 session 对象**，经 adapter 传入当前 session） |
| 输出 | notice success：`已重命名为「<title>」` |
| 联动 | 状态列标题栏由 `session/title` 事件折叠刷新（已有链路），无需手工改 state |
| 降级 | 服务缺失 → warn；空标题/含换行 → error（拒绝，不发服务调用） |
| 注 | 无需面板、无需新 reducer——最轻的一条，可提前实现 |

### 2.3 `/settings`（前置：批次 0 第 4 项 ✅ 已过门）

| 项 | 规格 |
|----|------|
| 参数 | 无（只读展示） |
| 服务 | `settings.describe()` → `SettingsDescriptor[]`（**枚举 ns 且直接带当前值**：`ns`/`value`/`revision`/`base?`/`user?`/`applies`）。首版输出仅用 `describe()`；`get(ns)`（单读，宿主返回 unknown）未接入，留作后续 |
| 输出 | notice 多行（`ns：key = value`，超长截断） |
| 降级 | 服务缺失 → warn |
| 范围 | **第一版只读**。写回涉及真实配置与乐观锁（`expectedRevision`），公开路径为 `settings.update(ns, patch, expectedRevision?)` / `replace` / `mutate`（`write` 为 private），需独立设计与确认契约，不在本命令范围 |

### 2.4 `/fork`（前置：批次 0 第 5 项 ✅ 已过门）

| 项 | 规格 |
|----|------|
| 参数 | 无 |
| 服务 | `sessions.fork(source, boundary?, childSessionId?)` → live `Session`（**后两参可省**：省 `boundary` = 源会话当前最后事件；省 `childSessionId` = store 的 id 策略；`source` 可用 id 字符串） |
| 语义（已核实） | 切片可止于 turn 间事件，**不可落在未闭合 turn 内**；错误码全量 5 个（`SessionForkErrorCode`）：`SESSION_NOT_FOUND` / `SESSION_NOT_LIVE` / `SESSION_ALREADY_EXISTS` / `INVALID_BOUNDARY` / `OPEN_TURN` → 映射为 warn notice（不抛穿） |
| 输出 | success notice（新会话 id/标题）+ 必要时提示用 `/session` 切换 |
| 降级 | 服务缺失 → warn |

## 3. 本轮不纳入（索引）

| 命令 | 类别 | 原因 |
|------|------|------|
| `/memory` | 需插件改造 | knowledge-base 的 `apply` 为同步且 `void createKnowledgeBundle(...)`（服务建完即丢；该工厂是 async）→ 需改插件暴露服务 |
| `/loop` | 需插件改造 | metric-loop 的 controller 未挂 ctx；且需新增 `list()`（现仅有 `start/tick/status(id)/stop(id)`） |
| `/task` ✅ 已实现（A1） | 需插件改造 | task-engine 已 provide 只读查询面（`query()`/`frameStack()`，C1 补全 + ctx 挂载）并由 TUI `/task` 面板接线 |
| `/guard` | 需插件新增能力 | security-guard 仅有 `GuardEngine.inspect(toolName, args)`，无策略/拦截记录查询 → 需先加记录缓冲与 `recent()`/`policy()` |
| `/contract` | 需插件包改动 | `goal-contract` 包入口未 re-export `buildObjective` / `parseContract`（已核实：`index.ts` 仅导出 `name`/`inject`/`apply`，包无 `exports` 字段）→ 公开依赖需加 re-export；深路径 import 内部文件不稳、内联复制会漂移 |
| `/clear` | 宿主无对应能力 | `dsh-session` 类型面无 `clear`（仅 `create`/`get`/`list`/`fork`）；会话清理无宿主入口 |
| `/login` `/logout` | 语义不匹配（无交互登录流程） | 宿主仅有凭据**引用** seam `ctx.credentials`（`resolve`/`describe`/`set`/`unset`，`dsh-credentials/lib/types/index.d.ts:129/136/145/152`）——提供引用解析与写入原语，**无**交互式登录流程（供应商选择 / OAuth / 设备码）；由 TUI 自造属凭据录入与安全边界设计，超出本轮命令范围 |
| `/review` | 需工作流资产 | `ctx.workflowEngine.start(WorkflowStartRequest)` **存在**（`dsh-workflow/lib/types/index.d.ts:119`），但请求要求 `script` + `meta` + `parent: Agent`（`runtime-types.d.ts:15-29`）；宿主未内置 review 工作流资产，由 TUI 内联定义属编排层设计 |

> 这 9 项不进入本轮实现；待插件改造完成或 API 证实后另立规格。

## 4. 实现顺序（批次 0 + 四批，编号与 `COMMANDS-TASKS.md` §0 一致）

| 批次 | 命令 | 验证的闭环 |
|------|------|-----------|
| 0 | （前置）API 合同门 ✅ 已完成 | 5 项全部过门，见 `COMMANDS-TASKS.md` §1；无命令移出 §3 |
| 1 | `/stats`、`/rename` | 「命令 + notice」最小闭环（`/stats` 零新服务只读 `state.usage`；`/rename` 打通首个宿主服务调用） |
| 2 | 共享列表面板 + `/skills` | 「共享面板 + 新服务接线」闭环（建立 `commandPanel` 模型） |
| 3 | `/agents`、`/tools` | 面板 kind 复制（新增 kind 即可，不再写 reducer/渲染器） |
| 4 | `/settings`、`/fork` | 只读展示 / 待确认签名的收尾项 |

## 5. 与既有文档的关系

| 文档 | 关系 |
|------|------|
| `COMMANDS.md` | 上游：命令来源归口与优先级；本文件是其「建议」的可实现化（仅纯 TUI 侧部分） |
| `DESIGN.md` | 上游：布局/面板/焦点约定（§0.4 渲染位置与优先级以 `layout.ts` 实现为准） |
| `SPEC.md` | 上游：Box 生成与渲染契约（共享面板 Box 生成器遵循） |
| `NOTICE-LEVELS.md` | 双向：新增 notice 调用点须同步入 A 表 |
| `COMMANDS-TASKS.md` | 下游：本规格的实施清单（五批拆分、落点、待决） |
| `IMPLEMENTATION.md` | 下游：实现完成后追加实现记录 |
| `docs/DEVELOPMENT-BACKLOG.md` | 下游：命令项以本文件为规格依据 |
