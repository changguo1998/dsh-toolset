# @dsh-toolset/tui

DSH（DeepSeek Harness）进程内集成的终端 UI 插件：复用 DSH 核心服务（会话、Agent 驱动、审批链等），提供 Web UI / CLI 之外的第三种交互方式。自研极简渲染层驱动，不依赖 Ink / Solid-TUI / node-pty，运行时唯一依赖 `chalk`。

| 文档 | 类型 | 内容 |
|---|---|---|
| `DESIGN.md` | design | 架构设计：术语与模块划分、Box 排版模型、四区域布局、DSH 事件接入、规划与边界 |
| `SPEC.md` | spec | 规范性规格：Box 类型与布局算法、内容元素映射、缩进语义、面板原语、FocusFrame、渲染契约、主题契约、不变量 |
| `IMPLEMENTATION.md` | implementation | 实现要点：命令路由、文本管线、状态/渲染机制、性能、各子系统实现记录 |
| `COMMANDS.md` | 参考 | 命令面清单（本地 + 宿主注册）与扩展建议 |
| `COMMANDS-SPEC.md` | 参考 | 命令扩展规格：落点矩阵、服务获取与降级硬约定、输出三型、共享面板契约 |
| `REFACTOR.md` | 约定 | 模块拆分原则、文件归属、触发标准 |
| `NOTICE-LEVELS.md` / `AUDIT-colors.md` | 参考 | notice 级别约定 / 灰度三语义颜色约定 |

历史文档（已完成的重构任务与调研记录）见仓库根 `archive/`。

## 启动

`bin/tui.js` 是零第三方依赖的 delegating launcher：

- **真实链路**：目标 profile（默认 `fff`，可用 `DSH_TUI_PROFILE` 覆盖）已安装本 bundle 时，委托 `dsh --profile <p>` 启动——profile 树内 cordis 以插件方式调用 `main.ts` 的 `apply(ctx)`，创建会话、拉起 agent 并组装 renderer + app + real adapter；argv 与退出码原样透传。
- **无 DSH 退化**：无可用 profile 或传 `--demo` 时运行 mock demo（renderer + app + mock adapter 全栈走通，不触碰 DSH）。

```sh
tui            # 双态自动判定
tui --demo     # 强制 mock demo（无 DSH 依赖）
tui --help
```

### 作为 bundle 挂载到 profile

```jsonc
// <profile>/package.json
{
  "dependencies": { "@dsh-toolset/tui": "link:<本包路径>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsh-toolset/tui"] } }
}
```

```sh
dsh --profile <p> --dump-config        # 应出现 - id: tui 行
dsh --profile <p>                      # 启动（需要真实终端；真实链路还需模型凭据）
```

本地开发用 `link:` 依赖：构建产物经 symlink 实时可见，源码变更后无需重新安装（勿用 `file:`——install 时复制快照且不跟踪目录内容变化）。从 npm 分发的正式安装形态为 `dsh plugin --profile <p> add <包名>`。

## 界面布局

屏幕自上而下分四区（`layout.ts` 纯函数组装，几何见 `SPEC.md` §11.3）：

```
│ 会话标题（左列标题栏）              │ Mode  plan on | sandbox wr | policy ask │
│ ────────────────────────────────   │ ────────────────────────────────────── │
│ 对话历史（user / assistant 交错）    │ Goal active                            │
│ ...(更早回复已折叠)                   │ <objective>                            │
│ ────────────────────────────────   │ ────────────────────────────────────── │
│ 活动区（思考 / 工具 / notice，瞬态）  │ Todo 1/3                               │
│                                    │ ○ 待办 / ● 进行中 / ✓ 完成              │
────────────────────────────────────┬──────────────────────────────────────────
12:00:00 · main ↑1 +2 ~3 · ~/proj | deepseek-v4-pro:high · ctx 13.3k(11%) · cache 98%
───────────────────────────────────────────────────────────────────────────────
> 输入消息…                            <- 输入区（多行框）
[Alt+Enter]打断并发送 · [Ctrl+L]重绘 · [Ctrl+J]输入换行 · [/help]更多命令
```

