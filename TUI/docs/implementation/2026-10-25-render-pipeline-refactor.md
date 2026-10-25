# 重构 TUI 渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析（接取条目：`TUI/docs/BACKLOG.md`「重构渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析」）

状态：调研　　开启：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮只建立文档（接取），调研与实现均未开始。

## 目标

让结构分类成为单一源（随节点进入摊平阶段，不再按文本二次分类），并让折行只有单一入口（measure 与本文件所述 fill 共用同一实现，前缀 / 悬挂回到节点字段，修掉 `void contWidth` 造成的几何分叉）；保持表格仍在构建期算列宽、折叠基线不静默重冻。

## 调研

调研方式：只读阅读 + `grep`；未跑 `build` / `test` / `format`，未改源码。行号以 2026-10-25 工作区为准。

### 1. 链路与各段职责

| 段 | 入口 | 输入 → 输出 | 是否分类 |
| --- | --- | --- | --- |
| ① 结构 | `TUI/src/app/layout/pipeline/boxes.ts:205` `textParts` / `:411` `buildBoxes` / `:338` `tableTree` | 节文本 → `Box`（`shape`: text / quote / list / code / table；`role`: block / table / row） | 是（宽无关） |
| ② pane | `panes.ts:63` `PaneItem`、`:206` `push` | `Box[]` → `PaneItem[]`（`kind: "line"` 持 `box`，另有 blank / step-head / step-summary / turn-separator） | 否（只分流 + 空行合并） |
| ③ 摊平 | `rows.ts:261` `boxToLines`、`:395` `tableLines`、`:469` `itemLines`、`:534` `renderPane` | `Box` → `HistoryRow[]`（纯文本行 + kind/final/tone 等旧口径字段） | **否（分类在此丢失）** |
| ④ 重建 | `build-box.ts:369` `buildBox`、`:1315` `buildContentRows` | `HistoryRow[]` → 节点树（`panes.dialogue` / `panes.activity`） | 是（按文本二次分类） |
| ⑤ 测量 | `measure.ts:34` `layout`、`:413` `measureLeaf`、`:502` `paragraphRowsNoSplit` | 节点树 + 宽 → `Rect`（含 `node.height`） | 否（只认 prefix / suffix / indent / hanging） |
| ⑥ 填充 | `fill.ts:356` `fillParagraph`、`:259` `decorateRows` → `ContentRow[]` | 节点树 + `Rect` → 上屏行 | 是（`wrapAssistantLine` 再做块级分类） |

`TUI/src/renderer/` 不参与结构判断，只按 `ContentRow[]` 上屏。

### 2. 分类在 ③ 丢失，④ / ⑥ 各自重判

- ③ `boxToLines`（`rows.ts:261-392`）按 `box.shape` 分流后**统一压回文本行**：code → 围栏行（`:323-336`）、text / quote / list → `box.text.split("\n")`（`:344-391`）、table → 原始 markdown 行（`tableLines` `:395-442`）。`shape` / `role` 不进入 `HistoryRow`。
- ④ `buildBox` 只能按文本再猜：围栏状态机 `inFence`（`build-box.ts:440` 起、`:740` 附近）、assistant 正文行一律造 `Paragraph`（`:875`）、思考行 / 工具行 / notice / 用户块按行 `kind` 分流，再由 `:1216` `trimTrailingAssistantBlanks`、`:1239` `lineUpBlockBars`、`:1285` `spaceUserAssistant` 等后处理。
- ⑥ `wrapAssistantLine`（`markdown.ts:862` → `:872` `assistantLineRows`）按正则再做一次块级分类：rule → task → heading → quote → list → 内联 markdown（`:874-944`）；列表 / 任务 / 标题的前缀字全部在此现造（`:888`、`:904`、`:917`、`:936`），`wrapListRows`（`:845-854`）负责悬挂缩进。
- 结论：`textParts`（①）与 `assistantLineRows`（⑥）用两套正则表达同一套语义；`SPEC.md:148`「列表项 = `Paragraph(prefix:{"• "}, hanging:2)`」与实现（前缀由 ⑥ 现造，节点上没有 `prefix`）不一致，`SPEC.md:119` 的 `text(prefix …)` 写法同属旧口径。

### 3. 两套折行几何（额外空行 / 断线的直接来源）

