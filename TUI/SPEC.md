# TUI 渲染管线规格（Spec）

> 类型：**[spec]**——覆盖"渲染管线"从排版到渲染的接口与规则：Part I Box 排版模型（Box 类型/算法/面板/折叠/表格/焦点框），Part II RenderLine→FrameRow 渲染契约（数据契约/主题/不变量/序列化）。可照写、可验证；设计见 `DESIGN.md` Part II，实施见 `TASKS.md`。

## 2. Box 模型 [spec]

```ts
// 节点公共属性（Box 与 Paragraph 共享；除 children/direction/text 外）
interface NodeBase {
  width?: Width;                    // 尺寸意图：覆盖父分配（缺省由父容器分配）
  height?: Height;                  // 高度意图：分区固定行高 / Spacer 用；普通段落缺省由内容折行决定
  align?: "left" | "right" | "center";  // 行级对齐（缺省 left）；仅 width 为 fixed/fill 时有效
  valign?: "top" | "center" | "bottom"; // 垂直对齐：fill 补白位置（缺省 top）；矮格补行高时上/中/下摆放（表格 cell 用 center，§3.2）
  style?: FrameStyle;               // 默认样式（行内解析可覆盖）
  indent?: number;                  // 首行左缩进列数（整段基准）
  hanging?: number;                 // 续行缩进列数；缺省 = indent（工具行的悬挂缩进）
  prefix?: {                        // 段前缀（占列，正文缩进自前缀后起算）
    text: string;                   //   如思考 ┃ / 引用 │ / 列表 • / 任务 [x]
    style?: FrameStyle;
  };
  fillBg?: boolean;                 // 底色铺满分配宽度（代码块用；行内代码只在文字上着色）
  wrap?: boolean;                   // 默认 true；false = 单行截断不换行
}

/** 兄弟项之间的分隔线（结构性，随子项增删；首尾不画） */
interface Separator {
  char?: string;                    // 缺省按主题/场景（如 `╌` turn 分隔、状态列块间虚线）
  color?: ColorName;                // 缺省 border（灰）
}

/** 可寻址分区 id（与 state.focusedPanel 收口一处）；仅可寻址区域挂 */
type PaneId = "history" | "activity" | "status";

// 1. Box = 组合节点（屏幕分区与内容容器）：可嵌套子 Box，也可嵌套 Paragraph
interface Box extends NodeBase {
  kind: "box";
  direction: "v" | "h";            // 子项排布：上下（v）/ 左右（h）
  children: (Box | Paragraph)[];    // 子节点（Box 或 Paragraph）
  separator?: Separator;            // v 排布兄弟间分隔线（结构性，随子项增删；首尾不画）
  id?: PaneId;                      // 分区身份（Pane = 带 id 的 Box）：仅可寻址区域挂
  // 无 border：边框归 FocusFrame（`DESIGN.md` Part II §8）
}

// 2. Paragraph = 叶子节点（内容最小单位）：不能嵌套子 Box
interface Paragraph extends NodeBase {
  kind: "text";
  text: string;                     // 纯文本；行内 markdown 在摊平阶段解析
  // 无 children、无 direction、无 separator
}

// Spacer = 内容为空的 Paragraph（便捷构造）：只声明尺寸意图，不产出内容
//   spacer(w) := Paragraph({ text:"", width: w })；h 中读 width、v 中读 height
```

**简写与说明**：示例中 `v([...])` / `h([...])` 是 `Box(direction:"v"/"h")` 的简写，`text(...)` 是 `Paragraph(...)` 简写。`v.separator` 是**唯一**的"边框"机制——只做兄弟项之间横线分隔，**不做盒子四边描边**（现状无此需求）、**不做** `h` 竖分隔（列间 `│` 仍是行端字符）；焦点框线仍归 `FocusFrame` 全局覆写（`DESIGN.md` Part II §8）。

**`Spacer` 用法**：块级对齐/间距的占位项——横向在 `h` 里 `spacer(fill)` 吃剩余推位（用户块右对齐）、`spacer(fixed n)` 留白（回复右缘 `messageGutter`）；纵向在 `v` 里 `spacer(fill)` 吃剩余、让内容不足时落在容器底边、`spacer(fixed n)` 为固定空行。占用轴由所在容器决定（h 读 width / v 读 height）；允许 `fill` 与 `fixed`（±夹取界）两种形态，`auto`/`ratio` 对空内容无意义、不做（YAGNI）。

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

