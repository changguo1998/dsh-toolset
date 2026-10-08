# 排版流程重构：六步流水线（节 → box → pane → 行）

> 接取条目：`TUI/docs/BACKLOG.md`「排版流程重构：按段缓存排版结果 + 「先量后裁」」（**条目仍是旧标题**，待改写——见「收尾」）。
> 状态：决策　　开启：2026-10-09　　关闭：—
> 本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把现状「每帧对物化窗全部行重跑 `buildBox → measure/allocate/fill`」改成**六步流水线 + 四级缓冲**（节 → box → pane → 行）：帧只做「取行 + 拼接」，滚动 / 扩窗不再重排，帧成本与历史长度解耦。

- **口径变更**：原条目是「段缓存 + 先量后裁」（用户 2026-10-07 裁定）；2026-10-09 用户改为**六步流水线重设计**（当时口语称「三层」），原口径作废（其边界分析已被本文件的调研与设计覆盖）。
- **本轮范围**（用户 2026-10-09 指示）：只做调研与设计，不写实现、不改源码。

## 规划（计划改动文件清单）

设计阶段（已完成）只改文档：

1. `TUI/docs/BACKLOG.md`：条目「排版流程重构…」标〔进行中〕；按流程追加 R7 缺陷条目（未闭合围栏丢内容）。
1. 本追踪文档：建 → 写调研与设计（关闭时移入 `TUI/docs/archived/`）。

实现阶段（**未开始**）：落点按设计确定，初步范围 `TUI/src/app/layout.ts`、`TUI/src/app/layout/build-box.ts`、`layout/measure.ts` / `fill.ts`、`TUI/src/app/index.ts`、`TUI/src/app/state.ts`、`TUI/tests/`、`TUI/bench/layout-bench.mts`。

## 调研（现状事实 = 实现依据）

### R1｜现状管线与实测成本

- 每帧路径：`buildTopRegion`（`layout.ts:1573`）→ `dialogueWindow(state.buffer, state.windowGroups)`（`:1628`）取窗口切片 → `buildContentRows(win.lines, opts, dialogueTextW, activityTextW)`（`:1629-1645`）→ 两 pane 的 `ContentRow[]`；随后拼折叠占位行（`:1647-1658`）、算 `spans` / `topIdx`（`:1661-1664`）、活动 pane 按可视高切片（`:1733-1739`）。

- `buildContentRows`（`build-box.ts:905-931`）= `buildBox`（建树）→ `measure` → `allocate` → `fillToList`。**每帧都重跑这四步**，节点树每帧重建。

- 每帧还有第二处同管线调用：`queuedBlockRows`（`layout.ts:761-779`，在 `frameGeometry` 内于 `:837` 调用）；模态面板打开时第三处 `fillPanelBox`（`:1554-1565`）。三处都是全量重建。

- **已存在的缓存**（commit `9e8c499`，2026-09-19）是**文本级** memo：`layout/cache.ts`（键 = 文本 + 宽 [+ 主题]，FIFO 上限 2048，`TUI_LAYOUT_CACHE=0` 可关），命中点 `truncate`（`primitives.ts:51`）、`wrapLine`（`:82`）、`displayWidth`（`markdown.ts:558`）、`parseInlineMarkdown`（`:593`）、`wrapInlineMarkdown`（`:696`）、`wrapCodeLine`（`:773`）、`wrapAssistantLine`（`:814`）——**没有节点级 / 段级缓存**。

- 实测（本机 `cols=120 rows=40`，buffer ≈1200 行，cache on；探针跑完已删，数据留档）：

  | windowGroups | 物化规模 | 单帧（warm） | cache off |
  | --- | --- | --- | --- |
  | 3（缺省，`DIALOGUE_KEEP_REPLIES`） | 最近 3 组 | 0.47 ms | 7.16 ms |
  | 20 | 近 20 组 | 1.36 ms | 29.43 ms |
  | 200（~全量） | 全历史 | 8.58 ms | 166.15 ms |

  `npm --prefix TUI run bench` 三档（1000 行合成语料）：cold 0.50 ms / warm 0.17 ms / incremental 0.34 ms。
  → 成本随物化行数线性增长；**默认窗口已不痛，痛在窗口被撑大**（`End` 全量物化、`Home` 分批加载、扩窗后为拿几何再排一遍）。

### R2｜结构识别的现状与坑（六条）

