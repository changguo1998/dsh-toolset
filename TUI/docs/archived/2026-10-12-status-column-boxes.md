# 状态列内容改为 Box 构建（接取条目：TUI/docs/BACKLOG.md「状态列内容改为 Box 构建（复用排版库）」）

状态：完成　　开启：2026-10-12　　关闭：2026-10-12
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

状态列（四个**子面板**：Goal / Todo / 后台任务 / 子代理）的内容**构建成 Box 树**，出行复用既有
Box 排版库（`measure` → `allocate` → `fillToList`），不再由 `renderStatusColumn` 自建行段。由此：

1. 消除「裸 `\n` 写屏把一行写断」这一类问题（排版库自带物理行切分）；
2. 状态列的宽度 / 折行 / 缩进口径与其它区域走同一套实现，不再各写一份；
3. 把拼帧层的活还回去：截断 / 补白 / 右缘竖线不再由状态列自己做（现在画完立刻被
   `buildTopRegion` 剥掉，见「顺带发现」）。

不在目标内：字符显示宽度与字形宽度校正（与本任务无关，见「明确不做」）。

## 调研

### 触发症状（真机，2026-10-12）

状态列某一行只显示到一半：行首还有 goal 内容，其后的右缘竖线与该行右侧区域内容**全空**，
内容没有被挤到下一行；按 `Ctrl+S` 隐藏状态列后恢复正常（区域行不再受该行影响）。

### 根因（已定位并复现）

`goalHistoryRows`（`src/app/layout.ts:800`）对**完整 objective** 直接 `wrapLine`，未先按 `\n` 切分；
宿主 objective 本身含 `\n`（如「一句话概括」+ 换行 + 「细节: ...」）。该换行符原样进入
`FrameSegment.text`，渲染层把整行作为一个字符串写出时，终端把内嵌 `\n` 执行成真实换行：

- 本行在 `ESC[K` 擦除后不再回填 → 边框与右侧内容全空；
- 后半截写到下一行，随后被下一行自己的重绘覆盖 → 内容「消失」而非被挤下去。

离线复现（2026-10-12）：以真实 objective 构造历史 goal，帧行文本为
`" 后再开下一条）\n细节: (1) 实时路径终态归属优 │ …"`。

### 同类缺口（机制不同，证据等级也不同）

四处状态列文本入口都未做单行归一，但**机制不同、证据等级也不同**：

| 入口 | 位置 | 机制 | 证据等级 |
| --- | --- | --- | --- |
| `goalHistoryRows` | `:800` | `wrapLine`（不切 `\n`） | **真机症状 + 离线复现**（实证） |
| `todoItemRows` | `:821` | `wrapLine(body, width - 2)`（不切 `\n`） | 结构推断（未实证其输入含 `\n`） |
| `agentItemRows` | `:894` | `wrapWithHanging`（`:2416`）→ 内部仍是 `wrapLine` | 结构推断 |
| `jobItemRows` | `:849` | **完全不折行**：整个 label 塞进单个 segment | 结构推断（表现会是「不折行」而非「折错行」） |

`goalObjectiveRows`（`:786`）因 `.split("\n")` 取首个逻辑行而幸免。

### 为什么状态列漏掉了

聊天区那条路（六步流水线第 4 步，`layout/pipeline/rows.ts:356`）**按物理行 `split("\n")`** 落行，
注释里记着 2026-10-09 的同一个症状（「整段当一行输出会让终端把内嵌换行执行成真实换行……
差分行账本认为那些行未变，残留一直留到 Ctrl+L」）。状态列不在那条流水线里，所以没被覆盖。

状态列现状（代码核实）：

- `renderStatusColumn`（`layout.ts:1177`）在 `layout.ts` 内自建行；`statusBlocks`（`:915`）只有一个调用点（`:1197`）；
- 宽度来自 `metricsFor` 公式（`max(20, floor(cols/3))`），**不经过** `measure` / `allocate`；
- `measure` / `allocate` / `fillToList` 目前只服务面板 Box 与状态栏（`:1302-1304`、`:1982`）。

