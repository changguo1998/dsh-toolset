# DSH TUI 实现要点（Implementation）

> 类型：**[implementation]**——实现层关键机制记录（现状方案）。
> 配套：`README.md`（使用与配置）、`DESIGN.md`（架构/设计）、`SPEC.md`（规格）、`COMMANDS.md` / `COMMANDS-SPEC.md`（命令面）。渲染管线重构（主线 A/B）的实施过程已归档至仓库根 `archive/TUI-RENDER-REFACTOR-RECORD.md`。

## Slash 命令路由

- 命令分两路：本地命令目录（`LOCAL_COMMANDS`，`commands.ts`，现 36 项 = 32 命令 + 4 别名）由 app 层直接处理；目录未命中者 `/name` → `adapter.runCommand(line)` → `ctx.commands.execute(agent, line, [], signal)`（官方注册表）。
- `App.submit()` 对以 `/` 开头的输入走 `handleSlash()`，不进 `agent.followup`、不占模型 token / 历史。未命中注册表（execute 返回 `undefined`）→ notice 提示未知命令（**官方 fail-close**，绝不把 slash 行发给模型）。demo 模式无注册表，非本地 `/xxx` 直接提示。
- 命令名语法与官方 client 一致：`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/`（`parseSlashCommand`）。
- 本地命令目录 `LOCAL_COMMANDS`（`commands.ts`）是**路由与补全目录的单一来源**（`routeSlashCommand` 查表，未知名落 registry 转发）；帮助文本与 `/help` 双列表格同源。
- 服务解析：`main.ts` 经 `ctx.get("commands")` 取注册表（cordis 严格模式不允许未注入服务直接属性访问），`commandAgent` 传真实 Agent（注册表作用域查找需要完整 agent，而非 app 的瘦 `DshAgentLike`）。
- **接收者绑定**：caller 侧对 adapter 方法一律以 `method.call(adapter, …)` 保留实例作 `this`——提取为局部变量再调用会让方法体内 `this.xxx` 为 undefined、异步方法恒 rejected、误报「服务不可用」。
- dispose：`App.dispose()` 透传 `adapter.dispose?.()`；adapter 实现中止在途命令的 AbortController、解绑 runtime 监听（collectUnbind）、清空监听集。

**notice 通道**：`DshEvent` 的 `{ type: "notice"; text }`——命令结果 / 错误 / 提示只进 UI 缓冲（`appendNotice`，独立成行，不入流式末行），经 `notice` reducer 落地。级别与着色约定见 `NOTICE-LEVELS.md`。

### 命令实现落点

| 命令 | 机制 | 降级 |
|---|---|---|
| `/init` | 检查会话语义 cwd（`state.systemStatus.cwd`，占位时回退 `process.cwd()`）下的 `AGENTS.md`；缺失则以 `sendUserText(INIT_PROMPT, "/init")` 注入初始化指令（常量在 `commands.ts`） | 已存在则 notice 提示并结束 |
| `/stats` | 读 `state.usage`（最近一次模型调用）→ info 三行：分解 / 上下文（`input + cacheRead`，窗口缺失或为 0 时只显绝对量）/ 缓存命中率（分母 0 → `n/a`） | 无 usage → info 提示 |
| `/rename` | 纯函数 `renameCommandDecision(line)` 判 usage / invalid / apply；apply → `ctx.sessionTitle.rename(live Session, title)`；标题栏由既有 `session/title` 链路刷新，不手工改 state | 空标题 / 含换行本地拒绝；服务缺失 → warn |
| `/model`、`/provider`、`/effort` | 见下文「/model 命令」 | 目录读取失败 → 提示 |
| `/policy`、`/permission`、`/preset` | 见下文「通用状态选项面板」 | 服务缺失 → 提示不可用 |
| `/session`、`/fork` | `listSessions()` / `readSessionSurface(id)` / `deleteSession(id)`；`ctx.sessions.fork(activeSessionId)`（后两参省略 = 源会话最后事件 + store id 策略） | fork 错误码映射中文 → warn；面板失败入 error 态 |
| `/skills`、`/agents`、`/tools` | 共享列表面板（`refreshSkills` / `refreshAgents` / `refreshTools`）；`Enter` 经 `skillDetail` / `interruptAgent` / `toolDetail` | 服务缺失 → warn 且不空开面板 |
| `/task`、`/guard`、`/loop`、`/workflows` | 共享列表面板；`Enter` 经 `taskDetail` / `guardPolicy` / `loopDetail` 取详情；workflows 为只读 | 同上 |
| `/memory` | `ctx.knowledge.getSummary()`（同步优先，否则 `whenReady()` 等待）→ info notice | 服务缺失 / 失败 → warn |
| `/contract` | 取当前会话 goal 快照 objective → `adapter.contractSummary()` 解析 `Done-when:` 段 → ≤4 行 info | 无目标 / 解析失败 → warn |
| `/council` | `ctx.subagents.start("one-shot", …)` 并行拉起 N（默认 2、上限 4）个评审子代理，`Promise.allSettled` 汇总 | 服务缺失 → warn 不假启动 |
| `/search` | 并行多 provider 聚合（见下） | 全部失败 → warn 不空开面板 |
| `/settings` | `ctx.settings.describe()` → `ns：value` 多行 info，secret 脱敏 `<redacted>`；只读不写 | 服务缺失 → warn |
| `/jobs` | `ctx.jobs.onJobsChanged` 增量 + 打开时全量拉取；`Enter` → `ctx.jobs.kill` | 服务缺失 → warn |
| `/goal` | 仅 notice 提示「详情见左侧信息栏」（goal/todo/jobs 常驻状态列） | — |

**只读服务面（插件侧提供）**：task-engine `ctx.provide("taskEngine", { query, frameStack })`、metric-loop `ctx.provide("metricLoop", { list, status })`、security-guard `ctx.provide("guard", { recent, policy })`、knowledge-base `ctx.provide("knowledge", { getSummary, whenReady })`。`/contract` 例外：goal-contract 不 expose ctx 服务，TUI 优先用 `opts.goalContract.parseContract`（`ctx.get('goalContract')`），未挂载时走内置同构回读 `parseContractObjective`（定位独占 `Done-when:` 行 + 段后 JSON 数组）；包入口直读不可行（TUI 无跨包依赖、根无 workspaces、`file:` 依赖被项目约定禁止）。

### 共享列表面板（`commandPanel`）

`/skills` `/agents` `/tools` `/task` `/guard` `/loop` `/workflows` `/search` `/jobs`（会话面板另有自己的一套）共用一套 state / reducer / 渲染：

- `state.commandPanel: CommandPanelState | null`（`kind` / `index` / `rows` / `loading?` / `error?`）；reducer 四件套 `command-panel-open` / `-move`（clamp + 窗口平移）/ `-page`（PgUp/PgDn 整页，页高由调用方按活动区可视行数给出）/ `-close`；数据经 `command-panel-data` 事件推送（kind 匹配才写入，挡迟到数据覆盖新面板；`index` 随数据缩短收敛）。
- 渲染为单一 `components/CommandListPanel.ts`（`buildCommandListPanelBox` + `renderCommandListPanel` 薄包装 `fillBoxTree`）：首行标题青 + 计数 + 右侧灰提示（按剩余宽截断），行 = `> ` 高亮 + 可选符号 + 主文本 — 副文本；占位态（错误红 > 加载中灰 > 空列表灰）输出恰 `height` 行。
- **接线（现状）**：`layout.buildActivePanelBox` 按优先级选型（`commandPanel` 在 `jobsPanel` 与 `history` 之间）；`frameGeometry` 的 `modalOpen` 一次性判定 7 类面板非空（approval / question / picker / statusPanel / jobsPanel / commandPanel / history），`normalInput = !modalOpen`、`showHint` 随之派生——布局层已无独立的 `normalInput` / `modalOpen` 条件拼接；`inputPanelHeights` 提供翻页页高（与面板窗口同口径）。
- 键位在 `handleKey` 面板段：`↑/↓`、`PgUp/PgDn`、`Enter` 主操作、`Esc` 关闭、其余吞掉（面板打开时不可输入新命令）。面板占满活动区期间瞬态输出不可见，故 Enter 类主操作若以 notice 反馈，先关面板再提示。
- **面板保鲜**：`/agents` 与 `/workflows` 在宿主无状态事件面时于面板打开期间定时重拉（`startPanelRefresh`，默认 2s，`agentsRefreshIntervalMs` 可注入；tick 自检面板仍为自身否则停表），`/agents` 另有 `r` 手动刷新。

### 非显然实现要点

