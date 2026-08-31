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
  layout.ts      # 四区域帧：顶部(插件窄条+历史) / 状态区 / 输入行 / 审批弹窗；保留宽度/viewport/buildFrame
  layout/
    markdown.ts   # 宽度原语 + markdown 行内/块级纯解析（2026-08-31 从 layout.ts 拆出）
  status.ts      # 系统状态区数据源：StatusTicker 合并节流读取 cwd/git/time
  commands.ts    # 纯函数：模型目录格式化/规格解析 + slash 路由/决策（2026-08-31 拆出）
  question-transition.ts  # 问答纯状态转换（2026-08-31 拆出）
  model-transition.ts     # 模型选择纯状态转换（2026-08-31 拆出）
  components/    # TextInput、ScrollView（历史区）、ApprovalPrompt、QuestionPrompt、ModelPicker（纯渲染）
  adapter/
    dsh.ts       # ctx 订阅 → 写入 state；审批/发消息 → 回调 DSH；保留 installSessionModelSelection + createRealDshAdapter
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

屏幕自上而下切分为：**顶部区域**（左侧插件窄条占位 + 右侧对话历史）、**系统状态区**（按宽度可溢出多行）、**输入区**（含审批弹窗形态）：

- **高度分配**：顶部高度 = `rows - 状态区(1) - 输入区(1) - 分隔行(2)`（审批弹窗时输入区更高，沿用 `max(4, rows*0.3)`）；「中间与底部满足显示需要，剩余高度全部由上方两个填充」；`buildFrame` 输出顺序为 顶部区 → 横线分隔行 → 状态区 → 横线分隔行 → 输入/审批。
- **插件窄条**：固定 `PLUGIN_WIDTH=2` 列，仅最左一列竖线 `│` 区分左右分区，其余留白；无边框、无标题、本轮不读取插件数据。
- **历史区**：按 `historyWidth = cols - pluginWidth` 换行，沿用 scrollback 语义（wrapping、followBottom、scrollOffset、2000 行上限）。
- **状态区**：横向单行 `12:00:00|~/proj|main|—|—|—`（六段：时间/路径/git/模型/上下文/缓存；无标题、仅值，`|` 分隔；默认前景色，路径段染蓝；推理状态段已移除）。超宽按显示宽度截断。通用配色：边框/分隔线（分离行、顶部竖线）统一灰色，输入栏为默认前景色（不切半个 CJK；不用 emoji 避免宽度模型偏差）。2026-08-28 起颜色经 `src/renderer/theme.ts`（内嵌 fff 的 fffdark/ffflight 两份 truecolor 调色板）解析，`AppState.themeId` 决定取色（/theme 切换并同步 Screen 基底色），见 IMPLEMENTATION.md「/theme 命令」。
- **输入区提示**：提示符两个字符。左字符 = 上次提交所用模式符号（`>` / `$` / `/`，经 `MODE_SYMBOL[lastSubmitMode]` 映射），颜色随状态（绿/黄/红）；右字符 = 当前输入模式符号（`>` 普通 / `$` shell / `/` slash，默认前景色，不着色）。`inputMode`（normal/shell/slash）经右字符 `MODE_SYMBOL` 表映射；`inputStatus`（success/running/failure）决定左字符颜色（经 `STATUS_PROMPT_COLOR` 表）；`lastSubmitMode`（提交时记录、随后回退 normal 不影响）决定左字符符号（复用 `MODE_SYMBOL` 表）；`buildFrame` 组装 `colorFor(theme, STATUS_PROMPT_COLOR[inputStatus])(MODE_SYMBOL[lastSubmitMode]) + MODE_SYMBOL[inputMode] + ' '` 作预着色 prompt 传 `renderTextInput(text, cursor, placeholder, width, promptText, promptColor?)`（promptColor 省略；宽度按未着色文本经 `displayWidth` 计算，ANSI 序列不计宽）。模式是为瞬态临时模式：输入框为空时按 `$`/`/` 切换并吞键（同符号幂等；`!` 为普通字符、不再是模式键），**任何提交（普通/slash/shell）后自动回退 normal**，不再有 Esc 回退；**输入框为空时按 Backspace 也从 `$`/`/` 回退 normal**（切了模式不输入可反悔）。状态颜色 3 态直接映射 `inputStatus`：正常提交置 `running`，`agent-status` 的 thinking/tool 兜底置 `running`，`turn-end` 置 `success`，本地可检测的无效 slash 命令置 `failure`；**活跃守卫**——`agentStatus` 非 idle 时绿/红结果一律压回黄，仅空闲后可见。按键：Esc 打断运行（agent 非 idle 时调 `adapter.interrupt()`；idle 无操作，picker 面板 Esc 仍为关闭面板，**审批弹窗打开时仅 y/n 应答、其余按键吞掉不打断**）；Enter 排队/发送；Alt+Enter（解码层 ESC CR/LF → `meta+enter`）先 `adapter.interrupt()` 再发送。占位提示固定「Type a message…」。
- **turn 分隔**：`turn-begin`（回合开始：App 在提交用户消息前或首条思考/正文到达时触发）→ `appendTurnSeparator` 往 buffer 追加 `TURN_SEPARATOR` 横线行；`turn-end` 仅清遗留思考、不再画线。`appendStream` 遇到末行为分隔线时不合并（硬边界，下个 turn 另起一行）。
- **会话流对话式展示**（2026-08-27）：历史 buffer 使用结构化行类型。模型正文靠历史区左侧，右缘按 `assistantMaxBodyWidth`（= 宽度 - `messageGutter`）保留与用户块左缘对称的空位，与右对齐的用户输入形成左右交错的视觉（`messageGutter` 默认 4，可配置）；用户消息由 App 本地回显，渲染为**整体靠右的收缩块**——先按 `userMaxBodyWidth`（= 宽度 - `USER_MIN_LEFT_GUTTER`）换行（含显式换行），取最大行宽作块宽，整块统一 leftPad、右缘贴历史区右缘，块内文本左对齐，续行共享同一左边界。用户块与随后回答/思考之间空一行（`wrapBufferLines` 后处理，纯布局不改 state）。reasoning 流作为临时 thinking 行显示，仅以 2 空格缩进区分（无 [思考] 前缀文字），最多保留最近几行并显示折叠提示，首条正文或 turn-end 到达后立即清除，不提供展开/收起交互。模型正文支持终端 markdown 子集（只作用于最终回答，思考不经 markdown）：行内粗体/斜体/`***粗斜***`（同段粗+斜）/删除线(`~~`)/下划线(`__`)/代码（主题专用灰底 `CODE_BG`：暗色深灰、浅色浅灰）/链接与自动链接（蓝下划线）/图片（`[alt]`+URL 占位）/反斜杠转义（标点按普通文本，不触发样式）。块级 fenced 代码块（`wrapBufferLines` 维护 `inFence` 跨行状态，块内原样不解析，整行灰底补齐到内容区宽、语言标签灰斜体）、标题（青粗体）、引用（单层灰竖线前缀、正文灰不加斜、正文开头残留 `>` 隐藏，不做嵌套）、任务列表（未完成 `[ ]` 灰 / 已完成 `[x]` 勾选灰可辨识 + 正文灰色删除线）、无序列表统一 `•`、有序列表保留数字、分隔线（灰横线）。解析全部在布局层（`parseInlineMarkdown(text, themeId)` → `wrapSegments` 按显示宽度换行 → 序列化 manual ANSI），buffer 只存纯文本；样式段跨软换行每行独立开关，ANSI 转义不参与宽度计算、截断透传不切断。上标/下标（`^`/`~`）与嵌套格式暂不实现。
- **用户提问面板**（2026-08-30）：模型调用 `ask_user_question` 时，DSH 经 `user-questions` 服务询问用户——TUI 注册 `registerProvider({ask})` 接收，归一化为 `DshEvent {type:'question'; id; questions[]}`，footer 区弹「第 n/m 题」问答面板（`QuestionPrompt.ts` 纯函数，footer 优先级 approval > question > picker > 输入栏）。数据模型对齐官方 0.1.1-rc.2 `AskUserQuestionItem`（id/question/header/detail/options/multiSelect/intent.kind='plan-review'）。多题一次 ask 整批回答（`{answers:[{id, selected[], custom?}]}`，空回答照交、agent 自适）：单题视图 + 第 n/m 导航，**Enter 非末题进下一题、末题提交**。**「自定义回答」是固定在选项列表末位的兜底项**（无预设选项时列表仅此一项），与普通选项一样用 ↑/↓ 高亮，高亮在其上时键入字符即输入自由文本（空格输入空格、退格删末字、可即时回显修改）；单选时预设与自定义互斥（选预设清空已输入文本），多选二者并存。**底部操作提示只显示实际用到的按键**：Enter 文案区分「下一题/提交」、多题才显示「切题」、有预设选项才显示「空格 选择」与「↑/↓ 选项」。选项标记纯 ASCII：光标列 `>`/空格 + 选中列 `*`（单选）/`+`（多选）/空格（未选中对齐）。`plan-review` intent 以「计划卡片」呈现 detail、标题「计划审批」。Esc 仅 `cancelQuestion()`（reject ask，绝不 interrupt）。

