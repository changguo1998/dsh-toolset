# TUI 命令扩展规格（Commands Spec）

> 职责：新增或改造命令时的规格与硬约定（降级、输出三型、面板契约、测试口径）
> 不负责：命令清单（见 `TUI/docs/COMMANDS.md`）
> 过期条件：无

> 用途：新增命令时须遵守的通用约定——落点、服务获取与降级、输出三型、共享面板契约、命名冲突、测试口径，以及已裁定排除项的索引。
> 现状：本地 32 条命令均已实现（清单见 `COMMANDS.md` §1.1），用法见 `README.md`「Slash 命令」，逐命令落点与降级见 `IMPLEMENTATION.md`「命令实现落点」——逐条实现规格不再重复于此。
> 上游：`COMMANDS.md`（命令来源归口与落点决策）、`TUI/docs/DESIGN.md`（四区域布局与面板约定）、`SPEC.md`（Box 渲染与排版契约）、`TUI/docs/design/NOTICE-LEVELS.md`（提示分级）。

## 1. 落点（按命令取子集，最多 6 类）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/main.ts` | `ctx.get?.("<svc>") as <Svc>Like \| undefined` 取宿主服务，加进 `createRealDshAdapter({...})`（与既有 `sessionQuery` / `sessions` / `agentPresets` / `permissionPresets` / `jobs` 同模式） |
| 2 | `src/app/adapter/types.ts` | 加结构化 `<Svc>Like` 类型（宽松返回 + 方法可选，风格照 `JobsLike`）+ `DshAdapter` 上的可选方法（`refresh<Name>?()` / `<verb><Name>?()`） |
| 3 | `src/app/adapter/dsh.ts` | 实现该方法：调服务、归一化返回值；异常内部消化为 `undefined` / `[]` 并经 notice 上报，不抛穿 |
| 4 | `src/app/commands.ts` | **两处**：`SlashRoute` 联合类型加 `"<name>"` **和** `LOCAL_COMMANDS` 加条目（缺一不可） |
| 5 | `src/app/index.ts` | `case "<name>"` 分支 + `handle<Name>Command()` + 键位段（若为面板）+ `/help` 行 |
| 6 | 测试与基线 | `tests/app.test.ts`（`FakeAdapter` 注入）用例 + 文档同步（本文件、`README.md`、`TUI/docs/design/NOTICE-LEVELS.md`）；`/help` 行变化须重跑 freeze 脚本与 smoke（§5） |

> 服务获取走 `ctx.get()`，**无需**改本插件的 `inject` 声明——既有做法即如此（`agentDefaultModel` / `commands` / `sessionQuery` 等均未在 `inject` 中声明，见 `src/main.ts` 注释）。

## 2. 服务获取与降级（硬约定）

- **服务缺失**（`ctx.get` 返回 undefined 或 `adapter.<method>` 不存在）→ `notice("<svc> 服务不可用", "warn")` 后 return，**不开空面板**（先例 `/jobs`）。
- **调用失败**（Promise reject / 同步抛错）→ `catch` 后同一提示（warn），面板保持原状，不崩。
- **级别**遵循 `TUI/docs/design/NOTICE-LEVELS.md`：服务不可用 = warn；命令结果失败 = error；成功且重要 = success；信息展示 = info；进度 = log。新增 notice 调用点须在同一变更补入该文件 A 表。
- 面板命令在拉取失败且面板已开时：先关面板再提示——面板占满活动区会遮住瞬态 notice。

## 3. 输出三型

| 型 | 形态 | 实现 |
|----|------|------|
| notice | 活动区瞬态行（info / log / warn / error / success） | `this.notice(text, tone)` |
| 面板 | 活动区窗口内的列表面板（§4） | 共享 `buildCommandListPanelBox` |
| 预填型 | `reduceState(s, { type: "input", text, cursor })` 写回输入框 | 为后续命令预留，当前无命令使用 |

## 4. 面板通用契约

**渲染位置（重要）**：面板渲染在**活动区窗口**，不是底部交互区。

- 选型点在 `layout.ts` `buildActivePanelBox(state, activityH, contentW)`，优先级：`approval` > `question` > `picker` > `statusPanel` > `jobsPanel` > `commandPanel` > `history` > `completion`；返回 `null` 时活动区显示瞬态行。
- 面板用活动区高度 `activityH` 与内容宽度 `contentW` 构建并 fill 进活动区窗口；面板态底部输入区在**问题交互态（问答 / 审批）改显最近 notice**（尾 `footerHeight` 行、tone 与 hanging 口径同活动区，见 BACKLOG 3.1.1），其余面板为空白占位；提示区恒 1 行（显示该面板键位，文案见 `layout/hints.ts` 的 `hintLine(state)`），`hintRows = 1`、`footerHeight = max(1, interaction − hintRows)`——面板开关不改变交互区高度（避免顶区跳动）；**面板内不再内嵌键位提示**。