- `/search` 的**多引擎聚合是 TUI 侧职责**：`dsh-web` seam 是 provider-**selecting**（`search()` 只跑单个 provider，多 provider 无显式 id 抛 `WEB_PROVIDER_AMBIGUOUS`）。`aggregateSearchSources` 纯函数（`dsh.ts`）组装 provider 集合（`opts.web` 派生 + `options.searchProviders` 注入），`Promise.allSettled` 并行调用 → 合并记 provider → URL 去重 → query-token 关联度（title 命中 ×2 + snippet ×1）降序（同分保合并顺序）→ 截断 `maxResults`（默认 10）。
- `/contract`、`/council` 的目标取当前会话 goal 快照 objective，无 goal 时回退 buffer 最近 user 行。
- `/agents` 的 `kind:'diagnostic'` 条目灰显且 payload 置空（无可中断 id 时只提示、不发调用）。
- `/session` 的 live 会话读取走 `Session.events` 原始事件（`readSurface` 的 surface fold 会滤掉 `surfaceOp`，`readSession` 的全量校验对 live 混合日志会抛校验错）；persisted 会话走 `readSurface`，兜底 `readSession`；`readSurface` 必须直接调用 `sq.readSurface(id)`（解构丢失 `this` 读 `_corpus` 报错）。
- `/session` 批量删除：`Space` 标记 / 取消（标记后高亮自动下移一行）、`a` 全选当前范围可删项（替换标记集）、`c` 清空；判据 `deletableSession`（persisted + 非 live + 非当前），`deletableSession` / `markableSessionIds` 为 `state.ts` 纯函数。标记按 id 记录并跨 `Tab` 范围切换保留；`d` 有标记 = 批量（`pendingDeleteIds`，跨范围保留的标记也计入、自动剔除已不可删项），无标记 = 单条（`pendingDelete`）。批量与单条共用 `runPendingHistoryOp` 的逐条 `deleteSession` 串行删除循环，成功集经 `history-delete-done` 移除记录（`dropHistoryRecords`），**失败项保留标记**便于重试；列表重拉只一次。

## 文本管线（流式 / 清洗 / 补发）

- **sanitizeText（渲染保护）**：流式文本进 buffer 前清洗——CRLF / 孤立 CR 归一为换行（否则 `\r` 残留被终端当回车、抹掉整行造成大段空白），其余 C0/C1 控制字符（含 Tab、孤立 ESC）剔除，完整 ANSI 转义序列（CSI / OSC）保留（渲染着色功能，`/copy` 时再剥离）。剔除计数入 `state.strippedChars`（turn-begin 清零），turn-end 后以黄色 notice 提示。恢复历史（`surfaceToBuffer`）同样走清洗。
- **非流式回复补发**：`assistant/message` 是每个 step 结束必发的完整正文 surface 事件。adapter 按 `(session:turn:step)` 累计已流式输出的正文（reasoning 不计），该事件只补发缺失后缀；非流式 / 无思考 provider（无任何 chunk）累计为空 → 直接输出完整正文。`surfaceOp: replace` 的影子覆盖事件跳过（append-only 无法安全重写）；`turn/end` 与 dispose 清空累计。
- **消息 identified**：`buildUserMessage` 用 `crypto.randomUUID()` 生成稳定消息 `id`——`agent/inbox/spliced` 与 `user/message` 均带 identified 标记；缺 id 会导致后续 `agents.resume` 全量校验抛 `SessionPersistenceCorruptionError`（会话永久不可 resume）。
- **零宽字符宽度**：`charWidth` 对组合附加符 / 变体选择符 / ZWJ / ZWSP / emoji 肤色修饰符等计 0 列（对齐 Markus Kuhn wcwidth 零宽表），避免工具内容夹带特殊字符时总宽度虚高或提前换行。

## 事件 → 状态 → 渲染

完整映射与渲染语义见 `DESIGN.md`「事件接入与渲染」。实现要点：

- raw 事件由 adapter 归一化为 `DshEvent` → App 事件 switch → state reducer → `buildFrame`；`DshEvent` 为封闭联合，新增成员需同步 `index.ts` 穷尽登记（否则 `npm run check` 失败）。
- tool 行文本由 `layout/tool-line.ts` 纯函数组装；summary / detail 启发式由 adapter（`dsh.ts`）在归一化时产出。
- **seq 守卫**（per-session 游标）：`event.seq <= lastSeq` 丢弃；间隙接受不补缺；非活跃会话丢弃。

## 会话状态恢复（Mode / 模型 / goal / todo / TUI 本地开关）

切换会话（`/session` Enter → `agents.resume`）与启动时都不重放历史事件，故 `App.start` /
`resumeToSession` 成功后调用 `adapter.restoreSessionState?(id)`（adapter 侧 `restoreSessionState`），
折叠**宿主日志**与 **TUI 侧快照**两份来源并 emit 对应事件：

- **宿主日志**（live 内存事件优先，其次 `sessionQuery.readSession`；**不能用 `readSurface`**——
  log-only 事件被 surface fold 滤掉）：
  - `plan/mode` / `sandbox/mode` / `permission/preset` / `approval/policy` 末条 → `mode` /
    `approval-policy`（原 `emitSessionModeSnapshot` 能力）；
  - **模型**：末条 `model/selection`（显式意图）→ 末条 `request/header.header.config`
    （该会话最近一次**实际使用**的 provider / model / effort；TUI 的 `/model` 也记在这里）；
  - `goal/change`、`todo/write` 末条（全量快照事件，latest-wins）→ 回填状态列。
- **TUI 侧会话状态快照**（`<会话目录>/tui-state.json`，`adapter/session-ui-state.ts`）：
  `/model` 结果、`/verbose`、`/symbol-unify` 与 Mode 兜底值。宿主不认识 TUI 本地开关，
  「已选但尚未发起请求」的模型也不在日志里——这两类只有快照能恢复。

每项取值优先级 = 宿主日志 → 快照 → 宿主默认（`permissionPresets.defaultPreset` 捆绑；
plan 无记录即 off）。模型命中即写回 `sessionModel.current`（`agent/request` 钩子的生效源，
也是 `/model` 面板与状态栏的显示源）；三者皆无则**清空**该引用回落宿主实时默认——顺带修掉
「同进程内 A 会话的模型选择泄漏进 resumed 的 B 会话」。

落盘时机：`/model`、`/verbose`、`/symbol-unify` 与 mode / policy 事件 → 400ms 合并写
（`SESSION_STATE_SAVE_MS`）；切换会话前与 `dispose()` 前 `flushSessionStateSave()` 立即写。
快照随会话目录走（会话删除即随之清理）；仅内存会话（无持久化目录）静默跳过；文件损坏 /
版本不符 / 字段类型不符按「无快照」或逐项丢弃处理，绝不影响渲染。

## 滚动偏移收敛（越界假死）

- **现象**：上滚历史（或按 `Home` / `End`）后按 `↓` 画面纹丝不动；发送消息后更容易撞上。
- **根因**：`scrollOffset`（对话区）/ `activityScroll`（活动区）无上限——连续上滚越顶会一直累加，`End` 曾直接置 `Number.MAX_SAFE_INTEGER`；渲染层只在显示侧 clamp，状态里留着越界值。此后下滚每按一次只是「还债」一格，差额大时等于永久卡住。
- **修复**：状态里的偏移恒在真实范围内——`buildFrame` 出帧时顺带回填 `FrameScrollReport{dialogueMaxScroll, activityMaxScroll}`（零额外排版开销；对话区上限取**未折叠**全量行数 − 可视行数，上滚会解除折叠，折叠态上限偏小不能作上界）；App 侧 `paneMaxes()` 取上限（出帧回填过就直接用，否则就地补算一次同口径帧）；`scrollBy(state, delta, maxOffset?)` 与 `activity-scroll` action 先收敛当前偏移再叠加 delta、结果不超上限；`End` 改为真实上限。
- **回归**：`tests/app.test.ts`（上滚越顶后 `↓` 立即响应 / `End` 后 `↓` 立即响应 / 活动区同理）+ `tests/layout4.test.ts`（回填值在折叠态下仍为未折叠全量）。

## 历史区回滚：语义锚点 + 渐进窗口

