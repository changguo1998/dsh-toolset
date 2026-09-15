# TUI 排版 Box 模型（设计草案）

> 状态：**设计草案，待实施**（2026-09）。配套：`DESIGN.md`「术语：渲染 vs 排版」、`CONTRACT.md`（排版→渲染对外契约）。本文件是**排版层内部中间表示**的设计：Box 树不跨层，对外输出仍是 `FrameRow[]`，renderer 契约不受影响。

## 1. 定位：Box 是排版的基本元素

Box 统一承担两件事——**屏幕分区**与**内容元素**：

- **分区**：屏幕 = 顶区（历史 ‖ 活动 ‖ 状态列）/ 状态区 / 输入区 / 提示区的 Box 嵌套。
- **内容**：每一条用户输入、每一条 LLM 回复、一个段落、一个 markdown 表格、一条工具调用记录，**各自也是一棵 Box 子树**。

两者是同一个模型、同一套布局算法，只是层级不同：pane 树的叶子挂内容树，内容树的叶子是**缩进段落**。

**核心不变量（叶子语义）**：**一个叶子的文字属于同一个缩进段落**——叶子内部的所有文字（含软换行后的续行）共享同一缩进基准；缩进不同就是不同叶子。

**它不是组件树**：Box 是纯数据结构（可穷举的代数类型），无生命周期、无样式继承、无测量回环、无回调。与 DESIGN「砍组件树/布局引擎」不冲突——砍的是带行为与继承的引擎，Box 只是"布局代数"。

## 2. Box 模型

```ts
type Box =
  | Paragraph                                  // 叶子：缩进段落（内容最小单位）
  | { kind: "v"; children: Box[] }             // 上下排：高 = 子高和；宽 = max 子宽
  | { kind: "h"; children: Box[] };            // 左右排：宽 = 子宽和；高 = max 子高

/** 叶子：一个缩进段落。段落内所有文字共享缩进基准。 */
interface Paragraph {
  kind: "text";
  text: string;                 // 纯文本；行内 markdown 在摊平阶段解析
  indent?: number;              // 首行左缩进列数（整段基准）
  hanging?: number;             // 续行缩进列数；缺省 = indent（工具行的悬挂缩进）
  prefix?: {                    // 段前缀（占列，正文缩进自前缀后起算）
    text: string;               //   如思考 ┃ / 引用 │ / 列表 • / 任务 [x]
    style?: FrameStyle;
  };
  style?: FrameStyle;           // 段落默认样式（行内解析可覆盖）
  align?: "left" | "right" | "center"; // 行级对齐（缺省 left）；仅 width 为 fixed/fill 时有效
  fillBg?: boolean;             // 底色铺满分配宽度（代码块用；行内代码只在文字上着色）
  wrap?: boolean;               // 默认 true；false = 单行截断不换行
  width?: Width;                // 覆盖宽度意图（缺省由父容器分配）
}
```

**宽度/高度意图**（对齐现状：状态列 1/3、历史区保底 10 列、交互区固定行数）：

```ts
type Width =
  | { mode: "auto"; min?: number; max?: number }   // 按内容宽度（用户块的"收缩块"用）
  | { mode: "fill"; min?: number; max?: number }   // 占满剩余
  | { mode: "fixed"; cols: number }
  | { mode: "ratio"; value: number; min?: number; max?: number }; // 按剩余比例（状态列 1/3）
type Height =
  | { mode: "fixed"; rows: number }     // 交互区/输入区固定行数
  | { mode: "fill" };
```

`min/max` 是**夹取界**（分配优先级与冲突解决见 §6「分配优先级」），三个真实用法（均由现状代码印证）：

| 用例 | 现状 | 模型表达 |
|---|---|---|
| 用户消息块 | `userMaxBodyWidth = width − gutter`（layout.ts:1203） | `{ mode:"auto", max: 可用宽 − gutter }` |
| 历史区保底 | 与下一条共同决定状态列上限 | `{ mode:"fill", min: 10 }` |
| 状态列宽 | `Math.min(⌊cols/3⌋, cols−10)` | `{ mode:"ratio", value:1/3 }`——**上限由历史区的 `min` 自动产生**，无需再写 `max`（见 §6「一侧声明即够」） |

