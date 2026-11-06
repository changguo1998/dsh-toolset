# 折行策略可配置（按词 / 按字符 / 不折行）（接取条目：docs/BACKLOG.md「折行策略可配置（按词 / 按字符 / 不折行）」）

状态：调研（决策 7 已定；1 至 6 待用户裁定）　　开启：2026-11-06　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

折行风格从「`wrap: true | false` 两档」扩成枚举，至少三档：`char`（逐字符，现状）/ `word`（按词）/ `none`（单行截断）。三档共用同一套缩进与截断口径（悬挂缩进、续行宽、行尾 `…`），CJK 在 `word` 下不被强制按空格断，状态列条目可逐条选风格，且缺省行为与今天逐字一致。

**另加目标（2026-11-06 用户追加）：统一折行逻辑。** 全仓逐字符折行从 5 份副本（3 份通用核 + 2 份专用外壳）收敛为一份纯函数核；风格差异只体现在核的入参上，调用点不得再各写字符循环。

## 追加规格：最大行数与折行提示（2026-11-06 用户指定）

原「折行策略」管**断点口径**（`char` / `word` / `none`）；本次追加两个**与断点口径正交**的变量——折行后行数超出预算时显示多少、以及如何提示被隐藏。

### 变量 1：最大行数 `maxRows`

- 类型整数，取值范围 `0` 或正整数。
- `0` = 不生效，显示全部内容（缺省语义同今天）。
- `N > 0` = 内容折行后的总行数超过 `N` 时只显示 `N` 行，其余隐藏。

### 变量 2：折行提示 `hint`

指定隐藏发生时的提示符摆放风格：

- `"none"`：不加提示字符，单纯截断。
- `"head"`：显示内容**末尾**（保留最后 `N` 行），提示符号放在**开头**（保留部分的第一行行首）。
- `"tail"`：显示内容**开头**（保留前 `N` 行），提示符号放在**最后一行行尾**。
- `"middle"`：显示内容**开头与结尾**、隐藏中间（2026-11-06 用户追加）。

提示符号统一 `…`，**只占列、不额外占行**：`head` 在首行行首一个，`tail` 在末行行尾一个。

### 已确认（2026-11-06 用户答复）

1. 提示符号字形：统一 `…`。
2. 不额外占行：只在首行行首或末行行尾有一个。
3. 设计取向：**作为 leaf 的属性替换现有 `wrap`**（不是「全局开关 + 覆盖」）。
4. 现有硬上限本次不动——只提供能力，工具行 5 行 / 提示行 1 至 2 行 / 状态列 L3 / `/collapse` 的合并留给后续条目。

### 待确认（2 点，见本轮提问）

1. `middle` 的提示符贴在哪：前段末行行尾，还是后段首行行首；`N` 行如何在前 / 后两段分配（均分 / 前多一行 / 后多一行）。
2. 是否仍需要配置缺省：leaf 未声明该属性时的回落值写死（`char` + `maxRows: 0` + `hint: "tail"`），还是再给 `tui.config.json` 的 `layout.wrap` 一个用户级缺省 + `/wrap` 运行时切换。

## 调研

来源：本仓代码实测（`TUI/src` 全量 grep + 逐文件精读），文档口径 `TUI/docs/SPEC.md`。

### 1. 今天有两条并存的折行路径，都在线上

- **内容区（会话 / 回合）走 pipeline**：`pipeline/parse.ts` → `structure.ts` → `pipeline/measure.ts` / `pipeline/flatten.ts`，唯一折行入口 `pipeline/wrap.ts:40` 的 `wrapLeaf`，内部核 `wrapSegmentsAt`（`pipeline/wrap.ts:104-130`）**逐字符**切（只判 `curW > 0 && curW + w > limitW`）。
- **面板与 chrome（状态列 / 标题栏 / 状态行 / 输入区 / 提示行 / 各类面板）走 legacy 排版库**：`box.ts` 节点树 → `layout/measure.ts:389` → `fill.ts`。其中两个分支各有一套字符核：
  - `Paragraph`：`measure.ts:428-435` 的 `wrapParagraph`——`wrap !== false` 走 `primitives.ts:92-110` 的 `computeWrapLine`（逐字符），`wrap === false` 走单行 + `…`。
  - `StyledText`：`fill.ts:443-446`——`wrap === false` 走 `splitPhysical`（`fill.ts:479`，只按 `\n` 切、超宽整行保留），否则走 `splitAndWrapSegments`（`fill.ts:493`）→ `markdown.ts:773` 的 `wrapFrameSegments`（逐字符）。
