# DSH TUI 实现要点（Implementation）

> 类型：**[implementation]** 实现细节记录。
> 配套文档：`DESIGN.md`（架构/设计）、`SPEC.md`（规格）、`TASKS.md`（任务）。本文档记录实现层的关键机制（现状方案），命令路由与文本管线细节；算法/接口规格见 `SPEC.md`，开发任务见 `TASKS.md`。

## Slash 命令路由

- 涉及其他功能的命令走注册-调用方式（`dsh-commands` 注册表），只与渲染相关的命令作为本地小命令表。
- `App.submit()` 对以 `/` 开头的输入走 `handleSlash()`，不进 `agent.followup`、不占模型 token/历史：
  - 本地小命令表（app 层）：`/help`、`/clearscreen`（`/cls`，清空显示缓冲）、`/quit`（关闭 renderer）、`/theme`、`/goal`（仅 notice 提示查看右侧信息栏）、`/session`、`/copy`、`/model`、`/policy`、`/permission`、`/preset`、`/jobs`。
  - 其他 `/name` → `adapter.runCommand(line)` → `ctx.commands.execute(agent, line, [], signal)`（官方注册表）。
  - 未命中注册表（execute 返回 `undefined`）→ `notice` 提示未知命令（**官方 fail-close**：绝不 sendMessage 给模型）。
- 事件面：`DshEvent` 的 `{ type: "notice"; text }`——命令结果/错误/提示只进 UI 缓冲（`appendNotice`，独立成行，不入流式末行），经 `notice` reducer 落地。
- 命令名语法：`parseSlashCommand` 与官方 client 一致——`/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/`。
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

## Mode 初始值折叠

- 官方 `plan/mode`、`sandbox/mode`、`permission/preset`、`approval/policy` 均为 log-only 事件（仅切换时落盘，会话启动无初始事件）→ `DshAdapter.refreshSessionModes?(id)`（`emitSessionModeSnapshot`：从 live 内存事件或 `readSession` 折叠各事件最后一条并 emit mode/approval-policy；**不能用 readSurface**——log-only 事件被 surface fold 滤掉）；`App.start` / `resumeToSession` 成功后调用。

## /model 命令

- 能力：查询可用模型 + 切换当前会话模型（不落盘）。
- `/model`（无参）→ 交互选择模式（面板渲染在流输出（活动区）窗口）：↑/↓ 移动高亮（选项超出可视高度时视口跟随选中项滚动）、←/→ 左右切换 provider/model/effort 三列焦点区（clamp 不循环）、Enter 确认切换、Esc 取消不改变；普通字符键在该模式下被忽略（不进入输入框）。
- `/model <provider>/<model>` → 显式指定切换；`/model <modelId>` → 跨全部 provider 唯一匹配（未匹配或歧义给错误提示，不落盘）。
- 交互选择面板：`AppState.picker`（`PickerState`：options + index + phase + efforts + effortIndex）+ reducer action（`picker-open`/`picker-move`/`picker-tab`/`picker-phase`/`picker-efforts`/`picker-close`）。渲染为 `src/app/components/ModelPicker.ts` 纯函数（输出恰活动区可视行 `activityH` 行）：**provider/model/effort 三列独立列表同屏**，头部全小写；←/→ 切换焦点区（phase 0/1/2，clamp 不循环）、Tab 循环切换，当前模型恒为首行标 `*` 附 `[current]`，焦点行标 `>` 并加粗。等级列表经 adapter `modelEfforts(provider, model)`（结构面调用宿主 `llm.resolveModelInfo` → `reasoning.efforts`；非思考模型返回 undefined，面板显示 `effort: (unsupported)`）异步按高亮模型加载，Enter 应用「模型 + 高亮等级」。`metricsFor` 的 picker 高度预算取（模型列表、等级列表）较大者。宿主等级名首字母大写（Off/Low/High/Max），adapter 归一为全小写再展示（面板与状态栏 `model:<等级>` 后缀同源）。
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
- 交互：↑/↓ 移动焦点、空格预选星号（再按取消）、Enter 提交预选（无预选回退焦点行）并关闭、Esc 取消；当前策略来自 `state.policyBySession[sid]` 事件回读。
- **接收者绑定**：caller 侧对 adapter 方法一律以 `method.call(adapter, …)` 保留实例作 `this`（与 `approve`/`interrupt` 等一致）——提取为局部变量再调用会导致方法体内 `this.xxx` 为 undefined、异步方法恒 rejected、误报「服务不可用」。

