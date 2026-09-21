# @dsh-toolset/tui

本目录文档导航（等级 = design/spec/task/implementation/meta）：

| 文档 | 等级 | 内容 |
|---|---|---|
| `DESIGN.md` | design | 架构设计：现状（Part I）+ Box 重构目标态（Part II） |
| `SPEC.md` | spec | 渲染管线规格：Box 排版模型（Part I）+ RenderLine→FrameRow 渲染契约（Part II） |
| `TASKS.md` | task | 重构实施任务：契约迁移主线 A + Box 主线 B + 验收/提交拆分/待决 |
| `IMPLEMENTATION.md` | implementation | 实现细节：命令路由、文本管线、机制实现记录 |
| `REFACTOR.md` | task/约定 | 模块拆分原则、文件归属、触发标准 |
| `AUDIT-colors.md` / `NOTICE-LEVELS.md` | 参考 | 颜色审计 / notice 级别约定 |
| `COMMANDS.md` | 参考 | 命令面清单（本地 + 宿主注册）+ 对比其他 agent 的扩展建议 |
| `COMMANDS-SPEC.md` | spec | 命令扩展规格（纯 TUI 侧 7 项，已过 API 合同门）：落点/降级/共享面板与接线点/API 核实表 + 逐条规格 + 未纳入索引 |
| `COMMANDS-TASKS.md` | task | 命令扩展实施清单：批次 0 合同门与批次 1-4 四批实现全部完成，A 组 A1（`/task`）A2（`/guard`）A3（`/memory`）A4（`/loop`）A5（`/contract`）、C1（`/jobs` PgUp/PgDn）/ C2（`/agents` 定时刷新）/ P2#16（`/workflows` 面板）/ P2#18（`/council` 二次意见）/ P2#24（`/search` 多引擎聚合）已实现 + 验收命令、提交协议与待决清单 |

DSH（DeepSeek Harness）进程内集成的终端 UI 插件。复用 DSH 核心服务（会话、Agent 驱动、审批链等），提供 Web UI / CLI 之外的第三种交互方式，由自研极简渲染层驱动（不依赖 Ink / Solid-TUI / node-pty，运行时唯一依赖 `chalk`）。

```
│ 会话标题（左侧标题栏）           │ 详细状态列 │
│ ────────────────────             │ 目标: ……    │
│ 对话历史+活动区(左列)             │ [ ] todo    │
│ …… (assistant/attempt)            │             │
│ …思考/工具（瞬态，底部跟随、折叠）  │             │
──────────────────────────────┬───────── <- 横线分隔行
12:00:00|~/proj|main|—|—|—   <- 系统状态区（| 分隔；默认前景色，仅路径段蓝色；分隔线灰色；不含推理状态段）
───────────────────────────── <- 横线分隔行
> 输入消息…                   <- 回车发送, Enter 走 agent.followup
```

## 双态启动

`bin/tui.js` 是 delegating launcher（零第三方依赖，逻辑仅基于 node 内建模块）：

- **真实链路**：目标 profile（默认 `fff`，可用 `DSH_TUI_PROFILE` 覆盖）已安装本 bundle 时，bin 委托 `dsh --profile <p>` 启动——profile 树内 cordis 以插件方式调用 `main.ts 的 apply(ctx)`，创建会话/拉起 agent 并组装 renderer+app+real adapter，argv 与退出码原样透传。
- **无 DSH 退化**：无可用 profile 或传 `--demo` 时，运行 mock demo（renderer + app + mock adapter 全栈走通，不触碰 DSH）。

```

tui            # 双态自动判定
tui --demo     # 强制 mock demo（无 DSH 依赖）
tui --help

```

## 界面布局

屏幕自上而下分四区（`layout.ts` 纯函数组装，见 `DESIGN.md`「四区域布局」）：

