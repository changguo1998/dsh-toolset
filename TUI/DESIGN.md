# DSH TUI 插件设计

## 项目目标

为 DeepSeek Harness（DSH）开发一个轻量级、高性能的终端用户界面插件，作为进程内集成的交互前端，通过复用 DSH 核心服务（会话管理、Agent 驱动、工具调用等），提供 Web UI 和 CLI 之外的另一种交互方式。

## 技术选型

- 语言：TypeScript（与 DSH 核心一致）
- 运行时：Node.js
- 包管理：npm（开发脚本）；发布验证历史上使用 pnpm
- 依赖：chalk（ANSI 颜色控制）
- 可选依赖：node-pty（已评估，暂不引入；除非 TUI 需直接开 shell，否则会话由 DSH 管理）

关键决策：不采用 Ink / Solid-TUI 等成熟框架，自研极简渲染层。
理由与代价：

- 流式输出本质是「增量文本追加 + 偶尔整帧重绘」，human-speed 交互下整帧重绘足够。
- 砍掉：帧 diff、组件树、布局引擎。渲染核心约 150 行，验证可行。
- 输入解码是隐藏大头：需手写 ANSI 转义序列解析（方向键、Home/End、Ctrl 组合、bracketed paste）。node 无 stdlib 键盘解析，这是自研 vs 用 Ink 的真正代价。
- 针对 DSH 特定交互模式（流式输出、工具审批）优化；对渲染和输入事件拥有完全控制力。

DSH 适配层接口以**官方源码研读**为准（`~/GithubRepos/deepseek-harness`，契约沉淀于仓库根 `DSH-CTX-API.md`，基线 `dsh-v0.1.5-rc.2`）：

- 进程内宿主为 vendored `@deepseek-ai/cordis`（Context/Service/Fiber），插件导出 `apply(ctx)`；
- 订阅会话事件：`ctx.on('session/event', (session, event) => …)`（带 `seq` 连续契约），词汇表见 `KNOWN_SESSION_EVENT_TYPES`；
- 审批应答链：`ctx.on('approval/request', (req, next) => …)`，返回 `ApprovalOutcome`（'allowed-once'|'rejected'|'cancelled'|'unavailable'），须在 open turn 内；
- 发消息：进程内 `agent.followup(...)`；进程外官方桥为 JSON-RPC `session/prompt`；
- agent 状态是 agent 层事件 `agent/status`，不在 session 事件词汇表内。

## 文件结构（单包分目录）

```
TUI/
  package.json          # type: module, bin: dsh-tui.js
  tsconfig.json
  src/
    main.ts             # 组装: renderer + app + DSH adapter
  demo/                 # 无 DSH 依赖的 demo：mock adapter 喂模拟流式文本 + 审批，
                        #   完整走通 renderer→app 栈，不接 DSH
  tests/                # 极少的可运行自检；优先覆盖 input.ts（ANSI 解码易错）
  bin/dsh-tui.js        # shebang + import('../dist/main.js')
```

框架层 `src/renderer/` —— 不感知 DSH、不 import app：

```
src/renderer/
  terminal.ts    # raw mode 开/关、resize 监听、退出清理
  input.ts       # stdin 键解码：ANSI 转义序列 → 结构化 key 事件
  screen.ts      # 帧缓冲 + 整帧重绘
  theme.ts      # 内嵌 fff fffdark/ffflight truecolor 调色板 + ANSI 槽位映射
  index.ts       # 公共 API
```

应用层 `src/app/` —— 只依赖 renderer 公共 API：

```
src/app/
  state.ts       # 状态模型：会话列表、流式文本增量、审批项、系统状态区、turn 分隔
  layout.ts      # 四区域帧：顶部(状态列+历史) / 状态区 / 输入行 / 审批弹窗；保留宽度/viewport/buildFrame
  layout/
    markdown.ts   # 宽度原语 + markdown 行内/块级纯解析
  status.ts      # 系统状态区数据源：StatusTicker 合并节流读取 cwd/git/time
  commands.ts    # 纯函数：模型目录格式化/规格解析 + slash 路由/决策
  question-transition.ts  # 问答纯状态转换
  model-transition.ts     # 模型选择纯状态转换
  components/    # TextInput、ScrollView（历史区）、ApprovalPrompt、QuestionPrompt、ModelPicker（纯渲染）
  adapter/
    dsh.ts       # ctx 订阅 → 写入 state；审批/发消息 → 回调 DSH；保留 installSessionModelSelection + createRealDshAdapter；历史会话表面归一化（sessionQuery → SessionInfo/HistoryMessage）
    types.ts     # 纯类型
    normalize.ts # 纯归一化函数
  index.ts       # App：组装层，副作用（adapter 调用/paint/notice/异步）都在此
```

依赖方向（单向）：

```
main.ts → app → renderer
adapter → app（喂状态）
```

## 核心接口契约（renderer 公共 API）

```ts
// 应用调用渲染：每一行携带样式（帧缓冲输入）
interface RenderLine {
  text: string;
  style?: { fg?: string; bg?: string; bold?: boolean };
  caret?: number; // 渲染后硬件光标停留列(0 基)，仅输入行设置
}

// 应用收到的按键事件：input.ts 解码后的结构化结果
interface KeyEvent {
  name: string; // 'a' | 'up' | 'down' | 'enter' | 'tab' | 'escape' | …
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

// renderer 对 app 暴露的公共 API
interface Renderer {
  render(lines: RenderLine[]): void; // 整帧重绘
  onKey(cb: (k: KeyEvent) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  getSize(): { cols: number; rows: number };
  setTheme(id: "dark" | "light"): void; // 切换主题(基底色+槽位),并令 delta 缓存失效
  close(): void; // 恢复终端，退出事件循环
}
```

## 四区域布局

屏幕自上而下切分为：**顶部区域**（左侧对话历史，历史下方为活动区；右侧详细状态列）、**系统状态区**（按宽度可溢出多行）、**输入区**（含审批弹窗形态）：

- **高度分配**：顶部高度 = `rows - 状态区(1) - 输入区 - 提示区(1) - 分隔行(2)`。输入区+提示区为「交互区」：常规终端固定 4 行（输入框 3 + 提示 1），矮终端按 `floor(rows/5)` 收缩、至少 2 行（输入 1 + 提示 1）；提示区固定 1 行、与输入区之间不画横线，输入区取剩余（多行框）；模态交互面板（审批/问答/模型选择）显示于顶部流输出（活动区）窗口、底部交互区以空白占位，与输入态同高——面板开关不上下调整交互区高度；历史/任务等浏览面板仍占据底部交互区（面板自带最底行按键提示、无独立提示区）；面板内容超出时面板内截断/滚动（问答选项按高亮行滚动窗口、选择列省略号滚动、审批正文截断）；「中间与底部满足显示需要，剩余高度全部由上方两个填充」；`buildFrame` 输出顺序为 顶部区 → 横线分隔行 → 状态区 → 横线分隔行 → 输入区 → 按键提示区。

