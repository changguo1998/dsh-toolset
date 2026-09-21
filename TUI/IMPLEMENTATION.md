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
  - **跨回合帧率上限（可选，真实接线默认 10Hz）**：`AppDeps.frameIntervalMs`（`main.ts` 传 100；0/缺省=不限帧，测试与演示保持立即出帧）。`flushPaint()` 距上一帧不足该间隔时**不清脏**、改挂一个「窗口末」定时器，窗口内跨宏任务的标脏合并到该时点统一出一帧——把事件洪峰的每回合一出帧压到目标频率。`paintNow()` 抢占时取消窗口定时器；`dispose()` 一并清除。
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

## 历史区回滚：语义锚点 + 渐进窗口

- **为什么**：旧模型用「距底部行数」（`scrollOffset`）+ 全量物化，「上滚即展开全量」。三处弱点：底部新增/流式增长会改变同一偏移所指的内容（视图被顶走）、resize 重排后锚定内容跳、首帧上滚要付一次全量排版。
- **语义锚点**（`layout.ts`：`DialogueAnchor{seq,row}` / `DialogueSpan` / `DialogueGeometry`）：
  - 位置改成**内容身份**——视口顶行 = 来源 buffer 行的**稳定序号** `seq` + 行内换行序号 `row`（`seq = -1` 是折叠占位行）。序号在行插入时由 `state.append*` 分配（`BufferLine.seq`，`AppState.nextSeq` 单调递增、只增不减），`RowMeta.seq`/`ContentRow.seq` 由 `buildBox`/`fill` 透传，`dialogueSpans(rows)` 每帧把行按序号压成分组表（无序号时回退行下标，便于直接构造 buffer 的单测）。
  - **为什么必须是稳定序号而不是行下标**：`turn-begin` 会 `filter` 掉上一回合的瞬态活动行（thinking/tool/notice/非 final 中间输出），`MAX_BUFFER_LINES` 也会从头部裁剪——两者都让行下标整体平移；按下标存的锚点会指向别的内容（表现为「提交新消息后视图跳到新内容」），按序号则不受影响。
  - `anchorToIndex`/`indexToAnchor` 互算（锚点行已被清掉时收敛到**空间上最近的前一行**，越界收敛首/末行）、`moveDialogueAnchor(anchor, deltaRows, geom)` 做行位移（顶到窗口末行 → 返回 `null`，即跟底 = 旧 `offset 0`）；`anchorToOffset` 供 `scrollOffset` 派生缓存口径。
  - 帧渲染：`topIdx = anchor === null ? maxTop : clamp(anchorToIndex(...))`，视口 = `[topIdx, topIdx+height)`。因此**底部新增行、resize 重排、扩窗在上方插入行都不会移动锚定的内容**。
- **渐进窗口**（`dialogueWindow(buffer, groups)` / `turnGroupStarts`）：只物化尾部 `windowGroups` 个回合组（缺省 `DIALOGUE_KEEP_REPLIES=3`），组起点 = user 行，或无 user 前缀的回复起头（恢复会话也能切）；窗口未覆盖最旧内容时顶部加 `...(更早回复已折叠)` 占位行（锚点 `line = -1`）。`buildContentRows` 接切片 + `lineOffset`，于是「折叠」不再是显示层裁剪，而是**排版量随窗口收敛**。
- **增窗/复位**：`scrollDialogue()`（`state.ts`）在位移后判断——上滚且视口顶行进入窗口顶部半屏区间（或窗口内已无可滚行）→ `windowGroups += WINDOW_GROW_STEP(3)`（封顶总组数）；扩窗在视口上方插入行，锚点不变所以画面不跳。下滚回到底部（锚点 `null`）时复位默认组数，释放增量物化。
- **按键口径**：↑/↓（半屏）走 `scroll` action（带本帧 `geom`）；PgUp/PgDn 的 `userInputJump` 改为在**物化窗口内**找用户块并返回锚点（无下一条 → `null`，App 转 `scroll-to-bottom`）；`Home` = `scroll-to-bottom`（跟底 + 复位窗口）；`End` = `scroll-to-oldest`（窗口一次扩到全部组 + 锚点钉 `line 0`）。
- **App 接线**：`FrameScrollReport` 增 `dialogueGeometry{rows,height,spans,topIdx}` + `dialogueTop`（本帧渲染的锚点）；`paneMaxes()` 同口径回填/补算，`syncScrollAnchor()` 在出帧后把收敛后的锚点/几何/`scrollOffset` 写回 state（派生缓存，帧已按该锚点渲染故不触发重绘）。**窗口起点不滑走**：用户停在历史里（锚点非 null）而尾部新增了回合组时，按新增组数把 `windowGroups` 撑住——窗口按「尾部 N 组」计，不撑就会被新内容把起点向前挤出已物化范围。
- **回归**：`tests/scroll-anchor.test.ts`（9 例：组切分/切片、互算往返与越界、**底部新增不顶走视图**、resize 重排锚点可解析、位移到顶/底、增窗与复位、End 跳最旧、**回合切换清瞬态行后视图不跳**）+ `tests/layout4.test.ts`（窗口/占位/报告口径）+ `tests/app.test.ts`（键位路径）。

## 对话左右交错留白（`messageGutter` 默认 6）