- ⑤ `measureLeaf`（`measure.ts:413-460`）对 `Paragraph` 用**原文**折行：`wrapParagraph`（`:463-466`）→ `primitives.ts:85` `wrapLine`，只认 `prefix` / `suffix` / `indent` / `hanging`；`kind === "text"` 走 `paragraphRowsNoSplit`（`:502-512`），**`contWidth` 被 `void` 掉**（续行宽不参与）。
- ⑥ `fillParagraph`（`fill.ts:356-401`）对同一 `Paragraph` 用**行内解析 + 块级分类后**折行（`:390` `wrapAssistantLine`）；`wrap:false` 与 `fillBg` 各走一支。
- 行数不等时：`decorateRows`（`fill.ts:259-344`）的 valign 补白按 `rect.h` 补空白行；`hasHeightDecl`（`:347-352`）把 measure 写入的 `height` 也当「显式高度」，所以**估值偏高**就多出无竖线空行，**估值偏低**就溢出丢 `┃` / `│`。
- 已被 `TUI #1` 实证的同类项：表格 `measureLeafRows`（`table.ts:319-334`）二次 `parseInlineMarkdown` 导致行高低估、思考行表格末行无竖线；表格回退文本（宽 18）会放大同一口径差。

### 4. 影响面：测试与基线

- `TUI` 共 1760 例；与本次相关：`tests/pipeline-boxes.test.ts`（263 行）、`pipeline-panes.test.ts`（506）、`pipeline-rows.test.ts`（135）、`pipeline-frame.test.ts`（838）、`pipeline-equivalence.test.ts`（412）、`content-mapping.test.ts`（398）、`fill.test.ts`（139）、`table.test.ts`。
- 关键断言：`pipeline-equivalence.test.ts:278-283`（行数表之和 = 实产行数）、`:287`（表格 / 代码块 / 工具批还原形态）；`pipeline-frame.test.ts:400`（回合区空行序列 `["<step>", "┃（先想）", "", "┃中间正文"]`）；`pipeline-rows.test.ts` 直测 `boxToLines` / `renderPane`。
- 基线夹具：`tests/fixtures/focus-frame-legacy.json`、`content-mapping-legacy.json` 内无表格；`npm run demo -- --smoke` 有帧断言。按项目约定**不静默重冻**，受影响断言逐条人工确认。
- 行缓存键含（宽、pane、活动区开关、紧凑开关）（`rows.ts:516-527`），改折行口径不会使旧缓存串味，但缓存失效面会扩大。

### 5. 规模与风险

- 直接相关代码量：`build-box.ts` 1341 行、`markdown.ts` 945、`rows.ts` 617、`measure.ts` 568、`fill.ts` 534、`boxes.ts` 515、`panes.ts` 401；测试 3000 行以上。
- 主风险：⑤ 行数一变，所有文本高度跟着变 → 空行序列 / 行数表 / 帧断言大面积重排；③ 通道一改（`HistoryRow` 契约）会牵动 `rows.ts` 与 `build-box.ts` 两侧；`pipeline-frame` 的空行语义（块首 / 块尾 / 类型间隔）是历史裁定，容易被顺手改坏。
- 可拆分性：折行单一入口（§3）与分类单一源（§2）彼此独立——前者只动 ⑤ / ⑥，后者动 ①②③④。先做前者能直接消除用户看到的空行 / 断线，且回退面小。

### 6. 建议的阶段划分（~~待决策~~ 已被 2026-10-25「新框架设计 v2」取代）

（原建议为「阶段 A 折行单一入口 + 阶段 B 分类单一源」。用户 2026-10-25 裁定改为从原始文本出发的七段完全重构，本段保留作历史记录，取代者为下文「新框架设计（v2，待审阅）」。）

## 新框架设计（v2，待审阅）

用户 2026-10-25 裁定：不做局部修补，**从原始文本开始按七段完全重构**。本节的每一段都是一个独立纯函数 + 一份明确 IR；旧链路（`HistoryRow` / `boxToLines` / `tableLines` / `buildBox` 的文本重判）在新框架中删除。

### 0. 总原则

1. **一次解析**：markdown 块级分类与行内解析各只发生一次（第 2 段），后续任何阶段不得再调 `parseInlineMarkdown` 或按正则猜块类型。
2. **一次折行**：折行只有一个函数 `wrapLeaf(leaf, width)`（第 5 / 6 段共用），测量行数 = 折行结果长度，禁止任何 `ceil` 估算与二次折行。
3. **宽无关在前，宽相关在后**：分节 / 解析 / 分流 / 结构 完全不含宽度；测量 / 摊平 / 组装 才引入宽度。
4. **空行与装饰是数据**：空行只能由显式的 `Gap` 块产生；前缀（列表符 / 任务框 / 引用竖线 / 标题样式）与 `hanging` 是节点字段，不在渲染时现造。
5. **每段一个入口**：`split` / `parse` / `route` / `structure` / `measure` / `flatten` / `compose`，入参与出参见下。

