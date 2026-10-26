# 排查表格排版修复（`61f63af`）后的副作用：额外空行与竖线断掉（接取条目：`TUI/docs/BACKLOG.md`「排查表格排版修复（`61f63af`）后的副作用：思考与正文出现额外空行、竖线断掉」）

状态：完成（决策只到方案；修法并入渲染流水线重构，未单独实现）　　开启：2026-10-24　　关闭：2026-10-26
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮范围只到**调研与决策**（实现待用户批准后另接），除本文件外任何文件都不改。

## 目标

排查并定位两处副作用的根因，给出修复方案与回归用例清单：

- 额外空行：思考内容与正文**有时**出现多余空行（疑似排版链重组 markdown 行时的空行残留，或缺列按左对齐补齐后的空行生成）。
- 竖线断掉：表格竖线在部分形态下断开（疑似表格栅格合并，或思考行紫竖线识别受牵连）。

前情见 `TUI/docs/archived/2026-10-22-table-content-mismatch.md`（修复 `61f63af`：分隔行按表头格数生成 + `isTableStart` 列数只许少不许多、缺列按左对齐补齐；顺带交付「思考行识别 markdown 表格」紫竖线）。

## 调研

### 1. `61f63af` 的改动面

`git show --stat 61f63af`：**4 个文件，+264 / −36**，只动排版与用例，未碰布局引擎（`measure.ts` / `fill.ts`）、未碰 `TUI/src/renderer/`。

| 文件 | 增删合计 | 改动函数 |
| --- | --- | --- |
| `TUI/src/app/layout/table.ts` | 95 | `isTableStart` / `parseTableAt` / `measureLeafRows` / `rowBox` / `ruleRow` / `tableBox`（新增 `TableBoxOptions`） |
| `TUI/src/app/layout/pipeline/rows.ts` | 34 | `tableLines`（分隔行生成口径） |
| `TUI/src/app/layout/build-box.ts` | 29 | `buildBox` 的思考行分支（新增表格识别） |
| `TUI/tests/table.test.ts` | 142 | 新增 5 例 + 改 1 例断言 |

六条语义变化点（本轮逐条核对 diff）：

1. `isTableStart`（`table.ts:150`）列数口径从「必须相等」放宽为「分隔行 ≤ 表头列数」（只许少、不许多）。→ 更多「4 列表头 + 2 列分隔行」之类的真机文本被识别成表格。
2. `parseTableAt`（`table.ts:167`）的 `aligns` 恒等于表头列数，缺列按 `left` 补（`table.ts:179-181`）；数字列自动右对齐跳过缺格（`table.ts:192-197`）。
3. `measureLeafRows`（`table.ts:319`）从 `ceil(显示宽 / 列宽)` 估算改为调用渲染同款 `wrapFrameSegments`，`rowBox` 据此写 `heightFixed`（`table.ts:392-402`）。→ 行高与折行同源（但见第 4 节「单元格内换行」，同源前仍多一次二次解析）。
4. `tableBox` 新增 `TableBoxOptions.barStyle`（`table.ts:375-379`、`table.ts:434-439`），左缘竖线可按来源换色（正文蓝 / 思考紫）。
5. `tableLines`（`rows.ts:416-442`）的分隔行改按**表头格数**生成（原先按 `aligns` 长度）；表头缺失时按首行格数；`ncols === 0` 时不再输出分隔行。
6. `build-box.ts:774-802` 新增「思考行识别 markdown 表格」：表头 + 分隔行成对时收集连续 thinking 表格行，构建期降级为固定宽 Box，左缘竖线用 `thinkingBar.style`（紫）。→ 思考行从「逐行 Paragraph」变成「一个表格 Box + 其余 Paragraph」。

### 2. 链路定位（file:line）