**为什么需要尺寸意图**：`measure` 只回答「内容自然有多大」（内容说了算），`allocate` 才回答「容器分配给你多少」——而**填满剩余（fill）、按比例（ratio）、固定行数（fixed rows）、保底（min）这些布局需求都与内容无关**，必须作为额外声明带给分配器，否则这些数字只能写死在布局函数里。因此：**尺寸意图 = 布局的需求侧声明，归属对象是分区（带 `id` 的 Box / 覆盖型的叶子）而非普通内容节点**。挂载点：`width`/`height` 在 `NodeBase`（Box 与 Paragraph 共享），内容节点**缺省不声明**（高度由折行决定），仅两类场景显式声明——分区（带 `id` 的 Box，如状态列 `ratio 1/3`、历史区 `fill+min:10`）与覆盖型叶子（§3.2 表格每格 `width:fixed`、`Spacer`）。

### 取值域与交互边界

- **宽度**：`fixed.cols`≥1；`min`/`max`≥1（夹取界为“列数下限/上限”，超界按界夹）；`ratio.value`>0。退化终端下即便违背 `min` 也保 1 列底线（§6）。
- **高度**：`fixed.rows`≥0（0 = 不占行）；`fill` 取剩余、可被裁剪到 0。
- **`align`（行级）**：仅当该叶子被分配了确定的 available 宽（`width: fixed/fill`）时生效；`auto` 宽叶子无从对齐（§5 规则 8）。
- **`valign`（垂直）**：仅当该叶子所在 `h` 行的高度 = 子高 max、且本叶子实际内容行数 < 行高时生效——补白分上下两侧：`top` 补在下、`center` 上下平摊、`bottom` 补在上（§6 fill 步骤）。
- **`prefix` 测量**：前缀按显示宽度占列；`prefix.width = charWidth(prefix.text)`；正文可用宽 = 分配宽 − `indent` − `prefix.width`（§5 规则 3）。
- **`wrap: false`**：不换行、单行截断加省略号；截断按显示宽度不切半个 CJK。

## 3. 内容元素映射（Box 组合示例） [spec]

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

### 3.2 表格：构建期降级（不新增 `table` 构造子）

**关键约束**：表格列宽是**跨行约束**——同列第 3 行单元格的宽度取决于第 1 行的单元格（位于另一棵子树）。纯 `v/h` 只能表达嵌套，表达不了跨兄弟约束（HTML 为此专门有 `<table>`，CSS 有 grid）。

**方案：在内容映射层降级**——把 2D 数学放在表格构建器里，布局引擎保持**两类节点（Box/Paragraph）**：

```
表格构建器（已知可用宽 width）：
  1. 量各格自然宽 → colW[j] = max(该列各格)
  2. ΣcolW + 分隔 > width → 按比例压缩（下限 minW），格内换行
  3. 产出 v([ h([ Paragraph(cell, width:fixed colW[0]), sep, Paragraph(cell, width:fixed colW[1]) ]), … ])
     # sep = 前景色实线 `│` 的固定 1 列（行端字符，见 §2“列间 │ 仍是行端字符”）
```

- **列对齐**：宽度构建期算好写成 `fixed`，各行自然对齐
- **每格独立成块**：cell 是独立 box（可含多段文字、可再嵌套）
- **行高自动补齐**：`h` 的 measure 取子高 max，fill 时矮格补白到行高
- **构建器需要可用宽度**：`ctx` 中已有（历史区宽度由 metrics 确定）
- **窄终端压缩**（可用宽不足时）：按**比例压缩**（下限 `minW`）+ 格内换行；`minW` 也放不下 → 截断加省略号；不做降级为列表
- **列分隔 / 表头**：列间画**前景色实线** `│`（末列不画）；表头下**双横线** `═`（区别于 turn 分隔的 `╌`）
- **单元格内容 / 纵向对齐**：cell 内**按正常 markdown 解析**（多段/行内格式）；矮格补行高时**垂直居中**——`valign: "center"`（§2 NodeBase；默认 top）
- 何时才需要真正的 `table` 构造子：出现 colspan / rowspan / 冻结表头这类**不可降级**能力时