- **为什么**：旧的「距底部行数」+ 全量物化模型有三处弱点——底部新增 / 流式增长会改变同一偏移所指的内容（视图被顶走）、resize 重排后锚定内容跳、首帧上滚要付一次全量排版。
- **语义锚点**（`layout.ts`：`DialogueAnchor{seq,row}` / `DialogueSpan` / `DialogueGeometry`）：位置改成**内容身份**——视口顶行 = 来源 buffer 行的稳定序号 `seq` + 行内换行序号 `row`（`seq = -1` 是折叠占位行）。序号在行插入时由 `state.append*` 分配（`BufferLine.seq`，`nextSeq` 单调递增），`RowMeta.seq` / `ContentRow.seq` 由 `buildBox` / `fill` 透传，`dialogueSpans(rows)` 每帧把行按序号压成分组表（无序号时回退行下标，便于直接构造 buffer 的单测）。**为什么必须稳定序号**：`turn-begin` 会 filter 掉上一回合的瞬态活动行、`MAX_BUFFER_LINES` 会从头部裁剪——两者都让行下标整体平移，按下标存的锚点会指向别的内容（表现为「提交新消息后视图跳到新内容」）。
- `anchorToIndex` / `indexToAnchor` 互算（锚点行已被清掉时收敛到空间上最近的前一行，越界收敛首 / 末行）、`moveDialogueAnchor(anchor, deltaRows, geom)` 做行位移（顶到窗口末行 → `null` = 跟底）、`anchorToOffset` 供 `scrollOffset` 派生缓存口径。帧渲染取 `topIdx = anchor === null ? maxTop : clamp(anchorToIndex(...))`。
- **渐进窗口**（`dialogueWindow(buffer, groups)` / `turnGroupStarts`）：只物化尾部 `windowGroups` 个回合组（缺省 `DIALOGUE_KEEP_REPLIES=3`，组起点 = user 行或无 user 前缀的回复起头）；窗口未覆盖最旧内容时顶部加 `...(更早回复已折叠)` 占位行。`buildContentRows` 接切片 + `lineOffset`，「折叠」不再是显示层裁剪，而是排版量随窗口收敛。
- **增窗 / 复位**：`scrollDialogue()` 在位移后判断——上滚且视口顶行进入窗口顶部半屏区间（或窗口内已无可滚行）→ `windowGroups += WINDOW_GROW_STEP(3)`（封顶总组数）；扩窗在视口上方插入行、锚点不变故画面不跳；下滚回到底部时复位默认组数。
- **App 接线**：`FrameScrollReport` 增 `dialogueGeometry{rows,height,spans,topIdx}` + `dialogueTop`（本帧渲染的锚点）；`paneMaxes()` 同口径回填 / 补算；`syncScrollAnchor()` 在出帧后把收敛后的锚点 / 几何 / `scrollOffset` 写回 state（派生缓存，帧已按该锚点渲染故不触发重绘）。**窗口起点不滑走**：用户停在历史里（锚点非 null）而尾部新增了回合组时，按新增组数把 `windowGroups` 撑住。
- **回归**：`tests/scroll-anchor.test.ts`（9 例：组切分 / 切片、互算往返与越界、底部新增不顶走视图、resize 重排锚点可解析、位移到顶 / 底、增窗与复位、`End` 跳最旧、回合切换清瞬态行后视图不跳）+ `tests/layout4.test.ts`（窗口 / 占位 / 报告口径）+ `tests/app.test.ts`（键位路径）。

## 排版尺寸唯一来源：FrameGeometry

- **问题**：`metricsFor` / `topPaneSplit` / `regionColumnWidth` / `renderStatusLine` 曾在 `buildFrame`、`buildTopRegion`、`inputPanelHeights`、`dialogueScrollMetrics` 各自算一遍（同一件事 4 份），口径漂移即出现「帧里看到的 pane 高度」与「滚动 / 翻页用的 pane 高度」不一致（横向排列下活动区内容仍按纵向高度排就是这类缺陷）。
- **做法**：`frameGeometry(state, size): FrameGeometry`（纯函数，`layout.ts`）把状态栏行、模态 / 提示区判定、`metricsFor`、`topPaneSplit`、排队块行、视口高、分隔列、内部分隔列、焦点框矩形基准一次算定并返回；`buildFrame` / `buildTopRegion` / `buildStatusSeparator` 与 App（`focusedLineScroll` / `focusedPageScroll` / `userInputJump` / 补全可视行）只读这一份（字段清单见 `SPEC.md` §11.3）。
- **语义保持**：面板开关不改变顶部内容行数（输入态 `footer = 交互相−1 + 提示 1`，面板态 `footer = 交互相 + 提示 0`，`contentTopH` 相同）；`frameGeometry` 同时产出 `statusLines`，`buildFrame` 不再重复调 `renderStatusLine`。

## 对话左右交错留白（`messageGutter`）

- **口径**：超长（英文）输入折行时，输入的最左侧与回复正文第 5 个字符同列。
- **文字右缘留白（`PANE_TEXT_MARGIN_COLS=1`）**：历史区/活动区的**文字排版宽**在各自 pane 宽上再收窄——横向两 pane 各让 1 列（历史 1 + 活动 1 = 2）、纵向两 pane 同列同宽各让 2 列（`frameGeometry.dialogueTextW/activityTextW`；排队块、活动区面板同口径）。**所有横线一概不缩**：标题栏下划线、活动区分隔线、回合分隔线（`╌`，按 `ContentRow.kind === "separator"` 识别并补满）、状态栏上下边框都铺满到屏幕最右列（区域外缘框列在横线行补 `─`/`╌`）。**活动区行尾不补空格、也不画右边框**：`buildTopRegion` 对活动区行跳过 `padSegs` 与外缘框列字形；`FocusFrame` 的 activity 分支只画左缘竖线，顶/底亮线铺到最右列收尾（无角字）。回归：`tests/pane-text-margin.test.ts`。
- **列口径**：区域右缘框列是焦点框保留格（`FRAME_RIGHT_COLS=1`），正文区自区域正文起始列（状态列与分隔竖线之后，屏幕列 = `statusColWidth`）起算——回复行 `┃` 占正文区第 0 列、正文自第 1 列起；用户块整体右对齐，左缘留白 `gutter−1` 列（`spacer(fill, min)`）、块内右缘 `┃` 贴正文区最后一列。故输入正文起列 = 正文区起始列 + `gutter−1`（屏幕列），令其等于回复第 5 字符所在列（正文区第 5 列）解得 **`gutter = 6`**。
- **两侧同源**：`gutter` 同时是用户块左缘留白与回复右缘留白（`finalSpace` 的 `spacer(fixed gutter−1)`），故默认 6 时两侧文本上限对称各收 2 列（宽 60 时：正文区 39 列 → 回复正文 33 列、用户文本 33 列）。
- **连带**：竖线可见阈值 `USER_MIN_LEFT_GUTTER + 2` 由 6 上移到 8（w ≤ 7 不画竖线）；`DEFAULT_MESSAGE_GUTTER` 与 `normalizeTuiDisplayConfig` 缺省同步为 6。
- **回归**：`tests/layout4.test.ts`「输入最长折行左缘与回复正文第 5 个字符同列（gutter=6）」+ `tests/content-mapping.test.ts` 竖线阈值边界（w=6/7 关闭、w=8 开启）+ `tests/fixtures/focus-frame-legacy.json`（w20 四场景按新口径冻结）。

## 多行用户输入 = 一块

- **口径**：一次输入（含 `Ctrl+J` 显式换行）视为**一个块**——块内行首左对齐（各行共享左边界）、块宽 = 该块折行后最长行宽、整块右对齐（右缘 `┃` 贴正文区最后一列，短行右侧补白）。
- **实现**：`appendStream` 对 `kind="user"` 不按 `\n` 拆行（整段 = 一条 buffer 行、一个 `seq`）；折行 / 补白交给渲染层——`fill.decorateRows` 按 `maxBodyW` 给每行右侧补白到块宽，故块内各行天然左对齐、`┃` 同列。配套：`queuedBlockRows`（排队消息同语义）；`surfaceToBuffer` 的 user 消息也不拆（恢复的历史输入同样一块）。
- **assistant 仍逐行拆**：正文流式逐行到达，且 fence 开合、尾部空行清理、回复组折叠都按 buffer 行粒度工作。
- **回归**：`tests/layout4.test.ts`「多行输入为一块」+ `tests/app.test.ts`（`user-line` 保留换行 / `append` 仍拆行 / `surfaceToBuffer` user 整段保留）。

## 活动区内容生命周期

- **不按组数折叠**：工具调用历史只受**活动 pane 可视行数**约束——内容先自下往上填满整块 pane（`activityH`，横向排列时 = 整列可用行数），更早内容折叠在 pane 顶边之外，Tab 聚焦活动区后 `↑` / `PgUp` 可回看（`activityMaxScroll = 活动内容行数 − activityH`）。
- **清空时机 = 用户输入**：`turn-begin` 带 `clearActivity` 参数——为 true 时整类清空活动区（thinking / tool / notice / 非 final assistant 一起清）并把 `activityScroll` 归零；`App.beginTurnIfNeeded(userInput)` 只在「用户输入开启的回合」传 true（空闲提交与排队消息被核心认领）；核心自发的回合（goal 轮次、定时唤醒等）只画分隔线、保留上一轮内容继续往上堆。
- **打字机不丢内容**：正文到达或延迟 `turn-end` 接管时，未放完的思考由 `drainThinking()` 整段放入缓冲；`dropThinking` 仅留给 `dispose`。
- **回归**：`tests/app.test.ts`「活动区生命周期：核心自发回合不清空」+ `tests/layout4.test.ts`「工具历史不按组数折叠，只受活动 pane 可视行数约束」。

