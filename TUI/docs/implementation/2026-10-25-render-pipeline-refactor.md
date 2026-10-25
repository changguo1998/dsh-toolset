# 重构 TUI 渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析（接取条目：`TUI/docs/BACKLOG.md`「重构渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析」）

状态：决策　　开启：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮只建立文档（接取），调研与实现均未开始。

## 目标

从原始文本出发按七段完全重构渲染流水线，实现三件事：

- **结构分类单一源**：块级分类与行内解析各只发生一次，结构随节点进入摊平阶段，不再按文本二次分类。
- **折行单一入口**：measure 与摊平共用同一 `wrapLeaf`，测量行数 = 折行结果长度，修掉 `void contWidth` 造成的多空行 / 断线。
- **最小事件单元**：一次模型交互为一条 `Section`（思考 + 正文 + 工具声明），来源边界清晰，route 按块来源分发。

## 调研

调研方式：只读阅读 + `grep`；未跑 `build` / `test` / `format`，未改源码。行号以 2026-10-25 工作区为准。

### 1. 旧链路与各段职责

| 段 | 入口 | 输入 → 输出 | 是否分类 |
| --- | --- | --- | --- |
| ① 结构 | `pipeline/boxes.ts:205` `textParts` / `:411` `buildBoxes` / `:338` `tableTree` | 节文本 → `Box`（`shape`: text / quote / list / code / table；`role`: block / table / row） | 是（宽无关） |
| ② pane | `panes.ts:63` `PaneItem`、`:206` `push` | `Box[]` → `PaneItem[]`（`kind: "line"` 持 `box`，另有 blank / step-head / step-summary / turn-separator） | 否（只分流 + 空行合并） |
| ③ 摊平 | `rows.ts:261` `boxToLines`、`:395` `tableLines`、`:469` `itemLines`、`:534` `renderPane` | `Box` → `HistoryRow[]`（纯文本行 + kind/final/tone 等旧口径字段） | **否（分类在此丢失）** |
| ④ 重建 | `build-box.ts:369` `buildBox`、`:1315` `buildContentRows` | `HistoryRow[]` → 节点树（`panes.dialogue` / `panes.activity`） | 是（按文本二次分类） |
| ⑤ 测量 | `measure.ts:34` `layout`、`:413` `measureLeaf`、`:502` `paragraphRowsNoSplit` | 节点树 + 宽 → `Rect`（含 `node.height`） | 否（只认 prefix / suffix / indent / hanging） |
| ⑥ 填充 | `fill.ts:356` `fillParagraph`、`:259` `decorateRows` → `ContentRow[]` | 节点树 + `Rect` → 上屏行 | 是（`wrapAssistantLine` 再做块级分类） |

`renderer/` 不参与结构判断，只按 `ContentRow[]` 上屏。

### 2. 分类在 ③ 丢失，④ / ⑥ 各自重判

- ③ `boxToLines`（`rows.ts:261-392`）按 `box.shape` 分流后统一压回文本行：code → 围栏行（`:323-336`）、text / quote / list → `box.text.split("\n")`（`:344-391`）、table → 原始 markdown 行（`tableLines` `:395-442`）。`shape` / `role` 不进入 `HistoryRow`。
- ④ `buildBox` 只能按文本再猜：围栏状态机 `inFence`（`build-box.ts:440` 起、`:740` 附近）、assistant 正文行一律造 `Paragraph`（`:875`）、思考行 / 工具行 / notice / 用户块按行 `kind` 分流，再由 `:1216` `trimTrailingAssistantBlanks`、`:1239` `lineUpBlockBars`、`:1285` `spaceUserAssistant` 等后处理。
- ⑥ `wrapAssistantLine`（`markdown.ts:862` → `:872` `assistantLineRows`）按正则再做一次块级分类：rule → task → heading → quote → list → 内联 markdown（`:874-944`）；列表 / 任务 / 标题的前缀字全部在此现造（`:888`、`:904`、`:917`、`:936`），`wrapListRows`（`:845-854`）负责悬挂缩进。
- 结论：`textParts`（①）与 `assistantLineRows`（⑥）用两套正则表达同一套语义；`SPEC.md:148`「列表项 = `Paragraph(prefix:{"• "}, hanging:2)`」与实现（前缀由 ⑥ 现造，节点上没有 `prefix`）不一致，`SPEC.md:119` 的 `text(prefix …)` 写法同属旧口径。

### 3. 两套折行几何（多空行 / 断线的直接来源）

- ⑤ `measureLeaf`（`measure.ts:413-460`）对 `Paragraph` 用原文折行：`wrapParagraph`（`:463-466`）→ `primitives.ts:85` `wrapLine`，只认 `prefix` / `suffix` / `indent` / `hanging`；`kind === "text"` 走 `paragraphRowsNoSplit`（`:502-512`），`contWidth` 被 `void` 掉（续行宽不参与）。
- ⑥ `fillParagraph`（`fill.ts:356-401`）对同一 `Paragraph` 用行内解析 + 块级分类后折行（`:390` `wrapAssistantLine`）；`wrap:false` 与 `fillBg` 各走一支。
- 行数不等时：`decorateRows`（`fill.ts:259-344`）的 valign 补白按 `rect.h` 补空白行；`hasHeightDecl`（`:347-352`）把 measure 写入的 `height` 也当「显式高度」，所以估值偏高就多出无竖线空行，估值偏低就溢出丢 `┃` / `│`。
- 已被 `TUI #1` 实证的同类项：表格 `measureLeafRows`（`table.ts:319-334`）二次 `parseInlineMarkdown` 导致行高低估、思考行表格末行无竖线；表格回退文本（宽 18）会放大同一口径差。

### 4. 影响面：测试与基线

- `TUI` 共 1760 例；与本次相关：`pipeline-boxes.test.ts`（263 行）、`pipeline-panes.test.ts`（506）、`pipeline-rows.test.ts`（135）、`pipeline-frame.test.ts`（838）、`pipeline-equivalence.test.ts`（412）、`content-mapping.test.ts`（398）、`fill.test.ts`（139）、`table.test.ts`。
- 关键断言：`pipeline-equivalence.test.ts:278-283`（行数表之和 = 实产行数）、`:287`（表格 / 代码块 / 工具批还原形态）；`pipeline-frame.test.ts:400`（回合区空行序列 `["<step>", "┃（先想）", "", "┃中间正文"]`）；`pipeline-rows.test.ts` 直测 `boxToLines` / `renderPane`。
- 基线夹具：`tests/fixtures/focus-frame-legacy.json`、`content-mapping-legacy.json` 内无表格；`npm run demo -- --smoke` 有帧断言。按项目约定不静默重冻，受影响断言逐条人工确认。
- 行缓存键含（宽、pane、活动区开关、紧凑开关）（`rows.ts:516-527`），改折行口径不会使旧缓存串味，但缓存失效面会扩大。

### 5. 规模与风险

- 直接相关代码量：`build-box.ts` 1341 行、`markdown.ts` 945、`rows.ts` 617、`measure.ts` 568、`fill.ts` 534、`boxes.ts` 515、`panes.ts` 401；测试 3000 行以上。
- 主风险：⑤ 行数一变，所有文本高度跟着变 → 空行序列 / 行数表 / 帧断言大面积重排；流水线不再消费 `HistoryRow`，但它是 `state.ts` 的 `Buffer` / `BufferLine` 基础类型，还被 `layout` / `commands` / `index` / `replay` 与 17 个测试文件引用（共 24 文件）——删的是基于它重建节点的渲染链路（`buildBox` / `buildContentRows` / `boxToLines`），行类型本身保留；`pipeline-frame` 的空行语义（块首 / 块尾 / 类型间隔）是历史裁定，容易被顺手改坏。

## 新框架设计

不做局部修补，从原始文本开始按七段完全重构。每一段都是一个独立纯函数 + 一份明确 IR；旧链路（`boxToLines` / `tableLines` / `buildBox` 的文本重判）在新框架中删除。

### 0. 总原则

1. **一次解析**：markdown 块级分类与行内解析各只发生一次（第 2 段），后续任何阶段不得再调 `parseInlineMarkdown` 或按正则猜块类型。
2. **一次折行**：折行只有一个函数 `wrapLeaf(leaf, width)`（第 5 / 6 段共用），测量行数 = 折行结果长度，禁止任何 `ceil` 估算与二次折行；代码行折叠（`wrapCodeLine` / `expandCodeTabs`）是唯一例外。
3. **宽无关在前，宽相关在后**：分节 / 解析 / 分流 / 结构完全不含宽度；测量 / 摊平 / 组装才引入宽度。
4. **空行与装饰是数据**：空行只能由显式的 `Gap` 块产生；前缀（列表符 / 任务框 / 引用竖线 / 标题样式）与 `hanging` 是节点字段，不在渲染时现造。
5. **每段一个入口**：`split` / `parse` / `route` / `structure` / `measure` / `flatten` / `compose`，入参与出参见下。

### 1. 分节 `split(SectionsState) → Section[]`

- 输入：宿主交付的原始文本分片 + 来源元数据（source / turn / step / seqs / time / status）。
- 输出：`Section` 列表。**`Section` = 一次模型交互**（一次推理的完整产出：思考 + 正文 + 工具声明），只记「归属、边界与纯文本槽位」，不含任何 markdown 语义：

