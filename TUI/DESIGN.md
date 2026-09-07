# DSH TUI 插件设计与文件结构

## 项目目标

为 DeepSeek Harness（DSH）开发一个轻量级、高性能的终端用户界面插件，作为进程内集成的交互前端，通过复用 DSH 核心服务（会话管理、Agent 驱动、工具调用等），提供 Web UI 和 CLI 之外的另一种交互方式。

## 技术选型

- 语言：TypeScript（与 DSH 核心一致）
- 运行时：Node.js
- 包管理：npm（开发脚本）；发布验证历史上使用 pnpm
- 依赖：chalk（ANSI 颜色控制）
- 可选依赖：node-pty（已评估，暂不引入；除非 TUI 需直接开 shell，否则会话由 DSH 管理）

关键决策：不采用 Ink / Solid-TUI 等成熟框架，自研极简渲染层。
理由：针对 DSH 特定交互模式（流式输出、工具审批）优化；框架代码量小，
维护成本可控；对渲染和输入事件拥有完全控制力。

### 评审记录（2026-08 | 自研渲染层）

- 流式输出本质是"增量文本追加 + 偶尔整帧重绘"，human-speed 交互下整帧重绘足够。
- 砍掉：帧 diff、组件树、布局引擎。渲染核心约 150 行。
- 输入解码是隐藏大头：需手写 ANSI 转义序列解析（方向键、Home/End、Ctrl 组合、bracketed paste）。node 无 stdlib 键盘解析，这是自研 vs 用 Ink 的真正代价。
- node-pty 是原生二进制，暂不引入。
- 自研渲染层约 150 行验证可行（阶段 1 已实现并审计通过）。
- DSH 适配层（"通过 ctx 订阅会话事件、驱动 Agent"）接口风险已解除：改以**官方源码研读**（`~/GithubRepos/deepseek-harness`，b150a551b8 = dsh-0.1.1-rc.2）确认接口形状，沉淀于仓库根 `DSH-CTX-API.md`。确认结果：
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
  state.ts       # 状态模型：会话列表、流式文本增量、审批项、系统状态区、turn 分隔（拆分后未动）
  layout.ts      # 四区域帧：顶部(状态列+历史) / 状态区 / 输入行 / 审批弹窗；保留宽度/viewport/buildFrame
  layout/
    markdown.ts   # 宽度原语 + markdown 行内/块级纯解析（2026-08-31 从 layout.ts 拆出）
  status.ts      # 系统状态区数据源：StatusTicker 合并节流读取 cwd/git/time
  commands.ts    # 纯函数：模型目录格式化/规格解析 + slash 路由/决策（2026-08-31 拆出）
  question-transition.ts  # 问答纯状态转换（2026-08-31 拆出）
  model-transition.ts     # 模型选择纯状态转换（2026-08-31 拆出）
  components/    # TextInput、ScrollView（历史区）、ApprovalPrompt、QuestionPrompt、ModelPicker（纯渲染）
  adapter/
    dsh.ts       # ctx 订阅 → 写入 state；审批/发消息 → 回调 DSH；保留 installSessionModelSelection + createRealDshAdapter；历史会话表面归一化（sessionQuery → SessionInfo/HistoryMessage）
    types.ts     # 29 个纯类型（2026-08-31 从 dsh.ts 拆出）
    normalize.ts # 5 个纯归一化函数（2026-08-31 从 dsh.ts 拆出）
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

屏幕自上而下切分为：**顶部区域**（左侧对话历史，历史下方为活动区；右侧详细状态列，2026-09-17 两列对调）、**系统状态区**（按宽度可溢出多行）、**输入区**（含审批弹窗形态）：

- **高度分配**：顶部高度 = `rows - 状态区(1) - 输入区 - 提示区(1) - 分隔行(2)`。输入区+提示区为「交互区」：常规终端固定 4 行（输入框 3 + 提示 1），矮终端按 `floor(rows/5)` 收缩、至少 2 行（输入 1 + 提示 1）；提示区固定 1 行、与输入区之间不画横线，输入区取剩余（多行框）；模态交互面板（审批/问答/模型选择，2026-09-17 起）显示于顶部流输出（活动区）窗口、底部交互区以空白占位，与输入态同高——面板开关不上下调整交互区高度；历史/任务等浏览面板仍占据底部交互区（面板自带最底行按键提示、无独立提示区）；面板内容超出时面板内截断/滚动（问答选项按高亮行滚动窗口、选择列省略号滚动、审批正文截断）；「中间与底部满足显示需要，剩余高度全部由上方两个填充」；`buildFrame` 输出顺序为 顶部区 → 横线分隔行 → 状态区 → 横线分隔行 → 输入区 → 按键提示区。

- **顶部状态列**（2026-09-13；2026-09-17 对调至最右侧）：最右侧常驻一列「详细状态」窄列（`statusColWidth ≈ cols×25%`，左缘即分隔竖线 `│`（与历史区右缘共用），历史区保底 10 列），与左侧历史区在同一行：显示当前活跃会话的 **goal 详细**（goal 块首行标题 `Goal <phase>`（Goal 蓝 + phase 状态色：active/complete 绿、paused 黄、blocked 红）+ objective（无「目标」前缀）+ 阻塞原因黄 tone）+ **todo 块**（标题 `Todo 完成数/总数`（蓝）+ 列表：`○` 待办(空心圆) / `●` 进行中(实心圆、黄、换行保留色且续行缩进对齐) / `✓` 完成(对号灰不划线、正文灰+删除线)）+ **jobs 块**（标题 `Jobs 运行中/总数`（蓝）+ 任务行：`●` 运行中(黄) / `✗` 失败(红) / `○` 取消(灰) / `✓` 已完成(正文灰+删除线，与 todo 一致)）。**条目行数上限**：goal 目标最多 `STATUS_GOAL_MAX_LINES=5` 行、每条 todo 最多 `STATUS_TODO_MAX_LINES=3` 行，超限折叠为 `…(+N行)` 提示行；无 goal/todo 显示灰色占位「（无目标/待办）」。滚动并入「顶部三面板统一焦点滚动」：仅当 Tab 焦点在「状态」面板时响应 ↑/↓/PgUp/PgDn（非焦点下不干扰其他面板滚动）。偏移由 `status-column-scroll` reducer 累积 `statusColumnScroll`（距顶部，上滚=-）、渲染层 clamp。实现 `renderStatusColumn`（layout.ts 纯函数，输出恰 height 行、每行定宽 statusColWidth 且末位竖线为分隔边线）；`buildTopRegion` 对调后剥去该竖线、自行构图：分隔竖线位于 `D=historyWidth` 列（历史区右缘/状态列左缘共用），状态列正文按 `statusBodyW=statusColWidth-2` 定宽截取并补空白。**（2026-09-17）不同块之间以点更少的虚线 `╌` 分隔**：goal 块（标题/目标/阻塞）与 todo 块（计数+列表）之间插入整行虚线，视觉分层。

- **历史区**：按 `contentW = historyWidth - FRAME_RIGHT_COLS`（右缘焦点框预留列）换行，沿用 scrollback 语义（wrapping、followBottom、scrollOffset、2000 行上限）。

- **活动区**（思考/工具/notice，含 `/help` 等瞬态输出）：固定高度 = **内容区（顶部面板总高 − 顶部边框行 1）的一半**（`activityH = ⌊(topHeight-1)/2⌋`，至少 1 行，不随内容变化）；长内容（如 `/help`）超出窗口时默认仅显示最近 `activityH` 行。滚动并入「顶部三面板统一焦点滚动」：焦点在「流输出」时 ↑/↓ 行滚动、PgUp/PgDn 整页滚动，偏移 `activityScroll`（距活动区底部行数，0=跟随最新，渲染层 clamp）。对话历史区获得剩余高度。**（2026-09-17 变更）审批/问答/模型选择面板存在时占满活动区可视行（面板优先显示于流输出窗口，活动区瞬态行本帧让位），面板关闭后恢复瞬态显示。**