**构建器签名**（落实 design §6 模块 `layout/table.ts`）：

```ts
// cells: 二维，rows[col] 已含 markdown 行内解析需要的信息；width: 可用宽（历史区由 metrics 给出）
tableBox(cells: Cell[][], width: number): Box   // 产出 v([ h([cellBox, …]), … ]) 的 Box 子树
```

- **`minW` 下限**：每列一个最小宽下限；压缩后仍 < minW → 格内省略号截断（`…`）。具体 `minW` 取值策略待定（候选：`ceil(colW_natural / 4)`，见 `TASKS.md` §6）。
- **分隔符**：`│` 前景色实线（`ColorName: "border"`），固定 1 列，末列不画；表头下 `═`（双横线，`ColorName: "border"`）。
- **对齐**：`:---:` 映射 `align`（左/右/居中），数字列右对齐。
- **格内多段**：cell 内按正常 markdown 解析（`Paragraph`），矮格补行高用 `valign: "center"`。

## 5. 缩进段落语义（叶子规则） [spec]

1. **共享缩进**：段内所有行（含软换行续行）以 `indent`（首行）/ `hanging`（续行）为基准；段内不出现缩进变化，需要变化就拆叶子。

1. **前缀占列**：`prefix` 先占列，正文缩进自前缀之后起算；续行是否重复前缀由 `hanging` 决定（引用/列表重复竖线或对齐正文，现状语义保持）。

1. **宽度**：段落可用宽度 = 容器分配宽 − indent − prefix 宽度；换行按显示宽度（`charWidth/displayWidth`，CJK/emoji 零宽表不变）。

1. **样式**：段落 `style` 为默认，行内 markdown 解析产生的段样式在其上覆盖（`FrameSegment` 级）。

1. **产出**：段落摊平后是若干 `FrameRow`，每行若干 `FrameSegment`——与 Part II 渲染契约无缝衔接。

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

## 6. 布局算法（纯递归） [spec]

### 6.1 尺寸计算次序：宽先于高（交替细化）

布局不是两个相互独立的阶段，而是**交替细化**，宽度永远先于高度确定（与设计不变量一致）：

1. **宽轴 = 自顶向下（分割）**：根矩形（终端尺寸）→ 逐层按 `Width` 意图切分宽度。该链与内容无关，纯分割（`metricsFor`/`contentW` 的活）。
1. **高轴 = 自底向上（生长）**：**必须在宽度确定后才能计算**——段落折行必须知道可用宽（来自父链分配），折行行数即高度（`wrapBufferLines` 的活）。
1. **视口裁剪 = 再一次自顶向下**：行级高度预算（如 `activityH`）与内容行数比较，裁剪 + 滚动偏移（`topPaneHeights` + `computeViewport` 的活）。

**次序不变量（长宽不可能同时自由）**：宽度分割先于高度测量；高度永远在宽度确定后计算。`measure(node, constraint)` 的 `constraint` 即「宽度来自父链」的入口——measure 并非无约束累加：宽锁（父分配）→ 高自由（内容生长）。至少一个轴被父链锁死，内容才在另一轴自由生长。

### 6.2 数据结构

```ts
// 节点联合：Box（组合）与 Paragraph（叶子）
type Node = Box | Paragraph;

// measure 产物：每个节点测量后的自然宽高（宽=分配结果，高=折行行数或子项和）
interface SizeTable {
  root: Node;                      // 根节点引用，allocate 由它出发递归（避免重复解析文本）
  w: number;                       // 该节点总宽（含 indent + prefix，父链分配后）
  h: number;                       // 自然高（内容决定：v 子项和 / h 最大子高 / Paragraph 折行行数）
  size: Map<Node, { w: number; h: number }>;   // 子树实测（含自身），供 allocate 精确切分
}

// constraint：来自父链的可用宽上界（宽锁）。根：终端 cols。measure 时"宽锁 → 高自由生长"
interface MeasureConstraint { maxW: number; }
```

### 6.3 measure 递归体（自底向上）

对每个节点，先给子项测出尺寸，再聚合成自己；约束只承载父链已分配的宽度：