- **拼帧层兜底截断**：状态列每格超 `statusBodyW` 时 `truncateSegs(w−1) + "…"`（`top-region.ts:460-477`）；紧凑模式同类截断 `pipeline/rows.ts:432-440` 的 `foldRows`。
- 分化口径见 `TUI/docs/SPEC.md:248`（面板与 chrome 用 legacy，内容区用 `wrapLeaf`），是已有裁定，不是待修缺陷。

### 2. 逐字符折行核今天有 3 份通用副本 + 2 份专用变体

| 位置 | 入参 | 备注 |
|---|---|---|
| `primitives.ts:92-110` | 纯文本 | 带缓存（`wrapLine`，`primitives.ts:85-89`） |
| `markdown.ts:773-801` | 样式段 | 带 `hanging` 参数；缓存见 `wrapInlineMarkdown` / `wrapAssistantLine` |
| `pipeline/wrap.ts:104-130` | 样式段 | 带 `limit(globalRow)` 回调（首行 / 续行分档） + 平衡折行计数 |
| `content-rules.ts:71-98` | 纯文本 | 专用：工具行悬挂 2 列 + 5 行上限 |
| `frame-rows.ts:41-75` | 纯文本 | 专用：提示行先按 `·` 断，超宽再回落 `wrapLine` |

结论：**加一种风格前必须先收敛折行核**，否则 5 处各改一遍必然漂移（现状已有 3 份逐字符实现互为复刻，注释里多处写「对齐」）。

### 3. `wrap: false` 今天承载两种不同语义

- `measure.ts:428-435`：单行 + 行尾 `…`（高度恒 1）。
- `fill.ts:443-446` / `:479`：只按 `\n` 切物理行，**超宽整行保留**，不截断。
- 面板族靠后者的「精确行长」写法（构建期自己按宽截断）保证不溢出：全仓 `wrap: false` 共 **57 处**（`StatusColumn.ts` 12 处、面板组件约 30 处、`layout/panel.ts` / `status-line.ts` 等）。
- 状态列条目另有自己的字段 `StatusItem.wrap?: false`（`StatusColumn.ts:79-97`），在 `itemLeaves`（`StatusColumn.ts:184-193`）落到叶子上；L3 折叠强制一条一行（`StatusColumn.ts:188` 的 `level >= 3`）。

结论：`none` 只应表达「单行 + `…`」（验收要求「现有 `wrap: false` 行为不变」正好对上）；面板的「精确行长、不软折、不截断」不是折行风格，不进枚举。

### 4. pipeline 里的 `wrap` 字段是死的

`pipeline/ir.ts:351-352` 声明了 `wrap?: boolean`（注释同样写「false = 单行截断不换行」），但 `parse.ts` / `structure.ts` / `measure.ts` / `flatten.ts` **都不读它**；`wrapLeaf` 的 `WrapOptions`（`pipeline/wrap.ts:27-34`）也只有 `prefixW` / `hanging` / `balance`。全仓没有一处给 pipeline 叶子写过 `wrap: false`。

结论：内容区今天做不到「不折行」，要么让字段生效（与 legacy 对齐），要么删掉。

### 5. 配置与状态通道（决定「可配置」怎么落地）

- 配置文件：`tui.config.json` 的 `layout` 段（`config.ts:27-38` 类型、`config.ts:196-235` 归一化），**启动读一次**（`config.ts:331`）；`TUI/docs/SPEC.md:232` 已记「除 `theme` 外其余键需重启才生效」。
- 注入链：`TuiLayoutConfig` → `AppDeps`（`app-deps.ts:58-62`）→ `AppState`（`state/types.ts:556-558`、`state/initial.ts:51-55`）→ `runtime/context.ts:362-363` → 各处组件。这条链上今天跑的是 `activityPlacement` / `statusColumnDivisor`。
- 运行时切换范式：本地命令改 state 字段、不落盘，如 `/collapse`（`commands.ts:481-483`）改 `state.activityCompact`。
- 缓存键：`cache.ts:78-80` 的 `sizedKey(text, size)` 只含「文本 + 宽」——加策略必须进键，否则同一文本切两档会串味；pipeline 折行暂未做缓存（`pipeline/wrap.ts:19-21`）。