- **顶部三面板统一焦点滚动**（2026-09-07）：输入态下 `Tab` 循环选中三个顶部可折叠面板之一——**对话历史（history）/ 流输出（activity）/ 详细状态列（status）**（默认焦点=历史），**Tab 仅在输入区为空时生效**（有输入在编辑时不切换，不打断输入）。焦点面板以**中性色四边框**标记（`focusFrameColor(themeId)`：dark=`white`、light=`black`，即灰→白/黑、不再用彩色）：顶部常驻 1 行（`FRAME_TOP_ROWS`）、历史/活动区左缘常驻 1 列（`FRAME_LEFT_COLS`，`historyWidth` 相应减 1 得 `contentW`）、状态列右缘框列（`statusColWidth≥2` 时预留）——焦点在历史（左列）：顶部 `┌`+`─`+`┐`、对话区左缘/分隔竖线 `│`、`╌` 分隔行两端 `┘` 各成框；焦点在流输出（左列）：`╌` 两端 `┌`/`┐`、活动区左缘/分隔竖线 `│`、状态栏 `─`（`└`+`┴` 左段角）成框；焦点在状态（右列）：顶部 `┌`+`─`+`┐`（自 D 列起）、`─`+`┴`+`┘` 右段成框。**非焦点/模态面板态：顶边与两侧框列以空白占位（不再画线），内容区不重排**。hint 行尾灰色标签 `· [面板:历史]` 仍指示当前焦点。↑/↓ 对焦点面板行滚动、PgUp/PgDn 整页滚动（页 = 该面板当前可视行数 `dialogueH`/`activityH`/`topHeight`，经 `inputPanelHeights` 与 buildFrame 同口径计算）。偏移按各面板符号约定：history/activity 为「距底部」（上滚=+，`scrollOffset`/`activityScroll`）、status 为「距顶部」（上滚=-，`statusColumnScroll`），均由渲染层 clamp、按需取窗口渲染（history/activity 尾随最新、status 顶对齐）；`home`/`end` 仍只作用于对话历史。实现：state 追加 `focusedPanel`/`activityScroll` 与 `focus-panel-cycle`/`activity-scroll` reducer action；键位经 `focusedLineScroll`/`focusedPageScroll` 映射（index.ts）；四边框构图（顶部边框行/右缘框列/`┐┘└┌┴` 角字、空白占位、`focusFrameColor` 中性色）+ 活动区滚动窗口与焦点标签在 layout.ts `buildTopRegion`/`buildStatusSeparator`/`buildFrame`。（2026-09-13 细化；2026-09-17 对调镜像）焦点面板左缘预留 1 列框格（`FRAME_LEFT_COLS`，对调后归历史/活动区左缘，`historyWidth ≥ 2` 时启用：history 焦点画对话区行 `│`+分隔行左下角 `┘`、activity 焦点画活动区行 `│`+分隔行左上角 `┌`，否则空白占位不重排）；**中间分隔竖线（D=historyWidth 列）随焦点面板只亮其垂直边界**——status 焦点全行亮、history 焦点仅对话区行亮、activity 焦点仅分隔行+活动区行亮，其余各状态回灰；**内容行按 `contentW` 补齐显示宽度后接分隔竖线**，分隔竖线恒位于 D 列、不紧贴文字末尾（状态列正文截断用 `truncateToWidth` 只切字不切断 ANSI 闭合，截后按 `statusBodyW` 补空白到定宽，右缘框列恒在屏幕右缘）。模态面板（审批/问答/模型选择/历史会话）按键优先级不变，Tab/方向键仍归面板自身；其中审批/问答/模型选择面板显示于流输出（活动区）窗口（2026-09-17 变更，见活动区段），历史会话面板仍在底部交互区。**活动区偏移随瞬态区生命周期重置**：`turn-begin` 清空活动区瞬态、`/cls` 清屏、会话切换替换 buffer 时 `activityScroll` 一并归零（新回合回到跟随最新；此前不归零，旧偏移超出新内容可视上限会形成 ↓ 死区——按到偏移耗尽才恢复）。

- **状态区**：横向单行 `12:00:00|~/proj|main|—|—|—`（六段：时间/路径/git/模型/上下文/缓存；无标题、仅值，`|` 分隔；默认前景色，路径段染蓝；推理状态段已移除）。超宽按显示宽度截断。通用配色：边框/分隔线统一灰色，输入栏为默认前景色（不切半个 CJK；不用 emoji 避免宽度模型偏差）；纵向竖线为历史/活动区左缘框格 `│`（history/activity 焦点）与中间分隔竖线 `│`（D 列，历史区右缘/状态列左缘共用，随焦点面板只亮其垂直边界）与状态列右缘框列 `│`（status 焦点），横向分隔线——对话历史与流输出（活动区）之间用 box-drawing 虚线 `╌`（2026-09-17 起用点更少的 double-dash 虚线）、状态区上方与其余横线统一用单线 `─`（2026-09-07 起由双线 `═` 改单线）；纵向竖线 `│`，全部 box-drawing 字形可在交叉处连成连续线。顶部面板区常驻 1 行顶边格 + 1 列左缘格（historyWidth≥2）+ 1 列右缘格（statusColWidth≥2，均非焦点时空白占位保证布局不重排），焦点面板以中性亮色（dark 白 / light 黑）四边成框，角字形随所在线段着色（`┘┐┌┴└`）。2026-08-28 起颜色经 `src/renderer/theme.ts`（内嵌 fff 的 fffdark/ffflight 两份 truecolor 调色板）解析，`AppState.themeId` 决定取色（/theme 切换并同步 Screen 基底色），见 IMPLEMENTATION.md「/theme 命令」。

- **输入区提示**：提示符两个字符。左字符 = 上次提交所用模式符号（`>` / `$` / `/`，经 `MODE_SYMBOL[lastSubmitMode]` 映射），颜色随状态（绿/黄/红）；右字符 = 当前输入模式符号（`>` 普通 / `$` shell / `/` slash，默认前景色，不着色）。`inputMode`（normal/shell/slash）经右字符 `MODE_SYMBOL` 表映射；`inputStatus`（success/running/failure）决定左字符颜色（经 `STATUS_PROMPT_COLOR` 表）；`lastSubmitMode`（提交时记录、随后回退 normal 不影响）决定左字符符号（复用 `MODE_SYMBOL` 表）；`buildFrame` 组装 `colorFor(theme, STATUS_PROMPT_COLOR[inputStatus])(MODE_SYMBOL[lastSubmitMode]) + MODE_SYMBOL[inputMode] + ' '` 作预着色 prompt 传 `renderTextInput(text, cursor, placeholder, width, promptText, promptColor?, height?)`（promptColor 省略；高度 `metrics.footerHeight`；宽度按未着色文本经 `displayWidth` 计算，ANSI 序列不计宽）。多行语义：文本按 `avail = width - promptWidth` 显示列统一换行（字符不跨行、不切半个 CJK），首行带 prompt、续行缩进 `promptWidth` 列，顶部对齐，光标行（`floor(cursorFlowCol/avail)`）超出可见窗口时按 `vshift` 整体滚动跟随，仅光标行带 `caret`。模式是为瞬态临时模式：输入框为空时按 `$`/`/` 切换并吞键（同符号幂等；`!` 为普通字符、不再是模式键），**任何提交（普通/slash/shell）后自动回退 normal**，不再有 Esc 回退；**输入框为空时按 Backspace 也从 `$`/`/` 回退 normal**（切了模式不输入可反悔）。状态颜色 3 态直接映射 `inputStatus`：正常提交置 `running`，`agent-status` 的 thinking/tool 兜底置 `running`，`turn-end` 置 `success`，本地可检测的无效 slash 命令置 `failure`；**活跃守卫**——`agentStatus` 非 idle 时绿/红结果一律压回黄，仅空闲后可见。按键：Esc 打断运行（agent 非 idle 时调 `adapter.interrupt()`；idle 无操作，picker 面板 Esc 仍为关闭面板，**审批弹窗打开时仅 y/n 应答、其余按键吞掉不打断**）；Enter 排队/发送；Alt+Enter（解码层 ESC CR/LF → `meta+enter`）先 `adapter.interrupt()` 再发送。占位提示固定「Type a message…」；输入区下方为独立按键提示区（1 行灰色，与输入区之间不画横线：`[Enter]发送 · [Alt+Enter]打断并发送 · [Esc]打断 · [Ctrl+L]重绘 · [/help]更多命令`，末尾附当前面板焦点标签 `· [面板:历史/流输出/状态]`，均窄终端按显示宽度截断；审批/问答/模型选择/历史会话面板自带按键提示，不显示该区）。

- **turn 分隔**：`turn-begin`（回合开始：App 在提交用户消息前或首条思考/正文到达时触发）→ `appendTurnSeparator` 往 buffer 追加 `TURN_SEPARATOR` 横线行；`turn-end` 仅清遗留思考、不再画线。`appendStream` 遇到末行为分隔线时不合并（硬边界，下个 turn 另起一行）。