```text
measure(node, c: MeasureConstraint) -> SizeTable:
  若 node 是 Paragraph:
    首行可排正文宽 W1 = c.maxW − indent − prefix.width   # 前缀 + 首行缩进先占列（规则 3）
    续行可排正文宽 Wk = c.maxW − hanging                  # hanging 缺省 = indent（悬挂缩进）
    rows = wrap(text, W1 首行 / Wk 续行)，wrap=false 时单行截断
    h = rows 数                                          # 内容自然高
    w = indent + prefix.width + 最宽正文行宽              # 节点总宽（含 indent + prefix；供横向父盒精确分摊）
    返回 { w, h }
  若 node 是 Box(direction: v):                          # 上下排布：不额外占宽
    对每个 child: measure(child, { maxW: c.maxW })        # 各子同宽约束
    h = Σ child.h + separator 行数                        # 仅纵向 Box 有 separator：各子项间 1 行，首尾不画
    w = max(child.w)                                     # v 宽取最宽子项
    返回父 SizeTable（含子 size）
  若 node 是 Box(direction: h):                          # 左右排布：横向分摊
    先按「分配优先级」（§6.5）把 c.maxW 切给每个 child：fixed/min/max/ratio 直接定宽，
    auto 先以 max 为折行上界再量内容宽，fill 吃剩余
    对 auto/fill 的 child 再次 measure(child, { maxW: 分配宽 })
    h = max(child.h)                                     # h 高取最高子项
    w = Σ child.w                                        # 列间 │ 为行端字符、不占分配宽（末列不画）
    返回父 SizeTable（含子 size）
```

- `auto` 的自指（块宽依赖内容、内容依赖块宽折行）由 `max: M` 折行上界**一次消解**：先以 `M = min(容器可用宽, max)` 为折行上界量出内容宽，再按内容宽定块宽（见 §6.5「auto 宽度测量」）。不需要分配器与测量器之间的迭代回环。
- `max` 是「折行上界」而非「最终宽度硬上限」：遇无法断行的超宽内容按现状强制放下、不丢字符，该行可 > M；块宽取实际最大行宽（由父 pane 裁剪），夹到 M 会丢内容。

### 6.4 allocate 递归体（自顶向下）

按 `Width`/`Height` 意图逐层切分矩形，输出每个节点的最终矩形：

```text
allocate(st: SizeTable, rect: Rect) -> Map<Node, Rect>:
  若是 Paragraph（叶子）: 记录 rect；结束
  若是 Box(direction: h):                                     # 横向切宽
    依「分配优先级」（§6.5）给每个子项定宽：fixed → min/max → ratio → auto（用 st.size[child].w 夹 max）→ fill(吃剩余)
    列间 │ 为行端字符、不占分配宽（fill 阶段在段边界补画，末列不画）；遇过度约束按让路顺序压缩（fill→auto→ratio→max→min→fixed）
    每个子项递归 allocate(child, { x: 当前游标, y: rect.y, w: 分配宽, h: rect.h })
  若是 Box(direction: v):                                     # 纵向切高
    每个子项宽 = rect.w（同宽）
    子项高：声明 fixed/fill 者按意图；无声明者取 st.size[child].h（测量高）
    剩余/不足按「无声明的默认分布」（§6.6）处理：无 fill 时余量留白；不足时按让路顺序压缩，底线高 ≥ 0
    separator 在两子项间占 1 行（首尾不画）
    每个子项递归 allocate(child, { x: rect.x, y: 当前游标, w: rect.w, h: 分配高 })
```

- 根矩形 = 终端尺寸（cols×rows）；`allocate` 产出的 `Map<Node, Rect>` 供 fill 阶段与 FocusFrame 使用（`DESIGN.md` Part II §8）。
- 全局流程 = 宽分割（自顶向下）→ 高生长（自底向上，用已分配宽）→ 视口裁剪（自顶向下），**无迭代回环**（见 §6.1）。

### 6.5 分配优先级：越精确的指定优先级越高

单一判据：**声明的精确度决定主张强度**——越精确越不让路（任意两个声明都可比较，不需要额外的"硬/软"分类）。