## 3. 内容元素映射（Box 组合示例）

| 内容元素 | Box 表达 | 对应现状 |
|---|---|---|
| 一条用户输入 | `h([ spacer(fill), Paragraph(width:auto) ])`（**块级对齐，不用 `align`**） | 整体靠右的收缩块（先换行取最大行宽作块宽、块内左对齐、右缘贴边） |
| 一条 LLM 回复段落 | `h([ text(indent), spacer(gutter) ])` | 回复靠左 + 右缘 `messageGutter` 留空 |
| 思考 | `text(prefix:{┃,紫}, indent:1)` | 左侧紫色竖线区分 |
| 一条工具调用记录 | `v([调用行, 结果行])`，续行 `hanging:4` | 工具行缩进 + 续行 `TOOL_CONT_INDENT=4` |
| 引用块 | `text(prefix:{│})` | 单层竖线前缀、正文不加斜 |
| 列表 / 任务列表 | `text(prefix:{"• "}/{"[x] "}, hanging:2)` | 统一 `•`、`[x]` 删除线 |
| 代码块 | `v([ Paragraph(lang, style:{italic}), Paragraph(code, style:{bg:"code"}, width:fill, fillBg:true) ])` | 标签单独一行（斜体、无底色）；代码体超长行折行、底色补齐到内容区宽 |
| markdown 表格 | 构建期降级为 `v([ h([cell,cell…]), … ])`（见 §3.2） | 现状未实现，模型预留 |
| 每回合分隔线 | `text("╌"×w)` | `TURN_SEPARATOR` |

**结论**：现状 `wrapBufferLines` 里那一大坨"按类型分别处理缩进/前缀/对齐"的逻辑，被"内容元素 → Box 子树"的映射统一替代；新增内容类型 = 新增一个映射函数，不改布局。

### 3.1 消息分块排版

一条 markdown 消息**不是单个叶子**，而是 `v(块…)`——文字与表格等块各自**独立排版**（各自子树、各自缩进与样式）：

```ts
// 模型一次回复："说明文字" + 一个表格
v([
  Paragraph("说明文字……"),                    // 文字块
  v([ h([cell, cell]), h([cell, cell]) ]),    // 表格块（见 §3.2）
])
```

markdown 解析因此分两级：**先切块、再块内做行内解析**。

| 块类型 | Box 表达 |
|---|---|
| 段落 | `Paragraph` |
| 标题 | `Paragraph(style:{bold, fg:"cyan"})` |
| 列表项 | `Paragraph(prefix:{"• "}, hanging:2)` |
| 引用 | `Paragraph(prefix:{"│"})` |
| 代码块 | `Paragraph(style:{bg:"code"}, width:fill)` |
| 表格 | 见 §3.2 |
| 分隔线 | `Paragraph("─"×w)` |

现状的块判定是**隐式**的（混在 `wrapBufferLines` 的 `inFence` 状态机等处）；Box 模型将其显式化为"块列表 → 子树"。

### 3.2 表格：构建期降级（不加第 4 构造子）

**关键约束**：表格列宽是**跨行约束**——同列第 3 行单元格的宽度取决于第 1 行的单元格（位于另一棵子树）。纯 `v/h` 只能表达嵌套，表达不了跨兄弟约束（HTML 为此专门有 `<table>`，CSS 有 grid）。

**方案：在内容映射层降级**——把 2D 数学放在表格构建器里，布局引擎保持 3 构造子：

```
表格构建器（已知可用宽 width）：
  1. 量各格自然宽 → colW[j] = max(该列各格)
  2. ΣcolW + 分隔 > width → 按比例压缩（下限 minW），格内换行
  3. 产出 v([ h([ Paragraph(cell, width:fixed colW[0]), sep, Paragraph(cell, width:fixed colW[1]) ]), … ])
```

