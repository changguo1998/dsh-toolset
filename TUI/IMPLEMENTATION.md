# DSH TUI 实现要点（Implementation）

> 类型：**[implementation]** 实现细节记录。
> 配套文档：`DESIGN.md`（架构/设计）、`SPEC.md`（规格）、`TASKS.md`（任务）。本文档记录实现层的关键机制（现状方案），命令路由与文本管线细节；算法/接口规格见 `SPEC.md`，开发任务见 `TASKS.md`。

## Slash 命令路由

- 涉及其他功能的命令走注册-调用方式（`dsh-commands` 注册表），只与渲染相关的命令作为本地小命令表。
- `App.submit()` 对以 `/` 开头的输入走 `handleSlash()`，不进 `agent.followup`、不占模型 token/历史：
  - 本地小命令表（app 层）：`/help`、`/clearscreen`（`/cls`，清空显示缓冲）、`/quit`（关闭 renderer）、`/theme`、`/goal`（仅 notice 提示查看右侧信息栏）、`/session`、`/copy`、`/model`、`/policy`、`/permission`、`/preset`、`/jobs`、`/init`、`/stats`（`/usage` `/context`）、`/rename <标题>`、`/skills [过滤]`、`/agents`、`/tools [过滤]`、`/settings`、`/fork`、`/task`、`/guard`、`/memory`、`/loop`、`/contract`、`/workflows`、`/council`、`/search`。
  - 其他 `/name` → `adapter.runCommand(line)` → `ctx.commands.execute(agent, line, [], signal)`（官方注册表）。
  - 未命中注册表（execute 返回 `undefined`）→ `notice` 提示未知命令（**官方 fail-close**：绝不 sendMessage 给模型）。