- **顶部区域**：左侧为**对话历史区**（用户消息 + 模型正文实时流，仅保留最近 3 条模型回复、更早已灰占位 `…(更早回复已折叠)` 折叠，支持滚动 ↑/↓），历史区下部为活动区（高度 = 顶部内容高的一半（默认，可经 `activityHeightDivisor` 配），`╌` 虚线隔开、始终底部跟随展示最新；极窄终端自动压缩活动区高度以保证对话区非空）；右侧新起一列「**顶部状态列**」（约 1/3 宽窄列，显示当前会话 goal 详（goal 块首行标题 `Goal <phase>`：Goal 蓝、phase 按 active/complete 绿、paused 黄、blocked 红着色，下接 objective/阻塞原因、无「目标」前缀）+ **todo 块**（标题 `Todo 完成数/总数`（蓝）+ 列表：`○` 待办(空心圆) / `●` 进行中(实心圆、黄、换行保留色且续行缩进对齐) / `✓` 完成(对号灰不划线、正文灰+删除线)）+ **jobs 块**（标题 `Jobs 运行中/总数`（蓝）+ 任务行：`●` 运行中(黄) / `✗` 失败(红) / `○` 取消(灰) / `✓` 已完成(正文灰+删除线)）；块间以虚线 `╌` 分隔；状态列折叠策略：**整体高度未溢出时完整显示（目标/todo 全文不折叠、已完成任务不隐藏）**；仅当整体超高时折叠——**优先隐藏已完成任务**（completed todo / done jobs，计数标题仍保留），仍超高再对长内容折叠到 `STATUS_GOAL_MAX_LINES=5`/`STATUS_TODO_MAX_LINES=3` 行并提示 `…(+N行)`；无 goal/todo 直接留空（不显示占位文字）；**PgUp/PgDn 滚动状态列**）。**左列顶部为会话标题栏（由右侧状态列迁入，置于会话历史区上方）**：标题行（空标题 `<title>` 灰占位保持行稳定；前景色）+ 实线下划线（在分隔竖线处用 `┤` 连接）；标题优先官方 `dsh-session-title` 服务落盘的 `session/title` 事件折叠结果，缺失时本地兜底为被恢复会话首条用户消息前 30 字符，无消息为 `（新会话）`；标题栏行数由对话区承担（活动区高度不受影响），极矮终端自适应收缩（对话区不足 1 行时先收掉下划线、再整栏省略）。两列布局：历史/活动区在左、详细状态列在右。活动区为**每回合瞬态**：内容（思考/工具/notice/中间输出）按时间顺序混合显示、不做类型分组；新模型回合开始（turn-begin）即清空上一轮活动区（含非 final 中间输出），旧命令的活动结果被新回合结果冲掉——**每个回合只有最终总结（最后一段模型正文）进入历史区**，turn-end 时打 final 标记；顶部/状态/输入三区之间各有横线分隔行（`SEPARATOR_ROWS=2`）。**排队消息块**（agent 工作中 Enter、已交给核心但本回合尚未认领的消息）钉在历史 pane 可视窗口右下角：右对齐用户块 + 灰色右缘竖线 `┃`（区别于已发出消息的亮红竖线），不随历史滚动、上滚看旧记录时始终可见，历史视口相应收缩若干行；核心开始新回合认领该条时，它转正为历史里的用户消息（亮红竖线）。
- **系统状态区（分类分组）**：按类分组展示，**组间用 `|` 分隔、组内用 `·` 分隔**——**环境组** `时间·git/cwd·当前目录`（本机/工作区信息；git 段格式 `分支 ↑N ↓N +N ~N -N`——`↑`领先上游提交数、`↓`落后、`+`未暂存新增（未跟踪）、`~`未暂存修改、`-`未暂存删除，计数为 0 的项省略，干净仓库只显分支名，非 git 仓库/读取失败显 `—`）、**LLM 组** `模型:{后缀}·上下文长度·缓存命中率`（会话标题已迁入左列顶部标题栏，见上）。宽度足够时单行完整显示；放不下按段折行（组完整不丢内容），单组超行宽才组内压缩（cwd 保尾、model 保后缀）。模型段**与思考状态同一段，格式 `provider/model:{后缀}`**：后缀=`none`=不支持思考 / `off`=支持思考但未开启（无显式等级且 provider 未配置默认等级）/ `on`=单等级开启 / **实际等级名**（多等级开启，如 `high`/`low`/`max`）；未显式选择等级时按 **provider 默认等级（`reasoning` 配置，经 `llm.resolveModelInfo().reasoning.defaultEffort` 读取）** 显示，保证状态栏展示与实际请求生效的 effort 一致。上下文长度与缓存命中率无数据源时为 `—` 占位；模型默认 `—` 且对应思考 `none`，`/model` 切换本会话后更新且不落盘。`StatusTicker` 合并节流读取（5s 一次，一次 tick 批量查 cwd/git/time，避免高频 fork 子进程）。LLM 响应时间 / tps 等指标当前 DSH 事件无数据源，待接入后并入 LLM 组。
- **输入区**：提示符两个字符——左字符 = 上次提交所用模式的符号（`>` 普通 / `$` shell / `/` slash，随最后一次提交的模式而定），颜色随上一条命令状态（成功绿 / 运行黄 / 失败红；符号不随状态变，仅颜色变，如上个会话用 shell 执行成功 → 左字符 `$` 绿）；右字符 = 当前输入模式符号（`>` 普通 / `$` shell / `/` slash，默认前景色）。`>` 一般文本（发送始终走官方流程：立即 `followup` 交给 agent；**agent 工作中进入核心排队队列**，逐条入队、每回合认领一条，本机只把「尚未认领」的消息显示为历史区右下角的排队块（灰色右缘竖线））、`$` shell（当前仅符号展示，提交同普通消息）、`/` slash 命令（自动补 `/`，文本无需手输 `/`）。输入框为空时按 `$`/`/` 切换模式并吞键（同符号幂等；`!` 为普通字符，不再是模式键）；**任何提交（普通/slash/shell）后自动回退 `>`**；输入框为空时按 Backspace 也可回退 `>`。Esc 打断运行（agent 活跃时中断；idle 无操作）。左字符颜色 3 态：绿=上个命令成功等待、黄=任务进行中、红=上个命令失败等待。占位提示固定「Type a message…」。输入区为多行框：文本按显示宽度换行向下展开（顶部对齐，续行与首行文本起点对齐、缩进与提示符同宽），光标行超出区域高度时整体跟随滚动；审批/问答/模型选择/历史会话/任务浏览面板显示于顶部流输出（活动区）窗口、底部交互区以空白占位（高度不变）。**输入区+按键提示区共同构成「交互区」：常规终端固定 4 行（输入框 3 行 + 提示区 1 行），矮终端按 1/5 收缩、每区至少 1 行（输入 1 + 提示 1）**。输入区下方为独立的按键提示区（1 行正常前景色，与输入区之间不画横线：`[Alt+Enter]打断并发送 · [Ctrl+L]重绘 · [/help]更多命令`（Enter/Esc 与面板焦点标签已隐藏），窄终端按显示宽度截断）；审批/问答/模型选择/任务浏览面板自带操作提示，不显示该区（面板已上移到流输出窗口，提示随面板显示在顶部）；**历史会话面板的按键提示例外**：按惯例显示在输入区下方的按键提示区（`[↑/↓]移动 · [Tab]范围 · [Enter]切换 · [d]删除 · [x]清理空会话 · [Esc]关闭`，list 阶段；确认阶段 `[y/Enter]确认 · [n/Esc]取消`；view/error 阶段同理，加载/进行中阶段留空），面板标题行不内嵌键位。**命令补全**：输入仍处于首个命令 token 时（slash 模式即输入框内容，其它模式需字面 `/` 开头），活动区窗口显示候选面板——候选 = 本地命令目录 + 宿主命令注册表（`ctx.commands.list`，同名以本地优先），前缀匹配、最多 16 项、**默认高亮最匹配项**（名称最短优先），`Tab` 接受（写入命令名 + 尾随空格）、`↑/↓` 选择、`Esc` 收起，`Enter` 仍为提交；**候选超出活动区可视行时多余的直接丢弃不显示**（不滚动，`↑/↓` 与 `Tab` 接受也限定在该可视范围内）；面板**只占活动区**（标题 + 候选行铺满可视行，键位提示不放面板内），键位提示改在**输入区下方的按键提示区**显示（`[tab]补全 · [↑/↓]选择 · [esc]收起`，替换默认提示行）。
- **会话流**：模型正文位于历史区左侧、右缘与用户块左缘对称留白（左右交错，留空列数默认 4，可经 `messageGutter` 配置）；用户消息本地回显为**整体靠右的收缩块**（块内左对齐、右缘贴历史区右缘），用户输入与回答之间空一行；**历史区回滚 = 语义锚点 + 渐进窗口**：排版只物化最近 3 个回合组（更早以顶部 `…(更早回复已折叠)` 占位示意），上滚接近窗口顶部时自动按 3 组步长增窗；视口位置锚在「(buffer 行, 行内换行序号)」上，因此底部新内容、窗口缩放、终端 resize 都不会把正在看的内容顶走。**整个回合中思考/中间输出/工具/notice 全部按时间混合显示在活动区**（活动区按可视高度截断、可上滚回看，不再单独折叠思考），仅每回合最后一段模型正文（最终总结）进入历史区。真实链路下 reasoning（思考）按打字机节奏放缓显示，正文回复即时展示（思考放完后再铺正文；思考初始约 120 字符/秒，收到正文后剩余思考自动加速到 200 字符/秒再铺正文，每个 turn 结束后回落初始速度；`streamTypewriter` 开启；mock demo 保持原速；回合开始时先画分隔线、turn 结束不再画）。思考以紫色竖线 `┃` 标识，与活动区其他行同窗展示。模型正文渲染终端 markdown 子集（只作用于最终回答，思考过程不渲染）：行内 `**加粗**`、`*斜体*`、`***粗斜***`（同一段粗体+斜体）、`~~删除线~~`、`__下划线__`、`` `行内代码` ``（主题专用灰底：暗色深灰/浅色浅灰）、`[文字](url)` 链接（蓝色下划线，无点击交互）、`<https://…>` 自动链接（蓝色下划线）、`![alt](url)` 图片（占位显示 `[alt]` 与 URL）、反斜杠转义 `\*`/`\#`/`\\` 等（转义后的标点按普通文本、不触发样式；`^上标^`/`~下标~`/`_单下划线_` 暂不解析保持原样）；块级 fenced 代码块（```` ```lang ```` 灰底补齐到行宽、语言标签斜体（正常前景色）、块内不解析 markdown）、`# 标题`（去 `#`、青粗体）、`> 引用`（单层竖线前缀、正文正常前景不加斜体、正文开头残留的 `>` 自动隐藏）、`- [ ]`/`- [x]` 任务列表（均正常前景色，已完成正文删除线）、`-`/`*`/`+` 无序列表（统一显示 `•` 圆点）/ `1.` 有序列表（数字保留）、`---` 分隔线（灰色横线）、markdown 表格（表头行 + `| --- |` 分隔行，其后连续含 `|` 的行成表体；列宽在构建期算死：左缘 1 列 `┃` 竖线（与正文左竖线同色同列，逐行连续不断，含折行续行与横线行）、列间 `│` 分隔（末列不画）、表头下 `═` 双横线（交叉处 `╢`/`╪`）、数据行之间 `─` 单横线（交叉处 `├`/`┼`，内容折行时用于区分行）——网格线一律用默认前景色（不着色）、表头加粗、`:---`/`:--:`/`---:` 三态对齐且未显式标注时数字列自动右对齐、格内按行内格式解析、矮格垂直居中；超可用宽按水位法压缩（窄列保自然宽、超宽列格内折行），连最小宽都放不下则格内 `…` 截断，可用宽不足则退回原样文本行；`fence` 内与可用宽未知时不识别）。未闭合/嵌套/歧义标记按普通文本原样保留（不误删内容）；嵌套格式（多层引用、嵌套列表等）暂不支持。**流式文本进入 buffer 前统一做非打印控制字符清洗（渲染保护）**：CRLF/孤立 CR 归一为换行、其余 C0/C1 控制字符（含 Tab、孤立 ESC）剔除，完整 ANSI 转义序列（CSI/OSC）保留；本回合若有剔除，turn-end 后以黄色 toast 提示「已过滤 N 个非打印控制字符」。
- **会话切换**：`/session` 面板列出持久化会话（列表行展示标题：官方 `session/title` 事件优先，缺失本地兜底；live 会话当前活跃标 `[当前]`、其余 live 标 `[不可续]` 不可选中），Enter 即切换（单活跃会话：先释放旧 agent → `agents.resume` 恢复目标会话 → 其历史表面与标题载入 buffer/状态栏，之后可继续对话）；切换失败（损坏/缺失）面板 error 态提示不崩溃；切换后发新消息落入被恢复会话的记录。`/copy` 将最后一条模型回复（ANSI 剥离）经 OSC52（`ESC]52;c;<base64>`BEL）写入系统剪贴板。
- **会话列表范围（当前目录 / 全部）**：会话面板提供两个列表——**当前目录**（默认，与当前活跃会话同 cwd）与**全部目录**，list 阶段 `Tab` 切换。标题标明当前范围与计数：`历史会话 [当前目录]（可见/全量）`（如 `（3/12）`，一眼看出本目录有几条、全局共几条）、`历史会话 [全部]（N）`；空态区分三态——全局无会话 `（无历史会话）`、当前目录暂无会话 `（当前目录暂无会话；[Tab] 查看全部 N 条）`、当前目录无法识别 `（无法识别当前目录；[Tab] 查看全部 N 条）`（不把全量伪装成本目录）。数据只拉取一次（同一份 `listSessions()` 结果按 cwd 过滤），**切换范围不重新请求**；切换时按会话 id 尽量保留选中项，选中项在新范围不可见则回到首项。列表操作（Enter 切换 / `d` 删除 / `x` 清理）一律作用于**当前可见列表**的高亮项。
- **会话清理**：会话面板支持删除单条与按列表范围清理空会话。list 阶段 `d`（或 Delete/Backspace）对高亮会话进入二次确认，`x` 进入「清理空会话」二次确认（`y`/Enter 执行、`n`/Esc 取消，执行中吞键）；`/session clean` 等价于打开面板并直达清理确认（无可清理项时提示）。**清理范围跟随当前可见列表**——当前目录列表清理本目录空会话（确认文案给出目录路径与数量），「全部」列表清理全部目录空会话（确认文案明示范围）；当前活跃会话、live 会话、未持久化会话一律拒绝并提示。空会话判定 = 已持久化 + 非 live + 从未有用户消息（`sessionQuery` surface 首条 user 消息探针；读取失败不判空，宁可不删），列表行标 `[空]`。删除为文件级：单段 id 白名单（`[A-Za-z0-9][A-Za-z0-9_-]{0,127}`）→ 在 `sessionRoots()`（`DSH_TUI_SESSION_ROOT` → `$DSH_HOME|~/.dsh/sessions` → `~/.dsh-tui/sessions`）下按 `<project-slug>/<id>` 定位 → `realpath` 包含性校验（会话目录是指向根外的符号链接一律拒绝）→ `rmSync(recursive)`；删除/清理后重新拉取列表刷新面板并收敛高亮。结果与护栏文案显示在面板首行（面板占满活动区时 notice 不可见），同时以 notice 留痕于对话区。
- **事件化渲染**：工具调用与结果显示为独立工具行（`bash <摘要>`，无前缀图标，结果 `✓ <首行>` / 失败红色 `✗ <详情>`，独立成行、不走思考打字机）；模型回合结束后面板状态栏显示本次 token 用量（`ctx 13.3k(11%)|cache 98%`，k/M 缩写；ctx 占用百分比=(input+cacheRead)/模型上下文窗口，窗口由 llm.resolveModelInfo 披露、未披露时省略仅显绝对大小；cacheHit=cacheRead/(input+cacheRead)；无用量保持 `—`）；命令通知（notice）按 tone 4 级语义着色（log 灰=进度/状态 / info 蓝=需了解 / warn 黄=可绕开运行错误·副作用危险警示 / result 级互斥：error 红·success 绿，用户输入命令的结果一律 result 级）；长会话压缩（compaction）与模型重试（retry，如 `重试 1/2 (1.5s): TRANSPORT 连接被重置`）以 toast 提示。真实 DSH happy path 由 `npm run smoke:pty` 冒烟验证（真实会话出工具行与状态栏 usage）。状态栏按类分组（组间 `|`、组内 `·`，行数动态尽量少）：**环境组** time·git·cwd（git 段 = `分支 ↑N ↓N +N ~N -N`，0 省略；`↑`领先/`↓`落后上游、`+`未暂存新增/`~`未暂存修改/`-`未暂存删除）、**LLM 组** model:后缀·ctx·cache（标题在左列顶部标题栏）；宽度足够单行完整，不足按段折行、单组超宽才组内压缩（cwd 保尾、model 保后缀）。**思考状态并入 model 段（格式 `provider/model:{后缀}`，后缀前景色）：`none`=模型不支持思考 / `off`=支持思考但未开启（无显式等级且 provider 未配默认等级）/ `on`=单等级开启 / 多等级开启时按实际等级名显示（如 `high`/`low`/`max`）；未显式选择等级时按 **provider 默认等级（`reasoning` 配置）** 显示——状态栏与实际请求生效的 effort 一致（map：`llm.resolveModelInfo().reasoning.defaultEffort`）**。工具调用历史**不按组数折叠**——只受活动 pane 可视行数约束（内容先自下往上填满整块 pane，超出部分折叠在 pane 顶边之外，可上滚回看），连续两次调用之间不再空行分隔（紧凑拼接）；每步（step）以 `╌╌ step N ╌╌╌…` 整行虚线分隔（与历史区分隔回合的 `╌` 虚线一致，铺满活动区列宽），step 分隔行紧跟前文——其前的空白活动行（思考/notice 拖尾空段）被吸收，后续行也不再额外空行；工具行无前缀图标、工具名着黄，成功 ✓ 绿、失败 ✗ 整行红。
- **排版与绘制性能**：折行/宽度纯函数走有界缓存（键含文本 + 列宽 + 主题，`TUI_LAYOUT_CACHE=0` 可关）；`paint()` 同 tick 合帧——一 tick 一帧，事件 burst（如逐 delta 流式）不再逐帧重绘，定时/交互路径各自 tick 内出帧。`npm run bench` 报告 cache off/on 三档中位耗时与倍数（cold 33× / warm 72× / incremental 70× 量级）。机制见 `IMPLEMENTATION.md`「排版缓存与绘制合帧」。
- **事件显示（P3 批次）**：workflow 运行（`⚑ workflow: <名>`、`⤷ 成员`、结束 toast）、命令执行流（`/> <名>`，失败红行）、run_code 子派发（`⇥`，成功静默）、hooks 调用（`⌗`）、schedule 到点（toast）、compaction 剪除（toast）、feedback 确认（toast）与重试启动（`↻ 重试中 (N)`）均已接入；全部走活动区行/notice，append-only。
- **agent 预设与 /jobs 后台任务**：`agent-preset/selected` 事件接入 → 状态栏 `preset:<id>` 徽标 + `/preset` 命令（无参列可用/当前/默认，带参经 `ctx.agentPresets.recompose` 切换，宿主缺失提示不可用）；`/jobs` 后台任务面板（adapter 订阅 `ctx.jobs.onJobsChanged` 增量推送 + 打开时 `refreshJobs` 全量拉取；面板显示任务状态行，↑/↓ 选择、`PgUp/PgDn` 整页翻页、`Enter` 取消高亮任务（`ctx.jobs.kill`）、`Esc` 关闭；状态栏 `jobs N` 徽标仅计运行中；顶部状态列含 jobs 块（`Jobs 运行中/总数` + 任务状态行））。
- **宿主自带命令（`/compact` `/feedback` `/record` `/goal` `/permission` `/plan` `/export`）**：dsh-base 默认装配（经 `ctx.commands.register` 注册），除 `/goal` `/permission` 外均可直接转发即用（这两条另有本地 UX：无参走提示/面板、带参转发宿主）；`feedback/record` 确认 toast 已接入。命令面全貌与扩展建议见 `COMMANDS.md`，可实现级规格见 `COMMANDS-SPEC.md`。
- **turn 分隔**：每个回合开始时先插入横线分隔行（上一轮内容 → 分隔线 → 新回合内容），流式输出实时合入历史；turn 结束不再画线。