```ts
interface Section {
  id: string;                  // 稳定身份: "turn:step:交互序号"
  turn: number; step: number;  // 归属
  time?: number;               // 交互开始时间
  seqs: readonly number[];     // 覆盖的宿主事件号（去重 / 遮蔽判定）
  reasoning?: string;          // 思考, markdown 纯文本(未解析)
  body?: { source: "system"|"user"|"assistant"; text: string };  // 正文, markdown 纯文本(未解析)
  calls?: readonly ToolCall[]; // 工具调用声明(结构化, 非 markdown)
  status?: "running"|"success"|"failure"|"aborted";  // 终态: 挂起/正常/失败/中断
}
```

- 职责：把连续文本按模型交互边界切开——同一次推理的思考、正文、工具声明并进同一条 `Section`；不做行内解释，不删空行。
- 契约：纯函数；与宽度无关；同输入同输出；`Section` 是后续所有阶段的稳定身份（缓存键、段键、跳转目标）。
- **层级**：`session > turn > step > section`（section = 最小事件单元）。
- **现状对应**：沿用 `pipeline/sections.ts` 作事件累积（节缓存 `SectionsState`，旧多 item 节）；新增 `splitSections(state): Section[]` 把旧节 items 按模型推理边界分组（断点 = 块 index 的连续段）。旧节只在展开前存在于 `SectionsState`。
- **恢复路径**：`--resume` / 会话切换时，`replay.ts` 的历史行按模型交互边界分组产新 `Section[]`，不再经旧节缓存。
- step 头 / 回合分隔线 / 空行等**非 markdown 项**不由 §2 产出（§2 只处理 markdown），改由第 3 段 route 按来源事件边界生成。

### 2. 解析 `parse(section) → Block[]`

- 定位：`parse` 纯函数，只处理 markdown；把 `Section` 的两个文本槽位——`reasoning` 与 `body.text`——里的格式控制字符（块级 `#` / `|` / `>` / `-` / 围栏，行内 `**` / `` ` `` / `\*`）消费成结构化类，全部摊开成一条 `Block[]`，不做宽度 / pane / 主题色 / 压缩。
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

// 块闭集（5 种，不可变、带 id；原文不复制，用 span 回引所属槽位原文）
type Block = Paragraph | Quote | List | Code | Table;

interface BlockBase { source: "reasoning" | "system" | "user" | "assistant"; }  // 来源标记, route 分发用
interface Paragraph extends BlockBase { kind: "paragraph"; id: string; span: [number, number]; text: StyledText; }
interface Quote      extends BlockBase { kind: "quote";      id: string; span: [number, number]; children: Block[]; }
interface List       extends BlockBase { kind: "list";       id: string; span: [number, number]; ordered: boolean; marker: string; items: Block[]; }
interface Code       extends BlockBase { kind: "code";       id: string; span: [number, number]; lang?: string; rows: string[]; closed: boolean; }
interface Table      extends BlockBase { kind: "table";      id: string; span: [number, number]; header: Paragraph[]; aligns: TableAlign[]; rows: Paragraph[][]; }
type TableAlign = "left" | "center" | "right";
```

- 统一规则：`StyledText` 只出现在 `Paragraph`，其它容器一律装 `Block`。`Quote.children` / `List.items` 走子块 `Block[]`（多为 `Paragraph`）；表格格 = `Paragraph`（header 格 / 数据格都是 `Paragraph`）；代码行 `rows: string[]` 不参与行内格式化。
- **两个解析入口（格式不同）**：
  - **markdown**：`reasoning` 与 `body.text` 走行内 / 块级解析 → 文本 `Block`（各块带 `source`）。
  - **工具**：`calls` 是结构化格式（非 markdown），不经 markdown 解析器；其显示形态用约定 markdown 语法组合（工具名行 → 带标记的 `Paragraph`，参数行 → 缩进 / 悬挂 `Paragraph`，结果行 → 带状态的 `Paragraph`），由现有 5 种块拼出，不新增块类型；结构化数据（`callId` 配对、结果回填）仍留在 `Section.calls`（事件层，组合显示时取用）。
- 原文来源唯一：Block 不复制原文，用 `span: [start, end]` 回引所属槽位的原文区间（`Section.reasoning` 或 `Section.body.text`，含控制字符）；`span` 只作范围标记（检索 / 复制 / 断言取原文），`StyledText` 是行内解析产物（控制符已吸收），两者形态不同、不重复存原文。这要求块始终与其源 Section 成组存活（见 §3 的 `EventGroup`），否则 span 悬空。
- `Heading` / `Rule` 无独立块类型，归 `Paragraph`，用 `StyledStr` 样式表达（标题 = bold + 色，分隔线 = 特殊样式 / 铺满线）。
- `List` 不记 `depth`：嵌套由 `items: Block[]`（可含 `List`）递归表达，层级深度靠递归推导；有序编号在递归展开时按 `items` 索引生成；任务复选框不设独立字段（如需，用条目 `Paragraph` 的 `StyledStr` 前缀段表达，否则记入 SPEC 已知限制）。
- `Gap` / `StepHeader` / `TurnHeader` 非 markdown，不由 §2 产出，由 §3 route 按来源事件边界生成。
- 表格：复用 `table.ts` 的 `parseTableAt` / `isTableStart` 产结构，不做列宽、不做折行。
- 唯一性：块级分类正则、围栏状态机、表格解析、inline 解析全部收在这一段；`textParts`（`boxes.ts:205`）、`build-box.ts` 的 `inFence`、`markdown.ts:872` `assistantLineRows` 的块级分类在此合并为一处。
- 契约：`parse` 纯函数；`Block` 不可变（`Object.freeze` / 只读，解析产物）；每块稳定 `id`（section id + 块内序号）；原文经 `span` 回引所属槽位。`Node` / `Leaf` 可变（§5 measure 原地写宽高），冻结只限 `Block`。

### 3. 分流 `route(groups: EventGroup[], view, …) → { session, turn }`

- 输入：`groups: EventGroup[]` + 视图状态 `view`（`activityShow` / `compact` / `collapse` / 折叠占位）。基本单位是分组，不是零散的 Block：

```ts
// 每个模型交互（Section）一组：来源元数据 + 该交互解析摊开的 markdown 块
interface EventGroup {
  provenance: Section;   // 完整来源元数据（id / turn / step / seqs / status? / time?）
  blocks: Block[];       // = parse(provenance) 摊开的文本块(思考 + 正文), 各块带 source
  calls?: readonly ToolCall[];  // 工具声明(结构化, 数据留 Section; 显示由 route 组合成批)
}
type PaneItem =
  | Block        // markdown 块（5 种, 成品）
  | StepHeader   // step 头（原 StepHead）
  | TurnHeader   // turn 分隔（原 TurnSeparator）
  | Gap          // 空行间隔
  | ToolBatch    // 工具调用批(由 calls 组合出的显示形态, 内部用现有 Block 表达)
  | StepSummary  // P9 恢复的 step 概要行
// 各变体均带稳定段键 `key`（滚动定位 / 重映射用, 但不用 {item, decoration, visible, key} 四字段外壳）
function route(groups: EventGroup[], view: ViewState, …): {
  session: PaneItem[];   // 会话区（对话正文）
  turn:    PaneItem[];   // 回合区（思考 / 工具 / 回合内容）
};
```

- 输入按 Section 分组（`EventGroup`），route 按 `Block.source` 决定 pane：`reasoning` → turn；`system / user / assistant` 正文 → session；工具批（`calls`）→ turn。拼平会丢来源关联，且 Block 的 `span` 需要源 Section 在场。
- **route 只做对话一路（追加）**：`{ session, turn }` → 每个 pane 一串扁平 `PaneItem[]`。chrome 五 pane（`tool` / `statusBar` / `statusCol` / `titleBar` / `input`）不是 route 的产物，由独立的 chrome 刷新一路每帧整块重算产出（来源 = 当前工具状态 / 状态栏 / 标题 / 输入框）。
- 两路在最顶层同层级平铺（都是「各自 pane 的 `PaneItem[]`」，不出现一路被包成对象、另一路散开的不对称），在 §4 structure（`buildTree`）拼接成一棵完整树。
- `route` 入参允许多个独立参数（groups / view / …），不强行收成单一参数对象。
- 每个 pane 内的 `PaneItem` 为扁平的单一序列，不再保留 Section / 来源分组。
- `StepHeader` / `TurnHeader` / `Gap` / `ToolBatch` / `StepSummary` 只作占位类型：字段沿用旧 `panes.ts` 的 step-head / turn-separator / step-summary、`boxes.ts` 的 `ToolBatch`，本任务不重新设计；其中 `ToolBatch` 的显示形态内部用现有 5 种 Block 组合（见 §2）。
- 职责：唯一决定「去哪个 pane、顺序、前后留几行空」的规则表：
  - `Block.source` × 块类型 → pane（正文 → session；思考 / 工具 / notice → turn）。
  - 类型间隔（思考 ↔ 正文 1 行、工具不插行）在 route 生成显式 `Gap` 项（空行唯一来源）、step 头（`StepHeader`）、回合分隔（`TurnHeader`）、折叠占位。
  - 压缩开关按类别（think / tool / reply）。