- **顶部区域**：左列为会话标题栏 + 对话历史区 + 活动区，右侧为常驻状态列（`statusColumnDivisor`，默认 1/3 宽、最低 20 列，历史区保底 10 列）。两区之间为分隔竖线；活动区与历史区之间为实线 `─`，状态列块间与回合之间为虚线 `╌`。
- **系统状态区**：占 1 行（内容超宽时按组折行）。
- **交互区**：输入框 + 按键提示区，常规终端固定 4 行（输入 3 + 提示 1）；矮终端按 1/5 收缩，至少 2 行。
- 顶部与状态区、状态区与交互区之间各有一条横线分隔行（`SEPARATOR_ROWS=2`）。

### 会话标题栏

标题行（前景色；空标题显示灰色 `<title>` 占位）+ 实线下划线。标题优先取官方 `dsh-session-title` 服务落盘的 `session/title` 事件折叠结果；缺失时本地兜底为被恢复会话首条用户消息前 30 字符，无消息为 `（新会话）`。标题栏行数由对话区承担（不影响活动区高度），极矮终端先收掉下划线、再整栏省略，保证对话区非空。

### 对话历史区

- **会话流**：模型正文靠左、右缘留白；用户消息回显为整体靠右的收缩块（块内左对齐、右缘贴历史区右缘、右缘竖线 `┃` 亮红），用户输入与回答之间空一行。左右留白列数默认 6（`messageGutter`）：输入最长折行的左缘与回复正文第 5 个字符同列。
- **多行输入**：`Ctrl+J` 显式换行，一次输入视为**一块**——块内各行行首左对齐、块宽 = 该块折行后最长行、整块右对齐。
- **渐进窗口 + 语义锚点**：只物化最近 3 个回合组，更早内容在顶部显示 `...(更早回复已折叠)` 占位；上滚接近窗口顶部时按 3 组步长自动增窗。视口位置锚在「(buffer 行, 行内换行序号)」上，故底部新增内容、窗口缩放、终端 resize 都不会顶走正在看的内容。
- **回合分隔**：每个回合开始时插入横线分隔行，turn 结束不画线。

### 活动区

每回合瞬态的思考 / 工具调用 / notice / 非 final 中间输出**按时间顺序混合显示**，不做类型分组；内容自 pane 底边往上长（恒底部对齐），填满整块 pane 后才折叠最早内容，可上滚回看。

- **清空时机**：只在「用户输入开启的回合」清空（提交消息、或排队消息被核心认领）；核心自发的回合（goal 轮次、定时唤醒等）保留上一轮内容继续往上堆。
- **思考打字机**：真实链路下 reasoning 按打字机节奏放缓显示（初始约 120 字符/秒；正文到达后剩余思考加速到 200 字符/秒放完再铺正文，turn 结束后回落初始速度）。思考以紫色竖线 `┃` 标识；`streamTypewriter: false` 或 mock demo 保持原速。
- **工具行**：`bash <摘要>`（无前缀图标），结果 `✓ <首行>` / 失败红色 `✗ <详情>`；每步以 `╌╌ step N ╌╌╌…` 整行虚线分隔，连续两次调用之间不空行。
- **详略两态**：`/verbose off` 紧凑模式把每条目压成 1 行 + 行尾 `…`，便于高密度浏览长任务输出。
- **面板优先**：审批 / 问答 / 模型选择 / 各列表面板打开时占满活动区可视行，瞬态行本帧让位。

### 状态列

自上而下若干块，块间以虚线 `╌` 分隔：

- **Mode 块**：`plan` / `sandbox` / `permission` / `policy` / `preset` 以 `|` 分隔连续排布，每项列出全部可选项、生效项着色强调（plan 青；sandbox/permission 按危险等级 ro 绿 / wr 黄 / full 红；policy ask 绿 / auto 红；preset 洋红）、其余灰。无会话数据时整块省略。
- **Goal 块**：标题 `Goal <phase>`（Goal 蓝、phase 按 active/complete 绿、paused 黄、blocked 红）+ objective；blocked 时附黄色阻塞原因。
- **Todo 块**：标题 `Todo 完成数/总数`（蓝）+ 列表（`○` 待办 / `●` 进行中（黄，续行同色）/ `✓` 完成（对号灰、正文灰 + 删除线））。
- **Jobs 块**：标题 `Jobs 运行中/总数`（蓝）+ 任务行（`●` 运行中黄 / `✗` 失败红 / `○` 取消灰 / `✓` 已完成灰 + 删除线）。

