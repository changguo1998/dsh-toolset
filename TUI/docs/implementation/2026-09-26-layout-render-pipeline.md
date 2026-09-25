# 布局与渲染管线三条待办（BACKLOG: TUI#3.1.1, TUI#3.1.2, TUI#3.1.3）

状态：实现　　开启：2026-09-26　　关闭：—
接取条目：`TUI/docs/BACKLOG.md` §3.1 的 **3.1.1 / 3.1.2 / 3.1.3**（来源：用户 2026-09-26 反馈）
不接取：**3.1.4（排版性能）**——用户 2026-09-26 裁定「退回不要接取」（原 TUI §3 开放项，非本任务范围；BACKLOG 中已去掉「进行中」）
本文件是本任务**唯一**的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. **3.1.1** 问题交互（问答 / 审批面板打开）期间，notice 改由底部用户输入区呈现（取消「活动区留行」方案）；交互结束清理输入区 buffer 并恢复输入模式。
1. **3.1.2** 所有按键提示统一到底部提示区、按状态切文案；面板内不再有提示行，腾出的行还给面板内容。
1. **3.1.3** 每批重写结束后把光标定位回输入位置，仅「允许输入」时生效；非输入态保持隐藏。

## 调研

现状事实（2026-09-26 源码核对，行号为当前工作区）：

- **提示区**：`src/app/layout.ts` 的 hint 区，`showHint = normalInput || state.history !== null`（第 809 行）——**面板态隐藏**；文案优先级 = 历史阶段 `HISTORY_HINTS`（第 327-332 行）> 补全 `COMPLETION_HINT_LINE`（第 310 行）> 默认 `HINT_LINE`（第 306-307 行）。`metricsFor(size, !showHint, …)` 以 `showHint ? 1 : 0` 决定 hint 行数（第 819-824 行）。**注意（2026-09-26 续查修正）**：`metricsFor` 里 `footerHeight = hasPanel ? interaction : interaction - 1`（第 371-372 行），即面板态输入区 4 行、提示区 0 行，输入态输入区 3 行 + 提示 1 行——交互区总高恒为 `interaction`、**活动区高度不随面板开关变化**。故 3.1.2 的正确口径是「面板态 footer 由 `interaction` 回到 `interaction - 1` + 提示区恒 1 行」，而非「面板态活动区少 1 行」（BACKLOG 3.1.2 原文需同步修正）。
- **面板内嵌提示**：`components/QuestionPrompt.ts`（末行 hint）、`components/ApprovalPrompt.ts`（末行 hint）、`components/StatusPanel.ts`（hintRow）、`components/JobsPanel.ts` 与 `components/CommandListPanel.ts`（首行标题右侧灰色键位）。已统一到底部 hint 区的先例：`components/HistoryPanel.ts`（`HISTORY_*_HINT_LINE`）与 `components/CommandCompletion.ts`（`COMPLETION_HINT_LINE`）。
- **模态态 footer**：`layout.ts` 第 2516-2530 行——`modalOpen` 时输入区为空白占位，`renderTextInput` 只在输入态调用（故模态帧无 caret 行）。
- **面板正文行数**：`QuestionPrompt` / `ApprovalPrompt` / `StatusPanel` 均为 `maxBody = Math.max(0, height - 2)`（1 行标题 + 1 行提示）；3.1.2 删提示行后应回到 `height - 1`，且面板输出仍需恰好 `height` 行。
- **光标**：`src/renderer/screen.ts` 的 `render`（第 176 行）与 `renderRanges`（第 217 行）末尾**无条件** `CURSOR_SHOW`；caret 只在本批写入的行上收集（第 159-162 / 201-203 行）。delta 常态路径 = `src/renderer/index.ts` 的 `changedIntervals` → `renderRanges`（第 153-179 行），因此「活动区流式刷新」这类不含输入行的批次不会重定位光标，光标停在该批最后写入行末尾。`reset()`（第 236 行）写 `SYNC_END + CURSOR_SHOW`。
- **排版**：`layout/cache.ts`（有界缓存 + 同 tick 合帧）、`measure.ts`（自底向上 measure）、`fill.ts`（摊平 / 折叠裁剪，SPEC §6.7-6.8）；懒排版的目标是「只测量可见窗口」，需块高度前缀和与折叠 / 滚动边界处理。
- **基线产物**：`scripts/freeze-focus-frame.mts` → `tests/fixtures/focus-frame-legacy.json`；排版基准 `npm run bench`（`bench/layout-bench.mts`）。
- **待查项的核对结果（2026-09-26 续查）**：
  - **notice 取行**：`AppState.buffer` 为 `BufferLine[]`（`state.ts` 第 122-145 行），notice 行 `kind === "notice"` 且带 `tone`，多行 notice 已拆为多行；面板态 footer 3 行，取尾部「按 footer 宽度折行后的 3 行」即可。
  - **「允许输入」判据**：`modalOpen`（`layout.ts` 第 800-807 行）为假即允许输入；命令补全态属允许输入；历史面板态 `modalOpen` 为真 → 不允许（与其 footer 空白占位一致）。用 `normalInput` 作判据足够。
  - **渲染器接口**：`Renderer.render(rows, sections?)`（`renderer/index.ts` 第 39-40 行）已有 `sections` 形参，追加第三参改动面小；`FrameRow.caret` 已存在（`screen.ts` 第 65 行）但只在本批含输入行时可见，故 3.1.3 需 App 侧独立提供输入位置，而非让渲染器从批次推断。
  - **提示文案素材**（迁移后供底部提示区）：`QuestionPrompt` 末行「[Enter]下一题/提交 · [Esc]取消 · [空格]标记 · [↑/↓]选项 · [←/→]切题」（按需拼装）、`ApprovalPrompt`「[y]批准 · [n]拒绝 · [Esc]退出」、`StatusPanel`「[Enter]提交 · [空格]预选 · [↑/↓]选项 · [Esc]取消」、`JobsPanel`「↑/↓ 选择 · PgUp/PgDn 翻页 · Enter 取消 · Esc 关闭」、`CommandListPanel.commandPanelHint(kind)`（agents 另有 `r 刷新` / `Enter 中断`）；可复用范式 = `HINT_LINE` / `COMPLETION_HINT_LINE` / `HISTORY_HINTS`。
  - **排版性能基准（`npm run bench`，2026-09-26，`cols=120 rows=40 buffer≈1000 行`，iterations=30）**：cold 2.92 ms / 0.24 ms（cache off / on，11.9×）、warm 2.71 ms / 0.11 ms（24.9×）、incremental 4.60 ms / 0.20 ms（22.7×）——缓存开启后稳态帧已 0.1-0.2 ms，懒排版收益集中在冷路径与缓存失效（窗口尺寸变化、长会话首次排版）。
  - **懒排版接入点**：`measure.ts`（523 行，自底向上测量）、`fill.ts`（515 行，摊平 + 折叠裁剪，SPEC §6.7-6.8）、`layout/cache.ts`（有界文本缓存 + `memo`）；懒排版需在「块高度前缀和」之上只对可见窗口做完整测量，牵动 measure/fill 的整体形状，属大改。