- **结构层（宽无关）**：`pipeline/boxes.ts:205` `textParts`（按行切正文 / 引用 / 列表 / 代码 / 表格）、`boxes.ts:295-308` 表格识别与 `parseTableAt`、`boxes.ts:338` `tableTree`（table → row → cell）。
- **表构建（宽相关）**：`table.ts:434` `tableBox`、`table.ts:382` `rowBox`、`table.ts:409` `ruleRow`、`table.ts:357` `gridRow`、`table.ts:319` `measureLeafRows`、`table.ts:291` `cellLeaf`、`table.ts:266` `fitCols`（水位法压缩）、`table.ts:150` `isTableStart`、`table.ts:167` `parseTableAt`。
- **行重组**：`pipeline/rows.ts:261` `boxToLines`、`rows.ts:395` `tableLines`（表格容器 → 旧口径原始表格行）、`rows.ts:469` `itemLines`、`rows.ts:534` `renderPane`（按 pane 项分次调 `buildContentRows`）。
- **空行收敛**：`pipeline/panes.ts:193` `blank`（相邻空行合并）、`panes.ts:206-245` `push`（`pairBlank` / `userBlank`）；`build-box.ts:424` `noteActKind`（思考 ↔ 正文插 1 行）、`build-box.ts:1216` `trimTrailingAssistantBlanks`（只收尾部）、`build-box.ts:1239` `lineUpBlockBars`、`build-box.ts:1285` `spaceUserAssistant`、`build-box.ts:1148` `absorbActivityBlank`；`pipeline/rows.ts:344-351`（`final` 早退，不剥前导 / 拖尾空行）、`rows.ts:380-391`（非 `final` 剥前导 / 拖尾空行）、`rows.ts:605-615`（整 pane 末尾空行不渲染）。
- **思考行识别（紫竖线）**：`build-box.ts:407-413` `thinkingBar` / `thinkAvail`、`build-box.ts:774-802`（表格分支，`tableBox(..., actPaneW, { barStyle: thinkingBar.style })`）、`build-box.ts:803-805`（普通思考行 Paragraph + `thinkingBar` 前缀）。
- **布局测量与摊平（补白落点）**：`measure.ts:413` `measureLeaf`、`measure.ts:502` `paragraphRowsNoSplit`（→ `primitives.ts:85` `wrapLine`，按**原文**计宽）、`fill.ts:356` `fillParagraph`（→ `markdown.ts:862` `wrapAssistantLine`，按**行内解析后**计宽）、`fill.ts:259` `decorateRows`（`fill.ts:326-342` 按 `rect.h` 补空白行）、`fill.ts:347` `hasHeightDecl`（把 measure 写入的 `height` 也当「显式高度」）。
- **`TUI/src/renderer/`**：不参与表格排版 —— 只提供 `FrameSegment` / `FrameStyle` 类型（`renderer/screen.ts`），按 `ContentRow[]` 逐格上屏；空行与竖线全部在上面的 `app/layout` 层定型（`61f63af` 也未改该目录）。

### 3. 「额外空行」的来源判断（逐条）

证据强度口径：**强** = 本轮本机复现且有控制组；**中** = 代码路径清楚 + 单点实测，真机形态未确认；**弱** = 仅代码推断。

| 候选 | 判断 | 强度 |
| --- | --- | --- |
| 缺列补齐生成的行 | 不产额外行。补齐的格是空串（占位宽 0），该列列宽由其它格决定（下限 `minColWidth`，`table.ts:65`），空串行高恒为 1；实测 4 列表头 + 2 列分隔行 + 缺格数据行，逐行 1:1，无空行。 | 强 |
| 分隔行重组 | 不产额外行（`rows.ts:421-442` 1:1 生成一行）。但它会把**短分隔行加长到表头格数**：建表失败回退成文本时，回退文本里的分隔行比作者原文长，折行点随之改变，间接放大下面的 `measure` / `fill` 口径差。 | 强 |
| 表格块前后空行规范化 | 不是「多一行」，而是**不对称**：`final` 正文走 `rows.ts:344-351` 早退（前导空行保留），尾部空行另由 `build-box.ts:1216` 吸收；表格前的空行因此被吃掉、表格后的空行保留（内容宽 80 实测：`┃段落一，正文。` 的下一行直接是表头，表格后的空行照常出 `┃`）。 | 强 |
| 思考行拆分 | 表格行消费计数正确（`build-box.ts:784-798`，`li += parsed.end - 1`，无重复 / 漏行）。两条伴生判断：(i) `bodyRun` 合并把表格前的正文叶搬到表后，只在**同一次** `buildContentRows` 调用内发生，而生产链路按 pane 项分次调用（`rows.ts:557-601`）且每项单来源 → 生产不可达，仅旧口径直调可达；(ii) 窄宽回退时表格行走 Paragraph 路径 → 进入下表。 | 强（生产不可达）/ 中 |
| **行高多算 → 补一行空行（本轮新增主因）** | `measure` 按原文计宽（`wrapLine`），`fill` 按行内解析后计宽（`wrapAssistantLine`）。标记（`**` / 反引号 / `\_`）被 measure 算进宽度 → 多算 1 行 → `decorateRows` 按 `measure` 写的 `height` 补一行空白（无竖线）。正文与思考两 pane 同一路径。 | 强 |