历史记录（明确排除，不是遗漏）：

- `docs/archived/2026-10-09-layout-segment-cache.md:288`：「**非会话区域直接构造 box、跳过节缓存**：
  状态列 / 标题栏 / 输入区 / 提示区 / 面板的输入是 state 字段，不是流式长内容，不需要分节与合并。」
- `docs/archived/2026-10-10-old-layout-dead-code.md:28`：清死代码时「**D3 明确保留**……`layout.ts`
  的组装与**状态列 / 几何（活）**」。
- 关闭「排版流程重构」的提交 `59b8746` 只留了两条遗留（markdown 缓存键、旧死代码清理），没有状态列。

### 顺带发现：状态列越权做拼帧层的活

状态列的产出是 `FrameRow[]`（`:1192`），**跳过** `ContentRow[]` 这个几何中间态，自己把拼帧层该做的
事做了一遍，而拼帧层拿到后立刻把其中一部分扔掉：

1. `renderStatusColumn`（`:1225-1230`）：截断到 `w - 1` → 补空格到 `w - 1` → **追加右缘竖线 `│`**；
2. `buildTopRegion`（`:1598-1601`）：`cell.segments.slice(0, -1)` **把刚画的竖线剥掉** → 再截断到
   `statusBodyW` → 再补一次空格。

两轮截断、两轮补白，外加一条画了就扔的竖线（`:1226` 的注释自认「此竖线在 buildTopRegion 被剥去后
重画」）。其它区域交的是 `ContentRow[]`，截断 / 补白 / 边线统一由拼帧层做。

### 文档与代码不符（用户记忆「已经加入了」的来源）

| 位置 | 文档写的 | 代码实际 |
| --- | --- | --- |
| `SPEC.md:94` | 状态列是 `ratio 1/3` 的**分区 Box**，宽度由分配器给 | `metricsFor` 公式计算 |
| `DESIGN.md:173` | 折叠在 **fill 阶段**执行（依赖可用高度），**内容树**与尺寸无关 | `renderStatusColumn` 按帧高折叠（`foldAt`），无内容树 |

两条都是**本来就过时**的描述，与本次改动没有因果关系 → 不在本任务实现范围内改，收尾时一并更新
（见「收尾」）。

### Box 排版库已具备的能力（复用的依据）

库本来就按物理行切分，构建好 Box 即可自动获得该保障：

- `measure.ts:71-80`：「按物理行（`\n` 切分）折行，产出显示行列表 —— StyledText / Paragraph 测量共用」；
- `fill.ts:451-475`（`wrap:false` 与预样式段两条路径）：「先按 `\n` 把段切成一串物理行段」；
- `build-box.ts:88`：`text.replace(/\s*\n+\s*/g, " ")`。

状态列现用的视觉特性也都能由库表达（库不只解决换行）：

- 悬挂缩进：`hanging` 是 Box 的一等属性（`layout/box.ts:24`；语义见 `fill.ts:290-296`）；
- 灰色删除线：`style.strike` 库内已在用（`layout/markdown.ts:638`）。

现成出行模式见 `fillPanelBox`（`layout.ts:1294-1304`）：`measure(box, {maxW})` →
`allocate(st, rect)` → `fillToList({viewportWidth}, box, rect, rects)` → `ContentRow[]`。

## 决策

选项：

| 选项 | 内容 | 评估 |
| --- | --- | --- |
| A 小路 | 在状态列的文本入口做一次单行归一（控制字符 → 空格、ANSI → 删除） | 单行归一其实也能一次覆盖四处 `\n`（四个入口共用一个归一函数），改动小（1 处 + 1 用例）；否决理由是状态列**仍旧自建行段** —— 宽度 / 折行 / 缩进口径与排版库两套实现并存，且截断 / 补白 / 右缘竖线仍越权做拼帧层的活 |
| B 大路 | 状态列内容构建成 Box，复用 `measure` / `allocate` / `fillToList` 出行 | 结构性改造，工作量大；同时消除整类问题、把两套实现收敛成一套，并把拼帧层的活还回去 |