## 决策

> 2026-09-26 **用户裁定**（首轮）：3.1.4 退回不接取；3.1.1 范围＝仅问答 / 审批；「清空」＝清理屏幕。
> 2026-09-26 **用户裁定**（第二轮，详见「审阅与修订」）：**不为输入区另设 buffer**（显示上不需要）——footer 直接取活动区 buffer 的 notice 尾部渲染，退出交互只是切回输入视图（屏幕层面清理），**不动任何数据、无清空动作**；提示文案表抽到低层新文件 `layout/hints.ts`；审阅发现的清单缺项全部补入。

| 议题 | 选定 | 理由 |
|---|---|---|
| 3.1.4 取舍 | **退回未接取** | 用户裁定「退回不要接取」；缓存开启后稳态帧 0.11-0.20 ms，收益集中在冷路径，懒排版牵动 measure/fill 形状，宜单独排期 |
| 3.1.1 范围 | **仅问答 / 审批** | 用户口径即「问题交互」；其余面板 footer 语义未定，不做一次扩大 |
| 3.1.1 数据通路 | **不新增 buffer（复用活动区 buffer）** | 用户二次裁定：输入区显示无需独立 buffer——footer 渲染时取活动区 buffer 中 `kind === "notice"` 的尾部；退出交互＝切回输入视图（屏幕层面清理），无数据清空动作 |
| 3.1.1 取行与截断 | **尾部折行后 N 行**（N = footer 行数，面板态 3） | 输入区高度可容纳多条；顺序沿用活动区（最新在末尾，含面板打开前最近的 notice）；先整体折行再取末尾；截断不加 `…`，保持原文 |
| 3.1.2 交互区高度 | **面板态 footer 回 3 行 + 提示恒 1 行** | 交互区总高恒为 `interaction`（现状契约），活动区高度不变；面板 `maxBody` 由 `height − 2` 回 `height − 1` |
| 3.1.2 文案组织 | **按状态取文案的单表**（沿用 `HISTORY_HINTS` 范式） | 与条目目标一致，便于扩展与测试 |
| 3.1.3 焦点信息通道 | **`render(rows, sections, focus)` 显式传入** | 区间重写不含输入行，渲染器无从推断；resize / 全帧重绘下语义唯一 |
| 3.1.3 隐藏时机 | **无焦点即 HIDE**（`reset()` / close 保底 SHOW） | 用户裁定「非输入态不显示光标」 |
| 实施顺序 | **3.1.3 → 3.1.2 → 3.1.1** | 渲染器改动独立可先行；3.1.2 改面板行数并影响冻结基线；3.1.1 依赖 3.1.2 确定的 footer 口径 |
| 3.1.2 空提示行 | **空串仍占 1 行**（用户裁定 1A） | hint 行数恒为 1；若空串即隐藏，history 加载阶段切换会让活动区高度跳动，违反「交互区总高恒定」契约 |
| 3.1.2 高度口径 | **删 `hasPanel`，改为 `footerHeight = interaction - hintRows`**（用户裁定 3B） | 唯一事实是「交互区总高 = footer + hint」；保留 `hasPanel` 会出现「参数传错却碰巧对」的隐患；补断言「任意状态 footer + hint = interaction」 |
| 3.1.3 刷新路径 | **`render` / `refresh` 统一传 focus，刷新后重新定位光标**（用户裁定 2） | Ctrl+L / resize / 主题切换走 `refresh`（全帧），不统一则重绘后光标停错位置 |
| 3.1.1 排版复用 | **复用 `build-box.ts` 的 notice 行排版**（用户裁定 4；该文件已补入清单） | 保留 `tone` 着色与 `hanging` 悬挂缩进（`/help` 类 notice 依赖），避免两处规则漂移 |
| 3.1.3 异常退出 | **仅文档口径：`reset()` 保底 `CURSOR_SHOW`，不改代码**（用户裁定 5） | `installExitHandlers` 已覆盖 SIGINT / SIGTERM / uncaught；验收加「kill -INT 后终端光标可见」 |