**折叠策略**：整体不溢出时完整显示；超高时按等级整体尝试、首次放下即采用——L0 不折叠 / L1 隐藏已完成条目 / L2 仅保留进行中条目（goal 压成标题行）/ L3 进行中条目也压为 1 行；隐藏条目以 `…(+N项已隐藏)` 收尾，全部等级仍放不下则整列行级截断 `…(+N行)`。折叠在渲染期按窗口高决定，不改状态。焦点在状态列时 `PgUp/PgDn` 滚动。

### 排队消息

agent 工作中提交的消息经官方流程立即交给核心（`followup`，`next-turn` 队列，逐条不合并），本机只登记「已交给核心、本回合尚未认领」的文本用于显示：钉在历史 pane 可视窗口右下角，右对齐用户块 + **灰色**右缘竖线 `┃`（区别于已发出消息的亮红竖线），不随历史滚动；核心开始新回合认领该条时，它转正为历史里的用户消息。历史视口相应收缩若干行。`Esc` 与 `Alt+Enter` 会把登记内容按提交顺序退回输入框。

### 系统状态区

按类分组，**组间 `|`、组内 `·`**：

- **环境组** `时间·git·cwd`：git 段格式 `分支 ↑N ↓N +N ~N -N`（`↑` 领先上游 / `↓` 落后 / `+` 未暂存新增 / `~` 未暂存修改 / `-` 未暂存删除，计数为 0 省略，干净仓库只显分支名，非 git 仓库或读取失败显 `—`）。
- **LLM 组** `provider/model:{后缀}·ctx·cache`：后缀为思考等级——`none` 不支持思考 / `off` 未开启 / `on` 单等级开启 / 多等级时显示实际等级名；未显式选择等级时按 provider 默认等级显示，与本次请求生效的 effort 一致。`ctx` 取最近一次模型调用的上下文占用（`(input+cacheRead)`，模型窗口已知时附百分比），`cache` 为缓存命中率；无数据时保持 `—` 占位。

宽度足够时单行完整显示；放不下按段折行（组完整不丢内容），单组超行宽才组内压缩（cwd 保尾、model 保 effort 后缀、git 保分支 + 统计符号簇）。数据由 `StatusTicker` 合并节流读取（5s 一次，一次 tick 批量查 cwd/git/time，避免高频 fork 子进程）。

### 输入区与按键提示区

- 提示符两个字符：左字符 = 上次提交所用模式的符号（`>` 普通 / `$` shell / `/` slash），颜色随上一条命令状态（成功绿 / 运行黄 / 失败红）；右字符 = 当前输入模式符号（默认前景色）。
- 输入模式：普通文本提交走官方 `followup`；`$` shell 目前仅符号展示（提交同普通消息）；`/` slash 命令自动补 `/`。输入框为空时按 `$`/`/` 切换模式并吞键（同符号幂等），按 Backspace 回退 `>`；任何提交后自动回退 `>`。
- 输入框为多行框：文本按显示宽度换行向下展开（顶部对齐，续行与首行文本起点对齐），光标行超出高度时整体跟随滚动。`Ctrl+J` 输入换行（`Enter` 提交）。
- 按键提示区（1 行，与输入区之间不画横线）：`[Alt+Enter]打断并发送 · [Ctrl+L]重绘 · [Ctrl+J]输入换行 · [/help]更多命令`；命令补全打开时替换为补全键位，历史会话面板按其阶段显示自己的提示。

### 命令补全

输入处于首个命令 token 时（slash 模式即输入框内容，其它模式需字面 `/` 开头），活动区显示候选面板——候选 = 本地命令目录 + 宿主命令注册表（`ctx.commands.list`，同名本地优先），前缀匹配、默认高亮最匹配项。`Tab` 接受（写入命令名 + 尾随空格）、`↑/↓` 选择、`Esc` 收起、`Enter` 仍为提交。面板只占活动区（标题 + 候选行铺满可视行），超出可视行的候选直接丢弃不滚动。

## 会话流渲染

模型正文渲染终端 markdown 子集（只作用于最终回答，思考过程不渲染）。行内：`**加粗**`、`*斜体*`、`***粗斜***`、`~~删除线~~`、`__下划线__`、`` `行内代码` ``（主题专用灰底）、`[文字](url)` 与 `<https://…>`（蓝下划线，无点击交互）、`![alt](url)`（占位显示 `[alt]` 与 URL）、反斜杠转义。块级：fenced 代码块（灰底补齐到行宽、语言标签斜体、块内不解析）、`# 标题`（去 `#`、青粗体）、`> 引用`（单层竖线、正文不加斜）、任务列表 `- [ ]`/`- [x]`、无序列表（统一 `•`）/ 有序列表（保留数字）、`---` 分隔线、markdown 表格（见下）。列表项折行采用悬挂缩进（续行与首行正文同列）。未闭合 / 嵌套 / 歧义标记按普通文本原样保留；嵌套格式（多层引用、嵌套列表等）暂不支持；`^上标^`/`~下标~` 保持原样。