- **会话流对话式展示**（2026-08-27）：历史 buffer 使用结构化行类型。模型正文靠历史区左侧，右缘按 `assistantMaxBodyWidth`（= 宽度 - `messageGutter`）保留与用户块左缘对称的空位，与右对齐的用户输入形成左右交错的视觉（`messageGutter` 默认 4，可配置）；用户消息由 App 本地回显，渲染为**整体靠右的收缩块**——先按 `userMaxBodyWidth`（= 宽度 - `USER_MIN_LEFT_GUTTER`）换行（含显式换行），取最大行宽作块宽，整块统一 leftPad、右缘贴历史区右缘，块内文本左对齐，续行共享同一左边界。用户块与随后回答/思考之间空一行（`wrapBufferLines` 后处理，纯布局不改 state）。reasoning 流作为临时 thinking 行显示，仅以 2 空格缩进区分（无 [思考] 前缀文字），折叠上限=活动区（瞬态显示区）高度 `min(thinkingMaxLines, activityH)`——默认思考可占满活动区、超出折叠为提示行，`thinkingMaxLines` 配置仅在收紧时生效；首条正文或 turn-end 到达后立即清除，不提供展开/收起交互。模型正文支持终端 markdown 子集（只作用于最终回答，思考不经 markdown）：行内粗体/斜体/`***粗斜***`（同段粗+斜）/删除线(`~~`)/下划线(`__`)/代码（主题专用灰底 `CODE_BG`：暗色深灰、浅色浅灰）/链接与自动链接（蓝下划线）/图片（`[alt]`+URL 占位）/反斜杠转义（标点按普通文本，不触发样式）。块级 fenced 代码块（`wrapBufferLines` 维护 `inFence` 跨行状态，块内原样不解析，整行灰底补齐到内容区宽、语言标签灰斜体）、标题（青粗体）、引用（单层灰竖线前缀、正文灰不加斜、正文开头残留 `>` 隐藏，不做嵌套）、任务列表（未完成 `[ ]` 灰 / 已完成 `[x]` 勾选灰可辨识 + 正文灰色删除线）、无序列表统一 `•`、有序列表保留数字、分隔线（灰横线）。解析全部在布局层（`parseInlineMarkdown(text, themeId)` → `wrapSegments` 按显示宽度换行 → 序列化 manual ANSI），buffer 只存纯文本；样式段跨软换行每行独立开关，ANSI 转义不参与宽度计算、截断透传不切断。上标/下标（`^`/`~`）与嵌套格式暂不实现。

- **用户提问面板**（2026-08-30）：模型调用 `ask_user_question` 时，DSH 经 `user-questions` 服务询问用户——TUI 注册 `registerProvider({ask})` 接收，归一化为 `DshEvent {type:'question'; id; questions[]}`，于顶部流输出（活动区）窗口弹「第 n/m 题」问答面板（`QuestionPrompt.ts` 纯函数；2026-09-17 起不再占底部交互区，见高度分配段）。数据模型对齐官方 0.1.1-rc.2 `AskUserQuestionItem`（id/question/header/detail/options/multiSelect/intent.kind='plan-review'）。多题一次 ask 整批回答（`{answers:[{id, selected[], custom?}]}`，空回答照交、agent 自适）：单题视图 + 第 n/m 导航，**Enter 非末题进下一题、末题提交**。**「自定义回答」是固定在选项列表末位的兜底项**（无预设选项时列表仅此一项），与普通选项一样用 ↑/↓ 高亮，高亮在其上时键入字符即输入自由文本（空格输入空格、退格删末字、可即时回显修改）；单选时预设与自定义互斥（选预设清空已输入文本），多选二者并存。**底部操作提示只显示实际用到的按键**：Enter 文案区分「下一题/提交」、多题才显示「[←/→]切题」、有预设选项才显示「[空格]选择」与「[↑/↓]选项」。选项标记纯 ASCII：光标列 `>`/空格 + 选中列 `*`（单选）/`+`（多选）/空格（未选中对齐）。`plan-review` intent 以「计划卡片」呈现 detail、标题「计划审批」。Esc 仅 `cancelQuestion()`（reject ask，绝不 interrupt）。

- **会话切换 + 标题 + 复制（P0 会话生命周期，2026-09-02）**：`/session` 面板列出持久化会话（newest-first，live 标记 `[当前]` 不可续），Enter 对 persisted 会话执行 `adapter.resumeTo(id)` → host `agents.resume({resumeSessionId, agentOptions, setup})` 加载旧会话继续对话；单活跃会话设计——**先切活跃引用再释放旧 handle**（旧 handle 失败不阻断切换），切换后 buffer 展示该会话 surface（user/assistant 行），标题 `deriveTitle`（首条 user 前 30 字符，无消息 `（新会话）`）显示于状态栏（\<24 列窄屏省略）；`/copy` 取最后一条 assistant 正文经 OSC52（`ESC ]52;c;<base64>BEL`）写入系统剪贴板。resume 失败进面板 error 态不崩溃；resume 链 virtual（adapter 可选方法，宿主无 `agents.resume` 时提示不可用）。状态机沿用 history panel 五阶段 + 新增 `resuming`，async 结果带 id 匹配 stale guard。

- **历史会话面板**（2026-09-01；2026-09-02 起 `/session` 升级为「列表 + 切换」，只读 view 代码保留）：`/session` 打开会话面板，list 阶段由只读浏览改为**切换到 persisted 会话**（Phase 2，见下）。数据源为宿主 `ctx.get("sessionQuery")`（`@deepseek-ai/dsh-session-query` 引擎，d-base profile 已挂载；`main.ts` 注入 `createRealDshAdapter({sessionQuery, sessions})`——`sessions` 为 `ctx.get("sessions")` 会话存储服务，**不塞入 DshRuntime**；adapter 结构类型 `SessionQueryLike` 需 `listSessions()`，读取面为 `readSession?`/`readSurface?` 其一）。adapter 暴露两个**可选**方法 `listSessions(): Promise<SessionInfo[]>`（header 归一化 id/createdAt/cwd/live/persisted，newest-first）与 `readSessionSurface(id): Promise<SessionSurfaceView>`。**读取顺序（按 live/persisted 区分，2026-09-01 实测修复）**：① live 会话（在 `sessions.get(id)` 内存 store 中）→ 直接读原始事件 `events`（`Session.events` 不包含 `surfaceOp`，`readSurface` 的 surface fold 会滤光；且其混合日志含 `agent/inbox/spliced` 未 identified 事件，`readSession` 的 `Session.create` 全量校验会抛 `seed user/message ... lacks an identified message`，两条接口对 live 均不可用）；② persisted 会话 → `readSurface`（持久化时已补 `surfaceOp` 标记，surface fold 正常）；③ 兜底 `readSession`；④ 皆缺 → 抛结构化错误入 error 阶段。**归一化**：`normalizeHistoryMessages` 从原始事件提取 `HistoryMessage[]`（`{role, text}`）——兼容两种消息形态：`user/message`/`assistant/message` 的 text blocks（`reasoning`/`tool/result` v1 省略），以及**当前 dsh live 会话实际的消息形态 `agent/inbox/spliced`**（文本在 `data.inserted[].content[]`，role 取 `inserted[].role` 仅 user/assistant）。`readSurface` 必须 `sq.readSurface(id)` 直接调用（解构丢失 `this` 读 `_corpus` 报错）。`AppState.history: HistoryPanelState | null` 五阶段状态机：`loading-list → list ⇄ loading-view → view →（Esc 返回列表）`，失败入 `error`（列表加载失败/内容加载失败）；每个 async 结果 action 带 stale guard（phase 不匹配则 no-op，防面板已关闭/已切走的迟到响应误入）。`App` 层 `openHistory()`/`openHistoryView()` 承载异步与 paint（reducer 保持纯函数）；宿主未挂载 sessionQuery 时 `/session` 显示 notice「历史会话服务不可用」不打开面板。渲染 `HistoryPanel.ts` 纯函数（无 ANSI，同 ModelPicker 风格）：标题行 + 正文区占满固定交互区，列表行 `> MM-DD HH:mm  <8位短id>  .../cwd  [当前]`（live 标记、cwd 尾部按显示宽度截取、焦点行 `>` 前缀、视口滚动保证焦点可见），view 消息行 `问:`/`答:` 前缀 + 换行缩进 + 消息间空行，**无可提取文本（空会话/live 未落 assistant）时显示占位提示**；按键路由（`handleKey`，优先级 approval > question > picker > history）：list 阶段 ↑/↓ 移动、Enter 查看、Esc 关闭；view 阶段 ↑/↓ 滚动 ±1、PgUp/PgDn ±10、Esc 返回列表（records/index 保留、messages 清空）；loading/error 阶段吞键（error 可 Esc 关闭）。损坏会话（sqlite 校验失败）的 `readSurface` 结构化错误透传到 error 阶段显示。

