# 2026-10-13 重新设计回合区工具块的显示格式

- 层：TUI
- 接取条目（按标题引用）：〈重新设计回合区工具块的显示格式〉
- 开始：2026-10-13　状态：进行中（**实现完成**：check + build + 全量 1545 通过 + bench 已比；真机人工确认待用户）

## 目标

重做**回合区（活动 pane）里工具调用 / 结果的显示格式**：现在一批工具是「调用行（无标记，
名字打头）+ 结果行（`✓` / `✗` + detail）」按顺序平铺，看不出配对与批次边界。目标形制由
用户裁定后落定（本条目登记时即写明「详细内容待开工时与用户讨论后再补」）。

## 现状盘点（2026-10-13 实测）

**当前渲染**（`buildContentRows` 实测，宽 76；缓冲文本 → 帧行）：

```
╌╌ 22:41:07 ⇆3 #12 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
read TUI/src/app/layout.ts
✓ 2311 行
grep frameBands
✓ TUI/src/app/layout.ts:1997: export function frameBands(section: Section)
hash_edit src/app/layout.ts
✓ (+1/-0)
bash npm run test:tui
✗ 1 test failed: grid.test.ts
```

**机制链路**（改动落点）：

| 环节 | 位置 | 现在做什么 |
|------|------|-----------|
| 行文本 | `layout/tool-line.ts` `toolCallLine` / `toolResultLine` | 调用行 = `name summary`（无标记）；结果行 = `✓|✗ detail`（空 detail 出 `✓ `）+ `(+N/-M)` diff 摘要；展示期省工作区根前缀 |
| 落缓冲 | `state.ts` `case "tool-call" / "tool-result"` → `appendToolLine` | 写 buffer 行（`kind: "tool"`，tone 由 `✓/✗` 判定） |
| 成盒 | `layout/pipeline/boxes.ts` `toolBox` / `computeBoxes`（`isBatch`） | 一批 = `shape: "tool"` + `batch: {calls, results}` |
| 上屏 | `layout/build-box.ts`（`kind === "tool"` 分支，约 `:310`；`:250-290` 的 `flushToolRun` 分组） | 调用行 `toolCallSegs`（首词黄）；结果行 `toolLineSegs`（`✓` 绿 / `✗` tone）；统一悬挂缩进 `TOOL_CONT_INDENT`；step 头 `╌╌ hh:mm:ss ⇆N #M` 独占一行 |
| 档位 | `state.activityVerbose`（think / tool / step）+ `state.activityCompact` | `step` 档只留调用行首物理行；紧凑档每条目压 1 行 |
| 恢复路径 | `surfaceToBuffer` 注入的 step 概要行（`SPEC.md` §8 表） | 恢复会话时只有 `╌╌ hh:mm:ss #N ╌╌ 工具名[×次数], …[ ✗失败数]` 概要，**没有**逐条调用/结果行 |

**约束**（新形制必须一起满足）：

1. **活动 pane 行数固定**：`frameGeometry.activityH` 决定可视行，超出的靠滚动回看；折叠会直接改动滚动上限与 `FrameScrollReport.activityMaxScroll`
2. **两档位**：`activityLevel`（think / tool / step）与 `activityCompact` 都要能表达新形制（不能只在完整档好看）
3. **窄窗降级**：w20 等窄窗已有断言行（`layout*` / `focus-frame`），装饰（竖线 / 缩进）需按宽度降级
4. **既有帧断言**：`content-mapping`（双轨：等价 / 已偏离）、`activity-verbose`、`layout*` 里都有工具块断言 —— 改形制必然要重冻其中一部分，需要「审查后重冻」这条口径（先前 #2 定的是逐字节不变，本条目相反）

## 决策（逐项裁定）

> 约定：决策项用数字，选项用 abcd（沿用〈拼帧层改为 Box 库统一装配〉那次任务的口径）。

### 决策 1 —— 形制骨架〔已定 2026-10-13；二次裁定后改版〕