- **列对齐**：宽度构建期算好写成 `fixed`，各行自然对齐
- **每格独立成块**：cell 是独立 box（可含多段文字、可再嵌套）
- **行高自动补齐**：`h` 的 measure 取子高 max，fill 时矮格补白到行高
- **构建器需要可用宽度**：`ctx` 中已有（历史区宽度由 metrics 确定）
- 待定：窄终端的**压缩策略**（按比例缩 / 最小宽 / 截断 / 降级为列表）
- 何时才需要真正的 `table` 构造子：出现 colspan / rowspan / 冻结表头这类**不可降级**能力时

## 4. 层级：pane 树挂内容树

```
screen = v([
  h([
    v([ titleBar, h([ history, activity ]) ]),   // 左列
    statusColumn,                                // 右侧状态列（width: ratio 1/3）
  ]),
  statusBar, input, hint,
])

history 的内容 = v( 消息 Box … )      // 由 state.buffer 派生
activity 的内容 = v( 瞬态行 Box … )    // 思考/工具/notice；面板打开时整体替换
```

- **pane 树**：结构固定（四区域），尺寸由 `metricsFor` 预算 → `Width/Height` 意图
- **内容树**：每帧从 state 派生（纯函数），挂在 pane 的叶子上
- 内容树在 pane 的 **fill 阶段摊平为 `FrameRow[]`**；pane 的滚动/裁剪在**行级**进行（= 现状 `computeViewport` 语义，滚动语义零变化）

## 5. 缩进段落语义（叶子规则）

1. **共享缩进**：段内所有行（含软换行续行）以 `indent`（首行）/ `hanging`（续行）为基准；段内不出现缩进变化，需要变化就拆叶子。

1. **前缀占列**：`prefix` 先占列，正文缩进自前缀之后起算；续行是否重复前缀由 `hanging` 决定（引用/列表重复竖线或对齐正文，现状语义保持）。

1. **宽度**：段落可用宽度 = 容器分配宽 − indent − prefix 宽度；换行按显示宽度（`charWidth/displayWidth`，CJK/emoji 零宽表不变）。

1. **样式**：段落 `style` 为默认，行内 markdown 解析产生的段样式在其上覆盖（`FrameSegment` 级）。

1. **产出**：段落摊平后是若干 `FrameRow`，每行若干 `FrameSegment`——与 `CONTRACT.md` 输出契约无缝衔接。

1. **缩进归属（防止两套机制打架）**：**段落内缩进一律走 `indent`/`hanging`/`prefix`**（行级，逐行生效）；`h` + `spacer` 只表达**块间横向位置**（块级，整块一次）——如用户块右对齐 `h([spacer(fill), text])`、右缘留白 `h([text, spacer(fixed gutter)])`。

   为什么不用 spacer 表达段落缩进：① **悬挂缩进做不到**——`h([space(4), text])` 会让整块（含首行）都缩进 4，而工具行要求首行 0、续行 4（现状 `wrapToolCallText`：首行全宽、续行 `TOOL_CONT_INDENT=4` 且折行宽度扣掉缩进）；② **前缀需逐行重复**（引用 `│`、列表 `•`、思考 `┃`），spacer 只作用于块首；③ **`fixed` spacer 并未消灭那个数字**，只是把 indent 搬进节点，且布局仍须扣除它才能算可用宽。