- **顶部状态列**：最右侧常驻一列「详细状态」窄列（`statusColWidth ≈ cols×1/3`，左缘即分隔竖线 `│`（与历史区右缘共用），历史区保底 10 列），与左侧历史区在同一行：显示当前活跃会话的 **goal 详细**（goal 块首行标题 `Goal <phase>`（Goal 蓝 + phase 状态色：active/complete 绿、paused 黄、blocked 红）+ objective（无「目标」前缀）+ 阻塞原因黄 tone）+ **todo 块**（标题 `Todo 完成数/总数`（蓝）+ 列表：`○` 待办(空心圆) / `●` 进行中(实心圆、黄、换行保留色且续行缩进对齐) / `✓` 完成(对号灰不划线、正文灰+删除线)）+ **jobs 块**（标题 `Jobs 运行中/总数`（蓝）+ 任务行：`●` 运行中(黄) / `✗` 失败(红) / `○` 取消(灰) / `✓` 已完成(正文灰+删除线，与 todo 一致)）。**折叠策略**：整体高度未溢出时完整渲染（目标/todo 全文、含已完成任务）。**无强制行数上限、无平均分配**：仅当总高超过窗口高才折叠——按折叠等级从低到高整体尝试、首次放下即采用：**L0** 不折叠 / **L1** 隐藏已完成条目（todo completed、jobs done）/ **L2** 仅保留进行中条目（todo in_progress、jobs running/stopping；goal 块压成标题行「Goal <phase>」，去掉 objective 与分隔线）/ **L3** 进行中条目也压为 1 行；隐藏条目以灰标记 `…(+N项已隐藏)` 收尾。全部等级仍放不下（mode/goal 大头）→ 整列行级截断兜底 `…(+N行)`。无 goal/todo 时该栏直接留空（不显示占位文字）。**会话标题已迁出状态列**——状态列首行直接是 Mode 块，标题栏移至左列历史区顶部（见「历史区」段）。滚动并入「顶部三面板统一焦点滚动」：仅当 Tab 焦点在「状态」面板时响应 ↑/↓/PgUp/PgDn（非焦点下不干扰其他面板滚动）。偏移由 `status-column-scroll` reducer 累积 `statusColumnScroll`（距顶部，上滚=-）、渲染层 clamp。实现 `renderStatusColumn`（layout.ts 纯函数，输出恰 height 行、每行定宽 statusColWidth 且末位竖线为分隔边线）；`buildTopRegion` 剥去该竖线、自行构图：分隔竖线位于 `D=historyWidth` 列（历史区右缘/状态列左缘共用），状态列正文按 `statusBodyW=statusColWidth-2` 定宽截取并补空白。**不同块之间以点更少的虚线 `╌` 分隔**：goal 块（标题/目标/阻塞）与 todo 块（计数+列表）之间插入整行虚线，视觉分层。

- **历史区**：左列顶部为**会话标题栏**（置于会话历史区上方）：标题行（前景色；空标题 `<title>` 灰占位保持行稳定）+ 实线下划线（D 列交点用 `┤` 连接，与活动区分隔行中性态一致）；标题优先官方 `dsh-session-title` 服务落盘的 `session/title` 事件折叠结果，缺失时本地兜底为被恢复会话首条用户消息前 30 字符，无消息为 `（新会话）`。**标题行即屏幕最顶行（rc0，无独立顶部边框行/空行）**，下划线行在标题行之下；标题栏归历史面板（history 焦点时对话框通过下划线行**兼作顶边**：左缘 `┌`、D 列 `┐` 亮框，标题行/下划线行左缘与 D 列其余位置留空白/边框色占位保持布局不重排）；**标题栏行数由对话区承担**（活动区高度不受影响），极矮终端由 `topPaneHeights` 自适应收缩——对话区将不足 1 行时先收掉下划线（标题栏 1 行）、再整栏省略（0 行）以保证对话区非空。正文按 `contentW = historyWidth - FRAME_RIGHT_COLS`（右缘焦点框预留列）换行，沿用 scrollback 语义（wrapping、followBottom、scrollOffset、2000 行上限）。

- **活动区**（思考/工具/notice/中间输出，含 `/help` 等瞬态输出）：固定高度 = **顶部内容区（topHeight，无独立顶部边框行）除以 `activityHeightDivisor`（默认 2 = 1/2）**（`activityH = ⌊contentTopH/activityDivisor⌋`，至少 1 行，不随内容变化）；长内容（如 `/help`）超出窗口时默认仅显示最近 `activityH` 行。内容（思考/工具/notice/中间输出）**按时间顺序混合显示、不做类型分组**；`wrapBufferLines` 按 `BufferLine.final` 分流——只有回合结束（turn-end）标 final 的最终总结进历史区，其余 assistant 中间输出与思考/工具一样留在活动区瞬态显示。滚动并入「顶部三面板统一焦点滚动」：焦点在「流输出」时 ↑/↓ 行滚动、PgUp/PgDn 整页滚动，偏移 `activityScroll`（距活动区底部行数，0=跟随最新，渲染层 clamp）。对话历史区获得剩余高度。**审批/问答/模型选择面板存在时占满活动区可视行（面板优先显示于流输出窗口，活动区瞬态行本帧让位），面板关闭后恢复瞬态显示。**