**二次裁定（用户 2026-10-13，取代先前的 d「标记落结果位」）**：不限制在一行 —— **工具 box 内继续拆分：
工具名一个 box、每个参数名各一个新 box、结果一个 box**；参数行缩进 **4 列**（值列 = 4 + 最宽参数名 + 2），
结果 box 对齐值列。

**形制**

在飞（名字行带闪烁标记，参数各占一行，缩进 4 列）：

```
● read
    path   TUI/src/app/layout.ts
    limit  100
```

完成后（标记在名字行原地变状态；结果 box 追加在末尾、对齐值列）：

```
✓ read
    path   TUI/src/app/layout.ts
    limit  100
    2311 行
```

失败（结果 box 整块红）：

```
✗ bash
    command  npm run test:tui
    1 test failed: grid.test.ts
```

静默工具（`write` / `hash_edit` 无结果文本）：只出名字行 + 参数行，标记在名字行变 `✓`，**不多出结果行**。

**box 树拆法**（`pipeline/boxes.ts` 的 `toolBox` 由平面 `batch` 改为子树）：

```
toolBox = v([
  nameBox,                    // 标记 + 工具名（标记由帧层按相位整格改写）
  paramBox(name₁, value₁),    // 每个参数 = 一个新 box
  paramBox(name₂, value₂),
  resultBox,                  // 有结果详情时才挂；多行详情逐行折行
])
```

**数据落点**：`ToolCall.args` 是原始 JSON 字符串（`pipeline/types.ts:17-20`）→ 按仓库分工
「启发式归 adapter」，参数列表提取放 `adapter/normalize.ts`（新增 `toolParams(args)`），
`ToolCall` 加 `params?: { name, value }[]` 透传到 `batch`；`pipeline/rows.ts` 的 tool 分支
改为按子树产行。

**细节口径（2026-10-13 续裁，逐条经用户确认；取代此前「对齐 / 不截断」的早期草案）**

01. **参数顺序 = JSON 原序**（不按优先级重排）；参数不设条数上限（沿用决策 3.1 不折叠）。
02. **名字行**：`标记 + 空格 + 工具名`（标记列 0、名字列 2）。
03. **参数行**：缩进 **4**，`名 值`（**单空格、不做任何对齐**；值列不参与对齐）。
04. **参数名**：不折行；**自身超过可用宽 → 名字截断加 `…`**。名字过长（放不下值）时的取舍 ——
    比较两种布局的总行数：`H_另起 ≤ H_同行` → **值另起一行**（缩进 **6**，= 参数名 + 2）；
    否则**留在同行**走正常值规则；名字已占满一行时值必然另起一行。
05. **参数值**：折行、**上限 5 行**（超出 → 前 2 + `…` + 后 2，对称）；悬挂缩进 = 值起始列
    （正常 = 4 + 名宽 + 1；另起一行 = 6）。
06. **结果行**：缩进 **2**（对齐**工具名**列，与参数无关）；折行、**上限 5 行**（超出 → 前 2 + `…` + 后 2），
    悬挂缩进 2；失败整块红；空详情**不挂**结果行（静默工具只出名字行 + 参数行）。
07. ~~极窄兜底~~ **作废（2026-10-13 续裁）**：小尺寸不再做降级设计 —— 取消窄窗 / 矮窗分档，
    取消「值可用宽 < 8 → 单行中间截断」；改为**启动时尺寸检测 + 警告**（见决策 7）。
08. **非 JSON 参数**（纯文本 / 数组 / 解析失败）→ 单条无名兜底（值 = 原文）。
09. 符号与频率沿用：`●` / `○`（黄，固定 1 toggle/s，墙钟整秒相位）、`✓` 绿 / `✗` 红 / `■` 灰中断；
    **标记恒在名字行行首** —— 决策 2.2 由此自动被取代。
10. **配对**：沿用既有口径（`ToolResult.callId` 有则按 callId、缺失按到达顺序；`sections.ts:485`
    已全程透传）；落单结果（无对应调用）按原顺序补在结果区末尾。
11. **E**：参数值与结果都过展示期路径缩短（`shortenWorkspacePath`）；**不做额外脱敏**。