## 审阅与修订（2026-09-26，第二轮）

### 模糊概念（需定死）

1. **「问题交互态」判据**：前文只写「问答 / 审批面板打开」，没给表达式。定为 `isQuestionInteraction(state) = state.approval !== null || state.question !== null`，与 `modalOpen`（含 picker / jobs / 历史 / 命令列表）区分。
1. ~~**输入区 notice buffer 的写入时机**~~：**已消解**——用户二次裁定不新增 buffer（footer 直接取活动区 buffer 的 notice 尾部），写入与渲染不再分离。
1. ~~**清空点**~~：**已消解**——无输入区 buffer 即无清空点；退出交互仅切回输入视图（屏幕层面），天然覆盖 y / n / Esc / 超时 / 提交各路径。
1. **`focus.caret` 坐标系**：定为**帧内 1 基行号 + 0 基列**（与 `screen.render` 的 `i + 1`、`FrameRow.caret` 的列口径一致），避免与区间相对行号混淆。
1. **`focus` 缺省语义**：注入型 renderer（测试 / demo mock）不传 focus 时沿用旧行为（本批有 caret 才定位，否则 SHOW），不破坏既有注入实现；真实路径由 App 恒传。
1. **notice 取行的实现顺序**：把输入区 buffer 当作与活动区同一行模型的**连续行序列**（先整体折行）再从**末尾**取 N 行，否则最新一条会被截断。
1. **提示行状态优先级**：多状态并发（如历史面板 + 命令补全）需定序——approval > question > statusPanel / picker / jobs / commandPanel > history > completion > default。
1. **提示文案可动态拼装**（问答的 `[Enter]下一题/提交`、jobs 是否有运行中任务等），故取值为 `hintLine(state)` 纯函数，而非静态常量表。
1. **极矮终端**：`footer + hint` 之和恒为 `interaction`（改动前后一致），活动区高度不变；改动仅是「面板态 footer 4→3、hint 0→1」，即 notice 可显示行数 = `interaction − 1`（最小 1 行），无需额外让位策略。

### 更好的设计（2026-09-26 用户裁定：1 已采纳，其余随实现采纳）