### 状态区数据流

`StatusTicker`（`status.ts`）以固定间隔 tick，**一次 tick 内合并查询 cwd/git/time**（不重复 fork 子进程），聚合为单个 `Partial<SystemStatus>` 经 `{type:"status"}` reducer 更新。模型/上下文长度/缓存命中率无数据源，保持占位 `—`。queries 与 schedule 均可注入（测试断言调用次数）；真实实现：`process.cwd()` + `git status --porcelain --branch`（execFile，1.5s 超时，失败回 `—`）。

## DSH 集成配置（主题与流式显示）

- 展示类配置在 `apply()` 配置边界由 `normalizeTuiDisplayConfig` 一次性归一化（非法值告警回退默认），经 `main()` → `App` → `initialState` 下传，app 内不再校验：
  - `streamTypewriter`（默认 true）：思考打字机总开关；false 恢复原速（思考与正文均即时）。
  - `streamCharsPerSecond`（默认 120，域 1..2000）：思考打字机流速；收到正文后剩余思考自动加速到 200 字符/秒放完再铺正文，**每个 turn 结束后回落初始速度**；按码点切分不拆 emoji；低速用分数累计保证逐字输出。正文回复本身不受限速（即时显示）。
  - `thinkingMaxLines`（默认 50，域 1..50）：思考区显示行数上限（逻辑行）；实际生效 `min(thinkingMaxLines, activityH)`，默认跟随活动区（瞬态显示区）高度，超出折叠为提示行，更小值仅收紧。
  - `messageGutter`（默认 4，域 0..20）：用户块左缘/回复右缘对称留空列数（交错布局；0 表示右缘顶满）。
- theme（`dark|light`）由配置注入、`/theme` 会话内切换不落盘（见 IMPLEMENTATION「/theme 命令」）。
- `toolBootstrap`（默认 true）：锚定工具引导总开关（见 IMPLEMENTATION「锚定工具引导」），非行为展示类配置，在 `apply()` 直接读 `config.toolBootstrap` 透传给 `installToolBootstrap`，不参与 display 归一化。

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
- demo：`npm run demo` → tsc 后 `node dist/demo/main.js`

## 开发阶段（含 spike）

0. **DSH adapter 接口确认**（已完成，2026-08-23）：研读官方源码并沉淀于仓库根 `DSH-CTX-API.md`，接口形状已写入 `src/app/adapter/dsh.ts` 的类型骨架（DSH 原生类型 + 归一化映射表）。不再需要一次性的 spike 脚本；阶段 2 实现 real adapter 时直接在真实 DSH profile 内验证（订阅 → 流式 → 审批应答）。adapter 保持接口化以便 mock/真实替换。
1. 实现 renderer 最小可用（raw mode + 输入解码 + 整帧重绘），`demo/` 跑通
2. 接入 DSH 核心（adapter/dsh.ts，含审批与流式输出）
3. 完善交互功能并打包为 DSH Profile Bundle（bin/dsh-tui.js）

由 advisor 审阅（2026-08-22），本版修正：

- 补 phase 0 spike：adapter 接口先行
- 定义 renderer↔app 接口契约（RenderLine / KeyEvent / Renderer）
- 明确 scrollback 行为（wrapping、2000 行上限、跟随底部、视口移动）
- 入口统一为 `src/main.ts`
- 构建工具选定 tsc，产物 dist/，bin 指向 dist/main.js
- demo 与 tests 定位：demo 用 mock adapter 走通全栈；tests 优先覆盖 input.ts
- 信号/退出契约归 renderer
- components 清单落实为 TextInput / ScrollView / ApprovalPrompt / ModelPicker / QuestionPrompt
- adapter 接口化，ctx API 未确认前可 mock 替换

## 能力缺口 Backlog（2026-09-03 首版；2026-09-04 复核：基准仍为 v0.1.1-rc.2 = 48 项，暂不升级 0.1.2）

对照官方 `deepseek-harness` v0.1.1-rc.2（= 本机安装宿主）的接口与功能盘点。8 个插件可消费服务（sessions / agents / approval / userQuestions / llm / commands / sessionQuery / agentDefaultModel）已全部接入；缺口集中在**事件可视化与交互能力**（rc.2 事件词汇表 48 项，以该 tag 的 `packages/core/session/src/known-event-types.ts` 为准）。优先级依据：用户感知频率 × 实现成本（现有 DshEvent / reducer / notice / 状态栏通道可复用程度）。

- 事件词汇表以 rc.2 的 48 项为准；2026-09-04 与最新 master（52 项）核对，差异仅 3 项（`model/selection`、`subagent/model-selection-policy`、`session-log-deepseek/delivery-accepted`）——**因暂不升级 0.1.2，标为「master 前瞻」不入当前分级**（见下方 P3 末尾）。
- `compaction/summary` / `compaction/prune` / `agent/inbox/spliced` / `team/*` 等在 rc.2 已存在，此前分级未单列，本次补齐；其中 `agent/inbox/spliced` **已用于历史重建**（`normalizeHistoryMessages`，当前 dsh 内存会话承载消息的形态）。
- 优先级依据：用户感知频率 × 实现成本（现有 DshEvent / reducer / notice / 状态栏通道可复用程度）。

### P1 — 核心体验补全（高频感知，现有通道即可落地）

| 缺口 | 通道 | 理由 |
| --- | --- | --- |
| `tool/call` + `tool/result` | 新 DshEvent + 紧凑渲染（工具名+摘要+结果折叠） | 编码代理 TUI 的第一可见性，当前完全不可见 |
| usage/cost 状态栏 | 状态栏扩展（usage chunk 已解析，零新事件） | 成本几乎为零 |
| `finish` reason | 挂 turn-end notice | 截断/失败静默是体验坑 |
| `compaction/start` + `compaction/end` | notice toast | 长会话静默压缩造成困惑 |
| `llm/retry`（`retry-started` 先不处理，见事件映射表注） | notice toast | 重试透明化 |

### P2 — 状态可见性与交互完整（中频，需小面板或状态栏槽位）

- `goal/change`、`todo/write` — 状态区/迷你面板
- `plan/mode`、`sandbox/mode`、`permission/preset` — 状态栏模式徽标
- `step/start`|`end` — turn 内分步（依赖 P1 工具域先行）
- 审批策略切换 UI（`setPolicy` ask/never）
- `subagent/descriptor` — 子代理可见性
- `compaction/summary` — 压缩摘要文本展示（toast/折叠，压缩后的总结可读）

### P3 — 低频生态域与特性决策（toast 或暂缓）