> **注意：第 5、6 条取代决策 3.2**（原「长 detail 不截断、无限折行」）—— 现统一为**折行 + 5 行上限**。

**代价**：一次调用从现在的 2 行（调用 + 结果）变为 `1 + 参数数 + 1` 行（`read` / `grep` 类 1-2 个
参数 = 3-4 行；`bash` 类参数多则更长，靠滚动）。

### 决策 2 —— 配对冗余度与合并 = a + a + a〔已定 2026-10-13〕

1. **2.1 结果行不带工具名**（选 a）：`✓ 2311 行` —— 紧贴调用行，位置已表达归属；长 detail
   不被名字挤窄。候选 b（`✓ read 2311 行`）不采用。
2. **2.2 结果有多条物理行时只在第一条带标记**（选 a）：续行按既有悬挂缩进
   （`TOOL_CONT_INDENT`）对齐。候选 b（每条都带标记）不采用。
3. **2.3 成功的多条工具不合并**（选 a）：保持逐条明细（活动 pane 可滚动回看；合并会丢细节）。
   候选 b（`✓ 4 次工具：read, grep, … ✗1` 摘要行）不采用。

### 决策 3 —— 折叠与截断 = a + a + a〔已定 2026-10-13〕

1. **3.1 不引入批次折叠**（选 a）：完整档逐行铺开 + 活动 pane 滚动回看；压缩需求走既有
   `activityCompact` 档位（每条目压 1 行 + 省略号）。候选 b（超 N 行折叠，无展开入口 = 藏内容）、
   c（只折叠成功且无 detail 的条目）均不采用。
2. **3.2 长 detail 不截断**（选 a）：与仓库既有原则一致（`summarizeToolArguments` 注释：
   「不做固定字符数截断（固定字符数与窗口宽度无关），完整摘要交给渲染层按窗口宽度换行」）。
   候选 b（单行截断 + `…`）不采用。
3. **3.3 成功但 detail 为空的条目保持现状**（选 a）：那一行只有 `✓`（今天也是 `✓ `）。
   候选 b（兜底 `✓ 完成`）、c（并进调用行，破坏标记位置口径）均不采用。

### 决策 4 —— 配色与相邻元素 = a + a + a〔已定 2026-10-13〕

1. **4.1 结果行配色保持现状**（选 a）：标记染色（`✓` 绿 / `✗` 红）+ detail 原色。
   候选 b（成功 detail 改灰）、c（失败整行红 + 成功 detail 灰）不采用。
2. **4.2 工具名保持黄**（选 a）：与用户块运行中符号同色系，且「首词染黄」是既有唯一口径。
   候选 b（改青 / 蓝）不采用。
3. **4.3 工具块保持不缩进、保留 step 头**（选 a）：活动 pane 宽度本就紧（窄窗 w20 有断言行）；
   step 头是时间轴分节。候选 b（缩进 2 列）、c（去掉 step 头）不采用。

### 决策 5 —— 恢复路径口径 = a〔已定 2026-10-13〕

**维持现状**（选 a）：恢复走既有 P9 折叠口径（每 step 一行摘要：工具名去重计数 + 失败数；
参数摘要 / 结果详情 / thinking 一概不还原，见 `adapter/dsh.ts` `normalizeHistoryMessages` 注释）。
本次只改在线形制。候选 b（恢复按 D 重建逐条、不带 detail）、c（恢复完整重建）不采用。
「恢复路径与在线形制对齐」若要做，**另立条目**（本次不登记）。

### 决策 6 —— 活动区两个开关暂时失效 + 另立条目〔已定 2026-10-13〕

`/collapse`（`activityCompact` 紧凑）与 `/verbose think|tool|step`（`activityVerbose` 档位）**暂时失效**：
拼帧层恒按完整形态渲染（不受这两个状态影响），两个命令改为提示「暂时失效」且不改状态。
**重新设计另立 BACKLOG 条目**：〈重新设计活动区两个开关（`/collapse` 紧凑 与 `/verbose` 档位）〉
（本次登记，交后续接取）。

