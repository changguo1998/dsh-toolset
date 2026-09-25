# TUI 待办与开放项

> 职责：TUI 包的待办、开放项与已知外部问题（TUI 的变更优先写在本目录）
> 不负责：跨包功能待办（见 `docs/BACKLOG.md`）、TUI 现状（见 `TUI/docs/STATUS.md`）
> 过期条件：无
> 分组口径（2026-09-26 定）：待办按**主要改动部位**分组（§3），一条只归一个主组，跨组以编号指引（如「见 3.3.1」）。

## 1. 命令扩展

- 7 项纯 TUI 命令与 A1-A5 已完成，9 项候选当前无待办。裁定理由见 `TUI/docs/COMMANDS-SPEC.md` §7（`/clear`、`/login` `/logout` 维持排除；`/review` 搁置，可随 `docs/BACKLOG.md` 的 #17 一并考虑）；命令清单与层归属见 `TUI/docs/COMMANDS.md`；实施清单（已完成）见 `archive/TUI-COMMANDS-TASKS.md`。

## 2. 已完成、不再跟踪

- 排版重构（Box 模型）与符号统一（白名单 / 归一 / 同符号冷却）均已完成，机制与配置见 `TUI/README.md`、`TUI/docs/SPEC.md`、`TUI/docs/IMPLEMENTATION.md`。

## 3. 待办（按主要改动部位分组）

> 19 条，均未实现、尚未排期；来源 = 用户 2026-09-26 反馈的 14 条与原开放项合并重排。
> 共同落点：`src/app/components/QuestionPrompt.ts`（问答面板渲染）、`src/app/components/ApprovalPrompt.ts`（审批面板渲染）、`src/app/index.ts` 的 `handleKey` 面板分支、`src/app/adapter/dsh.ts` 的 `approvalAnswerer`（审批应答与超时）、`src/app/state.ts`（面板状态 + reducer）。
> 组目：3.1 布局与渲染管线 / 3.2 面板内容渲染 / 3.3 按键、状态与 adapter 契约 / 3.4 声音提醒 / 3.5 文档与测试基线 / 3.6 外部依赖 / 3.7 其它机制类开放项。

### 3.1 布局与渲染管线