| 精度 | 声明 | 说明 |
|---|---|---|
| 1（最高） | `fixed: n` | 确定数字，无歧义 |
| 2 | `min: n` / `max: n` | 确定边界；同级内 **`min` > `max`**（保底优先于上限） |
| 3 | `ratio: v` | 确定比例（结果随容器确定） |
| 4 | `auto` | 依赖内容，需先测量 |
| 5（最低） | `fill` | 无自身主张，只吃剩余 |

**算法（单轮）**

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

### 6.6 无声明的默认分布（父 → 子）

- 无声明子项 ≡ `auto`：按 measure 自然尺寸参与分配，属低精度，让位于 `fixed`/`min`/`max`/`ratio`。
- **剩余归属（无任何 fill 时）**：父矩形余量**留白**，不摊开——显式 `spacer(fill)` 才吃剩余（§5 规则 6/8 由此成立；若默认均分/摊开，`spacer(fill)` 失去意义）。
- **空间不足（过度约束）**：按让路顺序 `fill → auto → ratio → max → min → fixed` 压缩；无声明项（auto）最先被压——可折行则折行，折不了溢出由 pane 裁剪，底线宽 ≥ 1 列。

### 6.7 fill 步骤（叶子摊平 / Box 递归 / setCell）

`fill(ctx, rect)` 把一棵已 `allocate` 出 `rect` 的 Box 树摊平为 `FrameRow[]`（纯函数；逐行追加到输出行数组）。

```ts
fill(ctx: FrameContext, box: Box | Paragraph, rect: Rect, append: (row: FrameRow) => void): void
```

按节点类型分派：

- **`Paragraph`（叶子）**：沉淀行 → 每行 `FrameSegment[]`（见下）→ 组装 `FrameRow`。折行宽度 = `rect.w − indent − prefix.width`；行内 markdown 在此解析（`parseInlineMarkdown` → 段式 `FrameSegment[]`）；`prefix` 先占列、逐行重复（引用/列表/思考）。`valign`：若自身行数 < `rect.h`，按 `top/center/bottom` 在行组前后补空白行（空白行 = 空 `FrameRow`）。`align ≠ left` 时右/中对齐按 `rect.w` 计算行内偏移。
- **`Box(direction: v)`**：按 `rect` 纵向遍历子项，子项行接续 append；`separator` 在两子项之间产出 1 行横线（字符/颜色按 `Separator`，缺省 `╌` + border）。
- **`Box(direction: h)`**：按 `rect` 的子项 `x`/`w` 依次 append；相邻子项间无竖线（`│` 是叶子文本自带的行端字符，见 §5 规则 8）——`h` 自身不画分隔。

**迭代 / 裁剪**：`fill` 只负责“把行追加进 append 的回调”，**滚动画布/裁剪由上层在拿到行数组后按 pane `rect.h` 做行级处理**（见 §6.8）。

**`setCell`（FocusFrame 用；段数组上的定点改写）**：

```ts
// 在 row.segments 上把 col 显示列处替换为 ch（边界安全：col 必须是段边界列）
setCell(row: FrameRow, col: number, ch: string, style?: FrameStyle): void
// 规则（单一确定性行为）：
//   a. 前置：col 必须是某两个相邻段之间（或行首/行尾）的段边界列；段边界 = 前段末尾显示列。
//      若 col 落在某段内部（会切成半个 CJK 宽字符），调用方不得传入——spec 不定义段内切分，
//      由 FocusFrame 保证只对边界列落笔（见 §8 不变式）。
//   b. 宽字符保护：ch 必须与目标位置同宽（均为 1 列或均为 2 列）；不满足则不替换（保持行宽不变量 #2）。
//   c. 替换：拆除旧内容并按需插入新段；若新段 style 与相邻段全字段相等则合并（不变量：相邻同 style 合并）。
//   d. 替换后丢弃空段（text==""）。
//   e. setCell 不改变行宽（只替换既有宽度；col 超出行末时不操作）。
```

### 6.8 fill 阶段的适配（折叠/裁剪全放 fill）

折叠决策依赖**可用高度**，因此全部落在 `fill`（拿 rect 之后）执行——内容树本身与尺寸无关，避免“建树要先知高度”的鸡生蛋：