- **顶部三面板统一焦点滚动**：输入态下 `Tab` 循环选中三个顶部可折叠面板之一——**对话历史（history）/ 流输出（activity）/ 详细状态列（status）**（**默认无焦点 null：所有框线/框格灰色或空白占位；新输入/输出（内容推进：append/thinking/notice/tool/turn/compaction/jobs 等）后自动回到无焦点**；**Tab 才进入焦点循环** null→history→activity→status→history，UI 类操作不打断浏览），**Tab 仅在输入区为空时生效**（有输入在编辑时不切换，不打断输入）。焦点面板以**中性色四边框**标记（`focusFrameColor(themeId)`：dark=`white`、light=`black`，即灰→白/黑、不用彩色）：**无独立顶部边框行（标题行即屏幕最顶 rc0）**——history 顶边由标题栏下划线行**兼作**（左缘 `┌`/D 列 `┐` 亮框，标题行不在焦点窗口内）、status 顶边从标题行并排位置（rc0）D 列起 `┌`+`─`+`┐`；仍保留历史/活动区左缘常驻 1 列（`FRAME_LEFT_COLS`，`historyWidth` 相应减 1 得 `contentW`）、状态列右缘框列（`statusColWidth≥2` 时预留）——焦点在历史（左列）：顶边（下划线行）`┌`+`─`+`┐`、对话区左缘/分隔竖线 `│`、活动区分隔（实线 `─`）行两端 `┘` 各成框；焦点在流输出（左列）：活动区分隔两端 `┌`/`┐`、活动区左缘/分隔竖线 `│`、状态栏 `─`（`└`+`┴` 左段角）成框；焦点在状态（右列）：顶部（rc0 起，D 列起）`┌`+`─`+`┐`、`─`+`┴`+`┘` 右段成框。**非焦点/模态面板态：顶边与两侧框列以空白占位（不画线），内容区不重排**。hint 行不显示焦点标签（焦点以四边框亮色指示）。↑/↓ 对焦点面板行滚动、PgUp/PgDn 整页滚动（页 = 该面板当前可视行数 `dialogueH`/`activityH`/`topHeight`，经 `inputPanelHeights` 与 buildFrame 同口径计算）。偏移按各面板符号约定：history/activity 为「距底部」（上滚=+，`scrollOffset`/`activityScroll`）、status 为「距顶部」（上滚=-，`statusColumnScroll`），均由渲染层 clamp、按需取窗口渲染（history/activity 尾随最新、status 顶对齐）；`home`/`end` 仍只作用于对话历史。实现：state 追加 `focusedPanel`/`activityScroll` 与 `focus-panel-cycle`/`activity-scroll` reducer action；键位经 `focusedLineScroll`/`focusedPageScroll` 映射（index.ts）；四边框构图（标题栏下划线/rc0 顶边/右缘框列/`┐┘└┌┴` 角字、空白占位、`focusFrameColor` 中性色）+ 活动区滚动窗口在 layout.ts `buildTopRegion`/`buildStatusSeparator`/`buildFrame`。焦点面板左缘预留 1 列框格（`FRAME_LEFT_COLS`，归历史/活动区左缘，`historyWidth ≥ 2` 时启用：history 焦点画对话区行 `│`+分隔行左下角 `┘`+标题栏下划线行左角 `┌`、activity 焦点画活动区行 `│`+分隔行左上角 `┌`，否则空白占位不重排）；**中间分隔竖线（D=historyWidth 列）随焦点面板只亮其垂直边界**——status 焦点全行亮（含 rc0 顶边 `┌`）、history 焦点仅对话区行+标题栏下划线行亮（标题行保持边框色）、activity 焦点仅分隔行+活动区行亮，其余各状态回灰；**内容行按 `contentW` 补齐显示宽度后接分隔竖线**，分隔竖线恒位于 D 列、不紧贴文字末尾（状态列正文截断用 `truncateToWidth` 只切字不切断 ANSI 闭合，截后按 `statusBodyW` 补空白到定宽，右缘框列恒在屏幕右缘）。模态面板（审批/问答/模型选择/历史会话）按键优先级不变，Tab/方向键仍归面板自身；其中审批/问答/模型选择面板显示于流输出（活动区）窗口（见活动区段），历史会话面板仍在底部交互区。**活动区偏移随瞬态区生命周期重置**：`turn-begin` 清空活动区瞬态、`/cls` 清屏、会话切换替换 buffer 时 `activityScroll` 一并归零（新回合回到跟随最新；旧偏移不归零会在超出新内容可视上限时形成 ↓ 死区——按到偏移耗尽才恢复）。

- **状态区**：横向单行 `12:00:00|~/proj|main|—|—|—`（六段：时间/路径/git/模型/上下文/缓存；无标题、仅值，`|` 分隔；默认前景色，路径段染蓝；推理状态段已移除）。超宽按显示宽度截断。通用配色：边框/分隔线统一灰色，输入栏为默认前景色（不切半个 CJK；不用 emoji 避免宽度模型偏差）；纵向竖线为历史/活动区左缘框格 `│`（history/activity 焦点）与中间分隔竖线 `│`（D 列，历史区右缘/状态列左缘共用，随焦点面板只亮其垂直边界）与状态列右缘框列 `│`（status 焦点），横向分隔线——对话历史与流输出（活动区）之间用实线 `─`、状态区上方与其余窗口间横线统一用单线 `─`；**对话的 turn 之间用点更少的虚线 `╌`**（double-dash）；状态列内 goal/todo/jobs 块间保留虚线 `╌`；纵向竖线 `│`，全部 box-drawing 字形可在交叉处连成连续线。左上角 1 列左缘格（historyWidth≥2）+ 1 列右缘格（statusColWidth≥2，均非焦点时空白占位保证布局不重排），**顶部无独立边框行（标题行即最顶行）**，focus 面板以中性亮色（dark 白 / light 黑）四边成框（history 顶边用标题栏下划线行兼作、status 顶边 rc0 起），角字形随所在线段着色（`┘┐┌┴└`）。颜色经 `src/renderer/theme.ts`（内嵌 fff 的 fffdark/ffflight 两份 truecolor 调色板）解析，`AppState.themeId` 决定取色（/theme 切换并同步 Screen 基底色），见 IMPLEMENTATION.md「/theme 命令」。

- **输入区提示**：提示符两个字符。左字符 = 上次提交所用模式符号（`>` / `$` / `/`，经 `MODE_SYMBOL[lastSubmitMode]` 映射），颜色随状态（绿/黄/红）；右字符 = 当前输入模式符号（`>` 普通 / `$` shell / `/` slash，默认前景色，不着色）。`inputMode`（normal/shell/slash）经右字符 `MODE_SYMBOL` 表映射；`inputStatus`（success/running/failure）决定左字符颜色（经 `STATUS_PROMPT_COLOR` 表）；`lastSubmitMode`（提交时记录、随后回退 normal 不影响）决定左字符符号（复用 `MODE_SYMBOL` 表）；`buildFrame` 组装 `colorFor(theme, STATUS_PROMPT_COLOR[inputStatus])(MODE_SYMBOL[lastSubmitMode]) + MODE_SYMBOL[inputMode] + ' '` 作预着色 prompt 传 `renderTextInput(text, cursor, placeholder, width, promptText, promptColor?, height?)`（promptColor 省略；高度 `metrics.footerHeight`；宽度按未着色文本经 `displayWidth` 计算，ANSI 序列不计宽）。多行语义：文本按 `avail = width - promptWidth` 显示列统一换行（字符不跨行、不切半个 CJK），首行带 prompt、续行缩进 `promptWidth` 列，顶部对齐，光标行（`floor(cursorFlowCol/avail)`）超出可见窗口时按 `vshift` 整体滚动跟随，仅光标行带 `caret`。模式是为瞬态临时模式：输入框为空时按 `$`/`/` 切换并吞键（同符号幂等；`!` 为普通字符、不再是模式键），**任何提交（普通/slash/shell）后自动回退 normal**，不再有 Esc 回退；**输入框为空时按 Backspace 也从 `$`/`/` 回退 normal**（切了模式不输入可反悔）。状态颜色 3 态直接映射 `inputStatus`：正常提交置 `running`，`agent-status` 的 thinking/tool 兜底置 `running`，`turn-end` 置 `success`，本地可检测的无效 slash 命令置 `failure`；**活跃守卫**——`agentStatus` 非 idle 时绿/红结果一律压回黄，仅空闲后可见。按键：Esc 打断运行（agent 非 idle 时调 `adapter.interrupt()`；idle 无操作，picker 面板 Esc 仍为关闭面板，**审批弹窗打开时仅 y/n 应答、其余按键吞掉不打断**）；Enter 排队/发送；Alt+Enter（解码层 ESC CR/LF → `meta+enter`）先 `adapter.interrupt()` 再发送。占位提示固定「Type a message…」；输入区下方为独立按键提示区（1 行正常前景色，与输入区之间不画横线：`[Alt+Enter]打断并发送 · [Ctrl+L]重绘 · [/help]更多命令`（Enter/Esc 与面板焦点标签已隐藏，窄终端按显示宽度截断）；审批/问答/模型选择/历史会话面板自带按键提示，不显示该区）。

