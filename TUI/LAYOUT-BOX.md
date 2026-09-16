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
  // 无 border：边框归 FocusFrame（§8）
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

**简写与说明**：示例中 `v([...])` / `h([...])` 是 `Box(direction:"v"/"h")` 的简写，`text(...)` 是 `Paragraph(...)` 简写。`v.separator` 是**唯一**的"边框"机制——只做兄弟项之间横线分隔，**不做盒子四边描边**（现状无此需求）、**不做** `h` 竖分隔（列间 `│` 仍是行端字符）；焦点框线仍归 `FocusFrame` 全局覆写（§8）。

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

> 上例中的区域名（`titleBar`/`history`/`statusColumn`/...）即**带 `id` 的 Box**（分区，类型见 §2 的 `Box`/`PaneId`）；尺寸意图写在对应 Box 的 `width`/`height` 上（如历史区 `fill+min:10`、状态列 `ratio 1/3`）。
```

- **pane 树**：结构固定（四区域），尺寸由 `metricsFor` 预算 → `Width/Height` 意图
  - **分区层硬编码**于 `buildBox`：四区域 Box 嵌套是固定字面量（区域固定、面板不新增分区）；
  - **内容层用清单**：每个 pane 内走「内容元素类型 → Box 构建函数」映射表，新增内容类型 = 加一条映射、不改布局主体（§3）；不引入 `planRegions` 分区清单
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
measure(box, constraint) -> SizeTable            // 自底向上成长：v 高求和/宽取 max；h 宽求和/高取 max；constraint 携带父链分配的宽度
allocate(SizeTable, rect) -> Map<Box, Rect>       // 自顶向下分割：按 Width/Height 意图逐层切分矩形
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

### 尺寸计算次序：宽先于高（交替细化）

布局不是两个相互独立的阶段（先 measure 后 allocate），而是**交替细化**，宽度永远先于高度确定：

1. **宽轴 = 自顶向下（分割）**：根矩形（终端尺寸）→ 逐层按 Width 意图切分宽度。该链与内容无关，纯分割（`metricsFor`/`contentW` 的活）。
1. **高轴 = 自底向上（生长）**：**必须在宽度确定后才能计算**——段落折行必须知道可用宽（来自父链分配），折行行数即高度（`wrapBufferLines` 的活）。
1. **视口裁剪 = 再一次自顶向下**：行级高度预算（如 `activityH`）与内容行数比较，裁剪 + 滚动偏移（`topPaneHeights` + `computeViewport` 的活）。

**次序不变量（长宽不可能同时自由）**：宽度分割先于高度测量；高度永远在宽度确定后计算。`measure(box, constraint)` 的 `constraint` 即「宽度来自父链」的入口——measure 并非无约束累加：宽锁（父分配）→ 高自由（内容生长）。至少一个轴被父链锁死，内容才在另一轴自由生长。

### 无声明的默认分布（父 → 子）

- 无声明子项 ≡ `auto`：按 measure 自然尺寸参与分配，属低精度，让位于 `fixed`/`min`/`max`/`ratio`。
- **剩余归属（无任何 fill 时）**：父矩形余量**留白**，不摊开——显式 `spacer(fill)` 才吃剩余（§5 规则 6/8 由此成立；若默认均分/摊开，`spacer(fill)` 失去意义）。
- **空间不足（过度约束）**：按让路顺序 `fill → auto → ratio → max → min → fixed` 压缩；无声明项（auto）最先被压——可折行则折行，折不了溢出由 pane 裁剪，底线宽 ≥ 1 列。

### fill 阶段的适配（折叠/裁剪全放 fill）

折叠决策依赖**可用高度**，因此全部落在 `fill`（拿 rect 之后）执行——内容树本身与尺寸无关，避免“建树要先知高度”的鸡生蛋：

- **状态列分级折叠**（L0–L3）：按 rect 高逐级尝试、首次放下即采用；必保行与可折叠条目及其优先级由现状块结构（`head`/`items`）自然携带，**不发明“可折叠标注”**（现 `foldAt`）
- **历史区组折叠**：仅保最近 N 回复组，更早替换为灰占位（现 `foldDialogue`）
- **活动区两态**：状态 1 每条完全显示、溢出按行截断 + 可滚动；状态 2（紧凑）每条目压为 1 行、行尾省略号；**触发方式待定**（§14）
- 滚动 viewport：按矩形高裁行 + 行级滚动偏移（= 现状 `computeViewport` 语义）

以上适配函数都是 `(内容, rect) → 行` 的纯函数——同输入同输出，支撑 §9 的摊平可复现不变量。

## 7. 现状特殊场景逐条落法

| 场景 | 落法 |
|---|---|
| 浮动面板（审批/问答占活动区） | activity 的**内容树整体替换**为面板 Box，非叠加层——无需 Overlay 构造子；面板组件是 Box 生成器（**场景原语** `title`/`question`/`explanation`/`options`，便捷构造），内部排版同样走 Box，fill 统一摊平；`RenderLine[]` 输出退出 |
| 滚动裁剪（历史/活动区 viewport） | fill 拿矩形高后按行裁剪（现状语义） |
| 非等分左右（历史 vs 状态列） | `Width.ratio`（状态列 1/3）+ `fixed`（历史区保底 10 列） |
| 横线/虚线区域分隔（`─`/`╌`） | `v({ separator })` 自动生成（§2）；特殊横线（如页面级 `---`）用显式 `Paragraph` |
| **焦点四边框 / 标题栏兼作顶边 / 跨区角字** | 见 §8 全局 FocusFrame |

## 8. 焦点框线方案（border 的核心设计）

> **边框归属（先钉死）**：Box 模型**不引入 `box.border` 属性**。三类视觉边界各有机制——兄弟项分隔线 = `v.separator`（§2）；行端竖线 = 摊平时按行附加；**焦点高亮框 = 本节全局 `FocusFrame` 覆写**。现状无"盒子四边描边"需求，不为假想买单。

**现状事实**（`buildStatusSeparator` / `buildTopRegion`）：

- 角字/边线**按焦点在本帧选择性亮相**：`─ │ └ ┘ ┌ ┐ ┴` 依 `sepFocus`（none/activity/status）与 `focusedPanel` 逐段决定，未聚焦回灰
- **共享边**：标题栏下划线行兼作 history 顶边；D 列竖线兼作历史区右缘/状态列左缘——两区 border 落同一条线，**不能双画**

**方案：焦点框线 = `FocusFrame` 全局覆写（唯一机制，无 box.border）**

布局后得到 `Map<PaneId, Rect>`（仅带 `id` 的可寻址分区），顶层 `FocusFrame(ctx, rects)` 纯函数——已知 `focusedPanel` 与各区域矩形，在指定行列**重写角字与边线**（未聚焦的灰线由正常内容机制产出：行端竖线 / `v.separator`，与本层无关）。与现状中心化构图一一对应：

**实现载体**：不引入字符网格——`FrameRow` 保持段数组，`FocusFrame` 对整帧做**一次循环扫描**：凡满足焦点框线坐标谓词（行列落在焦点分区 `Map<PaneId, Rect>` 的边界、且该位置当前为灰框/占位/内容）的位置，以 `setCell(row, col, ch, style)` 切段替换为亮角字/边线。防双画由**扫描 + 覆盖顺序**天然保证（FocusFrame 亮边 > 内容 > 占位），每处只替换一次。覆写按**字符**定位（不切半个 CJK），宽度不进入覆写计算。

| 焦点 | 现状构图 | FocusFrame 覆写 |
|---|---|---|
| history | 标题栏下划线行兼作顶边（┌─┐）、左缘/分隔竖线 │ | titleBar/history 共享行亮边 + 左角 |
| activity | 活动区分隔两端 ┌┐、活动区左缘/分隔竖线 │ | activity 矩形左缘、底部分隔行亮 |
| status | 状态列 rc0 起 ┌─┐、右缘框列、┴ ┘ | statusColumn 矩形左/上/下/右亮边 |
| 无焦点 | 全灰/空白占位（布局不重排） | 不覆写 |

- **防双画规则**：共享行/列上优先级 = FocusFrame 亮边 > 正常内容行 > 空白占位；每条边只写一次。
- 状态区上下横线的 `└/┴/┘` 角字同样由 FocusFrame 按焦点状态产出（对应现状 `buildStatusSeparator`）。

**为什么焦点框不做成"每个 box 自带 border"**：焦点框是**全局状态驱动的跨区构图**，放叶子上会让每个区域重复判断焦点，且无法处理共享边；中心化为 FocusFrame 一层，正好对应现状的集中构图。

## 9. 排版管线

```
state --buildBox--> Box 树 --measure/allocate--> rects --fill(ctx, rect)--> FrameRow[] --renderer--> 终端
        （每帧全量重建，与现状整帧重绘一致）