选定：**B（用户 2026-10-12 裁定）** —— 原话「我的要求是：也走排版流水线」、「2 直接改造。
只需要构建好 box，后续排版可以复用」。

### 实现方案（2026-10-12 逐条裁定）

**D1 条目模型改造** —— 现状 `StatusItem = { rows: StatusRow[], done, active }`，其中 `rows` 是
**在固定宽度下已经折好的行**；折行决策留在状态列里，正是本任务要拆掉的。改为条目持有
**未折行的内容**（文本 + 样式 + 段前缀），折行归 `measure` / `fill`。
（代码里没有名为 `StatusItem` 的类型：它是 `StatusBlock` 的内联 `items`（`layout.ts:701-703`），
本文件把它当**概念名**使用。顺带删掉 `StatusBlock.id` 联合里已死的 `"mode"` 成员
（`layout.ts:700`，P7 删 Mode 块后无实例）——同文件、同模型、属本任务范围。）

**D2 Box 树形状**：

1. 四块 = `v([goal, todo, jobs, agents], { separator: { char: "╌" } })` —— Box 的 `separator`
   语义就是「兄弟之间画、首尾不画」（`box.ts:52-54`），与手写 `sep()` 同构；
2. 每块 = `v([head, ...items])`，head 用 `styled`（今天的样式段直接搬）；
3. 条目标记改用 **`prefix`**（`box.ts:26-32`，注释里的示例即「列表 • / 任务 [x]」），续行对齐
   改用 **`hanging`**；`wrapWithHanging`（`:2416`）**本次不删** —— 它还有第二个调用点在
   输入区 notice（`:2458` `noticeFooterLines`），删函数就越出本范围（「明确不做」不改输入区）。
   只删状态列那处调用（`:894`），并在函数注释加一行 `TODO`：「仅剩 notice 一处调用，待 notice
   视图也走 Box 后连同函数一起删」（用户 2026-10-12 裁定：**加删除 TODO，不实际删除**）。
   顺带说明：宽度公式的完整口径是 `min(max(20, floor(cols / statusDivisor)), max(1, cols - 10))`
   （`layout.ts:169-172`，`statusDivisor` 可配、默认 3），本文件下文简写为 `max(20, floor(cols/3))`。

**D3 折叠落点**：

1. **取舍留在 `foldAt` 层**（按 `done` / `active` 过滤 + 算隐藏计数），改为输出**条目列表**
   而非行列表；
2. **L3「每条压一行」改用 `wrap: false`**（`box.ts:49`「单行截断不换行」）；
3. **行级兜底 `capRows` 改在 `fillToList` 产出 `ContentRow[]` 之后切** —— 「按行数」的语义 Box
   的 `height` 表达不了，出行后切最简单，比今天还少一层。

**D4 接入点形态**：新增 `src/app/components/StatusColumn.ts`（导出 `buildStatusColumnBox`），
状态列的内容层（条目模型、条目构造、`foldAt`、Box 生成器）都放这里，与 8 个工具面板的生成器同构；
`layout.ts` 是组装层，不再放内容层。

**D5 宽度口径**：`maxW = statusBodyW`（`cols=100` 时 31，= 今天的正文宽，行为等价）。
状态列不做字形宽度校正（理由见「口径澄清」）；`renderStatusColumn` 现在收到的
`statusColWidth - 1`（32 = 正文 31 + 自建竖线 1）这一层随自建竖线一起消失。

### 口径澄清（重要）

- 本任务**只复用 Box 排版库**（`box` / `measure` / `fill`），**不把状态列并入六步内容流水线**
  （delivery → sections → boxes → panes → rows）—— 依据仍是 2026-10-09 的决定：状态列的输入是
  state 字段，不需要分节与合并。
- **术语**（本次统一口径）：**面板**是抽象概念（有边界、自带内部排版的一块内容），实例必须带
  功能 / 内容名。**工具面板** = 按需覆盖活动区的交互界面（审批 / 问答 / 模型选择 / 状态 /
  后台任务 / 命令列表 / 历史）；**分区面板** = 常驻区域（标题栏 / 会话 / 回合 / 状态列 /
  状态栏 / 输入 / 提示）；**子面板** = 状态列面板内的 Goal / Todo / 后台任务 / 子代理四块。
  本任务的对象是**状态列面板**及其四个子面板。