- **turn 分隔**：`turn-begin`（回合开始：App 在提交用户消息前或首条思考/正文到达时触发）→ `appendTurnSeparator` 清掉上一轮瞬态活动行并在 buffer 追加 `TURN_SEPARATOR` 横线行；`turn-end` 不画线、也不清思考——思考保留显示，至下回合 `turn-begin` 才统一清空（输出结束后不立即清空，下一轮输出前才清）。`appendStream` 遇到末行为分隔线时不合并（硬边界，下个 turn 另起一行）。

- **会话流对话式展示**：历史 buffer 使用结构化行类型。模型正文靠历史区左侧，右缘按 `assistantMaxBodyWidth`（= 宽度 - `messageGutter`）保留与用户块左缘对称的空位，与右对齐的用户输入形成左右交错的视觉（`messageGutter` 默认 4，可配置）；用户消息由 App 本地回显，渲染为**整体靠右的收缩块**——先按 `userMaxBodyWidth`（= 宽度 - `USER_MIN_LEFT_GUTTER`）换行（含显式换行），取最大行宽作块宽，整块统一 leftPad、右缘贴历史区右缘，块内文本左对齐，续行共享同一左边界。用户块与随后回答/思考之间空一行（`wrapBufferLines` 后处理，纯布局不改 state）。reasoning 流作为临时 thinking 行显示，左侧紫色粗竖线 `┃` 区分（无 [思考] 前缀文字，色区于浅蓝回复/浅红输入）；**思考不再单独折叠/保留最新几行，与工具/notice/中间输出一起按时间混合显示在活动区**，活动区按可视高度 `activityH` 截断、可上滚回看（`thinkingMaxLines` 配置已移除）；正文（历史区）到达不清思考（思考/正文分属活动区/历史区两窗口）；turn-end 后思考保留显示，至下回合 turn-begin 才清空（非 final 中间输出同被清空），不提供展开/收起交互。**每回合只有最后一段连续 assistant 输出（final 总结）进入历史区**：turn-end 调 `markFinalSummary` 标 `BufferLine.final`，历史区/活动区渲染据此分流；`surfaceToBuffer` 恢复的历史 assistant 行同样标 final。模型正文支持终端 markdown 子集（只作用于最终回答，思考不经 markdown）：行内粗体/斜体/`***粗斜***`（同段粗+斜）/删除线(`~~`)/下划线(`__`)/代码（主题专用灰底 `CODE_BG`：暗色深灰、浅色浅灰）/链接与自动链接（蓝下划线）/图片（`[alt]`+URL 占位）/反斜杠转义（标点按普通文本，不触发样式）。块级 fenced 代码块（`wrapBufferLines` 维护 `inFence` 跨行状态，块内原样不解析，整行灰底补齐到内容区宽、语言标签斜体（正常前景色））、标题（青粗体）、引用（单层竖线前缀、正文正常前景不加斜、正文开头残留 `>` 隐藏，不做嵌套）、任务列表（`[ ]`/`[x]` 均正常前景色、已完成 `[x]` 正文删除线）、无序列表统一 `•`、有序列表保留数字、分隔线（灰横线）。解析全部在布局层（`parseInlineMarkdown(text, themeId)` → `wrapSegments` 按显示宽度换行 → 序列化 manual ANSI），buffer 只存纯文本；样式段跨软换行每行独立开关，ANSI 转义不参与宽度计算、截断透传不切断。上标/下标（`^`/`~`）与嵌套格式暂不实现。

- **用户提问面板**：模型调用 `ask_user_question` 时，DSH 经 `user-questions` 服务询问用户——TUI 经 `runtime.on("user-questions/request", answerer)` 注册 waterfall 应答者接收，归一化为 `DshEvent {type:'question'; id; questions[]}`，于顶部流输出（活动区）窗口弹「第 n/m 题」问答面板（`QuestionPrompt.ts` 纯函数；不占底部交互区，见高度分配段）。数据模型对齐官方 `AskUserQuestionItem`（id/question/header/detail/options/multiSelect/intent.kind='plan-review'）。多题一次 ask 整批回答（`{answers:[{id, selected[], custom?}]}`，空回答照交、agent 自适）：单题视图 + 第 n/m 导航，**Enter 非末题进下一题、末题提交**。**「自定义回答」是固定在选项列表末位的兜底项**（无预设选项时列表仅此一项），与普通选项一样用 ↑/↓ 高亮，高亮在其上时键入字符即输入自由文本（空格输入空格、退格删末字、可即时回显修改）；单选时预设与自定义互斥（选预设清空已输入文本），多选二者并存。**底部操作提示只显示实际用到的按键**：Enter 文案区分「下一题/提交」、多题才显示「[←/→]切题」、有预设选项才显示「[空格]选择」与「[↑/↓]选项」。选项标记纯 ASCII：光标列 `>`/空格 + 选中列 `*`（单选）/`+`（多选）/空格（未选中对齐）。`plan-review` intent 以「计划卡片」呈现 detail、标题「计划审批」。Esc 仅 `cancelQuestion()`（reject ask，绝不 interrupt）。

- **会话切换 + 标题 + 复制（会话生命周期）**：`/session` 面板列出持久化会话（newest-first，live 标记 `[当前]` 不可续），Enter 对 persisted 会话执行 `adapter.resumeTo(id)` → host `agents.resume({resumeSessionId, agentOptions, setup})` 加载旧会话继续对话；单活跃会话设计——**先切活跃引用再释放旧 handle**（旧 handle 失败不阻断切换），切换后 buffer 展示该会话 surface（user/assistant 行），标题 `deriveTitle`（首条 user 前 30 字符，无消息 `（新会话）`）显示于状态栏（\<24 列窄屏省略）；`/copy` 取最后一条 assistant 正文经 OSC52（`ESC ]52;c;<base64>BEL`）写入系统剪贴板。resume 失败进面板 error 态不崩溃；resume 链 virtual（adapter 可选方法，宿主无 `agents.resume` 时提示不可用）。状态机沿用 history panel 五阶段 + 新增 `resuming`，async 结果带 id 匹配 stale guard。