- **状态列分级折叠**（L0–L3）：按 rect 高逐级尝试、首次放下即采用；必保行与可折叠条目及其优先级由现状块结构（`head`/`items`）自然携带，**不发明“可折叠标注”**（现 `foldAt`）
- **历史区组折叠**：仅保最近 N 回复组，更早替换为灰占位（现 `foldDialogue`）
- **活动区两态**：状态 1 每条完全显示、溢出按行截断 + 可滚动；状态 2（紧凑）每条目压为 1 行、行尾省略号；**触发方式待定**（`TASKS.md` §6）
- 滚动 viewport：按矩形高裁行 + 行级滚动偏移（= 现状 `computeViewport` 语义）

**adapt.ts 签名**（落实 design §6 模块归属）：

```ts
// 状态列分级折叠：L0-L3 逐级尝试、首次放下即用；输入为状态列内容行（已含 head/items 优先信息），输出裁剪后行
foldAt(rows: StatusRow[], budget: number): StatusRow[]   // L0→L3 尝试；全部放不下 → 行级截断 `…(+N行)` 兜底
// 历史区组折叠：保最近 N 回复组，更早替换为灰占位 `…(更早回复已折叠)`
foldDialogue(rows: ConversationRow[], keep: number): ConversationRow[]
// 活动区两态：状态 1 完整显示 + 截断/滚动；状态 2 每条目压 1 行 + 行尾省略号
activityCompact(rows: ActivityItem[]): ActivityItem[]
```

以上适配函数都是 `(内容, rect) → 行` 的纯函数——同输入同输出，支撑 §9 的摊平可复现不变量。

## 7. 面板场景原语 [spec]

落实 `DESIGN.md` Part II §7（面板 = Box 生成器）与 design §6 模块 `layout/panel.ts`。面板组件（Approval/Question/Picker 等）重写为 Box 生成器，用下列**便捷构造**组装（非新 `kind`，均返回 `Box`/`Paragraph`）：

```ts
// 面板结构原语：各返回 Box 子树，由 fill 统一摊平
panelTitle(text: string): Box                    // 标题行（加粗；如审批面板第一行）
panelQuestion(text: string): Box                 // 问题正文（Panel 主问句）
panelExplanation(text: string): Box             // 解释/说明段（次要文字）
panelOptions(options: PanelOption[]): Box       // 选项列表（每项一行：选中标记 + 文本 + 样式）
```

- 面板组件 = 这些原语的组合函数（design §7），输出整棵 activity 内容树替换（无需 Overlay）。
- 选项行：高亮标记 + 文本；`PanelOption { label: string; selected: boolean; focused?: boolean }`——渲染字符沿用现状面板（高亮游标 `>`、单选选中 `*`、多选 `+`，见 `IMPLEMENTATION.md`「/model 命令」ModelPicker）。
- 面板原语跟普通 `Paragraph` 一样可配 `indent`/`style`/`wrap`，无新属性——纯组装糖，不改布局语义。

## 8. FocusFrame 覆写规格 [spec]

落实 `DESIGN.md` Part II §8：焦点框 = 全局覆写，无 `box.border`。

```ts
FocusFrame(ctx: FrameContext, rects: Map<PaneId, Rect>, rows: FrameRow[]): void
// 纯函数，就地改写 rows（整帧一次扫描完毕）；不改变行数/行序
```

**扫描步骤**（对整帧逐行逐列）：

```text
对每一 row, 每一 col:
  判定该网格位置是否为“焦点分区边界”的候选：
    行列落在 rects[focusedPanel] 的 上/下/左/右 四条边的网格上 且
    该位置属于设计 §8 表格所列的线条组合（history 顶/左、activity 上/左/分隔、status 四边+角、状态区上下 ┴ ┘ 等）
  若候选 → 用 setCell(row, col, 期望角字/边线, 亮色 style) 覆写
```

