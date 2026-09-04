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

屏幕自上而下切分为：**顶部区域**（左侧插件窄条占位 + 右侧对话历史）、**系统状态区**（按宽度可溢出多行）、**输入区**（含审批弹窗形态）：

- **高度分配**：顶部高度 = `rows - 状态区(1) - 输入区 - 提示区(1) - 分隔行(2)`。输入区+提示区为「交互区」：常规终端固定 4 行（输入框 3 + 提示 1），矮终端按 `floor(rows/5)` 收缩、至少 2 行（输入 1 + 提示 1）；提示区固定 1 行、与输入区之间不画横线，输入区取剩余（多行框）；面板态（审批/问答/模型选择/历史会话）整体占据交互区（面板自带最底行按键提示、无独立提示区），与输入态同高——面板开关不上下调整交互区高度；面板内容超出时面板内截断/滚动（问答选项按高亮行滚动窗口、选择列省略号滚动、审批正文截断）；「中间与底部满足显示需要，剩余高度全部由上方两个填充」；`buildFrame` 输出顺序为 顶部区 → 横线分隔行 → 状态区 → 横线分隔行 → 输入/审批 → 按键提示区。

- **插件窄条**：固定 `PLUGIN_WIDTH=2` 列，仅最左一列竖线 `│` 区分左右分区，其余留白；无边框、无标题、本轮不读取插件数据。

- **历史区**：按 `historyWidth = cols - pluginWidth` 换行，沿用 scrollback 语义（wrapping、followBottom、scrollOffset、2000 行上限）。

- **状态区**：横向单行 `12:00:00|~/proj|main|—|—|—`（六段：时间/路径/git/模型/上下文/缓存；无标题、仅值，`|` 分隔；默认前景色，路径段染蓝；推理状态段已移除）。超宽按显示宽度截断。通用配色：边框/分隔线（分离行、顶部竖线）统一灰色，输入栏为默认前景色（不切半个 CJK；不用 emoji 避免宽度模型偏差）。2026-08-28 起颜色经 `src/renderer/theme.ts`（内嵌 fff 的 fffdark/ffflight 两份 truecolor 调色板）解析，`AppState.themeId` 决定取色（/theme 切换并同步 Screen 基底色），见 IMPLEMENTATION.md「/theme 命令」。

- **输入区提示**：提示符两个字符。左字符 = 上次提交所用模式符号（`>` / `$` / `/`，经 `MODE_SYMBOL[lastSubmitMode]` 映射），颜色随状态（绿/黄/红）；右字符 = 当前输入模式符号（`>` 普通 / `$` shell / `/` slash，默认前景色，不着色）。`inputMode`（normal/shell/slash）经右字符 `MODE_SYMBOL` 表映射；`inputStatus`（success/running/failure）决定左字符颜色（经 `STATUS_PROMPT_COLOR` 表）；`lastSubmitMode`（提交时记录、随后回退 normal 不影响）决定左字符符号（复用 `MODE_SYMBOL` 表）；`buildFrame` 组装 `colorFor(theme, STATUS_PROMPT_COLOR[inputStatus])(MODE_SYMBOL[lastSubmitMode]) + MODE_SYMBOL[inputMode] + ' '` 作预着色 prompt 传 `renderTextInput(text, cursor, placeholder, width, promptText, promptColor?, height?)`（promptColor 省略；高度 `metrics.footerHeight`；宽度按未着色文本经 `displayWidth` 计算，ANSI 序列不计宽）。多行语义：文本按 `avail = width - promptWidth` 显示列统一换行（字符不跨行、不切半个 CJK），首行带 prompt、续行缩进 `promptWidth` 列，顶部对齐，光标行（`floor(cursorFlowCol/avail)`）超出可见窗口时按 `vshift` 整体滚动跟随，仅光标行带 `caret`。模式是为瞬态临时模式：输入框为空时按 `$`/`/` 切换并吞键（同符号幂等；`!` 为普通字符、不再是模式键），**任何提交（普通/slash/shell）后自动回退 normal**，不再有 Esc 回退；**输入框为空时按 Backspace 也从 `$`/`/` 回退 normal**（切了模式不输入可反悔）。状态颜色 3 态直接映射 `inputStatus`：正常提交置 `running`，`agent-status` 的 thinking/tool 兜底置 `running`，`turn-end` 置 `success`，本地可检测的无效 slash 命令置 `failure`；**活跃守卫**——`agentStatus` 非 idle 时绿/红结果一律压回黄，仅空闲后可见。按键：Esc 打断运行（agent 非 idle 时调 `adapter.interrupt()`；idle 无操作，picker 面板 Esc 仍为关闭面板，**审批弹窗打开时仅 y/n 应答、其余按键吞掉不打断**）；Enter 排队/发送；Alt+Enter（解码层 ESC CR/LF → `meta+enter`）先 `adapter.interrupt()` 再发送。占位提示固定「Type a message…」；输入区下方为独立按键提示区（1 行灰色，与输入区之间不画横线：`[Enter]发送 · [Alt+Enter]打断并发送 · [Esc]打断 · [Ctrl+L]重绘 · [/help]更多命令`，窄终端按显示宽度截断；审批/问答/模型选择/历史会话面板自带按键提示，不显示该区）。

