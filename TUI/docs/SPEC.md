# TUI 渲染管线规格（Spec）

> 职责：TUI 渲染管线的权威规格（布局 / 窗口 / 绘帧口径）
> 不负责：命令面与配置说明（见 `TUI/README.md`、`TUI/docs/COMMANDS.md`）
> 过期条件：无（随实现同步更新）

> 类型：**[spec]**——排版与渲染的接口与规则：Box 类型与布局算法（§2-§8）、排版管线（§9）、层间数据契约与主题契约（§11-§12）、不变量（§13）、段级序列化（§14）。可照写、可验证。
> 配套：`TUI/docs/DESIGN.md`（设计与取舍 / 机制实现要点）。章节编号稳定（代码注释按号引用），新章节追加在末尾。

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
  suffix?: {                        // 段尾固定后缀（占列，正文补白后挂；每行重复）
    text: string;                   //   如用户块右缘 ┃ 竖线（不随行尾移动）
    style?: FrameStyle;
  };
  tail?: {                          // 行尾铺满字符（不占测量宽；fill 补到分配宽）
    char: string;                   //   如 step 虚线 ╌ / turn 分隔 ╌
    style?: FrameStyle;             //   缺省无样式（默认前景；对齐旧 turn 分隔线）
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
  separator?: Separator;            // v 排布行间横线 / h 排布列间竖线框线（结构性，随子项增删；首尾不画）
  id?: PaneId;                      // 分区身份（Pane = 带 id 的 Box）：仅可寻址区域挂
  // 无 border：边框归 FocusFrame（`TUI/docs/DESIGN.md` §8）
}

// 2. Paragraph = 叶子节点（内容最小单位）：不能嵌套子 Box
interface Paragraph extends NodeBase {
  kind: "text";
  text: string;                     // 纯文本；行内 markdown 在摊平阶段解析
  // 无 children、无 direction、无 separator
}

// Spacer = 内容为空的 Paragraph（便捷构造）：只声明尺寸意图，不产出内容
//   spacer({ width }) := Paragraph({ text:"", width })（h 容器占列）
//   spacer({ height }) := Paragraph({ text:"", height })（v 容器占行）——轴显式
```

**简写与说明**：示例中 `v([...])` / `h([...])` 是 `Box(direction:"v"/"h")` 的简写，`text(...)` 是 `Paragraph(...)` 简写。`separator` 是**唯一**的"边框"机制——纵向 `v` 做兄弟项之间横线分隔（缺省 `╌`）、横向 `h` 做列间分隔（缺省 `│`+border；状态栏组内 / 组间分隔改传 `{ char:"•", color:"plain" }`，见 §3「系统状态栏分隔」，不再与上/下横线相交、无交点 `┬`），**不做盒子四边描边**（现状无此需求）；焦点框线仍归 `FocusFrame` 全局覆写（`TUI/docs/DESIGN.md` §8）。

**`Spacer` 用法**：块级对齐/间距的占位项——横向 `spacer({ width: fill })` 吃剩余推位（用户块右对齐）、`spacer({ width: fixed n })` 留白（回复右缘 `messageGutter`）；纵向 `spacer({ height: fill })` 吃剩余、让内容不足时落在容器底边、`spacer({ height: fixed n })` 为固定空行。**轴必须显式给出**（`width`→h 占列、`height`→v 占行，杜绝 `{mode:"fill"}` 歧义）；允许 `fill` 与 `fixed`（±夹取界）两种形态，`auto`/`ratio` 对空内容无意义、不做（YAGNI）。

**宽度/高度意图**（对齐现状：状态列 1/3 且最低 20 列、历史区保底 10 列、交互区固定行数）：

```ts
type Width =
  | { mode: "auto"; min?: number; max?: number }   // 按内容宽度（用户块的"收缩块"用）
  | { mode: "fill"; min?: number; max?: number }   // 占满剩余
  | { mode: "fixed"; cols: number }
  | { mode: "ratio"; value: number; min?: number; max?: number }; // value=容器分数（状态列 1/3）；Σ>1 才按 value 和归一
type Height =
  | { mode: "fixed"; rows: number }     // 交互区/输入区固定行数
  | { mode: "fill" };
```

`min/max` 是**夹取界**（分配优先级与冲突解决见 §6「分配优先级」），三个真实用法（均由现状代码印证）：

| 用例 | 现状 | 模型表达 |
|---|---|---|
| 用户消息块 | `userMaxBodyWidth = width − gutter`（layout.ts:1203） | `{ mode:"auto", max: 可用宽 − gutter }` |
| 历史区保底 | 与下一条共同决定状态列上限 | `{ mode:"fill", min: 10 }` |
| 状态列宽 | `Math.min(max(20, ⌊cols/3⌋), cols−10)` | `{ mode:"ratio", value:1/3, min:20 }`——**上限由历史区的 `min` 自动产生**，无需再写 `max`（见 §6「一侧声明即够」） |

**为什么需要尺寸意图**：`measure` 只回答「内容自然有多大」（内容说了算），`allocate` 才回答「容器分配给你多少」——而**填满剩余（fill）、按比例（ratio）、固定行数（fixed rows）、保底（min）这些布局需求都与内容无关**，必须作为额外声明带给分配器，否则这些数字只能写死在布局函数里。因此：**尺寸意图 = 布局的需求侧声明，归属对象是分区（带 `id` 的 Box / 覆盖型的叶子）而非普通内容节点**。挂载点：`width`/`height` 在 `NodeBase`（Box 与 Paragraph 共享），内容节点**缺省不声明**（高度由折行决定），仅两类场景显式声明——分区（带 `id` 的 Box，如状态列 `ratio 1/3`、历史区 `fill+min:10`）与覆盖型叶子（§3.2 表格每格 `width:fixed`、`Spacer`）。

### 取值域与交互边界

- **宽度**：`fixed.cols`≥1；`min`/`max`≥1（夹取界为“列数下限/上限”，超界按界夹）；`ratio.value`>0。退化终端下即便违背 `min` 也保 1 列底线（§6）。
- **高度**：`fixed.rows`≥0（0 = 不占行）；`fill` 取剩余、可被裁剪到 0。
- **`align`（行级）**：仅当该叶子被分配了确定的 available 宽（`width: fixed/fill`）时生效；`auto` 宽叶子无从对齐（§5 规则 8）。
- **`valign`（垂直）**：仅当该叶子所在 `h` 行的高度 = 子高 max、且本叶子实际内容行数 < 行高时生效——补白分上下两侧：`top` 补在下、`center` 上下平摊、`bottom` 补在上（§6 fill 步骤）。
- **`prefix` 测量**：前缀按显示宽度占列；`prefix.width = charWidth(prefix.text)`；正文可用宽 = 分配宽 − `indent` − `prefix.width`（§5 规则 3）。
- **`suffix` 测量**：后缀占列并入总宽（`w = max(首行 overhead, 续行 overhead) + suffix.width`，挂在最右）；正文可用宽 = 分配宽 − `indent` − `prefix.width` − `suffix.width`（保证正文折行不溢出越过后缀列）。
- **`tail` 测量**：不占测量宽（flex 填充，fill 阶段补到分配宽；measure 不因 tail 增加行数与宽度）。
- **`wrap: false`**：不换行、单行截断加省略号；截断按显示宽度不切半个 CJK。

## 3. 内容元素映射（Box 组合示例） [spec]

| 内容元素 | Box 表达 | 对应现状 |
|---|---|---|
| 一条用户输入 | `h([ spacer(fill), Paragraph(width:auto) ])`（**块级对齐，不用 `align`**） | 整体靠右的收缩块（一次输入 = 一条 buffer 行：显式换行保留在行内、按物理行折行取最大行宽作块宽、块内行首左对齐、右缘贴边） |
| 一条 LLM 回复段落 | `h([ text(indent), spacer(gutter) ])` | 回复靠左 + 右缘 `messageGutter` 留空 |
| 思考 | `text(prefix:{┃,紫}, indent:1)` | 左侧紫色竖线区分 |
| 一条工具调用记录 | `v([调用行, 结果行])`，续行 `hanging:2` | 工具行缩进 + 续行 `TOOL_CONT_INDENT=2` |
| step 分组头 | `text("╌╌ hh:mm:ss #N ", tail:{char:"╌"})` | `stepHeaderLine(step, time)`（P6：本地时区 24 小时制逐段补零，时间缺失只出 `#N`；该 step 首个工具调用时渲染） |
| 恢复会话的 step 概要行 | 同上形制（buffer `kind = "step"`） | P9：`╌╌ hh:mm:ss #N ╌╌ 工具名[×次数], …[ ✗失败数]`，由 `surfaceToBuffer` 注入、`build-box` 按同形制品渲染 |
| 引用块 | `text(prefix:{│})` | 单层竖线前缀、正文不加斜 |
| 列表 / 任务列表 | `text(prefix:{"• "}/{"[x] "}, hanging:2)` | 统一 `•`、`[x]` 删除线 |
| 代码块 | `v([ Paragraph(lang, style:{italic}), Paragraph(code, style:{bg:"code"}, width:fill, fillBg:true) ])` | 标签单独一行（斜体、无底色）；代码体超长行折行、底色补齐到内容区宽 |
| markdown 表格 | 构建期降级为 `v([ h([cell,cell…]), … ])`（见 §3.2） | `layout/table.ts` |
| 每回合分隔线 | `text("╌╌ hh:mm:ss ⇆N ", tail:{char:"╌"})`（片段缺失即省略该片段，都缺退回纯线） | `turnHeaderLine(turn, time)`（`layout/tool-line.ts`）；buffer 侧占位行文本 `TURN_SEPARATOR`，`build-box` 的 separator 分支按上述形制渲染 |

**结论**：内容元素 → Box 子树的映射（`buildBox` / `buildContentRows`）统一了「按类型分别处理缩进 / 前缀 / 对齐」的逻辑；新增内容类型 = 新增一个映射函数，不改布局。

**顶部区域构成（结构规格）**：状态列 = **Goal / Todo / Jobs / Agents 四块**（块间虚线 `╌`，不再有 Mode 块；Agents 块无子代理数据时整块省略）；标题栏首行 = `[preset 图标 + 1 空格 + 预设名] 1 空格 [状态符号组（最多 6 个，空格分隔，固定顺序：沙箱 / policy / plan / verbose / symbol-unify / bell）] 2 空格 [会话标题]`，符号取 Nerd Font 私有区字形（`TITLE_ICON`，各 1 列）、**颜色即语义值**（沙箱 `read-only` 绿 / `workspace-write` 黄 / `danger-full-access` 红 / 其它灰；policy `ask` 黄 / `never` 绿；四个开关 `on` 绿 / `off` 灰；preset 默认前景；`permission` 不显示），窄宽让位顺序 = ① 去掉 preset → ② 截断标题 → ③ 去掉整组符号 → ④ 既有标题栏降级。`Ctrl+S` 切换状态列显隐：隐藏时 `statusColWidth = 0`、右缘分隔竖线不画（状态区上方分隔行该列的交点随之不画，几何上 `dividerCol = −1`）、历史区吃满整区全宽；显隐随会话写入 `tui-state.json`。

**系统状态栏分隔**：组内与组间统一 `•`（U+2022，默认前景色、1 列、两侧无空格；`h` 容器的 `separator` 以 `char:"•"` / `color:"plain"` 传入），因此组间不再有边框色竖线，其上/下横线也没有组间交点 `┬`（状态列右缘 D 列的 `┴` 保留）。

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

Box 模型把块判定显式化为"块列表 → 子树"，不再与 `inFence` 状态机等混在一处隐式判定。

**注入 notice 行**（BACKLOG TUI#17）：`source.form:'notice'` 的 user 消息（如 rule-engine 注入）**不按用户块渲染**——摘要（`summary`；缺省取正文首个非空行，≤120 字符）渲染为**单行 notice 行**（log 灰、进活动区），不展开、不占用户消息块；实时路径（`agent/inbox/spliced` / `user/message`，按消息 id 去重）与恢复路径（`HistoryMessage.role='notice'` → buffer `kind='notice'`）同一口径，非 notice 形态的注入维持现状（实时不显示、恢复按普通用户块）。

### 3.2 表格：构建期降级（不新增 `table` 构造子）

**关键约束**：表格列宽是**跨行约束**——同列第 3 行单元格的宽度取决于第 1 行的单元格（位于另一棵子树）。纯 `v/h` 只能表达嵌套，表达不了跨兄弟约束（HTML 为此专门有 `<table>`，CSS 有 grid）。

**方案：在内容映射层降级**——把 2D 数学放在表格构建器里，布局引擎保持**两类节点（Box/Paragraph）**：

```
表格构建器（已知可用宽 width）：
  1. 量各格自然宽（按行内解析后的渲染文本计宽）→ colW[j] = max(该列各格)
  2. ΣcolW + 固定开销 > width → 压缩（水位法，下限 minW），格内换行
  3. 产出 v([ 表头行, ══╪═ 表头横线, 数据行（行间 ──┼─ 横线）, … ])
     # 行 = h([ 左竖线 ┃, 间隔空格, pad, StyledText(cell, width:fixed colW[j]), pad, │, … ])
     # 左竖线 ┃（1 列，brightBlue，与正文左竖线同列同色）+ 1 空格间隔（表格 box 的 prefix）
     # + pad（每格左右各 1 列）+ │（固定 1 列，末列不画）
```