- 事件面：`DshEvent` 的 `{ type: "notice"; text }`——命令结果/错误/提示只进 UI 缓冲（`appendNotice`，独立成行，不入流式末行），经 `notice` reducer 落地。
- 命令名语法：`parseSlashCommand` 与官方 client 一致——`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/`。
- `/init`（初始化 AGENTS.md）：本地检查会话语义 cwd（`state.systemStatus.cwd`，占位/空时回退 `process.cwd()`）下 `AGENTS.md` 是否存在——已存在则 `notice` 提示并结束（不发消息）；缺失则经共用发送路径 `sendUserText(INIT_PROMPT, "/init")` 注入初始化指令（状态置运行 + 本地回显 `/init` + `adapter.sendMessage`），由模型阅读目录、总结并写 `AGENTS.md`。指令常量 `INIT_PROMPT` 在 `commands.ts`（与本地命令目录同处，便于测试导入）。
- `/agents`：经 `adapter.refreshAgents()`（`ctx.subagents.listChildren(activeSessionId)` → `CommandPanelRow[]`，`status` 取 `activity`；`kind:'diagnostic'` 条目 `status="diagnostic"` 灰显且 payload 置空）拉取并打开共享面板；`Enter` 直接中断（`adapter.interruptAgent(id)` → `ctx.subagents.interrupt(id, {kind:'user', parentSessionId: activeSessionId})`），无可中断 id 的条目 → info 说明不发调用；两者均先关面板再 notice。**刷新保鲜（C2）**：评估 `subagent/descriptor`（仅转转录行）、`agent/status`（agent 层且只转发当前活跃 agent）、`subagent/catalog`（载荷未定型）与 `SubagentsLike`（无 subscribe/onChange，对比 `/jobs` 的 `onJobsChanged`）→ **宿主无可驱动的子代理状态事件面**；故面板打开期间启动 `setInterval`（默认 2s，`AppDeps.agentsRefreshIntervalMs` 可注入）调 `refreshAgents` 全量重拉，tick 自检面板仍为 `agents` 否则停表（覆盖全部关闭路径），外加手动 `r` 键立即刷新与面板提示「`r 刷新`」。共享面板行按 `row.status` 经 `JobsPanel.statusMark` 着色（● 黄运行、○ 灰冷/诊断、✗ 红失败）。
- `/loop`：`adapter.refreshLoops()`（`ctx.metricLoop.list()` → `CommandPanelRow[]`：title=measureCmd 或 id、detail=状态·方向·轮数·best·更新时间（HH:MM）、running → status "running"（黄）/stopped → "inactive"（灰）、payload=循环 id）拉取并复用共享列表面板；`Enter` 经 `adapter.loopDetail(id)`（list() 定位 → 4 行：id/状态·停止原因/方向·目标/轮数·窗口·best）取详情，先关面板再以 info notice 展示；服务未挂载 → warn 且不空开面板。metric-loop 只读面已由 C5 前置挂载（`provide=["metricLoop"]` + `ctx.provide("metricLoop", { list, status })`），本轮无需插件改动。
- `/contract`：接入点取当前会话 goal 快照（`activeGoalSnapshot(state, sessionId)`，state.goalBySession 判别联合 set 态）的 `objective`，经 `adapter.contractSummary(objective)` 解析 `Done-when:` 段为条款（**优先 `opts.goalContract.parseContract`（ctx.get('goalContract')）**，宿主未挂载 → 内置同构回读 `parseContractObjective` 兜底——定位独占 `Done-when:` 行 + 段后 JSON 数组，与 goal-contract `parseContract` 往返同构），`contractSummaryText` 归一行 ≤4 行（目标截断 40 + 条款数 + 前 3 条 check·等级）经 info notice 展示；无目标快照 / 解析失败 → warn。包入口直读评估：TUI 与 goal-contract 无依赖（根无 workspaces、禁止 `file:`）、profile 下经 realpath 加载找不到兄弟包 `node_modules` → 编译期不可直读，故走内置回读支路（可行那支）并在适配层保留 service 优先钩子。
- `/search <query>` — 网页搜索（**多引擎聚合为 TUI 侧职责**）：`aggregateSearchSources` 纯函数（dsh.ts）——provider 集合 = `opts.web` 派生 host provider + `options.searchProviders`（TUI 本地可配置注入面），`Promise.allSettled` **并行**遍历 → 成功 sources 逐个合并（记 provider id）→ **URL 去重**（首现保留）→ **query-token 关联度**（title 命中×2 + snippet 命中×1）**降序**、分数一致保合并顺序稳定 → 截断 `maxResults`（默认 10）→ 行（title 缺省回落 `new URL(url).host`、detail=`[provider] · snippet · publishedAt`、payload=url）推 `command-panel-data(kind=search)`。单 provider 失败仅丢其数据、其余降级保留；**全部失败 → reject**（App warn 不空开）。`dsh-web` seam 为 provider-**selecting** 非聚合（`search()` 单 provider；多 provider 无显式 id → `WEB_PROVIDER_AMBIGUOUS`），故多引擎由 TUI 承担，符合「不做搜索后端」边界（复用现有 provider search 能力，非自建爬虫）。
- `/council [N]` — 二次意见：`adapter.council(target, count)`——经 `ctx.subagents.start("one-shot", { label, prompt, parent })`（dsh-subagent 0.1.5-rc.2 `start` 启动面核实：SubagentStartRequest=label/prompt/parent/signal/agentOptions?，SubagentRun 不 reject 于子级失败）**并行**拉起 N 个评审子代理各给独立意见；`Promise.allSettled` 逐行汇总（output 首行/失败注明），`stopReason==="error"` 或无输出的评审判定失败并降级保留序号，全部失败 → 失败文本；`agentOptions` 路由偏好留给宿主（最小化默认）。App `handleCouncilCommand`：目标取 goal 快照 objective、无则 buffer 最近 user 行；服务缺失（无 `adapter.council`/reject）→ warn 不假启动。notice 型展示（≤4 行）。
- `/workflows`：`adapter.refreshWorkflows()`（读 `workflowRuns` 集合 → `CommandPanelRow[]`：title=run.name、detail=阶段·成员 N/M、running → status "active"（黄）/ run-end → "inactive"（灰））拉取并复用共享列表面板；`Enter` 只读无操作。运行集合由 adapter 在 `tool-workflow/*` 会话事件桥接处增量维护（runId 分组：run-start 建、agent-start ++members、agent-end ++membersDone、run-end 标记 done），**增量仅更新内部 Map、不 emit 额外事件**（避免污染既有事件流尾索引断言）；面板打开期间经通用 `startPanelRefresh`（/agents 同款）定时重拉以反映增量。宿主挂载探测 `opts.workflowEngine`（ctx.get('workflowEngine')，dsh-workflow）；未挂载 → reject（调用方 warn 不空开面板）。dsh-workflow 无只读查询面，故取事件面接线（B3 裁定衔接）。
- `/memory`：`adapter.memorySummary()`（notice 型）——`ctx.knowledge.getSummary()` 同步优先、否则 `whenReady()` 等待；就绪 → info 3 行（路径/chunk·source 计数）、未就绪 → info 说明、服务缺失/失败 → warn。knowledge-base 插件在 apply 内 `ctx.provide("knowledge", { getSummary, whenReady })` 挂只读面（C4 前置补全，与 task-engine/metric-loop/security-guard 同款）。
- `/guard`：经 `adapter.refreshGuard()`（`ctx.guard.recent()` → `CommandPanelRow[]`，deny → status failed（红）+「拦截 · 原因首行」、allow → success（绿）+「放行」；行恒无 payload）拉取并复用共享列表面板；`Enter` 经 `adapter.guardPolicy()`（`ctx.guard.policy()` → 启用/黑名单/敏感文件/拦截计数 4 行）展示，先关面板再以 info notice 呈现；服务未挂载 → warn 且不空开面板。security-guard 插件在 apply 内 `ctx.provide("guard", { recent, policy })` 挂只读面（C3 前置补全，与 task-engine/metric-loop 同款）。
- `/task`：经 `adapter.refreshTasks()`（`ctx.taskEngine.query()` 先序展平任务树 → `CommandPanelRow[]`，嵌套缩进 + status + `待拆分` 标记，payload=任务 id）拉取并复用共享列表面板；`Enter` 经 `adapter.taskDetail(id)`（query().tasks 定位 + 按 `query().frameStack` 标注帧栈位置：栈顶=下一待处理/第 N/帧 不在栈）取详情，先关面板再以 info notice 展示；服务未挂载 → warn 且不空开面板。task-engine 插件在 apply 内 `ctx.provide("taskEngine", { query, frameStack })` 挂只读面（C1 前置补全，与 C5 metricLoop 同款）。
- `/settings`：经 `adapter.readSettings()`（`ctx.settings.describe()` → `SettingsDescriptor[]`，`ns：value` 每行一行、secret 项脱敏为 `<redacted>`）多行 info notice 展示；服务缺失/读取失败 → warn。**只读不写**（`settings.update/replace/mutate` + `expectedRevision` 乐观锁另立规格）。`SettingsLike` 首版仅暴露 `describe()`（`get(ns)` 宿主返回 unknown 未接入）。
- `/fork`：经 `adapter.forkCurrentSession()`（`ctx.sessions.fork(activeSessionId)`，后两参省略 = 源会话最后事件 + store id 策略，同步返回 live Session）分叉当前会话；成功 → success（新会话 id，与当前不同时提示用 `/session` 查看/切换）；5 个 `SessionForkErrorCode` 在 adapter 侧映射中文文案后 reject → warn（不抛穿宿主错误对象）。sessions 服务已有注入（复用既有 `ctx.get('sessions')`，无 `main.ts` 增量）。
- `/tools [过滤]`：经 `adapter.refreshTools(filter?)`（`ctx.tools.schemas()` 全局视图 + filter 过滤）拉取并打开共享面板；`Enter` 经 `adapter.toolDetail(name)`（`ctx.tools.get(name)` 的 name/description/parameters）取详情，先关面板再以 info notice 展示。
- `/skills [过滤]`：经 `adapter.refreshSkills(filter?)`（`ctx.skills.list()` → 归一化为 `CommandPanelRow[]`，filter 在归一化阶段按名称/描述/适用场景子串过滤）拉取并打开共享面板；`Enter` 经 `adapter.skillDetail(name)`（`ctx.skills.get(name).content`）取正文，先关面板再以 info notice 展示；服务未挂载 → warn 且不空开面板。
- `/stats`（别名 `/usage` `/context`）：读 `state.usage`（**最近一次模型调用**的 token 用量，非会话累计）→ 单条 info notice 三行：分解（输入/输出/缓存读）、上下文（`input + cacheRead`，与状态栏 ctx 段同口径；`contextWindow` 缺失或为 0 时只显绝对量、不除零）、缓存命中率（`cacheRead / (input + cacheRead)`，分母为 0 → `n/a`）。无 usage（本回合尚未发生模型调用）→ info 提示。零新服务、不改 adapter。
- **共享列表面板（`commandPanel`，批次 2 基础设施）**：`/skills`（批次 3 起 `/agents`、`/tools`）共用**一套** state/reducer/渲染——`state.commandPanel: CommandPanelState | null`（`kind`/`index`/`rows`/`loading?`/`error?`），reducer 四件套 `command-panel-open` / `-move`（clamp + 窗口平移）/ `-page`（PgUp/PgDn 整页，页高由调用方按活动区可视行数给出）/ `-close`，数据经 `command-panel-data` 事件推送（kind 匹配才写入，挡迟到数据覆盖新面板；`index` 随数据缩短收敛）。渲染为单一 `components/CommandListPanel.ts`（`buildCommandListPanelBox` + `renderCommandListPanel` 薄包装 `fillBoxTree`）：首行标题青 + 计数 + 右侧灰提示（按剩余宽截断）、行 = `> ` 高亮 + 可选符号 + 主文本 — 副文本、占位态（错误红 > 加载中灰 > 空列表灰）均输出恰 `height` 行。**接线 5 处**（缺一即出现「面板显示了但 footer/focus 行为错」）：`layout.buildActivePanelBox` 选型（插在 `jobsPanel` 之后、`history` 之前）、`normalInput` 加 `!commandPanel`（按键提示行让位）、`modalOpen` 加 `commandPanel`（模态态焦点置空）、`showHint → metricsFor` 随前两者自动跟随（面板态 `footerHeight = interaction`，交互区高度不抖动）、`inputPanelHeights` 提供翻页页高（与面板窗口同口径）。键位在 `handleKey` 面板段：↑/↓、PgUp/PgDn、Enter 主操作、Esc 关闭、其余吞掉（与 `/jobs` 一致：面板打开时不可输入新命令，需先 Esc）。面板占满活动区期间瞬态输出不可见，故 Enter 类主操作若以 notice 反馈，先关面板再提示。
- `/rename <标题>`：纯函数 `renameCommandDecision(line)`（`commands.ts`，与 `themeCommandDecision` 同构）判 usage / invalid / apply；apply 经 `adapter.renameSession(title)` → 宿主 `ctx.sessionTitle.rename(live Session, title)`（live Session 取自当前活跃 agent，resume 后自动指向新会话）。非法标题本地拒绝（不发服务调用）；服务缺失或调用失败 → warn。标题栏由既有 `session/title` 事件链路刷新，不手工改 state。
- 服务解析：`main.ts` 经 `ctx.get("commands")` 取注册表（cordis 严格模式不允许未注入服务直接属性访问），`commandAgent` 传真实 Agent（注册表作用域查找需要完整 agent，而非 app 的瘦 `DshAgentLike`）。
- dispose：`App.dispose()` 透传 `adapter.dispose?.()`；adapter 实现中止在途命令的 AbortController、解绑 runtime 监听（collectUnbind）、清空监听集。