- **目标（用户 2026-12 口径）**：超长（英文）输入折行时，输入的最左侧与回复正文第 5 个字符同列。
- **列口径**：历史区左缘第 0 列是焦点框保留格（`FRAME_LEFT_COLS=1`，未聚焦空白、聚焦画 `│`），正文区自其右侧起算——回复行 `┃` 占正文区第 0 列、正文自第 1 列起；用户块整体右对齐，左缘留白 `gutter-1` 列（`spacer(fill, min)`）、块内右缘 `┃` 贴正文区最后一列。故输入正文起列 = `gutter-1`（正文区）/ `gutter`（屏幕列），令其等于回复第 5 字符所在列（正文区 5 / 屏幕 6）解得 **`gutter = 6`**。
- **两侧同源**：`gutter` 同时是用户块左缘留白与回复右缘留白（`finalSpace` 的 `spacer(fixed gutter-1)`），故默认 6 时两侧文本上限对称各收 2 列（宽 60 时：正文区 39 列 → 回复正文 33 列、用户文本 33 列，输入左缘与回复第 5 字符同列）。
- **连带**：竖线可见阈值 `USER_MIN_LEFT_GUTTER + 2` 由 6 上移到 8（w≤7 不画竖线）；`DEFAULT_MESSAGE_GUTTER` 与 `normalizeTuiDisplayConfig` 缺省同步 6；`tests/fixtures/focus-frame-legacy.json` 的 w20 四场景按新口径重冻结（窄窗正文宽随留白收窄，属预期）。
- **回归**：`tests/layout4.test.ts`「输入最长折行左缘与回复正文第 5 个字符同列（gutter=6）」+ `tests/content-mapping.test.ts` 竖线阈值边界（w=6/7 关闭、w=8 开启，w=6 相对旧基线已偏离）。

## 声音提醒事件钩子（P2#33）

- **输出口**：`Renderer.bell?()`（可选接口方法；真实 renderer 实现 → `Screen.beep()` 向输出流写 BEL `\x07`；注入型 renderer 可不实现，App 经 `bell?.()` 调用）。
- **config**：`tui.config.json` `notify.enabled`（缺省 true）、`notify.idleThresholdMs`（缺省 8000、最小 1000，`config.normalizeConfig` 归一化）；AppDeps.notify 注入（main.ts `loadTuiConfig().notify`）。App 构造只保阈值 >0 合法性；1000 下限属用户配置层职责（AppDeps 直传如测试可用小值）。
- **触发**：`App.onTurnEnded()`（turn-end case 钩子）——任务结束响一次；随后 `setTimeout(idleBellMs)` 等待输入，超时补响一次。`handleKey` 任意键 → `clearIdleBellTimer()` 取消本次等待；`dispose()` 清理计时器。`bellEnabled`/`disposed` 双检查防关闭后误响。
- **测试**：`tests/notify-bell.test.ts` 5 例（turn-end 响一次 / enabled=false 不响 / 超阈值补响 / 输入取消 / 真实 renderer 输出 BEL）+ `config.test.ts` notify 归一化 1 例。
- 边界：仅 TUI 事件触发 + bell，不动插件、不做桌面通知。

## 自动清理空会话（session.autoCleanEmpty）