## /theme 命令

- 配色方案：内嵌 `~/fff/config/terminal-colortheme/` 的两份 JSON（`fffdark` = dark、`ffflight` = light）作默认浅深模式，定义 16 个 ANSI 槽位 + 基底前景/背景，全部换成 truecolor ANSI。来源为副本——`src/renderer/theme.ts` 的 `THEMES`，改动需手动同步 fff 配置（运行时读取留作后续）。
- 槽位映射：`black..white` → `ansi[]`，`brightBlack..brightWhite` → `bright[]`，`gray` = `brightBlack`。`ansiNameToHex(theme, name)` 解析（颜色名转小写后查表）。`colorFor(themeId, name)` 手工拼接 truecolor ANSI 前景并**以主题基底前景收尾**（不用 chalk：chalk 以 `39m`/`49m` 收尾会复位到终端默认，浅色主题下不可读）。段级 `style` 由 `segStyle` / `serializeFrameRow`（screen.ts）按 Manual-ANSI 处理（fg/bg 分别 `38;2`/`48;2`，bold 用 `1m`/`22m`，各自恢复主题基底）。
- 基底色：`Screen` 持有当前主题（`setTheme(id)`），整帧渲染在 `ESC[2J` 清屏**之前**写出基底前景/背景（truecolor 背景 → 清屏即填充主题色）；每个 delta 行也带基底，保证 `ESC[K` 擦除以主题背景填充。`setTheme` 同时清掉渲染器 delta 缓存（`prevLines = null`），切换后必然全帧重绘。`close()` 前 `Screen.reset()` 输出 `ESC[0m` 恢复终端默认。

## 验证方式

- 单元：`node --test`（input 解码、layout 视口等）
- 集成：`npm run demo`（mock 全栈）+ `npm run demo -- --smoke`（帧断言 SMOKE_PASS；无 TTY/CI 下自动合成按键驱动并自断言、失败置非零退出码）
- 真机：`npm run smoke:pty`（真实 DSH PTY 冒烟：真实会话断言工具行与状态栏 usage）+ `TUI/scripts/verify-p0.py`（会话切换/标题/OSC52 复制，可重复执行）
- 打包：`pnpm pack` + 全新空目录 `pnpm add <tarball>` 验证 files/bundle patch；当前开发脚本使用 `npm run`

## 渲染管线重构·实现记录（FrameRow 段级契约 + Box）

> 实现细节（机制决策、具体写法、踩坑）统一记录在本文档；`SPEC.md` 只保留规范性接口/规则。重构期间
> （主线 A 契约迁移 + 主线 B Box 模型，见 `TASKS.md`）在此追加实现注意点：
>
> - **段序列化**：`segStyle` 实现要点（相邻合并判定、未知名回退、行尾 SGR 重置）——规范见 `SPEC.md` §14
> - **Box 摊平**：`fill` 实现注意点（Paragraph 折行/行内解析/补白、Box 递归、`setCell` 边界安全）——规范见 `SPEC.md` §6.7
> - **尺寸计算**：`measure`/`allocate` 实现注意点（优先宽分割→高生长→视口裁剪，无迭代回环）——规范见 `SPEC.md` §6.1-§6.4

### 主线 A：RenderLine → FrameRow 契约迁移（已完成）

3 个独立可回归提交（行为不变：570 单测 + 36 smoke 帧断言为回归标准）：

- **契约类型**（98e9efd）：`theme.ts` ColorName 增 `"code"` 槽位（dark #434343 / light #E8E8E8）；
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

三波推进（`TASKS.md` §2），行为不变基线：TUI 686 单测 + 36 smoke 帧断言 + 冻结 fixture。

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