**表格**：表头行 + `| --- |` 分隔行，其后连续含 `|` 的行成表体。列宽在构建期算死——左缘 1 列 `┃`（与正文左竖线同色同列，逐行连续），其后 1 空格间隔，列间 `│`（末列不画），表头下 `═` 双横线（交叉处 `╪`），数据行之间 `─` 单横线（交叉处 `┼`）；网格线用默认前景色，表头加粗；`:---`/`:--:`/`---:` 三态对齐，未显式标注时数字列自动右对齐；格内按行内格式解析、矮格垂直居中。超可用宽按水位法压缩（窄列保自然宽、超宽列格内折行），连最小宽都放不下则格内 `…` 截断，可用宽不足则退回原样文本行。

**控制字符清洗**：流式文本进入 buffer 前统一清洗——CRLF / 孤立 CR 归一为换行，其余 C0/C1 控制字符（含 Tab、孤立 ESC）剔除，完整 ANSI 转义序列保留。本回合若有剔除，turn 结束后以黄色 toast 提示「已过滤 N 个非打印控制字符」。

## 符号规范化

对**模型正文**做符号治理（展示层替换，不改会话记录；工具输出不替换，但会提醒模型避免），`/symbol-unify on|off` 控制（缺省 on）——关闭时正文原样展示、不替换不提醒。三态：

1. **放行**：正常文字、推荐符号、治理区外字符、以及**正文内容性排版字符**（表格框线 `─ │ ┌ ┐ └ ┘`、方块元素 `█ ▀ ▄`、数学括号 `⌈ ⌉ ⌊ ⌋`、键盘按键 `⌘ ⌃ ⌥ ⇧ ⇪ ⌫`、数学乘号 `×`）——信息载体而非治理对象，原样且零反馈。
1. **归一**：命中别名的变体替换为推荐符号，turn 结束后反馈模型（emoji 起源的替换罗列「X→Y」要求更换，细线变体只报计数）。
1. **警示**：治理区（箭头 / 杂项技术 / Dingbats / 几何 / emoji 全集 / 全角符号）内无替代的白名单外符号——保留原样，反馈模型改用推荐符号或文字。

开启 `warnModel`（默认）时，替换与警示合并为一条 `[符号规范]` 反馈，turn 结束后立即直发给模型（不等下一条输入），notice 同步给人看。**同符号冷却**：某符号被反馈过一次后进入冷却（时间窗 `cooldownMs` 默认 10 分钟、run 次数 `cooldownRuns` 默认 3，任一维度未过期即仍冷却），冷却期内不再对该符号反馈（展示层替换照常），避免「模型讨论符号本身 → 每轮反复提醒」。

内置推荐白名单：`✓ ✗ △ → ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ▶ ◀ ▲ ▼ ▷ ◁ ▽ ⟸ ⟹ ⟺ • ◦ ○ ● ◯ ■ □ ◇ ◆ ⓘ 〜 …`。