- **历史会话面板**：`/session` 打开会话面板，list 阶段由只读浏览为**切换到 persisted 会话**（只读 view 代码保留）。数据源为宿主 `ctx.get("sessionQuery")`（`@deepseek-ai/dsh-session-query` 引擎，d-base profile 已挂载；`main.ts` 注入 `createRealDshAdapter({sessionQuery, sessions})`——`sessions` 为 `ctx.get("sessions")` 会话存储服务，**不塞入 DshRuntime**；adapter 结构类型 `SessionQueryLike` 需 `listSessions()`，读取面为 `readSession?`/`readSurface?` 其一）。adapter 暴露两个**可选**方法 `listSessions(): Promise<SessionInfo[]>`（header 归一化 id/createdAt/cwd/live/persisted，newest-first）与 `readSessionSurface(id): Promise<SessionSurfaceView>`。**读取顺序（按 live/persisted 区分，实测验证）**：① live 会话（在 `sessions.get(id)` 内存 store 中）→ 直接读原始事件 `events`（`Session.events` 不包含 `surfaceOp`，`readSurface` 的 surface fold 会滤光；且其混合日志含 `agent/inbox/spliced` 未 identified 事件，`readSession` 的 `Session.create` 全量校验会抛 `seed user/message ... lacks an identified message`，两条接口对 live 均不可用）；② persisted 会话 → `readSurface`（持久化时已补 `surfaceOp` 标记，surface fold 正常）；③ 兜底 `readSession`；④ 皆缺 → 抛结构化错误入 error 阶段。**归一化**：`normalizeHistoryMessages` 从原始事件提取 `HistoryMessage[]`（`{role, text}`）——兼容两种消息形态：`user/message`/`assistant/message` 的 text blocks（`reasoning`/`tool/result` v1 省略），以及**当前 dsh live 会话实际的消息形态 `agent/inbox/spliced`**（文本在 `data.inserted[].content[]`，role 取 `inserted[].role` 仅 user/assistant）。`readSurface` 必须 `sq.readSurface(id)` 直接调用（解构丢失 `this` 读 `_corpus` 报错）。`AppState.history: HistoryPanelState | null` 五阶段状态机：`loading-list → list ⇄ loading-view → view →（Esc 返回列表）`，失败入 `error`（列表加载失败/内容加载失败）；每个 async 结果 action 带 stale guard（phase 不匹配则 no-op，防面板已关闭/已切走的迟到响应误入）。`App` 层 `openHistory()`/`openHistoryView()` 承载异步与 paint（reducer 保持纯函数）；宿主未挂载 sessionQuery 时 `/session` 显示 notice「历史会话服务不可用」不打开面板。渲染 `HistoryPanel.ts` 纯函数（无 ANSI，同 ModelPicker 风格）：标题行 + 正文区占满固定交互区，列表行 `> MM-DD HH:mm  <8位短id>  .../cwd  [当前]`（live 标记、cwd 尾部按显示宽度截取、焦点行 `>` 前缀、视口滚动保证焦点可见），view 消息行 `问:`/`答:` 前缀 + 换行缩进 + 消息间空行，**无可提取文本（空会话/live 未落 assistant）时显示占位提示**；按键路由（`handleKey`，优先级 approval > question > picker > history）：list 阶段 ↑/↓ 移动、Enter 查看、Esc 关闭；view 阶段 ↑/↓ 滚动 ±1、PgUp/PgDn ±10、Esc 返回列表（records/index 保留、messages 清空）；loading/error 阶段吞键（error 可 Esc 关闭）。损坏会话（sqlite 校验失败）的 `readSurface` 结构化错误透传到 error 阶段显示。

### 状态区数据流

`StatusTicker`（`status.ts`）以固定间隔 tick，**一次 tick 内合并查询 cwd/git/time**（不重复 fork 子进程），聚合为单个 `Partial<SystemStatus>` 经 `{type:"status"}` reducer 更新。模型/上下文长度/缓存命中率无数据源，保持占位 `—`。queries 与 schedule 均可注入（测试断言调用次数）；真实实现：`process.cwd()` + `git status --porcelain --branch`（execFile，1.5s 超时，失败回 `—`）。

## DSH 集成配置（主题与流式显示）

- 展示类配置在 `apply()` 配置边界由 `normalizeTuiDisplayConfig` 一次性归一化（非法值告警回退默认），经 `main()` → `App` → `initialState` 下传，app 内不再校验：
  - `streamTypewriter`（默认 true）：思考打字机总开关；false 恢复原速（思考与正文均即时）。
  - `streamCharsPerSecond`（默认 120，域 1..2000）：思考打字机流速；收到正文后剩余思考自动加速到 200 字符/秒放完再铺正文，**每个 turn 结束后回落初始速度**；按码点切分不拆 emoji；低速用分数累计保证逐字输出。正文回复本身不受限速（即时显示）。
  - `messageGutter`（默认 4，域 0..20）：用户块左缘/回复右缘对称留空列数（交错布局；0 表示右缘顶满）。
- theme（`dark|light`）由配置注入、`/theme` 会话内切换不落盘（见 IMPLEMENTATION「/theme 命令」）。
- `toolBootstrap`（默认 true）：锚定工具引导总开关（见上文「锚定工具引导」），非行为展示类配置，在 `apply()` 直接读 `config.toolBootstrap` 透传给 `installToolBootstrap`，不参与 display 归一化。

## 锚定工具引导（两阶段工具锁定-释放）

完整移植 dsh-anchored-standard（v2，MIT）的机制到 TUI 持有的 agent：

- **目的**：V4 Pro 的能力上限由**首个 API 请求**所见内容决定——首请求用小而任务匹配的认知开局（2-3 工具 + 单一 persona），首次 durable `tool/call` 后解锁全量工具目录，使推理轨迹锚定在任务匹配的支架上（参考评估 98/99 vs 全量 91/92）。
- **门控**：仅 `deepseek-v4-pro`（`isV4ProModel`，deepseek-v4 系含 pro 的 model id）应用；flash 与非 deepseek 模型、`toolBootstrap: false`、自定义门控不命中时，`system-prompt/assemble` 原样透传（零改动）。
- **状态机**（按会话，resume-safe）：任务模式由**首个真实 user 消息**分类（spec/react/weak），文本在 `agent/inbox/inserted` 捕获（严格早于首组装事件）、`agent/pre-step` 兜底；promotion 由会话 events 含 `tool/call` 派生，进程内 Set 记忆（append-only）。
- **首请求**：persona-only section（anchored-persona，order 0）、contexts 清空、工具目录过滤到 core（spec=bash+read+edit / react=bash+read+write / weak=bash+read；glob/grep 永不进入，参考测量轨迹边界）。
- **解锁后**：全量工具目录 + 完整 prompt sections（plan-mode 等回归）、persona 恒定、contexts 保持清空。
- **健壮性（fail-open）**：缺失 shell、过滤器内部异常一律降级全量目录并 warnOnce；logger 经窄化访问（cordis 严格模式）；解绑函数与 `installSessionModelSelection` 同构（setup 内 void 丢弃）。
- **接入点**：`main.ts` setup 中与 `installSessionModelSelection` 并列挂 `installToolBootstrap(agentCtx, { enabled })`，同一条 `system-prompt/assemble` waterfall，顺序无关可共存。