1. **（已采纳）提示文案表放低层新文件** `src/app/layout/hints.ts`：现文案在 `components/*` 内，`layout.ts` 取用会形成 `layout → components` 反向依赖（components 已 import `layout/panel.ts`）。抽到 `layout/hints.ts`（只依赖 state 类型与纯参数），components 与 layout 共用；`HINT_LINE` / `COMPLETION_HINT_LINE` / `HISTORY_HINTS` / `commandPanelHint` 一并迁入。
1. **输入区 notice 渲染做纯函数**（`(buffer, height, width) => FrameRow[]`，落 `layout/` 或 `components/NoticeView.ts`），便于单测、不依赖整帧。
1. **focus 由 `buildFrame` 的 `FrameBuildOutput` 输出**（与 `sections` 同源），App 原样转发给 `render`——单一来源，避免 App 侧重复计算 caret。
1. **`showHint` 布尔收敛为提示行内容函数**（返回**空串仍占 1 行**，hint 行数恒 1；仅由 `interaction` 分配决定行数）：把「是否显示」与「显示什么」两处判断合并，避免布尔与文案漂移。原写「空串 ⇒ 不显示」会与「交互区总高恒定」冲突，已按用户裁定 1A 修正。
1. **冻结基线变更留痕**：重跑 `scripts/freeze-focus-frame.mts` 后在实现记录里写 diff 摘要（哪些帧 / 行变化与原因），不只写「已重跑」。
1. **面板行数回归断言全覆盖**：`QuestionPrompt` / `ApprovalPrompt` / `StatusPanel` / `JobsPanel` / `CommandListPanel` 各补一条「输出恰好 height 行」断言（删提示行后易错）。
1. **验收补一条**：footer 被 notice 占用期间 `state.inputText`（排队输入）不动，面板关闭后原样恢复显示。

### 计划清单缺项（2026-09-26 用户裁定：**全部补入清单**，见「规划」）

1. `TUI/demo/main.ts` —— 面板帧断言（`approval-y-red` / `approval-n-green` / `△` 标记等）会因 3.1.1 / 3.1.2 改帧而失效，需同步。
1. `TUI/demo/mockAdapter.ts` —— mock 侧同步（notice 展示与面板关闭路径）。
1. `TUI/tests/demo-grading.test.ts` —— demo 帧断言测试。
1. `TUI/tests/focus-frame.test.ts`、`TUI/src/app/layout/focus-frame.ts` —— `showHint` / footer 行数变化影响段划分与焦点框绘制时需改（实现时确认）。
1. `TUI/src/app/layout/hints.ts` —— 新文件（已采纳「更好的设计」1）。

### 途中新问题登记（2026-09-26，第三轮审阅）

- **面板内「自定义回答」编辑无光标**：3.1.3 的 focus 判据只看 `normalInput`，面板内文本编辑焦点不被判为「允许输入」，且 `QuestionPrompt.ts` 不产出 caret。已按流程追加 BACKLOG 条目 **3.2.7**（用户裁定「加入 backlog，先不处理」），交其他 agent；本任务范围不变（不改面板渲染产出 caret）。
- **demo 冒烟 `titlebar-mode-icons` 期望的字形码过期**（既有缺陷，与 3.1.x 无关）：`demo/main.ts` 的 `ICON.box` / `ICON.boxClosed` 仍是 `U+ED95` / `U+ED75`，而源码 `TITLE_ICON` 已是 `U+F03D7` / `U+F03D6`——该断言在冒烟中恒失败（HEAD 版 demo 亦为旧值）。已按流程追加 BACKLOG 条目 **3.5.2**，交其他 agent；本任务不改该断言（已在步骤 2 记录中标注为唯一失败项）。

## 规划

### 计划改动文件清单（本任务只动这些 + 本追踪文档）

代码：

1. `TUI/src/app/layout.ts` —— 3.1.1 模态 footer 的 notice 视图（取活动区 buffer 的 notice 尾部）、3.1.2 `hintLine` 接线与活动区高度（`footerHeight = interaction - hintRows`）、3.1.3 输出「允许输入」标志与输入位置
1. `TUI/src/app/layout/build-box.ts` —— 抽出 notice 行排版纯函数（`tone` 着色 + `hanging` 悬挂缩进）供 3.1.1 的 footer 视图复用（用户裁定 4 补入清单）
1. `TUI/src/app/layout/hints.ts`（**新文件**）—— 提示文案表 + `hintLine(state)` 纯函数（`HINT_LINE` / `COMPLETION_HINT_LINE` / `HISTORY_HINTS` / `commandPanelHint` 迁入）
1. `TUI/src/app/state.ts` —— 3.1.2 提示态（如需）；3.1.1 不新增状态（复用活动区 buffer）
1. `TUI/src/app/index.ts` —— 3.1.1 / 3.1.3 接线
1. `TUI/src/app/components/QuestionPrompt.ts`、`ApprovalPrompt.ts`、`StatusPanel.ts`、`JobsPanel.ts`、`CommandListPanel.ts` —— 3.1.2 删内嵌提示、`maxBody` 回退
1. `TUI/src/renderer/index.ts`、`TUI/src/renderer/screen.ts` —— 3.1.3 焦点态传递与光标定位 / 隐藏
1. `TUI/src/app/layout/focus-frame.ts` —— 若 `showHint` / footer 行数变化影响段划分与焦点框绘制（实现时确认）
1. `TUI/demo/main.ts`、`TUI/demo/mockAdapter.ts` —— 面板帧断言与 mock 同步（3.1.1 / 3.1.2 改帧后）