**接线点（现状）**：`buildActivePanelBox` 按优先级选型（`commandPanel` 插在 `jobsPanel` 之后、`history` 之前）；`frameGeometry` 的 `modalOpen` 一次性判定 7 类面板非空（approval / question / picker / statusPanel / jobsPanel / commandPanel / history），`normalInput = !modalOpen`——提示区不再随面板隐藏（`FrameGeometry.showHint` 已移除，提示文案由 `layout/hints.ts` 按状态给出），布局层已无独立的 `&& !commandPanel` 条件；PgUp/PgDn 页高取活动区可视行数——在 `index.ts` 按键分支内按 `frameGeometry(state, renderer.getSize()).activityH` 计算（`jobs-panel-page` 与 `command-panel-page` 同一口径）。（`fillPanelBox` / `modalPanel` 与活动区渲染由 `buildActivePanelBox` 返回值驱动，无需额外改动。）

**共享面板模型（不复制 N 套 state/reducer）**：所有列表面板共用一个判别联合与一套实现，kind = `skills` / `agents` / `tools` / `task` / `guard` / `loop` / `workflows` / `search`：

```ts
// state.ts
commandPanel: {
  kind: CommandPanelKind;
  index: number;
  rows: CommandPanelRow[];      // 归一化后的行（标题/副文本/状态符号/载荷）
  loading?: boolean;
  error?: string;
} | null;

// reducer：三件套 + 翻页 + 数据推送
"command-panel-open"   // { kind }
"command-panel-move"   // { delta }   （↑/↓；clamp + 窗口平移）
"command-panel-page"   // { delta: ±1 页；page = 活动区可视行数 }
"command-panel-close"
"command-panel-data"   // { kind, rows, loading?, error? }
```

- 渲染：单一 `buildCommandListPanelBox(panel, height, width): Box` + 薄包装 `fillBoxTree`。
- 键位：↑/↓ 移动、PgUp/PgDn 整页翻页（页高 = 活动区可视行数）、Enter 主操作（各 kind 语义：详情 / 中断 / 无操作）、Esc 关闭、其余按键吞掉；无参重复调用同 kind = 关闭。
- 行样式：首行标题（青）+ 计数，右侧按键提示（灰，按剩余宽截断）；行 = `> ` 高亮前缀 + 状态符号 + 主文本，符号着色沿用 `JobsPanel.statusMark` 口径。
- 空态：灰占位，仍输出恰 `height` 行；超宽 `truncateToWidth`，不切半个 CJK。
- 互斥：打开时关闭 `history` / `picker` / `jobsPanel` / 其他 `commandPanel`。
- 数据：打开时经 `adapter.refresh<Name>()` 拉一次写入 `command-panel-data`；需保鲜的 kind（`agents` / `workflows`）打开期间定时刷新，`/agents` 另有 `r` 手动刷新，其余不做增量订阅（不引入轮询）。

## 5. 命名、冲突与 help

- 命令名规则 `^/([a-z][a-z0-9_-]*)`；别名在 `LOCAL_COMMANDS` 内以独立条目指向同一 route（先例 `/clearscreen` + `/cls`）。
- 与宿主注册命令同名时**本地优先**（先例 `/goal`、`/permission`）；本地未消费的形态应转发宿主，例外是 `/goal`——恒为本地提示、参数被忽略（不转发）。
- `/help` 必须同步加行；help 行数变化会改变冻结基线（`tests/fixtures/focus-frame-legacy.json`）→ 重跑 `node --experimental-transform-types scripts/freeze-focus-frame.mts` 并 diff 审查，随后 `npm run demo -- --smoke` 断言 `SMOKE_PASS` 全绿（36 项）。

## 6. 测试口径（每条命令必备）

| 层面 | 断言 |
|------|------|
| 命令路由 | `FakeAdapter` 注入 stub 服务 → 提交 `/<name>` → 断言 notice 文本与级别 / 面板开启 / state 变化 |
| 降级 | 移除 stub → 断言 warn 提示、不开面板、不抛 |
| 面板渲染 | 直测 `buildCommandListPanelBox`：行数恒等 `height`、空态占位、超宽截断、高亮窗口平移 |
| 键位 | 面板开启时 ↑/↓/PgUp/PgDn/Enter/Esc → 断言 state 与适配器调用（先例 `app.test.ts` 的 jobs 用例） |
| 基线 | `/help` 行变化 → 重跑 freeze 脚本 + smoke（§5） |

## 7. 排除项裁定（不另立规格）

