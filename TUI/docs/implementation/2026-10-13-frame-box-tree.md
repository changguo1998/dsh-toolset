# 2026-10-13 拼帧层改为 Box 库统一装配（整窗一棵 Box 树）

- 层：TUI
- 接取条目（按标题引用）：〈拼帧层改为 Box 库统一装配（整窗一棵 Box 树）〉
- 开始：2026-10-13　状态：进行中（方案讨论阶段）

## 目标

把「分区层」从手写逐行拼段迁到 Box 库，让**整窗由一棵 Box 树描述**、尺寸由
`measure` → `allocate` 一次算定，取代：逐行拼段（`buildTopRegion` 约 425 行）+
区域矩形字面量 + `focusFrame` 的两遍覆写。

## 调研（现状盘点）

**已经树化的部分**（这轮不动）：内容层 `pipeline/boxes.ts` + `build-box.ts`（930 行）、
各面板 `panel.ts` / `fillPanelBox`、状态列 `buildStatusColumnBox`、模型面板、审批与问答面板。

**仍是手写的「分区层」**（本项目标）：

| 位置 | 规模 | 现在做什么 |
|------|------|-----------|
| `layout.ts` `buildTopRegion` | 929-1354（约 425 行） | 标题栏 + 两 pane + 状态列 + 分隔行逐行拼段（截断/补白/加边线手工） |
| `layout.ts` `titleBarSegments` | 713-789 | 标题栏段拼装 |
| `layout.ts` `renderStatusLine` + `buildStatusSeparator` + `statusBarSeamCols` | 1473-1606 / 1918-1997 / 1606-1671 | 状态栏三行（上下分隔行 + 内容行）与交点列 |
| `layout.ts` `buildFrame` 尾部 | 2109-2311 | footer / 提示区 / 状态栏 / 分隔行 concat + 四个区域矩形字面量喂 `focusFrame` |
| `layout/focus-frame.ts` | 257 行 | 焦点框两遍覆写（`setCell` 就地改字形）、`FrameFocus` 提取 |

**库侧模型（`layout/box.ts`）**：`NodeBase` 有 `width` / `height` / `align` / `valign` /
`prefix` / `suffix` / `tail` / `fillBg` / `wrap`，`Box` 有 `separator`（v = 行间横线、h = 列间竖线）
与 `id`（可寻址 Pane），**明确「无 border：边框归 FocusFrame」**（`box.ts:92`，DESIGN §8）。
`Width` / `Height` 已支持 `auto` / `fill` / `fixed` / `ratio`（状态列 1/3 就是 ratio）。

**帧的对外产物**（迁移不能丢）：`FrameRow[]`（含 `caret`）、`out.sections`（行带表，
`frameSections(geom)` 由几何推导）、`out.focus`（`frameFocus` 从帧内 caret 行取）。
渲染层用 `sections` 做变化区间重写、用 `focus` 决定光标收尾。

**尺寸的另一批消费者**：`frameGeometry(state, size)` 被 `index.ts` 7 处调用（PgUp/PgDn 页高、
活动区滚动上限、问答/审批描述窗滚动上限、`/jobs` 分页）与多个测试 —— 尺寸查询是**按键路径**上的
热调用，不能变成「每次量一遍整棵树」。

**回归网**：`tests/focus-frame.test.ts` 15 个场景逐行（text + ansi）对照冻结基线
`fixtures/focus-frame-legacy.json`（已有「已偏离」豁免机制）；`content-mapping.test.ts`
双轨（等价 / 已偏离）；`layout*.test.ts` / `app.test.ts` 大量帧断言；`npm run bench`
（`bench/layout-bench.mts`）测每帧排版成本。

## 决策（2026-10-13 与用户裁定）

> 约定：决策项用数字，选项用 abcd。
> 编号对照：对话里先问的三项（目标形态 / 验收口径 / `frameGeometry`）＝ 本表 1-3；
> 对话里说的「决策项 1-5」＝ 本表 4-8（4 网格落点、5 阶段 3 时机、6 帧段表、7 覆盖边界、8 提交粒度）。

01. **目标形态 = b（B 分阶段）**。a) A 一次到位（border 入树 + 删 `focusFrame`）/ b) B 分阶段
    （阶段 1 顶部区域 → 阶段 2 整窗根树 → 阶段 3 另议）/ c) D 先只做库侧 border / d) C 轻量收口。
    理由：A 把交点网格 + 焦点框 + 窄窗 + 横向排列全放一锅里，风险不可控。