- **turn 分隔**：`turn-begin`（回合开始：App 在提交用户消息前或首条思考/正文到达时触发）→ `appendTurnSeparator` 往 buffer 追加 `TURN_SEPARATOR` 横线行；`turn-end` 仅清遗留思考、不再画线。`appendStream` 遇到末行为分隔线时不合并（硬边界，下个 turn 另起一行）。

- **会话流对话式展示**（2026-08-27）：历史 buffer 使用结构化行类型。模型正文靠历史区左侧，右缘按 `assistantMaxBodyWidth`（= 宽度 - `messageGutter`）保留与用户块左缘对称的空位，与右对齐的用户输入形成左右交错的视觉（`messageGutter` 默认 4，可配置）；用户消息由 App 本地回显，渲染为**整体靠右的收缩块**——先按 `userMaxBodyWidth`（= 宽度 - `USER_MIN_LEFT_GUTTER`）换行（含显式换行），取最大行宽作块宽，整块统一 leftPad、右缘贴历史区右缘，块内文本左对齐，续行共享同一左边界。用户块与随后回答/思考之间空一行（`wrapBufferLines` 后处理，纯布局不改 state）。reasoning 流作为临时 thinking 行显示，仅以 2 空格缩进区分（无 [思考] 前缀文字），最多保留最近几行并显示折叠提示，首条正文或 turn-end 到达后立即清除，不提供展开/收起交互。模型正文支持终端 markdown 子集（只作用于最终回答，思考不经 markdown）：行内粗体/斜体/`***粗斜***`（同段粗+斜）/删除线(`~~`)/下划线(`__`)/代码（主题专用灰底 `CODE_BG`：暗色深灰、浅色浅灰）/链接与自动链接（蓝下划线）/图片（`[alt]`+URL 占位）/反斜杠转义（标点按普通文本，不触发样式）。块级 fenced 代码块（`wrapBufferLines` 维护 `inFence` 跨行状态，块内原样不解析，整行灰底补齐到内容区宽、语言标签灰斜体）、标题（青粗体）、引用（单层灰竖线前缀、正文灰不加斜、正文开头残留 `>` 隐藏，不做嵌套）、任务列表（未完成 `[ ]` 灰 / 已完成 `[x]` 勾选灰可辨识 + 正文灰色删除线）、无序列表统一 `•`、有序列表保留数字、分隔线（灰横线）。解析全部在布局层（`parseInlineMarkdown(text, themeId)` → `wrapSegments` 按显示宽度换行 → 序列化 manual ANSI），buffer 只存纯文本；样式段跨软换行每行独立开关，ANSI 转义不参与宽度计算、截断透传不切断。上标/下标（`^`/`~`）与嵌套格式暂不实现。