1. **fence 跨行、未闭合吃到末尾**：`inFence` 是单次 `buildBox` 调用的局部量（`build-box.ts:240`）；fence 分支自行向后收集代码行（`:490-505`），未闭合时 `li = buffer.length - 1`（`:544-545`）。→ 不只是缓存障碍，**本身就是缺陷**（见 R7）；另有两处依赖 `inFence`（`:551` 表格判定、`:612` 合并边界）。
1. **表格前瞻吞连续行 + 列宽算死**：`isTableStart` 命中后吞「连续 `assistant` 且含 `|`」的行（`:551-563`）、`li += parsed.end - 1`（`:576`）；列宽在构建期按 `paneWidth` / `budget` 定死（`:564-571`）→ **`buildBox` 不是纯宽无关**（与 `:899-900` 注释自述不符）；代码块预折行（`:462-542`，含行号列 `numW`）与紧凑压行（`:212-213`）同样吃宽度。
1. **工具 run 分组 + step 头 + 拖尾空行吸收 + 正文合并**：`toolRun` / `flushToolRun`（`:242-291`，非工具行即冲刷 `:329`、`:691`）；`absorbActivityBlank`（`:249`、`:269`，实现 `:738-757`）会**删掉活动 pane 里已有节点**；`bodyRun` 合并（`:581-611`）会摘叶、移动、改写既有节点文本。→ 产出**不是纯局部**。
1. **绝对行号进身份**：`rowMeta.line = lineOffset + li`（`:308`），`lineOffset = win.start`（`layout.ts:1638`）；`ContentRow.line` 由 fill 带出（`fill.ts:37-38`）。
1. **`final` 在 turn-end 翻转**：`markFinalSummary` 用 `{ ...line, final: true }` **换掉行对象**（`state.ts:1183`）→ 可当版本信号；同时翻转会改变该行投向的 pane（`build-box.ts:412`）。
1. **`userStatus` 参与宽度预算**：符号直接进节点构建（`build-box.ts:365`），占固定 2 列并进 `spacer` 的 `min` 计算（`:396-404`）→ 不是纯着色。

### R3｜现有三处跨节点后处理（接缝）

`buildBox` 末尾三处全局后处理（`build-box.ts:693-705`）都会跨节点：

- `trimTrailingAssistantBlanks`（`:696`，实现 `:806-824`）：只在整 pane 末尾生效；
- `spaceUserAssistant`（`:698`，实现 `:875-889`）：user 后接 assistant 插空行 → **依赖上一段末行 kind**；
- `lineUpBlockBars`（`:700` 对话 pane、`:705` 活动 pane，实现 `:829-872`）：空行是否挂 `┃` 要看**其后**是否有同 kind 节点（`:844-851`，遇 `plain` / `separator` 停）→ **向前看跨段**。

### R4｜版本信号与状态事实

- buffer 行有稳定 `seq`（插入时分配，`state.ts:151-156`；流式续写沿用原序号 `:928-935`），`state.nextSeq` 单调递增（`:951`）。
- 行对象在**流式续写**（`buffer[lastIndex] = { ...last, text: last.text + part }`，`:926`）、**`final` 打标**（`:1183`）、**回合号回填**（`:1309`）时都是新对象 → 「按行对象身份比对」是廉价可靠的版本判据。
- 头部裁剪：`trimBufferHead`（`:939`、`:1071`、`:1298`，上限 `MAX_BUFFER_LINES = 2000`，`state.ts:67`）→ 段表须容忍窗口起点前移。
- **没有现成版本号**：state 不可变但无 revision / 内容版本 / 整体 seq；唯一单调计数器是行级 `nextSeq`；**也没有回合组对象或组 id**（`turnGroupStarts` 每次现算，`layout.ts:387-406`）。
- **每帧必变的字段**：`systemStatus.time`（5 s ticker，`state.ts:490`）、`runVirt` 相位（250 ms virt-tick，`:598`）、`inputStatus` / `agentStatus`（→ 状态符号）、`approvalDeadline`（面板内倒计时）。
- **几何的现状**：唯一来源是 App 私有字段 `paneMaxes()`（`index.ts:407-413`），键 = **state 对象引用身份**、尺寸不入键 → state 一变就整帧 `buildFrame` 只为问几何；`state.dialogueGeometry`（`state.ts:439`）与 `window-groups` action（`:2057-2061`）都**无派发点**（近似死字段）。新设计已定：这些旧结构**不必保留**（见「待续与处理口径」）。