> **已接入（2026-09-12，8 个 DshEvent 批次）**：`tool-workflow/*`（workflow 行 ⚑/⤷/↩ + 结束 toast）、`command/run`|`done`（执行流：run 灰行、成功 done 静默、失败红行 ✗）、`tool/code-dispatch*`（start 行 ⇥，settle 成功静默/失败红行）、`hook/*`（invoked 灰行 ⌗ / result 成败着色）、`schedule/change`（仅 dispatch 到点 toast，create/delete 静默）、`feedback/record`（确认 toast）、`compaction/prune`（剪除计数 toast）、`llm/retry-started`（↻ 启动灰行，与 retry toast 互补）。接入均为 append-only 活动区行/notice，不引入配对状态。
> **权限预设 `/permission`（2026-09-12）**：实际交付为 **预设目录 + slash 写路径**（非独立选择面板）——无参列当前值 + 可用预设表（rc.2 默认 workspace-write/danger-full-access，经 `ctx.permissionPresets.names/current` 读，main.ts 已接线）；带参 `/permission <name>` 转发宿主命令（宿主校验 + `permission/preset`+`approval/policy` 写路径）。宿主未挂载服务 → notice「权限预设服务不可用」。
> **agent 预设 `/preset`（2026-09-13）**：`agent-preset/selected`（rc.2 会话事件，拼法由 `agent/preset/selected` 修正为连字符 `agent-preset/selected`）归一化为 DshEvent → reducer `presetBySession`（按 sessionId 隔离 latest-wins）+ 状态栏徽标 `preset:<id>`；`/preset` 无参从 `ctx.agentPresets` 读目录（list + defaultId + 事件回读当前）列当前/可用/默认，带参调用 `selectAgentPreset`（rc.2 `AgentPresets.recompose(agentCtx, id)` 写路径，agentCtx 宽松取自 agent handle 的 ctx）。**DshEvent 归一化断言落位 `tests/agent-preset.test.ts`**（契约点名文件：seq 守卫同 seq/倒序丢弃 + 非法值丢弃 + 非活跃会话丢弃；`tests/adapter.dsh.test.ts` 保留同覆盖）。宿主未挂载/未暴露 → notice「agent 预设服务不可用」（fail-safe）。
> **jobs 后台任务面板 `/jobs`（2026-09-13）**：rc.2 核实 **`JobRegistry` 有 `onJobsChanged` 观察者**（任一 commit 变化即通知，非裸轮询），dsh-base 默认装配 `dsh-jobs-local`（ctx.jobs 可用）。adapter 订阅 `onJobsChanged` → 推送全量快照 `jobs-changed`（`JobSnapshot` 子集 id/kind/label/status/detail，宽松读取）；`/jobs` 打开面板 + `refreshJobs` 主动拉取一次；面板展示任务状态行（running/stopping 黄 ●、failed/error 红 ✗、cancelled 灰 ○、其余默认）、高亮行 `>` 恒在窗口内、`Enter` 调 `killJob`（`ctx.jobs.kill`）取消高亮任务、`Esc` 关闭；状态栏 `jobs N` 徽标仅显示运行中计数；顶部状态列含 jobs 块（`Jobs 运行中/总数` 蓝标题 + 每任务 `●`/`✗`/`○`/`✓` 状态行）。**caller 语义（0.1.2-rc.1 jobs-local 实测）**：`list(caller)`/`kill(id, caller)` 为 owner-relative——`list` 只读 `caller.id` 与 `job.owner.id` 匹配，缺 caller 仅返回 unowned（当前会话任务不可见）；故 `refreshJobs`/订阅回调/`killJob` 都显式传 `{ id: activeSessionId }`（当前会话 owner 的任务才可见/可取消，宿主未挂载 jobs 服务时 refreshJobs reject、不假成功）。**会话待机守卫（App 侧兜底）**：`agent-preset`/`jobs-changed` 在 App 事件层再按 `activeSessionId` 过滤（非活跃会话丢弃——adapter 已过滤，双重防线供直接 push 断言与切会话迟到事件防护）；面板关闭后迟到的 `jobs-changed` 只更新 jobs 状态、不重开面板。仅只读展示 + cancel，不做 job 创建/参数 UI。
> **`/compact`、`/feedback`（2026-09-13 装配核验）**：二者均为宿主自带命令（rc.2 `dsh-command-compact`/`dsh-command-feedback`，均在 **dsh-base bundle 默认装配**——`bundle/base/cordis.patch.yml`，经 `ctx.commands.register` 注册 `/compact`、`/feedback`）。故 TUI profile 基于 dsh-base 时**命令转发即用**（TUI 无本地路由，走 registry 转发），无需额外代码；`feedback/record` toast 已接入（见上方 8 事件批次）。
> **装配证据分级（2026-09-13）**：rc.2 bundle 证据见 `bundle/base/cordis.patch.yml`（command-compact / command-feedback / jobs-local / permission-presets 均在默认装配）；**当前 profile runtime 实测**（全局 dsh 内 `dsh-base@0.1.2-rc.1` 的 cordis.patch.yml）同样装配 jobs-local、command-feedback、command-compact、permission-presets、tool-jobs。**`agent-presets` 服务（dsh-agent-presets）在 rc.2 与当前 profile 的 dsh-base 默认装配中均未包含**——`/preset` 目录/切换在装配了该服务的环境可用；当前默认 profile 下 `/preset` 会提示「agent 预设服务不可用」（fail-safe 正常路径，TUI 接口已按 rc.2 核验、待装配该服务即生效）。
> **deferred（已评估暂缓，非缺失）**：`session/end-seed`、`session/title-llm-request`、`request/header`、`request/context` — 均为低价值调试向事件且 request/\* payload 结构复杂，接显示收益低于解析风险，待调试视图需求出现再做。

- **生态事件（未接入）**：`team/*`（实验包依赖）——`agent-preset/selected` 已于 2026-09-13 接入（/preset，见上方）
- **审计对（未接入）**：`approval/asked`|`decided`（功能由 approval/request 瀑布覆盖，仅事件流未直接读）、`web/deepseek-search-llm-request`（log-only，调试视图再做）。
  - **角色澄清**：`approval/request` 是瀑布应答链（机制，TUI 已接——`approvalAnswerer` 弹请求、返回 ApprovalOutcome 即裁定）；`approval/asked`+`decided` 是同段写日志（log-only 审计，`user-approval/src/index.ts` L267/274 append，同 id 恰好一 asked 一 decided，decided 失败则 Promise 拒绝）。**当前 TUI 唯一审批界面 = 弹窗（approval/request 驱动）；审计对无任何界面**。
  - **界面 vs 数据**：界面不需审计对（弹窗 + tool/result 行已覆盖）；只有「事后回溯」场景（事故复盘 / 审批问题诊断 / ask-never 策略调优）才需要审计时间线。
  - **持久化不丢**：审计对随 `session.append` 入会话事件流，整流落 sqlite（`session-persistence-sqlite` `packChunkRuns`/`loadStored`），resume 后完整恢复——数据层不丢，丢的是展示入口。
  - **readSurface vs readSession**：`readSurface`（persisted 会话）做 surface fold，仅保留 user/message、assistant/message、tool/result（`surface.ts` SURFACE_EVENT_TYPES）——审计对**必然不含**；`readSession` 返回全量原始事件（经 `Session.create` 全量校验，混合日志会抛校验错）。TUI 历史面板用 readSurface 是「对话视图」语义对口；审批历史必须另走 readSession。
  - **待实现通路设计（2026-09-16，未实现，仅记录）**：`/approvals` 只读面板 + adapter 新增 `readApprovalHistory?()`（走 `readSession` 全量 → 过滤 asked/decided → 按 id 配对，无 decided 孤儿记 pending → 按 seq 升序）。实时审批不回放（弹窗已覆盖），历史静态重放不做实时订阅。坑：readSession 全量校验在混合日志/live 会话抛错 → 抓错进 error 态提示「会话日志不完整」，不崩面板。落点：types.ts ApprovalRecord + 签名、dsh.ts 归一化、index.ts /approvals 路由 + 面板态、纯渲染组件、tests（配对/孤儿/校验错分支）。
  - **触发时机**（出现任一再做，当前 deferred）：安全事故复盘、审批问题诊断（asked 有无 / decided 超时 vs rejected）、ask/never 策略调优（批准率）、多会话事后审计。
- **特性级（需产品决策）排期决策（2026-09-16）**：**session fork（`sessions.fork`）→ 待做（下个功能批次）**；多会话并行 → 维持 P0 边界排除（单活跃会话设计，不做）；feedback 评价 → deferred（低频）。
- **TUI 自身渲染边界（排期决策 2026-09-16）**：**thinking 展开/收起 → 明确不做**（用户不喜欢看推理过程）；嵌套 markdown、上下标 → deferred（低频）
- **master 前瞻（rc.2 宿主不产生；暂不升级 0.1.2，升级后再评估）**：
  - `model/selection` — 官方模型切换回放（届时可与 TUI /model 联动）
  - `subagent/model-selection-policy` — 子代理模型策略
  - `session-log-deepseek/delivery-accepted` — 内部日志交付确认

## P1 实现计划（2026-09-03，三阶段，每阶段一个可审计 goal）

### 范围与关键决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 范围 | P1 五项：工具可见性、usage 状态栏、finish reason、compaction toast、retry toast | P2 需面板/槽位设计，依赖 P1 工具域先行 |
| 工具可视化形态 | 紧凑 buffer 行（append-only），不做面板 | 现有 buffer 管线可直接承载；面板属 P2 |
| 通道 | 全部走现有 DshEvent → reducer → 渲染链路，新增 4 个事件类型 | 不引入新管线 |
| usage 落点 | 复用状态栏已有 `contextLen`/`cacheHit` 槽位（当前硬编码 "—"，state.ts:216） | 零新增布局 |
| finish reason 数据源 | `turn/end.reason`（rc.2 为结构化判别联合，比 StreamChunk finish 更完整） | 现状 turn/end 只发空 `turn-end`，丢弃了 reason |
| 不做 | `meta` diff 展示、callId 配对 spinner、多行工具面板 | 全部归 P2 |

### 事件映射（rc.2 载荷 → TUI DshEvent）