| 域 | 推荐（代表） | 归一到代表 |
|---|---|---|
| 状态 | `✓ ✗ △` | `✔ ✅ ☑ 🗹 → ✓`；`✕ ✖ ✘ ❌ 🗙 ☒ 🗷 → ✗`；`⚠ → △` |
| 方向箭头 | `→ ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙` | `➔ ➜ ➡ ➠ ➢ ➣（→）`；`⬅ ⬆ ⬇（← ↑ ↓）` |
| 三角箭头 | 实心 `▶ ◀ ▲ ▼`；空心 `▷ ◁ △ ▽` | 实心 `▸ ► ⏵ ⏩ ➤`（→ 同向代表）、`🔺 🔼（→ ▲）`、`🔻 🔽（→ ▼）`；空心 `▹ ▻（→ ▷）`、`◃ ◅（→ ◁）`、`▵（→ △）`、`▿（→ ▽）` |
| 几何 | `■ □ ◇ ◆` | `▫ ◻ 🔳 🔲 → □`；`◽ ▪ ◼ ⬛ ⬜ 🟥 🟦 🟧 🟨 🟩 🟪 🟫 → ■`；`🔷 🔹 🔶 🔸 ⬥ ⬧ → ◆`；`⬦ ⬨ → ◇` |
| 圆域 | `• ◦ ○ ● ◯` | `⭕ → ○`；`⚪ ⚫ 🔴 🔵 🟠 🟡 🟢 🟣 🟤 ⬤ → ●` |
| 双线推导 | `⟸ ⟹ ⟺` | `⇐ → ⟸`；`⇒ → ⟹`；`⇔ → ⟺` |
| 加减 / 金额 / 波浪 | ASCII `+ -`；`¥ ¢ £ ₩`；`~`（1 列）/ `〜`（2 列） | `➕ ➖ → + -`；全角 `￥ ￠ ￡ ￦ → ¥ ¢ £ ₩`；`～ → 〜` |
| 信息 / 感叹 / 问号 | `ⓘ`；ASCII `!` `?` | `ℹ → ⓘ`；`❗ ❕ → !`；`❓ ❔ → ?` |

不纳入（使用即提醒）：星标域 `★ ☆ ✦ ✧` 与 `⭐`（无推荐代表）、双线/特殊笔触 `⇢ ⇝`、图形族 `💡`、带圈数字 `❶` 等。

## 配置

### 插件参数（profile `cordis.patch.yml` 的 `tui` 节点）

```yaml
- id: tui
  name: '@dsh-toolset/tui'
  config:
    theme: light                # dark | light（默认 dark）
    streamTypewriter: true      # 思考打字机总开关（默认 true）
    streamCharsPerSecond: 120   # 思考打字机初始流速（默认 120，合法域 1..2000）
    messageGutter: 6            # 用户块左缘 / 回复右缘对称留空列数（默认 6，合法域 0..20）
    toolBootstrap: true         # 锚定工具引导（默认 true，仅 deepseek-v4-pro 生效）
```

缺省或非法值回退默认并在启动时告警；改后需重启 `dsh --profile <p>`。`streamCharsPerSecond` 只在 `streamTypewriter: true` 时生效，按码点切分不拆 emoji/CJK。默认 `messageGutter: 6` 使输入最长折行的左缘与回复正文第 5 个字符同列；要让它对齐回复的第 k 个字符，配置 `messageGutter: k+1`。