## 文本管线（流式/清洗/补发）

- **打字机（思考）**：真实链路由 main 传 `slowStream`（默认 true）。打字机只作用于 thinking；初始流速 `streamCharsPerSecond`（默认 120，分数累计配额、按码点切分、不拆 emoji）随 tick（50ms）逐段 append；收到正文后 `slowCps` 切到 200 加速放完剩余思考；`turn-end` 置 `slowNewTurn`，下一条 thinking 回落到 `slowCpsBase`——每个 turn 的思考都从初始速度重新开始。正文为最终保留的回复，**即时显示**：思考队列运行期间到达的正文段按序缓冲（`pendingStream`），思考放完后一次性铺出正文、再执行 turn-end（分隔线画在下一个 turn-begin）。思考保留显示至下个回合 `turn-begin` 统一清空。
- **sanitizeText（渲染保护）**：流式文本进 buffer 前经 `sanitizeText` 清洗——CRLF/孤立 CR 归一为换行（否则 `\r` 残留在终端被当回车、抹掉整行内容造成大段空白），其余 C0/C1 控制字符（含 Tab、孤立 ESC）剔除，完整 ANSI 转义序列（CSI `ESC[…`、OSC `ESC]…BEL/ST`）保留（渲染着色功能，/copy 时再剥离）。剔除计数累计入 `state.strippedChars`（turn-begin 清零），turn-end 后若有剔除则以黄色 notice 提示「已过滤 N 个非打印控制字符」。恢复历史（`surfaceToBuffer`）同样走 `sanitizeText` 且按 `\n` 拆成独立 buffer 行，避免行内嵌换行破坏帧布局。
- **非流式回复补发**：`assistant/message` 是每个 step 结束必发的完整正文 surface 事件。adapter 按 (session:turn:step) 累计已流式输出的正文（reasoning 不计），`assistant/message` 只补发缺失后缀；非流式/无思考 provider（无任何 chunk）累计为空 → 直接输出完整正文，保证不支持流式输出的模型回复也可见。`surfaceOp: replace` 的影子覆盖事件跳过（append-only 无法安全重写）；`turn/end` 与 dispose 清空累计。
- **identified 消息**：`buildUserMessage` 用 `crypto.randomUUID()` 生成稳定消息 `id`——`agent/inbox/spliced` 与 `user/message` 均带 identified 标记，可被持久化校验识别；缺 id 会导致后续 `agents.resume` 全量校验抛 `SessionPersistenceCorruptionError`（会话永久不可 resume）。
- **零宽字符宽度**：`charWidth` 对组合附加符/变体选择符/ZWJ/ZWSP/emoji 肤色修饰符等计 0 列（对齐 Markus Kuhn wcwidth 零宽表），避免工具内容夹带特殊字符时总宽度虚高/提前换行。

## 事件 → 状态 → 渲染

完整映射与渲染语义见 DESIGN.md「事件接入与渲染」。实现要点：