测试与基线：

1. `TUI/tests/`：`layout.test.ts`、`layout4.test.ts`、`panel.test.ts`、`frame-contract.test.ts`、`focus-frame.test.ts`、`demo-grading.test.ts`、`screen.test.ts`、`renderer.test.ts`、`renderer-diff.test.ts`、`screen-residue.test.ts`、`input.test.ts`、`app.test.ts`、`completion.test.ts`、`jobs-panel.test.ts`、`command-panel.test.ts`、`modelpicker.test.ts`、`help.test.ts`、notice 类（`contract-notice.test.ts` / `council-notice.test.ts` / `memory-notice.test.ts`）—— 按实现范围增改断言
1. `TUI/tests/fixtures/focus-frame-legacy.json` —— 3.1.2 改变帧内容后重跑 `scripts/freeze-focus-frame.mts` 并审查基线

文档（收尾回写）：

1. `TUI/docs/DESIGN.md`（§布局、面板章节）
1. `TUI/docs/SPEC.md`（§7 面板原语、渲染契约）
1. `TUI/docs/IMPLEMENTATION.md`（布局 / 渲染 / 面板章节）
1. `TUI/README.md`（提示区与交互描述，如涉及）

### 明确不做

- **3.1.4（排版性能）已退回未接取**（用户 2026-09-26 裁定）：本任务不改 `layout/measure.ts` / `layout/fill.ts` / `layout/cache.ts` / `bench/`，懒排版与块高度前缀和留待单独排期（调研结论与基准数据留在本文件供后续接取）。
- 不实现 BACKLOG 其它组条目（3.2 面板内容渲染、3.3 按键与 adapter、3.4 声音提醒、3.5-3.7）；其中 3.2.1（分窗滚动）依赖 3.1.2 的高度分配，本任务只保证接口可衔接，不改滚动算法。
- 不改 `TUI/docs/STATUS.md`（对照文档，由用户择时更新）、不改 `docs/host/`（宿主面知识不参与本流程）。

## 实施计划（步骤 2 剩余 + 步骤 3，细化）

### 进行态快照（2026-09-26）

- **已落地**：新增 `src/app/layout/hints.ts`（文案唯一来源 + `hintLine(state)`，优先级 approval > question > statusPanel > picker > jobs > commandPanel > history > completion > 默认）；`layout.ts` 删旧常量改 import hints；`metricsFor` 删 `hasPanel`、`footerHeight = max(1, interaction − hintRows)`、`hintRows` 默认 1；`FrameGeometry.showHint` 移除；`frameGeometry` 改 `metricsFor(size, statusLines.length, 1, state)`；`frameSections` 提示段恒取 `geom.hintHeight`；`buildFrame` 提示区恒 1 行、内容 `hintLine(state)`（删 `historyHint` 与 `const history`）。
- **`npm run check` / `npm run build` 当前通过**（步骤 2 的 layout 侧自洽）。
- **测试签名已同步**（中断恢复那轮）：`tests/layout4.test.ts` / `app.test.ts` / `config.test.ts` / `layout-horizontal.test.ts` / `pane-text-margin.test.ts` 的 `metricsFor(...)` 调用已按新签名更新（含「面板态 footer=3、topHeight 与输入态相同」重写）；这 5 个文件 263/263 通过；pty 侧 `/session` 面板打开正常（修掉 `HISTORY_HINTS` 未定义崩溃）。
- **步骤 2 已完成**：5 个组件的面板内提示删除与 `maxBody` 回退（`QuestionPrompt` / `ApprovalPrompt` / `StatusPanel` / `JobsPanel` / `CommandListPanel`）；随之的断言改写（`command-panel-agents-tools` 改为直接断言 `hints.ts`；`command-panel.test.ts` 措辞；`app.test.ts` 两处窗口断言按 body +1 行重写）；冻结基线重跑并审查（仅 5 个面板场景：面板内提示行消失、底部提示行填文案，行数不变）；demo 断言改为「底部提示行含审批键位 + 面板内不再着色」；文档回写（DESIGN §布局 / SPEC §11.3 / COMMANDS-SPEC §渲染位置 / IMPLEMENTATION 补全键位 / README 输入区与面板）。详见「实现记录 · 步骤 2」。
- **仍待办**：步骤 3（3.1.1 notice 复用输入区）；真机验证（用户执行）；提交（按询问点）。