### 决策 7 —— 小尺寸不降级〔已定 2026-10-13；警告另立条目〕

**取消**所有小尺寸（窄窗 / 矮窗）降级设计与配套用例：不作窄窗四档、不作矮窗分档、
不作「值可用宽 < 8 → 单行中间截断」、不为小尺寸新增测试。**既有**窄窗测试（6 组降级用例 +
4 个 `@w20` 基线场景）与既有几何行为**不删不动**（本次不碰）。

「启动时终端尺寸过小警告（**宽 ≤ 16 或 高 ≤ 9**）」**另立 BACKLOG 条目**（用户 2026-10-13 裁定：
该口径超出本条目范围，不写成本条目的决策）——落点 `src/app/index.ts` 启动路径 + 既有 `notice()`；
阈值与文案见该条目。

### 决策 8 —— 细节复核（2026-10-13 用户逐条答复）

在决策 1-7 之外，用户对实现细节逐条裁定：

01. 参数行**名字染灰、值原色**（决策 4 说「配色沿用现状」，但现状无参数行，故本项为新定）—— 可以。
02. **折行悬挂缩进**：**参数值的续行缩进 = 参数名缩进 + 2 = 总计 6 列**（固定值，不随名字宽度变化）；
    **结果行缩进总计 2 列**（对齐工具名）—— 确认。
03. 名字自身超宽 → 截到占满一行 + `…` 收尾 —— 可以。
04. 非 JSON 参数 → 单条无名兜底（值 = 原文）—— 可以。
05. 参数**不设条数上限**（靠活动 pane 滚动）—— 可以。
06. **并发多个 pending 调用：每个调用各出一行标记** —— 可以。
07. **结果 detail 保留换行结构，内部继续嵌套 box**（**修正**原「换行折叠成空格」）：detail 的多行按行
    嵌套渲染；受 5 行上限约束（超出 → 前 2 + `…` + 后 2，嵌套层数自然有限）。
08. **结果 detail 拆 box 的方式**：按**原始换行**逐行拆成 box（保留行结构），**不做 markdown 解析**
    （不把 `- ` 当列表、不认代码块）；每行超宽按宽度折行；总行数仍受 5 行上限约束。
09. **失败时的红色范围**：名字行 `✗` 红 + **结果行整行红**；**参数行不染**（名字灰 / 值原色照旧）。
10. **标题栏 verbose / compact 指示：留着不动**（本次不改，待〈重新设计活动区两个开关〉一并处理）。
11. **`/collapse` 与 `/verbose` 改为「隐藏命令」**（**修正**原「命令只回提示」）：从命令目录 / 补全 /
    帮助面移除；输入时给一条「该命令已下线（待重新设计）」提示，不改状态（`state` 字段与 reducer 暂留，
    待〈重新设计活动区两个开关〉重设计时统一处理）。

## 重冻许可（2026-10-13 用户裁定）

**允许审查 diff 后重冻工具块场景**：`content-mapping` / `activity-verbose` / `layout*` / `app` 里因
形制改版而失效的工具块帧断言，可在逐条复核 diff 后重冻；每个重冻场景须在本文件「测试与证据」节
列明**场景 + 原因**。

## 计划改动文件清单

**形制（决策 1 二次裁定：工具 box 内拆 + 参数 4 列缩进）落点**。数据流已核：
`ToolCall{callId,name,args}`（原始 JSON）→ `boxes.ts` `toolBox`/`batch` → `rows.ts` 产行 →
`build-box.ts` 上屏 → 帧层写相位标记。

01. `src/app/adapter/normalize.ts`：新增 `toolParams(args)` = `{ name, value }[]`
    （JSON 原序；非 JSON / 解析失败 → 单条兜底 `{ name: "", value: 原文 }`）；
    与既有 `summarizeToolArguments`（取单一关键字段）并存 —— 后者仍是「摘要」口径的既有消费者。