02. **验收口径 = a（逐字节不变）**。a) 迁移期硬约束：帧断言不移不改，逐行 `text + ansi` 必须一致
    （确需偏离走既有单场景豁免）/ b) 允许审查后重冻基线。
03. **`frameGeometry` = a（保留为尺寸唯一源）**。a) 保留：树按同一批数字写 `width` / `height` 意图，
    `index.ts` 7 处按键路径调用与测试零改动 / b) 改成「量树得几何 + 按 (state,size) 缓存」。
    代价是尺寸有两个描述处，靠阶段 1 的验收网锁一致性。
04. **框线网格落点 = 阶段 1 用 b、阶段 3 用 d**。a) 库扩展「装饰按行取值」（resolver）/
    b) 网格基线 pass（不改库，新增 `layout/grid.ts`）/ c) 行角色入树 / d) 库加 `border` 节点（结构算交点）。
    理由：a 的收益（省一遍线性扫描）远小于代价（`measure` 要为 resolver 输出定宽度口径、节点树里放闭包、
    旧调用口径分叉）；d 才是能把网格 pass 与 `focusFrame` 一起干掉的东西。分区层难点不在内容（已树化），
    而在**逐行不同的框线字形**：D 列（内容行 `│` / 下划线行 `├` / 活动区分隔行 `├`）、右缘框列
    （边框行 `─` / 回合分隔行 `╌` / 活动区行**不落字形** / 其余空白）、左缘框列（空白占位）。
05. **阶段 3 时机 = a（预留）**。a) 本轮只承诺阶段 1+2，阶段 3 完成后再另开决策（**不预先接受重冻**）/
    b) 并进本轮连着做 / c) 不做、停在阶段 2 / d) 先只做库侧 border + 单测（提前退风险，但可能白花 1 天，
    且 API 是在看到阶段 1 的角色表之前设计的）。
06. **帧段表 = b（纯行范围，且不加语义）**。a) 维持现状（`frameGeometry` 推导 + 语义 `id`）/
    b) 退化为纯 `{ startLine, lineCount }` 行范围：**删掉 `FrameSectionId` 与 `FrameSection.id`**
    （渲染层本来只用它做「与上一帧段表一致」的校验，改比 startLine / lineCount 即可）/ c) b + 产出位置
    搬到树构建处。**变化行仍由渲染层 diff 得出**（`changedRuns`）——「排版时声明脏行」是另一套机制，
    需节点级变更判定 + 所有写入方（内容 / `grid.ts` / `focusFrame` / caret / 队列块）都记得标脏，
    漏一个就是静默残留像素；要做得另立条目（安全落地法：布局声明脏行 + 测试断言「声明 ⊇ diff」超集校验）。
    实施落在阶段 2（与段表产出一起改），阶段 1 不动。
07. **覆盖边界 = 确认全含**：横向排列（`activityPlacement: horizontal`）、窄窗（w20、窄到不留左右框格）、
    `Ctrl+S` 隐藏状态列、面板态 footer 空白 —— 都在既有帧断言里，阶段验收绕不过去。
08. **提交粒度与门槛 = 确认**：每阶段一个提交；`bench` 门槛 ±10%（超过查原因，不硬卡）。
09. **`buildTopRegion` 签名 = 改**（用户 2026-10-13 授权按默认走）：改成返回 `{ rows, roles }`
    （内部函数、无导出契约，测试不直接调它）。
10. **`grid.ts` 角色词汇 = 先 4 类、可扩展**：`border` / `rule` / `activity` / `body`，阶段 2 追加
    （状态栏 / 输入区 / 提示区）。
11. **「面板也用边框」= 不登记**：`Box.border` 若在阶段 3 落地，其复用价值那时再说，不预先立条目。

> 阶段 1 内部拆两步实施（不改决策，只为每步可独立逐字节验收）：
> **1a** 抽 `layout/grid.ts`（角色 → 字形）+ `buildTopRegion` 交出字形决策（行拼装结构不动）；
> **1b** 顶部区域的行拼装改成树（`h`/`v` + `fill`），补齐 / 截断口径靠验收网锁死。