### 步骤 2 剩余改动（逐文件）

1. `src/app/components/QuestionPrompt.ts`：删 hint 段（`parts` 构建与 `const hint`），返回改 `v([title, ...bodyLeaves])`；`hasPreset` 若仅被 hint 使用则删；`maxBody` 改 `Math.max(0, height - 1)`；文件头「操作提示只列出…」注释改为指向 `layout/hints.ts`。
1. `src/app/components/ApprovalPrompt.ts`：删末行 `hint`（`[y]批准 / [n]拒绝 / [Esc]退出`）；`maxBody` 改 `height - 1`；保留 `v(..., { height: { mode: "fixed", rows: height } })` 定高。
1. `src/app/components/StatusPanel.ts`：删 `hint` 文本与 `hintRow`，返回 `v([titleRow, ...body])`；`maxBody` 改 `height - 1`。
1. `src/app/components/JobsPanel.ts`：删首行右侧灰字键位（`hintText` / `hintVisible` / 灰色段），首行只留标题 + 计数；`taskRows` 公式不变。
1. `src/app/components/CommandListPanel.ts`：删 `commandPanelHint`（已迁至 `hints.ts`，文案保持一致）与首行右侧键位段；清理不再使用的 `displayWidth` / `truncateToWidth` import（按剩余用法判定）。
1. `tests/command-panel-agents-tools.test.ts`：`hintOf` 改为从 `../src/app/layout/hints.ts` import `commandPanelHint`（`agents` 断言 `Enter 中断`、其余 `Enter 详情` 不变）。

### 步骤 2 测试与基线

1. `tests/layout4.test.ts`：10 处 `metricsFor(...)` 按新签名改（删第 2 参；`metricsFor(size, false, 1, 1)` → `metricsFor(size)`）；原 `metricsFor(size, true)` 的「面板态」用例按新口径重写为「面板态 footer 也 = interaction − 1，topHeight 与输入态相同」；补「任意 hintRows 下 footer + hint = interaction」断言。
1. 面板测试核对行数与文案断言：`panel.test.ts`、`jobs-panel.test.ts`、`command-panel.test.ts`、`command-panel-*.test.ts`、`modelpicker.test.ts`、`help.test.ts`、`app.test.ts`（含 `hintRows` 读取与「hint 不带面板标签」两条）；五个面板各补「输出恰好 height 行」断言。
1. `scripts/freeze-focus-frame.mts` 重跑 → `tests/fixtures/focus-frame-legacy.json` 变更逐条审查，diff 摘要写入本文件（禁止盲刷）。
1. `demo/main.ts` / `demo/mockAdapter.ts`：面板帧断言与 mock 同步（提示位置与面板行数变化）。
1. 命令：`npm run check`；单文件 `node --experimental-transform-types --test --test-force-exit <file...>`；`npm run demo -- --smoke`；收尾整包 `npm run test:tui`。
1. 验收：任意状态下提示区恒 1 行且文案随状态切换；面板内无键位；五面板恰好 height 行；`footer + hint = interaction` 不随面板开关变化。

### 步骤 3（3.1.1）改动

1. `src/app/layout/build-box.ts`：抽出 notice 行排版纯函数（保留 `tone` 着色、`hanging` 悬挂缩进、`compact` / `noCompact` 语义），活动区与 footer 共用；活动区路径行为不变。
1. `src/app/layout.ts`：`modalOpen` 分支细分——问题交互态（`state.approval || state.question`）时 footer 渲染 notice 视图：取 `state.buffer` 中 `kind === "notice"` 的行 → 按 footer 宽度折行 → 取末尾 `geom.footerHeight` 行 → 逐行 `styled(..., { wrap: false })` + tone 着色；其余模态（picker / jobs / history / commandPanel / statusPanel）保持空白占位。
1. 交互结束：切回输入视图即可（无 buffer 需清理，活动区留痕不动）；`state.inputText`（排队输入）原样恢复。
1. 测试：新增 `tests/footer-notice.test.ts` —— notice 出现在 footer；tone 保留；超长 notice 折行后取尾部 N 行；picker / jobs 等非问题交互面板仍空白占位；关闭后回输入视图且 `inputText` 不变。
1. `demo`：mock 触发「面板 + notice」组合，冒烟断言输入区显示 notice。
1. 文档：`DESIGN.md` §布局（「模态面板底部交互区空白占位」改为「问题交互态显示 notice」）、`SPEC.md`、`IMPLEMENTATION.md`、`README.md`（按需）。
1. 验收：问答 / 审批打开期间新 notice 立即出现在输入区位置；关闭后回到空输入态且 `inputText` 恢复；活动区高度不变。