### 6. 文档口径现在写在两处

- `TUI/docs/SPEC.md:107`——「`wrap: false`：不换行、单行截断加省略号」。
- `TUI/docs/SPEC.md:248`——面板与 chrome 走 legacy、内容区走 `wrapLeaf`。
- `TUI/docs/SPEC.md:694`——状态列折叠 L3 = `wrap:false`。
- 配置键说明在 `TUI/README.md:188-232`（`TUI/tui.config.json` 段）。

### 7. 现状的直接痛点（本次要解的部分）

- 长英文单词 / URL / 路径被从中间切开（逐字符切，无断点概念）。
- 状态列条目只有「折行 / 压一行」两态，长 slug 要么折成多行挤掉别的块，要么被 `…` 一刀切。
- 用户无法按喜好切换风格，也没有「不折行」的全局开关（只有代码里逐点写死的 `wrap: false`）。

## 补充调研（2026-11-06 第二轮, 针对待裁定的 6 项补事实）

### 一、配置面比预估更省事（直接影响决策 2）

- `DshTuiConfig` 本身就有 `layout?: TuiLayoutConfig`（`main.ts:271-277`）：profile patch 的 `tui` 行与包内 `tui.config.json` **共用同一个 `layout` 段**, 逐键浅合并（`config.ts:294-325`；`main.ts:603-608` 记「patch > 文件 > 内置默认」）, 且 `main.ts:200` 直接 `...tuiConfig.layout` 摊进 App 选项, `AppDeps` 里是同名平铺字段（`app-deps.ts:51-62`）。
- 结论：加 `layout.wrap` 只需三处改动——`TuiLayoutConfig`（`config.ts:27-38`）、`normalizeConfig` 的枚举归一（`config.ts:196-235`）、`AppDeps` 的平铺字段；链路其余部分自动生效。**不需要新通道, 也不需要环境变量**, 决策 2 的 c 项（环境变量）可以划掉。
- 热更新：TUI 侧只有 `theme` 可就地生效, 其余键一律「profile 配置变更需重启 dsh 才生效」（`main.ts:402-442`、`:1110`）。所以「运行时可切」只能靠本地命令。
- `/config set tui.layout.wrap=…` 想有类型闸门, 需在 `config-edit.ts:279-291` 的 `CONFIG_KEY_TYPES` 加一行 `"tui.layout.wrap": { kind: "enum", values: ["char","word","none"] }`（该表注释写明「新增键 = 表里加一行」）；不加也能写, 只是落到「既有值类别兜底」。

### 二、词单元必须跨样式段（影响折行核的输入形态）

- `parseInlineMarkdown`（`markdown.ts:632-637`）按 markdown token 切段, **不在空格处切**：`foo**bar**baz` 产 3 段。故 `word` 的断点单元是「跨段的连续非空白字符」, 而现有 3 份通用核都在**段内**迭代（`for (const seg of segs) for (const ch of seg.text)`）。
- 结论：核的输入应是「带样式的字符流」（`{ch, style}` 序列）, 断行后再按样式合并成行段；这正好是收敛时要一并改掉的形态, 不能按段折行再拼接。

### 三、空白判定不能看宽度

- `charWidth` 对 `\t` 与控制字符返回 **0**（`markdown.ts:546-548`）, 故「空白」必须按字符类（`\s`）判, 不能按宽度 0 反推；代码块里的 `\t` 已先由 `expandCodeTabs` 展开（`pipeline/measure.ts:199`）。
- `truncateSegs`（`primitives.ts:25-43`）按整字符截、不切半个 CJK；`none` 的行尾 `…` 占 1 列, 现状口径是 `truncateToWidth(text, width-1) + "…"`（`measure.ts:431-432`）, 宽字符场景会留 1 列空档, 属既有表现, 本次不改。

### 四、代码块与工具行会被策略波及（需要显式定档）

- pipeline 代码块先把载荷展开成普通叶（`pipeline/measure.ts:167-210` 的 `codeLines`：`tree.code = undefined; tree.children = codeLines(...)`）, 之后与正文一样走 `wrapLeaf` → 不特判的话**代码行也会变成 `word`**。结论：代码叶（`style.code`）固定 `char`。
- 工具行参数 / 结果是普通叶（`structure.ts:361` / `:391` 的 `rowKind: "tool-param"` / `"tool-result"`）, 会跟着全局策略走；对 URL / 路径是改进, 对命令文本可能希望不断——建议不加特例, 记入「明确不做」。