| 命令 | 裁定 |
|------|------|
| `/clear` | 宿主无对应能力：`dsh-session` 公开面无删除/清理 API（`detachEntered` 为 private teardown）、`dsh-session-query` 仅查询、无 `session/delete` 事件；会话清理诉求已由 `/session` 面板多选批量删除（`Space` 标记 + `d`）/ `x` 清理空会话 + `/session clean` 文件级删除覆盖 |
| `/login` `/logout` | 语义不匹配：`ctx.credentials` 为凭据引用/记录 seam（reference 空间 `resolve` / `describe` / `set` / `unset` + record 空间 + `credentials/reference-updated` 事件），无交互式登录流程（供应商选择 / OAuth / 设备码）；`/logout` 亦无宿主「登出」概念 |
| `/review` | 需先建编排资产：`workflowEngine.start` 为通用脚本引擎，须自备 `script` / `meta`（`WorkflowMeta`）/ `parent: Agent`，包内无 review 资产 |

> 三项均因能力 / 语义缺口排除（非「API 未找到」）；若日后宿主补上对外 API 或资产建成，再另立规格。

## 8. 与既有文档的关系

| 文档 | 关系 |
|------|------|
| `COMMANDS.md` | 上游：命令来源归口与现状清单 |
| `TUI/docs/DESIGN.md` / `SPEC.md` | 上游：布局、面板与 Box 渲染契约（§4 渲染位置与优先级以 `layout.ts` 实现为准） |
| `TUI/docs/design/NOTICE-LEVELS.md` | 双向：新增 notice 调用点须同步入 A 表 |
| `README.md` / `IMPLEMENTATION.md` | 下游：命令用法与逐命令实现落点（`IMPLEMENTATION.md`「命令实现落点」） |
| `docs/BACKLOG.md` | 下游：命令项以本文件为规格依据 |

## 附：已核实的宿主服务签名（新增命令时参考）

| 服务 | 精确签名 | 提供包 |
|------|---------|--------|
| `skills` | `list(options?)` → `SkillSummary[]`、`get(name, options?)` → `SkillDefinition`（**服务层用名字符串**；`candidate` 只在 provider 层） | `dsh-skill` |
| `subagents` | `listDescendants(rootSessionId, signal?)` → `(SubagentListEntry & { parentId, depth })[]`（**0.1.7 起 `/agents` 首选**，取 `depth=1` 即直接子代）、`listChildren(parentSessionId, signal?)`（≤0.1.5 返回富条目；0.1.7 起返回投影目录 `SubagentCatalogEntry` = `{ id, createdAt, mode, label? }`，无 activity/hasChildren/diagnostic）、`interrupt(targetSessionId, authority)`（`authority` = `{ kind: 'user', parentSessionId }`）、`interruptByParent(child, parent, 'continuable')`、`start` / `sendMessage`（`list()` 返回 provider 名） | `dsh-subagent` |
| `jobs` | `list(caller?)` / `kill(id, caller?, reason?)`（**caller 形态随版本变化**：0.1.7 起裸 `sessionId` 字符串、≤0.1.5 只读 `caller?.id` 的对象）、增量订阅 `events.subscribe(filter, listener)`（0.1.7，`filter` = `{ owner }` | `{ owners }`）/ `onJobsChanged(listener)`（≤0.1.5） | `dsh-jobs`（bundle 里由 `dsh-jobs-local` 挂载） |
| `tools` | `schemas(scope?)` → `ToolSchema[]`、`get(name, scope?)`（**scope 省略 = 全局视图**）、`register` / `restrict`；`view()` 为 private，不属可用面 | `dsh-tools` |
| `sessionTitle` | `get(session)`、`rename(session, title)`（**首参为 session 对象**） | `dsh-session-title` |
| `sessions` | `list()`、`get(id)`、`create(id, options)`、`fork(source, boundary?, childSessionId?)` → `Session`（后两参可省：省 boundary = 尾事件、省 id = store 策略；错误码 5 个） | `dsh-session` |
| `settings` | `describe(options?)` → `SettingsDescriptor[]`（枚举 ns 且带当前值）、写入 `update(ns, patch, expectedRevision?)` / `replace` / `mutate`（`write` 为 private，不可调用）；`get(ns)` / `register` / `installSection` **在 0.1.7 已移除**（本 TUI 只用 `describe()`） | `dsh-settings` |
| `tokenMeter` | `measure(session, requestHeader)`、`estimateMessage(message)` | `dsh-token-meter` |

其他已核实事实：cordis 服务挂载 API 为 `ctx.provide(name, value)`；输入预填 action `{ type: "input", text, cursor }`；`state.usage = { input, output, cacheRead, contextWindow? }` 语义为**最近一次模型调用**（非会话累计）。