## 活动区详略两态（`/verbose on|off`）

- **语义**：状态 1（`verbose on`，缺省）每条目完整折行；状态 2（`verbose off`）每条目压成 1 行 + 行尾 `…`，条目内换行折叠为空格。触发方式为**用户显式命令**（不做「按 fill 高度预算自动降级」——自动降级会让同一份内容在不同窗口高度下详略跳变，阅读位置不稳定）。
- **实现**：`state.activityVerbose: boolean`（缺省 true）+ action `activity-verbose{on}`；`buildTopRegion` 传 `activityCompact: !state.activityVerbose` → `BuildBoxOptions.activityCompact`，全部落在 `build-box.ts` 构建期（`compactActivityLine` 单行压缩：按显示宽截断时预留 1 列放 `…`，宽度 = 活动 pane 宽扣该条目前缀列数）。各分支：thinking、tool（调用 / 结果 / 辅助行，用压缩后文本再上色，工具名前缀保持）、notice（紧凑下不再设 `hanging`）、非 final assistant（紧凑下不建 markdown 表格，因其天然多行）。
- **与 pane 高度 / 滚动的关系**：紧凑只改条目行数，`activityH` 与 `activityScroll` 口径不变；行数变少后 `activityMaxScroll` 自动收敛。
- **回归**：`tests/activity-verbose.test.ts`（完整模式折行多行 / 紧凑每条目 1 行且 ≤ pane 宽 + 行尾 `…` / 换行折叠 / 短条目不加省略号 / 端到端 buildFrame 行数收敛）+ `tests/app.test.ts`（切换与无参 / 非法参数只提示用法不动状态）。

## 活动区排列：黄金分割比自动选上下 / 左右

- **位置**：`layout.ts` 的 `topPaneSplit`（纯函数），唯一调用点是 `frameGeometry`（几何唯一来源）。
- **判定**：pane 宽高比与 φ≈1.618 的对数偏差（`|ln(w/h/φ)|`，取两 pane 较差者）小者胜；等分（divisor=2、纵向两 pane 等高）时等价于「区域正文宽 / 可用行数 > φ → 左右排列」。判据只吃区域正文宽 + 顶部内容高，不含状态列宽。
- **为什么不放在 state**：判定是尺寸的纯函数，启动与 resize 各自重算即可；不做滞回（阈值处反复拖动终端时最多一次翻转，且翻转点本身就是重排点）。缺省 `"vertical"` 保持既有上下语义（含 `activityTopRow` 锚定与 `activityHeightDivisor` 比例）。
- **两 pane 独立宽度**：横向时历史 pane 在左、活动 pane 在右；活动 pane 宽 = `floor(正文宽 / divisor)`，对话 pane 宽 = 正文宽 − 活动 pane 宽 − 1（两侧各保底 20 列 → 正文宽 < 41 或可用行 < 2 时回落上下）；**文字**排版另扣右缘留白（见「文字右缘留白」）。`BuildBoxOptions.activityWidth` 让 `buildContentRows(buffer, opts, w, aw)` 两 pane 各自 measure / fill；**不做两次 buildBox**（流式下 markdown / 表格构建会翻倍），只在构建期给活动 pane 的表格用 `activityWidth` 算预算。
- **拼行**：横向行 = 状态列 + D 列 `│` + 历史行（补空格到 `dialogueW`）+ 内部分隔 `│` + 活动行（补到 `activityW`）+ 区域右缘框列；活动区分隔行消失，标题栏下划线行在内部分隔列让位 `┬`，状态区分隔行该列收束 `┴`（`buildStatusSeparator` 以几何为入参）。活动 pane 恒底部对齐（与纵向一致），面板仍顶部对齐且按 `activityW` 排版。
- **滚动**：`scrollOffset` / `activityScroll` 语义不变（距各自 pane 底部行数），换行宽度 / 视口高变化——所有跳转 / 半屏 / 翻页坐标统一读 `frameGeometry`。
- **焦点框**：区域矩形左缘 = D 列（分隔竖线，与状态列共用 → 顶/底边用连接字 `├`/`┴`）、右缘 = 区域外缘框列（角字 `┐`/`┘`）；`FocusFrameContext.innerDividerCol` 非 undefined 即横向——history 右缘 / activity 左缘改为此列（顶边 `┬`、底边 `┴`），activity 右缘仍是区域外缘框列；rects 按左右并排构造。
- **回归**：`tests/layout-horizontal.test.ts`（8 例：内部分隔列与 `┬`/`┴`、两 pane 定宽、滚动口径一致、焦点框角字、独立宽度换行、活动区底部对齐、排队块钉在历史 pane 右下角）+ `tests/config.test.ts` 的 `topPaneSplit` 判定表。

## 排队消息（agent 运行中 Enter）

- **发送完全走官方流程**：`App.submit` 在 agent 忙（`agentStatus !== "idle"` 或本地 `inputStatus === "running"`，覆盖「刚提交、核心状态事件未到」窗口）时仍立即 `adapter.sendMessage(text)` → 核心 `followup`（`next-turn` 队列，durable）——逐条、不合并、不由 TUI 积压；空闲时走 `sendUserText`（本地回显 + 直接发送）。两条路径发送语义一致，**差别只在显示**。
- **显示登记**：`state.queued: string[]`（按提交顺序）+ action `queued-push` / `queued-claim`（弹出最早一条并落入历史）/ `queued-clear`。登记只用于渲染，不代表 TUI 持有消息（消息已在核心队列里）。
- **认领时机**：`beginTurnIfNeeded()` 在 `turn-begin` 之后 `queued-claim`——核心每开一个新回合从 `next-turn` 认领一条，UI 因此「每回合转正一条」；转正后按普通用户行渲染（亮红右缘竖线）。
- **渲染**：`queuedBlockRows` 以 `BufferLine{kind:"user", queued:true}` 走同一套 `buildContentRows`（右对齐 + 灰竖线），得 `geom.queuedRows`；对话 pane 最后 `queuedRows.length` 行渲染排队块（钉在右下角、不随历史滚动），历史视口高 = `dialogueH − queuedRows.length`（至少留 1 行历史；超长取尾部）。
- **Esc / Alt+Enter**：Esc 先 `restoreQueued()`（登记按顺序并回输入框，核心 `cancel` 会清自己的队列，本机留底不丢输入）再 `interrupt()`；Alt+Enter 同样先并回输入框、打断，然后整条发送（避免「新文本先发、排队内容后发」顺序颠倒；空输入且无登记仍为 no-op）。切换会话（`history-resume-ok`）时 `queued-clear`。
- **回归**：`tests/app.test.ts`（运行中 Enter 立即发送且逐条不合并、登记不写 buffer、新回合认领一条转正、Esc 退回输入框 + 清登记 + 打断、Alt+Enter 按序并入）+ `tests/layout-horizontal.test.ts`（排队块位置 / 灰竖线 / 视口高收缩）。

## /help 双列表格（无边框）

- **排版**（`app/layout/help.ts`）：`helpTableLines` 把命令目录排成两列——命令列定宽 = `min(最长命令显示宽, HELP_CMD_MAX=10)`（CJK 安全补白）、描述列固定起点；每行 = 行首 2 列缩进 + 命令 + 补白 + 2 列间距 + 描述。命令显示宽超 10（常见诱因：别名/参数示例合并写在一个命令里，如 `/provider、/effort (/thinking)`）不再撑宽整表——拆成两条独立行：命令独占一行、描述另起一行缩进到描述列起点（第二列），后续软折行续行同样停在描述列。描述列起点 = 2 + 上限(10) + 2 = 14 列。
- **折行**：不做预折行，交给渲染层——notice 的 `BufferLine` 可选 `hanging`（描述列起点的悬挂缩进），`build-box` 落到 `StyledText.hanging`，描述超 pane 宽时续行停靠描述列起点且 resize 后仍对齐。`BufferLine.hanging` 只在 `/help` 生效。
- **入口**：`App.helpLines()` 产出「表头 + 表中行 + 表尾」结构化行，`handleSlash` 走 `notice` action 的 `lines` 字段（`appendNoticeLines`，逐条独立成行）；表头 / 表尾无悬挂缩进。
- **回归**：`tests/help.test.ts`（命令列定宽 / 超宽命令拆行 / 全短命令回落 / CJK 补白 / 单物理行）+ 渲染层用例（窄 pane 强制折行时续行缩进 == 描述列起点；超宽命令描述另起一行的缩进 == 描述列起点）。