### 五、缓存键必须含策略, 不能只靠切档清缓存

- legacy `wrapLine` 缓存键 = `sizedKey(text, width)`（`cache.ts:78-80`）；pipeline 行缓存键 `keyHead = [pane, width, vw, gutter, …]`（`rows.ts:483-487`）**不含任何折行参数**。
- 若决策 6 选「逐条选风格」（c）, 同一文本在同一帧内可能出现两种风格 → 全局清缓存不够, 键必须带策略。
- 结论：核的缓存键统一为「策略 + 宽 + 悬挂 + 文本」；`clearLayoutCaches()`（`cache.ts:32`）/ `clearNewRowCache()`（`rows.ts:289`）保留给切档兜底。

### 六、`wrapToolCallText` 已是死代码（「5 份副本」的实际构成）

- 生产无任何调用：只有 barrel 再导出（`layout.ts:30`）与两个测试文件（`tests/tool-call-wrap.test.ts`、`tests/content-rules.test.ts`）；工具行早已迁到 pipeline（`structure.ts:321-400` 的 `toToolBatch`）。
- 实际构成 = **3 份在用通用核**（`primitives` / `markdown.wrapFrameSegments` / `pipeline.wrapSegmentsAt`）+ **1 份死代码**（`content-rules.wrapToolCallText`）+ **1 份专用外壳**（`frame-rows.wrapHintLine`, 在用的只有 `·` 优先 + 回落）。
- 结论：统一时可直接删除 `wrapToolCallText`（两个测试文件收敛到核用例）, 不必留兼容外壳；提示行外壳保留（它的 `·` 优先是提示行语义, 不是折行风格）。

### 七、默认值改动的代价（影响决策 3）

- TUI 现 140 个测试文件, 其中 **64 个**引用 `FrameRow` / `buildFrame`（帧级断言）, 39 个提到折行；`demo/main.ts:127` 用 `SMOKE_PASS` 冒烟。含空格的拉丁文本一旦换断点, 这些断言都可能变。
- 与折行直接相关的测试：`tests/pipeline-wrap.test.ts`、`pipeline-measure.test.ts`、`pipeline-layout.test.ts`、`layout4.test.ts`、`layout-cache.test.ts`、`status-column-equivalence.test.ts`、`tool-call-wrap.test.ts`、`content-rules.test.ts`、`question-wrap.test.ts`、`tui-config-merge.test.ts`、`main.config.test.ts`、`config-edit.test.ts`。
- 结论：缺省维持 `char` 几乎零成本；若改 `word` 要逐条复核这 64 个文件与 demo 基线。

### 八、状态列逐条选风格的落点（影响决策 6）

- 各块条目由工厂函数产出：`statusColumnBlocks`（`StatusColumn.ts:403-464`）里 `goalObjectiveItem` / `blockedItem` / `goalHistoryItem` / `todoItem` / `jobItem` / `agentItem`, 另有 `extrasBlocks` 产 Task / Flow / Pin / Daemon / Group 五块, 每个工厂返回 `StatusItem` → 加 `wrap?: WrapMode` 是逐工厂一行。
- 现状只有 `wrap?: false`（`StatusColumn.ts:79-97`）与 L3 强制单行（`:188`）。
- 长文本候选：Goal objective（现状完整折行）、Todo 文本、Agents `名称 · 工作内容`、Flow slug、Daemon 任务名、Group 名。

### 九、pipeline 的 `wrap` 字段建议删除而非启用

统一后折行风格由 `WrapOptions.mode` 承载；`pipeline/ir.ts:351-352` 的 `wrap?: boolean` 若同时「生效」会变成双轨（`wrap: false` 与 `mode: "none"` 同义）。建议删除该字段, 由 `mode` 唯一表达。

## 决策

第 1 至 6 项待用户裁定（每项给出推荐项，推荐 = a）；第 7 项已定（见该节）。

### 1. 作用面：策略要覆盖哪条路径

- a. 两条路径都做：`wrapLeaf`（内容区）与 legacy（面板 / chrome）共用同一策略值。会话正文是主要阅读面，只做面板等于名不副实。
- b. 只做 legacy；pipeline 维持逐字符（改动最小，但 `none` / `word` 对正文无效）。