## 规划（分阶段）

**阶段 1 —— 顶部区域树化 + 网格基线模块（约 1-1.2 天；决策 4 选 b）**

- 新增 `layout/grid.ts`（纯函数，约 60-80 行）：输入 = 几何 + **行角色表**，
  输出 = 每行「列 → 字形」的基线覆写表（D 列 / 左缘框格 / 右缘框列）；
  角色词汇：`border`（横线行：标题栏下划线、活动区分隔行）/ `rule`（回合分隔行）/
  `activity`（活动区行：不补白、不落右缘字形）/ `body`（普通内容行）。
- `layout.ts` `buildTopRegion`：把「五行拼装」（左缘框格 ‖ 状态列正文 ‖ 分隔竖线 ‖ 区域正文 ‖
  补齐 ‖ 右缘框列）改成**构内容树 + 产出角色表**；补齐 / 截断 / 各 pane 内容仍走既有树与
  ContentRow，行角色不再内联决定字形。
- `buildFrame`：`grid.apply(rows, roles, geom)` 写基线 → 再走既有 `focusFrame`（焦点色覆写不变）。
- 验收：`focus-frame` 15 场景 + `content-mapping` + `layout*` 逐字节不变；`npm run bench` ±10%；
  `frameGeometry` / `frameSections` / `frameFocus` 输出不变。

**阶段 2 —— 整窗根树 + 交点表达（约 1 天）**

- 状态栏（`renderStatusLine` / `buildStatusSeparator` / `statusBarSeamCols`）、上/下分隔行、输入区、
  提示区并入同一棵根树：`v([top, sep, status, sep, footer, hint])`，各行带 `height: {mode:"fixed"}`。
- 交点（`┬` / `┴` / `┼` / `└` / `┘`）进 `grid.ts` 的角色表（列位置仍来自 geometry）。
- `buildFrame` 退化为：geometry → 建树 → `fillBoxTree` → `grid.apply` → `focusFrame` → 回填。
- 验收同上（这一阶段动的场景最多）。
- **帧段表（决策 6 选 b）**：`frameSections(geom)` 继续由几何推导**行范围**，但**去掉语义** ——
  删 `FrameSectionId`（`renderer/screen.ts`）与 `FrameSection.id`，渲染层的一致性校验改比
  `startLine` / `lineCount` / 覆盖行数；`layout4.test.ts` 的段表用例随之改写（断言仍是「覆盖整帧、连续」）。
  变化行仍由渲染层 `changedRuns` diff 得出，不做布局声明脏行。

**阶段 3（决策 5 选 a：预留，完成后再裁）—— border 节点、删覆写（决策 4 选 d）**

- 新增 `Box.border`（含聚焦样式）：交点由嵌套结构算出来，替代 `grid.ts` 的基线 pass 与
  `focusFrame` 的边线覆写；`frameFocus` 的 caret 提取保留（与边框无关）。
- 此阶段大概率需要重冻若干冻结场景，届时另开决策；`grid.ts` 的角色表作为验收对照。

## 计划改动文件清单（阶段 1）

- `src/app/layout/grid.ts`（新增）：行角色表 → 网格基线字形（D 列 / 左缘 / 右缘），纯函数、无状态。
- `src/app/layout.ts`：`buildTopRegion` 改为「构内容树 + 产出角色表」，删手写五行拼装里的字形决策；
  `buildFrame` 在 `focusFrame` 之前调用 `grid` 基线。
- `tests/grid.test.ts`（新增）：角色 → 字形（含 `border` / `rule` / `activity` / `body` 四类）×
  窄窗（不留左右框格、`Ctrl+S` 隐藏状态列）+ 面板态空白 footer。
- 既有帧断言（`focus-frame` / `content-mapping` / `layout*` / `app`）：**不改**，作为阶段 1 的验收。
- `layout/box.ts` / `fill.ts` / `measure.ts`：**不动**（决策 4 选 b：网格基线不改库）；
  帧段表与其语义不在阶段 1（决策 6 选 b 排到阶段 2）。

## 实现记录

**阶段 1（已实现）**

- 新增 `src/app/layout/grid.ts`：行角色 `GridRole`（`border` / `rule` / `activity` / `body`）+
  `gridRole()`（判定优先级：横线行 > 活动区行 > 回合分隔行 > 普通行）+ `dividerGlyph()`
  （`├` / `│`）+ `rightEdgeGlyph()`（`─` / `╌` / `null` 不落字形 / `" "` 空白占位）。