- **列对齐**：宽度构建期算好写成 `fixed`，各行自然对齐
- **每格独立成块**：cell 是独立叶子（列宽内自行折行）
- **行高 = 该行各格折行行数的最大值**：由构建器用 `measure` 在同一列宽下算得后**显式声明** `height:fixed`，矮格 `valign:"center"` 补白（`fill` 的补白仅在显式高度下生效，§2）
- **构建器需要可用宽度**：`buildBox` 经 `BuildBoxOptions.width` 取得（`buildContentRows` 透传内容区宽）；**宽度未知时不识别表格**（按普通文本行渲染）
- **窄终端压缩**：水位法（`waterLevel`）——窄列保持自然宽、只有超宽列被压到共同水位线，并尽量不低于 `minW = max(3, ⌈自然宽/4⌉)`；若抬到 `minW` 后超预算则退回纯水位线（不牺牲窄列）；**ΣminW 也放不下** → **放弃表格**（`tableBox` 返回 `null`，调用方退回普通文本行渲染——**内容一律不截断**，见 BACKLOG #6）；不做降级为列表
- **网格**（左缘保留回复竖线，其后 1 空格 prefix）：
  - **左缘竖线**：整表最左 1 列 `┃`（`brightBlue`，与 assistant 正文左竖线同列同色）——`┃` 概念上属父级 box，故**逐行重复**（含折行续行、横线行），整条回答左缘竖线连续不断；竖线后固定 1 空格（表格 box 的 prefix）
  - **列分隔**：列间 `│`（末列不画；折行续行逐行重复）
  - **表头下双横线** `═`（自间隔空格之后起、铺满各列含留白），列分隔交叉字 `╪`；**左缘不设交叉字**（横线与左缘竖线之间隔着 1 空格，不连接——连接会让竖线列被交叉字替换掉）
  - **数据行之间单横线** `─`（内容折行时用于区分「哪一行」），列分隔交叉字 `┼`；首尾不画（表头之上、末行之下无横线）
  - **网格线一律不着色**：`│`/`═`/`─`/交叉字用主题默认前景色（只有左缘竖线取 `brightBlue` 与正文竖线一致）
  - 表头格加粗
- **单元格内容 / 纵向对齐**：cell 内**按行内 markdown 解析**（块级不解析——格源是单行）；矮格补行高时**垂直居中**——`valign: "center"`
- **右缘留白**：`final` 行让出 `gutter − 1` 列（与正文同口径）
- **可用宽过窄**（连“左竖线 + 1 空格间隔 + 每列 1 列 + 固定开销”都放不下）→ 构建器返回 `null`，调用方退回普通文本行渲染（窄终端降级）
- 何时才需要真正的 `table` 构造子：出现 colspan / rowspan / 冻结表头这类**不可降级**能力时

**接口**（`layout/table.ts`）：

```ts
type TableAlign = "left" | "center" | "right";
interface TableSpec { header: string[]; aligns: TableAlign[]; rows: string[][] }

// 表头 + 分隔行成对判定（O(1) 预筛：表头须含未转义 `|`，分隔行格全为 `:?-+:?` 且列数一致）
isTableStart(header: string, delimiter: string): boolean
// 自 lines[start] 起解析：表头 + 分隔行 + 连续数据行（行须含 `|`，否则表格结束）；
// 缺格补空、多格忽略（列数取表头）；end = 首个未消费行下标
parseTableAt(lines: readonly string[], start: number): { table: TableSpec; end: number } | null
// 构建期降级：width 含左缘竖线 + 1 空格间隔 + 每格左右留白 + 列间分隔；过窄返回 null
tableBox(table: TableSpec, width: number): Box | null
```

- **`minW` 下限**：`max(3, ⌈自然宽/4⌉)`（#6：ΣminW 放不下时**不再**按 minW 分配 + 截断，直接退普通文本行）
- **对齐**：`:---` 左 / `:--:` 中 / `---:` 右；**未显式标注且该列（表体）非空格全为数字 → 右对齐**（数字列自动右对齐）
- **转义**：`\|` 为单元格内的字面竖线（不切格），由行内解析还原
- **`|` 的其它语义不变**：表格行之外的普通文本里 `|` 仍是普通字符（不误判为表格）

## 5. 缩进段落语义（叶子规则） [spec]

1. **共享缩进**：段内所有行（含软换行续行）以 `indent`（首行）/ `hanging`（续行）为基准；段内不出现缩进变化，需要变化就拆叶子。

1. **前缀占列**：`prefix` 先占列，正文缩进自前缀之后起算；续行是否重复前缀由 `hanging` 决定（引用/列表重复竖线或对齐正文，现状语义保持）。

1. **宽度**：段落可用宽度 = 容器分配宽 − indent − prefix 宽度；换行按显示宽度（`charWidth/displayWidth`，CJK/emoji 零宽表不变）。

1. **样式**：段落 `style` 为默认，行内 markdown 解析产生的段样式在其上覆盖（`FrameSegment` 级）。

1. **产出**：段落摊平后是若干 `FrameRow`，每行若干 `FrameSegment`——与 §11 渲染契约无缝衔接。

1. **缩进归属（防止两套机制打架）**：**段落内缩进一律走 `indent`/`hanging`/`prefix`**（行级，逐行生效）；`h` + `spacer` 只表达**块间横向位置**（块级，整块一次）——如用户块右对齐 `h([spacer(fill), text])`、右缘留白 `h([text, spacer(fixed gutter)])`。

   为什么不用 spacer 表达段落缩进：① **悬挂缩进做不到**——`h([space(2), text])` 会让整块（含首行）都缩进 2，而工具行要求首行 0、续行 2（现状 `wrapToolCallText`：首行全宽、续行 `TOOL_CONT_INDENT=2` 且折行宽度扣掉缩进）；② **前缀需逐行重复**（引用 `│`、列表 `•`、思考 `┃`），spacer 只作用于块首；③ **`fixed` spacer 并未消灭那个数字**，只是把 indent 搬进节点，且布局仍须扣除它才能算可用宽。

1. **格式一致性：约束绑定"几何"，不绑定"样式"**——把"格式"拆成两类属性，只对前一类要求叶子内一致：

   | 类别 | 具体项 | 叶子内一致？ | 理由 |
   |---|---|---|---|
   | **几何属性** | `indent`/`hanging`、`prefix`、分配宽度、`wrap` | **必须一致** | 决定"折成几行、每行从第几列起"，段内不同则无法算折行 |
   | **外观属性** | `fg`/`bg`/`bold`/`italic`/`strike` | **允许段内变化** | 只影响某一段如何着色，不参与宽度与断行计算 |

   即：**改几何就拆叶子，改样式就用 `FrameSegment`**（段落 `style` 作默认，行内解析结果在其上覆盖）。

   为什么不能强制"一个 box 一种样式"：那会逼出**跨 box 的行内折行**。例：`这是**粗体**文字，后面还有很多字要折行……` 若拆成 `h([Paragraph("这是"), Paragraph("粗体", bold), Paragraph("文字…")])`，由于 **box 边界不是换行点**，超宽时须由 `h` 容器把子 box 逐行流式摆放（兄弟 box 之间也要能断行）——等于重写一套富文本行内布局（HTML/CSS 最重的机器）。现状之所以简单：折行在**单个叶子内部**按纯文本宽度完成，样式在其后贴上（`parseInlineMarkdown` 产段、`wrapFrameSegments` 每行重开样式），样式不进入宽度计算。

   **例外（该走"每 box 统一格式"的地方）**：**不跨 box 折行的单行组合行**——标题栏符号组（preset 图标 + 名称、最多 6 个状态符号 + 标题）、系统状态栏（环境组 `•` LLM 组，各段按语义着色）、工具行头（工具名黄 + 参数默认）等，用"各自统一格式的 box + `h` 拼接"表达最自然（单行 + 截断，无需 inline flow）。

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
1. **高轴 = 自底向上（生长）**：**必须在宽度确定后才能计算**——段落折行必须知道可用宽（来自父链分配），折行行数即高度（`fill` 的活）。
1. **视口裁剪 = 再一次自顶向下**：行级高度预算（如 `activityH`）与内容行数比较，裁剪 + 定位（`topPaneHeights` 定高度、`positionAt` / `indexOfTop` 按段键位置模型切段）。区域（历史 + 活动区，位于状态列右侧）的排列方式（上下 / 左右）在此先定：`topPaneSplit` 按 pane 宽高比距黄金分割比 φ 的偏差选择排列，随后两 pane 各自按自身宽度换行（`activityPlacement` 缺省 `"vertical"`，见 `TUI/docs/DESIGN.md`「四区域布局」）。历史区排版量由**渐进窗口**限定（只物化尾部 `windowGroups` 个回合组，`windowSections`），视口位置由**段键位置模型**（`DialogueTop{key,row}`：段键 = 节身份 + 节内 box 序号）解析——两者合计使「重排 / 新增内容 / 扩窗插入段」不再移动视口所指的内容（见 `TUI/docs/DESIGN.md`「四区域布局」）。

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
    h = Σ child.h + separator 行数                        # 纵向 Box 的 separator：各子项间 1 行，首尾不画
    w = max(child.w)                                     # v 宽取最宽子项
    返回父 SizeTable（含子 size）
  若 node 是 Box(direction: h):                          # 左右排布：横向分摊
    先按「分配优先级」（§6.5）把 c.maxW − separator 列数 切给每个 child：
    fixed/min/max/ratio 直接定宽，auto 先以 max 为折行上界再量内容宽，fill 吃剩余
    对 auto/fill 的 child 再次 measure(child, { maxW: 分配宽 })
    h = max(child.h)                                     # h 高取最高子项
    w = Σ child.w + separator 列数                       # 横向 Box 的 separator：各子项间 1 列竖线，首尾不画
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
    预算 = rect.w − separator 列数（横向 Box 的 separator：各子项间 1 列竖线，首尾不画）；遇过度约束按让路顺序压缩（fill→auto→ratio→max→min→fixed）
    每个子项递归 allocate(child, { x: 当前游标, y: rect.y, w: 分配宽, h: rect.h })；游标跨子项后 +1（框线列）
  若是 Box(direction: v):                                     # 纵向切高
    每个子项宽 = rect.w（同宽）
    子项高：声明 fixed/fill 者按意图；无声明者取 st.size[child].h（测量高）
    剩余/不足按「无声明的默认分布」（§6.6）处理：无 fill 时余量留白；不足时按让路顺序压缩，底线高 ≥ 0
    separator 在两子项间占 1 行（首尾不画）
    每个子项递归 allocate(child, { x: rect.x, y: 当前游标, w: rect.w, h: 分配高 })