### 风险与回滚点

- 面板行数断言密集（`maxBody` 回退最易错）→ 逐组件改完即跑对应测试文件，再统一跑面板族。
- 冻结基线仅允许「审查 diff 后重跑更新」；出现异常变更即回滚该夹具。
- `hints.ts` 不得反向依赖 `components/`；`commandPanelHint` 迁移后只保留一份实现。
- 每步先 `git diff` 自查，再按提交询问点单独询问是否提交。

## 实现记录

### 步骤 1：3.1.3 光标通道（2026-09-26，实现 + 单测通过）

改动（均在计划清单内）：

1. `src/renderer/screen.ts`：新增 `FrameFocus`（`inputFocus` + 可选 `caret`，帧内 1 基行号 / 0 基列）；`render` / `renderRanges` 加可选 `focus`，`renderRange` / `renderDelta` 透传；末尾光标收尾改为 `pushCursorTail(out, batchCaret, focus)`——未传 focus 沿用旧行为（有 caret 才定位，否则 SHOW）；`inputFocus && caret` 定位并 SHOW；其余不定位不 SHOW（沿用报文开头的 `CURSOR_HIDE`）。`reset()` 不变（异常退出保底 SHOW）。
1. `src/renderer/index.ts`：`Renderer.render` / `refresh` 加第三参 `focus` 并透传给 `screen.renderRanges` / `screen.render`；`FrameFocus` re-export（并 import 到本地作用域供接口使用）。
1. `src/app/layout.ts`：`FrameBuildOutput.focus` 回填 + 新增 `frameFocus(rows, inputFocus)`（扫描帧内 caret 行得 1 基行号）；`buildFrame` 末尾 `out.focus = frameFocus(rows, !modalOpen)`。
1. `src/app/index.ts`：三处渲染调用（`paintExitNotice`、`refresh`（Ctrl+L）、`renderFrame`）改为 `render|refresh(frame, out.sections, out.focus)`。
1. 测试：新增 `tests/focus-cursor.test.ts`（5 例）；`tests/screen.test.ts` 的 `capture` 加可选 `focus` 形参并补 3 例。

命令与结果：

- `npm run check`：通过（无输出错误）。
- `node --experimental-transform-types --test --test-force-exit tests/focus-cursor.test.ts`：5/5 通过。
- 同上跑 `tests/screen.test.ts tests/renderer.test.ts tests/renderer-diff.test.ts`：24/24 通过（含全部旧断言）。
- 同上跑 `tests/focus-frame.test.ts tests/frame-contract.test.ts tests/layout.test.ts tests/layout4.test.ts`：146/146 通过。
- 同上跑 `tests/app.test.ts`：157/157 通过。
- `npm run demo -- --smoke`（仓库根）：`SMOKE_PASS ...` / `SMOKE_OK sent=[...] interrupts=1`，exit=0。
- 备注：`npm run test:tui -- <文件>` 在本机包装脚本下未按单文件跑通（报 `Could not find '<file>'`，整包运行超时后转后台），故改用直接 `node --test` 跑单文件；整包 `npm run test:tui` 留到收尾统一跑一次。
- 待办（用户执行）：真机 `dsh --profile fff` 看三项——面板态无光标、思考中排队输入时光标停在输入框、`Ctrl+L` 后光标仍在输入框；`kill -INT` 后终端光标可见。

### 中断恢复：提示区接线与历史会话载入

- `layout.ts`：提示段改为恒计入帧高；`buildFrame` 改用 `hintLine(state)` 并移除旧常量/`showHint` 引用，修复 `/session` 面板触发 `HISTORY_HINTS` 未定义崩溃。
- 测试调用按新 `metricsFor(size, statusHeight, hintRows, layout)` 签名更新；面板 footer 断言同步为 3 行 + 提示 1 行。
- `npm run check`、`npm run build`：通过；布局 / App / config 相关 5 个测试文件：263/263 通过。
- pty 验证：`fffdsh` 检测到源码变化并触发重建；打开 `/session` 后进程仍运行，历史面板可见，无 fatal 异常。
- 整包 `npm test` 超过 10 分钟未结束，已停止；本次未完成整包测试。3.1.2 的面板内嵌提示迁移等后续工作仍未完成。

