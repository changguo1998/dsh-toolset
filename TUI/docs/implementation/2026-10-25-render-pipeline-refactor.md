# 重构 TUI 渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析（接取条目：`TUI/docs/BACKLOG.md`「重构渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析」）

状态：决策　　开启：2026-10-25
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
- 现状对应：沿用 `pipeline/sections.ts`。step 头 / 回合分隔线 / 空行等**非 markdown 项**不由 §2 产出（§2 只处理 markdown），改由第 3 段 route 按来源事件边界生成。

### 2. 解析 `parse(section) → Block[]`（类型定稿，2026-10-25）

- 定位：`parse` 纯函数，**只处理 markdown**；把格式控制字符（块级 `#` / `|` / `>` / `-` / 围栏，行内 `**` / `` ` `` / `\*`）在这一步消费成结构化类，不做宽度 / pane / 主题色 / 压缩。
- 输出：块序列 `Block[]`（可嵌套）。**块级闭集仅 5 种**：

```ts
// 行内格式化段（格式控制字符已消费成类）
interface StyledStr {
  text: string;
  color?: FrameColor;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;        // 行内代码
  link?: string;         // 链接
  // 需要更多行内样式（删除线 / 下划线 / 背景）时在此补充
}
type StyledText = StyledStr[];   // 行内内容一律此类型（数组：一段多格式）

// 块闭集（5 种，不可变、带 id；原文不复制，用 span 回引 Section.text）
type Block = Paragraph | Quote | List | Code | Table;

interface Paragraph { kind: "paragraph"; id: string; span: [number, number]; text: StyledText; }
interface Quote      { kind: "quote";      id: string; span: [number, number]; children: Block[]; }
interface List       { kind: "list";       id: string; span: [number, number]; ordered: boolean; depth: number; marker: string; items: Block[]; }
interface Code       { kind: "code";       id: string; span: [number, number]; lang?: string; rows: string[]; closed: boolean; }
interface Table      { kind: "table";      id: string; span: [number, number]; header: Paragraph[]; aligns: TableAlign[]; rows: Paragraph[][]; }
type TableAlign = "left" | "center" | "right";
```

- 统一规则（2026-10-25 定）：**`StyledText` 只出现在 `Paragraph`；其它容器一律装 `Block`**。`Quote.children` / `List.items` 走子块 `Block[]`（多为 `Paragraph`）；表格格 = `Paragraph`（header 格 / 数据格都是 `Paragraph`）；代码行 `rows: string[]` 不参与行内格式化。
- 原文来源唯一：Block **不复制原文**，用一个 `span: [start, end]` 回引它在 `Section.text` 里的区间；复制 / 检索 / 断言从 Section 切片取，单一来源、不重复存。这要求块始终与其源 Section 成组存活（见 §3 的 `EventGroup`），否则 span 悬空。
- `Heading` / `Rule` 无独立块类型，归 `Paragraph`，用 `StyledStr` 样式表达（标题 = bold + 色，分隔线 = 特殊样式 / 铺满线）。
- `List` 只记一个统一 `marker`（`•` / `-` / `*`）；有序编号在摊平期按 `items` 索引生成；任务复选框不设独立字段（如需，用条目 `Paragraph` 的 `StyledStr` 前缀段表达，否则记入 SPEC 已知限制）。
- `Gap` / `StepHead` / `TurnSeparator` / `ToolBatch` **非 markdown，不由 §2 产出**，由 §3 route 按来源事件边界生成。
- 表格：复用 `table.ts` 的 `parseTableAt` / `isTableStart` 产结构，不做列宽、不做折行。
- 唯一性：块级分类正则、围栏状态机、表格解析、inline 解析全部收在这一段；`textParts`（`boxes.ts:205`）、`build-box.ts` 的 `inFence`、`markdown.ts:872` `assistantLineRows` 的块级分类在此合并为一处。
- 契约：`parse` 纯函数；`Block` 不可变（`Object.freeze` / 只读）；每块稳定 `id`（section id + 块内序号）；原文经 `span` 回引 Section.text。

### 3. 分流 `route(groups: EventGroup[], view) → PaneItem[]`（输入定稿，2026-10-25）

- 输入：`groups: EventGroup[]` + 视图状态 `view`（`activityShow` / `compact` / `collapse` / 折叠占位）。**基本单位是分组，不是零散的 Block**：

```ts
// 每个事件（Section）一组：来源元数据 + 该事件解析出的 markdown 块
interface EventGroup {
  provenance: Section;   // 完整来源元数据（source / turn / step / seqs / status? / time?）
  blocks: Block[];       // = parse(provenance)；纯事件型（notice / StepHead）可为 []
}
type PaneItem =
  | Block        // markdown 块（5 种）
  | StepHeader   // step 头（原 StepHead）
  | TurnHeader   // turn 分隔（原 TurnSeparator）
  | Gap          // 空行间隔
  | ToolBatch    // 工具调用批
  // … 其余原非 markdown 项