- tool 行文本由 `src/app/layout/tool-line.ts` 纯函数组装；summary/detail 启发式由 adapter（dsh.ts）在归一化时产出。
- raw 事件由 adapter 归一化为 DshEvent → App 事件 switch → state reducer → buildFrame；`DshEvent` 为封闭联合，新增成员需同步 index.ts 穷尽登记（否则 `npm run check` 失败）。
- **seq 守卫**（per-session 游标）：`event.seq <= lastSeq` 丢弃；间隙接受不补缺；非活跃会话丢弃。

## 排版缓存与绘制合帧（性能）

排版成本集中在折行/宽度计算的**逐字符工作**（`wrapLine`/`displayWidth`/`wrapInlineMarkdown` 等，`measure` 与 `fill` 两阶段都调）。优化分两层，二者互不耦合：

- **折行/宽度有界缓存**（`src/app/layout/cache.ts` + `primitives.ts`/`markdown.ts`）：
  - 缓存目标：`wrapLine`、`truncateToWidth`、`displayWidth`、`parseInlineMarkdown`、`wrapInlineMarkdown`、`wrapAssistantLine`、`wrapCodeLine`，以及 `charWidth` 的码点宽度表（`Uint8Array`，0=未算）。
  - 键：文本 + 列宽（主题相关出口再并入 `themeId`）；命中值按**只读**使用（`fill.decorateRows` 已用 spread 复制，不就地改写缓存行）。
  - 有界：每表 FIFO 上限 `TEXT_CACHE_LIMIT`（2048），超限淘汰最旧插入项；不引入依赖。
  - 开关：`TUI_LAYOUT_CACHE=0`（初始值）或运行期 `setLayoutCacheEnabled(false)`；`clearLayoutCaches()` 清空全部表并重置码点宽度表。关缓存即回到优化前直算路径，用于等价断言与基准对比。
  - 根因备注：`isZeroWidthChar` 原实现把 326 条零宽区间表声明在函数体内，**每次调用都重建并线性扫描**——这是逐字符宽度计算的主要常数因子；现提升为模块级常量 + 码点宽度表 memo。
- **App 层 tick 内合帧**（`src/app/index.ts`）：`paint()` 只标脏并排队一个 microtask，同一 tick 内多次标脏只调用一次 `renderer.render`；`flushPaint()` 同步冲刷、`paintNow()` 立即出帧（启动首帧、测试与需即时可见路径用）；绘制期间再次标脏会补画一帧并收敛（不自旋）；`dispose()` 清掉待处理帧（已排队 microtask 变 no-op）。定时路径（状态栏 ticker / 思考打字机 / 面板刷新）与按键回显各自 tick 内仍出帧，不跨 tick 延迟。
  - 语义提醒：同一 tick 内的**中间态**不再逐帧写终端（这正是合帧的目的）。demo mock 的复合场景因此拆成两个 tick 发出，保证 `subagent` 行等中间态能被帧断言看到。

### 测试与基准

- 等价回归：`tests/layout-cache.test.ts`——固定语料（markdown 分支/CJK/emoji/组合符/ANSI/零宽/非法列宽）× 主题 × 列宽，逐项断言 cache 冷/热 与 off 一致；再用固定动作序列逐步比对整帧输出（固定状态 + 增量追加）；合帧侧断言「同 tick 200 事件只画一帧」「flushPaint/paintNow」「混排只一帧」「绘制期间标脏收敛」「打字机每 tick 出帧」「dispose 丢弃待处理帧」。
- 测试侧冲刷辅助：`tests/helpers/paintFlush.ts`（`TrackedApp` 构造即登记，`FakeRenderer` 的 `renders`/`refreshes`/`lastRender` 读前 `flushApp()`）——同步测试体读帧前先冲刷，用例写法不变。
- 基准：`npm --prefix TUI run bench`（`bench/layout-bench.mts`，手动运行、不设阈值）——同一进程内对同一合成语料跑 cache off/on 三档（cold 每帧清缓存 / warm 同状态重复排版 / incremental 增量追尾），打印中位耗时与提速倍数。

## Mode 初始值折叠

- 官方 `plan/mode`、`sandbox/mode`、`permission/preset`、`approval/policy` 均为 log-only 事件（仅切换时落盘，会话启动无初始事件）→ `DshAdapter.refreshSessionModes?(id)`（`emitSessionModeSnapshot`：从 live 内存事件或 `readSession` 折叠各事件最后一条并 emit mode/approval-policy；**不能用 readSurface**——log-only 事件被 surface fold 滤掉）；`App.start` / `resumeToSession` 成功后调用。

## 滚动偏移收敛（越界假死）

- **现象**：上滚历史（或按 `Home`/`End`）后按 `↓` 画面纹丝不动，像是整块历史卡死；输入命令并发送后更容易撞上（发送前后的重绘/内容变化把偏移顶出范围）。
- **根因**：`scrollOffset`（对话区）/ `activityScroll`（活动区）此前**无上限**——连续上滚越顶会一直累加，`End` 曾直接置 `Number.MAX_SAFE_INTEGER`；渲染层只在显示侧 `computeViewport` 里 clamp，状态里留着越界值。于是此后的下滚每按一次只是"还债"一格，画面在债务还完前完全不动（差额大时等于永久卡住）。活动区此前只靠 "turn-begin 归零"（`state.ts` 注释里的「向下没反应」死区）覆盖了"新回合"这一条路径，回合内越顶同样会卡。
- **修复**：让状态里的偏移恒在真实范围内。
  - `buildFrame(state, size, report?)` 出帧时**顺带回填** `FrameScrollReport{dialogueMaxScroll, activityMaxScroll}`（零额外排版开销）。对话区上限取**未折叠**全量行数 − 可视行数（上滚会解除折叠，折叠态上限偏小不能作上界），活动区上限取 `activity.length − activityH`。
  - App 侧 `paneMaxes()` 取上限：出帧回填过就直接用（记 `paneScrollMaxState` 引用判新旧），未出帧则就地补算一次同一口径的帧——不依赖"按键前一定刚出过帧"，单元测试同步按也不失稳。
  - `scrollBy(state, delta, maxOffset?)` 与 `activity-scroll` action 先**收敛当前偏移**再叠加 delta、且结果不超上限；`End` 由 `MAX_SAFE_INTEGER` 改为真实上限。上限缺省时行为不变（纯函数测试可直接调）。