| rc.2 事件（载荷已核实） | 新 DshEvent | 渲染 |
| --- | --- | --- |
| `tool/call` `{turn, step, callId, name, arguments: string}` | `tool-call` `{sessionId, name, summary}` | buffer 行 `○ <name> <summary>`（summary = arguments JSON 关键字段启发式提取，截断一行） |
| `tool/result` `{message, error?: {name, code}, meta?}` | `tool-result` `{sessionId, ok, detail}` | buffer 行 `✓ <detail 首行截断>`；错误 `✗ <error.name>: <message>`（红色） |
| `assistant/message` 的 `usage?: TokenUsage`（现已解析即丢） | `usage` `{sessionId, input, output, cacheRead}` | 状态栏槽位 `ctx 12.4k` + `cache 92%`（最新一次请求为准，不累计） |
| `turn/end` 的 `reason`（completed/aborted/blocked/error/max-tokens/interrupted） | 现有 `notice` 增加可选 `tone` 字段 | error → 红 `✗ <code>: <message>`；max-tokens → 黄"输出达 token 上限"；aborted → 灰"已取消"；completed 静默 |
| `compaction/start` + `compaction/end` `{compactionId, sourceCommandId?}` | `compaction` `{phase}` | notice toast："正在压缩上下文…" / "压缩完成" |
| `llm/retry` `{retry, maxRetries, delayMs, failure: {code, message}, provider}` | `retry` `{attempt, max, delayMs, code}` | notice toast："重试 1/2 (1.5s): TRANSPORT 连接被重置"；`llm/retry-started` 先不处理，形状实现时再核 |

### 阶段 1 — adapter 归一化 + 事件类型（无 UI 变化）

| 文件 | 改动 | 估计 |
| --- | --- | --- |
| `src/app/adapter/types.ts` | 新增 4 个 DshEvent 类型；notice 加 `tone?` | ~25 行 |
| `src/app/adapter/dsh.ts`（onSessionEvent 归一化 switch） | 新增 tool/call、tool/result、compaction start/end、llm/retry case；assistant/message 补发 usage；turn/end 按 reason 发带 tone 的 notice | ~80 行 |
| `src/app/state.ts` | reducer 对应 case（本阶段仅入状态/透传，不渲染） | ~30 行 |
| `tests/adapter.dsh.test.ts` | mock session 事件序列 → 断言 DshEvent 序列（arguments 解析失败兜底、error 分支、非活跃会话丢弃） | ~250 行 |

#### 阶段 1 边界修正（2026-09-03，已在暂停卡批准）

- 阶段 1 允许改动 `src/app/index.ts`：仅新增 5 个新事件的 pass-through 分发（入 reducer，不渲染；渲染仍归阶段 2）。原因：`DshEvent` 为封闭联合 + index.ts 穷尽 `never` switch，新增成员若不在 index.ts 登记，`npm run check` 必失败——「不改 index.ts」与「新增成员 + tsc 全绿」互斥。
- `state.ts` 的 StateAction 与 reducer 增加对应 case：`usage` 仅入状态（`state.usage`，阶段 2 状态栏 contextLen/cacheHit 读取）；tool-call/tool-result/compaction/retry 透传（case 已识别、不渲染）。
- `retry` DshEvent 在计划 `{attempt, max, delayMs, code}` 基础上增加可选 `message`（llm/retry.failure.message），供 render 示例「TRANSPORT 连接被重置」使用；`tool-call.summary` / `tool-result.detail` 的启发式提取函数落在 dsh.ts（阶段 2 渲染如需更细可迁至 tool-line.ts）。

### 阶段 2 — 渲染 + 状态栏

| 文件 | 改动 | 估计 |
| --- | --- | --- |
| `src/app/index.ts`（事件 switch） | tool-call/tool-result 直接 append（不进打字机队列）；usage/retry/compaction 分流 | ~50 行 |
| 工具行渲染（`src/app/markdown.ts` 或新 `tool-line.ts`） | summary 启发式提取（read/write/edit → path，bash → command，grep → pattern，兜底 = 原始 JSON 截断）；wrap 遵循现有行规则 | ~60 行 |
| `src/app/layout.ts`（状态栏） | `contextLen`/`cacheHit` 从 state.usage 取值（无 usage 时保持 "—"） | ~15 行 |
| `tests/app.test.ts`、`tests/layout.test.ts`、`tests/screen.test.ts` | reducer/布局/帧测试 | ~300 行 |
| `demo/` mock adapter | 注入 tool-call/result、usage、error turn 场景（PTY 验证依赖） | ~80 行 |

### 阶段 3 — 联调与文档

| 事项 | 内容 |
| --- | --- |
| 真实 DSH 验证 | 真实会话触发工具调用（读文件/跑命令）→ 紧凑行出现；turn 结束状态栏出 usage；error/retry/compaction toast 由 demo 场景覆盖 |
| 文档同步 | 本文档 backlog 标记 P1 完成；IMPLEMENTATION.md 增补事件表；README 功能列表（AGENTS.md 要求） |
| 收尾 | `format` 改动文件 → commit |

### 验证契约（审计用）

| 阶段 | 契约 |
| --- | --- |
| 1 | `npm run check` / `npm test` 全绿（含新 adapter 测试）；`git status` 干净 |
| 2 | 同上 + `npm run build` + demo 场景断言（tool 行、状态栏 usage、error notice 均出现于帧输出） |
| 3 | PTY 冒烟（真实 DSH 工具调用 + usage）+ 三文档 grep 检查 + 工作区干净 |

#### P1 计划状态：完成（2026-09-03）

P1 三阶段全部落地并经审计通过：

- **阶段 1**：adapter 归一化 + 事件类型（tool-call/tool-result/usage/compaction/retry、notice `tone?`、finish reason 分级 notice）。
- **阶段 2**：渲染 + 状态栏（工具行 ○/✓/✗、notice tone 红/黄/灰着色、状态栏 contextLen/cacheHit、retry/compaction toast）。
- **阶段 3**：真实 DSH PTY 冒烟 happy path（`npm run smoke:pty`：真实会话断言 ○ 工具行与状态栏 usage）+ 本文档/IMPLEMENTATION.md/README 收尾。

backlog 状态：P1、P2 完成（2026-09-05）；P3 部分接入（2026-09-12 起：8 事件批次 + `/permission`；2026-09-13：`/preset` agent 预设 + `/jobs` 后台任务面板）；**`jobs` 已落地（2026-09-13，经 `onJobsChanged` 观察者而非轮询，勿再按旧结论排期）**；`/compact`、`/feedback` 为宿主自带、dsh-base 默认装配即用（2026-09-13 核验）。其余低频/调试向项待排期。

### 风险 / 实现时需确认

| 项 | 说明 |
| --- | --- |
| `ToolResultMessage` 内部形状 | 计划按 content blocks 取首行文本，实现时核 rc.2 定义 |
| `TokenUsage` 字段名 | cache 读取字段的准确命名以 dsh-llm 类型为准（TUI types.ts 已有 usage chunk 雏形可对齐） |
| retry/compaction 真实触发难 | 单测 + demo fixture 覆盖，真实设备只验 happy path |
| 窄终端工具行换行 | 遵循现有 wrap 规则，测试覆盖 |

### P1 之后（供排序，不展开）

| 优先级 | 项 |
| --- | --- |
| P2 首 | `goal/change` + `todo/write` 迷你面板（复用 P1 工具行验证过的 buffer 行模式） |
| P2 | 状态栏模式徽标（plan/sandbox/permission）、`step/start` + `step/end` 分步、审批策略切换 UI、`subagent/descriptor` |
| **待做（2026-09-16 排期）** | **tool `meta` diff 展示（+N/-M）** — 用户确认做 |
| P3 | 按上方 backlog 清单暂缓 |

预估总改动 ~800 行（含测试）。每阶段完成报验证结果后再进下一阶段。

## P2 实现计划（2026-09-04 编制 v1；2026-09-05 advisor 多轮审阅修订 v4 定稿；同日 A0+A 完成并提交，B1 起待排期）