推荐 a。补研四：两条路径都做时, pipeline 的代码叶必须单独定档 `char`（代码行按词断没有意义）。

### 2. 配置入口

- a. `tui.config.json` 的 `layout.wrap` 定缺省值（启动生效） + 本地命令 `/wrap char|word|none` 运行时可切（不落盘，与 `/collapse` 同族）。
- b. 只做配置文件，不做运行时命令。
- ~~c. 只做环境变量（如 `TUI_WRAP`），不进配置文件。~~（补研一：`layout` 段已是 profile patch 与配置文件共用面, 环境变量这条不必要, 划掉。）

推荐 a。补研一：配置文件侧只需三个字段 + `CONFIG_KEY_TYPES` 一行；`/config` 改的键一律「需重启」, 故运行时切换只能靠本地命令。

### 3. 缺省值

- a. `char`（与今天逐字一致，全部现有帧基线不动）。
- b. `word`（更符合阅读习惯，但要复核所有「恰好折在字符中间」的帧测试与 demo 基线）。

推荐 a；若选 b，测试面要按第 4 节「测试与证据」补一轮基线复核。补研七：64 个测试文件引用帧级断言, 39 个提到折行, 改缺省值的复核面就在这里。

### 4. `word` 的断点口径

- a. 断点 = 空白处（断点空格吃掉，续行不以空格开头）+ `-` / `/` 之后可断；**单元超宽时回落逐字符**；CJK 与无空格文本按字符可断（不强制按空格）。
- b. 同 a，但断点空格保留在上一行行尾（缩进与右侧补白口径需另定）。
- c. 只按空白断，`-` / `/` 不可断；其余逐字符。

推荐 a。**明确不做**禁则（避头尾点 / 行首禁排标点），另立条目。

### 5. `none` 的语义

- a. 单行 + 行尾 `…`（与 `measure.ts:428-435` 一致）；面板「精确行长不软折、不截断」保持现状 `wrap: false` 不动。
- b. `none` 同时接管面板那种「整行保留」语义（会让 57 处 `wrap: false` 语义分叉，且与验收「现有行为不变」冲突）。

推荐 a。

### 6. 状态列逐条选风格的粒度

- a. 代码级：`StatusItem.wrap?: WrapMode`（缺省取全局值），由各块构建函数决定（jobs / 阻塞原因 / 长 slug 各自选）。
- b. 配置级：`layout.statusWrap` 按块给风格（`{ jobs: "none", flow: "word" }`），不改组件代码。
- c. 两者都做：配置给按块缺省，条目字段可覆盖。

推荐 c（b 满足「可配置」、a 满足「逐条」；工作量增加有限）。补研八：条目由逐块工厂函数产出（goal / todo / jobs / agents 四块在 `statusColumnBlocks` 内, Task / Flow / Pin / Daemon / Group 五块在 `extrasBlocks`）, 逐条加字段是每个工厂一行；长文本候选已列在该节。

### 7. 折行核收敛方式

- a. 新增一个纯函数核（按「折行单元」序列工作：单元 = 1 个字符或 1 个词），**5 处实现全部改为调用它**（3 份通用核换实现；工具行、提示行两份专用外壳保留自身行数上限与 `·` 优先逻辑，内部同样调核）。
- b. 每处各加一个 `mode` 参数，不抽公共核。

**选定 a（2026-11-06 用户追加目标「统一折行逻辑」直接定为必须项，不再作为可选项）**。理由：5 份副本已在互相复刻（注释多处写「对齐」），再加一档风格会变成 10 份；统一核后风格差异只在入参，`wrapLeaf` 与 legacy 也共用同一份断点判定，才不会出现「内容区按词、面板按字符」的口径分叉。

## 规划

决策 1 至 6 定稿后补全。当前为草稿，按「决策 1=a、2=a、3=a、5=a、6=c」预估；第 7 项（统一折行核）已定，列为第 1 步。

### 任务拆分（预估）