- **config**：`tui.config.json` `session.autoCleanEmpty`（缺省 true，可显式 `false` 关闭）；`config.normalizeConfig` 归一化（非法回落 undefined，默认由消费方应用）；main.ts `loadTuiConfig().session?.autoCleanEmpty ?? true` → AppDeps.autoCleanEmpty（`deps.autoCleanEmpty === true` 才生效）。同一开关覆盖**启动**与**优雅退出**两个时机。
- **判据**：`startupCleanableIds(records)`（state.ts 纯函数）——已持久化 + 非 live + 非当前 + `isEmpty`（无用户消息），全目录范围，与面板 `cleanableSessionIds` 同语义但不依赖 history 面板状态（启动时未必打开）。
- **共享核心**：`cleanableSessionIdsViaAdapter()`（`listSessions()` 全量 → 判据过滤；列表缺失/读取失败返回空）+ `deleteSessionIds()`（逐个 `deleteSession()` 串行删除，复用 `/session` 面板同一守卫，返回成功/失败计数）；启动与退出清理共用。
- **启动执行**：`App.start()` 末尾 `if (this.autoCleanEmpty) void this.runStartupCleanEmptySessions()`（后台异步，不阻塞首帧）——notice 汇报「已自动清理 N 个（M 个失败）」。
- **退出执行**：`App.dispose()` 开启时走 `disposeWithExitClean()`——先 `runExitCleanEmptySessions()`：有可清理项把「正在清理 N 个空会话...」**渲染到活动区**（`paintExitNotice`：dispose 已置 disposed=true，常规 notice/paint 被守卫拦截；且主接线 10Hz 合帧可能把标脏推迟到关终端之后——故同步 apply + render 直接落屏）并等待完成，结果与耗时同样渲染到活动区，完成后才执行释放 adapter/关闭渲染器；无清理项静默。等待受 `EXIT_CLEAN_TIMEOUT_MS`（5s）兜底，超时渲染提示并继续退出。仅优雅退出路径（`/quit`、Ctrl+D、双击 Ctrl+C、插件 unload）覆盖——信号强退（SIGINT/SIGTERM）与崩溃由 renderer 直接 `process.exit`，无法可靠等待异步 IO，不保证清理。
- **降级**：宿主未挂 `sessionQuery`（listSessions/deleteSession 缺失）、列表读取失败或无可清理项 → 静默跳过；删除失败计入失败数一并提示，不让启动/退出失败（未开启路径 `dispose` 保持同步收尾）。
- **测试**：`tests/session-delete.test.ts` 启动清理 3 例 + 退出清理 4 例（清理顺序与提示 / 无可清理项静默 / 部分失败计数 / 缺省同步收尾）+ `startupCleanableIds` 纯函数 1 例 + `config.test.ts` session 归一化 1 例；`app.test.ts` disposer 测试改为等待退出清理后的收尾（仓库 tui.config.json 已开启该开关）。

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
- 命令输入补全：`LOCAL_COMMANDS`（commands.ts，含别名项）为**路由与补全目录的单一来源**（`routeSlashCommand` 变为 `LOCAL_ROUTES` map 查表，未知名落 registry 转发）；纯函数 `completeCommandInput(text, extra, mode)` 做前缀匹配（名称短→长排序，items[0]=最匹配）、候选**不设硬上限**、同名以本地优先去重，`mode=slash` 时先把「无前导 `/` 的输入框文本」归一为字面 `/name` 再判定（slash 模式的 `/` 由 App.submit 提交时才补）。候选存入 `state.completion`，**唯一计算点在 reducer**：`input` action（setInput，所有编辑键的唯一漏斗）、`input-mode`（切换模式重算）、`command-catalog`（宿主目录到达）；展示复用活动区覆盖层（`components/CommandCompletion.ts`，与审批/问答/picker/statusPanel/jobsPanel/historyPanel 同一渲染链；footer **不**空白占位——补全不占输入区，输入行与光标必须可见）。面板只占活动区：标题 1 行 + (activityH-1) 行候选——候选池足够时铺满活动区（曾设 COMPLETION_LIMIT=16 硬上限导致活动区高时底部留白，2026-11 移除）；**超出可视行的候选直接丢弃、不滚动窗口**——渲染只取前 activityH-1 项，App 侧 `completionVisibleRows()` 给 `completion-move` 传 `max` 把 ↑/↓ 与 Tab 接受也限定在可视范围内；候选每帧由输入重算，故窗口尺寸变化无需回收状态），键位提示不放面板内而在输入区下方的按键提示区（`COMPLETION_HINT_LINE`，`normalInput` 保持为真故提示区仍存在）。按键：`Tab` 接受（写命令名 + 尾随空格，slash 模式不写前导 `/`）、`↑/↓` 移动（in `handleKey` 的 normal 分支先于面板滚动）、`Esc` 收起（不打断运行），`Enter` 保持提交语义不变。宿主目录经 `adapter.commandList()`（结构面 `DshCommandLike.list(agent)` = 官方 `commands.list(agent)`，仅取 name/description，缺失/抛错 → undefined 降级为仅本地命令）。
- 显示格式：纯 ASCII，紧凑 `provider/model` 一行一个模型；当前模型前 `->`，其余模型前空格缩进对齐。`renderStatusLine` 返回可多行 `FrameRow[]`，状态栏内容超出行宽时溢出到下一行（不再截断丢弃段），model 排在 time 之后第 2 位优先显示。
- 状态回显：切换成功后 `systemStatus.model` 更新为 `provider/model` 并写入 notice；`App.start()` 读取 `modelCatalog().current` 写入 `systemStatus.model`（不再用占位 `—`）。宿主 `agentDefaultModel` 需等 LLM provider 注册后才返回真实路由，早读会拿到内置兜底；故改为**常驻跟随 StatusTicker 的 5s 周期**（值变更才重绘），不受启动窗口限制，运行中宿主默认变化也会自动跟上。
- **已知限制：模型不随会话持久化/恢复（2026-10 核实，暂不修）**。`/model` 只改进程内 `sessionModel.current`（不落盘），因此**会话不保存「当前模型」**，resume 也不会还原：`resumeTo` 传静态 `agentOptions: route`（配置/宿主默认，`dsh.ts`），setup 的 `installSessionModelSelection` 按 `ref.current ?? fallback()` 覆盖每个请求的 provider/model，**不读目标会话最后使用的模型**。已核对真实会话落盘（`~/.dsh/sessions/<project>/<id>/session.v3.jsonl.zstd`）：日志只按次记录 `request/header`（`header.config.provider/model/reasoningEffort`，可查「用过哪些模型」，实测单会话中途换过模型），**无 `model/selection` 事件**，折叠状态 `record.rows` 亦无模型行。影响有二：① resume 后回落到宿主默认而非该会话最后用的模型；② 同进程内先在 A 会话切模型、再 resume B，残留的 `sessionModel.current` 会带进 B（串味）。TUI 的 `state.modelBySession`（`model/selection` 事件回读）目前只写不读。修复需 TUI 侧自存「会话→模型」映射（核心无 per-session 持久化 API，`agentDefaultModel.saveSelection` 是全局默认不适用）；见 `DESIGN.md`「规划与边界 · 待做」。

## /policy /permission /preset（通用状态选项面板）

- 写路径与 fail-safe 见 DESIGN「命令域」。
- `/policy`、`/permission`、`/preset` 无参统一打开 `statusPanel`（`src/app/components/StatusPanel.ts`，活动区窗口，与审批/问答/模型选择同区域）。状态：`StatusPanelState{kind,title,options[],index,selected}`（`state.statusPanel`）；reducer `status-panel-open/move/select/close`。提交路径：policy→`setApprovalPolicy`；permission→`runCommand("/permission <name>")` 转发宿主；preset→`selectAgentPreset`。goal/todo 保持只读右侧栏；plan/sandbox 无宿主写接口暂不开放面板。
- 交互：↑/↓ 移动焦点、空格预选星号（再按取消）、Enter 提交预选（无预选回退焦点行）并关闭、Esc 取消；当前策略来自 `state.policyBySession[sid]` 事件回读。着色：预选行绿、未预选的焦点行黄，同一行两者兼具时绿优先。
- **接收者绑定**：caller 侧对 adapter 方法一律以 `method.call(adapter, …)` 保留实例作 `this`（与 `approve`/`interrupt` 等一致）——提取为局部变量再调用会导致方法体内 `this.xxx` 为 undefined、异步方法恒 rejected、误报「服务不可用」。

## /theme 命令