```

- 根矩形 = 终端尺寸（cols×rows）；`allocate` 产出的 `Map<Node, Rect>` 供 fill 阶段与 FocusFrame 使用（`TUI/docs/DESIGN.md` §8）。
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
1. **`ratio` 语义（冻结）**：`value` 是**容器总宽的分数**（`1/3`=三分之一），基数取容器总宽、实际受可分配剩余封顶；**仅当所有 `ratio` 的 `value` 之和 > 1 时按 `value` 和归一**（否则各自按分数直接取，不归一）。`min`/`max` 执行顺序：**先夹 `max` 上限、再抬 `min` 保底**——`min > max` 时 `min` 赢（保底优先，与性质列一致）。
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

- **`Paragraph`（叶子）**：沉淀行 → 每行 `FrameSegment[]`（见下）→ 组装 `FrameRow`。折行宽度 = `rect.w − indent − prefix.width`（有 `suffix` 再 − `suffix.width`）；行内 markdown 在此解析（`parseInlineMarkdown` → 段式 `FrameSegment[]`）；`prefix` 先占列、逐行重复（引用/列表/思考）；`suffix` 末占列、逐行重复（如用户块右缘竖线，正文补白到 `rect.w − suffix.width` 后挂，竖线列恒定）；`tail` 在行尾把 `char` 重复补到 `rect.w`（铺满行，如 step 虚线 / turn 分隔），与正文不相干、只在文本空时整行铺满。`valign`：若自身行数 < `rect.h`，按 `top/center/bottom` 在行组前后补空白行（空白行 = 空 `FrameRow`）。`align ≠ left` 时右/中对齐按 `rect.w` 计算行内偏移。
- **`Box(direction: v)`**：按 `rect` 纵向遍历子项，子项行接续 append；`separator` 在两子项之间产出 1 行横线（字符/颜色按 `Separator`，缺省 `╌` + border）。
- **`Box(direction: h)`**：按 `rect` 的子项 `x`/`w` 逐行横向拼接（同 y 对齐、子项间按 x 偏移补空格）；`separator` 在兄弟边界逐行插 1 列框线（字符/颜色按 `Separator`，缺省 `│` + border；每行同列、垂直贯通——横向排列的内部分隔列、状态列右缘与上/下横线相接成格；状态栏组内 / 组间传 `{ char:"•", color:"plain" }`，不参与交点连接）。

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

- **状态列分级折叠**（L0–L3）：按 rect 高逐级尝试、首次放下即采用；必保行与可折叠条目及其优先级由现状块结构（`head`/`items`）自然携带，**不发明“可折叠标注”**（现 `foldAt`）。Goal 块额外携带 `historyFrom`（`items[≥historyFrom]` 为旧 goal 条目）：L1 只保留最近 1 条历史并提示隐藏数，L2 起压成标题行
- **历史区组折叠**：仅保最近 N 回复组，更早替换为灰占位（`windowSections` 在**节**层切片 + 占位行（`MARKER_KEY`），未物化的节不排版）
- **活动区两态**：状态 1（`/collapse off`，缺省）每条完全显示、溢出按行截断 + 可滚动；状态 2（`/collapse on`，紧凑）每条目压为 1 行、行尾省略号。**触发方式已定：显式命令切换**（不做按高度预算自动降级；实现见 §15.5.1）。另有**输出内容三档** `/verbose think|tool|step`（BACKLOG #8，见 §15.5）
- 滚动 viewport：按矩形高裁行 + 行级滚动偏移（= 现状 `computeViewport` 语义）

**适配落点**（均为 `(内容, rect) → 行` 的纯函数，同输入同输出，支撑 §9 的摊平可复现不变量）：

| 适配 | 现实现 |
|---|---|
| 状态列分级折叠（L0-L3 逐级尝试、首次放下即用，兜底行级截断 `…(+N行)`） | `layout.ts` `foldAt(block, level)` + `capRows(rows, budget)` |
| 历史区组折叠（保最近 N 回复组，更早替换为灰占位 `...(更早回复已折叠)`） | `windowSections(sections, groups)` 在节层切片 + 占位行（排版量随窗口收敛，段键跨扩窗稳定） |
| 活动区两态（完整折行 / 每条目 1 行 + 行尾省略号） | `layout/build-box.ts` `compactActivityLine`（构建期压缩） |
| 滚动 viewport（按矩形高裁行 + 行级滚动偏移） | `fill` 产出行后由 `buildFrame` 按 pane 高切窗口 |

## 7. 面板场景原语 [spec]

面板 = Box 生成器（`TUI/docs/DESIGN.md` §7），组件用下列**便捷构造**组装（非新 `kind`，均返回 `Box`/`Paragraph`，落在 `layout/panel.ts`）：

```ts
// 面板结构原语：各返回 Box 子树，由 fill 统一摊平
panelTitle(text: string): Box                    // 标题行（加粗；如审批面板第一行）
panelQuestion(text: string): Box                 // 问题正文（Panel 主问句）
panelExplanation(text: string): Box             // 解释/说明段（次要文字）
panelOptions(options: PanelOption[]): Box       // 选项列表（每项一行：选中标记 + 文本 + 样式）
```

- 面板组件 = 这些原语的组合函数，输出整棵 activity 内容树替换（无需 Overlay）。
- 选项行：高亮标记 + 文本；`PanelOption { label: string; selected: boolean; focused?: boolean }`——渲染字符沿用现状面板（高亮游标 `>`、单选选中 `*`、多选 `+`，见 `DESIGN.md`「/model 命令」ModelPicker）。着色沿用现状面板：**选中行绿、未选中的焦点行黄；两者同一行时绿优先**（`selectedStyle` 覆盖 `focusStyle`）。
- 面板原语跟普通 `Paragraph` 一样可配 `indent`/`style`/`wrap`，无新属性——纯组装糖，不改布局语义。

### 7.1 面板窗口与按键焦点（BACKLOG 3.2.1 / 3.2.2 / 3.2.3 / 3.2.7）

- **共用窗口工具**：`windowStart(count, windowRows, anchor, mode)`（`layout/panel.ts`）——`center` 让锚点居中（长列表跟随焦点，通用状态选项面板用）、`tail` 让锚点贴窗口末行（问答选项窗口用）；`count ≤ windowRows` 不滚动（返回 0）。三处面板局部实现（问答选项窗口 / 状态选项面板 / 审批描述窗口）已统一到它。
- **问答面板两窗**：面板体（`height − 1`，标题占 1 行）拆为「描述窗」（题干 + detail）与「选项窗」（选项 + 自定义兜底项）。分配为**动态制**（BACKLOG 3.2.11 规则）：`descMaxRows = max(1, floor(maxBody × 2 / 3))` 为**描述窗上限**；描述窗可见行 = `min(描述内容行数, descMaxRows, maxBody)`——内容不足时只占实际行数（两窗紧邻、中间不留大段空白，空行只落在活动区下方）；选项窗 = `maxBody − 描述窗可见行`（不设上限，内容超出即滚动）——两段合计溢出时**由选项窗先滚动**，描述窗仅在自身超过 2/3 时才滚动。描述窗滚动上界恒按 `descMaxRows` 计算，滚动时不随内容抖动。
- **兜底项合并**（BACKLOG TUI#5）：选项文案命中语义标记（`自定义` / `其它` / `其他` / `例外` / `以上都不是` / `都不对`）的预设**并入「自定义回答」兜底项**——从预设列表摘除（不可标记、也无空回退选中），其原文（label；带 description 时 `label（description）`；多命中按 `、` 连接）作为自定义项的**解释行**展示（与预设选项解释同形态），须输入文字才算作答。**提问方约定**：兜底 / 例外类选项按上述文案书写即可获得「解释行 + 纯自定义作答」的呈现；需要被直接选中的语义不要使用这些标记词。
- **按键焦点窗**：`state.question.items[i].focus: "desc" | "options"`（缺省 `options`）；**Tab** 切换（`questionKeyDecision → { kind: "focus" }`）。焦点在选项窗时 ↑/↓ 移项（`question-move`）；焦点在描述窗时 ↑/↓ 逐行滚动（`question-desc-scroll`，上界由 `QuestionPrompt` 的 `maxDescScrollFor(item, height, width)` 按折行行数算出，App 随 action 传 `max` 再由 reducer clamp）。选项窗起点保证**焦点项**可见；焦点在描述窗时改锚定**首个已标记项**（标记不允许被滚出视野）。
- **焦点可见性与滚动条**（BACKLOG 3.2.8）：提示区以显式前缀标出当前焦点窗（`▶选项` / `▶题干`），后续按键项用紧凑分隔符 `·` 连接（七项全列在 80 列终端为 70 列，`·` 会撑到 82 列并截掉尾部的切题提示）。面板内描述窗**左侧 1 列**（题干 / detail / 计划卡片分隔行与折行续行同行同列，占原有缩进、不增宽、不改折行）按内容是否超屏分两态：
  - **内容超屏 → 滚动条**：轨道 `│`（border 灰）+ 滑块 `┃`；滑块长度 = `max(1, round(可见行² / 总行数))`，滑块位置 = `round(偏移 · (可见行 − 滑块长) / (总行数 − 可见行))`。聚焦描述窗时滑块黄、失焦时滑块灰（仍可见）——阅读位置与焦点指示合一，滚动后不丢失。
  - **内容不足 → 纯焦点指示**：聚焦描述窗时整列黄 `┃`，失焦时空格。
    聚焦描述窗时选项光标行同时**降色**（不再黄，已标记仍绿），全屏只有一处焦点黄；聚焦选项窗时由选项光标行的黄色 `>` 表示。审批面板无焦点切换，其草稿滚动条同理但滑块恒为黄色。
- **面板内边距**：面板可用宽 = `width − 2`（右侧留 1 列）；此前为 `width − 4`，内容行右侧留白偏多（人工验收反馈，3.2.8 修订）。
- **标题类型标识**（BACKLOG TUI#4；2026-09-27 真机目视改判）：**问答面板不显示标题行**——**单题**标题区 0 行（首行即题干，不显示「请回答」字样、类型符号与状态 △）；**多题**标题区 1 行，按题序列出全部题「题号 + 符号」（如 ` 1● 2□ 3△`；**题号与符号同色**——当前题均黄、其余均灰（BACKLOG TUI#15）；**当前题字形实心、其余空心**（BACKLOG TUI#1）；超宽截断补灰 `…`、恒占 1 行不折行），其下直接是题干。符号**非当前题为空心几何符号**——单选 `○` / 多选 `□` / 审批 `△`（`intent.kind === "plan-review"` 视同审批）；**当前题切实心** `●` / `■` / `▲`（与空心等宽 1 列，截断口径不变；BACKLOG TUI#1），按当前题着色；**题号导航已移除**。审批面板标题 ` △ 等待审批` 整行黄（类型符号与状态标记 △ 合一，旧 `[审批]` 移除）。
- **选项行形态**（BACKLOG 3.2.6 / 3.2.12，标记改 `✓` 见 TUI#4）：首行 `${光标}${标记} ${编号}. ${选项正文}`，例如 ` >✓ 1. 生产环境`——行首 1 列缩进、光标 / 标记在前、编号居中靠左（宽度按最大编号位数：1 位 / 2 位）；**内容起点 = numW + 6 列**（1 缩进 + 光标 + 标记 + 1 空格 + 编号 + `.` + 1 空格）；折行**续行**与 `description` 一律缩进到内容起点（**数字悬挂**：续行不重复编号、解释与选项正文左对齐）；`>` 与 `✓` 只出现在选项首行（标记不再区分单 / 多选；类型只由多题符号行表达）。审批面板选项同格式（标记位留空）。
- **面板内编辑光标**（3.2.7）：焦点在「自定义回答」兜底项且该行落在选项窗内时，`QuestionPrompt` 产出 caret（面板内 **0 基行 + 0 基列**）；`buildFrame` 把该行写成对应帧行的 `caret`（列 = 活动区正文起始列 + 面板内列），`frameFocus` 的 `inputFocus` 相应为 true（面板态不再一律隐藏光标）。
- **描述窗 markdown 渲染**（BACKLOG TUI#6）：问答描述窗（题干 + detail）与审批草稿走**历史区同口径**的 markdown 子集——行内样式 / 标题 / 列表（含任务列表）/ 引用 / `---` 分隔线 / fenced 代码块（fence 状态由面板自持）；**表格退回纯文本行**（列宽是构建期定死的跨行约束，而面板先折行再按窗口切片，会丢表头与行间横线）。实现：`layout/panel.ts` 的 `panelMarkdownRows(text, width)` 产出**样式段行**（不含行首 1 列 bar 列），面板行模型由「纯文本 + 整行色」升级为「样式段行」（`PanelLine.segments`）。提问前正文段（青色）与选项行仍为纯文本；审批草稿里「命令：」之后那一行**按代码块渲染**（灰底、内部不解析——命令显示失真会误导审批判断）。
- **审批描述窗**：`prompt` 折行后按 `state.approvalScroll` 滚动（不再硬截断），上界由 `ApprovalPrompt` 的 `maxApprovalScroll(approval, height, width)` 给出。
- **审批面板交互**（BACKLOG 3.2.4 / 3.2.5 / 3.2.6 / 3.3.1 / 3.3.2 / 3.3.3）：审批面板与问答面板同构——描述窗放草稿（`允许工具 X 执行?` + 「命令：」命令全文 + 「参数：」单行摘要；命令来自 `tool/call` 参数经 `callId` 关联，未关联到时退化为单行旧文案），选项窗放**固定两项**「批准 / 拒绝」（带编号）。描述窗上限同样为面板体 2/3，选项窗吃剩余。
  - **焦点窗（BACKLOG 3.3.4，与问答面板同构）**：`Tab` 在「描述窗（草稿）」与「选项窗（批准 / 拒绝）」间切换（打开时归选项窗）；`↑/↓` 语义随焦点窗——描述窗滚草稿、选项窗在两项间移动；描述窗聚焦时左侧 1 列着黄（可滚动时为滑块、内容不足时为整列焦点条），失焦转灰；选项光标行仅在选项窗聚焦时着黄（全屏只有一处焦点黄，沿用 3.2.8 口径）；提示区以 `▶草稿` / `▶选项` 前缀标出当前焦点窗。
  - **按键白名单**：`y` / `1` = 批准，`n` / `2` = 拒绝，`Enter` = 提交当前焦点项，`Tab` = 切焦点窗，`←/→` = 切选项（快捷），`↑/↓` = 见焦点窗语义，`Esc` = 取消审批（应答 `cancelled`，不打断 turn）；白名单外按键不落输入栏，改在**用户输入区**显示 `[无效键] …`（BACKLOG 3.3.8）——即屏幕左下、按键提示区**正上方**的那一行（问题交互态下输入区切换为临时消息显示区，不显示 `>`；提示优先占用该行、任意有效键即切回 notice 视图），**按键提示区始终显示常规按键**。
  - **倒计时**：拒绝项行尾显示剩余秒数 `(XXs)`（`deadline − now` 向上取整；无 deadline 不显示，过期显示 `(0s)`）。
  - **超时语义（BACKLOG 3.3.2 / 3.3.5）**：**完全无操作**到超时 → 裁定 `rejected`（默认拒绝）并发 `approval-closed`（`reason: "timeout"`）→ App 关闭面板并提示「审批已超时（按默认拒绝处理）」；**面板内按过任意键**（含无效键）后 → App 调 `adapter.stopApprovalTimeout(id)` 停止计时，此后不再自动裁定、倒计时隐藏（与问答面板「人在场就不催」一致）；手动 `Esc` 仍为 `cancelled`（与超时区分）；连接中断（abort）同样发 `approval-closed`（`reason: "abort"`）。超时值可配置（BACKLOG 3.3.7）：`tui.config.json` 的 `approval.timeoutMs`（最小 1000ms）> 宿主插件 config 的 `approvalTimeoutMs` > 缺省 **30000**。
- **提问上下文**（BACKLOG 3.2.10 / 3.2.12）：问答面板打开时，`recentQuestionSource` 取本回合**最近一块含正文**的全部 `assistant` / `plain` 行（整块取出，不设行数 / 扫描上限；本回合无正文则回退上一回合的最近一块，仍无为空串）作 `question.source`，渲染在描述窗**顶部**（回退来源段前加 `- 上文 -` 标记；青色、随描述窗滚动、与题干空一行分隔）；取不到时不占行。分块与回退口径见 §15.5。
- **数字键直标**（BACKLOG 3.2.6）：问答与审批面板的选项前带编号，数字键 `1-9` 直接标记对应项（单选置唯一 / 多选切换）**不提交**（提交仍为 `Enter`）；「自定义回答」项上数字键仍按文本输入；越界吞掉。

## 8. FocusFrame 覆写规格 [spec]

焦点框 = 全局覆写，无 `box.border`（机制与理由见 `TUI/docs/DESIGN.md` §8）。

```ts
FocusFrame(ctx: FrameContext, rects: Map<PaneId, Rect>, rows: FrameRow[]): void
// 纯函数，就地改写 rows（整帧一次扫描完毕）；不改变行数/行序
```

**扫描步骤**（对整帧逐行逐列）：

```text
对每一 row, 每一 col:
  判定该网格位置是否为“焦点分区边界”的候选：
    行列落在 rects[focusedPanel] 的 上/下/左/右 四条边的网格上 且
    该位置属于下表所列的线条/角字组合
  若候选 → 用 setCell(row, col, 期望角字/边线, 亮色 style) 覆写