## markdown 列表项悬挂缩进

- **行为**：`wrapAssistantLine` 的普通列表（`-` / `*` / `+` / `1.`）与任务列表（`- [x]` / `- [ ]`）长项折行时，续行行首补与列表前缀同宽的空格（无序 `• ` 2 列 / 有序数字前缀按实际列数 / 任务 `[x] ` 4 列），正文与首行文字同列对齐。
- **实现**：`layout/markdown.ts` 的 `wrapListRows(segs, prefixWidth, width)` 复用 `wrapFrameSegments` 的 `hanging` 续行折宽（扣 `prefixWidth` 封顶总宽），并在折行结果每个续行行首补 `prefixWidth` 宽空格段；首行保持前缀随正文全宽折行；前缀宽 ≤ 0 或无续行时原样透传。
- **对齐设计意图**：`SPEC.md` §2 的 `text(prefix:{"• "}, hanging:2)` 已声明列表悬挂缩进，与工具行 / `/help` 双列表格的悬挂机制同构。

## markdown 表格（`SPEC.md` §3.2）

- **位置**：`src/app/layout/table.ts`（解析 + 构建期降级构建器）；识别与接线在 `layout/build-box.ts` 的 assistant 分支（索引循环以便逐行前瞻）。
- **为什么构建期算宽**：列宽是跨行约束（同列各行必须等宽），纯 `v`/`h` 表达不了跨兄弟约束；构建期把 2D 数学算完，产出「每格 `width:fixed`」的 `v([h([…])])` 子树，引擎保持两类节点。因此 `buildBox` 新增 `BuildBoxOptions.width`；**宽度未知时不识别表格**（按普通文本行渲染）。
- **识别**：`isTableStart`（表头须含未转义 `|` + 分隔行格全为 `:?-+:?` 且列数一致）做 O(1) 预筛，仅命中时才向前收集连续表格行（首个非 `|` 行停止）；`fence` 内不识别。数据行缺格补空、多格忽略。
- **单元格叶子用 `StyledText` 而非 `Paragraph`**：构建期就做行内解析，否则 `measureParagraph` 按原文（含 `**` 等标记）算行数，与 `fill` 的渲染文本口径不一致、会多出空行。行高由 `measure(leaf, {maxW: colW})` 用引擎同口径算得后显式声明 `height:fixed`，`fill` 的 `valign:"center"` 补白才生效。
- **网格：左缘竖线连续 + 1 空格间隔**：整表最左 1 列为 `┃`（`brightBlue`，与 assistant 正文左竖线同列同色）——竖线概念上属父级 box、内容整体在其右侧，故逐行重复（含折行续行与横线行），整条回复左缘竖线连续；竖线后固定 1 空格（表格 box 的 prefix），横线自该空格之后起、**不与左缘竖线连接**，左缘不设交叉字（用交叉字会把蓝色粗竖线替换成细线 / 双线，且 `╢` 向右无横线导致表头双横线左端断开）。数据行之间画单横线（首尾不画）以区分折行内容。
- **网格线不着色**：`│` / `═` / `─` / 交叉字一律用主题默认前景色，只有左缘竖线取 `brightBlue`；表头格加粗与格内行内样式照旧。横线行的横线须铺满整个列区域（列宽 + 左右留白），故不经 `gridRow` 的 pad 装配（否则每列多出 2 列、总宽超出预算导致折行错位）。
- **列宽求解**：自然宽按渲染文本计（CJK 2 列）；超预算用**水位法**（`waterLevel` 二分）——窄列保持自然宽、只有超宽列被压到共同水位线，避免按比例缩放把窄列压到 `minW` 以下；抬到 `minW` 后若超预算则退回纯水位线。`ΣminW` 仍放不下 → 按 `minW` 比例分配 + 格内 `…` 截断（`truncateSegs` 段感知，不切半个 CJK）。数字列在分隔行未显式标注且表体非空格全为数字时自动右对齐。
- **窄终端回退**：可用宽 < 左缘竖线 + 1 空格 + 每列 1 列 + 固定开销 → `tableBox` 返回 `null`，调用方退回普通文本行。
- **元数据**：表格子树整棵挂同一 `rowMeta`（`markSubtree`）——`fill` 后各行 `kind` / `blockId` 必须与所在回复一致，否则回复组折叠（`dialogueWindow` 按连续 assistant 行切组）与块内空行判定会把表格当成新块。
- **回归**：`tests/table.test.ts`（21 例：解析 / 转义 / 列宽 / 压缩 / 截断 / 对齐 / 加粗 / 网格与交叉字 / 左缘竖线连续 + 间隔空格 / 行高 / fence 保护 / 窄宽回退 / 元数据传播）。

## 模型输出符号规范化

- **纯函数**（`app/symbols.ts`）：`resolveSymbolRules`（内置默认 + 配置合并）与 `normalizeSymbols`（逐码点：孤立代理 / 零宽跳过 → **正文内容性排版字符放行**（`TEXTUAL_RANGES` / `TEXTUAL_POINTS`：框线 2500-259F、数学括号 2308-230B、键盘按键 `⌃⌘⌥⌦⌧⌨⌫⇧⇪`，置于别名之前、不参与任何治理）→ 别名映射替换 → 治理区 `[2190-21FF, 2300-23FF, 2500-27BF, 2B00-2BFF, 1F000-1FAFF, FFE0-FFE6]` 内查推荐白名单 → 文字 / 标点放行 → 其余放行）。输出替换后文本 + `replacedCount / remaps / emojiRemaps / unrecommended`（emojiRemaps = 仅 emoji 呈现起源的替换明细，供反馈按「要求更换」罗列）。推荐符号与别名清单见 `README.md`「符号规范化」。

**选型判据**（用于后续扩展推荐 / 别名对齐）：

1. 归一依据 = **形状身份（几何部件组合）**；功能、语义、宽度一律不参与。
1. 同一形状身份内只容**修饰性变体**归一：粗细、大小、重复数量、emoji 上色、内缀细节；**明暗 / 填充（空心 vs 实心）不是修饰**——空心、实心各为独立一族。
1. 触发**拆分**（不归一，按几何各自独立）：明暗 / 填充、新增独立部件（方框）、核心形状变化（圆环 vs 实盘、勾 vs 根号）、方向 / 对称变化（反向、双向 vs 单向）。
   - 校准点：`☑` / `☒` 与追加符号区 `🗹` / `🗷` 为**特例**（虽带独立方框，不各自成族也不拆分提醒，并入无框的 `✓` / `✗` 族）；`√`（根号）治理区外放行；`⏩⏫⏬`（双三角 = 数量 / 速度修饰）归入 `▶` / `▲` / `▼`；C 族短双线 `⇒⇐⇔` 按方向归一到长双线代表 `⟸⟹⟺`；空心三角族 `▷◁△▽` 四向代表入白名单、族内尺寸 / 指针变体归一到该向代表，与实心族不互相归一。

**接入**（`app/index.ts`）：`case "stream"` 对每段正文 `normalizeSymbols`（slowStream 的 `pendingStream` 与直发两条路径都走），结果累积到 `symbolTurn`（跨段去重）；`turn-end` 两个分支后 `flushSymbolTurn()` —— 有替换 / 未推荐则 notice（给人）+ 按需生成 `[符号规范]` 反馈。反馈在 turn-end 检测到后**宏任务推迟直发**（`setTimeout(0)` + `adapter.sendMessage`；turn-end 回调内同步 followup 宿主不接，实测不送达 / 不落盘），不经 `sendUserText`（避免清空活动区刷掉 notice），发送前检查 `disposed`。

**同符号冷却**：`flushSymbolTurn` 开头 `tickSymbolCooldown()` 推进 run 计数；emoji 罗列 / 变体计数 / 警示列表三组各自按 `isSymbolCooling(from)` 过滤冷却中的符号，本轮真正列入提醒的符号 `enterSymbolCooldown` 登记——三组全部被冷却时该 turn 完全静默（无 notice 无反馈）；不随用户下一条消息合并。

**配置**（`app/config.ts`）：`tui.config.json` 的 `symbols.{recommended[],aliases{},warnModel,cooldownMs,cooldownRuns}`，`main.ts` 经 `new App({ symbols })` 注入，缺省走内置默认（冷却 10 分钟 / 3 run，传 `0` 关闭对应维度）。