```

- 每帧从 state 派生 Box 树（纯函数），无增量、无文档状态
- `ctx: FrameContext = { state, size, themeId, metrics, focusedPanel … }`（CONTRACT §2.3 定义的只读上下文，见 `CONTRACT.md`）
- 对外仍 `buildFrame(state, size): FrameRow[]`，**renderer 契约零改动**
- **不变量**：摊平可复现——`flatten(state, size)` 是 `(state, size)` 的纯函数，同一输入必产出同一行序列（单测断言：同输入两次 flatten 逐行相等）；行级滚动偏移 = 该行序列的稳定索引

## 10. 与既有文档的关系

- **CONTRACT.md**：Box 树是排版层内部中间表示；`FrameRow`/`FrameSegment`/`FrameContext` 不变；两文档**互相引用**（`CONTRACT.md` §2.3 定义 `FrameContext` 供 §9 引用，其头部配套列本文件，定义处反向引用）
- **REFACTOR.md**：拆文件不拆架构、只拆纯逻辑；Box 是数据不是类，**不违背"不抽象通用 Panel"**；副作用仍留 App。
- **DESIGN.md**：不引入 flex/测量回环/样式继承；"布局代数"≠组件树。

## 11. 开放点

> 本节只记与算法/工程直接相关、尚未落实的开放点；其余已定决策见对应章节（§14 仅列未决项）。

- **内容树的测量代价**：消息多时每帧全量 measure；若成为瓶颈，再评估“内容行缓存”（现状本来也是每帧 wrap 全量，预期无回归）。

## 12. 实施步骤（并入 layout 重构）

推进分三波（并行路线；最终拆为多个可独立回归的提交）：

1. **接口冻结**：定义 `Box`/`Paragraph`/`NodeBase` 类型 + `measure/allocate` 签名（纯函数）
1. **五路并行**：① 契约迁移（`RenderLine[]` → `FrameSegment[]`，消灭手拼 ANSI）；② measure/allocate 实现 + 单测（宽度规则/保底/比例/悬挂缩进）；③ 内容映射（`state.buffer` → 内容 Box 树，替换 `wrapBufferLines` 的分类处理）；④ 测试序列化辅助（`FrameRow[]` ↔ 字符串，复用旧断言，§14 C3 相关）；⑤ 拆文件（`layout.ts` 拆纯逻辑，行为不变）
1. **接线汇合**：各区域改造为 `fill(ctx, rect)`；`FocusFrame` 实现与测试（对照现有焦点框线各焦点态的帧断言）；面板改造为 Box 生成器（§7）
1. 全量回归：`npm run check/test/build` + `demo -- --smoke` + `smoke:pty`
1. 文档同步：CONTRACT §2.3 引用、DESIGN「四区域布局」改为“由 Box 树声明”、REFACTOR 归属登记

## 13. 明确不做

- flex/grid/自动布局引擎/样式继承/响应式重排/嵌套滚动
- 可复用 Panel 基类 / 带行为的组件节点
- Overlay 覆盖层构造子（面板走"内容替换"，必要时再评估）
- renderer 侧任何改动（Box 不出排版层）

## 14. 待决清单（未决项，其余决策已并入正文）

> 本版起，已定决策不再在此重复，均按主题并入对应章节：§2（两类节点/Spacer/Pane/valign/尺寸意图归属）、§3.2（表格：窄终端压缩/列分隔/单元格对齐）、§4（分区硬编码 + 内容映射清单）、§6（fill 阶段折叠适配）、§7（面板 = Box 生成器 + 场景原语）、§8（FocusFrame 段级覆写）、§9（摊平可复现不变量）、§10（文档互引）、§12（并行实施路线/拆提交）。本节只保留尚未定案项。

| # | 问题 | 备注 |
|---|---|---|
| C2 | markdown 解析器重构范围 | 块解析自 `wrapBufferLines` 抽出后，`markdown.ts`（727 行）是否整体重排——动工那一步按实际 diff 形态评估 |
| C3 | 测试迁移策略 | 560 个测试断言由「带 ANSI 文本」改为 `segments` 结构：改动面、是否提供序列化辅助——动工那一步按实际 diff 形态评估 |
| — | 活动区两态触发方式 | 状态 2（紧凑）：由「fill 按高度预算自动降级」 vs「用户显式配置」决定（§6 fill 适配） |