function route(groups: EventGroup[], view: ViewState): {
  session: PaneItem[];   // 会话区（对话正文）
  turn:    PaneItem[];   // 回合区（思考 / 工具 / 回合内容）
};
```

- 输入按 Section 分组（`EventGroup`），`provenance.source` 是 route 决定 pane 的依据；拼平会丢来源关联，且 Block 的 `span` 需要源 Section 在场。
- 输出分**两路（不同更新语义）**：
  - **对话一路（追加）**：`{ session, turn }` → 每个 pane 一串扁平 `PaneItem[]`。
  - **chrome 一路（刷新）**：`tool` / `statusBar` / `statusCol` / `titleBar` / `input` → 各自一串 `PaneItem[]`，每帧整块重算。
- 每个 pane 内的 `PaneItem` 为**扁平的单一序列**，不再保留 Section / 来源分组。
- `PaneItem` 就是内容项联合（`Block` + 各非 markdown 项：`StepHeader` / `TurnHeader` / `Gap` / `ToolBatch` 等），无 `{item, decoration, visible, key}` 外壳。
- 职责：**唯一**决定「去哪个 pane、顺序、前后留几行空」的规则表：
  - 来源 × 块类型 → pane（正文 final → session；思考 / 工具 / notice → turn；用户块 → session）。
  - 类型间隔（思考 ↔ 正文 1 行、工具不插行）在 route 生成显式 `Gap` 项（空行唯一来源）、step 头（`StepHeader`）、回合分隔（`TurnHeader`）、折叠占位。
  - 压缩开关按类别（think / tool / reply）。
- 规则表要求：以数据表形式落在一个文件里（`routeTable.ts`），禁止散落在 `panes.push`、`noteActKind`、`absorbActivityBlank`、`trimTrailingAssistantBlanks` 等处。
- 不做：宽度、折行、样式解析（前缀 / 悬挂 / 配色放到 §4 结构）。
- 契约：纯函数；同 `view` 下 `EventGroup[]` 到 `{ session, turn }` 确定。

### 4. 结构 `structure(items: PaneItem[]) → LayoutTree`

- 输入：各 pane 的**扁平 `PaneItem[]`**。
- 输出：**一棵完整的 `Node/Leaf` 树**（把所有 pane 组织进同一棵树）。
- 类型（§4 阶段；不叫 `Paragraph`，那是 §2 parse 用的名字，避免命名空间冲突）：

```ts
type Node = { direction: "v" | "h"; children: (Node | Leaf)[]; separator?; id?: PaneId } & NodeBase;
type Leaf = { text: StyledText } & NodeBase;   // = StyledStr[]
type PaneId = "session"|"turn"|"tool"|"statusBar"|"statusCol"|"titleBar"|"input";
type LayoutTree = Node | Leaf;
```

- 本质：**一组 `PaneItem → Node/Leaf` 的映射函数**，把每个扁平元素转成对应节点（`Leaf` 内 `StyledText`、`Node` 挂 direction / children / id / separator），再组合成树。块自带结构（List / Quote 的内容在 §2 已组好），此处只铺平。
- `StepHeader` / `TurnHeader` / `Gap` / `ToolBatch` 在 route 添加时已定位置并转成节点内容，在此作为普通节点。
- 不做：几何字段语义设计、不预设节点闭集、宽度 / 行数 / 列宽 / 补白。
- 契约：同一 `PaneItem[]` 得同构树；节点尺寸字段由 §5 填入。

### 5. 测量 `measure(root, screenSize, view)`

- 输入：`LayoutTree`（根） + 屏幕尺寸 + `view`。
- 做法：**先把屏幕尺寸赋给根 Node**，再跑现有分配逻辑（**递归 + 循环**，参考 `measure.ts` / layout 分配，不重写算法）计算所有子节点尺寸并写回各节点的 `width` / `height`。
- 折行：`wrapLeaf(leaf, w)` 是唯一折行实现；**Leaf 按 `StyledText` 展示长度计宽**（控制字符已在 §2 消费，长度按展示文本算）。
- 表格：列宽用现有 `fitCols` 水位法一次算死（跨行约束），行高 = 单元格 `wrapLeaf` 行数最大值。
- `wrapLeaf` 结果可缓存（键 = 叶子 + 宽 + view 开关），摊平复用。
- 不变式（测试）：叶子 `height === wrapLeaf(leaf, w).length`；任何叶子高度不得估算或外部写死。
- 不做：生成行 / 补白 / 主题色。
- 现状对应：沿用 `measure.ts` 的分配逻辑；`measureLeaf` 改读 `StyledText`、删除 `void contWidth`；`table.ts` 的 `measureLeafRows` 与 `rowBox` 高度写死改读 `wrapLeaf`。

### 6. 摊平 `flatten(tree) → Row[]`

- 输入：一棵已量好的 `Node/Leaf` 树（宽高已在节点上）。
- 输出：**扁平行序列 `Row[]`**（只是「展开成行」，不做屏幕定位 / 合成，上屏在 §7）。
- 职责：逐 `Leaf` 取它的 `wrapLeaf` 行，照 `prefix` / `indent` / `hanging` / `align` 展开成若干 `Row`；表格按列宽铺成网格行（左缘竖线 / 列分隔 / 横线规则行）；空 `Leaf`（Gap）产空行；依据点顺序扁平铺出。
- `valign` 仅在**显式高度**（表格行、面板行）时按已量高补白。
- 不变式（测试）：摊平总行数 === 各节点 `height` 之和；空行只能来自显式 `Gap`（空 Leaf）。
- 不做：决定留白位置 / 改文本 / 折行（已量好）。
- 现状对应：沿用 `fill.ts` 的装饰与表格网格；删除 `decorateRows` 隐式补白、`hasHeightDecl`；`wrapAssistantLine` 的块级分类不再需要。

### 7. 组装 `compose(panes: Record<PaneId, Row[]>, viewport, chrome) → FrameRow[]`

- 输入：各 pane 展开的 `Row[]`（session / turn / tool / statusBar / statusCol / titleBar / input）+ 视口（段键 / 段内行）+ chrome。
- 输出：`FrameRow[]` 交给 `renderer` 逐格上屏。
- 职责（收窄）：**视口定位**（滚动到哪段哪行）、**折叠占位**、把各 pane 的行按屏上布局（状态列 / 主体区 / 标题 / 输入框）排布、**chrome 合成**（状态栏、输入行、在飞工具标记）并合成最终 `FrameRow[]`。
- **不做**：step 头 / 回合分隔的定位（它们在 §3 route 添加 `StepHeader` / `TurnHeader` 时已定位置、转成节点内容，作为普通节点在树内排布）。
- 现状对应：`layout.ts:1033` `buildTopRegion` + `renderer/` 基本不动，只改输入类型。

### 共享件与文件布局（建议）

```text
TUI/src/app/layout/pipeline/
  types.ts        Section / Block / PaneItem / Node / Leaf / Row / FrameRow / NodeBase
  split.ts        §1 分节
  parse.ts        §2 解析（含表格结构、inline 解析调用、围栏状态机）
  route.ts        §3 分流
  routeTable.ts   §3 的规则表（来源 × 块类型 × pane × 可见性 × 间隔）
  structure.ts    §4 结构（PaneItem → Node/Leaf 映射）
  wrap.ts         §5/§6 共用的唯一折行入口 wrapLeaf
  measure.ts      §5 测量（根拿屏幕尺寸 → 递归+循环填各节点宽高）
  flatten.ts      §6 摊平（树 → Row[]）
  compose.ts      §7 组装（各 pane Row[] + 视口 + chrome → FrameRow[]）
  sections.ts     （保留）事件 → Section 的现有适配