- 配色方案：启动时解析 `tui.config.json` theme 段（`renderer/theme-config.ts`：解析优先级 = 内联 `palettes.<id>` → `paletteDir/<file>.json`（上游单一源，默认 `~/fff/config/terminal-colortheme/`）→ 内置兜底快照）。`theme.ts` 的 `THEMES` 仅是兜底快照（= 当前上游配色），不再靠内嵌拷贝同步；语义色槽位 `gray`/`border`/`code`/`focus` 从各主题 `semantics` 数据解析（不再按主题名/ID 分支）。定义 16 个 ANSI 槽位 + 基底前景/背景，全部换成 truecolor ANSI。
- 槽位映射：`black..white` → `ansi[]`，`brightBlack..brightWhite` → `bright[]`；语义槽位 `gray`/`border`/`code`/`focus` → 各主题 `semantics`（默认 dark：gray=bright.0、border=ansi.4、code=ansi.0、focus=bright.7；light：gray=bright.0、border=ansi.4、code=ansi.7、focus=ansi.0）。`ansiNameToHex(theme, name)` 解析（颜色名转小写后查表）。段级 `style` 由 `segStyle` / `serializeFrameRow`（screen.ts）按 Manual-ANSI 处理（fg/bg 分别 `38;2`/`48;2`，bold 用 `1m`/`22m`），着色一律**以主题基底前景/背景收尾**（不用 chalk：chalk 以 `39m`/`49m` 收尾会复位到终端默认，浅色主题下不可读）。
- 基底色：`Screen` 持有当前主题（`setTheme(id)`），整帧渲染在 `ESC[2J` 清屏**之前**写出基底前景/背景（truecolor 背景 → 清屏即填充主题色）；每个 delta 行也带基底，保证 `ESC[K` 擦除以主题背景填充。`setTheme` 同时清掉渲染器 delta 缓存（`prevLines = null`），切换后必然全帧重绘。`close()` 前 `Screen.reset()` 输出 `ESC[0m` 恢复终端默认。

## markdown 列表项悬挂缩进（块级 markdown）

- **行为**：`wrapAssistantLine` 的普通列表（`-`/`*`/`+`/`1.`）与任务列表（`- [x]`/`- [ ]`）长项折行时，续行行首补与列表前缀同宽的空格（无序 `• ` 2 列 / 有序数字前缀按实际列数 / 任务 `[x] `、`[ ] ` 4 列），正文与首行文字同列对齐、不穿回第一列不顶满。
- **实现**：`layout/markdown.ts` 新增 `wrapListRows(segs, prefixWidth, width)`——复用 `wrapFrameSegments` 的 `hanging` 续行折宽（扣 `prefixWidth` 封顶总宽），并在折行结果每个续行行首补 `prefixWidth` 宽空格段；首行保持前缀随正文全宽折行。前缀宽 `<= 0` 或无续行时原样透传（不引入空段）。
- **对齐设计意图**：SPEC §2 `text(prefix:{"• "}, hanging:2)` 早声明列表悬挂缩进，此前 `wrapAssistantLine` 列表分支漏传 `hanging`（续行顶格）；本轮补上，与工具行 `/help` 双列表格的悬挂机制同构。

## markdown 表格（SPEC §3.2）

- **位置**：`src/app/layout/table.ts`（解析 + 构建期降级构建器）；识别与接线在 `layout/build-box.ts` 的 assistant 分支（`for` 改为索引循环以做逐行前瞻）。
- **为什么构建期算宽**：列宽是跨行约束（同列各行必须等宽），纯 `v/h` 表达不了跨兄弟约束；构建期把 2D 数学算完，产出「每格 `width:fixed`」的 `v([h([…])])` 子树，引擎保持两类节点。因此 `buildBox` 新增 `BuildBoxOptions.width`（`buildContentRows` 透传内容区宽）；**宽度未知时不识别表格**（按普通文本行渲染，保持 `buildBox` 直调语义不变）。
- **识别**：`isTableStart`（表头须含未转义 `|` + 分隔行格全为 `:?-+:?` 且列数一致）做 O(1) 预筛，仅命中时才向前收集连续表格行（收集在首个非 `|` 行停止），避免长回复下全量扫描；`fence` 内不识别。数据行缺格补空、多格忽略。
- **单元格叶子用 `StyledText` 而非 `Paragraph`**：构建期就做行内解析，否则 `measureParagraph` 按原文（含 `**` 等标记）算行数，与 `fill` 的渲染文本口径不一致，会多出空行。行高由 `measure(leaf, {maxW: colW})` 用引擎同口径算得后**显式声明** `height:fixed`，`fill` 的 `valign:"center"` 补白才生效。
- **网格：左缘竖线连续 + 1 空格间隔（2026-12 订正）**：整表最左 1 列为 `┃`（`brightBlue`，与 assistant 正文左竖线同列同色）——竖线概念上属父级 box、内容整体在其右侧，故**逐行重复**（`"┃\n┃"` + 显式高度），折行续行与横线行也在，整条回复左缘竖线连续；竖线后固定 1 空格（表格 box 的 prefix），横线自该空格之后起，**不与回复左缘竖线连接**。此前竖线列在横线行用交叉字形（`╢`/`├`）把横线接进左缘，横线行处蓝色粗竖线被替换成细竖线/双线（视觉干扰），且 `╢`（垂直双线+向左单横）向右无横线导致表头双横线左端断开；订正后左缘**不设交叉字**，两种现象一并消除（用户 2026-12 实测：「蓝色竖线作为整个回复的提示应当保留，表格部分的 box 应当添加一个空格作为 prefix」）。数据行之间画单横线（首尾不画），用于内容折行时区分「哪一行」。
- **网格线不着色**：`│`/`═`/`─`/交叉字一律用主题默认前景色（`seg` 不带 style），只有左缘竖线取 `brightBlue`（与正文竖线同色）；表头格加粗与格内行内样式照旧。
- **横线行的横线须铺满整个列区域**（列宽 + 左右留白），故不经 `gridRow` 的 pad 装配（否则每列多出 2 列、总宽超出预算导致折行错位）。
- **列宽求解**：自然宽按**渲染文本**计（CJK 2 列）；超预算用**水位法**（`waterLevel` 二分）——窄列保持自然宽、只有超宽列被压到共同水位线，避免「按自然宽比例缩放」把窄列压到 `minW` 以下（表头难看换行）；抬到 `minW` 后若超预算则退回纯水位线。`ΣminW` 仍放不下 → 按 `minW` 比例分配 + 格内 `…` 截断（`truncateSegs` 段感知，不切半个 CJK）。
- **数字列自动右对齐**：分隔行未显式标注（无 `:`）且表体非空格全为数字 → 右对齐（显式 `:---` 优先）。
- **窄终端回退**：可用宽 < 左缘竖线 + 1 空格间隔 + 每列 1 列 + 固定开销（每格左右留白 + 列间分隔）→ `tableBox` 返回 `null`，调用方退回普通文本行。
- **元数据**：表格子树整棵挂同一 `rowMeta`（`markSubtree`）——`fill` 后各行 `kind`/`blockId` 必须与所在回复一致，否则回复组折叠（`foldDialogue` 按连续 `assistant` 行分组）与块内空行判定会把表格当成新块；表格节点自身即对话区叶子（不再外套缩进 spacer，左缘竖线列已含在表内）。
- **回归**：`tests/table.test.ts`（21 例：解析/转义/列宽/压缩/截断/对齐/加粗/网格与交叉字/左缘竖线连续 + 间隔空格（横线不与其连接）/行高/fence 保护/窄宽回退/元数据传播）。