- **回归**：`tests/app.test.ts`（上滚越顶后 `↓` 立即响应 / `End` 后 `↓` 立即响应 / 活动区同理）+ `tests/layout4.test.ts`（回填值在折叠态下仍为未折叠全量）。

## 声音提醒事件钩子（P2#33）

- **输出口**：`Renderer.bell?()`（可选接口方法；真实 renderer 实现 → `Screen.beep()` 向输出流写 BEL `\x07`；注入型 renderer 可不实现，App 经 `bell?.()` 调用）。
- **config**：`tui.config.json` `notify.enabled`（缺省 true）、`notify.idleThresholdMs`（缺省 8000、最小 1000，`config.normalizeConfig` 归一化）；AppDeps.notify 注入（main.ts `loadTuiConfig().notify`）。App 构造只保阈值 >0 合法性；1000 下限属用户配置层职责（AppDeps 直传如测试可用小值）。
- **触发**：`App.onTurnEnded()`（turn-end case 钩子）——任务结束响一次；随后 `setTimeout(idleBellMs)` 等待输入，超时补响一次。`handleKey` 任意键 → `clearIdleBellTimer()` 取消本次等待；`dispose()` 清理计时器。`bellEnabled`/`disposed` 双检查防关闭后误响。
- **测试**：`tests/notify-bell.test.ts` 5 例（turn-end 响一次 / enabled=false 不响 / 超阈值补响 / 输入取消 / 真实 renderer 输出 BEL）+ `config.test.ts` notify 归一化 1 例。
- 边界：仅 TUI 事件触发 + bell，不动插件、不做桌面通知。

## 启动自动清理空会话（session.autoCleanEmpty）

- **config**：`tui.config.json` `session.autoCleanEmpty`（缺省 false，删除类操作默认保守）；`config.normalizeConfig` 归一化（非法回落关闭）；main.ts `loadTuiConfig().session?.autoCleanEmpty` → AppDeps.autoCleanEmpty（`deps.autoCleanEmpty === true` 才生效）。
- **判据**：`startupCleanableIds(records)`（state.ts 纯函数）——已持久化 + 非 live + 非当前 + `isEmpty`（无用户消息），全目录范围，与面板 `cleanableSessionIds` 同语义但不依赖 history 面板状态（启动时未必打开）。
- **执行**：`App.start()` 末尾 `if (this.autoCleanEmpty) void this.runStartupCleanEmptySessions()`（后台异步，不阻塞首帧）——`adapter.listSessions()` 列全量 → 过滤 → 逐个 `adapter.deleteSession()` 串行删除（复用 `/session` 面板同一守卫：安全 id + realpath 包含性校验 + 活会话拒绝）→ notice 汇报「已自动清理 N 个（M 个失败）」。
- **降级**：宿主未挂 `sessionQuery`（listSessions/deleteSession 缺失）、列表读取失败或无可清理项 → 静默跳过；删除失败计入失败数一并提示，不让启动失败。
- **测试**：`tests/session-delete.test.ts` +3 例（正常清理含提示 / 部分失败计数 / 缺省关闭与无服务跳过）+ `startupCleanableIds` 纯函数 1 例 + `config.test.ts` session 归一化 1 例。

## /model 命令