### 1. 分节 `split(raw, provenance) → Section[]`

- 输入：宿主交付的原始文本分片 + 来源元数据（source / turn / step / seqs / time / status / steerContinued）。
- 输出：`Section` 列表。`Section` 只记「来源与边界」，不含任何 markdown 语义：
  `{ id, source, turn, step, seqs, status?, time?, text: string }`。
- 职责：把连续文本按事件边界切开（一条回复、一段思考、一组工具调用、一条 notice、一条用户输入、一个 shell 段）；不做行内解释，不删空行。
- 契约：纯函数；与宽度无关；同输入同输出；`Section` 是后续所有阶段的稳定身份（缓存键、段键、跳转目标）。
- 现状对应：沿用 `pipeline/sections.ts`，但把 step 头 / 回合分隔线 / 空行从「隐式事件」改成显式的块（见第 2 段）。

### 2. 解析 `parse(section) → Block[]`

- 输入：`Section`。
- 输出：块序列 `Block[]`（可嵌套：`Quote` 含子块，`List` 含 `ListItem` 含子块）。
- 块类型（首版闭集）：
  `Paragraph` / `Heading{level}` / `List{ordered, depth, items}` / `ListItem{marker, checked?, children}` / `Quote{children}` / `Code{lang, rows, closed}` / `Table{header, aligns, rows}` / `Rule` / `Gap{kind: "author"|"type"|"section"}` / `ToolBatch{units}` / `StepHead` / `TurnSeparator`。
- 行内：每个文本块在这一步产出 `FrameSegment[]`（强调、行内代码、转义、符号归一后文本），块上同时保留 `text` 原文用于检索 / 复制 / 测试断言。
- 唯一性：块级分类的正则、围栏状态机、表格解析、inline 解析全部收在这一段；`textParts`（`boxes.ts:205`）、`build-box.ts` 的 `inFence`、`markdown.ts:872` `assistantLineRows` 的块级分类在此合并为一处。
- 表格：复用 `table.ts` 的 `parseTableAt` / `isTableStart` 产**结构**（表头、对齐、行），不做列宽、不做折行。
- 不做：宽度、pane 归属、主题色、压缩。
- 契约：`parse` 是纯函数；`Block` 一经产出不可变；每个块带稳定 `id`（section id + 块内序号）。

### 3. 分流 `route(blocks, view) → PaneItem[]`

- 输入：`Block[]` + 视图状态（`activityShow` / `compact` / `collapse` / 折叠占位）。
- 输出：`PaneItem[]`：`{ pane: "dialogue"|"activity", block: Block, decoration: Decoration, visible: boolean, key: string }`；另含显式 `Gap` 项。
- 职责：**唯一**决定「去哪个 pane、是否显示、前后留几行空」的规则表：
  - 来源 × 块类型 → pane（正文 final → 会话区；思考 / 工具 / notice → 活动区；用户块 → 会话区）。
  - 类型间隔（思考 ↔ 正文 1 行、工具不插行）、step 头抑制、回合分隔线、折叠占位。
  - 压缩开关按类别（think / tool / reply）。
- 规则表要求：以数据表形式落在一个文件里（`routeTable.ts`），禁止散落在 `panes.push`、`noteActKind`、`absorbActivityBlank`、`trimTrailingAssistantBlanks` 等处。
- 不做：宽度、折行、样式解析。
- 契约：纯函数；同 `view` 下 `Block[]` 到 `PaneItem[]` 确定。

### 4. 结构 `structure(items) → PaneTree`

- 输入：`PaneItem[]`。
- 输出：每个 pane 一棵节点树（`leaf` / `h` / `v` / `spacer` 闭集）。叶子携带**结论性几何字段**：`prefix{text,style}` / `hanging` / `indent` / `align` / `valign` / `bg` / `wrap` / `compactable`。
- 职责：把块与装饰落成节点属性：
  - `List` → `prefix: "• "` + `hanging: 2`（与 `SPEC.md:148` 一致）；有序列表 → 原文编号 + `hanging`；任务 → `[x] ` / `[ ] ` + 删除线样式。
  - `Quote` → `prefix: "│ "`；`Heading` → `bold + fg: cyan`；`Rule` → 铺满横线；`Code` → `bg` + 围栏行；`Table` → 表格容器节点（列宽留给第 5 段）。
  - 思考行 / 工具行 / notice / 用户块的前缀与配色在这一步定死。