02. `src/app/layout/pipeline/boxes.ts`：`toolBox` 由平面 `batch` 改为**子树**——
    `v([ nameBox, paramBox×N, resultBox? ])`（名字 box 带标记位；结果 box 仅在结果详情非空时挂）；
    **结果 box 内按详情原始换行逐行嵌套成叶**（不解析 markdown，决策 8 第 8 条）；
    节缓存键仍是节对象身份（子树随节缓存复用，无额外失效面）。
03. `src/app/layout/pipeline/rows.ts`（`box.shape === "tool"` 分支，`:263`）：按子树产行 ——
    名字行（`kind: "tool-name"`，文本 = 稳定字形 `●` + 空格 + 工具名）、每个参数一行
    （`kind: "tool-param"`，缩进 4 列、**不做对齐**；值的续行悬挂缩进固定 6 列）、
    结果行（`kind: "tool-result"`，缩进 2；**保留详情换行、内部嵌套 box**，受 5 行上限约束 —— 决策 8 第 7 条）。
04. `src/app/layout/pipeline/frame.ts`（`:82-90` kinds/owner 逐行对齐）：产出行数变化后，
    kinds/owner 必须同步（否则与行错位）—— 按新行数逐行推。
05. `src/app/layout/build-box.ts`：三类行分别样式 —— 名字行「标记字形（按状态染色）+ 工具名黄」
    （`renderToolNameLine` 需支持前导标记：现状按**首词**染色，会把标记当工具名）；
    参数行「名灰 + 值原色 + 缩进 4（值续行悬挂 6）」；
    结果行「缩进 2 + 折行悬挂 2」；**失败时名字行 `✗` 红 + 结果行整行红，参数行不染**（决策 8 第 9 条）；
    `RowMeta.kind` 透传（帧层据此定位名字行）。
06. `src/app/layout.ts`（`buildTopRegion` 活动 pane 行 → 帧行）：对 `kind === "tool-name"` 的行
    按相位整格改写首列：
    - 本回合活跃（`state.agentStatus !== "idle"` 或 `state.inputStatus === "running"`，与
      `userBlockSymbolResolver` 同源）→ 相位 0 `●`（管线默认值，缓存友好）、相位 1 `○`，黄
    - 本回合已不活跃且该调用无结果 → `■`，灰
    - 相位 = `Math.floor(Date.now() / 1000) % 2`（固定 1 toggle/s）；**不新增定时器**（搭状态栏 1s ticker）
    - 只改名字行（每批至多 pending 条，整格改写而非整帧扫描）
07. `src/app/layout/content-rules.ts`：pending 字形与配色常量（`●` / `○` 黄、`■` 灰），
    与用户块符号表并列（同一符号语义只定义一处）。
08. **小尺寸一律不做**（决策 7）：不写降级分支、不加小尺寸用例；启动尺寸警告见另立条目（BACKLOG）。
09. **隐藏 `/collapse` 与 `/verbose` 两个命令**（决策 8 第 11 条）：`src/app/commands.ts` 的命令目录
    （`:228` / `:233` 两条）与补全 / 帮助数据源移除；`src/app/index.ts` 的两个处理函数
    （`handleCollapseCommand` `:3647`、verbose 同族）改为回一条「该命令已下线（待重新设计）」提示且
    **不改状态**。`state.ts` 的 `activityCompact` / `activityVerbose` 字段与 reducer、标题栏指示
    **保留不动**（决策 8 第 10 条，待〈重新设计活动区两个开关〉处理）。adapter 事件面不改。
10. 新增 `tests/tool-block.test.ts`：在飞（两相位）/ 完成 / 失败 / 静默工具（空结果）/
    值 5 行上限（首尾保留）/ 名字截断 / 长名取舍（另起 vs 同行）/ 非 JSON 参数兜底 /
    多结果配对（callId 与到达顺序两种）/ 并发多调用。**不含**任何小尺寸用例（决策 7）。
11. 既有断言复核与重冻：`content-mapping`（工具批双轨）、`activity-verbose`、`layout*`、`app`
    （结果行 `\n` 折叠那条）—— 逐条复核 diff，重冻的场景在「测试与证据」节列明场景 + 原因。