```

**各焦点面板的亮边组合**：

| 焦点 | 亮边与角字 |
|---|---|
| history | 标题栏下划线行（兼作顶边）左端 `├`、右端 `┐`；历史区左缘 D 列 `│`；活动区分隔行左端 `├`、右端 `┘`；D 列分隔竖线仅历史区行 + 下划线行（横向排列时右缘改内部分隔列 `┬`/`┴`） |
| activity | 活动区分隔行左端 `├`、右端 `┐`；活动区左缘 D 列 `│`；状态区上行左端 `┴`、右端 `┘`；D 列分隔竖线仅分隔行 + 活动区行（横向排列时左缘改内部分隔列 `┬`/`┴`） |
| status | 自屏幕最左列/最顶行起 `┌─┐`（右端止于 D 列）；状态列左缘框列 `│`；状态区上行左段 `└─` 收 `┴`；D 列分隔竖线全行 |
| 无焦点 | 不覆写（全灰 / 空白占位，布局不重排） |

- **期望字符**：`─` 水平边、`│` 垂直边、`┌┐└┘┴` 角 / 交叉字。
- **防双画**：扫描顺序自上而下、自左而右，同一网格只写一次；**优先级 = FocusFrame 亮边 > 正常内容 > 空白占位**——覆写发生在所有行已由 fill 产出之后。
- **未聚焦（focusedPanel=null）**：不覆写——灰线 / 占位由正常内容机制（行端竖线 / `v.separator`）保持。
- **不变式**：覆写**不改行宽**（`setCell` 坐落在已有段上）、不切 CJK、不改变行数与顺序。

## 9. 排版管线 [spec]

```
state --buildBox--> Box 树 --measure/allocate--> rects --fill(ctx, rect)--> FrameRow[] --renderer--> 终端
        （每帧全量重建，与现状整帧重绘一致）
```

- 每帧从 state 派生 Box 树（纯函数），无增量、无文档状态
- `ctx: FrameContext = { state, size, metrics, focusedPanel … }`（`FrameContext` 定义见 §11.3）
- 对外仍 `buildFrame(state, size): FrameRow[]`，**renderer 契约零改动**
- **不变量**：摊平可复现——`flatten(state, size)` 是 `(state, size)` 的纯函数，同一输入必产出同一行序列（单测断言：同输入两次 flatten 逐行相等）；行级滚动偏移 = 该行序列的稳定索引

### 9.1 六步流水线（默认路径）

旧管线「每帧对物化窗内全部行重跑 buildBox → measure/allocate/fill」被**六步流水线 + 四级缓冲**取代（节 → box → pane → 行）：

```
宿主事件 --①接收--> 节缓存 --②结构--> box 序列 --③显示准备--> pane 缓存 ×2 --④出行--> 行缓冲 + 行数表 --⑤定位--> 可见行 --⑥装配--> FrameRow[]
   跟事件 ────────────────┤ 跟帧 ────────────────────────────┤ 吃宽度 ───────────────────┤ 拼接
```

- 分界：第 1/2 步之间 = 跟事件 | 跟帧；第 3/4 步之间 = 宽无关 | 吃宽度；主题只决定色值（渲染层）
- 缓冲与失效：节（无键）/ box（键 = 节身份）/ pane（键 = box + 档位 + 符号规则）/ 行（键 = box + 区域宽 + 档位 + 紧凑）
- 渐进窗口按**回合组**丢弃更早的节（分组复用 `turnGroupStarts` 口径）；段键 = 节身份 + 节内 box 序号（跨扩窗 / 改宽稳定）
- 滚动位置 = **段键 + 段内行**（`positionAt` / `indexOfTop`）：上方插入段（扩窗）画面不动、位移恒等于按键量；段键失效回落「距底偏移」
- 回合分隔线由 `turn-start` 交付驱动（时间未知 → 纯虚线）；`turn-start` / `step-summary` 等交付口径见 `layout/pipeline/types.ts`
- **内容真源 = 节缓存；`state.buffer` 不再承载会话内容**（条目 7 选项 1）：生产路径（App 注入 `pipelineSink`）下 `bufferRetainsContent: false`，`reduceState` 的内容类 action（正文 / 用户块 / 思考 / step / 工具行 / 分隔线 / 恢复行）只更新状态事实、不写缓冲；`buffer` 只留 **UI 本地行**（notice / shell / 辅助工具行），供底部 toast（`layout.ts` 的 notice 视图）与事件补投（`App.deliverBufferTail`：pass-through 事件写下的可见行 → 块交付）使用。读侧（`/copy`、`/council`、问答面板来源、画线判据）走 `sections.ts` 的 `lastTextOfSources` / `allSections`。
- **测试 / 嵌入用法仍可造缓冲**：`bufferRetainsContent` 缺省 `true`，`state.pipeline` 缺席时 `sectionsOf`（`layout/pipeline/frame.ts`）按 `buffer` 重放一份节（`replay.ts` 的 `sectionsFromBuffer`，按逐行对象身份 memo）——即 `buffer` 的定位是**测试与嵌入用的重放输入**，不再是生产渲染来源。「连测试路径也不经 buffer」见 `docs/BACKLOG.md` 条目（暂停中）。
- **本地 notice 的排版元数据随交付走**：`notice` 交付可带 `hanging`（折行续行停靠列）与 `noCompact`（紧凑模式豁免），经节条目 → box → 行透传到 `buildContentRows`（旧路径这两项长在缓冲行上，行不再是内容来源后必须随交付）。**UI 本地提示必须投块**：`/help` 是唯一不经 `App.notice()` 的本地提示，只写缓冲时生产路径什么都看不到（2026-10-10 真机验收缺陷，已补 `deliverLocal`）。
- 设计与分批见 `docs/archived/2026-10-09-layout-segment-cache.md`；第二阶段的迁移与退役记录同文件「第二阶段」一节

______________________________________________________________________

## 渲染契约（排版 ↔ 渲染）

## 11. 层间数据契约

### 11.1 排版输出（`FrameRow` / `FrameSegment` / `FrameStyle` / `ColorName`）

```ts
// 语义色名：排版层唯一颜色词汇；渲染层按当前主题解析为实际 hex + SGR。
// "code" 为行内代码/代码块背景语义（dark 深灰 / light 浅灰），由主题 semantics 解析。
export type ColorName =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "gray"
  | "border"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
  | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite"
  | "code"
  | (string & {}); // 逃生通道：任意名渲染层回退基底色（fail-safe），不用即弃