- 不做：宽度、行数、列宽、补白。
- 契约：`structure` 纯函数；同一 `PaneItem[]` 得到同构树；叶子 id 唯一。

### 5. 测量 `measure(tree, width, view) → Geometry`

- 输入：节点树 + pane 内容宽。
- 输出：`Geometry`：每节点 `Rect{x,y,w,h}`；表格的列宽与行高；`wrapLeaf` 结果缓存（键 = 叶子 id + 宽 + view 开关）。
- 折行：叶子高度 = `wrapLeaf(leaf, w).length`，`wrapLeaf` 是唯一折行实现（处理 prefix / hanging / 首行与续行宽差 / 平衡折行 / 表格单元格 / 代码行）。
- 表格：列宽在这一段用现有 `fitCols` 水位法算（跨行约束必须一次算死），行高 = 单元格 `wrapLeaf` 行数最大值。
- 不变式（写成测试）：`geometry.h(leaf) === wrapLeaf(leaf, w).length`；任何叶子高度都不得来自估算或外部写入。
- 不做：生成上屏行、补白、主题色。
- 现状对应：重写 `measure.ts` 的 `measureLeaf` / `paragraphRowsNoSplit` / `wrapParagraph`；删除 `void contWidth`；`table.ts` 的 `measureLeafRows` 与 `rowBox` 的高度写死改为读 `wrapLeaf`。

### 6. 摊平 `flatten(tree, geometry) → ContentRow[]`

- 输入：节点树 + `Geometry`。
- 输出：每个 pane 的 `ContentRow[]`（唯一上屏内容来源）。
- 职责：逐个叶子取 `wrapLeaf(leaf, w)` 的行，拼 `prefix` / `indent` / `hanging` / `align`；`valign` 仅在**显式高度**（表格行、面板行）时按 `Rect.h` 补白；表格按列宽出网格（左缘竖线 / 列分隔 / 横线规则行）。
- 不变式（写成测试）：摊平产出行数 === 测量高度；**不存在**「测量说 2 行、摊平给 3 行」；空行只能来自 `Gap`。
- 不做：决定留白位置、改文本内容。
- 现状对应：重写 `fill.ts` 的 `fillParagraph` / `decorateRows` / `hasHeightDecl` 补白逻辑；删除 `wrapAssistantLine` 的块级分类与 `table.ts` 的行高二次写死。

### 7. 组装 `compose(panes, viewport, chrome) → FrameRow[]`

- 输入：两 pane 的 `ContentRow[]` + 视口（段键、段内行）+ chrome（状态栏、输入行、面板、折叠占位、在飞工具标记）。
- 输出：`FrameRow[]` 交给 `renderer` 逐格上屏。
- 职责：视口定位、折叠占位、step 头 / 回合分隔线的最终位置、状态栏与输入行合成。
- 不做：内容排版、折行。
- 现状对应：`layout.ts:1033` `buildTopRegion` + `renderer/` 基本不动，只改输入类型。

### 共享件与文件布局（建议）

```text
TUI/src/app/layout/pipeline/
  types.ts        Section / Block / PaneItem / Leaf / RenderRow / Rect / Geometry
  split.ts        §1 分节
  parse.ts        §2 解析（含表格结构、inline 解析调用、围栏状态机）
  route.ts        §3 分流
  routeTable.ts   §3 的规则表（来源 × 块类型 × pane × 可见性 × 间隔）
  structure.ts    §4 结构
  wrap.ts         §5/§6 共用的唯一折行入口 wrapLeaf
  measure.ts      §5 测量
  flatten.ts      §6 摊平
  compose.ts      §7 组装
  sections.ts     （保留）事件 → Section 的现有适配
```

### 数据与不变量（写成测试）

1. `parse` 输出块数 × 行内解析次数：每块只解析一次（用调用计数断言）。
2. `wrapLeaf` 是唯一折行实现：全仓不允许出现第二处逐字符折行（grep 守门）。
3. `measure.h === flatten.rows.length`（同宽度下逐叶子断言）。
4. 块类型闭集：`parse` 产出的块类型必须在闭集内（`satisfies` + 测试）。
5. 空行来源唯一：`ContentRow` 的空行只能由 `Gap` 项产生（统计断言）。
6. `Block` 不可变：`Object.freeze`（开发期）或只读类型。