**锚定工具引导（`toolBootstrap`，默认 true）**：移植 [dsh-anchored-standard](https://github.com/Jungod1121/dsh-anchored-standard) 的两阶段工具锁定-释放——按会话首个真实用户消息分类（spec / react / weak），首请求仅暴露 `bash` + `read`（spec 加 `edit`、react 加 `write`，`glob`/`grep` 永不进入）并把 persona 作为唯一 prompt section、清空 contexts；会话记录首次 `tool/call` 后解锁全量工具目录并恢复完整 sections。仅对 `deepseek-v4-pro` 生效，其它模型或 `toolBootstrap: false` 时原样透传；promotion 状态按会话记忆（resume 保留），任何异常降级为全量目录（fail-open）。

### `TUI/tui.config.json`

```jsonc
{
  "layout": {
    "footerHeight": 4,               // 交互区绝对行数（可选；缺省 min(4, max(2, rows/5))）
    "activityHeightDivisor": 2,      // 活动区高 = 顶部内容高 / 此值（默认 2）
    "activityTopRow": null,          // 活动区分隔行锚定："half" 或绝对行号（0 基）；缺省走 divisor
    "activityPlacement": "vertical", // vertical（默认）| horizontal | auto（按黄金分割比自动选）
    "statusColumnDivisor": 3         // 状态列宽 = 终端列数 / 此值（默认 3）
  },
  "notify": {
    "enabled": true,                 // 终端 bell 总开关（默认 true）
    "idleThresholdMs": 8000          // 等待输入超过该阈值补响一次（默认 8000，最小 1000）
  },
  "session": {
    "autoCleanEmpty": true           // 启动 / 退出自动清理空会话（默认 true，显式 false 关闭）
  },
  "symbols": {
    "recommended": ["★"],            // 追加到内置推荐白名单（此后不再提醒）
    "aliases": { "♥": "●" },         // 追加 / 覆盖别名映射（变形 → 推荐）
    "warnModel": true,               // 是否向模型发提醒（默认 true）
    "cooldownMs": 600000,            // 同符号冷却时间窗（毫秒；0 关闭时间维度）
    "cooldownRuns": 3                // 同符号冷却 run 次数（0 关闭次数维度）
  },
  "theme": {
    "active": "dark",                // 启动默认主题（插件参数 config.theme 优先）
    "paletteDir": "~/fff/config/terminal-colortheme",
    "palettes": {
      "dark": { "file": "fffdark.json" },
      "light": { "file": "ffflight.json" }
    }
  }
}
```

- **layout**：`footerHeight` 省略时保持自适应，显式给出即固定绝对行数。`activityTopRow` 配置后替代比例分配——历史区与活动区的分隔行恰好落在指定行（`"half"` = `floor(rows/2)`；数字 = 绝对行号，0 基），剩余不足容纳活动区时自动让位（活动区 0 行、对话区吃满）。`activityPlacement: "auto"` 比较上下 / 左右两种排列下两个 pane 的宽高比与黄金比 φ≈1.618 的对数偏差，取较差 pane 偏差更小者，启动与 resize 时按当前帧尺寸重算；`"horizontal"` 固定左右并排（**活动区在左、历史区在右**，两 pane 等高，中间 1 列分隔竖线），此时 `activityTopRow` 不生效；不可行时回落上下（左列正文宽 < 41 列或可用行数 < 2）。判据只吃左列正文宽 + 顶部内容高，不含右侧状态列宽。
- **notify**：任务运行结束（turn-end）触发终端 bell（BEL `\x07`）；随后等待输入超过 `idleThresholdMs` 未输入再补响一次（任意输入即取消）。仅终端 bell，不做桌面通知。
- **session**：自动清理「空会话」（已持久化 + 非 live + 非当前 + 无用户消息，全目录范围），判据与 `/session` 面板的 `x` 清理一致。启动时后台异步执行；优雅退出（`/quit`、Ctrl+D、双击 Ctrl+C、插件 unload）先把提示渲染到活动区并等待清理完成再退出（5s 超时兜底），信号强退路径不保证。宿主未挂载会话服务、列表不可用或无可清理项时静默跳过。
- **symbols**：见上文「符号规范化」。`aliases` 的值是替换目标（推荐符号或文字），键为被治理的变体。
- **theme**：按「内联 `palettes.<id>` 字段 → `paletteDir/<file>.json`（上游配色单一源）→ 内置兜底快照」顺序解析；`paletteDir` 解析链为「配置值 → `$FFF_HOME/config/terminal-colortheme` → `~/fff/config/terminal-colortheme`」，显式设为 `""` 时只用内联 / 内置。语义色槽位 `gray`/`border`/`code`/`focus` 从各主题 `semantics` 解析，可经 `palettes.<id>.semantics` 覆盖。调色板在启动时读取一次（不热重载）；`/theme dark|light|toggle` 仅切换当前会话、不落盘。非法或缺失字段逐级回落并在 `[tui]` 输出告警。

## Slash 命令

以 `/` 开头的输入按命令处理（不走 `agent.followup`，不进入模型历史）。渲染相关命令由 app 层本地处理，其余经 `ctx.commands.execute` 转发宿主注册表；未命中注册表提示未知命令（fail-close，绝不把 slash 行发给模型）。

### 本地命令

| 命令 | 说明 |
|---|---|
| `/help` | 本地命令帮助（双列表格，描述超宽时续行对齐描述列） |
| `/clearscreen`（`/cls`） | 清空显示缓冲（不动会话上下文） |
| `/quit` | 关闭 renderer 退出 |
| `/verbose on\|off` | 活动区详略两态：`on`（默认）完整折行；`off` 每条目压成 1 行 + 行尾 `…` |
| `/symbol-unify on\|off` | 模型输出符号规范化开关（默认 on，会话级不落盘） |
| `/theme [dark\|light\|toggle]` | 切换调色板（仅当前会话，不落盘） |
| `/model [provider/]model` | 无参打开模型选择面板（provider / model / effort 三列同屏，`←/→` 换列、空格选中、Enter 提交）；带参直接切换（会话内生效，不落盘） |
| `/provider`、`/effort`（`/thinking`） | 打开同一模型选择面板并预置焦点列；带参只提示用法 |
| `/policy [ask\|never]` | 审批策略：无参打开状态选项面板，带参直接设置（写宿主 `approval.setPolicy`） |
| `/permission [预设名]` | 权限预设（sandbox mode + 审批策略捆绑）：无参打开面板，带参转发宿主命令 |
| `/preset [预设名]` | agent 预设：无参打开面板，带参经 `selectAgentPreset`（宿主 `recompose` 写路径）切换 |
| `/goal` | 提示 goal / todo / jobs 详情常驻右侧状态列（不再打开面板） |
| `/stats`（`/usage` `/context`） | 最近一次模型调用的 token 用量：分解（输入/输出/缓存读）、上下文占用、缓存命中率 |
| `/session` | 会话面板：列出持久化会话，Enter 切换（`agents.resume` 恢复后继续对话）；`Tab` 切换范围（当前目录 / 全部）、`Space` 批量标记（`a` 全选当前范围、`c` 清空）、`d`/Delete 删除（有标记=批量删除全部标记，无标记=删当前高亮）、`x` 清理空会话、`/session clean` 直达清理确认 |
| `/rename <标题>` | 重命名当前会话标题（写宿主 `sessionTitle.rename`；空标题或含换行本地拒绝） |
| `/copy` | 复制最后一条模型回复到系统剪贴板（OSC52，剥离 ANSI） |
| `/fork` | 分叉当前会话为新会话（宿主 `sessions.fork`，错误码映射中文提示） |
| `/settings` | 只读展示配置（`ns：value` 多行，secret 脱敏；宿主未挂载 settings 服务时提示不可用） |
| `/init` | 生成项目 `AGENTS.md`：已存在则提示并结束，缺失则注入初始化指令由模型生成 |
| `/jobs` | 后台任务面板：`↑/↓` 选择、`PgUp/PgDn` 翻页、Enter 取消、Esc 关闭 |
| `/skills [过滤]`、`/tools [过滤]` | 技能 / 工具列表面板：Enter 读取正文或详情（关面板后以 notice 展示） |
| `/agents` | 子代理面板：Enter 直接中断选中项；面板打开期间每 2s 定时刷新（`r` 手动刷新） |
| `/task`、`/guard`、`/loop` | 任务树 / 守卫记录 / 指标循环面板，Enter 查看详情 |
| `/workflows` | workflow 运行面板（只读，面板打开期间定时刷新） |
| `/memory` | 知识库概要（路径与 chunk/source 计数） |
| `/contract` | 当前会话 goal 的 Done-when 条款摘要 |
| `/council [N]` | 二次意见：并行拉起 N（默认 2、上限 4）个评审子代理汇总意见 |
| `/search <query>` | 网页搜索：并行多 provider 聚合 → URL 去重 → 相关度排序 → 列表面板（Enter 打开来源 URL） |

宿主服务缺失时相关命令提示不可用（且不空开面板）；面板型命令的主操作以 notice 反馈时先关面板再提示。

### 宿主自带命令

`/compact`、`/feedback`、`/goal`、`/permission`、`/plan` 由 dsh-base 装配的插件注册（dsh-command-compact / dsh-command-feedback / dsh-command-goal / dsh-permission-presets / dsh-plan-mode），`/export` 来自 dsh-session-log-export，均经 `ctx.commands.register` 注册。其中 `/goal` 恒为本地提示（不转发宿主），`/permission` 无参走本地面板、带参转发宿主；其余走 registry 转发即用。完整命令面与扩展建议见 `COMMANDS.md`。

## 按键

| 按键 | 行为 |
|---|---|
| `↑` / `↓` | 焦点在活动区 / 状态列时单行滚动该面板，否则对话区半屏滚动 |
| `PageUp` / `PageDown` | 焦点在活动区 / 状态列时整页滚动该面板，否则跳上 / 下一条用户输入（`PgDn` 无下一条时回到最新） |
| `Home` / `End` | 回到最新（复位渐进窗口）/ 跳到最旧（展开全部回合组） |
| `←` / `→` | 输入框光标移动 |
| `Backspace` | 删除光标前字符；输入框为空且模式为 `$` / `/` 时回退 `>` |
| `Enter` | 提交输入（普通文本走 `followup`，agent 工作中则排队；`/` 开头走命令） |
| `Alt+Enter` | 打断当前运行并发送（排队内容按时间顺序并回输入框一并发出） |
| `Ctrl+J` | 输入框换行 |
| `Esc` | 打断当前运行；agent 空闲时有排队消息则先退回输入框，否则输入框为空且面板有焦点时清除焦点；面板打开时按面板语义处理 |
| `Tab` | 输入区为空时循环切换顶部面板焦点（history / activity / status）；补全打开时接受候选 |
| `Ctrl+L` | 强制整帧重绘 |
| 可打印字符（含 CJK）/ 终端粘贴 | 插入输入框 |

**退出契约**：`Esc` 不触发退出，`Ctrl+C` 单击清空输入区（750ms 窗口内双击才退出），常规退出用 `/quit` 或 `Ctrl+D`（仅空闲且输入区为空时）。进程生命周期归 renderer，`close()` / SIGINT / SIGTERM 先恢复终端再退出，退出码随底层透传。

## 面板

审批 / 问答 / 模型选择 / 状态选项 / 各列表族面板统一显示在活动区窗口（底部交互区以空白占位、高度不变），面板打开时按键优先级归面板自身。

- **审批面板**：工具调用审批，`y` / `n` 应答；打开期间其余按键吞掉、不打断运行。
- **问答面板**（模型调用 `ask_user_question`，需 profile 加载 `@deepseek-ai/dsh-tool-ask-user`，本包 `cordis.patch.yml` 已声明）：一次可含多题（标题显示「第 n/m 题」），`Enter` 逐题推进、末题提交整批。列表底部恒有「自定义回答」兜底项——无预设选项时列表仅此一项，高亮在其上直接键入即可输入自由文本。某题未标记任何选项且无自定义输入时，`Enter` 提交当前高亮选项。选项标记纯 ASCII：行首 `>` = 当前选中（高亮），单选 `*` / 多选 `+` = Enter 时提交生效。着色为已标记选中行绿、未标记的高亮行黄（同一行两者兼具时绿优先）。`Esc` 取消本次提问（reject ask，不打断运行）；底部操作提示只显示当前实际用到的按键。
- **模型选择面板**：provider / model / effort 三列独立列表同屏，当前模型标 `*` 并附 `[current]`，焦点行标 `>`；`←/→`（或 Tab）切换焦点列，`↑/↓` 移动，空格预选、`Enter` 提交、`Esc` 取消。
- **状态选项面板**（`/policy` `/permission` `/preset`）：`↑/↓` 移动焦点、空格预选（再按取消）、`Enter` 提交（无预选时回退焦点行）并关闭、`Esc` 取消；预选行绿、未预选的焦点行黄。
- **历史会话面板**：见 `/session`；list 阶段按键提示显示在输入区下方的提示区（确认阶段为 `[y/Enter]确认 · [n/Esc]取消`）。

## 构建与测试

```sh
npm run build # tsc → dist/（无 bundler）
npm run check # tsc --noEmit 类型检查
npm run test  # node --test 全量（渲染解码 + 排版 + adapter fake-ctx 单测）
              # 仓库根 npm run test:tui -- <正则或文件名> 可过滤运行（scripts/test.sh）
npm run bench # 排版性能基准（cache off/on 三档中位耗时与倍数，报告式不设阈值）
npm run demo  # 构建后跑 mock demo（--theme light|dark；demo 不读 profile 配置）
npm run demo -- --smoke   # 帧断言冒烟（SMOKE_PASS）
npm run smoke:pty         # 真实 DSH PTY 冒烟（工具行与状态栏 usage）
npm run watch # tsc --watch 常驻编译到 dist/（仍需重启 dsh 生效）
```

排版折行 / 宽度纯函数走有界缓存（键含文本 + 列宽 + 主题，`TUI_LAYOUT_CACHE=0` 可关）；`paint()` 同 tick 合帧（真实链路默认 10Hz 上限，`AppDeps.frameIntervalMs`）。机制与基准见 `IMPLEMENTATION.md`「排版缓存与绘制合帧」。

## 已知限制

- **模型选择不随会话持久化**：`/model` 只改进程内当前选择，会话不保存、resume 后回落宿主默认模型；同进程内切换会话也可能带上先前选择。详见 `IMPLEMENTATION.md`「/model 命令」。
- 多会话并行不支持（维持单活跃会话设计）。
- 思考不提供展开 / 收起交互。
- 未接入事件（评估后暂缓）：`model/selection` 回放、`subagent/model-selection-policy`、log-only 调试类事件、审批审计对（`approval/asked` + `decided` 无界面，数据随会话持久化不丢）。