- 规则表要求：以数据表形式落在一个文件里（`routeTable.ts`），禁止散落在 `panes.push`、`noteActKind`、`absorbActivityBlank`、`trimTrailingAssistantBlanks` 等处。
- 不做：宽度、折行、样式解析（前缀 / 悬挂 / 配色放到 §4 结构）。
- 契约：纯函数；同 `view` 下 `EventGroup[]` 到 `{ session, turn }` 确定。

### 4. 结构 `structure(panes: Record<PaneId, PaneItem[]>) → LayoutTree`

- 输入：§3 的全部 pane——route 产出的 `{ session, turn }` 与 chrome 刷新路产出的五个 pane（`tool` / `statusBar` / `statusCol` / `titleBar` / `input`），两路在此拼接成各 pane 的扁平 `PaneItem[]`（同一层级，见 §3）。
- 输出：一棵完整的 `Node/Leaf` 树（把所有 pane 组织进同一棵树）。
- 类型（§4 阶段；不叫 `Paragraph`，那是 §2 parse 用的名字，避免命名空间冲突）：

```ts
type Node = { direction: "v" | "h"; children: (Node | Leaf)[]; separator?; id?: PaneId } & NodeBase;
type Leaf = { text: StyledText } & NodeBase;   // = StyledStr[]
type PaneId = "session"|"turn"|"tool"|"statusBar"|"statusCol"|"titleBar"|"input";
type LayoutTree = Node | Leaf;
```

- 本质：一组 `PaneItem → Node/Leaf` 的映射函数，把每个扁平元素转成对应节点（`Leaf` 内 `StyledText`、`Node` 挂 direction / children / id / separator），再组合成树。块自带结构（List / Quote 的内容在 §2 已组好），此处只铺平。
- `StepHeader` / `TurnHeader` / `Gap` / `ToolBatch` / `StepSummary` 在 route 添加时已定位置并转成节点内容，在此作为普通节点。
- 不做：几何字段语义设计、不预设节点闭集、宽度 / 行数 / 列宽 / 补白。
- 契约：同一 `PaneItem[]` 得同构树；节点尺寸字段由 §5 填入。

### 5. 测量 `measure(root, screenSize, view)`

- 输入：`LayoutTree`（根）+ 屏幕尺寸 + `view`（计算高度分配时有用；另作 `wrapLeaf` 缓存键的组成部分）。
- 做法：先把屏幕尺寸赋给根 Node，再跑现有分配逻辑（递归 + 循环，参考 `measure.ts` / layout 分配，不重写算法）计算所有子节点尺寸并写回各节点的 `width` / `height`。
- 折行：`wrapLeaf(leaf, w)` 是唯一折行实现；Leaf 按 `StyledText` 展示长度计宽（控制字符已在 §2 消费，长度按展示文本算）。
- 表格：列宽用现有 `fitCols` 水位法一次算死（跨行约束）；单元格 = 正常 `Paragraph`，按正文排版走 `wrapLeaf`（表格特殊性只在列宽分配，不在折行），行高 = 单元格 `wrapLeaf` 行数最大值。
- `wrapLeaf` 结果可缓存（键 = 叶子 + 宽 + view 开关），摊平复用。
- 不变式（测试）：叶子 `height === wrapLeaf(leaf, w).length`；任何叶子高度不得估算或外部写死。
- 不做：生成行 / 补白 / 主题色。
- 现状对应：沿用 `measure.ts` 的分配逻辑；`measureLeaf` 改读 `StyledText`、删除 `void contWidth`；`table.ts` 的 `measureLeafRows` 与 `rowBox` 高度写死改读 `wrapLeaf`。

### 6. 摊平 `flatten(tree) → Record<PaneId, Row[]>`

- 输入：一棵已量好的 `Node/Leaf` 树（宽高已在节点上）。
- 输出：各 pane 的扁平行序列 `Record<PaneId, Row[]>`（只是「展开成行」，不做屏幕定位 / 合成，上屏在 §7；pane 归属由返回的 `Record` 承载，`Row` 内不重复带 pane 字段）。
- 职责：逐 `Leaf` 取它的 `wrapLeaf` 行，照 `prefix` / `indent` / `hanging` / `align` 展开成若干 `Row`；表格按列宽铺成网格行（左缘竖线 / 列分隔 / 横线规则行）；空 `Leaf`（Gap）产空行；依据点顺序扁平铺出。
- 装饰（分隔线铺满 / 代码底色补齐 / step 头尾部 `╌`）：内容在节点字段，宽度由 §5 已填的 `width` / `tail` / `fillBg` 决定，flatten 只读不现造。
- `valign` 仅在 `heightFixed`（显式声明高度：表格行、面板行）时按已量高补白；不读 measure 写的 `height` 当显式高度（旧 `hasHeightDecl` 把估值当声明 → 多空行，此路径绕开）。
- 不变式（测试）：摊平总行数 === 各节点 `height` 之和；空行只能来自显式 `Gap`（空 Leaf）。
- 不做：决定留白位置 / 改文本 / 折行（已量好）。
- 现状对应：沿用 `fill.ts` 的装饰与表格网格；删除 `decorateRows` 隐式补白、`hasHeightDecl`；`wrapAssistantLine` 的块级分类不再需要。

### 7. 组装 `compose(panes: Record<PaneId, Row[]>, viewport, chrome) → FrameRow[]`

- 输入：各 pane 展开的 `Row[]`（session / turn / tool / statusBar / statusCol / titleBar / input）+ 视口（段键 / 段内行）+ chrome。
- 输出：`FrameRow[]` 交给 `renderer` 逐格上屏。
- 职责（收窄）：视口定位（滚动到哪段哪行）、折叠占位、把各 pane 的行按屏上布局（状态列 / 主体区 / 标题 / 输入框）排布、chrome 合成（状态栏、输入行、在飞工具标记）并合成最终 `FrameRow[]`。
- 不做：step 头 / 回合分隔的定位（它们在 §3 route 添加 `StepHeader` / `TurnHeader` 时已定位置、转成节点内容，作为普通节点在树内排布）。
- 现状对应：`layout.ts:1033` `buildTopRegion` + `renderer/` 基本不动，只改输入类型。

### 共享件与文件布局

```text
TUI/src/app/layout/pipeline/
  ir.ts          Section / Block / PaneItem / Node / Leaf / Row / FrameRow / NodeBase
                 （新 IR 类型；不占 pipeline/types.ts，旧文件名留给节缓存类型）
  split.ts       §1 分节（splitSections：SectionsState → Section[]）
  parse.ts       §2 解析（含表格结构、inline 解析调用、围栏状态机）
  route.ts       §3 分流（对话一路 {session, turn}）
  routeTable.ts  §3 的规则表（来源 × 块类型 × pane × 可见性 × 间隔）
  structure.ts   §4 结构（route + chrome 两路拼接 → Node/Leaf 映射）
  wrap.ts        §5/§6 共用的唯一折行入口 wrapLeaf
  measure.ts     §5 测量（根拿屏幕尺寸 → 递归+循环填各节点宽高）
  flatten.ts     §6 摊平（树 → Record<PaneId, Row[]>）
  compose.ts     §7 组装（各 pane Row[] + 视口 + chrome → FrameRow[]）
  sections.ts    （保留）事件 → 旧节缓存（SectionsState）的现有适配
  types.ts       （保留，不改）节缓存类型：旧 Section / Item / ToolCall / ToolResult / Delivery / BlockDelivery
```

### 数据与不变量（写成测试）

1. `parse` 输出块数 × 行内解析次数：每块只解析一次（用调用计数断言）。
2. `wrapLeaf` 是文本叶唯一折行实现：全仓不允许出现第二处文本叶逐字符折行（grep 守门；代码行折叠 `wrapCodeLine` / `expandCodeTabs` 除外）。
3. 摊平总行数 === 各节点 `height` 之和（同宽度下逐叶子断言）。
4. 块类型闭集：`parse` 产出的块类型必须在闭集内（`satisfies` + 测试）。
5. 空行来源唯一：`Row` 的空行只能由显式 `Gap`（空 Leaf）产生（统计断言）。
6. 只冻结 `Block`（解析产物，开发期 `Object.freeze` 或只读类型）；`Node` / `Leaf` 可变（§5 原地写宽高）。

### 与旧链路的映射与删除清单