1. **格式一致性：约束绑定"几何"，不绑定"样式"**——把"格式"拆成两类属性，只对前一类要求叶子内一致：

   | 类别 | 具体项 | 叶子内一致？ | 理由 |
   |---|---|---|---|
   | **几何属性** | `indent`/`hanging`、`prefix`、分配宽度、`wrap` | **必须一致** | 决定"折成几行、每行从第几列起"，段内不同则无法算折行 |
   | **外观属性** | `fg`/`bg`/`bold`/`italic`/`strike` | **允许段内变化** | 只影响某一段如何着色，不参与宽度与断行计算 |

   即：**改几何就拆叶子，改样式就用 `FrameSegment`**（段落 `style` 作默认，行内解析结果在其上覆盖）。

   为什么不能强制"一个 box 一种样式"：那会逼出**跨 box 的行内折行**。例：`这是**粗体**文字，后面还有很多字要折行……` 若拆成 `h([Paragraph("这是"), Paragraph("粗体", bold), Paragraph("文字…")])`，由于 **box 边界不是换行点**，超宽时须由 `h` 容器把子 box 逐行流式摆放（兄弟 box 之间也要能断行）——等于重写一套富文本行内布局（HTML/CSS 最重的机器）。现状之所以简单：折行在**单个叶子内部**按纯文本宽度完成，样式在其后贴上（`parseInlineMarkdown` 产段、`wrapSegments` 每行重开样式），样式不进入宽度计算。

   **例外（该走"每 box 统一格式"的地方）**：**不跨 box 折行的单行组合行**——系统状态栏 `plan off on`（仅生效项高亮）、工具行头（工具名黄 + 参数默认）、Mode 块等，用"各自统一格式的 box + `h` 拼接"表达最自然（单行 + 截断，无需 inline flow）。

1. **对齐归属：块级走 `spacer`，行级走 `align`**——两种粒度分开，不要混用：

   | 粒度 | 含义 | 表达 | 例子 |
   |---|---|---|---|
   | **块级** | 整块在父容器里靠左/右/居中；**块内各行仍左对齐** | `h` + `spacer(fill)` | 用户消息块 `h([spacer(fill), Paragraph(width:auto)])` |
   | **行级** | 叶子内**每一行**（含折行续行）按对齐规则摆放 | `Paragraph.align` | markdown 表格 `:---:` 三态、数字列右对齐 |

   - 为什么行级不能靠 `spacer`：spacer 只在**块首**生效，而折行发生在**叶子内部**——每行怎么摆只能由掌握可用宽度的叶子自己算（与"悬挂缩进"同构）。
   - `align` 仅在有确定分配宽度（`width: fixed/fill`）时有意义；`auto` 宽度正好裹住内容，无从对齐。
   - `align ≠ left` 时 `hanging` 不适用（避免语义纠缠）；右侧留白改用宽度意图表达。
   - 归属：**叶子级几何属性**（叶内一致，符合规则 7）；表格构建器把 `:---:` 映射为单元格 `align`。
   - 现状用户块**不需要** `align`：它要的是"块贴右 + 块内左对齐"（块级）；`align: right` 会得到"每行贴右、左缘参差"，是另一种效果。

## 6. 布局算法（纯递归，~100 行）

```
measure(box, constraint) -> SizeTable            // 自底向上：v 高求和/宽取 max；h 宽求和/高取 max
allocate(SizeTable, rect) -> Map<boxId, Rect>    // 自顶向下：按 Width/Height 意图逐层切分矩形
```

- 根矩形 = 终端尺寸（cols×rows）

- `h` / `v` 分配：按下方「分配优先级」执行（单轮两阶段，无迭代）

### 分配优先级：越精确的指定优先级越高

单一判据：**声明的精确度决定主张强度**——越精确越不让路（任意两个声明都可比较，不需要额外的"硬/软"分类）。

| 精度 | 声明 | 说明 |
|---|---|---|
| 1（最高） | `fixed: n` | 确定数字，无歧义 |
| 2 | `min: n` / `max: n` | 确定边界；同级内 **`min` > `max`**（保底优先于上限） |
| 3 | `ratio: v` | 确定比例（结果随容器确定） |
| 4 | `auto` | 依赖内容，需先测量 |
| 5（最低） | `fill` | 无自身主张，只吃剩余 |

**算法（单轮，两阶段）**

1. **按精度逐层满足**：`fixed` 定值 → `min`/`max` 边界 → `ratio` 目标（基数取**容器总宽**，实际受可分配宽封顶）→ `auto` 内容宽（夹 `max`）→ 剩余给 `fill`。
1. **回流（单轮）**：某盒被 `max` 截断而释放的空间，回流给**更低精度者**（`fill` → `auto` → 受限更小的 `ratio`），最后均分。

**性质**