- **用户提问面板**（2026-08-30）：模型调用 `ask_user_question` 时，DSH 经 `user-questions` 服务询问用户——TUI 注册 `registerProvider({ask})` 接收，归一化为 `DshEvent {type:'question'; id; questions[]}`，footer 区弹「第 n/m 题」问答面板（`QuestionPrompt.ts` 纯函数，footer 优先级 approval > question > picker > 输入栏）。数据模型对齐官方 0.1.1-rc.2 `AskUserQuestionItem`（id/question/header/detail/options/multiSelect/intent.kind='plan-review'）。多题一次 ask 整批回答（`{answers:[{id, selected[], custom?}]}`，空回答照交、agent 自适）：单题视图 + 第 n/m 导航，**Enter 非末题进下一题、末题提交**。**「自定义回答」是固定在选项列表末位的兜底项**（无预设选项时列表仅此一项），与普通选项一样用 ↑/↓ 高亮，高亮在其上时键入字符即输入自由文本（空格输入空格、退格删末字、可即时回显修改）；单选时预设与自定义互斥（选预设清空已输入文本），多选二者并存。**底部操作提示只显示实际用到的按键**：Enter 文案区分「下一题/提交」、多题才显示「[←/→]切题」、有预设选项才显示「[空格]选择」与「[↑/↓]选项」。选项标记纯 ASCII：光标列 `>`/空格 + 选中列 `*`（单选）/`+`（多选）/空格（未选中对齐）。`plan-review` intent 以「计划卡片」呈现 detail、标题「计划审批」。Esc 仅 `cancelQuestion()`（reject ask，绝不 interrupt）。

- **会话切换 + 标题 + 复制（P0 会话生命周期，2026-09-02）**：`/session` 面板列出持久化会话（newest-first，live 标记 `[当前]` 不可续），Enter 对 persisted 会话执行 `adapter.resumeTo(id)` → host `agents.resume({resumeSessionId, agentOptions, setup})` 加载旧会话继续对话；单活跃会话设计——**先切活跃引用再释放旧 handle**（旧 handle 失败不阻断切换），切换后 buffer 展示该会话 surface（user/assistant 行），标题 `deriveTitle`（首条 user 前 30 字符，无消息 `（新会话）`）显示于状态栏（\<24 列窄屏省略）；`/copy` 取最后一条 assistant 正文经 OSC52（`ESC ]52;c;<base64>BEL`）写入系统剪贴板。resume 失败进面板 error 态不崩溃；resume 链 virtual（adapter 可选方法，宿主无 `agents.resume` 时提示不可用）。状态机沿用 history panel 五阶段 + 新增 `resuming`，async 结果带 id 匹配 stale guard。