## 活动区排列：黄金分割比自动选上下/左右（layout.activityPlacement）

- **位置**：`src/app/layout.ts` 的 `topPaneSplit`（纯函数），唯一调用点是 `frameGeometry`（几何唯一来源）；`buildTopRegion`/`buildStatusSeparator`/`buildFrame` 与 App 的翻页/半屏/跳转全部读 `frameGeometry` 的结果。
- **判定**：pane 宽高比与 φ≈1.618 的对数偏差（`|ln(w/h/φ)|`，取两 pane 较差者）小者胜。等分（divisor=2、纵向两 pane 等高）时该判据等价于「左列正文宽 / 可用行数 > φ → 左右排列」：区域比 φ 更扁时把宽度对半分反而更接近黄金矩形（上下排列会给出一块比 φ 更扁的横条）。判据只吃左列正文宽 + 顶部内容高，**不含**右侧状态列宽。
- **为什么不放在 state**：判定是尺寸的纯函数，启动与 resize 各自重算即可；不做滞回（阈值处反复拖动终端时最多一次翻转，且翻转点本身就是重排点）。缺省 `"vertical"` 保持既有上下语义（含 `activityTopRow` 锚定与 `activityHeightDivisor` 比例）。
- **两 pane 独立宽度**：横向时**活动 pane 在左、历史（对话）pane 在右**；活动 pane 宽 = `floor(正文宽 / divisor)`，对话 pane 宽 = 正文宽 − 活动 pane 宽 − 1（两侧各保底 20 列 → 正文宽 < 41 或可用行 < 2 时回落上下）。`BuildBoxOptions` 新增 `activityWidth`，`buildContentRows(buffer, opts, w, aw)` 两 pane 各自 measure/fill；**不做两次 buildBox**（流式下 markdown/表格构建会翻倍），只在构建期给活动 pane 的表格用 `activityWidth` 算预算。
- **拼行**：横向行 = 左缘框格 + 活动行（补空格到 `activityW`）+ 内部分隔 `│` + 对话行（补到 `dialogueW`）+ D 列 + 状态列 + 右缘框列；活动区分隔行消失，标题栏下划线行在内部分隔列让位 `┬`，状态区分隔行该列收束 `┴`（`buildStatusSeparator` 以几何为入参）。**活动 pane 恒底部对齐**（两种排列一致：内容自 pane 底边往上长，填满整块 pane 后才折叠最早内容），面板仍顶部对齐且按 `activityW` 排版。
- **折叠点 = pane 高**：活动内容窗口切片用 `geom.activityH`（横向 = 整列可用行数，纵向 = 可用行数的一半），与渲染 pane 的程序同一变量——这正是「能用一个就不要用两个」要修的点：切片与 pane 各算一份时会出现「活动区内容高度与纵向相同、走到一半就折叠」。
- **滚动**：`scrollOffset`/`activityScroll` 语义不变（距各自 pane 底部行数），但**换行宽度/视口高变了**——所有跳转/半屏/翻页坐标统一读 `frameGeometry`（与帧同源：`dialogueW` 换行宽、`viewportH` 页高、`activityH`/`contentTopH` 页高）；`FrameScrollReport` 上限随 pane 高变化自动收敛。
- **焦点框**：`FocusFrameContext.innerDividerCol` 非 undefined 即横向——activity 右缘/history 左缘改为此列（activity 顶边右端用 `┬`、history 顶边左端用 `┬`；底边两端 `┴`），history 右缘仍是 D 列；rects 按左右并排构造（activity 在左、history 在右，等高，底边 = 状态区分隔行）。
- **回归**：`tests/layout-horizontal.test.ts`（8 例：内部分隔列与 `┬`/`┴`、两 pane 定宽、滚动口径一致、焦点框角字、独立宽度换行、**活动区底部对齐（填满 pane 后才折叠）**、**排队块钉在历史 pane 右下角**）+ `tests/config.test.ts` 的 `topPaneSplit` 判定表。

## 活动区内容生命周期（不清单类；只在用户输入后整体清空）