**开关**：`/symbol-unify on|off`（缺省 on，会话级）——`off` 时 `stream` 不规范化、`flushSymbolTurn` 直接跳过（不提醒不注入）；`state.symbolUnify` 由 reducer `symbol-unify` 切换。

**回归**：`tests/symbols.test.ts`（纯函数 7 例）+ `tests/app.test.ts`「symbols」组（展示层替换 / notice / warnModel 注入与关闭 / recommended 扩展 / 开关 / 同符号冷却：run 次数解冻、时间窗维度、跨符号互不影响、变体冷却）。

## 字符宽度（EAW 精确表 + 启动探测）

- **静态表**（`layout/eaw-table.ts`，生成物）：`scripts/gen-width-table.mts` 生成——EAW（UAX #11）取自 `scripts/eaw-dump.py`（Python `unicodedata`），emoji 属性取自 Node `\p{Emoji}` / `\p{Emoji_Presentation}`（UTS #51）。三张扁平区间表（每两个数字一对 `[lo, hi]`，运行期二分）：
  - `EAW_WIDE_RANGES`：EAW ∈ {W, F} → 2 列（CJK/全角/多数 emoji）；
  - `EAW_AMBIGUOUS_CONSERVATIVE`：EAW = A 且落在几何/符号/CJK/emoji 保守区间 → 2 列（这些符号可能被 CJK 字体按全角设计，防低估撑破）；
  - `EMOJI_CONSERVATIVE`：EAW = N/A 但带 emoji 属性且 ≥ U+2190 → 2 列（多数终端按 emoji 呈现；排除箭头区与 ™/©/® 等 1 列字符）。
  - 重新生成：`TUI` 内 `npm run gen:width-table`，随后跑 `format` 对齐数组换行。
- **判定顺序**（`layout/markdown.ts` `computeCharWidth`）：实测覆盖 → 零宽 → 文本符号例外（`NARROW_TEXT_SYMBOLS`）→ W/F → A(保守) → emoji 保守集 → 默认 1 列。
- **启动探测**（`Renderer.probeSymbolWidths` + `App.probeWidths`）：A 类（歧义）字符的实际列数由终端/字体解析决定（1 或 2 列），静态表只能保守取值。启动时（首帧渲染**前**）对推荐符号集（`DEFAULT_RECOMMENDED`）批量写「字符 + `CSI 6n`」，按序读回 CPR 光标位置，列差即实测列宽——**一次往返**完成整批；结果经 `setWidthOverrides` 写入覆盖表并清排版缓存，宽度确有变化则重绘一帧（探测字符画在原点，被首帧清屏覆盖）。终端不支持 CPR → 500ms 超时后静默沿用静态表；`TUI_WIDTH_PROBE=0` 整体关闭。
- **修复背景**：旧实现把 `0x2B00-0x2BFF`、`0x2600-0x27BF` 等区间**整段**按 2 列，使 EAW=N（中性、无歧义 1 列）字符（如 U+2B24、U+2B00）在屏幕上多留一格；现按 EAW 精确判定，N 类归 1 列，emoji 保守集仍按 2 列防低估撑破。
- **回归**：`tests/width-eaw.test.ts`（N/W/A/emoji 分层与优先级）、`tests/width-probe.test.ts`（CPR 解码不产按键、批量列差解析、超时回退、跨行跳过、覆盖表失效）。

## 排版缓存与绘制合帧（性能）

排版成本集中在折行 / 宽度计算的逐字符工作（`wrapLine` / `displayWidth` / `wrapInlineMarkdown` 等，measure 与 fill 两阶段都调）。优化分两层，互不耦合：

- **折行 / 宽度有界缓存**（`layout/cache.ts` + `primitives.ts` / `markdown.ts`）：
  - 缓存目标：`wrapLine`、`truncateToWidth`、`displayWidth`、`parseInlineMarkdown`、`wrapInlineMarkdown`、`wrapAssistantLine`、`wrapCodeLine`，以及 `charWidth` 的码点宽度表（`Uint8Array`，0 = 未算）。
  - 键：文本 + 列宽（主题相关出口再并入 `themeId`）；命中值按**只读**使用（`fill.decorateRows` 已用 spread 复制）。
  - 有界：每表 FIFO 上限 `TEXT_CACHE_LIMIT`（2048），超限淘汰最旧插入项。
  - 开关：`TUI_LAYOUT_CACHE=0`（初始值）或运行期 `setLayoutCacheEnabled(false)`；`clearLayoutCaches()` 清空并重置码点宽度表。关缓存即回到优化前直算路径，用于等价断言与基准对比。
  - 零宽判定：326 条零宽区间表为模块级常量，`charWidth` 另带码点宽度表 memo（`Uint8Array`）——若区间表在函数体内每次调用重建并线性扫描，会成为逐字符宽度计算的主要常数因子。
- **App 层 tick 内合帧**（`app/index.ts`）：`paint()` 只标脏并排队一个 microtask，同一 tick 内多次标脏只调用一次 `renderer.render`；`flushPaint()` 同步冲刷、`paintNow()` 立即出帧（启动首帧、测试与需即时可见路径用）；绘制期间再次标脏会补画一帧并收敛；`dispose()` 清掉待处理帧。
  - **跨回合帧率上限**（真实接线默认 10Hz）：`AppDeps.frameIntervalMs`（`main.ts` 传 100；0 / 缺省 = 不限帧，测试与演示保持立即出帧）。`flushPaint()` 距上一帧不足该间隔时不清脏、改挂「窗口末」定时器，窗口内跨宏任务的标脏合并到该时点统一出一帧；`paintNow()` 抢占时取消窗口定时器；`dispose()` 一并清除。
  - 语义提醒：同一 tick 内的中间态不再逐帧写终端（这正是合帧的目的）；demo mock 的复合场景因此拆成两个 tick 发出，保证 `subagent` 行等中间态能被帧断言看到。
- **测试与基准**：`tests/layout-cache.test.ts` 断言 cache 冷 / 热与 off 逐项一致、固定动作序列整帧一致，以及合帧侧「同 tick 200 事件只画一帧」「flushPaint / paintNow」「绘制期间标脏收敛」「dispose 丢弃待处理帧」等；`tests/helpers/paintFlush.ts` 提供同步测试体读帧前的冲刷辅助（`TrackedApp` 构造即登记）。基准 `npm run bench`（`bench/layout-bench.mts`，手动运行不设阈值）对同一合成语料跑 cache off/on 三档（cold 每帧清缓存 / warm 同状态重复排版 / incremental 增量追尾），打印中位耗时与提速倍数。

## 增量渲染与防闪烁

渲染层五项防闪烁机制（业界对照：Bubble Tea 行级跳过 + 60fps 合帧、pi 的 `firstChanged..lastChanged` 区间重写 + DEC 2026、Textual dirty region、Codewhale 去 `2J` 修复、Claude Code #37283）：

- **变化行游程重写**（`renderer/index.ts` 的 `changedRuns` + `screen.renderRange/renderRanges`）：逐行比较新旧帧（按主题下序列化文本，`caret` 参与比较），把**连续变化行**各合成一段、段间独立绝对定位 + 逐行**先擦后写**重写（行首 `ESC[K` 擦整行，**不写行尾 `ESC[K`**：活动区行不补齐整行，行尾擦不掉新内容右侧的旧字——新回合清空活动区后「最顶上残留几行」即由此而来；且行尾 `ESC[K` 在光标停于右缘待折行时会擦掉整宽行的末字）；新帧更短时末尾以 `ESC[J` 清除下方残留。**只取「首末跨度」是不行的**：状态列（最左纵向窄列，贯穿整个顶部区域）与活动区（底部流式行）常在同一 tick 同时变化，取跨度会把中间大片未变化行一起擦除重写（实测 **18 行/tick** → 改游程后 **2~3 行/tick**，报文 3.1 KB → 0.7 KB）；无 DEC 2026 同步的终端上，逐行擦除+重写正是肉眼可见闪烁的来源。**增量帧绝不 `ESC[2J` 清屏**——这是符号闪烁/流式行内增长场景的主要修复点（旧实现只支持「帧尾纯追加」，其余一律全帧清屏）。
- **帧段（box）切分**（`app/layout.ts` 的 `frameSections` + `renderer` 的 `changedIntervals`）：由 `FrameGeometry` 纯推导行带表（top / status / footer / hint），`buildFrame` 经 `FrameBuildOutput` 回填、App 随帧传入；段表与上一帧一致时先把范围收敛到各段（多段同时变化只重写各段内变化行，不跨越中间未变化的段），段内再按变化行游程切成若干区间（不取跨度）；段表缺失/不一致（几何或行数变化）退化为整帧游程比较，保证不漏更新。
- **DEC 2026 同步输出**（`screen.ts`）：整帧与区间报文首尾包 `ESC[?2026h` / `ESC[?2026l`，支持的终端（kitty / iTerm2 / WezTerm / Ghostty / Windows Terminal / tmux 3.4+）原子呈现整块更新；不支持的终端按未知私有模式忽略。`reset()` 补发结束序列兜底。
- **覆盖式全帧**：仅**首帧**清屏一次（清终端既有内容），后续全帧（resize / 主题切换 / Ctrl+L）改为绝对定位原点 + 逐行覆盖重写（每行同样**先擦后写**）；帧下方残留以「定位到帧下一行行首 + `ESC[J`」清除（不在末行行尾就地 `ESC[J`——末行整宽时同样会吃掉末字），不再破坏性清屏。
- **渲染期光标隐藏**：报文开头 `ESC[?25l`、定位 caret 后 `ESC[?25h`，消除重写期间硬件光标跳动；`reset()` 兜底补发显示序列。