- **3.1.1 问题交互时复用用户输入框显示 notice**：面板是活动区内容树的整体替换，打开期间新到的瞬态 notice（命令结果 / 错误提示）在活动区不可见（原独立开放项「面板占满活动区」即此现象，已并入本条）。用户 2026-09-26 定稿：**不在活动区留行**，改为**复用用户输入框**——进入问题交互（问答 / 审批面板打开）时，底部用户输入区改为 notice 显示区，程序打印 notice 到活动区（缓冲）的同时在该位置呈现一份（取最近若干行、按输入区高度截断，顺序沿用活动区口径）；交互结束（提交 / 取消 / 超时关闭）即清空该区域，恢复文本输入模式。期间面板内自定义回答编辑不受影响（仍在面板内）。范围限问答 / 审批这类「问题交互」，其它面板沿用现状空白占位（是否纳入实现时确认）。落点：`layout.ts`（模态分支下 question / approval 时 footer 渲染 notice 视图替代空白占位，内容取 `state.buffer` 中 `kind === "notice"` 的尾部若干行）、`state.ts`（如需 notice 视图查询辅助）、`docs/DESIGN.md` §布局（「模态面板底部交互区空白占位」改为问题交互态显示 notice）与 `docs/SPEC.md`、`docs/IMPLEMENTATION.md`、渲染测试。验收：问答 / 审批打开期间新 notice 立即出现在输入区位置；面板关闭后输入区回到空输入态、无 notice 残留；活动区高度与现状一致（本条不改活动区分配）。
- **3.1.2 按键提示统一到底部提示区（按状态切换文案）**：现状提示分两处：底部「按键提示区」（`layout.ts` 的 hint 区，`showHint = normalInput || history`——**面板态隐藏**；文案优先级为历史会话阶段 > 命令补全 > 默认 `HINT_LINE`，历史面板已是按状态切文案的范式：`HISTORY_HINTS`）与**面板内嵌提示**（`QuestionPrompt.ts` / `ApprovalPrompt.ts` / `StatusPanel.ts` 的末行提示行；`JobsPanel.ts` / `CommandListPanel.ts` 塞在首行标题右侧的灰色键位）。用户 2026-09-26 设定：**所有**按键提示统一放用户输入区下方，按当前状态（普通输入 / 命令补全 / 历史会话各阶段 / 问答 / 审批 / 模型选择 / 状态选项 / jobs / 命令列表 / 详情）切换文案；面板内不再出现键位提示，腾出的行还给面板内容（相关面板 `maxBody` 由 `height − 2` 回到 `height − 1`）。落点：`layout.ts`（`showHint` 改为面板态也显示、`HINT_LINE` 拆成按状态取文案的表并纳入 `HISTORY_HINTS` 同类结构、`metricsFor` 的活动区高度随之在面板态让出 1 行）、`QuestionPrompt.ts` / `ApprovalPrompt.ts` / `StatusPanel.ts` / `JobsPanel.ts` / `CommandListPanel.ts` 删内嵌提示、`state.ts`（如需暴露当前提示态）、`docs/DESIGN.md` §布局（模态面板「底部交互区空白占位」的描述改为提示区按状态显示）与 `docs/SPEC.md` §7、`docs/IMPLEMENTATION.md` 布局 / 面板章节同步、相关渲染断言与 `scripts/freeze-focus-frame.mts` 冻结基线重跑。协同与影响：面板态活动区比现状少 1 行，需与 3.1.1（notice 走输入框、不占活动区行）、3.2.1（窗口行数）一并核对高度分配，保证面板开关不上下抖动；3.3.1 无效键提示与 3.2.5 倒计时按本条口径（倒计时仍挂拒绝项）。验收：任意状态下键位提示都在输入区下方一行、文案与当前状态一致；面板内无残留键位；普通输入态文案与现状不变；窄宽截断沿用现规则。
- **3.1.3 重写帧结束后把光标定位回输入位置（仅允许输入时）**：现 `Screen.render` / `renderRanges` 末尾**无条件** `CURSOR_SHOW`（`src/renderer/screen.ts` 第 176 / 217 行），且区间重写只在**本批 intervals 含输入行**时才收集 caret——思考中活动区流式刷新时该批不含输入行，于是不重定位、光标停在本批最后写入行末尾（跑到活动区里闪烁）；delta 区间重写（`renderer/index.ts` 的 `changedIntervals` → `renderRanges`）是常态路径，故该现象高频出现，而模态态下则是「无焦点仍显示光标」。用户 2026-09-26 定稿：**每批重写结束后把光标重新定位回输入位置，仅「允许输入」时生效**；不允许输入（模态面板等非输入态）则不定位并保持 `CURSOR_HIDE`。实现要点：渲染器必须持有「允许输入 + 输入位置（row/col）」这一状态，**不能**用「本批 intervals 有无 caret」当判据（面板态与思考中排队输入两种情况都要正确）——可由 `Renderer.render(rows, sections, focus)` 显式传入，或缓存上一帧 caret / 焦点态；定位转义仍写在该批最后（现有顺序即如此），隐藏分支仅在 `!允许输入` 时使用。落点：`src/renderer/index.ts`（接口与调用）、`src/renderer/screen.ts`（`render` / `renderRanges` 末尾按焦点态定位或隐藏；`reset()` 保持 `CURSOR_SHOW` 保证退出后终端光标恢复）、`src/app/layout.ts` / `src/app/index.ts`（buildFrame 输出「允许输入」标志与输入位置：`normalInput` 为真即允许，含命令补全态；模态态不允许）、`docs/SPEC.md` 渲染契约与 `docs/IMPLEMENTATION.md` 渲染章节同步、渲染转义测试（活动区刷新帧仍含定位转义 + `\x1b[?25h`；模态帧不含 `\x1b[?25h`）。协同：3.1.1、3.1.2 之后的模态态属「不允许输入」→ 隐藏；命令补全态允许输入 → 显示并定位。验收：思考中排队输入时，活动区高频刷新期间光标恒定停在输入框插入点、不跑到活动区；模态面板态无光标闪烁；回到输入态立即定位显示；退出 TUI 后终端光标可见。
- **3.1.4 排版性能**：区域级帧输出 memo（状态列 / 状态栏 / footer，实测仅占单帧 1-4%）与「只测量可见窗口」的懒排版（需块高度前缀和 + 折叠 / 滚动边界处理）——现有有界缓存 + 同 tick 合帧已缓解主要成本。

### 3.2 面板内容渲染