- **统一到哪一层**：本任务统一的是**出行层**（都从 Box 树出发、都产出 `ContentRow[]`）；
  **拼帧层不统一** —— `frameGeometry` / `buildTopRegion` / `buildFrame` / `focusFrame` 仍是手写
  分区拼帧（`DESIGN.md:134`「分区层硬编码于 `layout.ts`」）。「整窗一棵 Box 树」的图书馆化另议
  （见「明确不做」）。
- **状态列不做字形宽度校正**：校正（右缘留白列）只做在会话区 / 回合区 / 工具面板
  （`PANE_TEXT_MARGIN_COLS`，`layout.ts:243-247`：「字形宽度算错（CJK/组合字符宽度估算偏差）时
  多出的列落在留白里，不顶到外缘框列、不把整行挤到下一行」）。状态列的 33 列 = 1 框格 +
  31 正文 + 1 分隔竖线，三列全有主，没有留白列。
- **硬约束：行为等价改造（视觉零回归）**。改完后状态列的用户可见表现必须与改前一致：四块顺序、
  块间 `╌`、块内条目顺序、状态符号与配色、灰色删除线、符号后的悬挂缩进、运行中闪烁、按帧高折叠
  分级、`Ctrl+S` 显隐、`PgUp` / `PgDn` 滚动。这些细节目前**没有自动化覆盖**，故以「同一批 state
  快照下新旧实现逐行 diff」作为可执行证据（见「规划」任务 5）。

## 规划

### 任务拆分

1. 按 **D1 / D2** 落地：条目模型改为持有未折行内容；Box 树 = 四块 `v` + `separator`，
   每块 = `v([head, ...items])`，标记用 `prefix`、续行对齐用 `hanging`；`wrapWithHanging` 只删
   状态列调用点（`:894`）并加 `TODO`（见 D2.3），函数本身保留。
2. 按 **D3** 落地：`foldAt` 改为输出条目列表；L3 用 `wrap: false`；`capRows` 移到 `fillToList`
   之后对 `ContentRow[]` 切。
3. 按 **D4 / D5** 落地出行与接入：`renderStatusColumn` 改为「调 `buildStatusColumnBox` →
   `measure` / `allocate` / `fillToList` → `capRows`」，**产出契约从 `FrameRow[]` 降级为
   `ContentRow[]`**（现签名见 `:1192`），截断 / 补白 / 右缘竖线交回 `buildTopRegion`；同步调整
   调用点（`layout.ts:1443-1454`）的传参口径；删除自建竖线（`:1225-1230`）与消费侧的剥离
   （`:1598`）。
4. 保持既有行为不变：块顺序、块间虚线、块内条目顺序、配色映射、显隐（`Ctrl+S`）、状态列滚动
   （`PgUp` / `PgDn`）、折叠分级语义。
5. 帧级断言 + 等价性证据：**帧行**显示宽恒为 `statusColWidth`（按 `displayWidth` 量，不是字符串
   长度），**内容行**宽不超过 `statusBodyW`；行文本不含控制字符（`\n` / `\r` / ESC 等）；
   多行 objective 的历史 goal 不再产生断行；**同 state 快照下新旧实现逐行 diff 一致**
   （`Ctrl+S` 显隐、滚动、折叠分级各取若干档）。
   等价性做法照仓内既有先例 `TUI/tests/pipeline-equivalence.test.ts`（六步流水线验收：旧路径 vs
   新路径逐行 diff）：同一批 state 快照分别喂**旧实现**（`git show <改造前提交>:TUI/src/app/layout.ts`
   取出的 `renderStatusColumn` 与四个行生成器，作为用例内的独立模块固定下来）与**新实现**，断言
   逐行文本与行数一致；不一致处收窄到批次修复。
   真机目视（BACKLOG 验收项「多行 objective 的历史 goal」）由用户 2026-10-12 裁定**跳过**（不在），
   改以离线等价性证据替代；「该验收项未执行」写进「测试与证据」。