- 能力：查询可用模型 + 切换当前会话模型（不落盘）。
- `/model`（无参）→ 交互选择模式（面板渲染在流输出（活动区）窗口）：↑/↓ 移动高亮（选项超出可视高度时视口跟随选中项滚动）、←/→ 左右切换 provider/model/effort 三列焦点区（clamp 不循环）、Enter 确认切换、Esc 取消不改变；普通字符键在该模式下被忽略（不进入输入框）。
- `/model <provider>/<model>` → 显式指定切换；`/model <modelId>` → 跨全部 provider 唯一匹配（未匹配或歧义给错误提示，不落盘）。
- 交互选择面板：`AppState.picker`（`PickerState`：options + index + phase + efforts + effortIndex）+ reducer action（`picker-open`/`picker-move`/`picker-tab`/`picker-phase`/`picker-efforts`/`picker-close`）。渲染为 `src/app/components/ModelPicker.ts` 纯函数（输出恰活动区可视行 `activityH` 行）：**provider/model/effort 三列独立列表同屏**，头部全小写；←/→ 切换焦点区（phase 0/1/2，clamp 不循环）、Tab 循环切换，当前模型恒为首行标 `*` 附 `[current]`，焦点行标 `>` 并加粗。等级列表经 adapter `modelEfforts(provider, model)`（结构面调用宿主 `llm.resolveModelInfo` → `reasoning.efforts`；非思考模型返回 undefined，面板显示 `effort: (unsupported)`）异步按高亮模型加载，Enter 应用「模型 + 高亮等级」。`metricsFor` 的 picker 高度预算取（模型列表、等级列表）较大者。宿主等级名首字母大写（Off/Low/High/Max），adapter 归一为全小写再展示（面板与状态栏 `model:<等级>` 后缀同源）。
- **列宽分配**（`pickerColumnWidths`，`components/ModelPicker.ts`）：三列自然宽 = 各自最长选项显示宽（含行前标记 2 列，effort 无选项时按标题宽兜底）。**空间充足（Σ 自然宽 ≤ 可用宽）按自然宽比例分配**（余数按最长列依次补 1），面板不出现大片留白；**空间不足改用水位法**（同 `table.ts`）——短列保持自然宽、只有超宽列被压到共同水位线，避免等比缩放把 provider/effort 也压到放不下自身内容而截断（窄面板/左右排列下活动 pane 窄时尤其明显）。极窄（可用宽 < 3）退化为「首列吃其余、后两列各 1」，保证 Σ = 可用宽且每列 ≥ 1。
- **星号选中语义**：phase 0 仅移动 `providerIndex`；`selectPicker` 在星号移到新 provider 时才把 model 列表切到该 provider、`modelIndex=0`、旧 `selectedModel` 失效（effort 列表清空由 App 重载；思考等级星号保留，新列表中存在才显示），重选同一 provider 幂等不重置；phase 1 选中保留 `selectedEffort`（维持「保留当前 reasoningEffort」）。`App.reloadPickerEfforts()` 目标为选中（星号）的 model/provider（未选中回退焦点行）。Enter 提交走 `resolvePickerSelection`「星号优先、焦点兜底」（打开时已用当前值预填星号）。
- 切换语义：只改会话内 `SessionModelSelectionRef.current`（经 `installSessionModelSelection` 挂到 agentCtx 的 `system-prompt/assemble` + `agent/request` 双钩子，下一 step 生效，快照保证不撕裂当步请求）；**绝不调用宿主 `agentDefaultModel.saveSelection()`**，避免覆盖配置中的默认模型。有效选择 = 会话内切换 ?? 宿主实时默认（`currentSelection()` 只读兜底：配置热加载生效后自动跟上；启动时不做一次性快照，避免异步 publish 时序吞掉设置）。切换时保留当前 `reasoningEffort`，不提供 effort 参数（YAGNI）。
- 接线：`DshAdapter` 接口含 `modelCatalog()` / `setSessionModel()`；`main.ts` apply() 在 `agents.create({ setup })` 中把 `installSessionModelSelection(agentCtx, sessionModel, () => readDefaultSelection(defaultModelSvc))` 挂上（setup 为官方 `AgentSetup` 结构面），并把同一 `sessionModel` 引用 + 只读 `defaultModel` 兜底传入 `createRealDshAdapter`（结构面 `LlmLike`/`AgentDefaultModelLike`，零运行时依赖）。
- 别名：`/provider` / `/effort`（`/thinking` 同义）经 `routeSlashCommand` 路由到 provider / effort，`handleModelFocus` 无参调用同一 `openModelPicker(catalog, phase)`（phase 预置面板焦点列，0=provider、2=effort），不做隐式切换；带参（`slashCommandArg` 非空）仅提示 usage，避免把 `/effort high` 当成模型名去切。`/model` 无参缺省 phase 1（model 列，最常用列先行）。
- 命令输入补全：`LOCAL_COMMANDS`（commands.ts，含别名项）为**路由与补全目录的单一来源**（`routeSlashCommand` 变为 `LOCAL_ROUTES` map 查表，未知名落 registry 转发）；纯函数 `completeCommandInput(text, extra, mode)` 做前缀匹配（名称短→长排序，items[0]=最匹配）、上限 8 项、同名以本地优先去重，`mode=slash` 时先把「无前导 `/` 的输入框文本」归一为字面 `/name` 再判定（slash 模式的 `/` 由 App.submit 提交时才补）。候选存入 `state.completion`，**唯一计算点在 reducer**：`input` action（setInput，所有编辑键的唯一漏斗）、`input-mode`（切换模式重算）、`command-catalog`（宿主目录到达）；展示复用活动区覆盖层（`components/CommandCompletion.ts`，与审批/问答/picker/statusPanel/jobsPanel/historyPanel 同一渲染链；footer **不**空白占位——补全不占输入区，输入行与光标必须可见）。面板只占活动区：标题 1 行 + (activityH-1) 行候选铺满（候选上限 COMPLETION_LIMIT=16；**超出可视行的候选直接丢弃、不滚动窗口**——渲染只取前 activityH-1 项，App 侧 `completionVisibleRows()` 给 `completion-move` 传 `max` 把 ↑/↓ 与 Tab 接受也限定在可视范围内；候选每帧由输入重算，故窗口尺寸变化无需回收状态），键位提示不放面板内而在输入区下方的按键提示区（`COMPLETION_HINT_LINE`，`normalInput` 保持为真故提示区仍存在）。按键：`Tab` 接受（写命令名 + 尾随空格，slash 模式不写前导 `/`）、`↑/↓` 移动（in `handleKey` 的 normal 分支先于面板滚动）、`Esc` 收起（不打断运行），`Enter` 保持提交语义不变。宿主目录经 `adapter.commandList()`（结构面 `DshCommandLike.list(agent)` = 官方 `commands.list(agent)`，仅取 name/description，缺失/抛错 → undefined 降级为仅本地命令）。
- 显示格式：纯 ASCII，紧凑 `provider/model` 一行一个模型；当前模型前 `->`，其余模型前空格缩进对齐。`renderStatusLine` 返回可多行 `FrameRow[]`，状态栏内容超出行宽时溢出到下一行（不再截断丢弃段），model 排在 time 之后第 2 位优先显示。
- 状态回显：切换成功后 `systemStatus.model` 更新为 `provider/model` 并写入 notice；`App.start()` 读取 `modelCatalog().current` 写入 `systemStatus.model`（不再用占位 `—`）。宿主 `agentDefaultModel` 需等 LLM provider 注册后才返回真实路由，早读会拿到内置兜底；故改为**常驻跟随 StatusTicker 的 5s 周期**（值变更才重绘），不受启动窗口限制，运行中宿主默认变化也会自动跟上。

## /policy /permission /preset（通用状态选项面板）

- 写路径与 fail-safe 见 DESIGN「命令域」。
- `/policy`、`/permission`、`/preset` 无参统一打开 `statusPanel`（`src/app/components/StatusPanel.ts`，活动区窗口，与审批/问答/模型选择同区域）。状态：`StatusPanelState{kind,title,options[],index,selected}`（`state.statusPanel`）；reducer `status-panel-open/move/select/close`。提交路径：policy→`setApprovalPolicy`；permission→`runCommand("/permission <name>")` 转发宿主；preset→`selectAgentPreset`。goal/todo 保持只读右侧栏；plan/sandbox 无宿主写接口暂不开放面板。
- 交互：↑/↓ 移动焦点、空格预选星号（再按取消）、Enter 提交预选（无预选回退焦点行）并关闭、Esc 取消；当前策略来自 `state.policyBySession[sid]` 事件回读。着色：预选行绿、未预选的焦点行黄，同一行两者兼具时绿优先。
- **接收者绑定**：caller 侧对 adapter 方法一律以 `method.call(adapter, …)` 保留实例作 `this`（与 `approve`/`interrupt` 等一致）——提取为局部变量再调用会导致方法体内 `this.xxx` 为 undefined、异步方法恒 rejected、误报「服务不可用」。

## /theme 命令