主因的另一条最小输入（不含表格的正文 / 思考行，本轮实测）：`` 这里用 **粗体** 强调，并且带 `行内代码` 与 **再一个粗体**。 ``，原文宽 59、行内解析后宽 49。期望 2 行；实测内容宽 30 时出「2 行正文 + 1 行全空白（无 `┃`）」，对话区与思考区同形，宽 31 / 34 起不复现 —— 与「有时」一致（取决于标记数与列宽卡在折行边界）。

### 4. 「竖线断掉」的来源判断（逐条）

| 候选 | 判断 | 强度 |
| --- | --- | --- |
| 栅格列宽合并（`fitCols` 水位法） | 不直接断线。列宽是构建期写死的固定宽，`fill` 到更窄宽度也不压缩（实测 40 宽构建、10 宽摊平仍等宽）→ 只可能横向溢出，不会挤掉竖线；但**列被压窄**是下一条的触发前提。 | 强 |
| 缺列补齐后列数不一致 | 不是断因。`tableLines` 按表头格数重生成分隔行（`rows.ts:421-442`），`parseTableAt` 按表头取列（`table.ts:176-181`），往返列数一致；实测 4 列表头 + 2 列分隔行在内容宽 30 时每行 3 个 `│`，在内容宽 20 回退成文本时分隔行也按 4 格生成。 | 强 |
| 单元格内换行 | **主因**：`measureLeafRows` 把已解析段落的纯文本**再解析一次**（`table.ts:324-333` 的 `parseInlineMarkdown(line)`）→ 代码跨度 / 反斜杠转义里的 `*` `_` 被二次当成强调，计宽变窄 → 行高低估 → 溢出行的 `┃` 与 `│` 全丢。控制组：`` `abcde` ``、`**abcd**` 正常，`` `__init__` ``、`` `a*b*c` ``、`a\*b\*c` 断线；把「再解析」去掉后计行从 1 变 2（= 真实折行数）。 | 强 |
| 紫竖线与普通竖线交界 | 未见断点。思考表左右缘都走同一个 `vLineLeaf` + `barStyle`（`table.ts:339-344`、`table.ts:396-403`、`table.ts:409-424`），与 `thinkingBar`（`build-box.ts:407-411`）同色同形；宽度上表 box 自带 `┃` 列、思考文本 prefix 也占 1 列，二者在 pane 内同列。实测内容宽 19 时表格各行（含 `═` 规则行）左缘全是 `brightMagenta`，紧接其后的思考文本前缀也是 `brightMagenta`；宽 26 / 50 同样连续。 | 中 |
| 表格不建表回退 | 回退成正文文本时「没有竖线」是形态本身（`table.ts:444` / `table.ts:453` 返回 `null` → 走 `build-box.ts:1030` 的 Paragraph），不是断点；但它与上面的空行 / 断线会在同一帧里叠加。 | 强 |

### 5. 最小可复现输入（按任务列出的四种形态）

复现方式：只读命令 `node --experimental-strip-types --input-type=module -e '…'`（不落盘），链路 `sectionsFromBuffer` → `buildPanes` → `renderPane`（`gutter: 4` = `DEFAULT_MESSAGE_GUTTER`，`TUI/src/app/state.ts:84`），底层用 `tableBox` + `fillBoxTree` 对照。**宽度均为内容宽**（对话区另扣 `gutter - 1 = 3` 作为表格预算；思考表按 `actPaneW` 计算）。