```

### 数据与不变量（写成测试）

1. `parse` 输出块数 × 行内解析次数：每块只解析一次（用调用计数断言）。
2. `wrapLeaf` 是唯一折行实现：全仓不允许出现第二处逐字符折行（grep 守门）。
3. 摊平总行数 === 各节点 `height` 之和（同宽度下逐叶子断言）。
4. 块类型闭集：`parse` 产出的块类型必须在闭集内（`satisfies` + 测试）。
5. 空行来源唯一：`Row` 的空行只能由显式 `Gap`（空 Leaf）产生（统计断言）。
6. `Block` / `Node` 不可变：`Object.freeze`（开发期）或只读类型。

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

2026-10-25 六项全部裁定（设计定稿后逐项核对，无需改动；见上「待审阅的取舍」）：

### 决策项 1：切换方式

- a. 一次性删除旧链路（`HistoryRow` / `boxToLines` / `buildBox` 文本重判），新链路一步到位。
- b. 先落地「单折行」过渡（measure / fill 共用 `wrapLeaf`），再整体切换。
- c. 按段分批切换，每段删除对应的旧代码。

**选定 a**。理由：双路径并存会让两套空行与前缀逻辑互相污染；一次性切换，前提是先把 IR 测试（`split` / `parse` / `route` / `structure` / `measure` = `flatten`）写完并由测试守住各段行为。

### 决策项 2：帧基线重冻

- a. 不重冻：所有帧 / 行数断言改写成按 IR 语义推导的断言。
- b. 授权重冻：逐条人工审查 diff 后重冻 `focus-frame-legacy` / `content-mapping-legacy`，过程逐场景记入本文件。
- c. 混合：核心帧断言不重冻，其余重冻。

**选定 b**。理由：项目禁止静默重冻；逐条人工确认 diff 后重冻并留记录。

### 决策项 3：表格的列宽与行高归属

- a. 测量段算列宽与行高（本设计；表格从「构建期」移到「测量期」）。
- b. 结构段算（需要宽度，破坏宽无关分层）。
- c. 摊平段算（违反跨行约束一次算死的要求）。

**选定 a**。理由：与定稿 §5 一致（测量期 fitCols 一次算死，行高 = 单元格 wrapLeaf 最大）。

### 决策项 4：压缩（`compact`）的归属

- a. 分流期作为视图属性，摊平期按宽度压缩（本设计）。
- b. 结构期生成「普通 / 紧凑」两套节点。
- c. 取消压缩功能（不推荐，属既有能力）。

**选定 a**。理由：与定稿 §3（route 按类别压缩开关）+ §6（摊平按宽处理）一致；结构阶段不再生成两套节点。

### 决策项 5：`valign` 补白口径

- a. 仅显式高度（表格行 / 面板行）补白，auto 高度不补（本设计）。
- b. auto 高度也按 `Rect.h` 补白（会重新引入「多空行」）。

**选定 a**。理由：auto 补白会重新引入多空行；与定稿 §6（valign 仅显式高度补白）一致。

### 决策项 6：迁移节奏

- a. 一次提交完成全部七段。
- b. 按段拆四次提交：① 分节 + 解析、② 分流 + 结构、③ 测量 + 摊平、④ 组装；每次跑全量测试与 demo。
- c. 两段提交：宽无关（① 至 ④）与宽相关（⑤ 至 ⑦）。

**选定 a**（用户 2026-10-25 裁定一次性完成）。理由：配合决策 1 的一次性切换，一次提交到位；提交前先由 IR 测试守住各段行为。

## 规划

计划改动文件清单（待决策定稿后细化）：

新增（`TUI/src/app/layout/pipeline/`）：

- `types.ts`：`Section` / `Block` / `PaneItem` / `Node` / `Leaf` / `Row` / `FrameRow` / `NodeBase`
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