- 配色方案：启动时解析 `tui.config.json` theme 段（`renderer/theme-config.ts`：解析优先级 = 内联 `palettes.<id>` → `paletteDir/<file>.json`（上游单一源，默认 `~/fff/config/terminal-colortheme/`）→ 内置兜底快照）。`theme.ts` 的 `THEMES` 仅是兜底快照（= 当前上游配色），不再靠内嵌拷贝同步；语义色槽位 `gray`/`border`/`code`/`focus` 从各主题 `semantics` 数据解析（不再按主题名/ID 分支）。定义 16 个 ANSI 槽位 + 基底前景/背景，全部换成 truecolor ANSI。
- 槽位映射：`black..white` → `ansi[]`，`brightBlack..brightWhite` → `bright[]`；语义槽位 `gray`/`border`/`code`/`focus` → 各主题 `semantics`（默认 dark：gray=bright.0、border=ansi.4、code=ansi.0、focus=bright.7；light：gray=bright.0、border=ansi.4、code=ansi.7、focus=ansi.0）。`ansiNameToHex(theme, name)` 解析（颜色名转小写后查表）。段级 `style` 由 `segStyle` / `serializeFrameRow`（screen.ts）按 Manual-ANSI 处理（fg/bg 分别 `38;2`/`48;2`，bold 用 `1m`/`22m`），着色一律**以主题基底前景/背景收尾**（不用 chalk：chalk 以 `39m`/`49m` 收尾会复位到终端默认，浅色主题下不可读）。
- 基底色：`Screen` 持有当前主题（`setTheme(id)`），整帧渲染在 `ESC[2J` 清屏**之前**写出基底前景/背景（truecolor 背景 → 清屏即填充主题色）；每个 delta 行也带基底，保证 `ESC[K` 擦除以主题背景填充。`setTheme` 同时清掉渲染器 delta 缓存（`prevLines = null`），切换后必然全帧重绘。`close()` 前 `Screen.reset()` 输出 `ESC[0m` 恢复终端默认。

## markdown 表格（SPEC §3.2）

- **位置**：`src/app/layout/table.ts`（解析 + 构建期降级构建器）；识别与接线在 `layout/build-box.ts` 的 assistant 分支（`for` 改为索引循环以做逐行前瞻）。
- **为什么构建期算宽**：列宽是跨行约束（同列各行必须等宽），纯 `v/h` 表达不了跨兄弟约束；构建期把 2D 数学算完，产出「每格 `width:fixed`」的 `v([h([…])])` 子树，引擎保持两类节点。因此 `buildBox` 新增 `BuildBoxOptions.width`（`buildContentRows` 透传内容区宽）；**宽度未知时不识别表格**（按普通文本行渲染，保持 `buildBox` 直调语义不变）。
- **识别**：`isTableStart`（表头须含未转义 `|` + 分隔行格全为 `:?-+:?` 且列数一致）做 O(1) 预筛，仅命中时才向前收集连续表格行（收集在首个非 `|` 行停止），避免长回复下全量扫描；`fence` 内不识别。数据行缺格补空、多格忽略。
- **单元格叶子用 `StyledText` 而非 `Paragraph`**：构建期就做行内解析，否则 `measureParagraph` 按原文（含 `**` 等标记）算行数，与 `fill` 的渲染文本口径不一致，会多出空行。行高由 `measure(leaf, {maxW: colW})` 用引擎同口径算得后**显式声明** `height:fixed`，`fill` 的 `valign:"center"` 补白才生效。
- **网格与左竖线连续**：整表最左 1 列为 `┃`（`brightBlue`，与 assistant 正文左竖线同列同色）——竖线概念上属父级 box、内容整体在其右侧，故**逐行重复**（`"┃\n┃"` + 显式高度），折行续行与横线行也在；横线行首列用交叉字 `╢`（表头下 `═`）/`├`（数据行间 `─`），列分隔处用 `╪`/`┼`，保证横竖线交叉处不断开。数据行之间画单横线（首尾不画），用于内容折行时区分「哪一行」。
- **网格线不着色**：`│`/`═`/`─`/交叉字一律用主题默认前景色（`seg` 不带 style），只有左竖线取 `brightBlue`（与正文竖线同色）；表头格加粗与格内行内样式照旧。
- **横线行的横线须铺满整个列区域**（列宽 + 左右留白），故不经 `gridRow` 的 pad 装配（否则每列多出 2 列、总宽超出预算导致折行错位）。
- **列宽求解**：自然宽按**渲染文本**计（CJK 2 列）；超预算用**水位法**（`waterLevel` 二分）——窄列保持自然宽、只有超宽列被压到共同水位线，避免「按自然宽比例缩放」把窄列压到 `minW` 以下（表头难看换行）；抬到 `minW` 后若超预算则退回纯水位线。`ΣminW` 仍放不下 → 按 `minW` 比例分配 + 格内 `…` 截断（`truncateSegs` 段感知，不切半个 CJK）。
- **数字列自动右对齐**：分隔行未显式标注（无 `:`）且表体非空格全为数字 → 右对齐（显式 `:---` 优先）。
- **窄终端回退**：可用宽 < 左竖线 + 每列 1 列 + 固定开销（每格左右留白 + 列间分隔）→ `tableBox` 返回 `null`，调用方退回普通文本行。
- **元数据**：表格子树整棵挂同一 `rowMeta`（`markSubtree`）——`fill` 后各行 `kind`/`blockId` 必须与所在回复一致，否则回复组折叠（`foldDialogue` 按连续 `assistant` 行分组）与块内空行判定会把表格当成新块；表格节点自身即对话区叶子（不再外套缩进 spacer，左竖线列已含在表内）。
- **回归**：`tests/table.test.ts`（21 例：解析/转义/列宽/压缩/截断/对齐/加粗/网格与交叉字/左竖线连续/行高/fence 保护/窄宽回退/元数据传播）；全量 894 单测。

## 验证方式

- 单元：`node --test`（input 解码、layout 视口等）
- 集成：`npm run demo`（mock 全栈）+ `npm run demo -- --smoke`（帧断言 SMOKE_PASS；无 TTY/CI 下自动合成按键驱动并自断言、失败置非零退出码）
- 真机：`npm run smoke:pty`（真实 DSH PTY 冒烟：真实会话断言工具行与状态栏 usage）+ `TUI/scripts/verify-p0.py`（会话切换/标题/OSC52 复制，可重复执行）
- 性能：`npm --prefix TUI run bench`（`bench/layout-bench.mts`：cold/warm/incremental 三档 cache off/on 中位耗时与倍数，报告式、不设阈值）
- 打包：`pnpm pack` + 全新空目录 `pnpm add <tarball>` 验证 files/bundle patch；当前开发脚本使用 `npm run`