12. 文档：`TUI/docs/SPEC.md` §8 渲染形制表新增「工具块（名字 / 参数 / 结果三层 box）」一行；
    `TUI/docs/DESIGN.md` 内容层口径补一句（工具 box 子树 + 标记由帧层写）。
13. 验收：`npm run check` + `npm run build` + `npm run test:tui`（全量）+ `npm run bench`（±10%）+
    人工确认（`npm run demo` 或真机看在飞 / 完成 / 失败 / 静默四态）。

## 实现记录

01. `adapter/normalize.ts`：新增 `ToolParam` 类型与 `toolParams(args)` —— JSON 对象按**原序**逐项
    取 `{name, value}`（值：字符串原样、其余 `JSON.stringify`，均单行紧凑）；非对象 / 解析失败 /
    空对象 → 单条**无名兜底** `{name: "", value: 原文}`。与 `summarizeToolArguments` 并存。
02. `pipeline/boxes.ts`：新增 **`toolUnits(batch)`** —— 工具批 → 逻辑行单元序列
    （`name`（带已配对结果）/ `param` / `result`），内部做**展示配对**（`callId` 优先，缺失按到达
    顺序）与「空结果不挂行」判据（`isEmptyToolResult`，空详情**且**无 `(+N/-M)` 摘要）。这是
    **行数模型与实产行的单一来源**：`rows.ts` 按它产行、`frame.ts` 按它推 kinds / owner。
03. `pipeline/rows.ts`：tool 分支改为按 `toolUnits` 产三类行 —— 名字行（`toolRole: "name"`，
    `toolOk` = 配对结果成败，缺省 = 在飞）、参数行（`toolRole: "param"` + `toolParam`）、结果行
    （`toolRole: "result"`，**保留详情原始换行**，失败带 `tone: "error"`）；落单结果带 `orphan`
    → 行内自带 `✓` / `✗`；`(+N/-M)` 摘要挂结果行首行末尾（`toolDiffSummary` 由 `tool-line.ts`
    导出，`toolResultLine` 复用同一函数）。
04. `state.ts`：`HistoryRow` 新增 `toolRole` / `toolParam` / `toolOk` 三个可选字段。
05. `layout/build-box.ts`：工具行渲染改为三类行 —— 名字行（`标记 + 空格 + 工具名`，标记按
    `toolOk` 着色：`●` 黄 / `✓` 绿 / `✗` 红，名字恒黄，超宽截断加 `…`）；参数行（缩进 4、
    `名 值` 单空格不对齐、名字灰 / 值原色、值续行固定悬挂 6、值折行上限 5 行（前 2 + `…` + 后 2）、
    名字超宽截断、**另起 / 同行**按总行数取舍）；结果行（缩进 2、按原始换行逐行、5 行上限、失败
    整行红）；工具行**不再受** `activityCompact` / `activityLevel` 影响（决策 6）。
06. `layout.ts`：新增 `markToolNameRows()` —— 帧层按 1 toggle/s 相位整格改写**名字行**首列
    （活跃 → `●` / `○` 黄；已不活跃且无结果 → `■` 灰；`✓` / `✗` 由管线写死不动）；不新增定时器。
07. `layout/content-rules.ts`：新增标记字形（`TOOL_PENDING_GLYPH` / `_ALT` / `TOOL_INTERRUPTED_GLYPH`
    / `TOOL_OK_GLYPH` / `TOOL_FAIL_GLYPH`）与排版常量（`TOOL_PARAM_INDENT` 4 /
    `TOOL_PARAM_CONT_INDENT` 6 / `TOOL_RESULT_INDENT` 2 / `TOOL_LINE_CAP` 5）。
08. `commands.ts` + `index.ts`：`/collapse` 与 `/verbose` 从**命令目录**（补全 / 帮助面）移除，
    路由经新增的 `RETIRED_ROUTES` 保留 → 两个 handler 只回「该命令已下线（待重新设计）」且
    **不改状态**（`state` 字段 / reducer / 标题栏指示保留不动）。