## 流式滚屏（scrollback）行为

状态模型持有无界 text buffer；`layout.ts` 负责切分 viewport：

- 长行按终端列宽软换行（wrapping），视口 = 行数裁剪后的可见窗口
- scrollback 上限：buffer 超过 2000 行裁剪旧行（`ponytail:` 固定上限，需要时再做持久滚动/搜索）
- 新文本到达时跟随底部；用户上滚时暂停跟随，按 up/down/PageUp/PageDown 移动视口
- 真实链路（`slowStream`）下 reasoning 经打字机队列按 tick 逐段 append（初始约 120 字符/秒；收到正文 `stream` 事件后剩余思考自动加速到 200 字符/秒放完，turn 结束回落到初始速度）；正文回复为最终保留内容，即时显示——思考队列运行期间到达的正文段按序缓冲，思考放完后一次性铺出；turn 结束仅清思考（思考打字机运行中等其放完再执行，不打断读取）；分隔线改由下个回合 `turn-begin` 时画；mock demo 不经过该队列保持原速

## 信号与退出契约

- `terminal.ts`（renderer 内）负责 raw mode 开/关与终端恢复，对所有退出路径生效：正常 `close()`、SIGINT/SIGTERM、`uncaughtException`/`unhandledRejection`
- 退出生命周期归 renderer 拥有；app 只在 renderer 分发的事件里做自己的清理

## 构建与运行

- 构建：`tsc`（无 bundler，Node CLI 无需打包），`outDir: dist/`，ESM
- bin：`bin/dsh-tui.js` = shebang + `import('../dist/main.js')`，`package.json.bin` 指向它
- demo：`npm run demo` → tsc 后 `node dist/demo/main.js`；`npm run demo -- --smoke` 冒烟（帧断言 SMOKE_PASS）；`npm run smoke:pty` 真实 DSH PTY 冒烟

## 事件接入与渲染（当前状态）

对照官方 `deepseek-harness` dsh-v0.1.5-rc.2（= 本机安装宿主）：8 个插件可消费服务（sessions / agents / approval / userQuestions / llm / commands / sessionQuery / agentDefaultModel）已全部接入；事件词汇表以该 tag 的 `packages/core/session/src/known-event-types.ts` 为准（53 项）。已接入能力按域如下：

- **工具与用量域**：`tool/call` + `tool/result` 紧凑 buffer 行（编码代理 TUI 的第一可见性）；usage 状态栏槽位（usage chunk 已解析，零新事件）；`finish` reason 挂 turn-end notice（截断/失败不再静默）；`compaction/start` + `compaction/end` toast；`llm/retry` + `llm/retry-started` 重试透明化。
- **状态域**：`goal/change`、`todo/write` 顶部状态列详显（`/goal` 输入仅 notice 提示「详情见右侧信息栏」，不打开面板）；`plan/mode`、`sandbox/mode`、`permission/preset`、审批策略、agent 预设 → 状态列 Mode 块；`step/start`|`end` turn 内分步；`subagent/descriptor` 子代理行；`compaction/summary` 摘要 toast。
- **生态域**：`tool-workflow/*`（workflow 行 ⚑/⤷/↩ + 结束 toast）、`command/run`|`done`（执行流：run 灰行、成功 done 静默、失败红行 ✗）、`tool/ptc-dispatch*`（start 行 ⇥，settle 成功静默/失败红行）、`hook/*`（invoked 灰行 ⌗ / result 成败着色）、`schedule/change`（仅 dispatch 到点 toast，create/delete 静默）、`feedback/record`（确认 toast）、`compaction/prune`（剪除计数 toast）。接入均为 append-only 活动区行/notice，不引入配对状态。
- **命令域**：`/permission`（预设目录 + slash 写路径——无参列当前值 + 可用预设表，经 `ctx.permissionPresets.names/current` 读；带参转发宿主命令，宿主校验 + `permission/preset`+`approval/policy` 写路径；宿主未挂载 → notice「权限预设服务不可用」）；`/preset`（`agent-preset/selected` 归一化为 DshEvent → reducer `presetBySession` 按 sessionId 隔离 latest-wins + 状态栏徽标 `preset:<id>`；无参从 `ctx.agentPresets` 读目录列当前/可用/默认，带参调用 `selectAgentPreset`（宿主 `AgentPresets.recompose(agentCtx, id)` 写路径，agentCtx 宽松取自 agent handle 的 ctx）；宿主未挂载/未暴露 → notice「agent 预设服务不可用」（fail-safe））；`/policy`（审批策略 ask/never 两态切换 + 当前策略展示：`approval/policy` 归一化为 DshEvent `approval-policy`，state `policyBySession` 隔离，状态栏第 4 槽位 `ask`/`auto` 徽标；`ctx.approval.setPolicy(agent, ask|never)` 写路径，宿主缺失 notice 兜底）；`/compact`、`/feedback` 为宿主自带命令（dsh-base 默认装配，经 `ctx.commands.register` 注册），TUI 无本地路由、走 registry 转发即用，无需额外代码。
- **后台任务**：`/jobs` 面板。宿主 `JobRegistry` 有 `onJobsChanged` 观察者（任一 commit 变化即通知，非裸轮询），dsh-base 默认装配 `dsh-jobs-local`（ctx.jobs 可用）。adapter 订阅 `onJobsChanged` → 推送全量快照 `jobs-changed`（`JobSnapshot` 子集 id/kind/label/status/detail，宽松读取）；`/jobs` 打开面板 + `refreshJobs` 主动拉取一次；面板展示任务状态行（running/stopping 黄 ●、failed/error 红 ✗、cancelled 灰 ○、其余默认）、高亮行 `>` 恒在窗口内、`Enter` 调 `killJob`（`ctx.jobs.kill`）取消高亮任务、`Esc` 关闭；状态栏 `jobs N` 徽标仅显示运行中计数；顶部状态列含 jobs 块。仅只读展示 + cancel，不做 job 创建/参数 UI。**caller 语义（jobs-local 实测）**：`list(caller)`/`kill(id, caller)` 为 owner-relative——`list` 只读 `caller.id` 与 `job.owner.id` 匹配，缺 caller 仅返回 unowned（当前会话任务不可见）；故 `refreshJobs`/订阅回调/`killJob` 都显式传 `{ id: activeSessionId }`（当前会话 owner 的任务才可见/可取消，宿主未挂载 jobs 服务时 refreshJobs reject、不假成功）。**会话待机守卫（App 侧兜底）**：`agent-preset`/`jobs-changed` 在 App 事件层再按 `activeSessionId` 过滤（非活跃会话丢弃——adapter 已过滤，双重防线供直接 push 断言与切会话迟到事件防护）；面板关闭后迟到的 `jobs-changed` 只更新 jobs 状态、不重开面板。
- **装配证据**：rc.2 bundle 默认装配（`bundle/base/cordis.patch.yml`）含 command-compact / command-feedback / jobs-local / permission-presets / tool-jobs；**`agent-presets` 服务不在默认装配**——装配了该服务的环境 `/preset` 目录/切换可用，未装配时提示「agent 预设服务不可用」（fail-safe 正常路径）。