6. 文档对齐：`SPEC.md` 中描述 `renderStatusColumn` 的部分（`:683`）随实现同步更新；
   `SPEC.md:94` 与 `DESIGN.md:173` 属既有过时描述，移「收尾」处理。

### 计划改动文件清单

- `TUI/src/app/components/StatusColumn.ts`（新增，按 D4）—— 状态列内容层：条目模型、条目构造（现 `statusBlocks`）、`foldAt`、Box 生成器（导出 `buildStatusColumnBox`）；`layout.ts` 内四个行生成器在此改写为条目构造
- `TUI/src/app/layout.ts` —— 出行与接入：`renderStatusColumn` 改为「调生成器 → `measure` / `allocate` / `fillToList` → `capRows`」（按 D3 / D5），产出 `ContentRow[]`；调整调用点（`:1443-1454`）传参；删除自建竖线（`:1225-1230`）与消费侧剥离（`:1598`）
- `TUI/tests/status-column.test.ts` —— 既有用例按新实现校准
- `TUI/tests/status-column-agents.test.ts` —— Agents 块条目构造校验（D1 / D2 触及）
- `TUI/tests/layout4.test.ts`、`TUI/tests/layout-horizontal.test.ts` —— 引 `statusColWidth` /
  `renderStatusColumn` 的既有断言，随产出契约（`FrameRow[]` → `ContentRow[]`）校准
- `TUI/tests/status-column-equivalence.test.ts`（新增）—— 任务 5 的帧级断言与新旧逐行 diff
- `TUI/docs/SPEC.md` —— 仅 `renderStatusColumn` 相关描述（`:683`）

### 明确不做

- 不把状态列并入六步内容流水线（见「决策」口径澄清）；
- **不重写分区层**：`frameGeometry` / `buildTopRegion` / `buildFrame` / `focusFrame` 的矩形与拼帧
  逻辑保持手写（「整窗一棵 Box 树」见 BACKLOG 条目〈拼帧层改为 Box 库统一装配（整窗一棵 Box 树）〉）；
- 不改状态列显隐、滚动、折叠等级语义、块顺序与配色；
- 不改标题栏 / 输入区 / 提示区 / 工具面板的既有路径（它们是否也有同类裸 `\n` 缺口**未核实**，
  不在本任务）；
- 本次不删 `wrapWithHanging`（`:2416`）—— 输入区 notice（`:2458`）仍在用，只加 `TODO` 注释（见 D2.3）；
- 不涉及宽度：既不解决「字符显示宽度不对」，也不增删字形宽度校正留白（状态列无留白列，校正只做在
  会话区 / 回合区 / 工具面板）；
- 不新增依赖。

## 实现记录

提交：`4b46d71`（实现）、`e9a0b82`（等价性证据 + 随证据收窄的实现调整）。

- **新增 `src/app/components/StatusColumn.ts`**（内容层，与 8 个工具面板生成器同构）：条目模型
  `StatusItem`（未折行 `segments` + `hanging` + 可选单行 `title` + 可选 `wrap:false` +
  `done` / `active`）、条目构造（goal 当前 / 阻塞原因 / 历史、todo、job、agent）、
  `foldBlock`（取代 `foldAt`：按等级过滤条目 + 算隐藏计数，输出条目列表）、
  `buildStatusColumnBox`（`v([goal, todo, jobs, agents], { separator: { char:"╌", color:"plain" } })`，
  每块 `v([标题行, ...条目, 隐藏计数提示?])`）。
  `layout.ts` 侧删掉四个行生成器 + `foldAt` + 状态列常量与符号表（净减约 370 行），只留
  组装与拼帧（`foldAt` 的**取舍**搬进 `foldBlock`，**出行**交排版库）。