- **不按组数折叠**：`flushToolRun` 不再截断工具调用组（`TOOL_MAX_GROUPS` / `TOOL_MORE` 常量与 `...(更早工具调用已隐藏)` 占位已删除）。工具历史只受**活动 pane 可视行数**约束：内容先自下往上填满整块 pane（`activityH`，横向 = 整列可用行数），更早内容折叠在 pane 顶边之外，Tab 聚焦活动区后 ↑/PgUp 可回看（`activityMaxScroll = 活动内容行数 − activityH`）。`tests/content-mapping.test.ts` 里两例旧折叠场景改为「记录基线含占位、新实现全量保留」的显式差异断言。
- **清空时机 = 用户输入**：`turn-begin` 带 `clearActivity` 参数——`true` 时清空活动区内容（`thinking`/`tool`/`notice`/非 `final` assistant **整类一起清**，不做单类清除）并把 `activityScroll` 归零；`App.beginTurnIfNeeded(userInput)` 只在「用户输入开启的回合」传 true：空闲提交（`sendUserText`）与排队消息被核心认领（`state.queued.length > 0`）——核心自发的回合（goal 轮次、定时唤醒等）只画分隔线、保留上一轮内容继续往上堆。
- **打字机不丢内容**：正文到达或延迟 `turn-end` 接管时，未放完的思考由 `drainThinking()` **整段放入缓冲**（旧的 `dropThinking` 会静默丢弃未显示的思考）；`dropThinking` 仅留给 `dispose`。
- **回归**：`tests/app.test.ts`「活动区生命周期：核心自发回合不清空（用户输入才清空，且整类一起清）」+ `tests/layout4.test.ts`「工具历史不按组数折叠，只受活动 pane 可视行数约束（超出可上滚回看）」。

## 活动区详略两态（`/verbose on|off`；SPEC §6.8）

- **语义**：状态 1（`verbose on`，缺省）= 每条目完整折行显示；状态 2（`verbose off`，紧凑）= 每条目**压成 1 行 + 行尾 `…`**，条目内换行折叠为空格。触发方式裁定为**用户显式命令**（不做「按 fill 高度预算自动降级」——自动降级会让同一份内容在不同窗口高度下详略跳变，阅读位置不稳定）。
- **状态**：`AppState.activityVerbose: boolean`（缺省 `true`）+ action `activity-verbose{on}`；`buildTopRegion` 传 `activityCompact: !state.activityVerbose` 进 `buildContentRows` → `BuildBoxOptions.activityCompact`。
- **实现位置**：全部落在 `build-box.ts` 构建期（`compactActivityLine` 单行压缩：按显示宽截断时预留 1 列放 `…`，宽度 = 活动 pane 宽扣该条目前缀列数——思考/非 final 的 `┃` 扣 1 列）。各分支：thinking、tool（调用/结果/辅助行，用压缩后的文本再上色，工具名/`✓` 前缀保持）、notice（紧凑下不再设 `hanging`，悬垂缩进对单行无意义）、非 final assistant（含内部换行/表格的行：紧凑下**不建 markdown 表格**，因其天然多行）。消息前缀占位在 fill 阶段保持原语义。
- **与 pane 高度/滚动的关系**：紧凑只改条目行数，`activityH` 与 `activityScroll` 口径不变；行数变少后 `activityMaxScroll` 自动收敛（`activity-scroll` reducer 已按 max clamp），上滚位置不会越界。
- **回归**：`tests/activity-verbose.test.ts`（完整模式折行多行 / 紧凑每条目 1 行且 ≤ pane 宽 + 行尾 `…` / 换行折叠 / 短条目不加省略号 / 端到端 buildFrame 行数收敛）+ `tests/app.test.ts`（`/verbose on|off` 切换与无参、非法参数只提示用法不动状态）。

## 排版尺寸唯一来源：FrameGeometry

- **问题**：`metricsFor`/`topPaneSplit`/`leftColumnWidth`/`renderStatusLine` 曾在 `buildFrame`、`buildTopRegion`、`inputPanelHeights`、`dialogueScrollMetrics` 各自算一遍（同一件事 4 份），口径一旦漂移就出现「帧里看到的 pane 高度」与「滚动/翻页用的 pane 高度」不一致——横向排列下活动区内容仍按纵向高度排就是这类缺陷。
- **做法**：新增 `frameGeometry(state, size): FrameGeometry`（纯函数，`layout.ts`），把状态栏行、模态/提示区判定、`metricsFor`、`topPaneSplit`、排队块行、视口高、分隔列、内部分隔列、焦点框矩形基准全部**一次算定**并返回；`buildFrame`/`buildTopRegion`/`buildStatusSeparator` 与 App（`focusedLineScroll`/`focusedPageScroll`/`userInputJump`/补全可视行）只读这一份。
- **删除的冗余尺寸入口**：`inputPanelHeights` + `PanelHeights`、`dialogueScrollMetrics` + `DialogueScrollMetrics`（并入 `frameGeometry`）、`ACTIVITY_HEIGHT_RATIO`（已废弃常量）、`THINKING_MAX`（无引用）、`buildTopRegion` 的 12 个位置参数（改为 `(state, geom, report?)`）。
- **语义保持**：面板开关不改变顶部内容行数（输入态 `footer=交互相-1 + 提示 1`，面板态 `footer=交互相 + 提示 0`，`contentTopH` 相同）；`frameGeometry` 同时产出 `statusLines`，`buildFrame` 不再重复调 `renderStatusLine`。

## 排队消息（agent 运行中 Enter）