- **不精确的声明不会挤掉精确的声明**：`auto`/`fill` 必让位于 `fixed`/`min`/`max`/`ratio`——`h([spacer(fill), Paragraph(auto)])` 里 auto 取到内容宽、spacer 吃剩余（用户块由此成立）。

- **一侧声明即够（不会互撞）**：`ratio` 基数取总宽、实际受可分配宽封顶，因此**历史区 `min: 10` 自动产生状态列的上限**，无需两侧各写一条——现状 `min(⌊cols/3⌋, cols−10)` 正是该结果。

- **底线强于一切声明**：宽度 **≥ 1 列**、高度 **≥ 0**；退化终端下即便违背某个 `min` 也保 1 列（同现状：`cols=10` 时状态列 1 / 历史区 9）。

- **过度约束让路顺序**：按精度**从低到高**让（`fill` → `auto` → `ratio` → `max` → `min` → `fixed`），让到满足底线为止。

- **`auto` 宽度测量（一次穿越，不自指）**：`max` 界使它可解——`M = min(容器可用宽, max)`（界来自容器，不依赖块宽）→ 以 `M` 为**折行上界**换行 → 块宽 = 各行显示宽的最大值（≤ M）

  - **`max` 是"折行上界"，不是"最终宽度硬上限"**：遇无法断行的超宽内容（超长英文单词、行首放不下的宽字符）按现状"强制放下、不丢字符"，该行可 > M；此时块宽取**实际最大行宽**（可能略超，由 pane 裁剪），而非夹到 M（夹了就丢内容）
  - **显式换行**参与取最大（`好的` → 2 列窄块，与现状一致）
  - `min` 对 `auto` 是可选"最小块宽"（现状无此需求，留空）

- **滚动裁剪**在 fill 阶段按矩形高度执行（= 现状 `wrapBufferLines` + `activityH` 的活）

## 7. 现状特殊场景逐条落法

| 场景 | 落法 |
|---|---|
| 浮动面板（审批/问答占活动区） | activity 的**内容树整体替换**为面板 Box，非叠加层——无需 Overlay 构造子 |
| 滚动裁剪（历史/活动区 viewport） | fill 拿矩形高后按行裁剪（现状语义） |
| 非等分左右（历史 vs 状态列） | `Width.ratio`（状态列 1/3）+ `fixed`（历史区保底 10 列） |
| 横线/虚线区域分隔（`─`/`╌`） | v 的 1 行 Paragraph 子项，或 leaf 静态 border |
| **焦点四边框 / 标题栏兼作顶边 / 跨区角字** | 见 §8 全局 FocusFrame |

## 8. 焦点框线方案（border 的核心设计）

**现状事实**（`buildStatusSeparator` / `buildTopRegion`）：

- 角字/边线**按焦点在本帧选择性亮相**：`─ │ └ ┘ ┌ ┐ ┴` 依 `sepFocus`（none/activity/status）与 `focusedPanel` 逐段决定，未聚焦回灰
- **共享边**：标题栏下划线行兼作 history 顶边；D 列竖线兼作历史区右缘/状态列左缘——两区 border 落同一条线，**不能双画**

**方案：静态 border（进布局）+ 全局 FocusFrame（行列级覆写）双层**

1. **静态 border**：容器可带 `border?: { top?, bottom?, left?, right?, color? }`，画非焦点灰线（`border` 色名）；不参与尺寸预算（现状框列不计入行数）。
1. **焦点框线**：布局后得到 `Map<boxId, Rect>`，顶层 `FocusFrame(ctx, rects)` 纯函数——已知 `focusedPanel` 与各区域矩形，在指定行列**重写角字与边线**。与现状中心化构图一一对应：

| 焦点 | 现状构图 | FocusFrame 覆写 |
|---|---|---|
| history | 标题栏下划线行兼作顶边（┌─┐）、左缘/分隔竖线 │ | titleBar/history 共享行亮边 + 左角 |
| activity | 活动区分隔两端 ┌┐、活动区左缘/分隔竖线 │ | activity 矩形左缘、底部分隔行亮 |
| status | 状态列 rc0 起 ┌─┐、右缘框列、┴ ┘ | statusColumn 矩形左/上/下/右亮边 |
| 无焦点 | 全灰/空白占位（布局不重排） | 不覆写 |