- **`renderStatusColumn`**：产出 `FrameRow[]` → **`ContentRow[]`**；新增 `fillStatusColumnBox`
  （`measure` → `allocate` → `fillToList`，分配高取**自然高**——不让 allocate 按帧高压缩子项，
  帧高只用于折叠等级与兜底截断）；宽度口径 = `statusBodyW`（计算上移到调用前，内容层排版宽与
  拼帧层截断/补白宽同源）；删除自建右缘竖线（`:1225-1230`）与消费侧剥离（`cell.segments.slice(0,-1)`）。
- **相对 D2.3 的实现偏差（1 处，已同步本文件与代码注释）**：条目标记**未**用 Box 的 `prefix`
  ——`prefix` 在 fill 阶段**逐行重绘**（`fill.ts` 的 `decorateRows`），折行后每行都会再出一次
  标记，与「续行停在首行文字起点」的既有表现冲突。改为**标记内联进条目首段 + 续行缩进用
  `hanging`**（与旧 `wrapWithHanging` 同语义）。D2.1 / D2.2（四块 `v` + `separator`、每块
  `v([head, ...items])`）与 D3 / D4 / D5 按原方案落地；`wrapWithHanging` 按裁定保留，其状态列
  调用点删除并在函数注释加 `TODO`（「仅剩 notice 一处调用，待 notice 视图也走 Box 后连同函数一起删」）。
- **等价性驱动的三处收窄**（都是「与旧实现逐字对齐」，均出自任务 5 的逐行 diff）：
  1. 历史 goal 的**标题与 objective 拆成两个叶子**：标题恒单行、超宽交拼帧层截断——若与 objective
     同叶（`\n` 分隔），窄列下标题自己会被折成多行，与旧口径（标题独立成行）不符；
  2. **jobs 与阻塞原因条目 `wrap: false`**：保持改造前「一行一条、超宽截断」的口径（只去掉裸
     `\n` 断行风险），不因为「统一走库」就变成折行；
  3. 条目标记内联 + `hanging`（见上）。
- **顺带发现与处置**：`statusBlocks` 的 `phase: 0|1` 参数是**死参数**（函数体内无引用，被
  `const phase = current.goal.phase` 遮蔽）→ 随内容层迁移移除（连同 `renderStatusColumn` 里
  唯一一处 `runPhase(runTokens)` 调用；`runPhase` 本身仍被状态栏 / App 使用）；`StatusBlock.id`
  联合里已死的 `"mode"` 成员删除（与本任务同文件同模型）；**`statusColumnScroll` 恒被压成 0**
  （`capRows` 后长度必 ≤ h → `statusStartFor` 恒返回 0，滚动是死路径）——不属本任务，保持原样，
  另开 BACKLOG 条目交其他 agent。
- **已知差异（有意变更，均已在等价性测试里钉住）**：
  1. **completed todo 折行时续行改为悬挂对齐**：旧实现 completed 分支只给首行挂标记、续行**不补
     缩进**（与 in_progress / pending 两分支不一致，续行还比正文短 2 列）；新实现统一用 `hanging`
     （= 标记宽）。差异 = 续行前导 2 空格，**折行边界与文本一字不变**；
  2. **`bodyW ≤ 3`（终端 ≤ 15 列）不保证等价**：旧实现把「标记 + 首个宽字符」拼成超宽行交拼帧层
     截断，新实现按列宽折行会多出 1 行 → 折叠档位可能不同。生产不可达（状态列可见时
     `statusColWidth ≥ 20` 或 `cols − 10` → `bodyW ≥ 8`）；
  3. **空白字符的样式**：悬挂缩进在排版库内以**无样式空格段**产出，旧实现把它并进着色段——空格
     无字形、状态列无底色，屏幕上不可见（等价性测试比对 ANSI 时按不可见处理）；
  4. 旧 `wrapWithHanging` 用 `text.slice(head.length)`（UTF-16 长度）切续行，含 CJK 时与「按显示
     宽切片」不等价——新实现走库的 `hanging` 语义；本批快照未触发差异（`hanging` = 标记宽 = 2，
     首行切片点一致）。

## 测试与证据

- `npm run check`（TUI `tsc --noEmit`）干净；`npm run build` 通过；`npm run test:tui` **1479 用例全绿**
  （改造前 1470）；`npm run demo -- --smoke` 通过（`SMOKE_PASS` / `SMOKE_OK`，含状态列可见帧）。