| 新段 | 取旧代码的什么 | 删除什么 |
| --- | --- | --- |
| §1 分节 | `pipeline/sections.ts`（事件 → 节缓存）；新增 `splitSections` 分组旧节 items；`replay.ts` 恢复直接产新 Section | 无 |
| §2 解析 | `boxes.textParts` 的结构识别、`table.parseTableAt`、`build-box` 的围栏状态机、`markdown.assistantLineRows` 的块级分类 | 三处重复分类；`assistantLineRows` 的分类分支 |
| §3 分流 | `panes.push` 的分流与空行、`build-box` 的 `noteActKind` / `absorbActivityBlank` / `trimTrailingAssistantBlanks` / `spaceUserAssistant`；`boxes.pairToolResults` / `seqHit` 移入工具批处理 | 分散在多个后处理里的间隔规则 |
| §4 结构 | `build-box` 的节点构建（去掉宽相关部分） | `fill` 侧现造前缀（`markdown.ts:888-941`） |
| §5 测量 | `measure.ts` 的宽度分配（`naturalWidthOf` / `measureWidthAt` / `fixedWidthSum` / `writeAutoWidth` / `snapshot` 等）、`table.fitCols` | `paragraphRowsNoSplit` / `wrapParagraph` / `void contWidth` / `measureLeafRows` |
| §6 摊平 | `fill.ts` 的装饰与表格网格、`balancedWidth`（并入 `wrapLeaf.balance`） | `fill` / `fillBoxTree` / `fillToList` / `fillBox` / `rowMeta`、`decorateRows` 隐式补白、`hasHeightDecl` |
| §7 组装 | `layout.buildTopRegion` + `renderer`；`pipeline/frame.ts`（视口 / 段定位 / `sectionGroupStarts`） | 无 |

删除的旧契约：`boxToLines`、`tableLines`、`buildBox(local: HistoryRow[])`、`buildContentRows(local, …)`、旧 `box.ts` 布局树类型（`Box` / `Paragraph` / `StyledText` / `Node` / `NodeBase` / `PaneId`，由新 IR 类型取代；`Rect` 若仍需要移入 `ir.ts`）。

`HistoryRow` 不删：它是 `state.ts` 的 `Buffer` / `BufferLine` 基础与恢复重放的行输入类型；流水线只是不再消费它，`replay.ts` 原样保留但产出改为新 `Section[]`。

保留的对外 API：`renderPane(items, pane, options)`（签名改为消费 `PaneItem[]` 的新结构；`pane` 参数现为 `"dialogue" | "activity"`，映射到新 `PaneId` 的 `session` / `turn`）。

### 迁移与验收

- **切换方式**：一次性切换到新链路（旧路径删除），理由是 `HistoryRow` 契约贯穿 `rows.ts` 与 `build-box.ts`，双路径并存会让两套空行 / 前缀逻辑互相污染；为降低风险，先用新增 IR 测试把每段行为钉住，再删旧路径。
- **测试策略**：
  1. 新增 `pipeline-ir` 测试：`split` / `parse` 快照（块类型 + 行内段）、`route` 表驱动、`structure` 结构快照、`measure`→`flatten` 同源断言（不变量 3）。
  2. 旧断言迁移：`pipeline-frame` / `pipeline-equivalence` 的行数表与空行序列改成按 IR 语义推导后逐条人工确认；`pipeline-boxes` / `pipeline-panes` 随新类型重写。
  3. 症状回归：TUI `#1` 的 F3 / F4（断线）、H2（多空行）用例必须全绿，作为本重构的验收门槛。
  4. `npm run check` + `npm run test:tui` + `npm run demo -- --smoke` + 人工真机。
- **基线**：`focus-frame-legacy.json` / `content-mapping-legacy.json` 不含表格，但文本行数会变；按项目约定不静默重冻，需用户明确许可后才重冻，并在文档逐场景记明。
- **风险**：1760 例中至少 `pipeline-*`（约 2500 行测试）与帧断言会大面积受影响；行为差异集中在空行、列表 / 引用前缀、思考行、工具行、压缩模式、表格回退六个面。

## 决策

六项全部裁定（设计定稿后逐项核对，无需改动）：

### 决策项 1：切换方式

- a. 一次性删除旧链路（`HistoryRow` / `boxToLines` / `buildBox` 文本重判），新链路一步到位。
- b. 先落地「单折行」过渡（measure / fill 共用 `wrapLeaf`），再整体切换。
- c. 按段分批切换，每段删除对应的旧代码。

**选定 a**。理由：双路径并存会让两套空行与前缀逻辑互相污染；一次性切换，前提是先把 IR 测试（`split` / `parse` / `route` / `structure` 快照 + `measure` → `flatten` 同源不变式）写完并由测试守住各段行为。

### 决策项 2：帧基线重冻

- a. 不重冻：所有帧 / 行数断言改写成按 IR 语义推导的断言。
- b. 授权重冻：逐条人工审查 diff 后重冻 `focus-frame-legacy` / `content-mapping-legacy`，过程逐场景记入本文件。
- c. 混合：核心帧断言不重冻，其余重冻。

**选定 b**。理由：项目禁止静默重冻；逐条人工确认 diff 后重冻并留记录。

### 决策项 3：表格的列宽与行高归属

- a. 测量段算列宽与行高（表格从「构建期」移到「测量期」）。
- b. 结构段算（需要宽度，破坏宽无关分层）。
- c. 摊平段算（违反跨行约束一次算死的要求）。

**选定 a**。理由：与定稿 §5 一致（测量期 fitCols 一次算死，行高 = 单元格 wrapLeaf 最大）。

### 决策项 4：压缩（`compact`）的归属

- a. 分流期作为视图属性，摊平期按宽度压缩。
- b. 结构期生成「普通 / 紧凑」两套节点。
- c. 取消压缩功能（不推荐，属既有能力）。

**选定 a**。理由：与定稿 §3（route 按类别压缩开关）+ §6（摊平按宽处理）一致；结构阶段不再生成两套节点。

### 决策项 5：`valign` 补白口径

- a. 仅显式高度（表格行 / 面板行）补白，auto 高度不补。
- b. auto 高度也按 `Rect.h` 补白（会重新引入「多空行」）。

**选定 a**。理由：auto 补白会重新引入多空行；与定稿 §6（valign 仅显式高度补白）一致。

### 决策项 6：迁移节奏

- a. 一次提交完成全部七段。
- b. 按段拆四次提交：① 分节 + 解析、② 分流 + 结构、③ 测量 + 摊平、④ 组装；每次跑全量测试与 demo。
- c. 两段提交：宽无关（① 至 ④）与宽相关（⑤ 至 ⑦）。

**选定 a**（一次性完成）。理由：配合决策 1 的一次性切换，一次提交到位；提交前先由 IR 测试守住各段行为。

## 规划

### 计划改动文件清单

新增（`TUI/src/app/layout/pipeline/`）：

- `ir.ts`：`Section` / `Block` / `PaneItem` / `Node` / `Leaf` / `Row` / `FrameRow` / `NodeBase`（不占 `types.ts`，旧文件名留给节缓存类型）
- `split.ts`（`splitSections`）、`parse.ts`、`route.ts`、`routeTable.ts`、`structure.ts`
- `wrap.ts`（唯一折行入口）、`measure.ts`（新）、`flatten.ts`、`compose.ts`

改造 / 删除：

- `TUI/src/app/layout/pipeline/boxes.ts`、`panes.ts`、`rows.ts`：并入 §1 至 §4，删除 `boxToLines` / `tableLines` / `buildPanes`（`HistoryRow` 不删）
- `TUI/src/app/layout/build-box.ts`：拆为 §3（分流规则）与 §4（结构），删除文本重判与后处理修补
- `TUI/src/app/layout/box.ts`：删除（旧布局树类型由 `ir.ts` 取代）
- `TUI/src/app/layout/measure.ts`、`fill.ts`：按 §5 / §6 重写，删除 `void contWidth`、`wrapAssistantLine` 块级分类、隐式补白、`fill` 主入口
- `TUI/src/app/layout/table.ts`：只保留结构解析与列宽算法（`parseTableAt` / `isTableStart` / `fitCols`），行高改由 `wrapLeaf` 决定
- `TUI/src/app/layout/markdown.ts`：保留 `parseInlineMarkdown` 与行内样式，删除块级分类与 `wrapListRows` 现造前缀
- `TUI/src/app/layout/layout.ts`：只保留 `buildTopRegion` 的视口 / 状态栏合成
- `TUI/src/app/layout/pipeline/replay.ts`：保留，产出从旧节改为新 `Section[]`；`frame.ts` 保留（视口 / 段定位）

测试：

- 新增 `TUI/tests/pipeline-ir.test.ts`（分节 / 解析快照、分流表驱动、结构快照、测量 = 摊平不变量）
- 重写 `pipeline-boxes` / `pipeline-panes` / `pipeline-rows` / `pipeline-frame` / `pipeline-equivalence` / `content-mapping` / `fill`
- `TUI/docs/SPEC.md` 按七段重写 §3（数据契约）与排版规格；`SPEC.md:148` 的列表项口径与实现对齐

明确不做：

- 不改 `TUI/src/renderer/`（只改输入类型）。
- 不改宿主接口、不改 slash 命令、不改状态栏布局。
- 不在本轮引入主题化 / 新视觉能力。

### 函数保留 / 删除对照（供实现对照）

按阶段与文件：

- **§1 分节**：`pipeline/sections.ts` 整文件保留沿用（事件 → 节缓存 `SectionsState`）；新增 `splitSections(state): Section[]` 按模型推理边界分组；`pipeline/replay.ts` 保留，恢复产出改为新 `Section[]`；`pipeline/frame.ts` 保留（视口 / 段定位 / `sectionGroupStarts`）。
- **§2 解析**：
  - 保留（底层）：`markdown.ts` 的 `parseInlineMarkdown` / `charWidth` / `displayWidth` / `wrapFrameSegments` / `expandCodeTabs` / `wrapCodeLine`。
  - 移到 §2 parse：`boxes.textParts` / `buildBoxes` / `computeBoxes` 的块分类逻辑、`fenceLang`、`table.parseTableAt` / `isTableStart` / `splitCells` / `hasCellPipe`。
  - 删除：`markdown.wrapAssistantLine` / `assistantLineRows` / `wrapListRows` 及块级正则分类（并入 parse）；`table.measureLeafRows`（二次解析）。