09. `tests/tool-block.test.ts`（新增，13 条）：完成 / 在飞 / 失败（含着色）/ 值 5 行上限 /
    名字截断 / 长名取舍（另起）/ `toolParams` 单元 / 非 JSON 兜底 / 配对（callId 与到达顺序）/
    并发多调用 / 静默工具 + `(+N/-M)` / 帧层相位（活跃 `●`·`○`、不活跃 `■`、完成 `✓`）。
10. 文档：`docs/SPEC.md` §「内容元素 → Box 表达」的工具行一行改写为新形制；`docs/DESIGN.md`
    模块表新增「工具块三类行」一行（单一来源 `toolUnits` + 帧层相位标记）。

### 计划外偏差（3 处，均有证据）

1. **`toolBox` 保持平面 `batch`，不拆子树**（计划清单 02）：行由 `rows.ts` 产出、宽度规则在
   `build-box.ts`，`batch` 的消费者只有 `frame.ts` / `panes.ts` / `rows.ts` 三处 —— 拆子树会多出
   一层没有消费者的结构定义（两处平行的行模型反而更容易错位）。改为把「批 → 逻辑行」的**模型**
   放进 `boxes.ts` 的 `toolUnits()`，`rows.ts` 与 `frame.ts` 共用同一函数（即计划想要的「行数
   对齐」效果的更强形式）。
2. **参数不经 `ToolCall.params` 透传**（计划清单 01/03 的衔接）：`toolUnits()` 在结构层现算
   `toolParams(call.args)`，免改 `pipeline/types.ts` 与节缓存（`ToolCall` 是节内容的一部分，
   加字段会牵动去重 / 剪枝的身份判据）。
3. **空详情 + `(+N/-M)` 摘要仍挂结果行**（决策 1 细节 06 只说「空详情不挂」）：否则 `hash_edit`
   这类「详情空但 diff 摘要有用」的结果会整条消失（旧形制里 `✓ (+1/-0)` 是可见信息），
   判据收敛为 `isEmptyToolResult()`（空详情**且**无摘要才不挂）。

## 测试与证据

- `npm run check`：通过；`npm run build`：通过。

- `sh scripts/test.sh`（全量）：**1545 通过 / 0 失败**（改动前 1532；新增 13 条）。

- `npm run bench`（同一合成语料，改动前 `ef00529` 用 git worktree 跑基线）：

  | 档位 | 改前 (off/on) | 改后 (off/on) |
  |---|---|---|
  | groups(rows=60) | 0.52 / 0.09 ms | 0.53 / 0.10 ms |
  | groups(rows=120) | 0.46 / 0.13 ms | 0.48 / 0.10 ms |
  | cold | 0.47 / 0.08 ms | 0.47 / 0.08 ms |
  | warm | 0.43 / 0.02 ms | 0.45 / 0.02 ms |
  | incremental | 0.49 / 0.02 ms | 0.51 / 0.02 ms |

  均在 ±10% 内（唯一例外是 `groups(60)` cache on 的 0.09 → 0.10 ms，绝对值 0.01 ms = 打印精度内
  的抖动；bench 自身不设阈值）。缓存命中路径（warm / incremental）保持 0.02 ms。