量化验收（`tmp/repro-flicker/` 三种脚本，临时排查留档、非仓库产物）：

| 脚本 | 场景 | 结果 |
| --- | --- | --- |
| `verify.mjs` | 符号翻转 / 流式行内增长 / 纯追加 / 内容滚动 | 全帧清屏均 0 次（修复前 10/10/0/1 次，输出 22.7 KB → 约 3 KB） |
| `verify-real-frames.mjs` | 真实 24×80 布局帧：20 帧流式 + 符号交替 | 0 清屏、0 缺同步包裹/光标序列；纯符号帧 356 B |
| `diag-rows.mjs` | 单 tick **重写行数**（游程改造前后对照） | 流式+符号 2 行/帧；状态列+活动区同 tick 3 行（取跨度时 18 行）；只符号翻转 1 行 |

回归测试：`tests/renderer-diff.test.ts`（区间 diff 6 例 + 段切分 3 例 + 游程切分 2 例，含真实帧「状态列 + 活动区同 tick ≤ 4 行」）、`tests/screen.test.ts`（报文序列：同步包裹 / 仅首帧清屏 / 光标管理）、`tests/layout4.test.ts`（`frameSections` 覆盖性与行带一致性）。

### 已评估未采用（附实测，勿重复讨论）

反闪烁改造完成后重新评估下面三项，**结论均为不做**。测量脚本 `tmp/measure-render-cost.mjs`（24×80 真实布局帧、300 帧流式 + 符号交替序列）：

| 指标 | 实测 |
| --- | --- |
| 单帧全量序列化（24 行） | 0.0128 ms |
| diff 比较（`sameRow` 每行 2 次序列化） | 0.0255 ms/帧 |
| 排版 `buildFrame` | 0.065 ms/帧 |
| 渲染（比较 + 序列化 + 报文组装） | 0.054 ms/帧 |
| 输出量 | 569 B/帧 |
| 10Hz 出帧 CPU 上界 | 1.20 ms/s（约 0.12% 单核） |

- **列级（单元格）局部重写（不做）**：状态列只占左侧 `statusColWidth` 列，理论上可只重写该列单元格（`ESC[r;cH` + 局部段）而不整行。但行级游程已把「状态列 + 活动区同 tick」压到 2~3 行/tick，收益只剩每行右半段（≈60 B/行）；代价是局部序列化必须自己处理宽字符跨界、样式收尾与右侧残留（`ESC[K` 不能用了），风险高于收益。
- **行序列化结果缓存（不做）**：收益上限即 0.0255 ms/帧（约总成本千分之五）；且 `buildFrame` 每帧新建 `FrameRow` 对象，按对象缓存（WeakMap）不会命中，须按内容做键，收益进一步缩水。
- **滚动区（DECSTBM）「只移动不重画」（不做）**：滚动场景写入量约 1.5 KB/帧、10Hz 下 15 KB/s，远低于终端处理能力；JS 侧已非瓶颈（上表），收益无从测量，却引入终端状态污染风险——Bubble Tea 的 `insertTop`/`insertBottom` 已标 deprecated，Codewhale 亦有「子进程泄漏 DECSTBM/DECOM 致视口整体下移」的修复记录。
- **重新评估的触发条件**：帧行数/宽度出现数量级增长（如 100+ 行帧 + 大量 CJK/emoji）致「比较」成本 > 10 ms/帧；或真机出现肉眼可见卡顿且定位到瓶颈为**终端写入量**（若瓶颈是终端自身重绘速度，程序侧优化无益，应排查终端 / tmux 配置）。

## 自动清理空会话

- **config**：`tui.config.json` 的 `session.autoCleanEmpty`（缺省 true，显式 `false` 关闭）；`normalizeConfig` 归一化（非法回落 undefined，默认由消费方应用）；`main.ts` 取 `loadTuiConfig().session?.autoCleanEmpty ?? true` → `AppDeps.autoCleanEmpty`（需 `=== true` 才生效）。同一开关覆盖**启动**与**优雅退出**两个时机。
- **判据**：`startupCleanableIds(records)`（`state.ts` 纯函数）——已持久化 + 非 live + 非当前 + `isEmpty`（无用户消息），全目录范围，与面板 `cleanableSessionIds` 同语义但不依赖面板状态。
- **共享核心**：`cleanableSessionIdsViaAdapter()`（`listSessions()` 全量 → 判据过滤；列表缺失 / 读取失败返回空）+ `deleteSessionIds()`（逐个 `deleteSession()` 串行删除，复用 `/session` 面板同一守卫，返回成功 / 失败计数）。
- **启动执行**：`App.start()` 末尾 `if (this.autoCleanEmpty) void this.runStartupCleanEmptySessions()`（后台异步，不阻塞首帧）——notice 汇报「已自动清理 N 个（M 个失败）」。
- **退出执行**：`App.dispose()` 开启时走 `disposeWithExitClean()`——先 `runExitCleanEmptySessions()`：有可清理项时把提示渲染到活动区（`paintExitNotice`：dispose 已置 `disposed = true`，常规 notice / paint 被守卫拦截，且 10Hz 合帧可能把标脏推迟到关终端之后——故同步 apply + render 直接落屏）并等待完成，结果与耗时同样渲染到活动区，完成后才释放 adapter / 关闭渲染器；无清理项静默。等待受 `EXIT_CLEAN_TIMEOUT_MS`（5s）兜底，超时渲染提示并继续退出。
- **降级**：宿主未挂 `sessionQuery`、列表读取失败或无可清理项 → 静默跳过；删除失败计入失败数，不让启动 / 退出失败。
- **测试**：`tests/session-delete.test.ts`（启动清理 3 例 + 退出清理 4 例 + `startupCleanableIds` 纯函数 1 例）+ `config.test.ts` session 归一化 1 例。

## 声音提醒事件钩子

- **输出口**：`Renderer.bell?()`（可选接口方法；真实 renderer 实现 → `Screen.beep()` 向输出流写 BEL `\x07`；注入型 renderer 可不实现，App 经 `bell?.()` 调用）。
- **config**：`notify.enabled`（缺省 true）、`notify.idleThresholdMs`（缺省 8000、最小 1000，由 `normalizeConfig` 归一化）；AppDeps 直传（测试可用小值）。
- **触发**：`App.onTurnEnded()` 任务结束响一次；随后 `setTimeout(idleBellMs)` 等待输入，超时补响一次。`handleKey` 任意键 → `clearIdleBellTimer()`；`dispose()` 清理计时器。`bellEnabled` / `disposed` 双检查防关闭后误响。
- **测试**：`tests/notify-bell.test.ts` 5 例（turn-end 响一次 / enabled=false 不响 / 超阈值补响 / 输入取消 / 真实 renderer 输出 BEL）+ `config.test.ts` notify 归一化 1 例。

## /model 命令