- **§3 分流**：
  - 删除：`panes.buildPanes` / `push` / `blank` / `visibleAtLevel` / `isDialogue` / `actKind` / `toLines` / `roleOf`（并入 `routeTable.ts` / `route`）。
  - 保留：`panes.sectionIdentities`、`boxes.applyShadowed`、`boxes.toolUnits` / `isEmptyToolResult`。
  - 移入工具批处理：`boxes.pairToolResults`（结果配对）、`boxes.seqHit`（遮蔽判定）。
- **§4 结构**：
  - 删除：`build-box.buildBox` / `buildContentRows`（文本重判）+ `finalSpace` / `absorbActivityBlank` / `trimTrailingAssistantBlanks` / `lineUpBlockBars` / `spaceUserAssistant` / `stripTrailingNewline`。
  - 改写为映射：`boxes.toolBox`、`build-box.noticeLinePresentation` / `toolCallSegs` / `toolLineSegs` / `codeBlockRows` / `wrapCodeRows`。
- **§5 测量**：
  - 保留：`measure.ts` 的 `layout` / `seedWidth` / `allocateWidths` / `allocateHeights` / `allocateNode` / `measurePass` / `clampWidth` 及分配辅助 `naturalWidthOf` / `measureWidthAt` / `fixedWidthSum` / `writeAutoWidth` / `snapshot` / `isSame` / `collectRects` 等；`table.fitCols` / `waterLevel` / `fitTo` / `minColWidth`。
  - 删除 / 改写：`measureLeaf` 的折行改 `wrapLeaf`；删 `wrapParagraph` / `paragraphRows` / `paragraphRowsNoSplit` / `void contWidth`。
- **§6 摊平**：
  - 保留（基础）：`fill.separatorRow` / `prefixVisible` / `suffixVisible` / `splitPhysical` / `splitAndWrapSegments` / `mergeStyleLike` / `emptyRow` / `build-box.fitSegments` / `tailToWidth`；`fill.balancedWidth` 并入 `wrapLeaf.balance`。
  - 删除：`fill.fill` / `fillBoxTree` / `fillToList` / `fillBox` / `rowMeta`（被 §6 flatten 取代）+ `fillParagraph` / `fillStyled` / `decorateRows` / `hasHeightDecl`（隐式补白与块级分类）+ `rows.boxToLines` / `tableLines` / `kindOf` / `itemLines`。
  - 改写：`table.cellLeaf` / `vLineLeaf` / `hRuleLeaf` / `gridRow` / `rowBox` / `ruleRow` / `tableBox` → §6（行高改 `wrapLeaf`）。
- **§7 组装 + 视口 / 缓存**：保留 `layout.buildTopRegion`（只改输入类型）；保留 `rows` 的 LineTable / 视口 / 段定位与 `renderPane`（对外 API，`pane` 参数 `"dialogue" | "activity"` 映射新 `PaneId` 的 `session` / `turn`）、`rowCache`（适配新 key）。
- **旧文件去留**：`box.ts`（旧布局树 `Box` / `Paragraph` / `StyledText` / `Node` / `NodeBase` / `PaneId` / `Rect`）删除，由新 IR 类型（`ir.ts`）取代（`Rect` 若仍需要移入 `ir.ts`）；`pipeline/types.ts`（旧 `Section` / `Item` / `ToolCall` / `ToolResult` / `Delivery` / `BlockDelivery`）保留（节缓存 `split` 之前仍需，不动）。
- **纯删除的旧契约**：`boxToLines`、`tableLines`、`buildBox`、`buildContentRows`、`wrapAssistantLine` 块级分类。`HistoryRow` 不在删除清单（保留为 `state.ts` 的 `Buffer` / `BufferLine` 基础与恢复行输入）。

### 函数接口契约

```ts
// ================= §1 分节 (沿用 sections.ts + 新增 splitSections) =================
createSections(): SectionsState
applyDelivery(state: SectionsState, item: Item): SectionsState
allSections(state: SectionsState): readonly Section[]
itemOf(section: Section, source: Source): Item | undefined
splitSections(state: SectionsState): Section[]   // 旧节 items 按模型推理边界分组 → 一次模型交互 Section
replaySections(rows: readonly HistoryRow[]): Section[]  // 恢复: 历史行按交互边界 → 新 Section[]

// ================= 共享类型 (ir.ts) =================
// Section = 一次模型交互: { id; turn; step; time?; seqs: number[]; reasoning?: string;
//   body?: { source: "system"|"user"|"assistant"; text: string }; calls?: ToolCall[]; status? }
interface StyledStr { text: string; color?; bold?; italic?; code?; link? }
type StyledText = StyledStr[]
interface BlockBase { source: "reasoning"|"system"|"user"|"assistant" }   // 来源标记, route 分发
type Block =
  | Paragraph extends BlockBase{ span; text: StyledText }
  | Quote     extends BlockBase{ span; children: Block[] }
  | List      extends BlockBase{ span; ordered; marker; items: Block[] }   // 不记 depth, 嵌套靠递归
  | Code      extends BlockBase{ span; lang?; rows: string[]; closed }
  | Table     extends BlockBase{ span; header: Paragraph[]; aligns; rows: Paragraph[][] }
type EventGroup = { provenance: Section; blocks: Block[]; calls?: readonly ToolCall[] }
type PaneItem = Block | StepHeader | TurnHeader | Gap | ToolBatch | StepSummary
// 各变体均带稳定段键 key; StepHeader/TurnHeader/Gap/ToolBatch/StepSummary 为占位类型, 字段沿用旧实现
type PaneId = "session"|"turn"|"tool"|"statusBar"|"statusCol"|"titleBar"|"input"
interface NodeBase { width?/height?/heightFixed?/align?/valign?/prefix?/hanging?/indent?/tail?/style?/wrap?/balance?/fillBg?/… }
interface Node extends NodeBase { direction: "v"|"h"; children: (Node|Leaf)[]; separator?; id?: PaneId }
interface Leaf extends NodeBase { text: StyledText }
type LayoutTree = Node | Leaf
type Row = { segments: FrameSegment[]; indent?: number; prefix?: FrameSegment[]; align?: "left"|"center"|"right" }
// FrameRow 复用 renderer/screen.ts 既有定义

// ================= §2 解析 parse.ts =================
parse(section: Section): Block[]                 // reasoning 与 body.text 都解析, 摊成一条 Block[](带 source)
// 工具: 结构化 calls, 不经 markdown 解析; 显示形态由现有 Block 组合, 数据留 Section.calls
// 复用: markdown.parseInlineMarkdown(text): FrameSegment[]   (行内底层)
// 复用: table.parseTableAt / isTableStart / splitCells / hasCellPipe  (表格结构)

// ================= §3 分流 route.ts + routeTable.ts =================
// route 只做对话一路(追加); chrome 五 pane 由独立刷新路产出; 两路在 §4 拼接
route(groups: EventGroup[], view: ViewState, …): { session: PaneItem[]; turn: PaneItem[] }
// 分发判据 = Block.source: reasoning→turn / 正文→session; 工具批(calls)→turn
// chrome 刷新路(独立, 非 route 产物): tool / statusBar / statusCol / titleBar / input → PaneItem[]
type ViewState = { activityShow; compact; collapse; 折叠占位 }
// routeTable.ts: 规则表(数据), route 消费, 不在别处散落
// 复用: panes.sectionIdentities; boxes.applyShadowed / toolUnits / isEmptyToolResult / pairToolResults / seqHit

// ================= §4 结构 structure.ts =================
buildTree(panes: Record<PaneId, PaneItem[]>): LayoutTree   // 两路拼接 → 一棵完整树
toNode(block: Block): Node | Leaf                          // PaneItem→Node 映射
toToolNode(toolBatch: ToolBatch): Node
toStepHeader(stepHeader: StepHeader): Leaf
toTurnHeader(turnHeader: TurnHeader): Leaf
toGap(gap: Gap): Leaf                                      // 空 Leaf(显式间隔)

// ================= wrap.ts (唯一折行, §5/§6 共用) =================
wrapLeaf(text: StyledText, width: number, opts: {
  prefixW: number; hanging: number; balance?: boolean;
}): FrameSegment[][]                                        // 行数组, 长度即高度; 文本叶折行唯一入口
// 例外: 代码行折叠 wrapCodeLine / expandCodeTabs; balancedWidth 并入 balance

// ================= §5 测量 measure.ts (沿用分配算法) =================
measure(root: LayoutTree, screen: { w; h }, view: ViewState): void  // 根拿屏幕尺寸, 递归+循环填宽高; view 保留(高度分配用)
// 保留: layout / seedWidth / allocateWidths / allocateHeights / allocateNode / measurePass / clampWidth
//        + naturalWidthOf / measureWidthAt / fixedWidthSum / writeAutoWidth / snapshot 等
// 复用: table.fitCols / waterLevel / fitTo / minColWidth    // 表格列宽
// 改: measureLeaf 折行 → wrapLeaf(text 按 StyledText 展示长)

// ================= §6 摊平 flatten.ts =================
flatten(tree: LayoutTree): Record<PaneId, Row[]>            // 树 → 各 pane 扁平行(不上屏)
// 保留基础: fill.separatorRow / prefixVisible / suffixVisible / splitPhysical / splitAndWrapSegments / mergeStyleLike / emptyRow
// 改写: table.gridRow / rowBox / ruleRow / cellLeaf / vLineLeaf / hRuleLeaf (行高改 wrapLeaf)
// valign 仅 heightFixed 补白; 装饰宽度读节点 width/tail/fillBg

// ================= §7 组装 compose.ts =================
compose(panes: Record<PaneId, Row[]>, viewport: Viewport, chrome: Chrome): FrameRow[]
// 保留: layout.buildTopRegion (只改输入类型)
// 保留: rows 的 LineTable / 段定位 / renderPane(对外 API) / rowCache
// FrameRow 复用 renderer/screen.ts 既有定义

// ================= 对外接线 =================
renderPane(items: PaneItem[], pane: "dialogue"|"activity", options): FrameRow[]   // pane 映射 session/turn
```