- **3.2.1 统一交互面板：描述区与选项区分窗滚动（Tab 切焦点）**：现状各面板各写一套溢出策略（问答：`pool` + 高亮跟随窗口，`optionIndex == 0` 时起点固定 0；状态选项面板：`index − floor(maxBody/2)` 居中窗口；审批：`lines.slice(0, maxBody)` 硬截断无滚动），导致长题干 / 长 detail / 长草稿时选项被挤出可视区或内容被裁掉。要求收敛为**统一交互面板机制**：正文分「描述窗口」（题干 + detail / 审批草稿）与「选项窗口」（选项列表）两个焦点窗；**Tab** 在两窗间切换焦点（焦点状态按 3.1.2 反映在底部提示区）；**↑/↓** 在描述窗内逐行滚动、在选项窗内逐项移动；选项窗滚动必须让**已标记（选中）项始终可见**（焦点在描述窗时亦然，不允许标记项被滚出视野）。落点：`layout/` 抽共用窗口工具（起点计算 + 边界 clamp，替换三处局部实现）、`QuestionPrompt.ts` / `ApprovalPrompt.ts` / `StatusPanel.ts` 改用共用窗口、`state.ts` 面板状态加焦点窗字段与滚动偏移、`question-transition.ts` 键路由（Tab 现被 `questionKeyDecision` 吞掉，可直接赋「切焦点」语义；↑/↓ 按焦点窗分派）、`index.ts` `handleKey`；`docs/SPEC.md` §7 与 `docs/DESIGN.md` 面板章节同步。与相邻条目协同：3.1.1（notice 走输入框，不占活动区行）、3.2.2 / 3.2.3（描述与选项的行形态）、3.3.1（审批白名单需补 `Tab` / `↑` / `↓`）、3.2.4（审批也有选项列表，本机制的直接受益者）；本条同时修复「长题干 / 长 detail 时选项不可见、审批长草稿被截断」的现状缺陷。验收：题干 + detail 超过活动区时选项仍可见且可滚入视野；Tab 切焦点并在底部提示区可见；滚动中已标记项不消失；审批长草稿可滚动查看全文；不溢出时行为与现状一致（无多余空行）。
- **3.2.2 面板首行缺类型标识**：问答与审批面板首行同形（`请回答（第 n/m 题）` / `等待审批`），类型无区分度。要求首行按类型用**黄色**字给 `[单选]` / `[多选]` / `[审批]` 提示（plan-review 计划审批按同风格给标识），保留原第 n/m 题导航。落点：`QuestionPrompt.ts` 标题段（单选 / 多选与 `markFor` 同源判定）、`ApprovalPrompt.ts` 标题段；`docs/SPEC.md` §7 同步。
- **3.2.3 选项与解释区分度不足**：现渲染为 `标记 + 选项正文 + 空格 + 解释` 挤在同一行，长解释与正文难分。要求：选项正文结束后的解释**另起一行**（缩进对齐选项正文起点）；`>` 光标与 `*` / `+` 标记只出现在选项**第 1 行**，续行与解释行不重复标记。落点：`QuestionPrompt.ts` 选项构建（`wrapPrefixed` 悬挂缩进与 `OPTION_CONT_INDENT` 注释一并改）、`tests/question-wrap.test.ts` 断言同步。
- **3.2.4 审批界面改单选列表（左右箭头 + y/n 快捷键）**：审批面板呈现为选项列表（批准 / 拒绝），`←/→` 切换标记项，表现与单选问答面板一致（标记 / 光标 / 提交语义对齐），额外支持 y = 批准、n = 拒绝 直答。落点：`ApprovalPrompt.ts`（改选项列表，复用 `layout/panel.ts` 的 `panelOptions` 原语）、`state.ts`（`approval` 增 index / selected 与对应 action）、`index.ts` `handleKey`，按键路由可复用 `question-transition.ts` 模式。需与 3.2.5 / 3.3.1 协同：倒计时挂在拒绝项、按键白名单含 `←/→`。
- **3.2.5 拒绝项后显示超时倒计时**：审批面板拒绝项后追加 `(XXs)` 剩余秒数（初始 = `approvalTimeoutMs`，默认 60s，见 `src/main.ts`），逐秒递减，归零与 3.3.2 联动自动关闭。落点：`ApprovalPrompt.ts` 拒绝项行（3.2.4 后即选项列表中的拒绝项）、`state.approval` 记 deadline（或面板打开时间戳）、复用 `status.ts` 的 `StatusTicker` 1s tick 重绘；面板关闭必须清理计时。
- **3.2.6 选项加数字编号，数字键直接标记（单选选中 / 多选切换）**：问题交互界面每个选项行加数字编号，按对应数字键**直接标记该选项**并把光标移到它——单选 = 设为唯一选中（标记 `*`），多选 = 切换该选项标记（`+`）；**不提交**，提交仍由 Enter（2026-09-26 用户定稿）。细节：编号与现有前缀（`>` 光标、`*` / `+` 标记）共存，编号列按选项总数对齐（1-9 与 10+）；编号只出现在选项**第 1 行**，续行与解释行不重复（与 3.2.3 同规则）；数字跳转后目标选项必须滚入可见（复用 3.2.1 的「已标记项始终可见」）；自定义回答兜底项默认不编号，且光标在自定义项（文本编辑焦点）时数字键仍作文本输入、不触发跳转（沿用现「自定义项接收可打印字符」）；选项超过 9 个时的按键策略实现时定（编号照常显示，多字符输入需超时判定）。范围含 3.2.4 之后的审批选项列表——其数字键需一并加入 3.3.1 的按键白名单。落点：`QuestionPrompt.ts` / `ApprovalPrompt.ts`（编号渲染，与标记 / 光标列共用对齐规则）、`question-transition.ts`（数字键 → 新的 jump 类决策，携带目标索引）、`state.ts`（按索引直接置 / 切标记的 action）、`index.ts` `handleKey`、3.1.2 的按键提示表补 `[1-9]标记`。验收：按 `3` 后第 3 项被标记（单选唯一 / 多选切换）且光标随之移动、无需 Enter；自定义项编辑中数字仍入文本；跳转目标自动可见；编号随选项数对齐、长文本折行不错位。