### 与旧链路的映射与删除清单

| 新段 | 取旧代码的什么 | 删除什么 |
| --- | --- | --- |
| §1 分节 | `pipeline/sections.ts` | 无 |
| §2 解析 | `boxes.textParts` 的结构识别、`table.parseTableAt`、`build-box` 的围栏状态机、`markdown.assistantLineRows` 的块级分类 | 三处重复分类；`assistantLineRows` 的分类分支 |
| §3 分流 | `panes.push` 的分流与空行、`build-box` 的 `noteActKind` / `absorbActivityBlank` / `trimTrailingAssistantBlanks` / `spaceUserAssistant` | 分散在多个后处理里的间隔规则 |
| §4 结构 | `build-box` 的节点构建（去掉宽相关部分） | `fill` 侧现造前缀（`markdown.ts:888-941`） |
| §5 测量 | `measure.ts` 的宽度分配、`table.fitCols` | `paragraphRowsNoSplit` / `wrapParagraph` / `void contWidth` / `measureLeafRows` |
| §6 摊平 | `fill.ts` 的装饰与表格网格 | `decorateRows` 的隐式补白、`hasHeightDecl` |
| §7 组装 | `layout.buildTopRegion` + `renderer` | 无 |

删除的旧契约：`HistoryRow`、`boxToLines`、`tableLines`、`buildBox(local: HistoryRow[])`、`buildContentRows(local, …)`。保留的对外 API：`renderPane(items, pane, options)`（签名改为消费 `PaneItem[]` 的新结构）。

### 迁移与验收

- **切换方式**：建议一次性切换到新链路（旧路径删除），理由是 `HistoryRow` 契约贯穿 `rows.ts` 与 `build-box.ts`，双路径并存会让两套空行 / 前缀逻辑互相污染；为降低风险，先用新增 IR 测试把每段行为钉住，再删旧路径。
- **测试策略**：
  1. 新增 `pipeline-ir` 测试：`split` / `parse` 快照（块类型 + 行内段）、`route` 表驱动、`structure` 结构快照、`measure`→`flatten` 同源断言（不变量 3）。
  2. 旧断言迁移：`pipeline-frame` / `pipeline-equivalence` 的行数表与空行序列改成按 IR 语义推导后逐条人工确认；`pipeline-boxes` / `pipeline-panes` 随新类型重写。
  3. 症状回归：TUI `#1` 的 F3 / F4（断线）、H2（多空行）用例必须全绿，作为本重构的验收门槛。
  4. `npm run check` + `npm run test:tui` + `npm run demo -- --smoke` + 人工真机。
- **基线**：`focus-frame-legacy.json` / `content-mapping-legacy.json` 不含表格，但文本行数会变；按项目约定不静默重冻，需用户明确许可后才重冻，并在文档逐场景记明。
- **风险**：1760 例中至少 `pipeline-*`（约 2500 行测试）与帧断言会大面积受影响；行为差异集中在空行、列表 / 引用前缀、思考行、工具行、压缩模式、表格回退六个面。

### 待审阅的取舍（需用户裁定）

1. 切换方式：一次性删除旧链路，还是先落地「单折行」过渡再整体切换。
2. 基线重冻：是否授权在逐条人工审查 diff 后重冻帧基线；不授权则所有断言改成语义断言。
3. 表格：列宽与行高放在测量段（本设计选是）是否接受——它把表格从「构建期」移到「测量期」。
4. 压缩（`compact`）：作为分流的视图属性 + 摊平期的宽度相关处理（本设计），还是移到结构段生成两种节点。
5. `valign`：仅显式高度生效（本设计），还是允许 auto 高度也补白。
6. 迁移节奏：一次提交完成，还是按段拆成多次提交（分节 + 解析 / 分流 + 结构 / 测量 + 摊平 / 组装），每次跑全量测试。

## 决策

（六项均待用户裁定；选定后在此写明字母与理由，不改历史。）

### 决策项 1：切换方式

- a. 一次性删除旧链路（`HistoryRow` / `boxToLines` / `buildBox` 文本重判），新链路一步到位。
- b. 先落地「单折行」过渡（measure / fill 共用 `wrapLeaf`），再整体切换。
- c. 按段分批切换，每段删除对应的旧代码。