**F1 表头后空行** 来源：本轮实测（与 GFM 同口径，非缺陷）。

```markdown
| a | b |

| --- | --- |
| 1 | 2 |
```

- 期望：不成表（分隔行必须紧跟表头），原文按正文打印，空行保留。
- 现状（对话区内容宽 60）：与期望一致 —— 4 行全按正文打印（`┃| a | b |`、`┃`、`┃| --- | --- |`、`┃| 1 | 2 |`），不成表，也不产额外行。
- 判断：不是本症状来源。若真机上看到的「表格」少了分隔行，那属于「表不成表」，不是「多空行」。

**F2 缺列** 来源：本轮实测 + `61f63af` 自带用例（`table.test.ts:591`、`:613`）。

```markdown
| 阶段 | 现象 | 结论 | 备注 |
| --- | --- |
| 解析 | 切分 | 一致 | 无 |
| 短 | 行 |
```

- 期望：按表头 4 列成表、缺格补空、分隔行补齐到 4 格；无额外行。
- 现状（内容宽 80）：4 列成表，每行 3 个 `│`，第 2 个数据行后两格补空；无空行、无断线。
- 判断：不是本症状来源（容错与补齐按设计工作）。残余风险只有「回退文本里的分隔行被加长」（第 3 节「分隔行重组」）。

**F3 单元格内换行** 来源：本轮实测。

```markdown
| `**x**` | 长格说明 | 备注 |
| --- | --- | --- |
| 值 | 说明 | 注 |

后文。
```

- 期望：宽够时建成 3 列表格；宽不够时回退成 6 行文本（不含作者空行与后文）；两种形态都无空行、无缺竖线行。
- 现状（对话区内容宽 18，表格预算 15 → `tableBox` 返回 `null`）：回退成文本后，表头行折成 2 行之后、分隔行之前插入 1 行全空白（无 `┃`），再往下才是 `| --- | --- |`；作者写的表格后空行仍照常出 `┃` —— 同一帧里「多一行空行 + 断一截竖线」。
- 同类断线（同根因 H1，成表形态）：2 列表格（表头 `| AAAAA | B |`、分隔行 `| --- | --- |`、数据行 `` | `__init__` | 短 | ``、`| 值 | 二 |`）在对话区内容宽 17 直接成表时，`__init__` 实际折 2 行却只按 1 行分高度，第 2 行 `   t__        ` 无 `┃` / `│`；控制组 `` `abcde` `` 同宽两行都有竖线。
- 需真机确认：用户终端宽度是否落在「表格建不出来」的区间，以及单元格里是否有反引号代码含成对 `*` / `_`（或转义 `\*`）。

**F4 思考行含表格** 来源：本轮实测。

```markdown
| 阶段 | 现象 | 结论 |
| --- | --- | --- |
| `__init__` | 切分 | 一致 |
```

（同一组行作为 `kind: "thinking"` 进活动区。）

- 期望：成 3 列表格、左缘 `brightMagenta`；`__init__` 折 3 行时三行都带竖线。
- 现状（活动区内容宽 19，首列宽 3）：表格建成、左缘与 `═` 规则行都是 `brightMagenta`，但末行 `   __              ` 无竖线（H1）；内容宽 22 同样复现。
- 补充：同一 pane 的**纯文本**思考行（含 `**粗体**` 与 `` `行内代码` ``）在内容宽 30 会多 1 行空白（H2），31 起不复现 —— 症状在「含表格」与「不含表格」两侧都会出现。
- 需真机确认：思考区是否真的出现表格（取决于模型输出形态）。

**本轮排除的形态**：缺列补齐逐行 1:1、无空行；`bodyRun` 合并搬叶只在直调路径可见；紫 / 蓝竖线交界无断点；`fitCols` 压缩不挤掉竖线。

### 6. 既有用例与断言