1. **收敛折行核（先做，第 7 项已定）**：新增 `TUI/src/app/layout/wrap-core.ts`（纯函数：带样式字符流切单元 + 三档策略 + 首行 / 续行可用宽回调 + 超宽单元回落 + 缓存键含策略），各处改为调核——`primitives.ts:92-110`（通用，纯文本）、`markdown.ts:773-801`（通用，样式段，含 `hanging`）、`pipeline/wrap.ts:104-130`（通用，样式段，含 `limit(globalRow)` 与平衡计数）改为薄封装；`content-rules.ts:71-98` 的 `wrapToolCallText` **直接删除**（补研六：生产无调用，两块测试收敛到核用例）；`frame-rows.ts:41-75` 保留 `·` 优先外壳、超宽回落调核。补核的单测。
2. legacy 两条分支接入策略（`primitives.wrapLine` / `markdown.wrapFrameSegments` / `measure.wrapParagraph` / `fill` 的 styled 路径），缓存键加策略。
3. pipeline 接入策略（`WrapOptions.mode`），并**删除** `pipeline/ir.ts:351-352` 的死字段 `wrap`（补研九：由 `mode` 唯一表达）；代码叶（`style.code`）固定 `char`（补研四）。
4. 状态列条目字段扩展（`StatusItem.wrap`）+ 各块按需选风格。
5. 配置与命令接线：`config.ts` 的 `layout.wrap` / `layout.statusWrap`、`AppDeps`、`AppState`、`/wrap` 命令；`config-edit.ts` 的 `CONFIG_KEY_TYPES` 加 `tui.layout.wrap` 一行（补研一）。
6. 文档回写与测试。

**统一折行的验收口径**：第 1 步完成后，全仓字符级折行循环只允许出现在 `wrap-core.ts` 内（`grep -rn "for (const seg of" TUI/src/app/layout` 与 `grep -rn "for (const ch of" TUI/src/app/layout` 只命中该文件与无关解析器）；第 2、3 步只换入参，不得再新增字符循环。

### 计划改动文件清单（草稿）

- 核心：`TUI/src/app/layout/wrap-core.ts`（新增，纯函数）、`TUI/src/app/layout/primitives.ts`、`TUI/src/app/layout/cache.ts`、`TUI/src/app/layout/markdown.ts`、`TUI/src/app/layout/fill.ts`、`TUI/src/app/layout/measure.ts`、`TUI/src/app/layout/content-rules.ts`（删 `wrapToolCallText`）、`TUI/src/app/layout/frame-rows.ts`、`TUI/src/app/layout/frame-build.ts`。
- pipeline：`TUI/src/app/layout/pipeline/wrap.ts`、`pipeline/measure.ts`（含 `codeLines` 定档 `char`）、`pipeline/flatten.ts`、`pipeline/ir.ts`、`pipeline/rows.ts`（缓存键）、`pipeline/structure.ts`（仅当需给代码叶定档）。
- 状态列：`TUI/src/app/components/StatusColumn.ts`、`TUI/src/app/layout/top-region.ts`（透传策略）。
- 配置与状态：`TUI/src/app/config.ts`、`TUI/src/app/app-deps.ts`、`TUI/src/app/state/types.ts`、`state/initial.ts`、`state/actions.ts`、`TUI/src/app/commands.ts`、`TUI/src/app/runtime/context.ts`、`TUI/src/app/config-edit.ts`。
- 测试：`TUI/tests/wrap-strategy.test.ts`（新增）、`tests/pipeline-wrap.test.ts`、`tests/layout4.test.ts`、`tests/layout-cache.test.ts`、`tests/status-column-equivalence.test.ts`、`tests/tool-call-wrap.test.ts`、`tests/content-rules.test.ts`、`tests/config.test.ts`、`tests/tui-config-merge.test.ts`、`tests/main.config.test.ts`、`tests/config-edit.test.ts`。
- 文档：本文件、`TUI/docs/SPEC.md`（§3 折行口径、§15 相关）、`TUI/README.md`（配置键）、`docs/BACKLOG.md`（条目状态 / 关闭清理）。

### 明确不做的部分

- CJK 禁则（避头尾点 / 行首禁排标点）。
- 图形字符宽度治理（`SPEC.md` §15.7 已有独立机制）。
- 跨 box 行内折行（`SPEC.md` §3.1 已裁定不做）。
- 代码块内「不折行」策略（围栏内仍按现状折行 + 底色补齐）；代码叶固定 `char`, 不随全局策略变。
- 工具行参数 / 结果的特例（跟全局策略走；命令文本可能被按词断开, 接受）。
- 工具行的 5 行上限与提示行的「1 至 2 行」上限口径改动（只换折行核，不改上限）。

## 实现记录

（未开始。）

## 偏差

无。

## 测试与证据

（待实现后补。）

## 收尾

（待关闭时补。）