### 核心事件映射（rc.2 载荷 → TUI DshEvent → 渲染）

| rc.2 事件（载荷已核实） | 新 DshEvent | 渲染 |
| --- | --- | --- |
| `tool/call` `{turn, step, callId, name, arguments: string}` | `tool-call` `{sessionId, name, summary}` | buffer 行 `<name> <summary>`（无图标前缀；summary = arguments JSON 关键字段启发式提取，截断一行） |
| `tool/result` `{message, error?: {name, code}, meta?}` | `tool-result` `{sessionId, ok, detail}` | buffer 行 `✓ <detail 首行截断>`；错误 `✗ <error.name>: <message>`（红色） |
| `assistant/message` 的 `usage?: TokenUsage` | `usage` `{sessionId, input, output, cacheRead}` | 状态栏槽位 `ctx 12.4k` + `cache 92%`（最新一次请求为准，不累计） |
| `turn/end` 的 `reason`（completed/aborted/blocked/error/max-tokens/interrupted） | 现有 `notice` 增加可选 `tone` 字段 | error → 红 `✗ <code>: <message>`；max-tokens → 黄「输出达 token 上限」；blocked → 黄「已阻塞（等待审批）」；aborted → 蓝「已取消」；interrupted → 蓝「已中断」；completed 静默 |
| `compaction/start` + `compaction/end` `{compactionId, sourceCommandId?}` | `compaction` `{phase}` | notice toast："正在压缩上下文…" / "压缩完成" |
| `llm/retry` `{retry, maxRetries, delayMs, failure: {code, message}, provider}` | `retry` `{attempt, max, delayMs, code, message?}` | notice toast："重试 1/2 (1.5s): TRANSPORT 连接被重置"；`llm/retry-started` 为 ↻ 启动灰行，与 retry toast 互补 |

### 状态事件映射（rc.2 载荷 → TUI DshEvent → 渲染）

| rc.2 事件（载荷已核实） | 新 DshEvent（判别联合） | 渲染 |
| --- | --- | --- |
| `goal/change`（operation: create/edit/pause/resume/complete/block 携带 GoalSnapshot{id,revision,objective,phase(active/paused/blocked/complete),blockedReason?,maxGoalRounds}+roundsStarted/createdAt/updatedAt；operation: clear 携带 cleared{id,revision}+clearedAt） | `goal-change` 判别联合：`{sessionId, operation: Exclude<…,'clear'>, goal: {id,revision,objective,phase,blockedReason?,maxGoalRounds}, roundsStarted}`；或 `{sessionId, operation:'clear', cleared: {id,revision}}` | 状态列 goal 块详显（`Goal <phase>` 标题（Goal 蓝+phase 状态色）、objective、blocked 显示 blockedReason.message 黄 tone）；clear：状态列 goal 块省略 |
| `todo/write`（{todos: TodoItem[]}；TodoItem {content, status: pending/in_progress/completed}，全量快照 last-write-wins） | `todo-write {sessionId, todos}` | 状态列 todo 块（标题 `Todo 完成数/总数` 蓝 + 列表 `○`待办(默认)/`●`进行中(黄)/`✓`完成(灰+删除线) + content） |
| `plan/mode`（{active: boolean}） | `mode {sessionId, kind:'plan', value}` | Mode 块 `plan off/on`，生效项青色强调 |
| `sandbox/mode`（{mode: read-only/workspace-write/danger-full-access, source?}） | `mode {sessionId, kind:'sandbox', value}` | Mode 块 `sandbox ro/wr/full`，生效项按危险等级着色 |
| `permission/preset`（{preset: string}，默认表键 workspace-write/danger-full-access，配置可增） | `mode {sessionId, kind:'permission', value}` | Mode 块 permission 项（实际目录列出可选值） |
| `step/start`（{turn, step}） | `step {sessionId, turn, step, phase:'start'}` | 工具行分组头 `step N`（仅该 step 首个工具调用时渲染） |
| `step/end`（{turn, step}） | `step {sessionId, turn, step, phase:'end'}` | 关闭当前工具组（无独立渲染） |
| `subagent/descriptor`（{version, mode: one-shot/continuable, provider, label?, agentProvider?, agentModel?, persona?, toolFilter?}） | `subagent {sessionId, label, mode}` | buffer 行 `@ <label> <os/ct>`（无 label 回落 provider；one-shot→os / continuable→ct），append-only |
| `compaction/summary`（{compactionId, summary: ContentBlock[], shadowedSeqs[], shadowedTokenCount, provider, model, usage?}；紧随其后 user/message 作阴影替换） | `compaction-summary {sessionId, text, raw}`（raw: CompactionSummaryPayload 完整原始载荷） | **仅 toast**：`压缩完成：<text 首行>`（notice tone 默认）；UI 只消费 `text`；reducer 将 `raw` 存入 `state.compactionBySession[sessionId]`（每会话仅最新一条；不改写、不裁剪；不写持久 buffer） |

### 渲染语义（已定规则）