推荐 **a**，前提是先把 IR 测试（`split` / `parse` / `route` / `measure` = `flatten`）写完并由测试守住各段行为；双路径并存会让两套空行与前缀逻辑互相污染。

### 决策项 2：帧基线重冻

- a. 不重冻：所有帧 / 行数断言改写成按 IR 语义推导的断言。
- b. 授权重冻：逐条人工审查 diff 后重冻 `focus-frame-legacy` / `content-mapping-legacy`，过程逐场景记入本文件。
- c. 混合：核心帧断言不重冻，其余重冻。

推荐 **b**，但重冻必须逐条人工确认并留记录（项目禁止静默重冻）。

### 决策项 3：表格的列宽与行高归属

- a. 测量段算列宽与行高（本设计；表格从「构建期」移到「测量期」）。
- b. 结构段算（需要宽度，破坏宽无关分层）。
- c. 摊平段算（违反跨行约束一次算死的要求）。

推荐 **a**。

### 决策项 4：压缩（`compact`）的归属

- a. 分流期作为视图属性，摊平期按宽度压缩（本设计）。
- b. 结构期生成「普通 / 紧凑」两套节点。
- c. 取消压缩功能（不推荐，属既有能力）。

推荐 **a**。

### 决策项 5：`valign` 补白口径

- a. 仅显式高度（表格行 / 面板行）补白，auto 高度不补（本设计）。
- b. auto 高度也按 `Rect.h` 补白（会重新引入「多空行」）。

推荐 **a**。

### 决策项 6：迁移节奏

- a. 一次提交完成全部七段。
- b. 按段拆四次提交：① 分节 + 解析、② 分流 + 结构、③ 测量 + 摊平、④ 组装；每次跑全量测试与 demo。
- c. 两段提交：宽无关（① 至 ④）与宽相关（⑤ 至 ⑦）。

推荐 **b**；每次提交都必须保持可运行（旧链路在切换前仍编译通过）。

## 规划

计划改动文件清单（待决策定稿后细化）：

新增（`TUI/src/app/layout/pipeline/`）：

- `types.ts`：`Section` / `Block` / `PaneItem` / `Leaf` / `RenderRow` / `Rect` / `Geometry`
- `split.ts`、`parse.ts`、`route.ts`、`routeTable.ts`、`structure.ts`
- `wrap.ts`（唯一折行入口）、`measure.ts`（新）、`flatten.ts`、`compose.ts`

改造 / 删除：

- `TUI/src/app/layout/pipeline/boxes.ts`、`panes.ts`、`rows.ts`：并入 §1 至 §4，删除 `boxToLines` / `tableLines` / `HistoryRow`
- `TUI/src/app/layout/build-box.ts`：拆为 §3（分流规则）与 §4（结构），删除文本重判与后处理修补
- `TUI/src/app/layout/measure.ts`、`fill.ts`：按 §5 / §6 重写，删除 `void contWidth`、`wrapAssistantLine` 块级分类、隐式补白
- `TUI/src/app/layout/table.ts`：只保留结构解析与列宽算法（`parseTableAt` / `isTableStart` / `fitCols`），行高改由 `wrapLeaf` 决定
- `TUI/src/app/layout/markdown.ts`：保留 `parseInlineMarkdown` 与行内样式，删除块级分类与 `wrapListRows` 现造前缀
- `TUI/src/app/layout/layout.ts`：只保留 `buildTopRegion` 的视口 / 状态栏合成

测试：

- 新增 `TUI/tests/pipeline-ir.test.ts`（分节 / 解析快照、分流表驱动、结构快照、测量 = 摊平不变量）
- 重写 `pipeline-boxes` / `pipeline-panes` / `pipeline-rows` / `pipeline-frame` / `pipeline-equivalence` / `content-mapping` / `fill`
- `TUI/docs/SPEC.md` 按七段重写 §3（数据契约）与排版规格；`SPEC.md:148` 的列表项口径与实现对齐

明确不做：

- 不改 `TUI/src/renderer/`（只改输入类型）。
- 不改宿主接口、不改 slash 命令、不改状态栏布局。
- 不在本轮引入主题化 / 新视觉能力。

## 实现记录

（待开工。）

## 偏差

（待实现阶段填写。）

## 测试与证据

（待实现阶段填写。）

## 收尾

（待关闭时填写。）