- `src/app/layout.ts` `buildTopRegion`：删掉内联的 `divFor()` / `rightGlyph()` 字形决策，
  改为按行角色在行内取字形（D 列与右缘框列）；补齐 / 截断 / 内容来源不变。
- 新增 `tests/grid.test.ts`（3 例）：角色判定优先级、D 列字形、右缘框列字形（含「不落字形」）。

**阶段 2（已实现，范围按下方偏差调整）**

- `frameBands(geom)` 成为**行带 + 焦点矩形唯一来源**：`frameSections(geom)` 取其中的 `bands`；
  `buildFrame` 里原先 ~45 行矩形字面量（history / activity / status 三块 + 横向分支）删除，
  改为 `const { rects } = frameBands(geom)`。「段表算一遍行数、buildFrame 再写一遍矩形」
  的两处算术合一。
- **段表去语义（决策 6）**：`renderer/screen.ts` 删 `FrameSectionId` 与 `FrameSection.id`
  （`FrameSection` 只剩 `startLine` / `lineCount`）；`renderer/index.ts` 的段表一致性校验改比
  两字段（+ 覆盖行数）；`renderer/index.ts` 的类型再导出同步删除；`tests/layout4.test.ts`
  的段表用例改为按行带顺序断言行数。
- 变化行仍由渲染层 `changedRuns` diff 得出，未引入「布局声明脏行」。

## 偏差（未做，需后续裁定）

1. **未做「整窗一棵 Box 树」**。原因：Box 库的叶子是**文本 / 段**（`Paragraph` / `StyledText`），
   而帧的四区域内容是**行数组**（窗口化内容行 + 逐行补齐差异：活动区行不补白、回合分隔行补 `╌`、
   横线行铺 `─`）。把行数组塞进树只有两条路：① 新增「预渲染行」叶子类型；② 换行拼接后靠 fill 重排。
   两条都要动库或把补齐差异挤进内容，而 `measure` / `allocate` 在这里**没有任何尺寸收益**
   （尺寸唯一来源是 `frameGeometry`，决策 3 已定）：逐行叶子树 = 每帧约 40 个叶子，只把数组拼接
   换成树遍历，判定为「无收益 + 有逐字节漂移风险」。要做得先裁定是否给库加 `Rows` 叶子（或回退到
   「整窗一张波段表」的形态）。
2. **相交点字形不搬进 `grid.ts`**：`teeGlyph` 早已是 `content-rules.ts` 的唯一判定来源，
   另两处调用点（状态区上分隔行 / 状态栏下横线）的 up / down 列集合本就不同，搬动无收益。
3. **「事后整帧基线 pass」改为「行内取字形」**：先按计划实现了 `applyGridBaseline`（复用
   `focus-frame.ts` 的 `setCell` 逐格改写），bench 实测 cache off 档 0.47ms → 1.90ms（约 4×，
   一行两列共约 80 次 `setCell`），违反 ±10% 门槛 → 改为纯映射函数、行内取值，bench 回到基线。
   决策 9 的实现随之调整：`buildTopRegion` **不返回** roles（字形在行内取，角色不外部化）；
   角色词汇与判定仍集中在 `grid.ts` 并有单测。

## 测试与证据

- `node_modules/.bin/tsc -p tsconfig.json --noEmit`：干净；`npm run build`：干净。
- 全量测试：**1525 / 1525 通过**（含新增 `tests/grid.test.ts` 3 例；既有帧断言
  `focus-frame` / `content-mapping` / `layout*` / `app` **一行未改**，逐字节口径守住）。
- bench A/B（同机同轮，`npm run bench`，cache off / cache on 中位耗时）：
  - 本改动：0.52 / 0.47 / 0.45 / 0.43 ms（off），0.09 / 0.11 / 0.08 / 0.02 ms（on）
  - HEAD 基线：0.53 / 0.48 / 0.48 / 0.44 ms（off），0.09 / 0.10 / 0.08 / 0.02 ms（on）
  - 结论：全部落在 ±10% 内（最大偏差约 4%）；反例见偏差 3（事后 pass 版 off 档 1.90ms）。

## 收尾

（待填）