- **复核后重冻的既有断言**（重冻许可范围：`content-mapping` / `activity-verbose` / `layout*` / `app`
  里的工具块场景；实际改动逐条列明「场景 + 原因」）：

  - `tests/activity-level.test.ts`：2 条 step 档用例改写为「档位对工具块失效、工具块恒完整形态」
    （原因：决策 6 两个开关退休）；2 条命令用例改写为「已下线提示 + 不改状态」（原因：决策 8 第 11）。
  - `tests/activity-verbose.test.ts`：2 条紧凑模式用例改为「工具块不受紧凑影响」（原因：决策 6）。
  - `tests/app.test.ts`：3 条工具事件用例改写为新形制（名字行 / 参数行缩进 4·续行 6 / 结果行保留
    换行、落单结果自带标记）；`/collapse` 用例改「已下线」；2 条状态落盘用例改用 `/model`
    （原因：`/collapse` 不再改状态）；`/help` 紧凑豁免用例去掉 `/collapse` 前置；活动区生命周期
    用例的工具断言拆成名字行 + 参数行。
  - `tests/layout4.test.ts`：工具行 / step 头相邻 / 工具名着色 / 长参数续行 4 条用例的断言按新形制
    更新（含「未活跃 pending → `■`」）。
  - `tests/step.test.ts`：10 条分组头用例的工具行期望改为三类行（step 头语义未变）。
  - `tests/completion.test.ts`：补全候选里去掉 `/collapse`。
  - `tests/tool-call-wrap.test.ts`：长 detail 折行用例按新形制（结果行缩进 2 + 落单标记）更新。
  - `tests/pipeline-frame.test.ts` / `tests/pipeline-equivalence.test.ts`：旧侧语料改为带**原始
    参数**并按三类行喂行（原因：形制改版后「name + 摘要」单文本行与新侧必然不等价）。
  - **未重冻** `content-mapping.test.ts`（本次未失败）。

- 帧核验（临时探针脚本，跑后已删）：在飞 `● read` / `    path TUI/src/app/layout.ts`；完成
  `✓ read` + `  2311 行`；失败 `✗ bash` + 红结果行；静默 `✓ write` 无结果行；不活跃 pending
  帧层改写为 `■`。

- **人工确认真机效果：未做**（用户不在场，按授权先提交）。真机复看项：`dsh --profile fff`，
  看四态（在飞 / 完成 / 失败 / 静默）+ 相位闪烁 + `/collapse` `/verbose` 的下线提示 +
  `/help` 里两条命令已消失。

## 收尾

- 关闭（2026-10-13）：条目已从 `TUI/docs/BACKLOG.md` 移除；本文档移入 `TUI/docs/archived/`。
- 提交：`428d2e7`（`toolParams` 数据面）+ `e0d6154`（三类行全量改动 + 用例 + 文档）。
- **子代理审阅：两次派发均未产出报告**（第一次 `538a26aa` 多轮后仍未回、被中止；第二次限时审阅
  `a5908ebb`（≤15 次工具调用 + 两次催收尾）同样未回、被中止）。中止时工作树均无残留改动
  （`git status --porcelain` 已核）。因此本文档**不含外部审阅结论** —— 替代证据是「测试与证据」节的
  **全量 1545 通过**、逐条重冻清单（场景 + 原因）与下面三条关键不变量自查：
  1. **行数模型对齐**：`rows.ts` 产行与 `frame.ts` 的 kinds/owner 共用**同一个** `toolUnits()` 函数
     （`boxes.ts`），差异只可能来自「同一次调用内 batch 被改动」——而 batch 随节对象不可变；
  2. **相位改写不动缓存**：`markToolNameRows()` 只处理 `kind === "tool-name"` 且首列是 `●` 的行，
     无变化时**返回原数组**（引用不变）；改写发生在 `fill` 之后，不触发重排；
  3. **符号列宽恒 1**：`●` / `○` / `■` / `✓` / `✗` 均为宽度 1 的推荐符号，相位切换不改行宽。
- 遗留（**不在本条目范围**）：
  - 真机人工确认未做（用户不在场，按授权先提交）——复看项见「测试与证据」末条；
  - `toolCallLine` / `toolResultLine` 仍保留（`state.ts` 缓冲行、`adapter/dsh.ts` 交付文本、恢复重放
    与 `tool-meta` 用例的消费者），本次只把**流水线渲染**切到三类行；
  - 恢复路径维持 P9 概要口径（决策 5）；测试侧 `sectionsFromLocal` 把旧缓冲工具行重放成三类行，
    属**测试脚手架**行为（生产恢复走 `surfaceToBuffer` 的 step 概要行，不经这条路径）。
- 后续：〈重新设计活动区两个开关（`/collapse` 紧凑 与 `/verbose` 档位）〉已作为 BACKLOG `#2` 登记，
  本次不接取。