- **等价性证据**（新增 `tests/status-column-equivalence.test.ts`）：等价矩阵 = 13 组 goal × 6 组 todo ×
  4 组 jobs × 5 组 agents = **1560 组 state 快照** × 6 种正文宽（4 / 8 / 18 / 31 / 40 / 60）× 7 档高度
  （1 / 2 / 3 / 5 / 8 / 14 / 30）= **56160 组**，逐行文本与可见 ANSI 与旧实现完全一致；另加相位开关 ×
  轮次进度 × 闪烁节拍 189 组、滚动偏移 3 档 × 高度 3 档。旧实现 = `tests/fixtures/status-column-old.ts`
  （改造前提交 `cca30c3` 的 `renderStatusColumn` + 四个行生成器 + `foldAt` / `capRows` /
  `wrapWithHanging` 冻结副本，函数体一字未动）。折叠分级（L0-L3 与 `capRows`）由高度档覆盖，
  块顺序 / 块间 `╌` / 条目顺序 / 配色与删除线由 ANSI 比对覆盖。
- **帧级断言**（同文件）：`cols ∈ {40, 60, 100, 126}` × `rows ∈ {10, 24, 40}` 下，状态列每行**显示宽
  恒为 `statusColWidth`**（按 `displayWidth` 量）、行文本**不含控制字符**（`\n` / `\r` / ESC）、分隔列
  字形（`│` 内容行 / `├` 结构行）、外缘框格恒 1 列；`Ctrl+S` 隐藏后整帧不含状态列内容。
- **改造点用例**：多行 objective 的历史 goal 不再把一行写断（原真机症状——首 / 第二逻辑行各自独立
  成行、单元格定宽）；当前 goal 仍只取首个逻辑行；todo / agents 条目内容含裸 `\n` 时按物理行折行、
  续行悬挂缩进 2 列（= 标记宽）。
- 既有用例按新契约校准：`tests/status-column.test.ts`（26）、`tests/status-column-agents.test.ts`（8）
  ——新增 `tests/helpers/statusFrame.ts` 统一「内容层正文行 → 帧内可见行」还原（截断 / 补白 / 右缘
  竖线按拼帧层口径），断言仍是屏幕所见口径。「计划改动文件清单」里的 `tests/layout4.test.ts` 与
  `tests/layout-horizontal.test.ts` **实测无需改动**：断言走 `buildFrame` 帧级口径（`statusColWidth` /
  分隔列 / 正文宽），与产出契约变更无关（其中「满宽 todo 行末字符不被截断」一条继续覆盖本次口径统一）。
- **未执行**：真机目视（BACKLOG 验收项「多行 objective 的历史 goal」）——用户 2026-10-12 裁定**跳过**
  （不在），改以离线等价性证据 + 帧级断言替代。

## 收尾

- 已回写两处**既有过时描述**：`SPEC.md:94`（该行「模型表达」列加注「当前实现未把它交给分配器——状态列
  宽仍由 `metricsFor` 算定」；§6 正文的分区举例改为「历史区 `fill+min:10`」并注明状态列 Box 不挂
  `width`）与 `DESIGN.md:173` **只改「折叠在 fill 阶段执行（依赖可用高度），内容树与尺寸无关」这半句**
  →「折叠在内容层按等级过滤条目（`foldBlock`），帧高只决定取哪一级；从 L0 到 L3 依次建 Box 并量行数、
  首次放得下即采用」；同句的宽度口径（`statusColumnDivisor`、最低 20 列、历史区保底 10 列）与
  `layout.ts` 相符，未动。
- `SPEC.md` §15.1「状态列」条目同步补内容层 / 出行 / 折叠落点口径，回归清单加入
  `tests/status-column-equivalence.test.ts`（实现范围内，任务 6）。
- 追踪文档移入 `TUI/docs/archived/`；BACKLOG 移除本条目（只留未完成项），并新增「状态列滚动为死路径」
  条目交其他 agent。