### 步骤 2：3.1.2 按键提示统一到底部提示区（2026-09-26，实现 + 测试通过）

改动（均在计划清单内）：

1. 新增 `src/app/layout/hints.ts`：文案唯一来源 + `hintLine(state)`（优先级 approval > question > statusPanel > picker > jobs > commandPanel > history > completion > 默认）；`HINT_LINE` / `COMPLETION_HINT_LINE` / `HISTORY_*` / `commandPanelHint` 分别由 `layout.ts` 与 `CommandListPanel.ts` 迁入；空串仍占 1 行。
1. `src/app/layout.ts`：删旧常量与 `FrameGeometry.showHint`；`metricsFor` 删 `hasPanel`、改为 `footerHeight = max(1, interaction − hintRows)`（`hintRows` 默认 1）；`frameGeometry` 走 `metricsFor(size, statusLines.length, 1, state)`；`frameSections` 提示段恒取 `geom.hintHeight`；`buildFrame` 提示区恒 1 行、内容取 `hintLine(state)`。
1. 5 个组件：`QuestionPrompt.ts`（删 hint 段与已无用的 `hasPreset`，`maxBody` → `height − 1`）、`ApprovalPrompt.ts`（删末行键位行，`maxBody` → `height − 1`）、`StatusPanel.ts`（删 hint 行，`maxBody` → `height − 1`）、`JobsPanel.ts` / `CommandListPanel.ts`（首行只留标题 + 计数；删 `commandPanelHint` 与灰色键位段、清理不再使用的 `displayWidth` import）。
1. 断言同步：`tests/command-panel-agents-tools.test.ts`（改为直接断言 `hints.ts` 的 `commandPanelHint`，并新增「面板内不再内嵌按键提示」用例）、`tests/command-panel.test.ts`（两处措辞改为「提示区换为面板键位 / 恒 1 行」）、`tests/app.test.ts`（问答与 plan-review 两处窗口断言按 body +1 行重写：初始窗口现含第二选项 / detail 正文，末位项仍被裁）。
1. 冻结基线：重跑 `scripts/freeze-focus-frame.mts`；diff 审查结果——仅 5 个面板场景变化（approval / question / picker / statusPanel / jobsPanel）：面板内提示行消失、末行提示区填入对应文案，帧行数 24 不变；其余 10 个场景无差异。
1. demo：审批断言由「面板内 y 红 / n 绿」改为「底部提示行含 `[y]批准 · [n]拒绝 · [Esc]退出`」+「面板内不再出现红色 `[y]批准`」。
1. 文档：`DESIGN.md` §布局（提示区恒 1 行、hints.ts 唯一来源、面板内无键位）、`SPEC.md` §11.3（`hintHeight` 恒 1、`showHint` 字段移除）、`COMMANDS-SPEC.md` §渲染位置与接线点（footer 口径）、`IMPLEMENTATION.md`（补全键位指向 hints.ts）、`README.md`（输入区提示区、面板两节）。

命令与结果：

- `npm run check`：通过。
- 整包 `node --experimental-transform-types --test --test-force-exit tests/*.test.ts`：**1047/1047 通过**（基线更新与断言改写后）。
- `npm run demo -- --smoke`：SMOKE_OK；新断言 `approval-hint-bottom` / `approval-hint-not-colored` 通过；**唯一失败**为 `titlebar-mode-icons`——既有缺陷、与本次改动无关（已记 BACKLOG 3.5.2）。
- 行为变化（需知悉）：面板内 `[y]` 红 / `[n]` 绿着色随提示迁移取消，底部提示行为单色普通前景；若要保留着色，需把 `hintLine` 扩为「段数组」形态，留待 3.2.4 / 3.3.1 一并考虑。

## 测试与证据

（3.1.3 见「实现记录 · 步骤 1」；3.1.2 见「实现记录 · 步骤 2」。整包：1047/1047 通过；demo 冒烟除既有 `titlebar-mode-icons`（BACKLOG 3.5.2）外全通过。待补：真机 `dsh --profile fff` 现象——面板态无光标 / 思考中排队输入光标停在输入框 / `Ctrl+L` 后光标仍在输入框 / 提示区文案随状态切换且面板内无键位 / `kill -INT` 后终端光标可见；3.1.1 完成后一并补齐。）

## 收尾

（关闭前补齐：回写文档清单、遗留项、追踪文档移入 `TUI/docs/archived/`。）