- **期望字符表**：`─` 水平边、`│` 垂直边、`┌┐└┘┴┤├` 角/交叉字（按设计 §8 表格的“现状构图 → 覆写”映射逐条给）。
- **坐标谓词**：一个位置是否“该亮” = `(row,col)` 属于焦点分区边界线网格 **且** 对应设计 §8 的线/角组合。
- **防双画**：扫描顺序自上而下、自左而右，同一网格只写一次；**优先级 = FocusFrame 亮边 > 正常内容 > 空白占位**——即覆写发生在所有行已由 fill 产出之后，覆盖内容/占位不重复（设计 §8）。
- **未聚焦（focusedPanel=null）**：不覆写——灰线/占位由正常内容机制（行端竖线 / `v.separator`）保持。
- **不变式**：覆写**不改行宽**（`setCell` 坐落在已有段上）、不切 CJK、不改变行数与顺序（A5 不变量兼容）。
- 「状态区上下横线的 `└/┴/┘`」同规则处理（设计 §8）。

## 9. 排版管线 [spec]

```
state --buildBox--> Box 树 --measure/allocate--> rects --fill(ctx, rect)--> FrameRow[] --renderer--> 终端
        （每帧全量重建，与现状整帧重绘一致）
```

- 每帧从 state 派生 Box 树（纯函数），无增量、无文档状态
- `ctx: FrameContext = { state, size, themeId, metrics, focusedPanel … }`（`FrameContext` 定义见 §11.3）
- 对外仍 `buildFrame(state, size): FrameRow[]`，**renderer 契约零改动**
- **不变量**：摊平可复现——`flatten(state, size)` 是 `(state, size)` 的纯函数，同一输入必产出同一行序列（单测断言：同输入两次 flatten 逐行相等）；行级滚动偏移 = 该行序列的稳定索引

______________________________________________________________________

## Part II · RenderLine→FrameRow 渲染契约

## 11. 层间数据契约

### 11.1 排版输出（核心新增，取代 `RenderLine`）

```ts
// 语义色名：排版层唯一颜色词汇；渲染层按当前主题解析为实际 hex + SGR。
// "code" 为新增语义（行内代码/代码块背景：dark 深灰 / light 浅灰），
// 取代排版层旧 CODE_BG 手拼 hex（已删；值迁入本槽位）。
export type ColorName =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "gray"
  | "border"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
  | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite"
  | "code"
  | (string & {}); // 逃生通道：任意名渲染层回退基底色（fail-safe），不用即弃

// 行内一段：纯文本 + 语义样式（原型 = 原 markdown.ts InlineSegment，已并入本类型；字段已对齐）
// 段级样式描述：语义色名（渲染层按当前主题解析为 hex + SGR）；
// 排版层唯一样式类型——FrameSegment / Box.NodeBase.style / prefix.style 共用
// （样式漂移已消除：原 RenderLine.style 由本类型替代，renderer 无独立行级样式）
export interface FrameStyle {
  /** 原则上取 ColorName；"#hex" 逃生保留但新代码禁用（存量待清理） */
  fg?: ColorName | `#${string}`;
  bg?: ColorName | `#${string}`;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

// 行内一段：纯文本 + 段级样式（原型 = 原 markdown.ts InlineSegment，已并入本类型；字段已对齐）
export interface FrameSegment {
  /** 纯文本，绝不含 ANSI/控制序列（不变量 #1） */
  text: string;
  style?: FrameStyle;
}

// 一行：排版输出最小单位
export interface FrameRow {
  /** 有序；相邻同 style 由渲染层序列化时自动合并 */
  segments: FrameSegment[];
  /** 输入行硬件光标停留列（0 基显示列）；仅输入行设置，宽度由排版层算好（不变量 #3） */
  caret?: number;
}
```

### 11.2 渲染层公共 API（改签名一处）

```ts
interface Renderer {
  render(rows: FrameRow[]): void;   // 整帧重绘（delta 为内部优化，对外不可见）
  refresh(rows: FrameRow[]): void;  // 强制全帧（Ctrl+L）
  onKey(cb: (k: KeyEvent) => void): void;
  emitKey(k: KeyEvent): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  getSize(): Size;
  setTheme(id: ThemeId): void;
  close(): void;
}
```

### 11.3 排版输入（已有契约，立字据）

- 输入 = `AppState`（只读）；`buildFrame(state, size): FrameRow[]` 保持**纯函数**：不改 state、无副作用、无 adapter/paint 调用（REFACTOR.md 原则）。

- **排版上下文（fill 阶段只读输入；不跨层，供 §9 管线引用）**：

```ts
// buildFrame 内部：state --buildBox--> Box 树 --measure/allocate--> rects --fill(ctx, rect)--> FrameRow[]
// ctx 承载构建/填板的只读事实；各区域 fill 不再背一长串位置参数（现 buildTopRegion 的痛）
interface FrameContext {
  state: AppState;                          // 只读，无副作用（REFACTOR 原则）
  size: Size;                               // 终端尺寸（cols×rows）
  themeId: ThemeId;                         // 主题选择（取色由渲染层）
  metrics: FrameMetrics;                    // 分区尺寸预算（statusColWidth/historyWidth/topHeight/footerHeight…）
  focusedPanel: "history" | "activity" | "status" | null;  // 焦点分区（FocusFrame 覆写用）
}