- `TUI/tests/table.test.ts`（26 例）：`61f63af` 新增 5 例、改 1 例——改的是 `isTableStart` 容错断言（`:84`）；新增 `parseTableAt` 缺列左对齐（`:102`）、行高与折行同源（`:549`）、思考行表格紫竖线（`:568`）、4 列 + 2 列分隔行集成（`:591`）、往返不丢列（`:613`）。**F3 / F4 的断线形态没有用例**（`:549` 用的是纯中文格，不触发二次解析）；**额外空行的两种形态（第 3 节主因）没有用例**。
- `TUI/tests/pipeline-frame.test.ts`：语料每回合末步带表格（`:37` 起）；`:400` 断言回合区边界空行序列 `["<step>", "┃（先想）", "", "┃中间正文"]` —— `measure` / `fill` 同源改动若落到「空白行是否产出」，这条会直接受影响。
- `TUI/tests/pipeline-equivalence.test.ts`：语料含表格（`:68`）；`:278-283` 断言行数表之和 = 实产行数；`:287` 断言表格 / 代码块 / 工具批的还原形态。
- `TUI/tests/pipeline-boxes.test.ts:101`、`TUI/tests/pipeline-panes.test.ts:148`：断言结构层仍是 `table` 容器（改行高不动结构，不受影响）。
- `TUI/tests/layout-cache.test.ts:70`：语料含 `| 表格 | 不支持 |`（单行，不成表）。
- **焦点帧基线**：`tests/fixtures/focus-frame-legacy.json` 与 `tests/fixtures/content-mapping-legacy.json` 里没有表格（`grep '═' tests/` 只命中 `table.test.ts`）→ 基线不会因表格行变化而重冻；受影响的是行数 / 空行类断言（`pipeline-frame`、`pipeline-equivalence`）与 `npm run demo -- --smoke` 的帧断言。

### 7. 证据口径与局限

- 本轮全部为只读操作：`git show` / 源码阅读 / `node … -e` 内联脚本；未跑 `build` / `test` / `format`，未改任何源码或用例。
- 「思考区」的实测走的是 `sectionsFromBuffer(…, { history: true })` 重放路径（思考内容留在未定型的当前节，`allSections` 可见）；实时线（`ingestDelivery`）的节划分不同，但 `renderPane` → `buildContentRows` 这一段完全相同，故结论对两条线一致。
- 未拿到用户真机文本与截图，无法确认用户看到的是 F3 / F4 中的哪一类（或只是 F1 / F2 式的「表不成表」）；见决策项 6。

## 决策

### 根因假设排序（按可能性）

1. **H1 = `measureLeafRows` 的二次解析**（`table.ts:324-333`）→ 行高低估 → 溢出行的 `┃` / `│` 丢失。对应「竖线断掉」；表格特有，`61f63af` 引入（它与「同源」修法同批落地，但自己又解析了一次）。
2. **H2 = `measure` / `fill` 折行口径分叉**（`measure.ts:502` → `primitives.ts:85` 原文计宽 vs `fill.ts:384-391` → `markdown.ts:862` 行内解析计宽）+ `decorateRows` 按 `measure` 高度补白（`fill.ts:326-342`、`fill.ts:347-352`）→ 末尾 / 中段多一行空白。对应「额外空行」；**先于 `61f63af` 存在**（该提交没碰 `measure.ts` / `fill.ts`），但表格回退文本（F3）与含标记的正文 / 思考行（第 3 节那条最小输入）让它高发。
3. **H3 = 表格块前后空行不对称**（`rows.ts:344-351` vs `rows.ts:380-391`）→ 只改空行位置，不增行数。次要。
4. **H4 = `bodyRun` 合并搬叶**（`build-box.ts:1001-1028`）→ 生产链路按 pane 项分次调用、每项单来源，不可达；只有旧口径直调（测试 / 嵌入）能看到「正文被搬到表后」。记录，不修。

### 验证步骤（实现阶段照此走）

1. 先用 `renderPane`（对话区 / 活动区各一）在第 5 节的宽度上把 F3 / F4 写成失败用例；F1 / F2 写成口径用例（钉住「表不成表」与「缺列补齐」的现状）。
2. 修 H1 后重跑 F3 / F4：断言每个数据行以 `┃` 起、`│` 个数 = 列数 − 1、各行等宽；控制组（`` `abcde` `` / `**abcd**`）保持通过。
3. 修 H2 后重跑第 3 节那条最小输入与 F3：断言行数与 `wrapAssistantLine` 的结果一致、无全空白行；再跑 `measure.ts` 相关用例与 `fill.test.ts` 的 valign 补白用例（显式高度仍须补白）。
4. `npm run check` + `npm run test:tui` + `npm run demo -- --smoke`；对 `pipeline-frame` / `pipeline-equivalence` 的行数断言逐条人工确认（不重冻基线）。
5. 按项目流程交人工确认（demo 或真机）后才提交。