### 五阶段任务与对应测试（规划）

各阶段：先实现「函数接口契约」里的对应项，再配测试守住；测试失败即验收门。

### 阶段 0：基建（类型 + 唯一折行）

- 实现接口：
  - `ir.ts`：`Section` / `Block`（5 种）/ `PaneItem` / `Node` / `Leaf` / `Row` / `FrameRow` / `NodeBase` / `PaneId`；`StepHeader` / `TurnHeader` / `Gap` / `ToolBatch` / `StepSummary` 为占位类型（字段沿用旧实现）。
  - `wrap.ts`：`wrapLeaf(text, width, opts)` 唯一折行（prefixW / hanging / balance；行数组长度即高度）；`balancedWidth` 并入 balance。
- 对应测试：
  - 新增 `pipeline-wrap.test.ts`：`wrapLeaf` 折行与渲染同源（宽字符 / prefixW / hanging / balance / 单元格宽）；返回行数组长度 = 高度。
  - 不变量：grep 守门「文本叶逐字符折行只此一处（`wrapLeaf`）；代码行折叠除外」。

### 阶段 1：前四段（宽无关：分节 / 解析 / 分流 / 结构）

- 实现接口：
  - `split.ts`：`splitSections(state) → Section[]`（旧节 items 按模型推理边界分组 → 一次模型交互 Section；`sections.ts` 沿用作事件累积）；`replay.ts` 改产新 `Section[]`。
  - `parse.ts`：`parse(section) → Block[]`；块分类（fence / table / quote / list）+ 行内→`StyledText` + `span` 回引；移入 `markdown.parseInlineMarkdown` 与 `table.parseTableAt` 等。
  - `route.ts` + `routeTable.ts`：`route(groups, view, …) → { session, turn }`（对话一路，追加）；chrome 五 pane 由独立刷新路产出，两路在 structure 拼接；类型间隔产显式 `Gap`；压缩开关按类别（think / tool / reply）在 route 应用（决策 4a）。
  - `structure.ts`：`buildTree(panes: Record<PaneId, PaneItem[]>) → LayoutTree` + `toNode` / `toToolNode` / `toStepHeader` / `toTurnHeader` / `toGap`。
- 对应测试：
  - 新增 `pipeline-ir.test.ts`：`parse` 快照（块类型 + 行内段 + span 区间 + source）；`route` 表驱动（pane 归属 / 间隔 Gap / 追加语义）；chrome 刷新路独立快照；`structure` 结构快照（Node/Leaf 树形，含两路拼接）。
  - 不变量：`parse` 每块只解析一次（调用计数断言）；块类型闭集（satisfies）。

### 阶段 2：后三段（宽相关：测量 / 摊平 / 组装）

- 实现接口：
  - `measure.ts`：`measure(root, screen, view)` 根拿屏幕尺寸、沿用分配算法（递归 + 循环）填各节点宽高（view 保留，高度分配用）；`measureLeaf` 折行改 `wrapLeaf`（StyledText 展示长）；表格 `fitCols` 列宽 + 行高 = 单元格 `wrapLeaf` 最大（单元格按正文排版）。
  - `flatten.ts`：`flatten(tree) → Record<PaneId, Row[]>`（逐 Leaf 展开、表格网格、空 Leaf 产空行、valign 仅 `heightFixed` 补白、compact 按宽度压缩（决策 4a））。
  - `compose.ts`：`compose(panes, viewport, chrome) → FrameRow[]`（视口 / 折叠占位 / 屏上排布 / chrome 合成）。
- 对应测试：
  - 新增 `pipeline-ir.test.ts` 续：测量 = 摊平不变量（`flatten` 总行数 === 各节点 height 之和）；`Row` 空行只能来自显式 `Gap`（统计断言）。
  - 归并 `fill.test.ts` / `table.test.ts` 相关：valign 仅 `heightFixed` 补白；表格网格行；compact 按宽度压缩（决策 4a）。
  - `compose` 帧断言（视口 / 状态栏 / 输入行）。

### 阶段 3：旧链路拆除 + 接线

- 删除 / 接线：
  - 删除旧契约：`boxToLines`、`tableLines`、`buildBox`、`buildContentRows`、`wrapAssistantLine` 块级分类、`void contWidth`、`decorateRows` 隐式补白、`hasHeightDecl`、旧 `box.ts` 布局树类型。`HistoryRow` 不删（`state.ts` 的 `Buffer` 基础与恢复行输入，流水线不再消费它）。
  - 接线：`renderPane(items, pane: "dialogue"|"activity", options)` 内部走新链路（新 `PaneItem[]` → 新 7 段）。
- 对应测试：
  - 全仓类型检查通过（无残留引用旧契约）；旧 `pipeline-*` 测试改新类型后重跑。

### 阶段 4：测试迁移与验收

- 任务：
  - 新增 / 重写测试：`pipeline-ir.test.ts` 全；重写 `pipeline-boxes` / `pipeline-panes` / `pipeline-rows` / `pipeline-frame` / `pipeline-equivalence` / `content-mapping` / `fill`。
  - 基线：逐条人工确认 `focus-frame-legacy` / `content-mapping-legacy` diff 后重冻（决策 2b）。
  - 验收回归：TUI #1 的 F3 / F4（断线）、H2（多空行）用例全绿。
- 对应验证：
  - `npm run check` + `npm run test:tui` + `npm run demo -- --smoke` + 人工真机（决策 1a 一次性切换 + 决策 6a 一次提交后整链验证）。

## 实现记录（具体任务列表）

> 粒度：到每个类型定义与重要函数接口；每个任务 = 一个类型/函数（附字段/签名与契约）+ 对应测试断言。实现顺序沿五阶段。

### 阶段 0：基建

**ir.ts（`TUI/src/app/layout/pipeline/ir.ts`）**

- [ ] T1 `interface Section { id; turn; step; time?; seqs: number[]; reasoning?: string; body?: { source: "system"|"user"|"assistant"; text: string }; calls?: ToolCall[]; status?: "running"|"success"|"failure"|"aborted" }`（一次模型交互容器，纯文本槽位未解析；层级 `session>turn>step>section`）
- [ ] T2 `interface StyledStr { text: string; color?: ColorName; bold?: boolean; italic?: boolean; code?: boolean; link?: string }`；`type StyledText = StyledStr[]`（行内解析产物，控制符已消费）
- [ ] T3 `interface BlockBase { source: "reasoning"|"system"|"user"|"assistant" }`；`interface Paragraph extends BlockBase { kind:"paragraph"; id; span:[number,number]; text: StyledText }`
- [ ] T4 `interface Quote extends BlockBase { kind:"quote"; id; span; children: Block[] }`
- [ ] T5 `interface List extends BlockBase { kind:"list"; id; span; ordered: boolean; marker: string; items: Block[] }`（不记 `depth`，嵌套靠 `items` 递归）
- [ ] T6 `interface Code extends BlockBase { kind:"code"; id; span; lang?: string; rows: string[]; closed: boolean }`
- [ ] T7 `interface Table extends BlockBase { kind:"table"; id; span; header: Paragraph[]; aligns: TableAlign[]; rows: Paragraph[][] }`；`type Block = Paragraph|Quote|List|Code|Table`（闭集 5 种，不增工具块）
- [ ] T8 `interface EventGroup { provenance: Section; blocks: Block[]; calls?: readonly ToolCall[] }`；`type PaneItem = Block | StepHeader | TurnHeader | Gap | ToolBatch | StepSummary`（各占位变体自带 `key`；占位类型字段沿用旧 `panes.ts` / `boxes.ts`）
- [ ] T9 `type PaneId = "session"|"turn"|"tool"|"statusBar"|"statusCol"|"titleBar"|"input"`
- [ ] T10 `interface NodeBase { width?:number; height?:number; heightFixed?:boolean; widthStyle?; heightStyle?; widthFixed?; heightFixed?; widthLocked?; heightLocked?; align?: "left"|"center"|"right"; valign?: "top"|"center"|"bottom"; style?: FrameStyle; indent?:number; hanging?:number; prefix?:{text;style?;minWidth?}; suffix?:{text;style?;minWidth?}; tail?:{char;style?}; fillBg?:boolean; wrap?:boolean; balance?:boolean }`
- [ ] T11 `interface Node extends NodeBase { direction:"v"|"h"; children:(Node|Leaf)[]; separator?; id?:PaneId }`；`interface Leaf extends NodeBase { text: StyledText }`；`type LayoutTree = Node | Leaf`（Node/Leaf 可变，measure 填宽高）
- [ ] T12 `interface Row { segments: FrameSegment[]; indent?: number; prefix?: FrameSegment[]; align?: "left"|"center"|"right" }`（§6 摊平行，pane 归属由 `Record<PaneId, Row[]>` 承载）；`FrameRow` 复用 `renderer/screen.ts` 既有定义
- [ ] T13 类型断言测试：`Block` 闭集 `satisfies`、`NodeBase` 字段禁重复、`LayoutTree` 递归类型可编译；只冻结 `Block`（`Object.freeze`）。