## 渲染管线重构·实现记录（FrameRow 段级契约 + Box）

> 实现细节（机制决策、具体写法、踩坑）统一记录在本文档；`SPEC.md` 只保留规范性接口/规则。重构期间
> （主线 A 契约迁移 + 主线 B Box 模型，见 `TASKS.md`）在此追加实现注意点：
>
> - **段序列化**：`segStyle` 实现要点（相邻合并判定、未知名回退、行尾 SGR 重置）——规范见 `SPEC.md` §14
> - **Box 摊平**：`fill` 实现注意点（Paragraph 折行/行内解析/补白、Box 递归、`setCell` 边界安全）——规范见 `SPEC.md` §6.7
> - **尺寸计算**：`measure`/`allocate` 实现注意点（优先宽分割→高生长→视口裁剪，无迭代回环）——规范见 `SPEC.md` §6.1-§6.4

### 主线 A：RenderLine → FrameRow 契约迁移（已完成）

3 个独立可回归提交（行为不变：570 单测（当时值；现 844）+ 36 smoke 帧断言为回归标准）：

- **契约类型**（98e9efd）：`theme.ts` ColorName 增 `"code"` 槽位（dark #434343 / light #E8E8E8，历史值；现 dark=ansi[0] #272336 / light=ansi[7] #E9EBEE）；
  `screen.ts` 并存新增 `FrameStyle`/`FrameSegment`/`FrameRow` + `segStyle`/`serializeFrameRow` 纯函数
  （相邻同 style 合并、异 style 先 close 前段再 open 新段、open 顺序 bold→italic→underline→strike→fg→bg、
  行尾 SGR 复位回主题基底、未知名色名回退基底、`#hex` 直用、close 逆序）。
- **markdown 收敛**（d0d28d6）：`InlineSegment`→公共 `FrameSegment`，`style.bg:"code"`（hex 常量迁 theme）；
  C2 决策：不整体重排 markdown.ts，仅定向契约收敛（零宽表/块识别顺序不动）。
- **原子翻转**（b35826d）：`screen.ts` render/renderDelta 收 `FrameRow[]`（内部 `serializeFrameRow`）；
  `renderer/index.ts` delta 按序列化文本 + caret 比较、主题切换清空 previous frame（全帧重绘）；
  `layout.ts` 排版层全面段化（`wrapSegs` 返回 `FrameRow[]`、modeBlock/statusBlocks/renderStatusLine/
  buildFrame 全改段数组、`colorFor` 烘焙 → style 字段）；components 8 文件同步；`markdown.ts`
  wrap\* 系列去序列化返回 `FrameSegment[][]`；删 `RenderLine`/`renderSeg`/`CODE_BG`。

迁移踩坑（已修复）：

- **选项级着色语义**：状态列 `add()` 各选项按自身语义色高亮（policy ask 绿 / auto 红），段化时误改为
  整行单色且逻辑取反；且选项间分隔空格应独立无色段（BASE `join(" ")` 语义），否则 SGR 后带前导空格
  破坏 `[..mauto` 断言。以 smoke policy-badge-ask/auto 帧断言回归兜住。
- **delta 主题**：FakeRenderer/renderer 需随 `setTheme` 切换序列化主题，否则 `/theme light` 后颜色断言用 dark 色板。
- **测试迁移（C3）**：按测试意图迁移而非统一 ANSI 序列化掩盖——布局断言用 `rowText(row)`/segments/style；
  颜色语义断言检查 `segments[].style`；仅 renderer/screen 回归用 `serializeFrameRow` 的 ANSI；
  FakeRenderer 的 `lastRender` 用 `rowAnsi(row, themeId)`（保留 ANSI 供 SGR 断言，纯文本断言再 strip）；
  新增「所有 FrameSegment.text 不含 `[`」不变量断言（`tests/layout4.test.ts` 尾部，对含
  markdown/状态列的代表性 `buildFrame` 帧全量检查；`tests/helpers/rowText.ts` 仅提供序列化辅助）。

> 具体条目随实施推进补充（含单测断言写法与性能观测）。

### 主线 B：Box 排版模型（已完成）

三波推进（`TASKS.md` §2），行为不变基线：TUI 686 单测（当时值；现 844）+ 36 smoke 帧断言 + 冻结 fixture。

- **接口冻结**（cc743d7）：`box.ts` 定义 `Box`/`Paragraph`/`NodeBase`/`Width` 类型与
  `measure/allocate` 签名；同步修订 `SPEC.md` §6 契约歧义（SizeTable.root / separator 仅纵向 Box /
  Paragraph 总宽含 indent+prefix）。
- **measure/allocate**（eea8196）：`measure.ts` 纯函数；advisor 两轮修复——spacer 轴显式互斥、
  多 ratio 归一、min>max、fill max 截断回流、v 过度约束压缩顺序。
- **内容映射**（b84d4b5）：`build-box.ts`+`fill.ts`+`content-rules.ts` 取代 `wrapBufferLines`；
  双轨对照冻结 fixture + cutover，`wrapBufferLines` 已删、两处调用点走 `buildContentRows`。
- **依赖基元迁移**（fd96d27）：抽 `layout/primitives.ts`（seg/rowWidth2/truncateSegs/
  truncateToWidth/wrapLine/wrapLines），measure/layout.ts 共用，避免双向依赖。
- **接线汇合**（19ca9bb 及后续）：`focus-frame.ts` 焦点框全局覆写（setCell 不切 CJK/code-point、
  styleEqual 全字段、focusedPanel 空不覆写）+ `panel.ts` 场景原语 + 7 面板改 `buildXxxBox`；
  buildFrame 末尾单次 `focusFrame`；冻结 fixture 对照 16 场景逐行等价。
- **advisor 复核修正**（d74e8ec）：7 面板 render 薄包装（`buildXxxBox` → `fillBoxTree` 单一数据源）；
  panel 原语 styled 基础（wrap:false 默认、bold 可选）；layout 清理 17 个未用 import（632a476）。