- **发送：完全走官方流程**。`App.submit` 在 agent 忙（`agentStatus !== "idle"` 或本地 `inputStatus === "running"`，覆盖「刚提交、核心状态事件未到」窗口）时仍是立即 `adapter.sendMessage(text)` → 核心 `followup`（`next-turn` 队列，durable）——**逐条、不合并**、不由 TUI 积压；空闲时走 `sendUserText`（本地回显 + 直接发送）。两条路径的发送语义一致，**差别只在显示**：忙时不回显历史行，改为排队登记。
- **显示登记**：`AppState.queued: string[]`（按提交顺序）+ action `queued-push`（追加一条）/ `queued-claim`（弹出最早一条并 `appendStream(..., "user")` 落入历史）/ `queued-clear`。登记只用于渲染，不代表 TUI 持有消息（消息已在核心队列里）。
- **认领时机**：`beginTurnIfNeeded()`（新回合开始：本地提交或首条思考/正文到达）在 `turn-begin` 之后 `queued-claim`——核心每开一个新回合从 `next-turn` 认领一条，UI 因此「每回合转正一条」；转正后该条按普通用户行渲染（亮红右缘竖线）。
- **渲染**（`frameGeometry` + `buildTopRegion`）：`queuedBlockRows` 把登记文本按 `\n` 拆行、以 `BufferLine{kind:"user", queued:true}` 走同一套 `buildContentRows`（右对齐 + 灰竖线 `gray`），得到 `geom.queuedRows`；对话 pane 最后 `queuedRows.length` 行渲染排队块（**钉在右下角、不随历史滚动**），历史视口高 = `dialogueH − queuedRows.length`（至少留 1 行历史；超长取尾部），`FrameScrollReport.dialogueGeometry.height` 与 App 的翻页/半屏按该视口高收敛。
- **Esc / Alt+Enter**：Esc 先 `restoreQueued()`（登记按顺序并回输入框，核心 `cancel` 会清自己的队列，本机留底不丢输入）再 `interrupt()`；Alt+Enter 同样先并回输入框、打断，然后整条发送（避免「新文本先发、排队内容后发」顺序颠倒；空输入且无登记仍为 no-op）。切换会话（`history-resume-ok`）`queued-clear`。
- **回归**：`tests/app.test.ts`（运行中 Enter 立即发送且逐条不合并、登记不写 buffer、新回合认领一条转正、Esc 退回输入框 + 清登记 + 打断、Alt+Enter 按序并入）+ `tests/layout-horizontal.test.ts`（排队块位置/灰竖线/视口高收缩；纵向活动区底部对齐不变）。

## /help 双列表格（无边框）

- **排版**（`app/layout/help.ts`）：`helpTableLines` 把命令目录排成两列——命令列定宽 = 最长命令显示宽（`displayWidth`，CJK 安全补白）、描述列固定起点；每行文本 = 行首 2 列缩进 + 命令 + 补白 + 2 列间距 + 描述。
- **折行**：不做预折行，交给渲染层。notice 的 `BufferLine` 新增可选 `hanging`（描述列起点的悬挂缩进），`build-box` 把它落到 `StyledText.hanging`——描述超 pane 宽时续行停靠描述列起点（不再穿回第一列），且 **resize 后续行重排仍然对齐**。`BufferLine.hanging` 只在 `/help` 生效，其余 notice 不设（续行顶格）。
- **入口**：`App.helpLines()` 产出「表头 + 表中行 + 表尾」结构化行，`handleSlash` 走 `notice` action 新增的 `lines` 字段（`appendNoticeLines`，逐条独立成行）；表头/表尾是普通行（无悬挂缩进），只在表中行带 `hanging`。
- **回归**：`tests/help.test.ts`（命令列定宽/CJK 补白/单物理行）+ 渲染层用例（`buildContentRows` 窄 pane 强制折行，验证续行缩进 == 描述列起点）。

## 模型输出符号规范化（symbols，2026-09-21）