### 决策项 1：修复范围

- a. 只修 H1（表格行高）。
- b. H1 + H2（表格行高 + 折行口径）。
- c. H1 + H2 + H3（再改前后空行对称）。
- d. 全部（含 H4 合并搬叶）。

**选定 b**。理由：H1 与 H2 各有一条可复现实证，分别对应「断线」与「空行」两个症状；H3 不产额外行、改动会动所有 `final` 正文的块首空行口径，H4 生产不可达 —— 都不进本轮。

### 决策项 2：H2 的修法

- a. 抽一个共享折行入口，`fillParagraph` 与 `measureLeaf` 用同一套分支（`wrap` / `fillBg` / `balance` / 平衡折行）判行数。
- b. 只给 `build-box` 产出的正文 / 思考 Paragraph 加标记，`measure` 对带标记的节点改调 `wrapAssistantLine`。
- c. 不改 `measure`，改 `decorateRows`：自动高节点不再按 `rect.h` 补白（`hasHeightDecl` 只认 `heightStyle` / `heightFixed`）。
- d. 不改，记入 SPEC 已知限制。

**选定 a**。理由：口径只能有一条；b 会留下「带标记 / 不带标记」两条口径，c 只是把症状藏掉（行数与 measure 记账仍不一致），d 与「额外空行是缺陷」的判断冲突。代价是影响面最大，故要求先按验证步骤 1 钉用例、再按 4 逐条人工确认基线。

### 决策项 3：推进方式

- a. 先补失败用例复现，再按用例修（测试先行）。
- b. 直接改代码，用例后补。
- c. 只改最小（H1），H2 另立条目。
- d. 只记录结论，等真机材料。

**选定 a**。理由：症状「有时」、触发面是「列宽 × 行内标记」的组合，先钉用例能把触发条件固定下来，也避免盲改 `measure.ts` 影响 1700+ 例；H1 可在第一批用例里一起修。

### 决策项 4：H3（表格前后空行不对称）处置

- a. 本轮一并改（`final` 与非 `final` 同口径剥前后空行）。
- b. 本轮只记 SPEC，另立条目。
- c. 口径改为「表格前后各留 1 行空行」。
- d. 口径改为「表格前后各 0 行空行」。

**选定 b**。理由：不产「额外空行」，改动会动所有 `final` 正文块首 / 块尾空行（影响全局观感且与本症状只部分相关）；先修 H1 / H2，看效果再决定要不要统一。

### 决策项 5：H4（`bodyRun` 合并搬叶）处置

- a. 本轮不动，只在 SPEC 记「生产按项分次调用，混合来源行不会同批」。
- b. 本轮顺手改成「不搬叶」（原叶内拼接）。
- c. 另立条目，专测旧口径直调路径。
- d. 一并改并补断言。

**选定 a**。理由：生产链路不可达；改它会动活动区「正文被 thinking / notice 隔开」的既有合并语义，风险与本症状无关。

### 决策项 6：是否需要用户提供真机文本 / 截图

- a. 阻塞：先要到材料再动手。
- b. 不需要：按本轮复现直接修。
- c. 先按本轮用例推进，材料到后再补用例 / 另立条目。

**选定 c**。理由：H1 / H2 已在本机复现、不依赖真机；但「有时」的具体触发宽度与单元格形态只有真机能核对，材料到后按需补例。

### 计划改动文件清单（草案，实现阶段定稿）