### 范围与关键决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 范围 | 6 项产品能力、9 个事件类型：①goal/todo 迷你面板（goal/change、todo/write）②状态栏模式徽标（plan/mode、sandbox/mode、permission/preset）③step 分步（step/start、step/end）④subagent 可见性（subagent/descriptor）⑤compaction 摘要（compaction/summary）⑥审批策略切换 UI。tool meta diff **移出本轮**（后续 P2/P3 再评估） | P1 后列表精选高频可落地项 |
| 集成方式 | 全部集成 TUI（2026-09-04 确认不拆分），复用 DshEvent/reducer/notice/状态栏/面板通道 | 单一 UI 消费端；P2 皆 UI 表达类 |
| goal/todo 形态 | 状态栏两类计数分列：**goal 状态徽标**（phase：active/paused/blocked/complete）+ **todo 活动计数**（in_progress n/共 m）；`/goal` 迷你面板复用 HistoryPanel 面板模式 | todo 全量快照（last-write-wins 无 id）、goal 全量快照 + clear 墓碑，无需增量 diff |
| 模式徽标 | 状态栏 session 组三合一 slot，固定顺序 plan→sandbox→permission，未触发/默认省略、缩略显示（规则见「渲染语义」）；窄屏随 session 组级折行 | 复用 renderStatusLine 分组；避免状态栏膨胀 |
| step 分步 | 仅在该 step 出现首个工具调用时渲染分组头 `step N`；无工具 step 静默 | step/start 无载荷值，只为工具行分组服务 |
| subagent 行 | buffer 行前缀 **候选**「`@ <label>`」+ mode 缩略（os/ct）；**符号与展示形态验收前需用户确认**，不视为已定 | 低频，行级即可；符号沿用用户符号偏好流程 |
| compaction 摘要 | **仅 toast（复用 notice 通道，tone 默认）**：`压缩完成：<首个非空文本块首行>`；不写持久 buffer、不做折叠行；完整载荷只入 state 待查 | 压缩可高频，持久行污染对话历史；与 compaction/start/end 现有 toast 一致 |
| 审批策略切换 UI | **条件化范围**：A0 确认宿主是否支持会话级 `approval/policy` 写路径；支持→做 ask/never 两态切换，不支持→仅实现 preset 选择 UI（不发明独立开关）。**`approval/policy` 是既有事件（P3 审计对同源），不属本轮新增事件**；仅当需要展示当前策略时才把它归一化为 DshEvent（见阶段 A 注） | ApprovalPolicy（ask/never）、PresetService 配置表与写路径均已在 rc.2 源码核实（A0）——C 定案为 ask/never 两态切换 |

### 事件映射（rc.2 载荷已核 → TUI DshEvent）

| rc.2 事件（载荷已核实） | 新 DshEvent（判别联合） | 渲染 |
| --- | --- | --- |
| `goal/change`（operation: create/edit/pause/resume/complete/block 携带 GoalSnapshot{id,revision,objective,phase(active/paused/blocked/complete),blockedReason?,maxGoalRounds}+roundsStarted/createdAt/updatedAt；operation: clear 携带 cleared{id,revision}+clearedAt） | `goal-change` 判别联合：`{sessionId, operation: Exclude<…,'clear'>, goal: {id,revision,objective,phase,blockedReason?,maxGoalRounds}, roundsStarted}`；或 `{sessionId, operation:'clear', cleared: {id,revision}}` | 非 clear：状态栏 goal 徽标（phase）+ 顶部状态列 goal 块详显（`Goal <phase>` 标题（Goal 蓝+phase 状态色）、objective、blocked 显示 blockedReason.message 黄 tone）；clear：徽标省略 + 状态列回到占位 |
| `todo/write`（{todos: TodoItem[]}；TodoItem {content, status: pending/in_progress/completed}，全量快照 last-write-wins） | `todo-write {sessionId, todos}` | 状态栏 todo 计数（in_progress/共 m）；顶部状态列 todo 块（标题 `Todo 完成数/总数` 蓝 + 列表 `·`待办(默认)/`>`进行中(黄)/`✓`完成(灰+删除线) + content） |
| `plan/mode`（{active: boolean}） | `mode {sessionId, kind:'plan', value}` | 状态栏徽标：active → `plan`，inactive → 省略 |
| `sandbox/mode`（{mode: read-only/workspace-write/danger-full-access, source?}） | `mode {sessionId, kind:'sandbox', value}` | 状态栏徽标缩略：read-only→ro / workspace-write→wr / danger-full-access→full；等于部署默认时省略 |
| `permission/preset`（{preset: string}，默认表键 workspace-write/danger-full-access，配置可增） | `mode {sessionId, kind:'permission', value}` | 状态栏徽标（preset 名缩略复用 sandbox 缩写；与当前 sandbox 缩略相同则省略避免重复） |
| `step/start`（{turn, step}） | `step {sessionId, turn, step, phase:'start'}` | 工具行分组头（仅该 step 首个工具调用时渲染） |
| `step/end`（{turn, step}） | `step {sessionId, turn, step, phase:'end'}` | 关闭当前工具组（无独立渲染） |
| `subagent/descriptor`（{version, mode: one-shot/continuable, provider, label?, agentProvider?, agentModel?, persona?, toolFilter?}） | `subagent {sessionId, label, mode}` | buffer 行 前缀「候选」`@ <label>` + mode 缩略（无 label 回落 provider；one-shot→os / continuable→ct），**验收前需用户确认符号** |
| `compaction/summary`（{compactionId, summary: ContentBlock[], shadowedSeqs[], shadowedTokenCount, provider, model, usage?}；紧随其后 user/message 作阴影替换） | `compaction-summary {sessionId, text, raw}`（raw: CompactionSummaryPayload 完整原始载荷） | **仅 toast**：`压缩完成：<text 首行>`（notice tone 默认）；UI 只消费 `text`；reducer 将 `raw` 存入 `state.compactionBySession[sessionId]`（`{raw, text}`，每会话仅最新一条；不改写、不裁剪；不写持久 buffer） |

### 渲染语义（已定规则，布局测试据此验收；标「候选」者待用户确认）

- **goal**：DshEvent 为判别联合（见事件映射）；state 侧**按 sessionId 隔离**（`state.goalBySession[sessionId]`），同样用判别联合并**完整保留原始载荷字段**：非 clear `{status:'set', operation, goal: GoalSnapshot(含 id/revision/objective/phase/blockedReason?/maxGoalRounds), roundsStarted, createdAt, updatedAt}`；clear `{status:'cleared', operation:'clear', cleared: GoalRef, clearedAt}`（**不丢弃 operation、maxGoalRounds、时间字段与 clearedAt**，UI 只取所需）；clear → 徽标省略、面板清空；非 clear → 快照全量替换（原子，无增量）；切换活跃会话读对应 sessionId 状态，杜绝旧会话泄漏。
- **todo**：每次 `todo/write` 全量替换**该会话**列表（`state.todoBySession[sessionId]`）；进行中计数 = todos.filter(status==='in_progress')；切换活跃会话读对应状态。
- **模式徽标**：状态按 sessionId 隔离（`state.modeBySession[sessionId]`）；顺序固定 plan→sandbox→permission，组内 `·` 分隔；plan 仅 active 显示；sandbox 等于部署默认（注入，缺省 workspace-write）时省略；permission 缩略与 sandbox 相同则省略；三者皆省略则整 slot 消失；窄屏随 session 组级折行（组整体换行，不做槽内截断）。
- **step**：P1 工具组按 callId 配对刷新；B3 引入 step 边界——`step/start` 到来且当前有活动工具组时先 flush 该组并另起分组头 `step N`；无工具调用的 step 不产生任何输出；`step/end` 只关闭分组状态。
- **subagent**（候选）：append-only 不配对不折叠；不在行内展示 persona/toolFilter。
- **compaction/summary**：只取首个非空文本块首行入 toast；空摘要（无文本块）→「压缩完成（无摘要）」；DshEvent 携带 `text` 与 `raw`（完整原始载荷），reducer 存入 `state.compactionBySession[sessionId] = {raw: CompactionSummaryPayload, text}`——**每会话仅保留最近一条，不无限累积**；raw 不改写、不裁剪、不进入对话 buffer；UI 仅消费 `text`。

### seq 守卫（事件序列约束，阶段 A 必须落地并被测试断言）

- adapter/state 为每个 session 记录 `lastSeq`：`event.seq <= lastSeq` → 丢弃（防重复/倒序重放）；`event.seq > lastSeq + 1` → 只是间隙（rc.2 用 session/end-seed 标识 seed 边界，TUI 不做补缺，直接接受并更新游标）。
- 非当前活跃会话的事件：沿用 P1 现有「非活跃会话丢弃」守卫，不进入 state。
- 验证契约必含具体断言：同 seq 重复丢弃、seq 倒序丢弃、间隙接受、非当前 sessionId 丢弃（各至少 1 条）。

### 阶段划分（A0 边界先行，A 事件层无 UI，B 按项可拆子阶段，C 收尾）