### R5｜单帧成本的分阶段分布

同一语料（buffer 1200 行、`windowGroups=200`、cache on）：

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| `buildBox`（两 pane 一起建树） | 0.66 ms | 每帧全新节点对象图 + 每行新 `blockId` |
| 对话 pane `measure + allocate + fill` | 1.15 ms | 产出 134 行 |
| 活动 pane `measure + allocate + fill` | 4.92 ms | 产出 **2144 行**（thinking / tool / notice 全在活动 pane） |

→ 全量物化时**活动 pane 占大头**（4.92 / 6.7 ms），而渲染只用其尾部 `activityH` 行（`layout.ts:1733-1739`）——「排了 2144 行、只显示约 20 行」。这是新流程要消掉的浪费。

### R6｜既有测试与基准（实现阶段要挂的点）

- 缓存等价性范本：`tests/layout-cache.test.ts`（399 行）——「缓存开 / 关逐行一致」+ 固定种子语料 + 合帧语义；新流程须照此加等价断言（缓存开 / 关、新旧路径整帧逐行一致）。
- 帧断言与滚动：`tests/layout.test.ts`、`tests/layout4.test.ts`（3228 行，含翻页区）、`tests/scroll-anchor.test.ts`、`tests/layout-horizontal.test.ts`。
- 基准：`bench/layout-bench.mts`（cold / warm / incremental 三档，**不设阈值**）——按同形态加「大窗口 / 全量物化」档。

### R7｜未闭合围栏缺陷（已入 BACKLOG，待另修）