- **goal**：DshEvent 为判别联合（见事件映射）；state 侧**按 sessionId 隔离**（`state.goalBySession[sessionId]`），同样用判别联合并**完整保留原始载荷字段**：非 clear `{status:'set', operation, goal: GoalSnapshot(含 id/revision/objective/phase/blockedReason?/maxGoalRounds), roundsStarted, createdAt, updatedAt}`；clear `{status:'cleared', operation:'clear', cleared: GoalRef, clearedAt}`（**不丢弃 operation、maxGoalRounds、时间字段与 clearedAt**，UI 只取所需）；clear → 状态列 goal 块省略；非 clear → 快照全量替换（原子，无增量）；切换活跃会话读对应 sessionId 状态，杜绝旧会话泄漏。
- **todo**：每次 `todo/write` 全量替换**该会话**列表（`state.todoBySession[sessionId]`）；进行中计数 = todos.filter(status==='in_progress')；切换活跃会话读对应状态。
- **模式/策略/预设（状态列 Mode 块）**：状态按 sessionId 隔离（`state.modeBySession[sessionId]` / `policyBySession` / `presetBySession`）。**各项目以竖线 `|` 分隔连续排布（同水平状态栏段间分隔），放不下才折行且折行处不加竖线**，每项目列出全部可选项：`plan off on`、`sandbox ro wr full`、`policy ask auto`；**permission 与 preset 按实际目录列出可选值**——权限预设目录（`ctx.permissionPresets.names`）与 agent 预设目录（`ctx.agentPresets.list` id）经 `permission-catalog`/`agent-preset-catalog` 事件同步进 state（start 与 /permission、/preset 命令时刷新；目录未同步时降级标准三档/仅当前值）；目录不含当前生效值时把该值补入列表末尾并高亮。**属性名用默认前景色、只有未生效的属性值才用灰色**（Mode 内容行自带 ANSI，不再被外层灰二次包裹）；生效项着色强调——标准三档按危险等级 ro 绿/wr 黄/full 红，目录外自定义值（如 custom）用洋红——plan 生效=青；sandbox/permission 生效按危险等级 ro 绿（只读安全）/ wr 黄（可写中危）/ full 红（全访问高危）；policy 生效 ask 绿（人工把关）/ `auto`（never）红（自动放行）；preset 洋红。sandbox 与 permission 各自独立列出。**Mode 块与 Goal 块之间以虚线分隔**（有 Mode 且有 goal 时）。窄列放不下时内容溢出折行（竖线留在上一项目尾），单项目超宽仍走截断（与状态列其余内容一致）。无 mode/policy/preset 数据时 Mode 块整块省略。
- **step**：P1 工具组按 callId 配对刷新；`step/start` 到来且当前有活动工具组时先 flush 该组并另起分组头 `step N`；无工具调用的 step 不产生任何输出；`step/end` 只关闭分组状态。
- **subagent**：append-only 不配对不折叠；不在行内展示 persona/toolFilter。
- **compaction/summary**：只取首个非空文本块首行入 toast；空摘要（无文本块）→「压缩完成（无摘要）」；DshEvent 携带 `text` 与 `raw`（完整原始载荷），reducer 存入 `state.compactionBySession[sessionId] = {raw: CompactionSummaryPayload, text}`——**每会话仅保留最近一条，不无限累积**；raw 不改写、不裁剪、不进入对话 buffer；UI 仅消费 `text`。

### seq 守卫（事件序列约束，测试断言覆盖）

- adapter/state 为每个 session 记录 `lastSeq`：`event.seq <= lastSeq` → 丢弃（防重复/倒序重放）；`event.seq > lastSeq + 1` → 只是间隙（宿主用 session/end-seed 标识 seed 边界，TUI 不做补缺，直接接受并更新游标）。
- 非当前活跃会话的事件：丢弃，不进入 state。
- 验证契约含具体断言：同 seq 重复丢弃、seq 倒序丢弃、间隙接受、非当前 sessionId 丢弃（各至少 1 条）。

### 审批对（未接入，通路已设计）

- **角色澄清**：`approval/request` 是瀑布应答链（机制，TUI 已接——`approvalAnswerer` 弹请求、返回 ApprovalOutcome 即裁定）；`approval/asked`+`decided` 是同段写日志（log-only 审计，`user-approval/src/index.ts` append，同 id 恰好一 asked 一 decided，decided 失败则 Promise 拒绝）。**当前 TUI 唯一审批界面 = 弹窗（approval/request 驱动）；审计对无任何界面**。
- **界面 vs 数据**：界面不需审计对（弹窗 + tool/result 行已覆盖）；只有「事后回溯」场景（事故复盘 / 审批问题诊断 / ask-never 策略调优）才需要审计时间线。
- **持久化不丢**：审计对随 `session.append` 入会话事件流，整流落 sqlite（`session-persistence-sqlite` `packChunkRuns`/`loadStored`），resume 后完整恢复——数据层不丢，丢的是展示入口。
- **readSurface vs readSession**：`readSurface`（persisted 会话）做 surface fold，仅保留 user/message、assistant/message、tool/result（`surface.ts` SURFACE_EVENT_TYPES）——审计对**必然不含**；`readSession` 返回全量原始事件（经 `Session.create` 全量校验，混合日志会抛校验错）。TUI 历史面板用 readSurface 是「对话视图」语义对口；审批历史必须另走 readSession。
- **通路设计（未实现，仅记录）**：`/approvals` 只读面板 + adapter 新增 `readApprovalHistory?()`（走 `readSession` 全量 → 过滤 asked/decided → 按 id 配对，无 decided 孤儿记 pending → 按 seq 升序）。实时审批不回放（弹窗已覆盖），历史静态重放不做实时订阅。坑：readSession 全量校验在混合日志/live 会话抛错 → 抓错进 error 态提示「会话日志不完整」，不崩面板。落点：types.ts ApprovalRecord + 签名、dsh.ts 归一化、index.ts /approvals 路由 + 面板态、纯渲染组件、tests（配对/孤儿/校验错分支）。
- **触发时机**（出现任一再做，当前 deferred）：安全事故复盘、审批问题诊断（asked 有无 / decided 超时 vs rejected）、ask/never 策略调优（批准率）、多会话事后审计。

## 规划与边界

- **待做**：
  - **session fork（`sessions.fork`）→ 下个功能批次**。
  - **tool `meta` diff 展示（+N/-M）**——用户确认做（复用 `tool/result.meta` 工具私有展示载荷）。
  - **`model/selection` 模型切换回放与 TUI `/model` 联动**——下个功能批次（0.1.2 起进正式词汇表，见下）。
- **明确不做**：多会话并行（维持单活跃会话设计边界）；thinking 展开/收起（用户偏好）。
- **deferred（已评估暂缓，非缺失）**：feedback 评价（低频）；嵌套 markdown、上下标（低频）；`compaction/summary` 持久化（若后续要可读历史 /inspect 类，另立条目）；`session/end-seed`、`session/title-llm-request`、`request/header`、`request/context`（低价值调试向事件且 request/\* payload 结构复杂，接显示收益低于解析风险，待调试视图需求出现再做）；`team/*`（实验包依赖）；`web/deepseek-search-llm-request`（log-only，调试视图再做）；审批审计对（见上「触发时机」）。
- **0.1.2 起新增事件（已进 0.1.5-rc.2 词汇表；TUI 未接入渲染，评估后决定）**：
  - `model/selection` — 官方模型切换回放（排期：下个功能批次与 TUI /model 联动）
  - `subagent/model-selection-policy` — 子代理模型策略（低频）
  - `session-log-deepseek/delivery-accepted` — 内部日志交付确认（log-only，无需界面）