- **纯函数**（`app/symbols.ts`）：`resolveSymbolRules`（内置默认 + 配置合并）与 `normalizeSymbols`（逐码点，判定顺序：孤立代理/零宽跳过 → **正文内容性排版字符放行**（框线/方块元素 `2500-259F`、数学括号 `2308-230B`、键盘按键 `⌘⌃⌥⌦⌧⌨⌫⇧⇪`——信息载体，见 `TEXTUAL_RANGES`/`TEXTUAL_POINTS`，置于别名之前不参与任何治理）→ 别名映射替换 → 治理区 `[2190-21FF, 2300-23FF, 2500-27BF, 2B00-2BFF, 1F000-1FAFF, FFE0-FFE6]` 内查推荐白名单 → 文字/标点放行 → 其余放行）。输出替换后文本 + `replacedCount/remaps/emojiRemaps/unrecommended`（emojiRemaps = 仅 emoji 呈现起源的替换明细，供反馈按「要求更换」罗列）。
- **接入**（`app/index.ts`）：`case "stream"` 对每段正文 `normalizeSymbols`（slowStream 的 `pendingStream` 与直发两条路径都走规范化），结果累积到 `symbolTurn`（跨段去重）；`turn-end` 两个分支（直发 / slow 的 `flushPending` 补执行）后 `flushSymbolTurn()`：有替换/未推荐 → notice（给人）+ 按需生成 `[符号规范]` 反馈（见下）。
- **反馈注入**：turn-end 检测到替换/警示后**宏任务推迟直发**（`setTimeout(0)` + `adapter.sendMessage`，`[符号规范]` 一条：**emoji 起源替换罗列「请将 X 改为 Y」要求更换**（先要求更换、展示层再替换，2026-11）；**细线变体替换只报计数**、不罗列明细；警示段复述 3 条选择规则 + 要求重新选择）；**同符号冷却（2026-11）**：`flushSymbolTurn` 开头 `tickSymbolCooldown()` 推进 run 计数；emoji 罗列 / 变体计数 / 警示列表三组各自按 `isSymbolCooling(from)` 过滤冷却中的符号，本轮真正列入提醒的符号 `enterSymbolCooldown` 登记冷却——三组全部被冷却时该 turn 完全静默（无 notice 无反馈）；**不**随用户下一条消息合并（原 pendingSymbolText 机制已移除）。不经 `sendUserText` 以避免清空活动区刷掉 notice。直发经宏任务推迟：turn-end 回调内同步 followup 宿主不接（实测不送达/不落盘），宏任务后再发实测送达。发送前检查 `disposed`。
- **配置**（`app/config.ts`）：`tui.config.json` `symbols.{recommended[],aliases{},warnModel,cooldownMs,cooldownRuns}`；`main.ts` 经 `new App({ symbols })` 注入，缺省走内置默认（冷却缺省 10 分钟 / 3 run，均传 0 关闭对应维度）。内置推荐 = `✓ ✗ △ → ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ▶ ◀ ▲ ▼ ▷ ◁ ▽ ⟸ ⟹ ⟺ • ◦ ○ ● ◯ ■ □ ◇ ◆ ⓘ 〜 …`，按「域 × 家族」归一（箭头单线八向 + 双向 `↔↕`、三角四向（实/空心）、C 双线 `⟸⟹⟺`、圆/方块/菱形几何全推（**空心/实心各成一族**，2026-11）、圆族 emoji `⭕→○`（圆环）`⚪⚫🔴🔵🟠🟡🟢🟣🟤→●`（`⬤` U+2B24 黑大圆同 ● 仅大小）、方块族 <code>▫◻🔳🔲→□</code>/<code>◽▪◼⬛⬜🟥🟦🟧🟨🟩🟪🟫→■</code>（🔳🔲 双色方块按钮 → □；◽ 观感实心 → ■，2026-11 订正）、菱形族 <code>🔷🔹🔶🔸⬥⬧→◆</code>/<code>⬦⬨→◇</code>、三角族 <code>🔺🔼→▲</code>/<code>🔻🔽→▼</code>（emoji 按「设计含色数」归类，2026-11：单色填充=实心、双色/内空腔=空心）、状态族 <code>✔✅☑🗹→✓</code>/<code>✕✖✘❌🗙☒🗷→✗</code>（☑☒ 与 🗹🗷 为**特例**）、列表圆点 `•`、信息圈 i `ⓘ`、感叹/问号/加减 emoji→ASCII `!`/`?`/`+`/`-`、金额 `￥￠￡￦→¥¢£₩`、全角波浪 `～→〜`）；**箭头按「方向一致」归一（2026-11）**：各方向黑箭头/三角变体归一到该向代表（A 族 `➔➜➡➠➢➣→→`、`⬅⬆⬇→←↑↓`；B 族 `▸►⏵⏩➤→▶`、`◂◄⏴⏪→◀`、`▴⏶⏫→▲`、`▾⏷⏬→▼`；B 空心三角族 `▹▻→▷`、`◃◅→◁`、`▵→△`、`▿→▽`（▷◁△▽ 四向代表，与实心族不互相归一）；C 族 `⇒→⟹`、`⇐→⟸`、`⇔→⟺`）；**按几何拆分**：`√`（根号）不归一（治理区外放行）；**治理域修正（2026-11）**：`×`（U+00D7 数学乘号，治理区外，数学/计量场景误伤）与 `⌫`（U+232B 退格键）从别名移除，改经 `TEXTUAL_RANGES`/`TEXTUAL_POINTS` 判定为正文内容性字符一律放行（框线/方块元素/数学括号/键盘按键同此，不替换、不提醒）；箭头 D、列表三角点不纳入——使用即提醒；星标域 `★☆✦✧` 与 emoji `⭐` 均无推荐代表——一律按警告处理、不归一（2026-11）、信息图形族（`💡`）不纳入——使用即提醒。
- **选型判据（2026-09-21 评审定稿，用于后续扩展推荐/别名对齐）**：
  1. 归一依据 = **形状身份（几何部件组合）**；功能、语义、宽度一律不参与；
  1. 同一形状身份内只容**修饰性变体**归一：粗细、大小、重复数量、emoji 上色、内缀细节；**明暗/填充（空心 vs 实心）不是修饰**——空心、实心各为独立一族（2026-11 修订）；
  1. 触发**拆分**（不归一，按几何各自独立）：**明暗/填充（空心/实心各成一族）**、新增独立部件（方框）、核心形状变化（圆环 vs 实盘、勾 vs 根号）、方向/对称变化（反向、双向 vs 单向）。
     校准点：`☑`（方框勾）/`☒`（方框叉）与追加符号区 `🗹`/`🗷` 为**特例**（2026-11，用户裁量）：虽带独立方框，不各自成族也不拆分提醒，而是并入无框的细线符号 `✅☑🗹→✓`、`❌☒🗷→✗`；其余独立部件判定照旧（`√` 治理区外放行）；`⏩⏫⏬`（双三角 = 数量/速度修饰）留 `→▶`/`→▲▼`，而 C 族短双线 `⇒⇐⇔` 按方向归一到长双线代表 `⟸⟹⟺`（2026-11，不再拆分提醒）；**空心三角族**（2026-11）四向代表 `▷◁△▽` 入白名单、族内尺寸/指针变体归一到该向代表，与实心 `▶◀▲▼` 族间不互相归一。
- **开关**（`app/index.ts` + `app/state.ts`）：`/symbol-unify on|off`（缺省 on，会话级）——`off` 时 `stream` 不规范化（原样）、`flushSymbolTurn` 直接跳过（不提醒不注入）；`state.symbolUnify` 由 reducer `symbol-unify` 切换。帮助目录与 `COMMANDS.md` 已列。
- **回归**：`tests/symbols.test.ts`（纯函数 7 例）+ `tests/app.test.ts`「symbols」组（展示层替换 / notice / warnModel 注入与关闭 / recommended 扩展 / symbol-unify 开关 / **同符号冷却**：run 次数解冻、时间窗维度、跨符号互不影响、变体冷却）。

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