- **防双画规则**：共享行/列上优先级 = FocusFrame 亮边 > 静态 border（灰）> 空白占位；每条边只写一次。
- 状态区上下横线的 `└/┴/┘` 角字同样由 FocusFrame 按焦点状态产出（对应现状 `buildStatusSeparator`）。

**为什么焦点框不做成"每个 box 自带 border"**：焦点框是**全局状态驱动的跨区构图**，放叶子上会让每个区域重复判断焦点，且无法处理共享边；中心化为 FocusFrame 一层，正好对应现状的集中构图。

## 9. 排版管线

```
state --buildBox--> Box 树 --measure/allocate--> rects --fill(ctx, rect)--> FrameRow[] --renderer--> 终端
        （每帧全量重建，与现状整帧重绘一致）
```

- 每帧从 state 派生 Box 树（纯函数），无增量、无文档状态
- `ctx: FrameContext = { state, size, themeId, metrics, focusedPanel … }`（CONTRACT §2 的只读上下文）
- 对外仍 `buildFrame(state, size): FrameRow[]`，**renderer 契约零改动**

## 10. 与既有文档的关系

- **CONTRACT.md**：Box 树是排版层内部中间表示；`FrameRow`/`FrameSegment`/`FrameContext` 不变；建议 §2.3 引用本文件。
- **REFACTOR.md**：拆文件不拆架构、只拆纯逻辑；Box 是数据不是类，**不违背"不抽象通用 Panel"**；副作用仍留 App。
- **DESIGN.md**：不引入 flex/测量回环/样式继承；"布局代数"≠组件树。

## 11. 开放点

> 未定案的完整清单已汇总至 §14「待决清单」；本节只记与算法直接相关的开放点。

- **~~表格列宽共享~~（已定）**：不加构造子，走 §3.2 的"构建期降级"（列宽算好写 `fixed`）；仅剩窄终端压缩策略待定（§14.4 D1）。
- **内容树的测量代价**：消息多时每帧全量 measure；若成为瓶颈，再评估"内容行缓存"（现状本来也是每帧 wrap 全量，预期无回归）。
- **~~`auto` 宽度与滚动交互~~（已定）**：`auto` 携带 `max` 折行上界 → 上界来自容器、不依赖块宽，**一次 measure 定稿、无需迭代**（算法与边界见 §6）。

## 12. 实施步骤（并入 layout 重构）

1. 定义 `Box`/`Paragraph` 类型 + `measure/allocate`（纯函数，单测覆盖宽度规则/保底/比例/悬挂缩进）
1. `buildBox`：四区域 pane 树（替换 `buildFrame` 隐式顺序）
1. 内容映射：`state.buffer` → 内容 Box 树（替换 `wrapBufferLines` 的分类处理）
1. 各区域改造为 `fill(ctx, rect)`
1. `FocusFrame` 实现与测试（对照现有焦点框线各焦点态的帧断言）
1. 全量回归：`npm run check/test/build` + `demo -- --smoke` + `smoke:pty`
1. 文档同步：CONTRACT §2.3 引用、DESIGN「四区域布局」改为"由 Box 树声明"、REFACTOR 归属登记

## 13. 明确不做

- flex/grid/自动布局引擎/样式继承/响应式重排/嵌套滚动
- 可复用 Panel 基类 / 带行为的组件节点
- Overlay 覆盖层构造子（面板走"内容替换"，必要时再评估）
- renderer 侧任何改动（Box 不出排版层）

## 14. 待决清单（未定案，待讨论）

> 以下条目**尚未定案**；逐条讨论落定后，或从本清单移除、或改为"已定"并入正文。已定要点见 §14.5。

### 14.1 类型缺口（文档内部不自洽，需先补形态）