### 3.3 按键、状态与 adapter 契约

- **3.3.1 审批按键白名单与无效键提示**：现 `handleKey` 审批分支只认 y / n，其余（含 Esc）静默吞掉。要求仅 **y / n / Esc** 有效：无效键无副作用并提示（如「按键 X 在审批界面无效」；按 3.1.2 显示于底部提示区，不占面板内容区）；**Esc = 取消审批（返回 `cancelled` 并关闭面板）**——2026-09-26 用户裁定，需改写源码中「审批模式不变（Esc 也被吞）」契约注释与 demo 断言。落点：`index.ts` 审批分支、`adapter/types.ts` + `adapter/dsh.ts`（`approve(id, allow)` 现只能 allowed-once / rejected，需补 cancelled 路径）、`demo/main.ts`、`demo/mockAdapter.ts`。
- **3.3.2 审批超时后自动关闭（缺陷）**：`adapter/dsh.ts` 的 `approvalAnswerer` 超时只 `settle(id, "cancelled")` 结算 Promise，不通知 UI——面板仍开着，用户随后按 y 面板照常关闭，但裁定已是 cancelled，即「选了通过实际被拒绝」。要求超时后自动关面板并 notice 说明（如「审批超时未应答，已取消」），此后不再接受该面板按键。落点：`adapter/dsh.ts`（超时与 `signal.abort` 两条路径都要向 app 发事件）、`adapter/types.ts` 事件面、`index.ts` 事件分支 + reducer。

### 3.4 声音提醒

- **3.4.1 需交互时也响铃**：现声音提醒只有两个触发点——turn-end 响一次、此后等待输入超 `idleThresholdMs` 补响一次（`onTurnEnded`，见 `docs/IMPLEMENTATION.md` §声音提醒）。要求：出现**需要用户交互**的事件（至少审批请求 / 问答请求面板弹出）时，若 bell 总开关 `notify.enabled` 开启，立即响铃；同一次请求只响一次，且不与 idle 补响叠加（面板响铃时清 `idleBellTimer`）。不新增配置项，复用现有总开关；其余「需交互」场景（如工具确认、列表类面板）暂不扩展。落点：`index.ts` 事件分支 `case "approval"` / `case "question"`（抽 `ringBell()` 私有方法，与 `onTurnEnded` 共用 `bellEnabled` / `disposed` 双检查）、`docs/IMPLEMENTATION.md` §声音提醒与 `README.md` 的 `notify` 说明同步、`tests/notify-bell.test.ts` 补例。验收：开关关闭时不响；开启时审批 / 问答面板弹出即响且仅一次。
- **3.4.2 一次 run 结束响两声，改为只响一声（缺陷）**：现 `onTurnEnded`（`index.ts`）在 turn-end 先响一声，再启动 `idleBellMs`（`notify.idleThresholdMs`，默认 8s）计时、超时无输入补响一声——一次 run 结束若 8s 内无输入即听到两声。要求一次 run 结束只响一声。实现前先复现定位：确认是「turn-end 一声 + idle 补响一声」叠加，还是 turn-end 事件重入（`adapter/dsh.ts` 的 `turn/end` 归一化路径）导致的双响，按定位结果改；默认处置为去掉 idle 补响（该场景的催促交由 3.4.3 承担）。落点：`index.ts` §声音提醒（`onTurnEnded` / `idleBellTimer` / `clearIdleBellTimer`）、`docs/IMPLEMENTATION.md` §声音提醒与 `README.md` `notify` 说明、`tests/notify-bell.test.ts`（现有「超阈值补响」用例需按新口径改写）。验收：单次 run 结束恰好一声；等待期间有输入不产生第二声。
- **3.4.3 需交互长时间无操作时持续响铃（每秒 1 次，至有操作为止）**：仅针对**需要用户输入**的交互（审批请求 / 问答请求打开且未作答；**不含** turn 结束后的 idle 空闲），若持续一段时间没有用户操作，则按每秒 1 次的频率持续响铃，直到用户有操作；**一次交互内最多触发一次**（用户操作停止后，同一次交互即使再次长时间无操作也不再重启）。起始阈值默认复用 `notify.idleThresholdMs`（默认 8s；若与 3.4.1 的即时提醒重叠需调，必要时再增独立配置项）；任意按键（含 3.3.1 的无效键——人在终端前即算有操作）停止响铃，面板关闭（提交 / 取消 / 超时）与 `dispose` 必须清理计时，避免泄漏与关闭后误响。与 3.4.1 协同：该条负责交互出现时响一声，本条负责此后催促；与 3.3.2 协同：审批超时自动关闭即停止。落点：`index.ts` §声音提醒（新增重复计时器 + `startRepeatingBell()` / `stopRepeatingBell()`，抽用 3.4.1 的 `ringBell()`；`handleKey` 入口停止）、`approval` / `question` 事件分支与面板关闭路径、`docs/IMPLEMENTATION.md` §声音提醒与 `README.md` `notify` 说明、`tests/notify-bell.test.ts`（假计时器断言周期次数与停止条件）。验收：需交互超阈值无操作 → 每秒一声；有操作立即停；一次交互只进入一次；idle 空闲不触发（按 3.4.2 口径）。