## 作为 bundle 挂载（在 DSH profile 中使用）

1. 创建/进入一个 profile，把本包加为依赖并声明 bundle（参见示例 profile `~/.dsh/profiles/fff`）：

```jsonc
// <profile>/package.json
{
  "dependencies": { "@dsh-toolset/tui": "link:<本包路径>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@dsh-toolset/tui"] } }
}
```

1. 核对组合树（本地 link: 依赖无需重新安装）：

```sh
# 本地开发使用 link: 依赖，无需重新安装；正式发布使用 dsh plugin add
dsh --profile <p> --dump-config        # 应出现 - id: tui 行
```

1. 启动（需要 DEEPSEEK_API_KEY 与真实终端）：

```sh
dsh --profile <p>
```

从 npm 分发的正式安装形态为 `dsh plugin --profile <p> add <包名>`（待发布后使用）；本地开发期使用 `link:` 依赖，构建产物经 symlink 实时可见，源码变更后无需重新安装。

## profile 配置（主题与流式显示）

- **内置主题**：`fffdark`（`dark`，默认）与 `ffflight`（`light`）两套 truecolor 配色；`/theme`（无参 toggle）仅切换当前会话，不落盘。
- 在 profile 的 `cordis.patch.yml` 中给 `tui` 节点加 `config` 即可配置以下项（缺省/非法值回退默认，非法值会在启动时告警）：