// 段级样式描述：语义色名（渲染层按当前主题解析为 hex + SGR）；
// 排版层唯一样式类型——FrameSegment / Box.NodeBase.style / prefix.style 共用；
// renderer 无独立行级样式
export interface FrameStyle {
  /** 原则上取 ColorName；"#hex" 逃生保留但新代码禁用（存量待清理） */
  fg?: ColorName | `#${string}`;
  bg?: ColorName | `#${string}`;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

// 行内一段：纯文本 + 段级样式
export interface FrameSegment {
  /** 纯文本，绝不含 ANSI/控制序列（不变量 #1） */
  text: string;
  style?: FrameStyle;
}

// 一行：排版输出最小单位
export interface FrameRow {
  /** 有序；相邻同 style 由渲染层序列化时自动合并 */
  segments: FrameSegment[];
  /** 硬件光标停留列（0 基显示列）；仅输入行与面板内编辑行（问答「自定义回答」编辑态）设置，
   *  列号由排版层算好（不变量 #3；面板行见 §7.1 / BACKLOG 3.2.7） */
  caret?: number;
}
```

### 11.2 渲染层公共 API

```ts
interface Renderer {
  render(rows: FrameRow[], sections?: FrameSection[]): void;  // 变化行游程重写（内部优化；sections = 帧段表，先按段收敛、段内按游程切分）
  refresh(rows: FrameRow[], sections?: FrameSection[]): void; // 强制全帧（Ctrl+L）
  onKey(cb: (k: KeyEvent) => void): void;
  emitKey(k: KeyEvent): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  getSize(): Size;
  setTheme(id: ThemeId): void;
  close(): void;
}
```

- `App.paint()` 为**标脏 + 同 tick 合帧**：同一 tick 内多次标脏只调用一次 `render(rows, sections)`；`flushPaint()` 同步冲刷、`paintNow()` 立即出帧（启动首帧与测试用）；`refresh()`（Ctrl+L）绕过区间 diff 立即整帧重绘。
- 渲染层不变量：增量帧只重写变化行游程——连续变化行各成一段、段间不取跨度（绝不 `ESC[2J` 清屏）；报文以 DEC 2026 同步输出（`ESC[?2026h/l`）包裹、渲染期隐藏光标（`ESC[?25l/h`）；仅首帧清屏一次，后续全帧走覆盖式重写。见 §15.9。

### 11.3 排版输入（已有契约，立字据）

- 输入 = `AppState`（只读）；`buildFrame(state, size): FrameRow[]` 保持**纯函数**：不改 state、无副作用、无 adapter/paint 调用（TUI/docs/design/REFACTOR.md 原则）。

- **排版几何（唯一来源）**：所有尺寸在 `frameGeometry(state, size): FrameGeometry` 内**一次算定**（`metricsFor` → `topPaneSplit` → 排队块行），`buildFrame`/`buildTopRegion`/`buildStatusSeparator` 与 App 的翻页/半屏/跳转全部读这一份——不再各处重算——两处各算一份会让「帧里看到的 pane 高」与「滚动 / 翻页用的 pane 高」口径漂移（表现为高度不一致）。

```ts
// buildFrame 内部：state --buildBox--> Box 树 --measure/allocate--> rects --fill(ctx, rect)--> FrameRow[]
interface FrameGeometry {
  cols: number; rows: number;              // 终端尺寸
  contentTopH: number;                     // 顶部内容行数（不含状态/输入/提示/分隔行）
  statusHeight: number; footerHeight: number; hintHeight: number;  // hintHeight 恒 1；footerHeight = max(1, 交互区 − hintHeight)；问题交互态（问答/审批）时 footer 显示最近 notice 尾行，其余面板空白占位
  statusColWidth: number; historyWidth: number; contentW: number;  // contentW = 区域正文宽（historyWidth − 右缘框列）；Ctrl+S 隐藏状态列时 statusColWidth = 0、historyWidth = cols、dividerCol = −1（该列不存在，分隔行不画交点）
  leftFrame: boolean; rightFrame: boolean;  // 屏幕最左（状态列外缘）/最右（区域外缘）焦点框保留格是否占列
  mode: "vertical" | "horizontal"; titleRows: number;
  activityH: number; dialogueH: number;    // 两 pane 可视行数（横向等高）
  activityW: number; dialogueW: number;    // 两 pane 正文宽（纵向同宽；含文字右缘留白列）
  dialogueTextW: number; activityTextW: number;  // 两 pane 文字排版宽（P3：只有右缘贴外框列的 pane 扣 1 列留白——横向历史 pane == dialogueW；边框按正文宽铺满）
  queuedRows: ContentRow[];                // 排队块（钉在对话 pane 右下角；空=无排队）
  viewportH: number;                       // 历史视口高 = dialogueH − queuedRows.length
  dividerCol: number;                      // 状态列右缘/历史区左缘（= statusColWidth − 1）
  contentStartCol: number;                 // 区域正文起始列（= dividerCol + 1，标题栏与两 pane 自该列起）
  innerDividerCol?: number;                // 横向排列内部分隔竖线列（历史右缘/活动左缘）
  activitySepRow: number;                  // 活动区分隔行（横向 = 对话 pane 底边下一行）
  modalOpen: boolean;                      // 模态面板是否打开（提示区恒 1 行，文案见 layout/hints.ts）
  statusLines: FrameRow[];                 // 状态栏行（避免二次计算）
}
```

- 尺寸入口只此一处：`inputPanelHeights` 等曾各自重算的入口均已并入 `frameGeometry(state, size)`，App 侧不再另算。

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

- **语义 → 色名（排版层）**：映射表为**排版层常量**——不入 `AppState`、不进 renderer。现有实例：`USER_BLOCK_SYMBOL` + `userBlockSymbolResolver`（用户输入块**首行左侧留白内**的状态符号：独占 2 列格，不参与正文换行（正文与续行同列）；success 绿 / failure 红 / aborted 灰；最新未终态块 running / waiting 黄；其余无终态块 `?` 不着色，排队块不出符号；**被 steer 续接过的输入**显示 `←`（默认前景，优先于终态与运行态、**永久**不恢复，见 BACKLOG #4）、标题栏图标语义色（`TITLE_ICON` 在 `titleBarSegments` 内取色：沙箱 ro 绿 / wr 黄 / full 红 / 其它灰，policy ask 黄 / never 绿，开关 on 绿 / off 灰，preset 默认前景）、notice tone（log 灰 / info 蓝 / warn 黄 / error 红 / success 绿）。markdown 语义同为此类（`**`→bold、`` ` ``→bg:code）：解析器在排版层，调"强调样式"只改排版层映射，state / renderer 均不动。
- **色名 → 色值（渲染层独占）**：`ColorName → hex → SGR`（`ansiNameToHex` / `hexSgr` 不得再被排版层 import，`theme.ts` 收口取色、`screen.ts` 的 `segStyle`/`serializeFrameRow` 收口序列化）。
- **排版层仅持有**：`ThemeId` + 语义 `ColorName`；state 保持与呈现无关（不存颜色）。
- 未知色名回退基底色（fail-safe，不抛异常，与现状 `ansiNameToHex` 返回 null 语义一致）。
- **调色板可配置**（tui.config.json `theme` 段，启动读取一次；`renderer/theme-config.ts` 解析）：优先 = 内联 `palettes.<id>` 字段 → `paletteDir/<file>.json`（上游单一源）→ 内置兜底快照（`theme.ts` 的 `THEMES`）。语义槽位 `gray/border/code/focus` 从各主题 `semantics` 数据解析（不再按主题名/ID 推断）；解析结果经 `createRenderer({ themes })` 注入 renderer，`setTheme(id)` 按注册表取调色板并 `prevRows = null` 全帧重绘。

______________________________________________________________________

## 13. 不变量（排版层义务，渲染层据此当纯字节通道）

| # | 不变量 | 承担方 |
|---|---|---|
| 1 | `text` 无 ANSI/控制序列 | 排版层 |
| 2 | 每行 segments 显示宽度合计 = 行宽 | 排版层 |
| 3 | `caret` 仅输入行与面板内编辑行（问答自定义回答编辑态，见 §7.1），列号按显示宽度算好 | 排版层 |
| 4 | 跨行段行内自洽：软换行时每行重新声明样式 | 排版层 |
| 5 | 渲染层不量宽、不布局、不理解内容 | 渲染层（身份） |

______________________________________________________________________

## 14. segStyle 精确规格（渲染层段级序列化）

**`segStyle` 精确规格**（渲染层 `screen.ts` 段级序列化）：

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

## 15. 排版与渲染实现要点 [impl]

> 本节承接原 `IMPLEMENTATION.md` 的渲染 / 排版类实现记录（2026-09-29 按「`IMPLEMENTATION.md` 拆分」项迁入）；
> 规则性内容以本文件前文 §2-§14 为准，本节记录实现口径、取舍与回归索引。

### 15.1 顶部状态列与标题栏（P1 / P2 / P7）

- **状态列**（`renderStatusColumn`）：自上而下 **Goal / Todo / Jobs / Agents 四块**（块间虚线 `╌`；Agents 块仅当前会话有子代理数据时出现），原 Mode 块整体删除——`modeBySession` 里的 plan / sandbox / permission 改由标题栏消费，`permission` 不再渲染。**Agents 块**（TUI#39）行 = `符号 名称 · 工作内容`（显示名 = 别名 ?? label；工作内容 = 最近一次工具调用摘要，无则省略），色义 运行中黄 `●` / 空闲灰 `○` / 一切异常态红 `!`（附宿主 reason），随 `StatusTicker` 5s 保鲜 + `subagent/start|end` 即时刷新；纯只读（中断走 `/agents` 面板）。
- **Goal 块当前行**：`Goal <phase 符号>` + 尾随 `⟳` 自动续轮开关（**只要收到过 activation 边就显示** `⟳`——armed 绿 / disarmed 灰，**不再按相位门控**（paused / blocked / complete 也显示灰）；**无记录 → 不显示**（宿主重启 / 回放 / 会话切换后不再推导为 `disarmed`，用户 2026-10-06 裁定）；历史行一律不带符号）。**当前行正文只显示 objective 首个逻辑行**（概括位：按列宽**完整折行**——行数由列宽与内容共同决定、**不截断**；「一句概括」的字数在起草侧由 goal-contract 限为 ≤40 显示列——2026-10-07 裁定；**全文入口 = 宿主 `/goal` 输出**，TUI 不提供展开键位）；**历史行 objective 仍全文折行**（口径不变）。**当前行 2026-10-05 起不再出相位词**（10 格默认列宽会把 `active` 截成 `ac`，信息量低于噪声；语义由符号 + 颜色承担）——**历史行仍带词**（它们按约定无符号，`Goal <phase>` 是其唯一相位线索）。**phase 符号与取色**：`▷` active 绿 / `∥` U+2225 paused 黄 / `△` U+25B3 blocked 黄（2026-10-02 由红改黄，与 `turn/end blocked` 及阻塞原因行同口径）/ `✓` complete 绿；**activation**：`⟳` U+27F3，armed 绿（宿主会自动续轮）/ disarmed 灰（需用户驱动）。数据源 = 进程本地事件 `goal/activation-changed`（`goalActivationBySession` 存末条边），展示值由 `goalActivationDisplay` 直取末条边（**有边就显示、无记录不显示**，不按相位门控、不做推导）；**会话切换清边**：宿主 `agents.resume` 走 `sessions.prepare` 重建 Session（进程本地 activation 归 disarmed 且同值早退不发边），故 `resumeTo` 成功时补一条清空边，防沿用切换前的 armed。`⟳` 属**呈现不确定**字符（2026-10-04 起「数学符号 A + 补充箭头 A」并入宽表的不确定符号块 `[0x27C0,0x27FF]`）：静态表按 1 列出帧，运行期经 CPR 实测后按实测列宽自校正（详见 §宽度表）。
- **状态列显隐（P7）**：`state.statusColumnVisible`（缺省显示）+ reducer `status-column{visible}`（`visible` 缺省取反，供 `Ctrl+S`）；`frameGeometry` 隐藏时 `statusColWidth = 0`、`historyWidth = cols`，`buildTopRegion` 不构建该列内容也不拼分隔段（分隔竖线随之消失）。显隐经 `adapter/session-ui-state.ts` 的 `statusColumn` 字段随会话写入 `tui-state.json`，`restoreSessionState` 回灌。
- **标题栏**（`titleBarSegments` / `TITLE_ICON`）：首行 = `[preset 图标 + 空格 + 预设名] 空格 [≤6 个状态图标（空格分隔，顺序：sandbox / policy / plan / verbose / symbol-unify / bell）] 2 空格 [标题]`；图标是 Nerd Font 私有区字形（`boxClosed U+F03D7`（`md-package_variant_closed`）/ `boxOpen U+F03D6`（`md-package_variant`）、`policyAsk U+F1739` / `policyNever U+F1414`、`plan U+EDA6`、`verbose U+F09AA`、`symbolUnify U+F04C6`、`bell U+F009F`、`preset U+F0A66`，命中与宽度实测各 1 列）。颜色即语义值：沙箱 ro 绿 / wr 黄 / full 红 / 其它灰（`MODE_SHORT` 归一，取值未知回落灰）、policy ask 黄 / never 绿、四个开关 on 绿 / off 灰、preset 段默认前景。**让位顺序**（`MIN_TITLE = 8` 列保底）：① 去掉 preset 段 → ② 截断标题 → ③ 去掉整组图标 → ④ 既有标题栏降级（收下划线 / 整栏省略，`titleRows` 在 `frameGeometry`）。**字体依赖**：非 Nerd Font 终端显示豆腐块（本机验证字体 Maple Mono NF CN）。
- **水平状态栏**（`renderStatusLine`）：`dotJoin` 给组内逻辑段插 `•`，`h` 的 `separator` 传 `{ char:"•", color:"plain" }` 做组间分隔；状态符号段（符号 + `│` lead 段）整体删除，首行行首回到 1 空格留边。因此 `statusBarSeamCols` 在状态栏行上取不到边框色竖线列——上/下横线不再画组间交点 `┬`，仅状态列右缘 D 列的 `┴` / `├` 保留（横向排列时内部分隔列的 `┬`/`┴` 属另一机制，不受影响）；`Ctrl+S` 隐藏状态列时 D 列不存在（几何 `dividerCol = −1`），该列交点一并不画（并排排列下该行只剩内部分隔列一个交点）。
- **回归**：`tests/title-bar.test.ts`（段结构 / permission 不显示 / 沙箱四态取色 / 开关 on-off / 让位顺序）+ `tests/status-column.test.ts`（三块基础渲染与折叠 / phase 符号与取色 / `⟳` 两态取色 / 历史行无符号）+ `tests/status-column-agents.test.ts`（Agents 块：有数据出块 / 行文本 / 无数据省略 / 折叠分级 / 按会话隔离 / 即时刷新与定时保鲜）+ `tests/goal-activation.test.ts`（activation reducer 与展示值口径：有边就显示、无记录不显示、四相位一致，含重启回归）+ `tests/status.test.ts` / `tests/tee-glyph.test.ts`（状态栏分隔与交点）。

### 15.2 历史区回滚：段键位置模型 + 渐进窗口

- **为什么**：旧的「距底部行数 + 全量物化」模型有三处弱点——底部新增 / 流式增长会改变同一偏移所指的内容；上方插入行（扩窗）会把视图整体推走；落点压在被裁剪行上时只能塌到窗口首行。改为**内容身份**表达位置后，这三种情况都不再需要补偿。
- **位置 = 段键 + 段内行**（`layout/pipeline/rows.ts`：`DialogueTop{key,row}` / `positionAt` / `indexOfTop`）：段键由节身份 + 节内 box 序号构成（边界项另发 `blank@<后项键>` / `sep@<回合>` / `step@<turn:step>`），跨扩窗与改宽稳定；段键失效（被窗口丢弃 / 会话切换 / `/cls`）时回落「距底偏移」`scrollOffset`。
- **渐进窗口**（`windowSections(sections, groups)` / `sectionGroupStarts`）：只物化尾部 `windowGroups` 个回合组（缺省 `DIALOGUE_KEEP_REPLIES = 3`），丢弃部分在会话区顶部画一行折叠占位（`MARKER_KEY = "@marker"`）；分组口径复用 `turnGroupStarts`，段身份与分组结果都不依赖宽度。
- **增窗 / 复位**：`App.scrollDialogueBy(delta)` 在施加位移**之前**按当前段表判断——上滚且视口顶进入窗口顶部半屏区间（或窗口内已无可滚行）→ `windowGroups += WINDOW_GROW_STEP(3)`（封顶总组数），随后按**扩窗后的段表**施加位移；扩窗只在视口上方插段、位置按段键表达 → 画面不动、**位移恒等于按键量**。下滚回到底部时复位默认组数（`scroll-to-bottom`）。
- **滚动粒度**：裸 `↑` / `↓` = 一行；`Ctrl+↑` / `Ctrl+↓` = 半屏（`dialogueHalfPage(vh) = max(1, floor(vh/2))`）——**对话区与活动区（Turn 面板）同款**（活动区半屏基准 = `frameGeometry().activityH`；2026-10-10 真机验收：此前 Ctrl+↑ 在 Turn 面板与裸 ↑ 同效）。`PgUp` / `PgDn` = 跳上 / 下一条用户输入（`userRowJump`，行号口径）；目标不在**已物化**窗口内时先 `window-grow` 再跳（与 `↑` 的扩窗同口径）——恢复出的历史只物化最近 N 组，不扩窗则按键在窗口顶无反应（2026-10-10 真机验收缺陷）；`Home` / `End` 语义见 BACKLOG 条目 6。
- **App 接线**：`FrameScrollReport` 回填段表口径字段（`dialogueTotal` / `dialogueCounts` / `dialogueKeys` / `dialogueTopIdx` / `dialogueViewportH` / `dialogueUserRows`）；`paneMaxes()` 同口径回填 / 补算；`syncDialoguePos()` 在出帧后把收敛后的位置写回 state（派生缓存，帧已按该位置渲染故不触发重绘）。**窗口起点不滑走**：用户停在历史里（`dialogueTop !== null`）而尾部新增了回合组时，按新增组数把 `windowGroups` 撑住。
- **阅读位置不被输出拽走**（「活动区输出大量文本后，历史区跟着一起向上滚动」的回归）：位置按段键表达 → 尾部追加 / 活动区增长都不改变视口顶所指的内容；缓冲头部裁剪（`trimBufferHead`）按上限裁剪（生产路径下缓冲只剩 UI 本地行，上限实际不再触达）。
- **会话切换**（`history-resume-ok` / `session-switch` / `/cls`）清掉位置回跟随底部，避免上一会话的位置跨会话残留。`/cls` 还要在 App 侧重置**接收层**（`createSections()` + 归零回合基线 / 画线判据）：`clearBuffer` 只换 `state.pipeline`，不重置 App 手里的节缓存 → 下一次交付会把清掉的内容带回来（2026-10-10 真机验收缺陷）。
- **回归**：`tests/scroll-position.test.ts`（段表 / 位置互算与越界 / 段键失效回落）+ `tests/buffer-trim.test.ts`（按上限裁剪）+ `tests/layout4.test.ts`（窗口 / 占位 / 报告口径 / 扩窗位移恒等于半屏）+ `tests/app.test.ts`（键位路径：裸 ↑ 一行、`Ctrl+↑` 半屏、撞窗口顶那次不多滚）。

### 15.3 排版尺寸唯一来源：FrameGeometry

- **问题**：`metricsFor` / `topPaneSplit` / `regionColumnWidth` / `renderStatusLine` 曾在 `buildFrame`、`buildTopRegion`、`inputPanelHeights`、`dialogueScrollMetrics` 各自算一遍（同一件事 4 份），口径漂移即出现「帧里看到的 pane 高度」与「滚动 / 翻页用的 pane 高度」不一致（横向排列下活动区内容仍按纵向高度排就是这类缺陷）。
- **做法**：`frameGeometry(state, size): FrameGeometry`（纯函数，`layout.ts`）把状态栏行、模态 / 提示区判定、`metricsFor`、`topPaneSplit`、排队块行、视口高、分隔列、内部分隔列、焦点框矩形基准一次算定并返回；`buildFrame` / `buildTopRegion` / `buildStatusSeparator` 与 App（`focusedLineScroll` / `focusedPageScroll` / `userInputJump` / 补全可视行）只读这一份（字段清单见 `SPEC.md` §11.3）。
- **语义保持**：面板开关不改变顶部内容行数——`footerHeight = max(1, interaction − hintRows)` 且 `hintRows` 恒 1（输入态与面板态同为「交互区 − 1 + 提示 1」，提示区恒占 1 行、空文案也占位）；**问题交互态（问答 / 审批打开）底部输入区改显最近 notice**（取活动区 buffer 的 `kind === "notice"` 行、折行后取末尾 `footerHeight` 行，tone 与 hanging 口径与活动区共用 `noticeLinePresentation`，见 BACKLOG 3.1.1），其余面板空白占位；`frameGeometry` 同时产出 `statusLines`，`buildFrame` 不再重复调 `renderStatusLine`。

### 15.4 文本留白与多行输入

#### 对话左右交错留白（`messageGutter`）

- **口径**：超长（英文）输入折行时，输入的最左侧与回复正文第 3 个字符同列。
- **文字右缘留白（`PANE_TEXT_MARGIN_COLS=1`，P3）**：留白只作用于**右缘贴着外框列**的文字——横向历史 pane **不留白**（用户块右缘 `┃` 紧贴内部分隔竖线）、横向活动 pane 与纵向两 pane 各让 1 列（`paneTextWidth(paneW, reserve)`：`frameGeometry.dialogueTextW/activityTextW`，`reserve` 只在右缘是外框列时为真；排队块、活动区面板同口径）。**所有横线一概不缩**：标题栏下划线、活动区分隔线、回合分隔线（`╌`，按 `ContentRow.kind === "separator"` 识别并补满）、状态栏上下边框都铺满到屏幕最右列（区域外缘框列在横线行补 `─`/`╌`）。**活动区行尾不补空格、也不画右边框**：`buildTopRegion` 对活动区行跳过 `padSegs` 与外缘框列字形；`FocusFrame` 的 activity 分支只画左缘竖线，顶/底亮线铺到最右列收尾（无角字）。回归：`tests/pane-text-margin.test.ts`。
- **列口径**：区域右缘框列是焦点框保留格（`FRAME_RIGHT_COLS=1`），正文区自区域正文起始列（状态列与分隔竖线之后，屏幕列 = `statusColWidth`）起算——回复行 `┃` 占正文区第 0 列、正文自第 1 列起；用户块整体右对齐，左缘留白 `gutter−1` 列（`spacer(fill, min)`）、块内右缘 `┃` 贴正文区最后一列。故输入正文起列 = 正文区起始列 + `gutter−1`（屏幕列），令其等于回复第 3 字符所在列（正文区第 3 列）解得 **`gutter = 4`**。
- **两侧同源**：`gutter` 同时是用户块左缘留白与回复右缘留白（`finalSpace` 的 `spacer(fixed gutter−1)`），故默认 4 时两侧文本上限对称各收 4 列（宽 60 时：正文区 39 列 → 回复正文 35 列、用户文本 35 列）。
- **连带**：竖线可见阈值 `USER_MIN_LEFT_GUTTER + 2` 由 6 上移到 8（w ≤ 7 不画竖线）——该常量是**窄列降级用的最小左缘留白**，与 `DEFAULT_MESSAGE_GUTTER` 各自独立（仍为 6，不随本条改动）；`DEFAULT_MESSAGE_GUTTER` 与 `normalizeTuiDisplayConfig` 缺省同步为 4。
- **回归**：`tests/layout4.test.ts`「输入最长折行左缘与回复正文第 3 个字符同列（gutter=4）」+ `tests/content-mapping.test.ts` 竖线阈值边界（w=6/7 关闭、w=8 开启）+ `tests/fixtures/focus-frame-legacy.json`（w20 四场景按新口径冻结）。

#### 多行用户输入 = 一块

- **口径**：一次输入（含 `Ctrl+J` 显式换行）视为**一个块**——块内行首左对齐（各行共享左边界）、块宽 = 该块折行后最长行宽、整块右对齐（右缘 `┃` 贴正文区最后一列，短行右侧补白）。
- **实现**：`appendStream` 对 `kind="user"` 不按 `\n` 拆行（整段 = 一条 buffer 行、一个 `seq`）；折行 / 补白交给渲染层——`fill.decorateRows` 按 `maxBodyW` 给每行右侧补白到块宽，故块内各行天然左对齐、`┃` 同列。配套：`queuedBlockRows`（排队消息同语义）；`surfaceToBuffer` 的 user 消息也不拆（恢复的历史输入同样一块）。
- **assistant 仍逐行拆**：正文流式逐行到达，且 fence 开合、尾部空行清理、回复组折叠都按 buffer 行粒度工作。
- **回归**：`tests/layout4.test.ts`「多行输入为一块」+ `tests/app.test.ts`（`user-line` 保留换行 / `append` 仍拆行 / `surfaceToBuffer` user 整段保留）。

#### 粘贴：bracketed paste + 裸 CR 降级（2026-10-10 关闭；追踪文档 `docs/archived/2026-10-10-paste-bracketed.md`）

- **启用协议**：renderer 启动写 `ESC[?2004h`、退出（`restore()` / `close()`，只写一次）写 `ESC[?2004l`；`rawMode: false`（测试 / 无 TTY）不写。终端此后把粘贴内容包在 `ESC[200~ … ESC[201~` 里，解码层 `stepPaste()` 产出**单个** `paste` 事件，App 的 `case "paste"` 整段插入输入框、光标停末尾、**不自动提交**（多行原样进输入框，`Enter` 才发送）。
- **载荷归一**：粘贴文本的行尾 `\r\n` / 裸 `\r` → `\n`（输入框行分隔符与 `Ctrl+J` 同源）。
- **降级**（不支持该协议的终端）：粘贴以裸字节到达时，按**单批 read** 判「像粘贴」——批内出现成对 CRLF 且不止这两个字节，或批内换行 ≥ 2 处 → 批内 CR 归一为换行（`\n` = 换行插入）；其余情况 CR 仍是 `enter`（单次 `Enter` 恒为独立一块，打字时相邻按键被内核合并成一块也安全）。判据不引入时钟，解码层保持纯逻辑。
- **回归**：`tests/input.test.ts`（载荷归一 / CRLF 多行 / CR-only 多行 / 单 Enter 不变）、`tests/renderer.test.ts`（启动与关闭写模式序列）、`tests/app.test.ts`（多行粘贴整段进输入框、未发送、光标末尾）。

### 15.5 活动区渲染（生命周期 / 详略 / 排列）

#### 活动区内容生命周期

- **不按组数折叠**：工具调用历史只受**活动 pane 可视行数**约束——内容先自下往上填满整块 pane（`activityH`，横向排列时 = 整列可用行数），更早内容折叠在 pane 顶边之外，Tab 聚焦活动区后 `↑` / `PgUp` 可回看（`activityMaxScroll = 活动内容行数 − activityH`）。
- **清空时机 = 用户输入**：`turn-begin` 带 `clearActivity` 参数——为 true 时整类清空活动区（thinking / tool / notice / 非 final assistant 一起清）并把 `activityScroll` 归零；`App.beginTurnIfNeeded(userInput)` 只在「用户输入开启的回合」传 true（空闲提交与排队消息被核心认领）；核心自发的回合（goal 轮次、定时唤醒等）只画分隔线、保留上一轮内容继续往上堆。
- **打字机不丢内容**：正文到达或延迟 `turn-end` 接管时，未放完的思考由 `drainThinking()` 整段放入缓冲；`dropThinking` 仅留给 `dispose`。
- **回归**：`tests/app.test.ts`「活动区生命周期：核心自发回合不清空」+ `tests/layout4.test.ts`「工具历史不按组数折叠，只受活动 pane 可视行数约束」。

#### 历史区正文分块（`final` 标记口径；#1）

- **分块边界 = `[step 变化 | 工具调用行]`**：按此把行切成块——step 分割线 / 回合分隔线同为硬边界，**thinking / notice / 空行不切割**；buffer 行由 `appendStream` 落 `step` 标（取自 `state.stepGroup.step`）以支持「step 变化」判定。
- **取「最近一块含正文」整块**：`markFinalSummary`（`turn-end`）把本回合最近一块含正文的**全部 assistant 行**标 `final`（不再只标「最后一段连续 assistant 行」——被思考行打断的前段不再被丢在活动区）；最近一块无正文（只剩宿主补发的 `"\n\n"` 空锚点）→ **回退取本回合更早的含正文块**（用户 2026-10-01 追加裁定：空块不吞正文）。
- **问答面板来源段同口径**：`recentQuestionSource` 取本回合最近一块含正文的 `assistant` / `plain` 行（整块、不再限 6 行、不再设扫描上限）；本回合取不到 → 回退取**上一回合**的最近一块（先回退、不加相关性闸门）；仍无 → 空串。面板显示时在该段前加 `- 上文 -` 标记（纯文本行、不经 markdown 解析）、与题干之间保留空行。
- **回归**：`tests/state-history-blocks.test.ts`（step 变化切 / 工具行切 / thinking-notice-空行不切 / 空锚点回退 / 跨回合回退 / 幂等）+ `tests/approval-panel.test.ts`（来源段整块与回退）。

#### 活动区类型间隔（#5；2026-10-02 收窄）

- **语义**：活动区内仅「**思考 ↔ 正文（非 final `assistant`）**」互切时插 **1 行空行**（双向：思考→正文、正文→思考）；同类连续只在边界插一次；活动区开头（无前一类）不插。
- **工具类不插**：工具行（step 头 / 调用行 / 结果行 / 辅助行）与任何类型相邻都不插空行——工具把思考与正文隔开时二者不再成对，故「思考 → 工具 → 正文」全程紧排（2026-10-02 用户裁定：只保留思考与正文之间的空行）。
- **step 分割线与内容紧排**：step 头属工具类，分割行原有的「吸收拖尾空行」照常生效（旧 #5 为保住类型间隔空行而设的 `gapBlank` 豁免判据随本口径删除）→ 分割行与前后内容之间不留视觉空行。
- **不算边界**：notice / shell / 已有空行既不引发间隔也不阻断判断。
- **正文分片连排（BACKLOG）**：只被 thinking / notice 行隔开的**相邻非 final 正文分片**合并为**一段**——文本**直接相接**（不插换行 / 空格），渲染顺序为「思考块 … → 整段正文」（合并叶取该 run 最后一个分片的位置）；两处切点的间隔空行**收敛为恰 1 行、置于该段正前方**。**直接相邻的正文分片不合并**（同一 delta 含 `\n` 时本就产相邻行：列表 / 代码块分片各成一行）；工具 / step / 用户行 / 分隔线 / `final` / 空正文行 / fence / 表格仍是硬边界（不穿透、不合并）。
- **实现**：`build-box.ts` 活动区叶子组装期的 `noteActKind()`（思考 / 正文 / 工具各一处调用；仅新类与旧类同属 `{思考, 正文}` 且不同时插间隔空行，空行取新类型行的 meta、`kind:"plain"`）。**正文合并**同层实现：`bodyRun` 记账（候选叶 + 自它以来的穿透行计数 + 本 run 插入的间隔空行按节点引用），命中「穿透行 ≥1 后再来普通正文分片」时**摘叶 → 文本相接 → 移到穿透行之后 → 间隔空行收敛 1 行置叶前**；正文**不缓冲**（未发生合并的路径与改动前逐字节相同），合并文本仍走 `actText(...,1)`（紧凑模式口径不变）。活动 pane 可视行数与滚动上限按**实际渲染行数**计（`activityMaxScroll`），间隔空行自动计入。
- **回归**：`tests/activity-type-gap.test.ts`（思考↔正文双向 / 同类连续 / 工具互切不插 / notice 与 step 不新增 / 开头不插 / **正文分片连排**：`正文→思考→正文` 并成一段、间隔空行恰 1 行、notice 穿透、工具与结构分片为硬边界、二次合并不丢空行）+ `tests/activity-verbose.test.ts`（紧凑模式行数 = 条目数）+ `tests/layout4.test.ts`（思考与下一个 step 分割行紧排）+ `tests/content-mapping.test.ts`（已偏离项：只多空行）。

#### 活动区详略两态（`/collapse`）

- **语义**：状态 1（`/collapse off`，缺省）每条目完整折行；状态 2（`/collapse on`）每条目压成 1 行 + 行尾 `…`，条目内换行折叠为空格。触发方式为**用户显式命令**（不做「按 fill 高度预算自动降级」——自动降级会让同一份内容在不同窗口高度下详略跳变，阅读位置不稳定）。
- **实现**：`state.activityCompact: boolean`（缺省 false；true = 紧凑）+ action `activity-compact{on}`；`buildTopRegion` 传 `activityCompact: state.activityCompact` → `BuildBoxOptions.activityCompact`，全部落在 `build-box.ts` 构建期（`compactActivityLine` 单行压缩：按显示宽截断时预留 1 列放 `…`，宽度 = 活动 pane 宽扣该条目前缀列数）。各分支：thinking、tool（调用 / 结果 / 辅助行，用压缩后文本再上色，工具名前缀保持）、notice（紧凑下不再设 `hanging`）、非 final assistant（紧凑下不建 markdown 表格，因其天然多行）。
- **与 pane 高度 / 滚动的关系**：紧凑只改条目行数，`activityH` 与 `activityScroll` 口径不变；行数变少后 `activityMaxScroll` 自动收敛。
- **回归**：`tests/activity-verbose.test.ts`（完整模式折行多行 / 紧凑每条目 1 行且 ≤ pane 宽 + 行尾 `…` / 换行折叠 / 短条目不加省略号 / 端到端 buildFrame 行数收敛）+ `tests/app.test.ts`（切换与无参 / 非法参数只提示用法不动状态）。

#### 活动区输出内容三档（`/verbose think|tool|step`；BACKLOG #8）

- **语义**：只作用于活动区（历史区不变），与「详略两态」**正交**、可叠加：`think`（缺省）= 思考 + 正文 + 工具调用（调用行 / 参数 / 结果 / 辅助行全显示）；`tool` = 正文 + 工具调用（**去思考行**）；`step` = 正文 + 工具调用的**第一行**（结果行 / 辅助行整条去掉，调用行只取**首个物理行**＝去参数续行；**step 头与 notice 保留**）。
- **实现**：`state.activityVerbose: ActivityLevel`（缺省 `"think"`）+ action `activity-verbose{level}`；`buildTopRegion` 传 `activityLevel` → `BuildBoxOptions.activityLevel`，过滤在 `build-box.ts` 构建期（thinking 分支跳过；tool 分支按 `isToolCall` / `isStepHeader` 取舍）。无参 / 非法参数只提示用法与当前档位、不切换；档位随会话状态快照持久化（键 `verbose`；旧布尔值按「详略」语义迁移到 `collapse`）。
- **回归**：`tests/activity-level.test.ts`（三档过滤矩阵 / step 取首行 / 命令切换与正交性）+ `tests/session-ui-state.test.ts`（快照迁移）+ `tests/app.test.ts`（ui-flags 回填与快照落盘）。

#### 活动区排列：黄金分割比自动选上下 / 左右

- **位置**：`layout.ts` 的 `topPaneSplit`（纯函数），唯一调用点是 `frameGeometry`（几何唯一来源）。
- **判定**：pane 宽高比与 φ≈1.618 的对数偏差（`|ln(w/h/φ)|`，取两 pane 较差者）小者胜；等分（divisor=2、纵向两 pane 等高）时等价于「区域正文宽 / 可用行数 > φ → 左右排列」。判据只吃区域正文宽 + 顶部内容高，不含状态列宽。
- **为什么不放在 state**：判定是尺寸的纯函数，启动与 resize 各自重算即可；不做滞回（阈值处反复拖动终端时最多一次翻转，且翻转点本身就是重排点）。缺省 `"vertical"` 保持既有上下语义（含 `activityTopRow` 锚定与 `activityHeightDivisor` 比例）。
- **两 pane 独立宽度**：横向时历史 pane 在左、活动 pane 在右；活动 pane 宽 = `floor(正文宽 / divisor)`，对话 pane 宽 = 正文宽 − 活动 pane 宽 − 1（两侧各保底 20 列 → 正文宽 < 41 或可用行 < 2 时回落上下）；**文字**排版另扣右缘留白（见「文字右缘留白」）。`BuildBoxOptions.activityWidth` 让 `buildContentRows(buffer, opts, w, aw)` 两 pane 各自 measure / fill；**不做两次 buildBox**（流式下 markdown / 表格构建会翻倍），只在构建期给活动 pane 的表格用 `activityWidth` 算预算。
- **拼行**：横向行 = 状态列 + D 列 `│` + 历史行（补空格到 `dialogueW`）+ 内部分隔 `│` + 活动行（补到 `activityW`）+ 区域右缘框列；活动区分隔行消失，标题栏下划线行在内部分隔列让位 `┬`，状态区分隔行该列收束 `┴`（`buildStatusSeparator` 以几何为入参）。活动 pane 恒底部对齐（与纵向一致），面板仍顶部对齐且按 `activityW` 排版。
- **滚动**：`scrollOffset` / `activityScroll` 语义不变（距各自 pane 底部行数），换行宽度 / 视口高变化——所有跳转 / 半屏 / 翻页坐标统一读 `frameGeometry`。
- **焦点框**：区域矩形左缘 = D 列（分隔竖线，与状态列共用 → 顶/底边用连接字 `├`/`┴`）、右缘 = 区域外缘框列（角字 `┐`/`┘`）；`FocusFrameContext.innerDividerCol` 非 undefined 即横向——history 右缘 / activity 左缘改为此列（顶边 `┬`、底边 `┴`），activity 右缘仍是区域外缘框列；rects 按左右并排构造。
- **回归**：`tests/layout-horizontal.test.ts`（8 例：内部分隔列与 `┬`/`┴`、两 pane 定宽、滚动口径一致、焦点框角字、独立宽度换行、活动区底部对齐、排队块钉在历史 pane 右下角）+ `tests/config.test.ts` 的 `topPaneSplit` 判定表。

### 15.6 表格与列表排版

#### /help 双列表格（无边框）

- **排版**（`app/layout/help.ts`）：`helpTableLines` 把命令目录排成两列——命令列定宽 = `min(最长命令显示宽, HELP_CMD_MAX=10)`（CJK 安全补白）、描述列固定起点；每行 = 行首 2 列缩进 + 命令 + 补白 + 2 列间距 + 描述。命令显示宽超 10（常见诱因：别名/参数示例合并写在一个命令里，如 `/provider、/effort (/thinking)`）不再撑宽整表——拆成两条独立行：命令独占一行、描述另起一行缩进到描述列起点（第二列），后续软折行续行同样停在描述列。描述列起点 = 2 + 上限(10) + 2 = 14 列。
- **折行**：不做预折行，交给渲染层——notice 的 `BufferLine` 可选 `hanging`（描述列起点的悬挂缩进），`build-box` 落到 `StyledText.hanging`，描述超 pane 宽时续行停靠描述列起点且 resize 后仍对齐。`BufferLine.hanging` 只在 `/help` 生效。
- **入口**：`App.helpLines()` 产出「表头 + 表中行 + 表尾」结构化行，`handleSlash` 走 `notice` action 的 `lines` 字段（`appendNoticeLines`，逐条独立成行）；表头 / 表尾无悬挂缩进。
- **回归**：`tests/help.test.ts`（命令列定宽 / 超宽命令拆行 / 全短命令回落 / CJK 补白 / 单物理行）+ 渲染层用例（窄 pane 强制折行时续行缩进 == 描述列起点；超宽命令描述另起一行的缩进 == 描述列起点）。

#### markdown 列表项悬挂缩进

- **行为**：`wrapAssistantLine` 的普通列表（`-` / `*` / `+` / `1.`）与任务列表（`- [x]` / `- [ ]`）长项折行时，续行行首补与列表前缀同宽的空格（无序 `• ` 2 列 / 有序数字前缀按实际列数 / 任务 `[x] ` 4 列），正文与首行文字同列对齐。
- **实现**：`layout/markdown.ts` 的 `wrapListRows(segs, prefixWidth, width)` 复用 `wrapFrameSegments` 的 `hanging` 续行折宽（扣 `prefixWidth` 封顶总宽），并在折行结果每个续行行首补 `prefixWidth` 宽空格段；首行保持前缀随正文全宽折行；前缀宽 ≤ 0 或无续行时原样透传。
- **对齐设计意图**：`SPEC.md` §2 的 `text(prefix:{"• "}, hanging:2)` 已声明列表悬挂缩进，与工具行 / `/help` 双列表格的悬挂机制同构。

#### markdown 表格

- **位置**：`src/app/layout/table.ts`（解析 + 构建期降级构建器）；识别与接线在 `layout/build-box.ts` 的 assistant 分支（索引循环以便逐行前瞻）。
- **为什么构建期算宽**：列宽是跨行约束（同列各行必须等宽），纯 `v`/`h` 表达不了跨兄弟约束；构建期把 2D 数学算完，产出「每格 `width:fixed`」的 `v([h([…])])` 子树，引擎保持两类节点。因此 `buildBox` 新增 `BuildBoxOptions.width`；**宽度未知时不识别表格**（按普通文本行渲染）。
- **识别**：`isTableStart`（表头须含未转义 `|` + 分隔行格全为 `:?-+:?` 且列数一致）做 O(1) 预筛，仅命中时才向前收集连续表格行（首个非 `|` 行停止）；`fence` 内不识别。数据行缺格补空、多格忽略。
- **单元格叶子用 `StyledText` 而非 `Paragraph`**：构建期就做行内解析，否则 `measureParagraph` 按原文（含 `**` 等标记）算行数，与 `fill` 的渲染文本口径不一致、会多出空行。行高由 `measure(leaf, {maxW: colW})` 用引擎同口径算得后显式声明 `height:fixed`，`fill` 的 `valign:"center"` 补白才生效。
- **网格：左缘竖线连续 + 1 空格间隔**：整表最左 1 列为 `┃`（`brightBlue`，与 assistant 正文左竖线同列同色）——竖线概念上属父级 box、内容整体在其右侧，故逐行重复（含折行续行与横线行），整条回复左缘竖线连续；竖线后固定 1 空格（表格 box 的 prefix），横线自该空格之后起、**不与左缘竖线连接**，左缘不设交叉字（用交叉字会把蓝色粗竖线替换成细线 / 双线，且 `╢` 向右无横线导致表头双横线左端断开）。数据行之间画单横线（首尾不画）以区分折行内容。
- **网格线不着色**：`│` / `═` / `─` / 交叉字一律用主题默认前景色，只有左缘竖线取 `brightBlue`；表头格加粗与格内行内样式照旧。横线行的横线须铺满整个列区域（列宽 + 左右留白），故不经 `gridRow` 的 pad 装配（否则每列多出 2 列、总宽超出预算导致折行错位）。
- **列宽求解**：自然宽按渲染文本计（CJK 2 列）；超预算用**水位法**（`waterLevel` 二分）——窄列保持自然宽、只有超宽列被压到共同水位线，避免按比例缩放把窄列压到 `minW` 以下；抬到 `minW` 后若超预算则退回纯水位线。`ΣminW` 仍放不下 → **返回 `null` 退回普通文本行**（#6：取消格内 `…` 截断，被截内容不再丢失）。数字列在分隔行未显式标注且表体非空格全为数字时自动右对齐。
- **窄终端回退**：可用宽 < 左缘竖线 + 1 空格 + 每列 1 列 + 固定开销 → `tableBox` 返回 `null`，调用方退回普通文本行。
- **元数据**：表格子树整棵挂同一 `rowMeta`（`markSubtree`）——`fill` 后各行 `kind` / `blockId` 必须与所在回复一致，否则回复组折叠（`windowSections` / `sectionGroupStarts` 按连续 assistant 行切组）与块内空行判定会把表格当成新块。
- **回归**：`tests/table.test.ts`（21 例：解析 / 转义 / 列宽 / 压缩 / 截断 / 对齐 / 加粗 / 网格与交叉字 / 左缘竖线连续 + 间隔空格 / 行高 / fence 保护 / 窄宽回退 / 元数据传播）。

### 15.7 字符宽度（EAW 精确表 + 按需实测 + profile 落盘）

- **静态表**（`layout/eaw-table.ts`，生成物）：`scripts/gen-width-table.mts` 生成——EAW（UAX #11）取自 `scripts/eaw-dump.py`（Python `unicodedata`），emoji 属性取自 Node `\p{Emoji}` / `\p{Emoji_Presentation}`（UTS #51）。四张扁平区间表（每两个数字一对 `[lo, hi]`，运行期二分）：
  - `EAW_WIDE_RANGES`：EAW ∈ {W, F} → 2 列（CJK/全角/多数 emoji）；
  - `EAW_AMBIGUOUS_CONSERVATIVE`：EAW = A 且落在几何/符号/CJK/emoji 保守区间 → 2 列（这些符号可能被 CJK 字体按全角设计，防低估撑破）；
  - `EMOJI_CONSERVATIVE`：EAW = N/A 但带 emoji 属性且 ≥ U+2190 → 2 列（多数终端按 emoji 呈现；排除箭头区与 ™/©/® 等 1 列字符）；
  - `WIDTH_UNCERTAIN_RANGES`：**呈现不确定区**（EAW = A ∪ 带 emoji 属性且 ≥ U+2190 ∪ 符号块 `0x2600-0x27BF` / `0x27C0-0x27FF` / `0x2B00-0x2BFF`，再减去 W/F）——不进宽度判定，只用于筛「可能判错、值得实测」的字符。
  - 重新生成：`TUI` 内 `npm run gen:width-table`，随后跑 `format` 对齐数组换行。
- **判定顺序**（`layout/markdown.ts` `computeCharWidth`）：实测覆盖 → 零宽 → 待实测登记（仅不确定字符）→ 文本符号例外（`NARROW_TEXT_SYMBOLS`）→ W/F → A(保守) → emoji 保守集 → 默认 1 列。
- **按需实测**（`App.probeThenRender` + `Renderer.probeSymbolWidths`）：呈现不确定字符的真实列数由终端/字体解析决定（1 或 2 列），静态表只能保守取值。排版遇到「不确定且无实测值」的字符即登记（`takePendingWidthProbes`；单批上限 64、去重、同一码点只发起一次）；**该帧写屏前**发起批量实测——每块写「字符 + `CSI 6n`」后按序读回 CPR 光标位置，列差即实测列宽，块大小按终端宽度切分（避免自动换行让列差作废）；实测值经 `setWidthOverrides` 写入覆盖表并清排版缓存，随后**重新排版 + 整帧重绘**出这一帧（探测字符画在屏幕原点，由该帧覆盖，不留残留）。整批无回包 → 判定终端不支持 CPR，本次会话不再实测（如实按静态宽度出帧）；`TUI_WIDTH_PROBE=0` 整体关闭（不载表、不登记、不探测）。
- **落盘复用**（`layout/width-table.ts`）：实测值写入 `<profile 目录>/tui-width-table.json`（目录取自 `ctx.get('profileContext').dir`；内容 `{version, term, widths:{<码点 hex>:1|2}}`，临时文件 + rename 原子替换、权限 0600）。启动时载入（`App.loadWidthTable`），已有实测值的字符不再探测；`term`（`TERM|TERM_PROGRAM|COLORTERM`）不匹配 → 整表作废重测（换终端/字体后旧值不可信）。无 profile 目录 / 读写失败 → 静默回落静态表。
- **修复背景**：旧实现把 `0x2B00-0x2BFF`、`0x2600-0x27BF` 等区间**整段**按 2 列，使 EAW=N（中性、无歧义 1 列）字符（如 U+2B24、U+2B00）在屏幕上多留一格；现按 EAW 精确判定，N 类归 1 列，emoji 保守集仍按 2 列防低估撑破。符号规则表里的 `➡`(U+27A1) / `⬅`(U+2B05)（静态判 2 列、多数终端实为 1 列）由按需实测纠正。
- **回归**：`tests/width-eaw.test.ts`（N/W/A/emoji 分层与优先级）、`tests/width-probe.test.ts`（CPR 解码不产按键、批量列差解析与分块、超时回退、跨行跳过、覆盖表失效、候选判定与登记、帧前实测时序、无 CPR 关闭、`TUI_WIDTH_PROBE=0`、启动载表）、`tests/width-table.test.ts`（落盘往返 / 终端标识作废 / 非法值与损坏文件回落）。

### 15.8 排版缓存与绘制合帧（性能）

排版成本集中在折行 / 宽度计算的逐字符工作（`wrapLine` / `displayWidth` / `wrapInlineMarkdown` 等，measure 与 fill 两阶段都调）。优化分两层，互不耦合：

- **折行 / 宽度有界缓存**（`layout/cache.ts` + `primitives.ts` / `markdown.ts`）：
  - 缓存目标：`wrapLine`、`truncateToWidth`、`displayWidth`、`parseInlineMarkdown`、`wrapInlineMarkdown`、`wrapAssistantLine`、`wrapCodeLine`，以及 `charWidth` 的码点宽度表（`Uint8Array`，0 = 未算）。
  - 键：文本 + 列宽（排版与主题无关：主题只在渲染层映射成颜色，不进缓存键）；命中值按**只读**使用（`fill.decorateRows` 已用 spread 复制）。
  - 有界：每表 FIFO 上限 `TEXT_CACHE_LIMIT`（2048），超限淘汰最旧插入项。
  - 开关：`TUI_LAYOUT_CACHE=0`（初始值）或运行期 `setLayoutCacheEnabled(false)`；`clearLayoutCaches()` 清空并重置码点宽度表。关缓存即回到优化前直算路径，用于等价断言与基准对比。
  - 零宽判定：326 条零宽区间表为模块级常量，`charWidth` 另带码点宽度表 memo（`Uint8Array`）——若区间表在函数体内每次调用重建并线性扫描，会成为逐字符宽度计算的主要常数因子。
- **App 层 tick 内合帧**（`app/index.ts`）：`paint()` 只标脏并排队一个 microtask，同一 tick 内多次标脏只调用一次 `renderer.render`；`flushPaint()` 同步冲刷、`paintNow()` 立即出帧（启动首帧、测试与需即时可见路径用）；绘制期间再次标脏会补画一帧并收敛；`dispose()` 清掉待处理帧。
  - **跨回合帧率上限**（真实接线默认 10Hz）：`AppDeps.frameIntervalMs`（`main.ts` 传 100；0 / 缺省 = 不限帧，测试与演示保持立即出帧）。`flushPaint()` 距上一帧不足该间隔时不清脏、改挂「窗口末」定时器，窗口内跨宏任务的标脏合并到该时点统一出一帧；`paintNow()` 抢占时取消窗口定时器；`dispose()` 一并清除。
  - 语义提醒：同一 tick 内的中间态不再逐帧写终端（这正是合帧的目的）；demo mock 的复合场景因此拆成两个 tick 发出，保证 `subagent` 行等中间态能被帧断言看到。
- **测试与基准**：`tests/layout-cache.test.ts` 断言 cache 冷 / 热与 off 逐项一致、固定动作序列整帧一致，以及合帧侧「同 tick 200 事件只画一帧」「flushPaint / paintNow」「绘制期间标脏收敛」「dispose 丢弃待处理帧」等；`tests/helpers/paintFlush.ts` 提供同步测试体读帧前的冲刷辅助（`TrackedApp` 构造即登记）。基准 `npm run bench`（`bench/layout-bench.mts`，手动运行不设阈值）对同一合成语料跑 cache off/on 三档（cold 每帧清缓存 / warm 同状态重复排版 / incremental 增量追尾），打印中位耗时与提速倍数。

### 15.9 增量渲染与防闪烁

渲染层五项防闪烁机制（业界对照：Bubble Tea 行级跳过 + 60fps 合帧、pi 的 `firstChanged..lastChanged` 区间重写 + DEC 2026、Textual dirty region、Codewhale 去 `2J` 修复、Claude Code #37283）：

- **变化行游程重写**（`renderer/index.ts` 的 `changedRuns` + `screen.renderRange/renderRanges`）：逐行比较新旧帧（按主题下序列化文本，`caret` 参与比较），把**连续变化行**各合成一段、段间独立绝对定位 + 逐行**先擦后写**重写（行首 `ESC[K` 擦整行，**不写行尾 `ESC[K`**：活动区行不补齐整行，行尾擦不掉新内容右侧的旧字——新回合清空活动区后「最顶上残留几行」即由此而来；且行尾 `ESC[K` 在光标停于右缘待折行时会擦掉整宽行的末字）；新帧更短时末尾以 `ESC[J` 清除下方残留。**只取「首末跨度」是不行的**：状态列（最左纵向窄列，贯穿整个顶部区域）与活动区（底部流式行）常在同一 tick 同时变化，取跨度会把中间大片未变化行一起擦除重写（实测 **18 行/tick** → 改游程后 **2~3 行/tick**，报文 3.1 KB → 0.7 KB）；无 DEC 2026 同步的终端上，逐行擦除+重写正是肉眼可见闪烁的来源。**增量帧绝不 `ESC[2J` 清屏**——这是符号闪烁/流式行内增长场景的主要修复点（旧实现只支持「帧尾纯追加」，其余一律全帧清屏）。
- **帧段（box）切分**（`app/layout.ts` 的 `frameSections` + `renderer` 的 `changedIntervals`）：由 `FrameGeometry` 纯推导行带表（top / status / footer / hint），`buildFrame` 经 `FrameBuildOutput` 回填、App 随帧传入；段表与上一帧一致时先把范围收敛到各段（多段同时变化只重写各段内变化行，不跨越中间未变化的段），段内再按变化行游程切成若干区间（不取跨度）；段表缺失/不一致（几何或行数变化）退化为整帧游程比较，保证不漏更新。
- **DEC 2026 同步输出**（`screen.ts`）：整帧与区间报文首尾包 `ESC[?2026h` / `ESC[?2026l`，支持的终端（kitty / iTerm2 / WezTerm / Ghostty / Windows Terminal / tmux 3.4+）原子呈现整块更新；不支持的终端按未知私有模式忽略。`reset()` 补发结束序列兜底。
- **覆盖式全帧**：仅**首帧**清屏一次（清终端既有内容），后续全帧（resize / 主题切换 / Ctrl+L）改为绝对定位原点 + 逐行覆盖重写（每行同样**先擦后写**）；帧下方残留以「定位到帧下一行行首 + `ESC[J`」清除（不在末行行尾就地 `ESC[J`——末行整宽时同样会吃掉末字），不再破坏性清屏。
- **渲染期光标隐藏**：报文开头 `ESC[?25l`、定位 caret 后 `ESC[?25h`，消除重写期间硬件光标跳动；`reset()` 兜底补发显示序列。

量化验收（临时脚本 `tmp/repro-flicker/` 三种，排查留档、非仓库产物，**已清理**）：

| 脚本 | 场景 | 结果 |
| --- | --- | --- |
| `verify.mjs` | 符号翻转 / 流式行内增长 / 纯追加 / 内容滚动 | 全帧清屏均 0 次（修复前 10/10/0/1 次，输出 22.7 KB → 约 3 KB） |
| `verify-real-frames.mjs` | 真实 24×80 布局帧：20 帧流式 + 符号交替 | 0 清屏、0 缺同步包裹/光标序列；纯符号帧 356 B |
| `diag-rows.mjs` | 单 tick **重写行数**（游程改造前后对照） | 流式+符号 2 行/帧；状态列+活动区同 tick 3 行（取跨度时 18 行）；只符号翻转 1 行 |

回归测试：`tests/renderer-diff.test.ts`（区间 diff 6 例 + 段切分 3 例 + 游程切分 2 例，含真实帧「状态列 + 活动区同 tick ≤ 4 行」）、`tests/screen.test.ts`（报文序列：同步包裹 / 仅首帧清屏 / 光标管理）、`tests/layout4.test.ts`（`frameSections` 覆盖性与行带一致性）。

#### 15.9.1 已评估未采用（附实测，勿重复讨论）

反闪烁改造完成后重新评估下面三项，**结论均为不做**。测量脚本 `tmp/measure-render-cost.mjs`（临时留档、非仓库产物，**已清理**；24×80 真实布局帧、300 帧流式 + 符号交替序列）：

| 指标 | 实测 |
| --- | --- |
| 单帧全量序列化（24 行） | 0.0128 ms |
| diff 比较（`sameRow` 每行 2 次序列化） | 0.0255 ms/帧 |
| 排版 `buildFrame` | 0.065 ms/帧 |
| 渲染（比较 + 序列化 + 报文组装） | 0.054 ms/帧 |
| 输出量 | 569 B/帧 |
| 10Hz 出帧 CPU 上界 | 1.20 ms/s（约 0.12% 单核） |

- **列级（单元格）局部重写（不做）**：状态列只占左侧 `statusColWidth` 列，理论上可只重写该列单元格（`ESC[r;cH` + 局部段）而不整行。但行级游程已把「状态列 + 活动区同 tick」压到 2~3 行/tick，收益只剩每行右半段（≈60 B/行）；代价是局部序列化必须自己处理宽字符跨界、样式收尾与右侧残留（`ESC[K` 不能用了），风险高于收益。
- **行序列化结果缓存（不做）**：收益上限即 0.0255 ms/帧（约总成本千分之五）；且 `buildFrame` 每帧新建 `FrameRow` 对象，按对象缓存（WeakMap）不会命中，须按内容做键，收益进一步缩水。
- **滚动区（DECSTBM）「只移动不重画」（不做）**：滚动场景写入量约 1.5 KB/帧、10Hz 下 15 KB/s，远低于终端处理能力；JS 侧已非瓶颈（上表），收益无从测量，却引入终端状态污染风险——Bubble Tea 的 `insertTop`/`insertBottom` 已标 deprecated，Codewhale 亦有「子进程泄漏 DECSTBM/DECOM 致视口整体下移」的修复记录。
- **重新评估的触发条件**：帧行数/宽度出现数量级增长（如 100+ 行帧 + 大量 CJK/emoji）致「比较」成本 > 10 ms/帧；或真机出现肉眼可见卡顿且定位到瓶颈为**终端写入量**（若瓶颈是终端自身重绘速度，程序侧优化无益，应排查终端 / tmux 配置）。