### 3.5 文档与测试基线

- **3.5.1 `/help` 持续增长**：命令加行后 help 超过一屏，且既有测试存在依赖 help 行数的脆弱断言；改 help 前先检查相关断言（改动后需重跑 `scripts/freeze-focus-frame.mts` 并审查冻结基线）。（其余条目的文档、测试与 demo 收尾随各自条目进行，不在此单列。）

### 3.6 外部依赖（TUI 侧无法自修）

- **3.6.1 herdr pane 尺寸与其渲染区域不一致（外部问题，TUI 侧无法自行校正）**：在 herdr pane 里运行时，全宽横线（状态栏下边框等）右端比 pane 渲染区少 1~2 列、需 `Ctrl+L` 或拖动 pane 才恢复；同一构建在独立终端里正常（2026-09-24 实测确认）。取证与排查结论：
  - 抓帧解析（`script -qec "dsh --profile fff" <cap>`）首帧：帧在它**自己的列数**下满宽（标题下划线 / 状态栏上下边框都到最后一列），活动区行按口径不补空格，布局无缺列；
  - 真机 PTY 假应答实验：`CSI 18t`（终端自报网格）确实由 TUI 发出，但终端的应答**到不了插件**（被宿主按键解码消费）→ 无法用终端查询校正尺寸；
  - 实测 Node 的 `stdout.columns` 与 `stdout.getWindowSize()` 都是**缓存值**（改 PTY winsize 但不发 SIGWINCH 时都不更新）→ 「实时 ioctl 读尺寸」这条路无效。
  - 结论：herdr 给 pane 的 PTY winsize 与实际渲染区差 1~2 列；修复应在 herdr 侧（pane 的 PTY 尺寸与渲染区一致，并在尺寸变化时同步下发、含 SIGWINCH）。本仓库 `herdr-integration` 只做状态上报（unix socket），不持有 PTY，无可改点；待 herdr 修复后回归验证。
  - 现场取证（在那台机器上跑，只读、结束恢复终端）：
    ```sh
    python3 - <<'EOF'
    import os,select,termios,tty
    fd=0; old=termios.tcgetattr(fd)
    try:
        tty.setraw(fd); os.write(1,b"\x1b[18t")
        r=select.select([fd],[],[],0.5)[0]
        print("终端自报网格:", os.read(fd,32) if r else "无应答", "| PTY:", os.get_terminal_size(1))
    finally:
        termios.tcsetattr(fd,termios.TCSADRAIN,old)
    EOF
    ```

### 3.7 其它机制类开放项

- **3.7.1 `state.usage` 语义**：`/stats` 展示「最近一次模型调用」，不是会话累计；要累计值需另行采集（`tokenMeter.measure` 接入成本高）。
- **3.7.2 `/agents` 刷新方式**：宿主无 subagent 状态事件面，现为打开期间每 2s 定时刷新 + `r` 手动；宿主补事件面后可改为事件驱动。