// FrameMetrics：分区尺寸预算（由 buildFrame 内 metricsFor/topPaneHeights 等计算后填入 ctx）
interface FrameMetrics {
  statusColWidth: number;   // 状态列宽（含右缘框列）
  historyWidth: number;     // 历史区宽（含左缘框列）
  contentW: number;         // 历史区正文宽（= historyWidth − 左缘框列）
  topHeight: number;        // 顶部区高（历史+活动区）
  activityH: number;        // 活动区高
  dialogueH: number;        // 历史区行可视数
  footerHeight: number;     // 底部区高（输入+提示）
}
```

______________________________________________________________________

## 12. 主题契约

颜色语义是**两段映射**，各归一层：

```
state 事实("status=failure")             -- 逻辑层，不碰颜色
   ↓
语义 → 色名("failure 用 red")            -- 排版层 ★
   ↓
色名 → 色值 → SGR("red" → hex → \x1b[…   -- 渲染层
```

- **语义 → 色名（排版层）**：映射表为**排版层常量**——不入 `AppState`、不进 renderer。现有实例：`STATUS_PROMPT_COLOR[inputStatus]`（success 绿 / running 黄 / failure 红）、`permColor`（sandbox 危险等级 ro 绿 / wr 黄 / full 红）、notice tone（log 灰 / info 蓝 / warn 黄 / error 红 / success 绿）。markdown 语义同为此类（`**`→bold、`` ` ``→bg:code）：解析器在排版层，调"强调样式"只改排版层映射，state / renderer 均不动。
- **色名 → 色值（渲染层独占）**：`ColorName → hex → SGR`（`colorFor` / `ansiNameToHex` / `hexSgr` 不得再被排版层 import，`theme.ts` 收口）。
- **排版层仅持有**：`ThemeId` + 语义 `ColorName`；state 保持与呈现无关（不存颜色）。
- 未知色名回退基底色（fail-safe，不抛异常，与现状 `ansiNameToHex` 返回 null 语义一致）。

______________________________________________________________________

## 13. 不变量（排版层义务，渲染层据此当纯字节通道）

| # | 不变量 | 承担方 |
|---|---|---|
| 1 | `text` 无 ANSI/控制序列 | 排版层 |
| 2 | 每行 segments 显示宽度合计 = 行宽 | 排版层 |
| 3 | `caret` 仅输入行，列号按显示宽度算好 | 排版层 |
| 4 | 跨行段行内自洽：软换行时每行重新声明样式 | 排版层 |
| 5 | 渲染层不量宽、不布局、不理解内容 | 渲染层（身份） |

______________________________________________________________________

## 14. segStyle 精确规格（渲染层段级序列化）

**`segStyle` 精确规格**（design §6 渲染层：screen.ts 段级序列化）：

```ts
// 把一段 FrameSegment 序列化为 ANSI 文本（含样式前后缀）
segStyle(seg: FrameSegment, theme: Theme): string
// 语义：
//   1. style 缺失/为空  → 仅返回文本（无前缀）
//   2. 色名 → hex → SGR 前缀；bold/italic/underline/strike 各追加 SGR 码（顺序固定）
//   3. 未知名色名 → 回退基底色（fail-safe，等同现状 ansiNameToHex 返回 null 时的基底）
//   4. 相邻同 style 合并：由渲染层在遍历 segments 时比较相邻 style 全字段相等则跳过新前缀（只输出一次底/前缀）
//   5. 每行行尾输出 SGR 重置（所有样式关闭）；下一行重开
//   6. caret：仅输入行，caret 列由排版层算好（不变量 #3），渲染层在行内定位
```