- `TUI/src/app/layout/table.ts`：`measureLeafRows` 改用段落自身 `segments` 计行（去掉 `table.ts:331` 的二次 `parseInlineMarkdown`）。
- `TUI/src/app/layout/measure.ts`：`measureLeaf` 的段落行数改调共享折行入口（决策项 2 选 a）。
- `TUI/src/app/layout/fill.ts`（+ 视抽取位置可能落在 `TUI/src/app/layout/markdown.ts`）：把 `fillParagraph` 的折行选择抽成共享函数（`wrap` / `fillBg` / `balance` 分支同源）。
- `TUI/tests/table.test.ts`：F3 / F4 回归 + 控制组 + F3 回退无空行。
- `TUI/tests/fill.test.ts` 或 `TUI/tests/content-mapping.test.ts`：正文 / 思考段落（第 3 节那条最小输入）无末尾空行。
- `TUI/docs/SPEC.md`：§3.2（表格行高与折行同源）、§2（valign / 隐式高度）补口径；H3 / H4 记现状。
- 关闭时：`TUI/docs/BACKLOG.md` 条目移除（主会话持有，不在本任务直接改）。

明确不改：`isTableStart` / `parseTableAt` 的容错口径（保留 `61f63af` 语义）；`rows.ts` 的 `final` 空行策略（决策项 4 选 b）；`pipeline/panes.ts` 的空行插入规则。

### 要补的测试用例

1. H1 回归：2 列表格 + 单元格 `` `__init__` ``，预算 14 → 数据行逐行以 `┃` 起、`│` 个数 = 1、等宽；同一形态在 `` `a*b*c` `` / `a\*b\*c` 各一例。
2. H1 控制组：同形状换 `` `abcde` `` / `**abcd**` → 不出现无竖线行（防回归成估算）。
3. H1 思考区：三列表格 + `` `__init__` ``，活动区宽 19 / 22 → 断点不出现，左缘仍为 `brightMagenta`。
4. H2 正文：内容宽 30 的第 3 节最小输入 → 行数 = 2、无全空白行；内容宽 31 同样 2 行。
5. H2 思考：同一文本作 `kind: "thinking"`、活动区宽 30 → 同上。
6. H2 表格回退：F3 在内容宽 18 → 回退文本 6 行（不含作者空行与后文）、无全空白行；同时钉住回退文本里分隔行按表头格数生成（4 格）。
7. 结构 / 行数：`pipeline-equivalence` 的行数表一致性 + `pipeline-frame` 的空行序列断言在改动后重跑（不重冻，逐条确认）。
8. （H3）口径记录用例：第 3 节表格前后空行的现状（前空行丢、后空行留）以断言形式钉住现行口径，避免后续无意改动。

## 流程梳理（2026-10-24 追加，用户要求记录）

用户 2026-10-24 裁定：根因属**流水线流程设计**，不是单点修法，方向是重构流水线；本段只记录分析，不接取实现。

### 全链路（六段）

1. **接收**：adapter 交付 → `App.ingestDelivery`（`app/index.ts:597`：符号归一、丢弃「整段纯空白且来源切换」的分片）→ `applyDelivery`（`pipeline/sections.ts:602` 起按 kind 分派）→ `reduceState({type:"pipeline-state"})` → `state.pipeline`（唯一内容源）。
2. **选窗口**：`pipelineContent`（`pipeline/frame.ts:177`）→ `windowSections`（`:120`）按回合组保留最近 N 组并记 `dropped`；段键 `sectionIdentities(all)` 按全量节算。
3. **结构与 pane（宽无关）**：`buildBoxes`（`pipeline/boxes.ts`：text / quote / list / code / table / cell / tool；列表与引用按连续 run 合成**单个** box，`text = lines.join("\n")`）→ `applyShadowed` → `push`（`panes.ts:206`：归属、空行合并、分类切换插行、`step-head`、`turn-separator`、`step-summary`）→ `PaneItem[]`。
4. **摊平（宽相关，每帧）**：`renderPane`（`pipeline/rows.ts:534`）→ `itemLines`（`:469`）→ `boxToLines`（`:261`：表格 → `tableLines` `:395`；工具批 → `toolUnits` 三类行；代码 → 围栏；文本 / 引用 / 列表 → 按 `\n` 拆回行）→ `buildContentRows`（`build-box.ts:1315`）：`buildBox`（`:369`）**二次分类** → `layout`（`measure.ts:34`：`seedWidth` / `allocateNode` / `measurePass`，`measureLeaf` `:413` 用原文折行定高写 `node.height`）→ `fillToList`（`fill.ts:63`：`fillParagraph` `:356` 解析 + 折行，`decorateRows` 装饰与补白）→ `ContentRow[]`。
5. **合成帧**：`buildTopRegion`（`layout.ts:1033`）：`markToolNameRows`（在飞 `●`）、折叠占位、视口定位（段键 + 段内行）、输入行 / 状态栏 / 面板 → `FrameRow[]`。
6. **上屏**：`renderer.render`（`renderer/index.ts:214`）→ `Screen`（`renderer/screen.ts:108`）与上一帧逐格 diff、写 ANSI。