### 状态区数据流

`StatusTicker`（`status.ts`）以固定间隔 tick，**一次 tick 内合并查询 cwd/git/time**（不重复 fork 子进程），聚合为单个 `Partial<SystemStatus>` 经 `{type:"status"}` reducer 更新。模型/上下文长度/缓存命中率无数据源，保持占位 `—`。queries 与 schedule 均可注入（测试断言调用次数）；真实实现：`process.cwd()` + `git status --porcelain --branch`（execFile，1.5s 超时，失败回 `—`）。

## DSH 集成配置（主题与流式显示）

- 展示类配置在 `apply()` 配置边界由 `normalizeTuiDisplayConfig` 一次性归一化（非法值告警回退默认），经 `main()` → `App` → `initialState` 下传，app 内不再校验：
  - `streamTypewriter`（默认 true）：思考打字机总开关；false 恢复原速（思考与正文均即时）。
  - `streamCharsPerSecond`（默认 120，域 1..2000）：思考打字机流速；收到正文后剩余思考自动加速到 200 字符/秒放完再铺正文，**每个 turn 结束后回落初始速度**；按码点切分不拆 emoji；低速用分数累计保证逐字输出。正文回复本身不受限速（即时显示）。
  - `thinkingMaxLines`（默认 4，域 1..50）：思考区显示行数上限（逻辑行），超出折叠为提示行。
  - `messageGutter`（默认 4，域 0..20）：用户块左缘/回复右缘对称留空列数（交错布局；0 表示右缘顶满）。
- theme（`dark|light`）由配置注入、`/theme` 会话内切换不落盘（见 IMPLEMENTATION「/theme 命令」）。

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