| # | 问题 | 备注 / 倾向 |
|---|---|---|
| B1 | **pane 节点未定义** | Box 类型只有 `Paragraph`/`v`/`h`，但 §4 屏幕树使用 `titleBar`/`history`/`statusColumn` 等区域名、§8 依赖 `boxId`——类型与用法对不上。倾向补 `{ kind:"pane"; id; width?; height?; border? }`，与内容节点**分角色**（§4 本就是"pane 树挂内容树"） |
| B2 | **`spacer` 未定义** | 示例中使用 6 处。倾向定义为"**空段落 + 宽度意图**"的便捷构造（**不是**新节点）；同时标明示例中 `text(...)` 是 `Paragraph(...)` 简写 |
| B3 | **`FrameStyle` 未定义** | `CONTRACT.md` 的 `FrameSegment.style` 目前是内联对象；需命名导出后供本文件引用 |
| B4 | **`FrameContext` 引用悬空** | §9 引用"CONTRACT §2 的只读上下文"，但 CONTRACT 未定义它。二选一：定案（列出字段）或改引用 |
| B5 | **两份文档互不引用** | `CONTRACT.md` §2.3 增加指向本文件的引用 |

### 14.2 模型级（需拍板）

| # | 问题 | 备选 / 倾向 |
|---|---|---|
| A1 | **折叠/裁剪归属** | 状态列折叠（L0–L3）、面板占位、历史区折叠均依赖可用高。倾向**全放 fill**，使"内容树与尺寸无关"成为不变量（避免鸡生蛋） |
| A2 | **`FocusFrame` 覆写机制** | "行列级覆写角字"已定，未定实现载体：引入"字符网格"中间表示 vs 段级 patch（`FrameRow` 为段数组，按显示列改字符需切段） |
| A3 | **区域清单形态** | pane 树硬编码于 `buildBox` vs 表驱动 `planRegions`（后者更易测、加面板不改主体，代价是多一层数据） |
| A4 | **面板组件迁移形态** | 审批/问答/picker 现产出"恰 `activityH` 行的字符串行"：重写为 `fill(rect)` vs 保留"叶子内容 = 行数组" |
| A5 | **滚动正确性不变量** | 滚动为行级，前提是"同一内容每帧摊平行数一致"；倾向写成不变量"**内容摊平是尺寸的纯函数**" |

### 14.3 工序级（动手前定）

| # | 问题 | 备注 |
|---|---|---|
| C1 | 实施顺序 | 拆文件 / Box 模型 / 契约迁移三者的先后 |
| C2 | markdown 解析器重构范围 | 块解析自 `wrapBufferLines` 抽出后，`markdown.ts`（727 行）是否整体重排 |
| C3 | 测试迁移策略 | 560 个测试的断言由"带 ANSI 文本"改为 `segments` 结构：改动面、是否提供序列化辅助 |
| C4 | 性能验收标准 | 每帧全量 measure 的帧耗时预算与基准方法 |
| C5 | 分批提交策略 | 一次完成 vs 拆成若干可回归提交 |

### 14.4 表格细节（实现表格时再定）

| # | 问题 |
|---|---|
| D1 | 窄终端压缩策略（按比例缩 / 最小宽 / 截断 / 降级为列表）——§3.2 已标待定 |
| D2 | 列分隔符是否绘制（`│`）、表头分隔行样式 |
| D3 | 单元格内是否允许块级内容（多段/嵌套）与纵向对齐（顶对齐/居中） |

### 14.5 已定要点（备查，不再讨论）

- Box = 排版的基本元素；叶子 = 缩进段落（§1、§5）
- 缩进走 `indent`/`hanging`/`prefix`（行级），块间位置走 `spacer`（块级）（§5 规则 6）
- 格式一致性绑定"几何"、不绑定"样式"（§5 规则 7）
- 对齐：块级走 `spacer`、行级走 `align`（§5 规则 8）
- 消息分块排版；表格走构建期降级，不加构造子（§3.1、§3.2）
- 宽度分配：**越精确优先级越高** + 一侧声明即够 + 底线（宽 ≥ 1 列、高 ≥ 0）（§6）
- `auto` 宽度一次穿越可解（`max` 为折行上界）（§6）