```yaml
- id: tui
  name: '@dsh-toolset/tui'
  config:
    theme: light            # dark | light（默认 dark）
    streamTypewriter: true  # 打字机总开关（默认 true：真实链路放缓流式正文显示）
    streamCharsPerSecond: 120   # 思考打字机流速，字符/秒（默认 120；收到正文后加速到 200、turn 结束回落；合法域 1..2000）
    messageGutter: 4        # 用户块左缘/回复右缘对称留空列数（默认 4，合法域 0..20）
    toolBootstrap: true     # 锚定工具引导（默认 true：两阶段工具锁定-释放，仅 deepseek-v4-pro 生效）
```

配置在 profile 启动时解析，改后需重启 `dsh --profile <p>` 生效。说明：`streamCharsPerSecond` 只在 `streamTypewriter: true` 时生效（mock demo 不经此配置）；`messageGutter` 同时作用于用户块左缘与回复右缘（交错对称）；`streamCharsPerSecond` 按码点切分，不会拆断 emoji/CJK。

**锚定工具引导（`toolBootstrap`，默认 true）**：完整移植 [dsh-anchored-standard](https://github.com/Jungod1121/dsh-anchored-standard) 的两阶段工具锁定-释放——按会话首个真实用户消息分类（spec/react/weak），首请求仅暴露 `bash`+`read`（spec 加 `edit`、react 加 `write`，`glob`/`grep` 永不进入）并把 persona 作为唯一 prompt section、清空 contexts；会话记录首次 `tool/call` 后解锁全量工具目录并恢复完整 sections（persona 恒定）。**仅对 `deepseek-v4-pro` 模型生效**；flash、其他模型及 `toolBootstrap: false` 时原样透传（零改动）。promotion 状态按会话记忆（进程内 + 会话事件派生，resume 保留）；任何异常降级为全量目录（fail-open），绝不阻塞会话。

## 布局配置（窗口尺寸，tui.config.json）

`TUI/tui.config.json` 控制三处窗口尺寸（语义「总：目标」——比例项为分母，目标 = 总数 / 值；缺省/非法回落默认）：

```json
{
  "layout": {
    "footerHeight": 4,                 // 交互区绝对行数（可选；缺省自动 min(4, max(2, rows/5))）
    "activityHeightDivisor": 2,        // 活动区高 = 顶部内容高 / 此值（1/2 → 2）
    "activityTopRow": null,            // 活动区分隔行锚定（可选；"half"= 屏幕中线行，或绝对行号；缺省 null = 走 divisor 比例）
    "activityPlacement": "vertical",   // 历史区/活动区排列（缺省 "vertical" 恒上下；"auto" = 按黄金分割比自动选上下/左右）
    "statusColumnDivisor": 3           // 状态列宽 = 终端列数 / 此值（1/3 → 3；状态列最低 20 列，历史区保底 10 列）
  }
}
```

- `footerHeight` 省略时保持自适应（不小终端撑坏）；显式给出即固定绝对行数。
- `activityTopRow` 配置后**替代** `activityHeightDivisor` 的比例分配：历史区与活动区之间的分隔行恰好落在指定行（`"half"` = `floor(rows/2)` 屏幕中线；数字 = 绝对行号，0 基）；剩余不足容纳活动区时自动让位（活动区 0 行、对话区吃满），不越界。
- `activityPlacement`（**黄金分割比自动排列**）：
  - `"auto"`：比较「上下」与「左右」两种排列下历史 pane / 活动 pane 的宽高比与 φ≈1.618 的对数偏差，取较差 pane 偏差更小的排列——等分时判据等价于「左列正文宽 / 可用行数 > φ → 左右排」，即区域比 φ 更扁（宽而矮）时左右并排更接近黄金矩形。启动与终端 resize 时按当前帧尺寸重新判定（不需要重启）。
  - `"horizontal"`：固定左右并排（**活动区在左、历史区在右**）。两 pane 等高（顶部内容高 − 标题栏），活动 pane 宽 = `floor(左列正文宽 / activityHeightDivisor)`，中间留 1 列内部分隔竖线（下划线行交汇 `┬`、状态区分隔行交汇 `┴`）；此时 `activityTopRow` 不生效。**活动区内容恒底部对齐**（两种排列一致：自 pane 底边往上长，填满整块 pane 后才折叠最早内容）。
  - 不可行时回落上下：左列正文宽 < 41 列（两侧各需 ≥20 列）、或可用行数 < 2 行。
  - 判据只吃「左列正文宽 + 顶部内容高」，**不含**右侧状态列宽（状态列由 `statusColumnDivisor` 单独决定）。
- 修改后重启 `dsh --profile <p>`（或 `npm run demo`）生效；缺失/非法文件不崩溃，回落默认。

## 声音提醒配置（notify，tui.config.json）

**P2#33**：任务运行结束、以及等待用户输入超过阈值时触发终端 bell（BEL `\x07`）。默认即可用（开启 + 8s 阈值）；经 `tui.config.json` 的 `notify` 段配置：

```json
{
  "notify": {
    "enabled": true,           // bell 总开关（可选；缺省 true）
    "idleThresholdMs": 8000    // 等待用户输入超过该阈值(ms)补响一次（可选；缺省 8000，最小 1000）
  }
}
```

- 触发点：`turn-end`（任务运行结束）响一次；随后等待用户输入，超过 `idleThresholdMs` 未输入再响一次（任意输入即取消本次等待）。
- 仅终端 bell（终端响铃/视觉闪烁），不做桌面通知（notify-send 等）；无外部依赖。
- 非法/越界字段回落默认；不新增依赖。

## 会话维护配置（session，tui.config.json）

自动清理空会话（默认开启；`tui.config.json` 设 `session.autoCleanEmpty: false` 关闭；开启后于两个时机执行：每次启动 TUI 时后台异步删除；优雅退出时（/quit、Ctrl+D、双击 Ctrl+C、插件 unload）先把提示渲染到活动区并等待清理完成、完成后再关闭退出，信号强退（SIGINT/SIGTERM/崩溃）路径不保证。清理对象为"空会话"——已持久化 + 非 live + 非当前 + 无用户消息，全目录范围）：

```json
{
  "session": {
    "autoCleanEmpty": true   // 启动/退出自动清理空会话（可选；缺省 true，显式 false 关闭）
  }
}
```

- 清理判据与 `/session` 面板 `x` 清理一致（同 `cleanableSessionIds` 语义），范围固定"全部目录"；当前活跃/live 会话天然排除。
- 删除走 `deleteSession`（文件级，安全 id + realpath 包含性校验）；结果经活动区 notice 汇报（清理 N 个、部分失败时附失败数）；宿主未挂载会话服务、列表不可用或无需清理时静默跳过，不阻塞启动。
- 缺省开启（main.ts 接线默认）；如不希望自动清理，在 `tui.config.json` 显式设 `session.autoCleanEmpty: false` 即可关闭。

## 模型输出符号规范化（symbols，tui.config.json）

对**模型正文**做符号治理（展示层替换，不改会话记录；工具输出不替换，但会提醒模型写命令/脚本时避免）。三态：

1. **免治理**：正常文字/推荐符号/治理区外/**正文内容性排版字符**（表格框线 `─ │ ┌ ┐ └ ┘`、方块元素 `█ ▀ ▄`、数学括号 `⌈ ⌉ ⌊ ⌋`、键盘按键 `⌘ ⌃ ⌥ ⇧ ⇪ ⌫`、数学乘号 `×`——信息载体而非治理对象）→ 原样、零反馈；
1. **归一**：命中别名的变体（如 `✔ ✅ ☑ → ✓`、`❌ ☒ → ✗`、`⚠ → △`、`⚪ ⭕ → ● ○`、`▫ → □`、`⬜ ▪ → ■`、`🔶 → ◆`、`🔺 → ▲`）→ 展示层替换为推荐符号，turn-end 反馈模型：emoji 起源替换罗列「X→Y」要求更换、细线变体只报计数；
1. **警示**：治理区（箭头/杂项技术/Dingbats/几何/emoji 全集/全角符号）内无替代的白名单外符号 → 保留原样，turn-end 反馈模型改用推荐或文字。

`warnModel` 开启（默认）时，替换与警示**合并为一条 `[符号规范]` 反馈**，在 turn-end 检测到后**立即直接发送**给模型（不等用户下一条输入）；notice 同步给人看（保留至下次用户输入清活动区）。

**同符号冷却（2026-11）**：某符号被反馈过一次后进入冷却，冷却期内不再对该符号反馈（展示层替换照常）——避免「模型讨论符号本身 → 每轮反复提醒」的循环。双维冷却：时间窗 `cooldownMs`（缺省 10 分钟）与 run 次数 `cooldownRuns`（缺省 3），任一维度未过期即仍冷却、都过期才解冻可再次反馈；显式传 `0` 关闭对应维度、两个都为 `0` 关闭冷却。冷却对 emoji 罗列、变体计数、警示列表独立生效——全被冷却时该 turn 完全静默。

```json
{
  "symbols": {
    "recommended": ["🚀"],              // 追加到内置推荐（内置：✓ ✗ △ → ▶ ⟹ …）；该符号此后不再提醒
    "aliases": { "❤": "heart" },        // 追加/覆盖别名映射（变形 → 推荐）
    "warnModel": true,                   // 是否向模型发提醒（缺省 true）
    "cooldownMs": 600000,                // 同符号冷却时间窗（毫秒，缺省 10 分钟；0=关闭时间维度）
    "cooldownRuns": 3                    // 同符号冷却 run 次数（缺省 3；0=关闭次数维度）
  }
}
```

内置推荐白名单：`✓ ✗ △ → ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ▶ ◀ ▲ ▼ ▷ ◁ ▽ ⟸ ⟹ ⟺ • ◦ ○ ● ◯ ■ □ ◇ ◆ ⓘ 〜 …`。箭头按「域 × 家族」选型（2026-09-21）：

| 域/家族 | 代表（推荐） | 族内候选（归一为代表） | 备注 |
|---|---|---|---|
| 状态 | `✓ ✗ △` | `✔✅☑🗹→✓`；`✕✖✘❌🗙☒🗷→✗`；`⚠→△` | `☑`/`☒` 与追加符号区 `🗹`/`🗷`（方框勾/叉）为**特例**（2026-11）：带独立方框但并入无框的 ✓/✗，不单独成族；`√`（根号）与 `×`（数学乘号，治理区外）放行 |
| A 方向箭头 | `→ ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙`（八向 + 双向全推荐） | `➔ ➜ ➡ ➠ ➢ ➣（→）`；`⬅ ⬆ ⬇（← ↑ ↓）` | 按「方向一致」归一：各方向黑箭头/变体归一到该向细线代表（2026-11）；若终端把箭头渲染为 2 列（Ambiguous 宽渲染），建议配置 recommended 改用 ASCII（`->` 等） |
| 加减 | ASCII `+ -` | `➕ ➖ → + -` | 优先推荐 ASCII；带圈数字（`❶` 等）不归一不推荐、使用即提醒（用 `1)` 文字序号） |
| 金额 | `¥ ¢ £ ₩`（半角） | `￥→¥`；`￠→¢`；`￡→£`；`￦→₩` | 全角 ￥/￠/￡/￦ 归一半角 ¥/¢/£/₩（半角治理区外、无渲染异构）；`$ €` 天然放行 |
| 圆域 | `• ◦ ○ ● ◯` | `⭕→○`（圆环）；`⚪⚫🔴🔵🟠🟡🟢🟣🟤⬤→●` | 空心点/实心点/空圈/实心圆/大空圈全推荐（圆几何、宽 1 稳定；空心/实心各成一族）；emoji 按「设计含色数」归类：纯色（含 ⚪ 白）→ 实心 ●，仅 ⭕（圆环，内空腔）→ ○；`⬤`（U+2B24 黑大圆，同 ● 仅大小）→ ● |
| 波浪 | `~`（1 列）/ `〜`（2 列，U+301C） | `～ → 〜` | 全角波浪 ～ 归一到 U+301C；1 列用 ASCII `~` |
| B 三角箭头 | `▶ ◀ ▲ ▼`（实心四向）；`▷ ◁ △ ▽`（空心四向） | 实心：`▸ ► ⏵ ⏩ ➤ → ▶`、`◂ ◄ ⏴ ⏪ → ◀`、`▴ ⏶ ⏫ → ▲`、`▾ ⏷ ⏬ → ▼`、`🔺🔼→▲`、`🔻🔽→▼`；空心：`▹ ▻ → ▷`、`◃ ◅ → ◁`、`▵ → △`、`▿ → ▽` | 实/空心各成一族（族间不互相归一）；族内各方向与其同向的其它三角归一到该向代表（2026-11）；`△` 亦为 ⚠ 警示目标 |
| 几何 | `■ □ ◇ ◆` | `▫◻🔳🔲→□`；`◽▪◼⬛⬜🟥🟦🟧🟨🟩🟪🟫→■`；`🔷🔹🔶🔸⬥⬧→◆`、`⬦⬨→◇` | 实心/空心方块与菱形全推荐（□ U+25A1、■ U+25FC、◇ U+25C7、◆ U+25C6 为代表；空心/实心分族）；emoji 纯色（含 ⬜ 白）→ 实心 ■；双色按钮（🔳🔲 方块按钮，带边框）→ 空心 □（2026-11 订正）；◽（观感实心）→ 实心 ■；文本空心变体（⬦⬨）→ ◇；键盘键（`⌘` 等）为正文内容性字符、一律放行 |
| C 双线/推导 | `⟸ ⟹ ⟺` | `⇒→⟹`（右）、`⇐→⟸`（左）、`⇔→⟺`（双向） | 各方向双线归一到该向长双线代表（2026-11：⟸ U+27F8 / ⟹ U+27F9 / ⟺ U+27FA 同族，短双线 `⇒⇐⇔` 归一） |
| D 特殊笔触 | （不纳入） | `⇢ ⇝` | 使用即提醒 |
| 列表·圆点 | `•` | — | `◦`（空心圆点）为空心一族代表、已推荐放行；三角点（`‣ ⁃` 通用标点区自然放行）、方块 `▪ ▫` 归一到 `■ □`（见几何行） |
| 星标 | （不纳入） | | `★☆✦✧` 与 emoji `⭐` 均无推荐代表（星标域无白名单）：一律按警告处理、不归一，使用即提醒 |
| 信息·圈 i | `ⓘ` | `ℹ` | 感叹/问号族推荐 ASCII `!`/`?`（`❗❕→!`、`❓❔→?` 归一）；图形族（`💡`）不纳入，使用即提醒 |

判定顺序：零宽跳过 → **正文内容性排版字符放行**（框线/方块元素/数学括号/键盘按键 `× ⌫` 等，信息载体）→ 别名替换 → 治理区内查推荐（命中放行/未命中记提醒）→ 文字与常用标点放行 → 其余放行。

**开关**：`/symbol-unify on|off`（缺省 on）——`off` 时模型正文原样展示，不替换、不提醒（状态为会话级，重启回默认）。

## 主题配置（theme，tui.config.json）

调色板外置为可配置项（启动时读取一次，改后重启 `dsh --profile <p>` 生效）：

```json
{
  "theme": {
    "active": "dark",   // 启动默认主题 dark|light（可选；缺省 dark；
    //                      另有插件参数 config.theme 更高优先）
    "paletteDir": "~/fff/config/terminal-colortheme", // 调色板目录（可选）
    "palettes": {
      "dark":  { "file": "fffdark.json" },
      "light": { "file": "ffflight.json" }
    }
  }
}
```

- **解析优先级**：内联 `palettes.<id>` 字段 → `paletteDir/<file>.json`（上游单一源）→ 内置兜底快照。内联可覆盖 `ansi`（8 项 #RRGGBB）/`bright`/`background`/`foreground`；`file` 缺省 `fffdark.json`/`ffflight.json`。
- **paletteDir 解析链**：配置值 → `$FFF_HOME/config/terminal-colortheme` → `~/fff/config/terminal-colortheme`；`"paletteDir": ""` 显式禁用文件查找（只用内联/内置）。`~/fff` 是选配环境（fff 配色单一源），缺目录时静默回落内置兜底。
- **语义色槽位**：`gray`/`border`/`code`/`focus` 从各主题 `semantics` 解析（不再按主题名/ID 推断），可经 `palettes.<id>.semantics` 覆盖：值可为字面 `#RRGGBB` 或槽位引用 `ansi.N`/`bright.N`。内置默认 = 当前上游配色快照（dark：gray=bright.0、border=ansi.4、code=ansi.0、focus=bright.7；light：gray=bright.0、border=ansi.4、code=ansi.7、focus=ansi.0）。
- 生效时机：启动读取一次，不做热重载；`/theme dark|light|toggle` 仅当前会话切换调色板，不写回配置。
- 非法/缺失字段逐级回落并记告警（`[tui]` 输出），不崩溃。

## 构建 / 测试

```sh
npm run build # tsc → dist/（无 bundler，Node CLI）
npm run check # tsc --noEmit 类型检查
npm run test  # node --test 全量（renderer 解码 + adapter fake-ctx 单测）
npm run bench # 排版性能基准（cache off/on 三档中位耗时与倍数，报告式不设阈值）
npm run demo  # 构建后跑 mock demo（演示主题：npm run demo -- --theme light|dark；缺省回落 tui.config.json theme.active；demo 不读 profile 配置）
npm run watch # tsc --watch 常驻：源码变更自动编译到 dist/（仍需重启 dsh 生效）
```

- `files` 发布字段覆盖 `dist/`、`bin/` 等；`cordis.patch.yml` 由 `package.json` 的 `dsh.bundle.patch` 引用。
- 事件契约与归一化映射见仓库根 `DSH-CTX-API.md` 与 `src/…/adapter/dsh.ts` 文件头。

## Slash 命令

以 `/` 开头的输入按 slash 命令处理（不走 `agent.followup`，不进入模型历史/会话记录）：

- **渲染相关命令 → 本地小命令表**（app 层直接处理，不经 adapter）：
  - `/help` — 显示本地命令帮助
  - `/clearscreen`（简写 `/cls`）— 清空显示缓冲（只清 UI，不动会话上下文）
  - `/quit` — 关闭 renderer 退出
  - `/verbose on|off` — 活动区详略两态（SPEC §6.8）：`on`（缺省）每条目完整折行；`off` 紧凑模式——每条目压成 **1 行 + 行尾 `…`**（条目内换行折叠为空格，宽度按活动 pane 宽扣前缀列），便于高密度浏览长任务输出；无参/非法参数只提示用法与当前状态，不切换。仅当前会话，不落盘
  - `/session` — 会话面板：列出持久化会话（newest-first，live 会话标记 `[当前]` 不可续），Enter 切换到选中的 persisted 会话（先释放当前 agent，再经 host `agents.resume` 恢复继续对话；resume 失败进面板 error 态不崩溃）；`Tab` 切换列表范围（默认当前目录 / 全部）、`d`/Delete 删除选中会话（二次确认）、`x` 清理空会话（范围跟随列表范围，二次确认）、`/session clean` 直达清理确认（文件级删除：安全 id + realpath 包含性校验；清理范围跟随列表范围（当前目录 / 全部））
  - `/copy` — 复制最后一条模型回复到剪贴板（OSC52 序列 `ESC ]52;c;<base64>BEL`，ANSI 剥离后写入；无回复时提示）
  - `/goal` — goal/todo 查看提示：goal、todo、jobs 详情**常驻右侧顶部状态列**（goal 块标题 `Goal <phase>`（Goal 蓝、phase 状态色：active/complete 绿、paused 黄、blocked 红）+ objective/阻塞原因、todo 块 `Todo 完成数/总数`（`○`/`●`黄/`✓`对号灰+正文灰删线，超高时优先隐藏已完成项）、jobs 块 `Jobs 运行中/总数`，PgUp/PgDn 滚动；状态栏不显示 goal/todo 徽标）。输入 `/goal` 仅提示「详情见右侧信息栏」，不再打开面板
  - `/policy [ask|never]` — 审批策略两态切换：无参打开**状态选项面板**（↑/↓ 选、空格预选、Enter 提交并关闭、Esc 取消），显式 `ask`/`never` 直接设置；经 `ctx.approval.setPolicy(agent, policy)` 写宿主，状态栏以 `ask`/`auto` 徽标展示当前策略（宿主未挂载审批服务时提示不可用）
  - `/permission [预设名]` — 权限预设（sandbox mode + 审批策略捆绑）：无参从 `ctx.permissionPresets` 读目录并打开**状态选项面板**（空格预选、Enter 提交转发宿主后关闭）；带参转发宿主 `/permission <name>`（宿主校验并写 `permission/preset` + `approval/policy`）。宿主未挂载权限预设服务时提示不可用
  - `/preset [预设名]` — agent 预设目录：无参从 `ctx.agentPresets` 读目录并打开**状态选项面板**（空格预选、Enter 提交 `selectAgentPreset` 后关闭）；带参经 `selectAgentPreset`（`recompose` 写路径）切换当前会话预设，宿主未挂载时提示不可用（**当前默认 profile 未装配 `dsh-agent-presets`，/preset 提示不可用；接口已按 rc.2 核验，装配该服务的环境即生效**）
  - `/jobs` — 后台任务面板（只读列表 + Enter 取消）：adapter 订阅 `ctx.jobs.onJobsChanged` 增量刷新 + 打开时全量拉取；↑/↓ 选择、`PgUp/PgDn` 整页翻页（页高 = 活动区可视行数，与共享面板同 `frameGeometry` 口径）、`Enter` 取消、`Esc` 关闭；状态栏 `jobs N` 徽标计运行中任务，宿主未挂载 jobs 服务时提示不可用
  - `/init` — 初始化项目 `AGENTS.md`：检查当前目录（会话 cwd，回退进程 cwd）下是否已存在 `AGENTS.md`；已存在则提示并直接结束（不发送任何消息），缺失则以一条初始化指令（`INIT_PROMPT`）注入当前会话，由模型阅读目录内容、总结后生成 `AGENTS.md`（本地回显用户行 `/init`）
  - `/stats`（别名 `/usage` `/context`） — 显示**最近一次模型调用**的 token 用量（非会话累计）：info 三行——分解（输入/输出/缓存读）、上下文 `input+cacheRead`（占窗口百分比；`contextWindow` 缺失或为 0 时只显绝对量、不除零）、缓存命中率 `cacheRead/(input+cacheRead)`（分母为 0 显 `n/a`）；本回合尚未发生模型调用时提示暂无数据。读 `state.usage`，零新服务、不改 adapter
  - `/rename <标题>` — 重命名当前会话标题：经 `sessionTitle.rename(live Session, title)`（`ctx.sessionTitle`）写宿主，成功提示「已重命名为「\<标题>」」；无参 → 用法提示，标题为空/含换行本地拒绝（不发服务调用），宿主未挂载标题服务 → 提示不可用；标题栏由既有 `session/title` 事件链路刷新（不手工改 state）
  - `/skills [过滤]` — 技能目录**共享列表面板**（活动区窗口）：adapter 经 `ctx.skills.list()` 拉取并归一化为行（`名称 — 描述首行`），可选过滤参数在归一化阶段按名称/描述/适用场景子串匹配；`↑/↓` 移动、`PgUp/PgDn` 整页翻页（页高 = 活动区可视行数）、`Enter` 读取正文（`ctx.skills.get(name)`）并**关闭面板后**以 notice 展示（面板占活动区会遮住瞬态 notice，与 `/jobs` 一致）、`Esc` 关闭；宿主未挂载 skills 服务 → 提示不可用且**不空开面板**
  - `/agents` — 子代理**共享列表面板**（活动区）：adapter 经 `ctx.subagents.listChildren(当前会话 id)` 拉取并归一化为行（`label · mode · activity`，诊断条目显示原因并**灰显**）；`↑/↓` 移动、`PgUp/PgDn` 整页翻页、`Enter` **直接中断**选中项（`ctx.subagents.interrupt(id, { kind: 'user', parentSessionId })`，面板内高亮即选择，照 `/jobs` 先例不引入二次确认）、`r` 手动刷新、`Esc` 关闭；**宿主无 subagent 状态事件面，面板打开期间每 2s 定时刷新**（C2，`agentsRefreshIntervalMs` 可配）；无可中断 id 的条目 → 说明提示且不发调用；两者都先关面板再提示（面板占活动区会遮住瞬态 notice）
  - `/tools [过滤]` — 工具目录**共享列表面板**（活动区）：adapter 经 `ctx.tools.schemas()`（省略 scope = 全局视图）拉取并按 filter 过滤（工具名子串，SPEC §2.1）；`↑/↓`、`PgUp/PgDn` 翻页（工具数量通常数十条）、`Enter` 经 `ctx.tools.get(name)` 取详情（名称 + 描述 + 参数 schema）并关面板后以 notice 展示、`Esc` 关闭；宿主未挂载 tools 服务 → 提示不可用且不空开面板
  - `/settings` — 只读展示全部配置：adapter 经 `ctx.settings.describe()`（枚举 ns + 当前值，`SettingsDescriptor[]`）归一化为 `ns：value` 多行 info notice（secret 项脱敏为 `<redacted>`）；宿主未挂载 settings 服务 → 提示不可用；**只读不写**（写回涉及真实配置与 `expectedRevision` 乐观锁，另立规格）
  - `/fork` — 分叉当前会话为新会话：adapter 经 `ctx.sessions.fork(activeSessionId)`（后两参省略 = 源会话最后事件 + store id 策略），成功 → success 提示新会话 id（与当前不同时提示用 `/session` 查看/切换），5 个错误码（`SESSION_NOT_FOUND`/`SESSION_NOT_LIVE`/`SESSION_ALREADY_EXISTS`/`INVALID_BOUNDARY`/`OPEN_TURN`）映射中文 → warn；宿主未挂载 sessions 服务 → 提示不可用
  - `/task` — 任务面板（A1，挂 task-engine 只读查询面）：adapter 经 `ctx.taskEngine.query()` 先序展平任务树（嵌套缩进 + 状态 + 待拆分标记）为共享面板行，`Enter` 经 `taskDetail(id)` 查看详情（标题/状态·帧栈位置/ id/需拆分，共 4 行）后关面板、`Esc` 关闭；宿主未挂载 taskEngine 服务 → 提示不可用且不空开面板
  - `/guard` — 守卫面板（A2，挂 security-guard 只读查询面）：adapter 经 `ctx.guard.recent()` 归一化拦截/放行记录（工具名 + 放行/拦截·原因摘要，拦截行红、放行行绿）为共享面板行，`Enter` 经 `guardPolicy()` 查看策略快照（启用/黑名单/敏感文件/拦截计数，4 行）后关面板、`Esc` 关闭；宿主未挂载 guard 服务 → 提示不可用且不空开面板
  - `/memory` — 知识库概要（A3，挂 knowledge-base 只读查询面）：adapter 经 `ctx.knowledge.getSummary()`（同步优先，否则 `whenReady()` 等待）展示概要 notice——就绪 → info（路径 + chunk·source 计数，3 行），未就绪 → info 说明；宿主未挂载 knowledge 服务 → 提示不可用
  - `/loop` — 循环面板（A4，挂 metric-loop 只读查询面）：adapter 经 `ctx.metricLoop.list()` 归一化活动/历史循环（目标命令或 id + 状态·方向·轮数·best·更新时间，运行中黄/已停止灰）为共享面板行，`Enter` 经 `loopDetail(id)` 查看详情（id/状态·停止原因/方向·目标/轮数·窗口·best，4 行）后关面板、`Esc` 关闭；宿主未挂载 metricLoop 服务 → 提示不可用且不空开面板
  - `/contract` — 契约概览（A5，notice 型）：取当前会话 goal 快照的 `objective`（state.goalBySession），经 `adapter.contractSummary` 解析 `Done-when:` 段为条款摘要（目标 + 条款数 + 前 3 条 check，≤4 行）以 info 展示；goal-contract 当前不 expose ctx 服务，TUI 以内置同构回读兜底（包入口直读不可行：TUI 无跨包依赖、根无 workspaces、`file:` 依赖被项目约定禁止）；无目标或解析失败 → warn
  - `/workflows` — 工作流运行面板（P2#16，只读列表）：adapter 维护 `tool-workflow/*` 事件（run-start/agent-start/agent-end/run-end，runId 分组）为 `WorkflowRunLike` 集合，打开时经 `refreshWorkflows()` 归一化行（name + 阶段·成员 N/M；running → 黄 active、done → 灰 inactive）并复用共享列表面板展示；宿主未挂载 workflowEngine → 提示不可用且不空开面板；面板打开期间定时刷新（C2 同款 interval）以反映增量；Enter 只读无操作、Esc 关闭
  - `/council [N]` — 二次意见（P2#18，notice 型）：adapter 经 `subagents.start`（ctx.subagents 启动面，one-shot）并行拉起 N（默认 2、上限 4）个评审子代理对当前目标（goal 快照 objective、无则最近用户输入）各自给独立意见，`Promise.allSettled` 汇总（`council（成功/总数）` + 每行 `评审 i：意见首行`）；stopReason=error／无输出的评审判定失败降级保留序号；宿主未暴露 start → 提示不可用且不假启动
  - `/search <query>` — 网页搜索（P2#24，列表面板）：**多引擎聚合为 TUI 侧职责**——`dsh-web` seam 是 provider-**selecting**（`search()` 运行单个所选 provider，多 provider 无显式 id 抛 `WEB_PROVIDER_AMBIGUOUS`，非聚合）；adapter 组装 provider 集合（`ctx.web` 派生一个 + `options.searchProviders` 注入更多）并行调用，合并 → URL 去重 → query-token 关联度降序 → 归一化行（title 缺省回落 URL host、detail=`[provider] · snippet`、payload=url），`Enter` 查看来源 URL、翻页复用共享面板；单 provider 失败降级保留其余；全部失败 → warn 不空开面板
  - `/model [provider/]model` — 会话内切换模型（不落盘）：无参打开**模型选择面板**（三列 provider/model/effort 同屏，初始焦点在 model 列，←/→ 换列、空格选中、Enter 提交、Esc 取消；effort 列初始高亮 = 当前显式等级，未显式选择时按 provider 默认等级）；带参直接切换（`provider/model` 或跨 provider 唯一的 model id）
  - `/provider`、`/effort`（`/thinking` 同义） — 无需参数打开同一个模型选择面板，并预先把焦点列放到 provider / effort 列；带参提示 usage（不做隐式切换）
- **宿主自带命令（dsh-base 默认装配，转发即用）**：`/compact`（`dsh-command-compact`）、`/feedback` `/record`（`dsh-command-feedback`）、`/goal`（`dsh-command-goal`）、`/permission`（`dsh-permission-presets`）、`/plan`（`dsh-plan-mode`）、`/export`（`dsh-session-log-export`）——均经 `ctx.commands.register` 注册（其中 `/goal` `/permission` 本地有路由：无参走提示/面板，带参形态转发宿主），其余命令 TUI 无本地路由、走 registry 转发；完整命令面与扩展建议见 `COMMANDS.md`，可实现级规格见 `COMMANDS-SPEC.md`。
- **其他功能命令 → commands 注册表**（官方 `dsh-commands` 机制）：输入路由到 `adapter.runCommand` → `ctx.commands.execute(agent, line)`，结果/错误经 `notice` 事件展示在 UI 缓冲。未命中注册表 → 提示未知命令（官方 fail-close 策略，绝不把 slash 行发给模型）。
- demo 模式无 commands 注册表，非本地 `/xxx` 回提示。

## 按键

| 按键 | 行为 |
| --------------------------- | -------------------------------------------------------------------------- |
| `↑` / `↓` | 滚动对话历史 1 行 |
| `PageUp` / `PageDown` | 滚动顶部状态列 10 行（详细 goal/todo） |
| `Home` / `End` | 回到底部 / 跳到顶部 |
| `←` / `→` | 输入框光标移动 |
| `Backspace` | 删除光标前字符；输入框为空且模式为 `$`/`/` 时回退到普通模式 `>` |
| `Enter` | 提交输入（普通文本 → agent（立即 `followup`，官方排队语义）；`/` 开头 → slash 命令；**agent 工作中的消息排队**，逐条入队、每回合认领一条） |
| `Alt+Enter` | 打断当前运行并发送（先 `adapter.interrupt()` 再发送；本机登记的排队内容按时间顺序并回输入框一并发出） |
| 可打印字符（含 CJK） | 插入输入框 |
| 终端粘贴（bracketed paste） | 插入粘贴文本 |
| `y` / `n` | 审批弹窗确认 / 拒绝 |
| `Esc` | 打断当前运行（agent 活跃时中断；有排队消息时先把排队内容退回输入框，可编辑后重发；idle 无操作；不再回退输入模式，提交后自动回 `>`） |
| `Tab` | 输入区为空时循环切换顶部面板焦点（history/activity/status）；slash 补全候选打开时接受当前候选 |
| `Ctrl+L` | 强制整帧重绘（绕过 delta 优化） |

## 退出契约

进程生命周期归 renderer：`close()` / SIGINT / SIGTERM 先恢复终端再退出；退出码随底层（`dsh` 委托场景透传，demo 场景 renderer 自行 exit）。

> 按键退出：`Esc` 与 `Ctrl+C` 不再触发退出（避免误触丢会话）；请用 `/quit` 命令退出。系统信号（SIGINT/SIGTERM）仍正常处理。

## 用户提问面板（ask_user_question）

模型调用 `ask_user_question` 工具、DSH 经 `user-questions` 服务询问用户时，TUI 弹出问答面板应答。一次可含多题（标题显示「第 n/m 题」），**Enter 逐题推进、最后一题提交整批**；前提是 profile 中加载了 `@deepseek-ai/dsh-tool-ask-user`（由 `TUI/cordis.patch.yml` 的 bundle 声明包含）。

> **术语约定**：**选中** = 当前被窗口高亮的选项（`↑`/`↓` 移动、行首 `>`，临时状态、不一定会提交）；**标记** = 按 Enter 会提交生效的选项（空格写入，单选 `*` / 多选 `+`）。
>
> **默认提交**：某题**未标记任何选项**且无自定义输入时，Enter 提交**当前选中的（高亮）选项**（与 `/policy` 等状态面板「无预选回退焦点行」一致）；高亮在「自定义回答」兜底项上且无输入时，该题提交为空。多选同理（默认提交高亮那一项）。

列表底部恒有一个「自定义回答」兜底项（无预设选项时列表仅此一项）：与普通选项一样用 `↑`/`↓` 高亮，高亮在其上时直接键入即可输入自由文本（可退格修改、空格输入空格）。

| 按键 | 行为 |
| --- | --- |
| `↑` / `↓` | 选项列表高亮移动（含末位「自定义回答」项） |
| `空格` | 预设选项：标记/取消标记；自定义项上：输入一个空格 |
| `←` / `→` | 上一题 / 下一题 |
| 可打印字符（含 CJK） | 仅自定义项高亮时输入；预设选项上被忽略 |
| `Backspace` | 自定义项高亮时删除末字符 |
| `Enter` | 还有下一题时进入下一题；最后一题提交整批回答 |
| `Esc` | 取消本次提问（reject ask，不打断运行） |

面板底部的操作提示只显示当前实际用到的按键：Enter 文案区分「下一题 / 提交」，多题才显示「切题」，有预设选项才显示「空格 标记」与「↑/↓ 选项」；Tab 不再参与面板操作。

> 选项标记（纯 ASCII）：行首 `>` = 当前选中（高亮），标记单选 `*` / 多选 `+`（Enter 提交生效），未标记为空格对齐（自定义项有输入时同样标记）。单选时预设选项与自定义输入互斥（选预设会清掉已输入文本）。