### 症结

- 分类做了两次：结构层（③）已完成 text / list / code / table 分类，但 `boxToLines` 把它压回纯行文本，`buildBox`（④）只能按文本再猜一次；列表符、标题井号、引用竖线、任务框全部由 fill 现造（`markdown.ts:935-941`）。
- 几何因此有两套：measure 用**原文**（`wrapLine`）且只认节点字段（正文仅 `prefix: ┃`），`paragraphRowsNoSplit`（`measure.ts:502`）对 `kind === "text"` 直接 `void contWidth`；fill 用**行内解析后 + 块级前缀 + 悬挂**。行数不等时 `decorateRows` 按高度补空格行 —— 即用户看到的「空行 + 该行无竖线」。
- SPEC 与实现不一致：`SPEC.md:148` 声明列表项为 `Paragraph(prefix:{"• "}, hanging:2)`，实际是 `wrapListRows` 内联实现（`SPEC.md:805-810` 记录的是现状）。

### 重构方向（待定，未接取）

- **分类单一源**：结构层分类结果随节点带进摊平阶段，`buildBox` 不再按文本二次分类。
- **折行单一入口**：measure 与 fill 共用同一折行实现，前缀 / 悬挂回到节点字段（与 `SPEC.md:148` 一致），`void contWidth` 一并修正。
- 保持不变项：表格仍构建期算列宽（跨行约束）、折叠基线不许静默重冻、`pipeline-frame` / `pipeline-equivalence` 行数断言逐条人工确认。

## 规划

计划改动文件清单见上「决策 → 计划改动文件清单（草案，实现阶段定稿）」，本轮不落定稿。

明确不做：本轮不实现任何改动；不重冻既有基线、不删断言。

## 实现记录

（本轮不做实现。）

## 偏差

（待实现阶段填写。）

## 测试与证据

（待实现阶段填写。）

## 收尾

**关闭（2026-10-26）：本任务只到决策，未单独实现修法——两个根因已由渲染流水线重构
（`TUI/docs/archived/2026-10-25-render-pipeline-refactor.md`）从结构上消除，本文件随该任务一并关闭。**

- **H1 消亡**（表格行高低估 → 竖线断）：新链表格在 §2 parse 出结构、§5 measure 的
  `expandTable` / `alignGridColumns` 定列宽与行高（行高写进格的 `heightFixed`），§6 摊平
  只读已量好的宽高。旧 `measureLeafRows` 那层「按原文二次解析定行高」不复存在，行高不再被低估。
- **H2 消亡**（measure / fill 折行口径分叉 → 额外空行）：折行收成 §6 `flatten` 的唯一入口
  （`wrapLeaf`），行数由同一次摊平产出；旧 `decorateRows` 按高度补空格行这条路径随旧 `fill`
  一起退出内容渲染（仅 chrome 面板仍在旧 `fill` / `measure` 上，不在重构范围）。
- **H3 / H4 按决策未做**，随旧链路删除一并消失（`bodyRun` 合并搬叶所在的 `build-box.ts`
  已整文件删除）。
- **验收项的承接**：决策里的 F1-F4 形态由 `pipeline-parse` / `pipeline-measure` /
  `pipeline-flatten` / `pipeline-frame` 的对应用例覆盖；表格列边界、横线段长、交叉字三者对齐
  见重构文档「第三轮 §5 测量收尾」的 grid pass 记录。
- **明确未做**：不重冻 `pipeline-equivalence` 基线；`SPEC.md` 的表格 / 排版篇幅未随重构重写，
  已登记为新 BACKLOG 条目「文档回写：DESIGN / SPEC 按七段链路重写」。