- **历史会话面板**（2026-09-01；2026-09-02 起 `/session` 升级为「列表 + 切换」，只读 view 代码保留）：`/session` 打开会话面板，list 阶段由只读浏览改为**切换到 persisted 会话**（Phase 2，见下）。数据源为宿主 `ctx.get("sessionQuery")`（`@deepseek-ai/dsh-session-query` 引擎，d-base profile 已挂载；`main.ts` 注入 `createRealDshAdapter({sessionQuery, sessions})`——`sessions` 为 `ctx.get("sessions")` 会话存储服务，**不塞入 DshRuntime**；adapter 结构类型 `SessionQueryLike` 需 `listSessions()`，读取面为 `readSession?`/`readSurface?` 其一）。adapter 暴露两个**可选**方法 `listSessions(): Promise<SessionInfo[]>`（header 归一化 id/createdAt/cwd/live/persisted，newest-first）与 `readSessionSurface(id): Promise<SessionSurfaceView>`。**读取顺序（按 live/persisted 区分，2026-09-01 实测修复）**：① live 会话（在 `sessions.get(id)` 内存 store 中）→ 直接读原始事件 `events`（`Session.events` 不包含 `surfaceOp`，`readSurface` 的 surface fold 会滤光；且其混合日志含 `agent/inbox/spliced` 未 identified 事件，`readSession` 的 `Session.create` 全量校验会抛 `seed user/message ... lacks an identified message`，两条接口对 live 均不可用）；② persisted 会话 → `readSurface`（持久化时已补 `surfaceOp` 标记，surface fold 正常）；③ 兜底 `readSession`；④ 皆缺 → 抛结构化错误入 error 阶段。**归一化**：`normalizeHistoryMessages` 从原始事件提取 `HistoryMessage[]`（`{role, text}`）——兼容两种消息形态：`user/message`/`assistant/message` 的 text blocks（`reasoning`/`tool/result` v1 省略），以及**当前 dsh live 会话实际的消息形态 `agent/inbox/spliced`**（文本在 `data.inserted[].content[]`，role 取 `inserted[].role` 仅 user/assistant）。`readSurface` 必须 `sq.readSurface(id)` 直接调用（解构丢失 `this` 读 `_corpus` 报错）。`AppState.history: HistoryPanelState | null` 五阶段状态机：`loading-list → list ⇄ loading-view → view →（Esc 返回列表）`，失败入 `error`（列表加载失败/内容加载失败）；每个 async 结果 action 带 stale guard（phase 不匹配则 no-op，防面板已关闭/已切走的迟到响应误入）。`App` 层 `openHistory()`/`openHistoryView()` 承载异步与 paint（reducer 保持纯函数）；宿主未挂载 sessionQuery 时 `/session` 显示 notice「历史会话服务不可用」不打开面板。渲染 `HistoryPanel.ts` 纯函数（无 ANSI，同 ModelPicker 风格）：标题行 + 正文区占满固定交互区，列表行 `> MM-DD HH:mm  <8位短id>  .../cwd  [当前]`（live 标记、cwd 尾部按显示宽度截取、焦点行 `>` 前缀、视口滚动保证焦点可见），view 消息行 `问:`/`答:` 前缀 + 换行缩进 + 消息间空行，**无可提取文本（空会话/live 未落 assistant）时显示占位提示**；按键路由（`handleKey`，优先级 approval > question > picker > history）：list 阶段 ↑/↓ 移动、Enter 查看、Esc 关闭；view 阶段 ↑/↓ 滚动 ±1、PgUp/PgDn ±10、Esc 返回列表（records/index 保留、messages 清空）；loading/error 阶段吞键（error 可 Esc 关闭）。损坏会话（sqlite 校验失败）的 `readSurface` 结构化错误透传到 error 阶段显示。

### 状态区数据流

`StatusTicker`（`status.ts`）以固定间隔 tick，**一次 tick 内合并查询 cwd/git/time**（不重复 fork 子进程），聚合为单个 `Partial<SystemStatus>` 经 `{type:"status"}` reducer 更新。模型/上下文长度/缓存命中率无数据源，保持占位 `—`。queries 与 schedule 均可注入（测试断言调用次数）；真实实现：`process.cwd()` + `git status --porcelain --branch`（execFile，1.5s 超时，失败回 `—`）。

## DSH 集成配置（主题与流式显示）

- 展示类配置在 `apply()` 配置边界由 `normalizeTuiDisplayConfig` 一次性归一化（非法值告警回退默认），经 `main()` → `App` → `initialState` 下传，app 内不再校验：
  - `streamTypewriter`（默认 true）：思考打字机总开关；false 恢复原速（思考与正文均即时）。
  - `streamCharsPerSecond`（默认 120，域 1..2000）：思考打字机流速；收到正文后剩余思考自动加速到 200 字符/秒放完再铺正文，**每个 turn 结束后回落初始速度**；按码点切分不拆 emoji；低速用分数累计保证逐字输出。正文回复本身不受限速（即时显示）。
  - `thinkingMaxLines`（默认 4，域 1..50）：思考区显示行数上限（逻辑行），超出折叠为提示行。
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