**wrap.ts（唯一折行）**

- [ ] T14 `wrapLeaf(text: StyledText, width: number, opts: { prefixW: number; hanging: number; balance?: boolean }): FrameSegment[][]`——行数组，`length = 高度`；宽字符（EAW）按列计、prefixW 占首行、hanging 让续行缩进、balance 平衡（并入 `fill.balancedWidth`）。
- [ ] T15 `pipeline-wrap.test.ts`：`wrapLeaf` 与渲染同源（宽字符 / prefixW / hanging / balance / 单元格宽）；返回行数 = 高度；grep 守门「文本叶逐字符折行只此一处，代码行折叠 `wrapCodeLine` / `expandCodeTabs` 除外」。

### 阶段 1：前四段（宽无关）

**split.ts + replay.ts**

- [ ] T16 `splitSections(state: SectionsState): Section[]`——旧节 items 按模型推理边界分组：同一次推理的思考 / 正文 / 工具声明并进同一条一次模型交互 `Section`（断点 = 块 index 连续段；`turn`/`step`/`time` 从旧节继承）。
- [ ] T17 `replaySections(rows: readonly HistoryRow[]): Section[]`——恢复：历史行按模型交互边界分组产一次模型交互 `Section`；工具行聚合工具批，separator / step 行 → `TurnHeader` / `StepHeader`。

**parse.ts**