- 机制：fence 分支的行消费是 `li = closed ? j : buffer.length - 1`（`build-box.ts:544`）；作者假设「未闭合 → 收集循环已走到 buffer 末尾」，但收集循环还会在**首个非 assistant 行**处提前 `break`（`:496`）——此时 `closed === false`，`li` 直接跳到窗口末尾，**其后所有行既不建节点也不进任何 pane**。
- 实测（探针已删）：buffer = ```` [user 第一问][assistant final "```ts"][assistant final "const a = 1;"][user 第二问][assistant final 回答][user 第三问][assistant final 回答] ```` → 对话 pane 只剩 4 行（第一问 + 代码块），**第二 / 第三问及其回答全部不可见**。
- 触发：某条 assistant 行整行恰为围栏开启符（```` ^ {0,3}(```+|~~~+) ````，`build-box.ts:442`）且遇到下一条非 assistant 行前未闭合——典型如粘贴代码少一个结尾围栏。
- 影响：**物化窗口内该行之后的内容在画面上消失**（不改 buffer、不影响会话数据），直到该围栏行被挤出窗口才自愈。
- 处置：已写入 `TUI/docs/BACKLOG.md`（缺陷条目，交其他 agent 接取）。

### R8｜宿主事件面事实（2026-10-09 定向核对）

- **两条线**：持久线 `session/event`（全量：`assistant/attempt` 的 `{turn, step, stream}`、`assistant/message` 完整正文、`user/message`、`tool/call`、`tool/result`、`step/*`、`turn/*`）与实时线 `agent/assistant-stream`（增量：`block-start{index,blockType}` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end{index,block}` / `usage` / `finish`）。**同一内容两条线都会到**（`docs/host/DSH-CTX-API.md:60-79`）。
- **chunk 与 block 是两个层级**：chunk 是传输单元（7 变体），block 是语义单元；持久线里 chunk 还被「打包」成 `text-chunks` / `reasoning-chunks` / `tool-call-chunks` 记录（`adapter/dsh.ts:1670-1700` 逐成员展开回 delta）。
- **step 是一个事件窗口**：`step/start` → chunk\* → `tool/result?` → `step/end`（`docs/host/AGENT-ARCHITECTURE-ANALOGY.md:200`）。
- **配对有权威依据**：`tool/call` = `{turn, step, callId: block.id, name, arguments}`；`tool/result` 顶层无 callId，但 `message.callId` 有，且宿主 append 时带 `sourceEventSeqs: [callSeq]` 链回对应 call 事件（`@deepseek-ai/dsh-agent-loop/lib/index.js:684-702`）。现状 TUI 只读结果文本（`adapter/dsh.ts:440-457`）。
- **批次不会缺结果**：失败步会为未回结果的调用补写合成 `tool/result`（`TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`，rc.2 活路径；`docs/host/HOST-UPGRADE-0.2.0-rc.2.md:24,174`）→「批结果到齐」可判。
- **reasoning 只在实时线**：不进 `assistant/message`（`adapter/dsh.ts:1533` 注释），恢复会话的历史映射也没有 reasoning 分支（`:307-381`）。

## 设计（2026-10-09 定）

### 六步流水线

| # | 步 | 输入 → 产物 | 吃宽度？ |
| --- | --- | --- | --- |
| 1 | 接收 | 宿主事件 → **节缓存**（幂等合并 + 3 张记账表 + 分节 + 节内合并） | 否 |
| 2 | 结构 | 节 → **box 序列**（围栏配对 / 表格识别 / 工具配对；不插分隔） | 否 |
| 3 | 显示准备 | box → **pane 缓存 ×2**（档位过滤 → 替换符号 → 拆行 → 加边界 → 合并空行） | 否 |
| 4 | 出行 | pane 缓存 → **行缓冲**（折行 + 装饰符号 + 状态符号）+ **行数表** | **是** |
| 5 | 定位 | 偏移 → 显示索引 → 取可见行 | 是（用表） |
| 6 | 装配 | 各区域行缓冲按帧几何拼接 → 帧 → 渲染（语义色名 → 色值） | 是 |

两条真实分界（比「层」更有用）：**第 1 / 2 步之间 = 跟事件 | 跟帧**；**第 3 / 4 步之间 = 宽无关 | 吃宽度**。

### 术语（只用于「宿主 → 项目」这一步）

**块** = 宿主的内容单元（`index` + `blockType` + 全文，作用域 `(turn, step, index)`）；**节** = 项目的划分。别处沿用各自上下文。

### 缓冲

| 缓冲 | 角色 | 键 / 失效 | 丢了会怎样 |
| --- | --- | --- | --- |
| **节缓存** | 内容真源 | 无键（就是内容）；节内容变即变 | 只能从宿主日志重读（`assistant/attempt`） |
| **box 缓存** | 结构（宽无关） | 键 = 节内容版本；**节级失效**；宽度变化**不影响**它 | 可由节缓存随时重建 |
| **pane 缓存 × 2**（会话区 / 回合区） | 过滤后的 box 序列（含边界项；换行已拆开，但仍是**逻辑行**） | 键 = box 版本 + 显示档位 + 符号规则版本；任一变化 → 从 box 缓存重放 | 可由 box 缓存随时重建 |
| **行缓冲（row）× 2** | 渲染行：折行后的内容 + 装饰符号 + 状态符号 | 键见「行缓冲键的组成」 | 可由 pane 缓存重排重建 |
| 三张记账表 | 非缓冲（记账） | 按块 id | 去重 / 配对会出错 |

- 节缓存结构 = 节列表（节元数据：turn / step / 时间；条目：类型标记 + 文本 / 调用 / 结果）+ 记账（当前节指针、待开节标记、批结果计数）。
- **不做块缓存**：内容只存一份（节内条目），按块 id 只留三张记账表——① 交付账（实时线 / 结算线去重）② 工具参数累计 ③ 完成与 `interrupted` 标记。出现「按块重算 / 事后重新分节 / 按块调试」需求时再加（宿主 `assistant/attempt` 可兜底）。
- 失效链：块到达 → 节内容变 → 该节 box 失效 → pane 重放 → 行重排；**粒度按节**。
- 命名映射：本文「会话区 / 回合区」= 现状代码的 dialogue pane / activity pane。

### 分节规则

1. 边界：**用户输入**、**notice**（各自独立成节）、`step/start`、**批结果到齐之后**；`tool/call` 不开节。
1. 开节**惰性**：只在第一条内容落地时建节 → 结构上无空节。
1. 一节最多一批工具调用（并发多条算一批）；该批结果全部到齐后才置「开新节」。
1. notice 与用户消息同行为：封闭当前节、自成节、其后开新节。

### 节内合并

1. 按**类型**归并，不被 reasoning / assistant 交错切断（`r1 a1 r2 a2` → `reasoning = r1+r2`、`assistant = a1+a2`）；顺序按各类型首次出现。
1. 同类型文本**直拼**（不补分隔符）；工具调用 / 结果各自成组，保留 `name` / `args` / `callId`。
1. 条目保留类型标记（user / assistant / reasoning / tool-call / tool-result 等）。
1. 归并**不跨节**。

### 节 → box（宽无关）

- 粒度：**一个节 → 一个 box 序列**（有序），按结构边界拆。例：节内正文夹代码块 → `正文 / 代码块 / 正文` 至少三个 box。
- 结构识别在**这一层**：围栏配对（→ 代码块，带语言标记与代码原文行）、表格识别（→ 表格，单元格原文 + 对齐）、工具调用与结果配对（状态 `✓` / `✗`），**工具批 = 整批一个 box**（调用 1..N + 结果 1..N 合成一个，内部保留各条 `name` / `args` / `callId` / 状态）。
- box 属性：`turn` / `step` 编号 + 分类（来源 `user` / `assistant` / `reasoning` / `tool` / `notice`；结构 `text` / `code` / `table` / `call` / `result`）+ 内容（文本原文 / 代码行 / 单元格 / 调用参数 / `callId` / 结果状态）。
- **不插任何分隔内容**：空行、step 头、回合分隔线都不在这层产生（step 头也不是 box）；分隔全部由 pane 构建按「相邻 box 的 `turn` / `step` / 分类**变化**」推导。
- 宽相关一律挪到第 4 步：代码块折行 + 行号列宽（`build-box.ts:462-542`）、表格列宽与窄宽降级（`:551-578`）、紧凑模式截断（`:89-98`、`:212-213`）。
- 时间（step 头显示用）存在节元数据；box 只带号，按号回查。

### pane 构建（box 缓存 → pane 缓存）

- 产物：**两个 pane 缓存**——会话区、回合区。
- 归属沿用现状：`user` 与 `final` 正文 → 会话区；`reasoning` / 工具批 / 非 final 正文 / notice → 回合区；回合区按 turn 边界清理。
- 五步顺序：① **档位过滤**（追加时跳过 box，如 `tool` 档跳 reasoning）→ ② **替换符号**（跳过代码：`normalizeSymbols` + `resolveSymbolRules`，`symbol-normalizer/src/symbols.ts:429` / `:295`；掩码用 `maskCodeSpans`，`:420`，围栏与内联代码都掩）→ ③ **拆行**（去掉换行符，文本类 box 拆成**逻辑行 box**；**代码块与表格不拆**）→ ④ **加边界**（`step` 变化 → step 头；`turn` 变化 → 回合分隔线；分类变化 → 空行；pane 首尾留白）→ ⑤ **合并空行**（连续空行并成 1 个；代码块内不合并）。
- 过滤**改内容**：pane 缓存存过滤后的副本，box 缓存保留原文；档位切回时从 box 缓存重放。
- 跨 box 的规则：空行合并要看已追加的前一个 box；档位跳过会让前后同类 box 变相邻，**新相邻关系要重新参与间隔判定**——这也是过滤必须排在「加边界」之前的原因。
- **不在这一步**：宽度折行、竖线连通（判据是 `minWidth` 对可见宽的比较）；顶部「更早回复已折叠」占位行（依赖窗口 `dropped`，**不入 pane 缓存**，装配 / 裁时插）。

### box → row 排版

- 输入：pane 缓存（逻辑行 box）+ 宽度；产物：**行缓冲**（row）。
- 做：折行；加**一切用到宽度的东西**——装饰性符号（左 / 右 `┃` 竖线、`╌` 尾部铺满、代码块 `┃` bar 与行号列、边框、右缘留白补齐、空行竖线连通）与**状态符号**（`✓` / `✗` / `■` / `?` / `←`、`●` / `○` / `△` 按行落位）。
- 口径：**凡是要用宽度才能定的，都在这一步或更后加** → box 缓存与 pane 缓存不含任何宽度信息；行缓冲的键含宽度。
- 状态符号落在行层 → 它每帧变化（tick）只影响那几行，不牵连上游缓存。

### 行数表

- 每段一行数（宽度相关）+ **前缀和**：查总行数、「第 N 行在哪段」都是 O(log n)，不必重排。
- 更新：段内容变 → 只更新受影响的段；宽度变 → 全量重算。
- 用途：滚动上限、能不能继续滚、「扩窗后有多少行」、偏移 ↔ 绝对索引换算。

### 滚动位置模型（不加 `follow`）

- 位置 = **偏移**（距结尾的行数；0 = 贴底）+ **显示索引**（`topIdx = 总行数 − 可见行数 − 偏移`）。
- **偏移 = 0** → 新增行后**重算显示索引**（贴底）；**偏移 ≠ 0** → 新增行**不动显示索引**（画面内容不动，偏移随总行数一起变大）。
- 手动 / 程序之分靠偏移本身：用户手动滚动改偏移 / 索引；程序（追加、流式、扩窗、resize、档位切换）按上面的规则处理，不额外引入标志位。
- 两种情形走**全量重算**：① **上方插入行**（扩窗、上方段变高）→ 偏移天然不变，画面自然不动；② **宽度变化**（行号全变）→ 按「**段 + 段内偏移**」换算一次新索引（换算不出则退回贴底）。

### 入口与边界

- **自造内容走同一流程、独立成节**：`/help` 输出、shell 输出、自造的 notice、命令输出等与宿主块一视同仁（只是没有宿主块 id，产生方直接给节内容）。
- **非会话区域直接构造 box、跳过节缓存**：状态列 / 标题栏 / 输入区 / 提示区 / 面板的输入是 state 字段，不是流式长内容，不需要分节与合并。
- **区域缓冲生命周期**：会话区、回合区长期存在（按段失效）；面板类**按需**（打开建、关闭丢）。
- **帧装配 = 拼接**：每个区域各自一份行缓冲（宽度 = 该区域文字宽）；帧几何定各区域的行 / 列区间；每帧行 = 各区域该行片段按列拼起来，不足补留白；滚动只是各区域缓冲取不同起点行。

### 主题

- **主题只决定色值，全部归渲染层**；排版产物（行 / 段）只带**语义颜色名**（`assistant` / `reasoning` / `code` / notice tone…）；色名 → 色值只在 `theme.ts`。
- 因此结构层、行数表、行缓冲都**不含主题**；切主题 = 重放渲染，不触发任何上游失效。
- 顺手清掉历史遗留：`parseInlineCache` / `wrapInlineCache` / `wrapAssistantCache` 的键带了 `themeId`（`themeSizedKey`），而解析本身不读它（`inlineSegments`，`markdown.ts:602` 注释即「主题仅进缓存键」）→ 新键只留「文本 + 宽度」。
- 边界：**字形 / 分段 / 宽度类差异不属于主题**（要的话另开维度，并自觉进结构缓存键）。

### 遮蔽（compaction shadowed）

- `compaction/prune` 的 `shadowedSeqs` → 按 seq 找到覆盖的 box，打 **`shadowed` 标记（box 层，宽无关）**；判定 = 该 box 覆盖的 seq 与 shadowed 集合**有交集即整块打标**。
- 显示：**整块渲染成灰**（覆盖 reasoning / 工具 / 代码原有颜色；字形保留）——灰属颜色，落行层 / 渲染层。
- **内容不改、不删行**；摘要文本仍只进提示，不插会话区。
- 容量策略：各缓冲看情况扩容，**不做频繁清理**。

### 冻结 / 活跃 两套

- 每一级（节 / box / pane / 行）都分两套：**冻结集**（append-only、版本稳定、派生结果可缓存且只随宽度 / 档位 / 符号规则失效）+ **活跃集**（tail，可变、每帧重算、不缓存）。

| 级 | 冻结部分 | 活跃部分（tail） |
| --- | --- | --- |
| 节缓存 | 已冻结节列表 | 当前节（可变） |
| box 缓存 | 每个冻结节的 box 序列 | 当前节的 box 序列 |
| pane 缓存 × 2 | 冻结节贡献的项（含边界项） | 当前节贡献的项 |
| 行缓冲 | 冻结节的行 + 行数表项 | 当前节的行（每帧重算） |

- **对齐约束**：因为按类型归并允许节内回写条目（`r1 a1 r2 a2` → `assistant = a1+a2`），细级的冻结**不能早于「该节不再新增内容」**——冻结点由上游信号统一决定。
- **两个定型信号**：① **`assistant/message`**（宿主每 step 必发的完整正文）→ 可冻结该 step 的条目 / box / pane 项 / 行；② **新开节**（用户输入 / notice / `step/start` / 批结果到齐）→ 该节彻底封版。
- **执行时机**：事件到达只**标记「可冻结」**，实际冻结在**帧边界**统一做。
- **取行跨越边界**：渲染 = 冻结集 + 活跃集拼接；行数表同样分两段（冻结前缀和 + 活跃实时算）。

### 处理流程

1. 宿主事件到达（持久线全量 + 实时线增量，同一内容两条线都可能到）；
1. 接收：按块 id 幂等合并（delta 追加 / 全文补后缀或替换）+ 维护三张记账表；判节边界 → 惰性开节；
1. 写条目：同类型直拼、reasoning 与 assistant 交错也各自归并、工具批成组带 `callId`；不过滤；
1. 节 → box（宽无关）：结构识别 + 拆 box + 分类标记；不插分隔内容；
1. pane 构建：档位过滤 → 替换符号 → 拆行 → 加边界 → 合并空行；
1. box → row 排版：折行 + 装饰与状态符号 → **行缓冲**；同时更新**行数表**；
1. 显示 / 滚动：偏移 = 0 贴底重算索引；偏移 ≠ 0 索引不动；上方插入或宽度变 → 全量重算；
1. 触发分工：**接收跟事件**（去重不能延迟）、**处理与排版跟帧**（帧边界补算脏段并执行冻结）、显示每帧。

### 行缓冲键的组成

- **进键**：pane 缓存版本 + 区域文字宽（会话区 / 回合区各自不同）+ **字符宽度实测表版本**。
- **不进键**（只影响渲染 / 装配 / 切片）：主题、焦点态、面板开关、区域**高度**、滚动位置、TTY / `NO_COLOR`。
- **归属上游、不重复**：`gutter`、显示档位（`verbose` / `collapse`）、符号规则（已在 box / pane 键）。
- **特例**：含状态符号的行不入行缓冲缓存、每帧重算（符号格恒 2 列，只换字形，不动行结构）。

### 待续与处理口径（实现按此执行）

| # | 待续项 | 口径 |
| --- | --- | --- |
| 1 | 旧结构退场 | **不必保留旧结构**：`state.buffer`、`seq` 锚点、`paneMaxes`、`dialogueGeometry`、`windowGroups` 都按新口径重写 / 删除；无派发点的死 action（`window-groups` / `anchor-resolved`）一并清理 |
| 2 | 会话恢复 | 写「事件 → 节」重放器（沿用 `normalizeHistoryMessages` 的映射思路）；reasoning 恢复不到就缺失，不造占位 |
| 3 | 宽度表失效传播 | 先全量重算（正确性优先），「按段失效」留作优化 |
| 4 | 容量与清理 | 不设硬上限；会话切换 / 清屏时释放；头部裁剪**按段整体丢**，不切断段 |
| 5 | 触发与调度 | 接收跟事件、处理 / 排版跟帧；沿用同 tick 合帧 + `frameIntervalMs` 限帧；冻结与脏段补算都在帧边界 |
| 6 | 光标 / 焦点框 | caret 由行层产出（同现状口径）；焦点框纯覆写框线色、不进任何缓冲 |
| 7 | 非会话区域的 box | 复用现有 builder（`statusBlocks` / `buildActivePanelBox` 等）产出 box，只换驱动方式 |
| 8 | 测试与迁移 | 照 `layout-cache.test.ts` 范式加等价性与计数断言；bench 加「大窗口 / 全量物化」档；帧断言全绿后切换 |
| 9 | 收尾 | 改写 BACKLOG 条目（标题 / 验收换口径）与工作量重估；关闭后回写 DESIGN / SPEC / README |

## 实现记录

（未开始。）

## 测试与证据

本轮为调研 + 设计阶段，无代码改动。证据 = 上文 `文件:行号`；三张实测表来自三个临时探针（`tmp/seg-probe.mts` / `tmp/phase2-probe.mts` / `tmp/fence2-probe.mts`，跑完已删，数字已抄录进 R1 / R5 / R7）与既有基准：

```
buildFrame 基准｜cols=120 rows=40 buffer≈1000 行｜iterations=30
mode          cache off      cache on      speedup
cold          7.30 ms        0.50 ms       14.6×
warm          6.58 ms        0.17 ms       38.6×
incremental   10.67 ms       0.34 ms       31.6×
```

## 收尾

（未关闭。待办：BACKLOG 条目改写 → 实现；关闭时本文件移入 `TUI/docs/archived/`。）