## 能力缺口 Backlog（2026-09-03，基准 v0.1.1-rc.2）

对照官方 `deepseek-harness` v0.1.1-rc.2（= 本机安装宿主）的接口与功能盘点。rc.2 的 8 个插件可消费服务（sessions / agents / approval / userQuestions / llm / commands / sessionQuery / agentDefaultModel）已全部接入；缺口集中在**事件可视化与交互能力**（rc.2 事件词汇表 48 项，以该 tag 的 `packages/core/session/src/known-event-types.ts` 为准）。优先级依据：用户感知频率 × 实现成本（现有 DshEvent / reducer / notice / 状态栏通道可复用程度）。

### P1 — 核心体验补全（高频感知，现有通道即可落地）

| 缺口 | 通道 | 理由 |
| --- | --- | --- |
| `tool/call` + `tool/result` | 新 DshEvent + 紧凑渲染（工具名+摘要+结果折叠） | 编码代理 TUI 的第一可见性，当前完全不可见 |
| usage/cost 状态栏 | 状态栏扩展（usage chunk 已解析，零新事件） | 成本几乎为零 |
| `finish` reason | 挂 turn-end notice | 截断/失败静默是体验坑 |
| `compaction/start` + `compaction/end` | notice toast | 长会话静默压缩造成困惑 |
| `llm/retry-started` + `llm/retry` | notice toast | 重试透明化 |

### P2 — 状态可见性与交互完整（中频，需小面板或状态栏槽位）

- `goal/change`、`todo/write` — 状态区/迷你面板
- `plan/mode`、`sandbox/mode`、`permission/preset` — 状态栏模式徽标
- `step/start`|`end` — turn 内分步（依赖 P1 工具域先行）
- 审批策略切换 UI（`setPolicy` ask/never）
- `subagent/descriptor` — 子代理可见性

### P3 — 低频生态域与特性决策（toast 或暂缓）

- **生态事件**（低频/功能仍在演进）：`team/*`、`schedule/change`、`agent-preset/selected`、`tool-workflow/*`、`tool/code-dispatch*`、`hook/*`、`command/run`|`done`、`request/context`|`header`、`feedback/record`
- **审计对**（log-only，无渲染需求，仅调试视图）：`approval/asked`|`decided`|`policy`、`session/end-seed`、`session/title-llm-request`、`web/deepseek-search-llm-request`
- **特性级**（需产品决策，非渲染缺口）：session fork（`sessions.fork`）、多会话并行（P0 边界排除）、feedback 评价
- **TUI 自身渲染边界**：嵌套 markdown、上下标、thinking 展开/收起
- **0.1.2 alpha 专有**（等出 rc 再评估）：`model/selection`、`subagent/model-selection-policy`、`session-log-deepseek/delivery-accepted`

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
| `tool/call` `{turn, step, callId, name, arguments: string}` | `tool-call` `{sessionId, name, summary}` | buffer 行 `⚙ <name> <summary>`（summary = arguments JSON 关键字段启发式提取，截断一行） |
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
- **阶段 2**：渲染 + 状态栏（工具行 ⚙/✓/✗、notice tone 红/黄/灰着色、状态栏 contextLen/cacheHit、retry/compaction toast）。
- **阶段 3**：真实 DSH PTY 冒烟 happy path（`npm run smoke:pty`：真实会话断言 ⚙ 工具行与状态栏 usage）+ 本文档/IMPLEMENTATION.md/README 收尾。

backlog 状态：P1 完成；P2/P3 待排期。

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
| P2 | tool `meta` diff 展示（+N/-M） |
| P3 | 按上方 backlog 清单暂缓 |

预估总改动 ~800 行（含测试）。每阶段完成报验证结果后再进下一阶段。