- 能力：查询可用模型 + 切换当前会话模型（写回会话内引用 + 记入会话状态快照，切回该会话时恢复）。
- `/model` 无参 → 交互选择面板（渲染在活动区窗口）：`↑/↓` 移动高亮、`←/→`（或 Tab）切换 provider / model / effort 三列焦点（clamp 不循环）、`Enter` 确认、`Esc` 取消；普通字符键被忽略（不进入输入框）。`/model <provider>/<model>` 直接切换；`/model <modelId>` 跨全部 provider 唯一匹配（未匹配或歧义 → 错误提示，不落盘）。`/provider` `/effort`（`/thinking`）无参调用同一面板并预置焦点列（0 = provider、2 = effort）；带参仅提示 usage。
- **状态与 reducer**：`state.picker`（`PickerState`：options + index + phase + efforts + effortIndex）+ `picker-open` / `-move` / `-tab` / `-phase` / `-efforts` / `-close`。渲染为 `components/ModelPicker.ts` 纯函数（输出恰活动区可视行）：三列独立列表同屏，头部全小写；当前模型恒为首行标 `*` 附 `[current]`，焦点行标 `>` 并加粗。等级列表经 adapter `modelEfforts(provider, model)`（宿主 `llm.resolveModelInfo` → `reasoning.efforts`；非思考模型返回 undefined，面板显示 `effort: (unsupported)`）异步加载；`metricsFor` 的 picker 高度预算取模型列表与等级列表较大者；宿主等级名首字母大写，adapter 归一为小写再展示（与状态栏 `model:<等级>` 后缀同源）。
- **列宽分配**（`pickerColumnWidths`）：三列自然宽 = 各自最长选项显示宽（含行前标记 2 列，effort 无选项时按标题宽兜底）。空间充足时按自然宽比例分配（余数按最长列依次补 1），不出现大片留白；空间不足改用水位法（同 `table.ts`）——短列保持自然宽、只有超宽列被压到共同水位线；极窄（可用宽 < 3）退化为「首列吃其余、后两列各 1」。
- **星号选中语义**：phase 0 仅移动 `providerIndex`；`selectPicker` 在星号移到新 provider 时才把 model 列表切到该 provider、`modelIndex = 0`、旧 `selectedModel` 失效（effort 列表清空由 App 重载；思考等级星号在新列表中存在才显示），重选同一 provider 幂等；phase 1 选中保留 `selectedEffort`。`App.reloadPickerEfforts()` 目标为选中（星号）的 model / provider（未选中回退焦点行）。`Enter` 提交走 `resolvePickerSelection`「星号优先、焦点兜底」。
- **切换语义**：只改会话内 `SessionModelSelectionRef.current`（经 `installSessionModelSelection` 挂到 agentCtx 的 `system-prompt/assemble` + `agent/request` 双钩子，下一 step 生效，快照保证不撕裂当步请求）；**绝不调用宿主 `agentDefaultModel.saveSelection()`**（避免覆盖配置中的默认模型）。有效选择 = 会话内切换 ?? 宿主实时默认（`currentSelection()` 只读兜底，不做一次性快照以免异步 publish 时序吞掉设置）。切换时保留当前 `reasoningEffort`，不提供 effort 参数。
- **接线**：`main.ts` 的 `apply()` 在 `agents.create({ setup })` 中把 `installSessionModelSelection(agentCtx, sessionModel, () => readDefaultSelection(defaultModelSvc))` 挂上，并把同一 `sessionModel` 引用 + 只读 `defaultModel` 兜底传入 `createRealDshAdapter`（结构面 `LlmLike` / `AgentDefaultModelLike`，零运行时依赖）。
- **状态回显**：切换成功后 `systemStatus.model` 更新为 `provider/model` 并写入 notice；`App.start()` 读取 `modelCatalog().current` 写入 `systemStatus.model`。宿主 `agentDefaultModel` 需等 LLM provider 注册后才返回真实路由，故改为常驻跟随 `StatusTicker` 的 5s 周期（值变更才重绘）。
- **持久化与恢复**：`/model` 只改会话内 `sessionModel.current`（**绝不写宿主 `agentDefaultModel.saveSelection()`**，避免覆盖配置默认模型），同时记入 `state.modelBySession` 供会话状态快照落盘；resume / 启动时按「宿主 `model/selection` → 快照 → 最近 `request/header.config`」恢复并写回引用（详见「会话状态恢复」）。仅内存会话（无持久化目录）没有快照，此时退化为宿主日志口径。

## 命令输入补全

- `completeCommandInput(text, extra, mode)` 做前缀匹配（名称短 → 长排序，`items[0]` = 最匹配）、**不设硬上限**、同名以本地优先去重；`mode = slash` 时先把「无前导 `/` 的输入框文本」归一为字面 `/name` 再判定（slash 模式的 `/` 由 `App.submit` 提交时才补）。宿主目录经 `adapter.commandList()`（官方 `commands.list(agent)`，仅取 name / description，缺失 / 抛错 → undefined 降级为仅本地命令）。
- 候选存入 `state.completion`，**唯一计算点在 reducer**：`input` action（`setInput`，所有编辑键的唯一漏斗）、`input-mode`（切换模式重算）、`command-catalog`（宿主目录到达）。
- 展示复用活动区覆盖层（`components/CommandCompletion.ts`，与审批 / 问答 / picker / 各面板同一渲染链；footer **不**空白占位——补全不占输入区，输入行与光标必须可见）。面板 = 标题 1 行 + (activityH−1) 行候选，候选池足够时铺满活动区（曾设硬上限导致活动区高时底部留白，已移除）；**超出可视行的候选直接丢弃、不滚动窗口**——渲染只取前 activityH−1 项，App 侧 `completionVisibleRows()` 给 `completion-move` 传 `max`，把 `↑/↓` 与 `Tab` 接受也限定在可视范围内。键位提示不放面板内，而在输入区下方的按键提示区（`COMPLETION_HINT_LINE`；`normalInput` 保持为真故提示区仍存在）。
- 按键：`Tab` 接受（写命令名 + 尾随空格，slash 模式不写前导 `/`）、`↑/↓` 移动（在 `handleKey` 的 normal 分支先于面板滚动）、`Esc` 收起（不打断运行）、`Enter` 保持提交语义。

## 通用状态选项面板（`/policy` `/permission` `/preset`）

- 无参统一打开 `statusPanel`（`components/StatusPanel.ts`，活动区窗口，与审批 / 问答 / 模型选择同区域）。状态 `StatusPanelState{kind,title,options[],index,selected}`（`state.statusPanel`）；reducer `status-panel-open/move/select/close`。提交路径：policy → `setApprovalPolicy`；permission → `runCommand("/permission <name>")` 转发宿主；preset → `selectAgentPreset`。
- 交互：`↑/↓` 移动焦点、空格预选星号（再按取消）、`Enter` 提交预选（无预选回退焦点行）并关闭、`Esc` 取消；当前策略来自 `state.policyBySession[sid]` 事件回读。着色：预选行绿、未预选的焦点行黄，同一行兼具时绿优先。
- plan / sandbox 无宿主写接口，暂不开放面板；goal / todo 保持只读状态列。

## /theme 命令

- 配色方案：启动时解析 `tui.config.json` 的 theme 段（`renderer/theme-config.ts`：内联 `palettes.<id>` → `paletteDir/<file>.json`（上游单一源，默认 `~/fff/config/terminal-colortheme/`）→ 内置兜底快照）。`theme.ts` 的 `THEMES` 仅是兜底快照（= 当前上游配色）；语义色槽位 `gray` / `border` / `code` / `focus` 从各主题 `semantics` 解析（不再按主题名 / ID 分支）。定义 16 个 ANSI 槽位 + 基底前景 / 背景，全部 truecolor。
- 槽位映射：`black..white` → `ansi[]`，`brightBlack..brightWhite` → `bright[]`；`ansiNameToHex(theme, name)` 解析。段级 `style` 由 `segStyle` / `serializeFrameRow`（`screen.ts`）按 Manual-ANSI 处理（fg/bg 分别 `38;2` / `48;2`，bold 用 `1m` / `22m`），着色一律**以主题基底前景 / 背景收尾**（不用 chalk：其 `39m` / `49m` 会复位到终端默认，浅色主题下不可读）。
- 基底色：`Screen` 持有当前主题（`setTheme(id)`），报文在清屏/定位之前写出基底前景 / 背景（truecolor 背景 → `ESC[2J` 首帧清屏即以主题色填充；覆盖式全帧与每个增量区间行同样带基底），保证 `ESC[K` / `ESC[J` 擦除以主题背景填充（擦除一律发生在行首/列 1，见上「先擦后写」口径）。`setTheme` 同时清掉帧缓存（`prevRows = null`），切换后必然全帧重绘。`close()` 前 `Screen.reset()` 输出同步结束 + 光标显示 + `ESC[0m` 恢复终端默认。

## 验证方式

```sh
npm run check          # tsc --noEmit
npm run test           # node --test 全量（renderer 解码 / 排版 / adapter fake-ctx）
npm run build
npm run demo -- --smoke   # 帧断言 SMOKE_PASS（无 TTY/CI 下自动合成按键驱动并自断言，失败置非零退出码）
npm run smoke:pty      # 真实 DSH PTY 冒烟：真实会话断言工具行与状态栏 usage
npm run bench          # 排版性能基准（off/on 三档中位耗时与倍数，报告式不设阈值）
```

另有 `TUI/scripts/verify-p0.py`（会话切换 / 标题 / OSC52 复制，可重复执行）与打包验证（`pnpm pack` + 全新空目录 `pnpm add <tarball>` 校验 files / bundle patch）。