- [ ] T18 `parse(section: Section): Block[]`——主入口：`reasoning` 与 `body.text` 都走块分类 + 行内解析，全部摊成一条 `Block[]`（各块带 `source`）。
- [ ] T19 块分类：fence → `Code`（`closed`、`lang`、`rows`）；table（`isTableStart`/`parseTableAt`）→ `Table`；quote → `Quote`；list → `List`；heading/rule/plain → `Paragraph`。
- [ ] T20 行内：`markdown.parseInlineMarkdown(text)` → `StyledText`（消费 `**`/`` ` ``/`\*`）；每块只解析一次（reasoning 与 body 各自一次）。
- [ ] T21 `span` 计算：每块 `[start,end]` 指向所属槽位原文（`Section.reasoning` 或 `Section.body.text`）区间（供检索/复制/断言）。
- [ ] T22 `pipeline-ir`·parse 快照：给定 Section（含 reasoning+body）输出块类型 + 行内段 + span 区间 + source；一次解析调用计数。

**route.ts + routeTable.ts**

- [ ] T23 `route(groups: EventGroup[], view: ViewState, …): { session: PaneItem[]; turn: PaneItem[] }`——对话一路（追加）；按 `block.source` 分发（reasoning→turn、正文→session、工具批→turn）；压缩开关按类别（think / tool / reply）应用（决策 4a）；chrome 五 pane 由独立刷新路产出（不在此函数）。
- [ ] T24 `routeTable.ts`：规则表（来源×块类型→pane、间隔 Gap、step/回合头转 StepHeader/TurnHeader、压缩类别 think/tool/reply（决策 4a））以数据表承载。
- [ ] T25 类型间隔：思考↔正文 1 行、工具不插行 → 显式 `Gap`（空行唯一来源）；step 头 / 回合分隔 → `StepHeader` / `TurnHeader`。
- [ ] T26 `pipeline-ir`·route 表驱动：pane 归属、间隔 Gap、追加语义、折叠占位、压缩类别（决策 4a）；chrome 刷新路独立快照。

**structure.ts**

- [ ] T27 `buildTree(panes: Record<PaneId, PaneItem[]>): LayoutTree`——route 两路（对话 + chrome）拼接成一棵完整树。
- [ ] T28 映射函数：`toNode(block: Block): Node|Leaf`、`toToolNode(toolBatch)`、`toStepHeader(stepHeader): Leaf`、`toTurnHeader(turnHeader): Leaf`、`toGap(gap): Leaf`（空 Leaf）。
- [ ] T29 `pipeline-ir`·structure 快照：给定 PaneItem[] 输出 Node/Leaf 树形（含 id/direction/prefix）。

### 阶段 2：后三段（宽相关）

**measure.ts**

- [ ] T30 `measure(root: LayoutTree, screen: {w;h}, view: ViewState): void`——根拿屏幕尺寸；view 保留（高度分配用）。
- [ ] T31 沿用分配算法（`seedWidth`/`allocateWidths`/`allocateHeights`/`allocateNode`/`measurePass`/`clampWidth` + `naturalWidthOf`/`measureWidthAt`/`fixedWidthSum`/`writeAutoWidth` 等）递归 + 循环填各节点宽高。
- [ ] T32 `measureLeaf` 折行改 `wrapLeaf`（`text` 按 `StyledText` 展示长）；删 `void contWidth` / `wrapParagraph` / `paragraphRows*`。
- [ ] T33 表格：`fitCols` 列宽一次算死；行高 = 单元格 `wrapLeaf` 行数最大（单元格按正文排版；删 `measureLeafRows` 二次解析）。
- [ ] T34 `pipeline-ir` · 测量不变量：`flatten` 总行数 === 各节点 `height` 之和。

**flatten.ts**

- [ ] T35 `flatten(tree: LayoutTree): Record<PaneId, Row[]>`——逐 Leaf 取 `wrapLeaf` 行拼 prefix/hanging/align；compact 按宽度压缩（决策 4a：分流期只挂属性，摊平期按宽度处理）。
- [ ] T36 表格网格：`cellLeaf`/`vLineLeaf`/`hRuleLeaf`/`gridRow`/`rowBox`/`ruleRow`/`tableBox` 改写，行高读 `wrapLeaf`。
- [ ] T37 空行：显式 `Gap`（空 Leaf）产空 `Row`；`valign` 仅 `heightFixed` 补白；装饰宽度读节点 `width`/`tail`/`fillBg`；删 `decorateRows`/`hasHeightDecl`/`fillParagraph`/`fillStyled` 隐式补白与块级分类。
- [ ] T38 `pipeline-ir` · 空行来源断言：`Row` 空行只能来自显式 `Gap`。

**compose.ts**

- [ ] T39 `compose(panes: Record<PaneId, Row[]>, viewport: Viewport, chrome: Chrome): FrameRow[]`——视口定位/折叠占位/屏上排布/chrome 合成（复用 `buildTopRegion` 只改输入类型）。
- [ ] T40 `pipeline-ir` · compose 帧断言：视口 / 状态栏 / 输入行。

### 阶段 3：旧链路拆除 + 接线

- [ ] T41 删除：`boxToLines`、`tableLines`、`buildBox`、`buildContentRows`、`wrapAssistantLine` 块级分类、`void contWidth`、`decorateRows`、`hasHeightDecl`、`rows.itemLines`/`kindOf`、旧 `box.ts` 布局树类型（`Rect` 移入 `ir.ts`）。`HistoryRow` 不删（流水线不再消费，保留为 `state.ts` `Buffer` 基础）。
- [ ] T42 接线：`renderPane(items: PaneItem[], pane: "dialogue"|"activity", options)` 内部走新链路（§1→§7）。
- [ ] T43 全仓类型检查通过（无旧契约残留引用）；目录清理（旧文件删空）。

### 阶段 4：测试迁移与验收

- [ ] T44 新增 `pipeline-ir.test.ts` 全（T22/T26/T29/T34/T37/T40 汇总）。
- [ ] T45 重写 `pipeline-boxes`/`pipeline-panes`/`pipeline-rows`/`pipeline-frame`/`pipeline-equivalence`/`content-mapping`/`fill`。
- [ ] T46 基线：逐条人工确认 `focus-frame-legacy`/`content-mapping-legacy` diff 后重冻（决策 2b）。
- [ ] T47 验收：TUI #1 的 F3/F4（断线）、H2（多空行）用例全绿。
- [ ] T48 整链：`npm run check` + `npm run test:tui` + `npm run demo -- --smoke` + 人工真机（决策 1a 一次性切换 + 决策 6a 一次提交后整链验证）。

## 实现记录（进行中）

> 2026-10-25 起实现。节奏调整：主代理直接实现（不再开子代理，用户裁定）。状态：阶段 0/1/2（新模块 + 隔离测试）完成，阶段 3（接线 + 删旧链路）与阶段 4（测试迁移）未开始。

### 阶段 0：基建（完成）

- [x] T1-T13 `pipeline/ir.ts`（新建）：Section / StyledStr / StyledText / Block 五态闭集 / EventGroup / PaneItem 占位 / PaneId / NodeBase / Node / Leaf / LayoutTree / Row / Rect / FrameRow 重导出 + `freezeBlock` + `BLOCK_KINDS`/`BlockKind` + `isNode`/`isLeaf`。evidence：`npm run check` 通过。
- [x] T14 wrap.ts（新建）：`wrapLeaf(text: StyledText, width, { prefixW, hanging, balance? }): FrameSegment[][]` 唯一折行入口 + `styledToSegments`（StyledStr→FrameSegment 映射）。折行口径对齐旧 `splitAndWrapSegments`+`wrapFrameSegments`：首行可用宽 = width−prefixW、续行 = width−hanging、`\n` 物理行切分、balance 复刻 `fill.balancedWidth`（内部折行核共用）。evidence：`npm run check` + 测试通过。
- [x] T15 `tests/pipeline-wrap.test.ts`（新建，17 例全绿）：宽度/宽字符/prefixW/hanging/balance/物理行/空行/超宽单字符/样式映射/合并/行数=高度。
- 额外的设计裁决（记入「偏差」）：ir.ts Section 在 T1 基础上扩展了 `final?`/`history?`/`standalone?`/`steer?`/`stepSummary?`（旧节归属字段透传，route 终态分流与 step 头/留白规则需要），`body.source` 扩为 `BlockSource`（含 notice/shell/tool 辅助行）并加 `tone?`/`hanging?`/`noCompact?`，新增 `results?: ToolResult[]` 槽（route 组 ToolBatch 显示），EventGroup 同步加 `results?`，Node 增加 `code?`/`table?` 载荷字段（表达代码/表格特殊内容，measure/flatten 分别消费）。`BLOCK_SOURCE` 含旧来源全集。

### 阶段 1：前四段（宽无关）——完成

主代理直接实现（用户裁定不开子代理）：

- [x] T16 `pipeline/split.ts`（新建）`splitSections(SectionsState): Section[]`——旧节 items 按来源分组切一次模型交互（断点 = 文本来源更换；思考 / 工具批归属所在交互），stepSummary / 独立自足节各自成节；节上 final/history/standalone/steer/time/status 透传。
- [x] T17 `replaySections(rows: HistoryRow[]): Section[]`——经 `sectionsFromBuffer`(history) + `splitSections` 复用边界判定（报告分隔线 / step 头由元数据经 route 产 TurnHeader / StepHeader）。
- [x] T18-T21 `parse.ts`（既有文件，本轮修正编译 + span 按行计 + 语义色）：`parse(section) → Block[]`；块级分类（fence/table/quote/list/heading/rule/plain）+ 行内 → `StyledText` + 每块 `span` 指向所属槽位原文区间。修正：① `styledOf` 适配 FrameStyle 无 `code` 字段（inline code = `bg:"code"` 语义色）、`fg` 可为 hex（显式收窄到 ColorName）；② 分支 5 的 span 从「整段 run」改为「逐行」（`endOf` 剔除换行）。
- [x] T23-T24 `pipeline/routeTable.ts`（新建，规则数据表）+ `pipeline/route.ts`（新建）`route(groups, view, …): { session, turn }`——规则全部落 `routeTable.ts`：`ruleFor(source, final)`（pane / category / constant / gapKind）、`TURN_BLANK` 间隔矩阵 + `turnBlankBetween`、`categoryVisible`（档位过滤）；route 只做对话一路（追加），step 头 / 回合分隔 / 间隔 Gap / steer 留白 / 工具批组合在此定位。
- [x] T25 类型间隔：思考↔正文 1 行 Gap、工具重置不插、会话区 user→正文 1 行；step 头内容驱动（只对已声明 step）+ suppressFirstHead；回合分隔按 turnTimes（turn-start 交付）与 firstTurn 守卫。
- [x] T27-T29 `pipeline/structure.ts`（新建）`buildTrees/buildTree` + 块映射：Paragraph（正文/思考左缘竖线前缀、用户块 balance、分隔线 tail 铺满）、Quote（v + `> ` 前缀 + 悬挂）、List（v + 标记 + 悬挂）、Code/Table/ToolBatch 载荷节点、StepHeader/TurnHeader/StepSummary（tail ╌）、Gap（空 Leaf）。
- [x] `tests/pipeline-ir.test.ts`（新建，12 例全绿）：split（一次性推理并入同条 / 独立用户自成节）、parse（块类型快照 + 标题样式 + span 回引 + 来源标记 + 数字列右对齐）、route（pane 归属 / 间隔 Gap / 档位过滤 / 遮蔽打灰）、structure（竖线前缀 / 载荷 / 空 Leaf）。
- [x] evidence：`npm run check` 通过；`tests/pipeline-ir.test.ts` 12 例全绿；TUI 全量 `npm test` 1789 例全绿（旧链路未受影响）。

### 阶段 2：后三段（宽相关）——完成（新模块 + 隔离测试，未接线）

主代理直接实现：

- [x] T31-T32 `pipeline/measure.ts`（新建）`measure(root, width, {vw?})`——后序填各节点 width/height：文本叶 height = `wrapLeaf(…).length`（不变量）；代码 / 表格 / 工具载荷各自行数模型（折行也走 wrapLeaf / fitCols / 代码软折行），v 高求和、h 高取 max（fixed 子项先定宽）。
- [x] T33 表格：measure 用 `fitCols` 定列宽（已从 `table.ts` 导出 `fitCols`，原私有）、行高 = 单元格 wrapLeaf 行数最大；`tableHeight` 含横线行。
- [x] T35-T37 `pipeline/flatten.ts`（新建）`flatten(root, width, {vw?})`——逐 Leaf 取 wrapLeaf 行按 prefix/suffix/indent/hanging/align 展开；代码行号列 + 软折行 + 灰底补齐、表格网格（左缘竖线 + 列分隔 + 横线交叉字 + 过窄回退普通行）、工具名字/参数/结果行；空 Leaf（Gap）→ 空行（空行唯一来源）；step/回合头 tail 铺满。
- [x] T39 `pipeline/compose.ts`（新建）`renderPane(groups, opts)` 一条龙（route→structure→measure→flatten）+ `rowsToFrame`（Row → FrameRow）。chrome/视口/状态栏拼装仍由 layout 现状承担。
- [x] `tests/pipeline-layout.test.ts`（新建, 8 例全绿）：叶子 height = wrapLeaf 行数、摊平总行数 = Σ高度（不变量 3）、prefix 竖线 / 思考紫、空行仅来自 Gap（统计断言）、tail 铺满、hanging 悬挂、renderPane 一条龙。
- [x] evidence：`npm run check` 通过；`tests/pipeline-layout.test.ts` 8 例全绿；TUI 全量 `npm test` 1797 例全绿（旧链路未受影响, 新模块未接线）。

## 偏差

（待实现阶段填写。已裁决项：① `Section`/`BlockSource`/`EventGroup` 的类型扩展（见上，spec 明细 vs 实现的必要细化）；② pane 终态分流保留现状（user→session、final/history 交互的正文+工具批→session、其余→turn），追踪文档 §3 一行「正文→session」是简写，以本实现为准；③ chrome 五 pane（tool/statusBar/statusCol/titleBar/input）不进 Node 树，由 layout 现状直接构图，structure 只处理 session/turn 两 pane，compose 合并——对「buildTopRegion 基本不动」的务实解读。）

阶段 1 新增（实现即口径，回写下文）：④ 解析把多行正文按行产独立 `Paragraph` 块（旧 `textParts` 按整段 run 产一个 box）——段内空行在新模型为独立空 Paragraph，route/structure **保留**空 Paragraph（flatten 出空行），与旧「块内空行竖线连排」的行数一致；仅「整段纯空」时旧路径整体丢弃、新模型会出空行（边缘差异，记入阶段 2 flatten 的尾空裁剪）。⑤ `shadowedSeqs` 遮蔽不落 Block 字段（Block 冻结），由 `route.shadowedBlockIds(groups, shadowedSeqs)` 算块 id 集、structure 按块 id 打灰。⑥ 列表 / 引用 / 标题样式入 Structure 而非 parse 现造：`ruleFor`/`markerFor` 用块字段派生展示标记。⑦ 表格数字列右对齐沿用 table.ts 口径（parse 直接复用 `parseTableAt`）。⑧ 回合头/step 头文案（`stepHeaderLine`/`turnHeaderLine`）在 structure 生成（与旧 build-box tail 铺满同形制）。

## 测试与证据

- 阶段 1：`tests/pipeline-ir.test.ts` 12 例全绿；TUI 全量 `npm test` 1789 例全绿。
- 阶段 0：`tests/pipeline-wrap.test.ts` 17 例全绿。
- 阶段 2：`tests/pipeline-layout.test.ts` 8 例全绿；TUI 全量 `npm test` 1797 例全绿（新模块未接线, 旧链路不变）。

## 收尾

（待关闭时填写。）