| 阶段 | 内容 | 文件 | 估计 |
| --- | --- | --- | --- |
| A0 — 宿主写路径核验 ✅ | **结论：宿主存在会话级写路径** `ctx.approval.setPolicy(agent, 'ask' | 'never')`（rc.2`user-approval/src/index.ts` L226 → `setApprovalPolicy` → `session.append('approval/policy')`）→ **C 做 ask/never 两态切换**；`permissionPresets`仅为替代的组合预设路径（PresetService 配置表键 workspace-write/danger-full-access，配置可增）。**若 C 需展示当前策略**，`approval/policy` 归一化为第 10 个新 DshEvent（既有事件源，仅 C 依 A0 结果按需引入）。调研结论记入仓库根 `DSH-CTX-API.md` 第 8 节备注（本 goal 客观要求的偏差；本段保留摘要） | 调研 | ✅ ~0 代码 |
| A — 事件层（无 UI） ✅ | **9 个新增 DshEvent 类型**（6 项能力；不含 `approval/policy`——其为既有事件）：types.ts 加 GoalOperation/GoalRefLike/GoalSnapshotLike/GoalChangeLike/TodoItemLike/SubagentDescriptorLike/ContentBlockLike/CompactionSummaryPayloadLike 与 9 个 DshEvent（goal-change 判别联合、mode×3 合一、step×2、subagent、compaction-summary{text,raw}）+ SessionEventType/DataMap 同步；dsh.ts 归一化 case（goal 以 operation==='clear' 选判别成员；todo 数组兜底空；plan/mode active→on/off；subagent label 缺省回落 provider；compaction text 取首个非空文本块）+ reducer 入状态（**goal/todo/模式/compaction 全部按 sessionId 隔离**；compaction 每会话仅最新一条不裁剪 raw）+ index.ts 透传 + **seq 守卫**（per-session 游标 `sessionSeq`：同 seq 重复/倒序丢弃、间隙接受；缺 seq 的旧 mock 跳过；非活跃会话沿用 P1 丢弃）。测试侧：FakeRuntime.fire 自动按 sessionId 分配递增 seq（兼容历史用例固定 seq:1），新增 fireRaw 供守卫用例显式注入 | types.ts / dsh.ts / state.ts / index.ts / tests/adapter.dsh.test.ts | ~260 ✅ |
| B1 — `/goal` 迷你面板 | 状态栏 goal 徽标 + todo 计数 slot + 面板（纯函数渲染 + footer 面板态，复用 HistoryPanel 模式）；goal clear/blocked 展示 | state.ts / 新 components/GoalPanel.ts / layout.ts / index.ts + 测试 | ~240 |
| B2 — 状态栏模式徽标 | plan/sandbox/permission 三合一 slot（顺序/省略/缩略规则见渲染语义） | layout.ts + tests/layout4.test.ts | ~60 |
| B3 — step 分步 | 工具行分组头 `step N`（新 step 先 flush 当前组）；无工具 step 静默 | layout.ts / tool-line.ts + 测试 | ~60 |
| B4 — subagent 行（候选确认后） | buffer 行 `@ <label> <os/ct>`（append-only） | layout.ts / tool-line.ts + 测试 | ~40 |
| B5 — compaction 摘要 | dsh.ts 提取 text + index.ts 发 notice toast（tone 默认）；原始载荷入 state | dsh.ts / index.ts + 测试 | ~40 |
| C — 审批策略 UI + 联调 | 依 A0 结论实现 `/policy`（两态切换）或 preset 选择 UI；demo 场景 + 三文档收尾 + 真实 DSH 验证 | 新组件 + adapter + demo + README/IMPLEMENTATION/DESIGN | ~150 |

### 验证契约（审计用）

| 阶段 | 契约 |
| --- | --- |
| A0 ✅ | 写路径在 rc.2 源码核实（`user-approval/src/index.ts` L226 `setApprovalPolicy` → `session.append('approval/policy')`），结论记入仓库根 `DSH-CTX-API.md` 第 8 节备注；无代码 |
| A ✅ | `npm run check` / `npm test` / `npm run build` 全绿（344 tests）；adapter 测试含 seq 守卫断言（同 seq 重复丢弃、倒序丢弃、间隙接受、非当前 sessionId 丢弃各 ≥1）+ goal 判别联合 set/clear + todo 全量替换 + reducer 级会话切换隔离断言（s1/s2 goal/todo/mode/compaction 互不泄漏） |
| B（每项） | 同上 + `npm run build` + demo 帧断言（goal 面板、徽标、step、subagent、summary toast 出现于帧输出；窄终端徽标组级折行；compaction 空摘要分支；goal blocked/clear 分支） |
| C | 同上 + PTY 冒烟（真实 goal/todo/plan 会话，如可达）；三文档 grep 检查 + 工作区干净 |

### 开放项（实现时核；不阻塞阶段排期）

| 项 | 说明 |
| --- | --- |
| 审批策略写路径 ✅ 已定 | A0 已核 `ctx.approval.setPolicy(agent, 'ask' | 'never')` 可用 → **C 做 ask/never 两态切换** |
| `/goal` 面板 **已移除（2026-09-07）** | goal/todo 详显统一由顶部状态列承接（单活跃会话设计）；输入 `/goal` 仅 notice 提示「详情见右侧信息栏」，不再打开面板；GoalPanel 组件、goalPanel 面板态与其路由/测试一并删除 |
| subagent 行符号 ✅ 已定 | `@` 前缀与 os/ct 缩略已随 B4 落地确认（`@ <label> <os|ct>`） |
| compaction/summary 持久化 | 本轮仅 toast 不落 buffer；若后续要可读历史（/inspect 类），另立条目 |

预估总改动 ~850 行（含测试）。每阶段完成报验证结果后再进下一阶段。

**阶段进度（2026-09-05）**：A0 ✅（写路径核实：`ctx.approval.setPolicy(agent, 'ask'|'never')` 存在，C 定案两态切换；结论与 9 事件载荷备注沉淀到仓库根 `DSH-CTX-API.md` 第 8 节）→ A ✅（9 事件归一化 + seq 守卫 + 4 隔离 store，344 tests 绿，已提交）→ B1+B2 ✅（/goal 迷你面板 + 状态栏 goal 徽标/todo 计数 + 模式徽标三合一，356 tests 绿，demo smoke 帧断言追加，已提交 60d5662）→ B3 ✅（step 分步：工具行分组头 `step N` + 无工具 step 静默 + step/end 关组 + 防御 flush + 跨会话隔离，363 tests 绿，demo smoke `step-header` 断言，已提交 d190d1b）→ B4 ✅（subagent 行：`@ <label> <os|ct>` append-only，365 tests 绿，demo smoke `subagent-line` 断言，已提交 b3cb19c）→ B5 ✅（compaction 摘要 toast：`压缩完成：<text 首行>`/空摘要占位 + 每会话最近一条 raw，368 tests 绿，demo smoke `compaction-summary-toast` 断言，已提交 e01180a）→ **C ✅**（`/policy` 两态切换 + 当前策略展示：`approval/policy` 归一化为第 10 事件 `approval-policy`，state `policyBySession` 隔离，状态栏第 4 槽位 `ask`/`auto` 徽标；`ctx.approval.setPolicy(agent, ask|never)` 写路径，宿主缺失 notice 兜底；379 tests 绿 + 4 条 policy smoke 断言，已提交 e584a09）。P2 六项能力全部完成。 → **P3 事件显示批次**（2026-09-12）：8 个新 DshEvent（workflow/command/code-dispatch/hook/schedule/compaction-prune/feedback/retry-started），14 个 rc.2 事件归一化接入，payload 均已对照 rc.2 核实；393 tests 绿，demo mock 注入 P3 事件批次（含 ↻ 重试行）；权限预设 `/permission`（目录 + 转发写路径，main.ts 已接线 ctx.permissionPresets）；`/compact`、`/feedback` 为宿主自带命令，TUI 命令转发即可用，无需代码（依赖宿主装配 command-compact/command-feedback）。S-M 批量完成，剩余 jobs（M-L）与 deferred 项待排期。

> **（2026-09-17 变更）状态栏 goal/todo 徽标移除**：右侧顶部状态列已详显 goal 阶段与 todo 列表，状态栏不再重复显示 `goal:<phase>` 与 `todo n/m`（模式/策略/预设/任务徽标保留）；B1 阶段原「状态栏 goal 徽标 + todo 计数 slot」相应移除，`/goal` 面板与顶部状态列不受影响。
