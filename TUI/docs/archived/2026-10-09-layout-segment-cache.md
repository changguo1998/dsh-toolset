# 排版流程重构：六步流水线（节 → box → pane → 行）

> 接取条目：`TUI/docs/BACKLOG.md`「排版流程重构：六步流水线（节 → box → pane → 行）」。
> 状态：决策　　开启：2026-10-09　　关闭：—
> 本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把现状「每帧对物化窗全部行重跑 `buildBox → measure/allocate/fill`」改成**六步流水线 + 四级缓冲**（节 → box → pane → 行）：帧只做「取行 + 拼接」，滚动 / 扩窗不再重排，帧成本与历史长度解耦。

- **口径变更**：原条目是「段缓存 + 先量后裁」（用户 2026-10-07 裁定）；2026-10-09 用户改为**六步流水线重设计**（当时口语称「三层」），原口径作废（其边界分析已被本文件的调研与设计覆盖）。
- **本轮范围**（用户 2026-10-09 指示）：只做调研与设计，不写实现、不改源码。

## 规划（计划改动文件清单）

### 已完成（调研与设计，只改文档）

1. `TUI/docs/BACKLOG.md`：条目「排版流程重构…」标〔进行中〕；追加 R7 缺陷条目（未闭合围栏丢内容，现已暂停）。
1. 本追踪文档：建 → 写调研与设计。

### 计划改动文件清单（实现阶段）

**新增**（新流水线的落点，按节 / box / pane / 行分层）：

| 文件 | 职责 |
| --- | --- |
| `TUI/src/app/layout/pipeline/types.ts` | 四种缓冲与位置模型的类型（节 / box / pane 项 / row / 行数表 / 偏移） |
| `TUI/src/app/layout/pipeline/sections.ts` | 接收：块 → 节（幂等合并 + 三张记账表 + 分节规则 + 节内合并 + 冻结标记） |
| `TUI/src/app/layout/pipeline/boxes.ts` | 节 → box 序列（围栏配对 / 表格识别 / 工具批一个 box / 分类标记） |
| `TUI/src/app/layout/pipeline/panes.ts` | pane 构建五步（档位过滤 → 替换符号 → 拆行 → 加边界 → 合并空行），两个 pane |
| `TUI/src/app/layout/pipeline/rows.ts` | box → row（折行 + 装饰 / 状态符号）+ 行数表 + 偏移 ↔ 索引 + 全量重算两种情形 |
| `TUI/src/app/layout/pipeline/assemble.ts` | 帧装配（各区域行缓冲按几何拼接）+ 折叠占位行插入 |
| `TUI/src/app/layout/pipeline/replay.ts` | 会话恢复：宿主事件 → 节的重放器 |
| `TUI/tests/pipeline-*.test.ts` | 分级单测（见下面每批的验收）+ 等价性（新旧路径逐帧逐行一致） |

**改造**：

- `TUI/src/app/adapter/dsh.ts`：`applyChunk` / `completedBlocks` / `emittedByBlock` 的去重逻辑改为产出「块 + 冻结信号」，不再直接写 buffer 行；补读 `message.callId` / `sourceEventSeqs`。
- `TUI/src/app/layout/markdown.ts`：缓存键去掉 `themeId`（`themeSizedKey` → `sizedKey`）。
- `TUI/src/app/layout/measure.ts` / `fill.ts` / `primitives.ts` / `table.ts`：作为第 4 步的算法库复用（折行、尺寸、填充），只换调用方与键。
- `TUI/src/app/index.ts`：帧循环接新流水线（标脏 → 帧边界补算脏段 + 执行冻结 → 装配）；滚动 / 扩窗 / 位置读写改新模型；非会话区域交给装配。
- `TUI/src/app/state.ts`：**退场**旧结构（`state.buffer`、`seq` 锚点、`dialogueGeometry`、`windowGroups`、`window-groups` / `anchor-resolved` 死 action）；保留状态字段与事件语义。
- `TUI/src/app/layout.ts`：从「每帧全量构帧」退化为装配入口（旧 `buildTopRegion` / `frameGeometry` 的口径被新流程取代）。
- `TUI/bench/layout-bench.mts`：加「大窗口 / 全量物化」档。

### 分批（依赖顺序；每批独立可验证）

| 批 | 内容 | 估时 | 验收 |
| --- | --- | --- | --- |
| 0 | 流水线骨架 + 新旧路径开关（`TUI_LAYOUT_PIPELINE` 风格，供等价性对照） | 1-2 h | 编译通过；关 = 行为不变 |
| 1 | 接收（`sections.ts` + adapter 改造） | 0.5 天 | 两条线重复交付只入一次；`r1 a1 r2 a2` 归并；无空节；工具批按 `callId` 配对 |
| 2 | 节 → box（`boxes.ts`，围栏配对**重写**） | 0.5 天 | box 序列形态断言；**未闭合围栏之后的内容仍在**（原 R7 用例）；代码 / 表格不拆 |
| 3 | pane 构建（`panes.ts` + 复用 `symbol-normalizer`） | 0.5 天 | 两 pane 缓存开 / 关逐项一致；档位切换重放正确；空行合并（代码块内不合并） |
| 4 | box → row + 行数表 + 位置模型（`rows.ts`） | 1 天 | 新旧路径逐帧逐行一致（宽度 × 档位矩阵）；宽度不变不重排（计数断言）；滚动 / 扩窗只查表 |
| 5 | 装配 + 接管 + 旧结构退场（`assemble.ts`、`index.ts`、`state.ts`、`layout.ts`） | 0.5 天 | 既有帧断言全绿；真机滚动 / 扩窗 / 流式 / 面板目视 |
| 6 | 恢复、失效传播、容量、文档回写、条目改写 | 0.5 天 | 恢复用例；宽度表切换用例；DESIGN / SPEC / README 更新 |

合计约 **3.5-4 天**（含等价性回归；不含真机验收往返）。

### 明确不做（本任务范围外）

- **未闭合围栏缺陷不单独修**：随第 2 批的围栏重写验证，**不作为验收条件**（BACKLOG 条目已标暂停）。
- 优化项留后：宽度表「按段失效」、按块重算、缓冲硬上限、字形维度（`glyphSet`）。
- 滚动与键位类条目（BACKLOG 条目 5 / 6 / 7）不在本任务内，重构完成后另行接取。
- 配色 / 视觉调整（主题只换色值，不在此列）。

### 细分与拆分方案（提案；经子代理审阅后定稿）

**审阅安排**（用户 2026-10-09：不能全程盯，改由子代理把关）：设计定稿后开两个只读审阅子代理——① 设计一致性与内部自洽；② 迁移面与可验证性。审阅结论并入本文档「规划」，再据此拆分条目。

**拆分提案**：把实现拆成 3 条 BACKLOG 条目，各自走标准流程（接取 → 追踪文档 → 实现 → 测试 → 人工确认 → 提交询问），每条实现前 / 后各过一次子代理审阅；原条目「排版流程重构」在拆分落地后关闭（设计交付物 = 本文档）。

| 条目 | 覆盖批 | 内容 | 落点 | 估时 |
| --- | --- | --- | --- | --- |
| A｜骨架 + 接收 + 结构 | 0-2 | 流水线骨架与新旧开关；块 → 节（幂等合并 / 记账表 / 分节 / 节内归并 / 冻结标记）；节 → box（围栏配对重写 / 表格 / 工具批一个 box / 分类标记） | `pipeline/{types,sections,boxes}.ts`、`adapter/dsh.ts` | 1-1.5 天 |
| B｜显示准备 + 出行 | 3-4 | pane 构建五步（两 pane）；box → row（折行 + 装饰 / 状态符号）；行数表 + 偏移 / 索引 + 全量重算两种情形 | `pipeline/{panes,rows}.ts`、`markdown.ts` | 1.5 天 |
| C｜装配 + 接管 + 收尾 | 5-6 | 帧装配与非会话区域；旧结构退场（`state.buffer` / 旧锚点 / 死 action）；恢复重放器；宽度表失效；容量清理；文档回写 | `pipeline/{assemble,replay}.ts`、`index.ts`、`state.ts`、`layout.ts`、`tests/`、`bench/` | 1-1.5 天 |

依赖：A → B → C（严格顺序；B 需要 A 的节 / box 产物，C 需要 B 的行缓冲与行数表）。

**批 0-1 细分（条目 A 的前半）**

类型骨架（`pipeline/types.ts` 草案，落地时以代码为准）：

```ts
type Source = "user" | "assistant" | "reasoning" | "tool" | "notice";
type Shape = "text" | "code" | "table" | "call" | "result" | "batch";
interface ToolCall { callId: string; name: string; args: string; seq: number }
interface ToolResult { callId?: string; callSeq?: number; ok: boolean; detail: string }
interface Item { source: Source; text?: string; calls?: ToolCall[]; results?: ToolResult[]; seqs: number[] }
interface Section { turn: number; step: number; time?: number; items: Item[]; frozen: boolean }
interface Box { turn: number; step: number; source: Source; shape: Shape; text?: string;
                code?: { lang: string; lines: string[] }; table?: unknown;
                batch?: { calls: ToolCall[]; results: ToolResult[] }; shadowed?: boolean }
```

模块接口（草案）：

- `sections.ts`：`createStore()`；`ingest(store, block: BlockEvent)`（幂等合并 + 分节 + 记账 + 冻结标记）；`sections(store)`；`active(store)`。
- `boxes.ts`：`buildBoxes(sec: Section): Box[]`（纯函数、宽无关）。
- 冻结信号：`assistant/message` → 标记该 step 可冻结；新开节 → 封版；实际冻结在帧边界执行。

用例清单（条目 A 的验收）：

| 批 | 用例 |
| --- | --- |
| 1 | ① 同一 `(turn, step, index)` 的实时 delta 与结算全文只入一次；② `r1 a1 r2 a2` → 两个条目（reasoning / assistant 各自归并）；③ 连续 `step/start` 不产生空节；④ 并发 3 条工具调用按 `callId` 配对成一批；⑤ notice / 用户输入各自独立成节 |
| 2 | ⑥ 正文夹围栏 → `正文 / 代码块 / 正文` 三个 box；⑦ 表格整体一个 box；⑧ 工具批一个 box；⑨ **未闭合围栏之后的内容仍进 box**（原 R7 用例）；⑩ `turn` / `step` / 分类标记正确；⑪ `shadowed` 有交集即整块打标 |

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

### R7｜未闭合围栏缺陷（已随批 2 消除，BACKLOG 条目已关闭）

- 机制：fence 分支的行消费是 `li = closed ? j : buffer.length - 1`（`build-box.ts:544`）；作者假设「未闭合 → 收集循环已走到 buffer 末尾」，但收集循环还会在**首个非 assistant 行**处提前 `break`（`:496`）——此时 `closed === false`，`li` 直接跳到窗口末尾，**其后所有行既不建节点也不进任何 pane**。
- 实测（探针已删）：buffer = ```` [user 第一问][assistant final "```ts"][assistant final "const a = 1;"][user 第二问][assistant final 回答][user 第三问][assistant final 回答] ```` → 对话 pane 只剩 4 行（第一问 + 代码块），**第二 / 第三问及其回答全部不可见**。
- 触发：某条 assistant 行整行恰为围栏开启符（```` ^ {0,3}(```+|~~~+) ````，`build-box.ts:442`）且遇到下一条非 assistant 行前未闭合——典型如粘贴代码少一个结尾围栏。
- 影响：**物化窗口内该行之后的内容在画面上消失**（不改 buffer、不影响会话数据），直到该围栏行被挤出窗口才自愈。
- 处置：已写入 `TUI/docs/BACKLOG.md`（缺陷条目）；2026-10-09 裁定**暂停**，等排版流程重构完成后再复检是否仍存在——**不作为重构的验收条件**，重构前也不单独修。
- **复检结论（2026-10-09）：已随批 2 消除，条目关闭并从 BACKLOG 移除。** 批 2 的围栏配对（`pipeline/boxes.ts:18,31,180`）只看**本条目文本**，未闭合 = 本条目文本用尽，不吞后续条目 / box；且默认路径已是流水线（`pipeline/flag.ts:8` 默认开），生产的构帧不再走旧 `build-box.ts` 的 fence 分支（那条 `li = closed ? j : buffer.length - 1` 仅存于回落路径）。真机复检：assistant 输出未闭合围栏 + 其后一行，行**仍在**（作为代码块内容显示，符合「未闭合仍是普通代码块」口径）。判据固化在 `tests/pipeline-boxes.test.ts` ④（未闭合围栏之后的内容仍在，含后续条目 / 节）。

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
- **不做块缓存**：内容只存一份（节内条目），按块 id 只留三张记账表——① 交付账（实时线 / 结算线去重，含宿主事件 `seq` 去重集合）② 工具参数累计 + 调用归属（`callId` → 节下标）与待配对集合（按 step 键）③ 完成（整块参数已到）/ `interrupted` / 定型标记。出现「按块重算 / 事后重新分节 / 按块调试」需求时再加（宿主 `assistant/attempt` 可兜底）。
- 失效链：块到达 → 节内容变 → 该节 box 失效 → pane 重放 → 行重排；**粒度按节**。
- 命名映射：本文「会话区 / 回合区」= 现状代码的 dialogue pane / activity pane。

### 分节规则

1. 边界：**用户输入**、**notice**（各自独立成节）、`step/start`、**批结果到齐之后**；`tool/call` 不开节。
1. 开节**惰性**：只在第一条内容落地时建节 → 结构上无空节。
1. 一节最多一批工具调用（并发多条算一批）；该批结果全部到齐后才置「开新节」。
1. notice 与用户消息同行为：封闭当前节、自成节、其后开新节；notice / shell 无 `(turn, step)` 归属时**继承最近一次带归属的交付**（不用 0 兜底——会开出 0/0 假节，回合分隔线与 step 头都会错）。
1. `step/start` **幂等**：同 `(turn, step)` 已有节或内容时只记元数据（时间戳），不切节——持久线重放与两线无序都会让 step-start 迟到。
1. **边界优先于迟到回写**：`待封闭`（批结果到齐 / 回合结束）置位后，下一块内容**另起新节**，即使 scope 相同。
1. **迟到交付回写原节**：`(turn, step)` 已有节（含已封闭节）时把内容写回该节并撤销其冻结，不新开错序节——两线无序与恢复重放都会造成迟到；这也是「冻结集 append-only」的例外，派生缓存按节失效即可。

### 节内合并

1. 按**类型**归并，不被 reasoning / assistant 交错切断（`r1 a1 r2 a2` → `reasoning = r1+r2`、`assistant = a1+a2`）；顺序按各类型首次出现。
1. 同类型文本**直拼**（不补分隔符）；工具调用 / 结果各自成组，保留 `name` / `args` / `callId`。
1. 条目保留类型标记（user / assistant / reasoning / tool-call / tool-result 等）。
1. 归并**不跨节**；但**工具批不拆**：结果按 `callId` 回到调用所在节（即使该节已封闭，如 steer 插话落在批中间时），批始终是一个 box。
1. 文本幂等：**增量只来自实时线**（逐 chunk），结算线按块投递一次 `full`；接收层用「交付账 + 前缀对齐」对账——整块更短时保留既有内容（append-only 设备不回写），更长时补后缀。原文 doc「全文补后缀**或替换**」中的「替换」**不做**（无块缓存，无法回写已归并文本）。

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

**批 0（完成）**：新增 `src/app/layout/pipeline/types.ts`（块交付 / 节 / 条目 / 工具调用与结果；只放宽无关两级）与 `pipeline/flag.ts`（`TUI_LAYOUT_PIPELINE` 开关，照 `layout/cache.ts` 写法：环境变量只作初始值，运行时可用 `setPipelineEnabled` 切换）。

**批 1（接收层完成，adapter 接线待做）**：新增 `src/app/layout/pipeline/sections.ts`——纯函数接收层（`createSections` / `applyDelivery` / `applyAll` / `freezeAtFrameBoundary` / `allSections` / `itemOf`）：幂等合并（实时增量与结算整块两条线交叉重放只入一次、结算补齐缺失后缀）、三张记账表（交付账 / 工具参数累计 / 完成与中断标记）、分节规则（user / notice / shell / step-start / 工具批结果到齐为边界，惰性开节 → 无空节）、节内按来源归并（`r1 a1 r2 a2` → `reasoning = r1+r2`、`assistant = a1+a2`，顺序按首现）、冻结口径（封闭节即定型；当前节待定型信号 + 帧边界；追加则撤销冻结）。

落定时修正两处设计细节（已按此实现）：① 批结果到齐的「待开节」在**结果入账之后**才置位（否则结果被推到新节、与调用分离）；② `interrupted` **不置**待开节、只清空待配对集合（中断后到达的结果正属本节那批）。

**批 1b（完成）**：adapter 产出「块交付」——`RealAdapterOptions.onDelivery` 可选 sink（缺省零开销）；投递点 = text 增量（实时线）与结算整块（结算线按块聚合一次 `full`，step 级 `index = -1`）/ step-start / tool-call（`full` 整块参数）/ tool-result（配对键兼容 `data.callId` 与 `message.callId`）/ assistant-message 定型与中断 / turn-end / 自造 notice；`liveScope` 跟踪当前 `(turn, step)`，**归属不可知就不投递**（不拿 0 兜底）。

**批 1 审阅修复（只读子代理报告 7 条，全部落地）**：

1. 文本幂等：删掉「`completed` 永久拦截」；改成交付账 + 前缀对齐（整块先到 + 更长内容后到 = 补后缀；增量重放 = 跳过；空整块不再吞后续内容）；结算线改为按块投递 `full`（不再逐成员重放 delta）。
1. 工具结果：新增 `seq` 去重、`callId → 节下标` 归属表（结果回到调用所在节，批不拆）、待配对集合**按 step 键**（不再跨 step 泄漏）、无 `callId` 时按到达顺序消费第一个待配对项、结果早于调用时调用侧不再登记等待。
1. 工具参数：交付补 `full` 标记；整块先到则忽略其后增量分片（原先会拼成 `{"cmd":"ls"}{"cmd":"ls"}`）。
1. 归属：`liveScope` + 接收层 `lastScope`（notice / shell 继承），去掉 0 兜底。
1. `step/start` 幂等（同 scope 重复 / 迟到不切节）；边界优先于迟到回写。
1. 迟到块回写原节（不新开错序节）。
1. 迁移面：交付与条目补 `seq`、`Section.final`（turn-end 标记最终总结节）、`readonly` 数组类型；`turn-end` 作为回合边界交付。

**批 2（完成）**：`boxes.ts`——节 → box 序列（正文 / 代码块 / 表格 / 工具批），围栏配对只看本条目文本（未闭合不再吞后续内容，原 R7 缺陷在新路径结构上不可能发生）；复用 `layout/table.ts` 解析表格；工具批整批一个 box；不插分隔内容。条目累积宿主事件号，`applyShadowed` 按交集给 box 打遮蔽标记；adapter 转发 `compaction/prune` 的 `shadowedSeqs`。用例 9 例。

**批 3（完成）**：`panes.ts`——box → pane 缓存 ×2（会话区 / 回合区），五步齐备：档位过滤（`think` / `tool` / `step`）→ 替换符号（只作用于文本，代码 / 表格跳过）→ 拆行（文本拆逻辑行，代码与表格整块）→ 加边界（step 头 / 回合分隔线 / 分类变化空行）→ 合并空行。归属：`user` 与 final 节正文 → 会话区，其余 → 回合区。边界项只带位置与元数据（文案由第 4 步按宽度渲染）。用例 7 例。

**批 4 上半（完成）**：`rows.ts` 的行数表与位置模型——段行数 + 前缀和（二分定位段 / 段内偏移）、单段增量更新与追加段；偏移 ↔ 显示索引互换；贴底重算索引、非贴底索引不动；上方插入 / 宽度变化按「段 + 段内偏移」remap，换算不出退回贴底。用例 5 例。

**批 4 下半（完成）**：`rows.ts` 出行层——pane 项 → 旧口径缓冲行（文本 / 代码块 / 表格 / 工具批 / step 头 / 回合分隔线 / 空行）→ 复用 `buildContentRows`（`measure` / `allocate` / `fill` + markdown 折行 + 表格渲染），逐项行数进线表；行缓存键 =（box 身份，区域宽，档位，紧凑），`rowRenderMisses` 供计数断言。为让行缓存有稳定身份，box 缓存按节身份、拆行缓存按 box 身份（封闭节对象不可变，迟到回写换新对象）。

**口径对齐（等价性逼出来的三处，已写进实现）**：

1. **step 头恒进回合区**（旧口径：step 头由 `appendToolLine` 插入 ⇒ kind = tool）；该 step 无回合区内容时是「孤儿头」，与旧路径一致。
1. **回合分隔线只在会话区**（旧路径的 `separator` 行进对话 pane）。
1. **档位过滤只去思考**（`tool` / `step`）；工具批内部的**结果行**由第 4 步沿用旧渲染器按档位裁掉，正文与 notice 保留。
   另：独立自足节（用户 / notice / shell）**不参与迟到回写**——否则同 scope 的 step 内容会串进用户节。

**等价性与计数（c3 / c4 的当前证据）**：`tests/pipeline-equivalence.test.ts` 用同一语料（用户 / 正文 / 思考 / 工具批 / 代码块 / 表格 / notice / 多 step / 多回合）走新旧两条路径，宽度 40 / 80 / 120 **逐行一致**；档位 `think` / `tool` / `step` 逐行一致；计数断言：宽度不变重复出帧 → 内容项零重排，宽度变化 → 全量重排，档位切换 → 重排回合区。

**批 5（接管接缝完成）**：`pipeline/frame.ts`（节缓存 → 两 pane 内容行；渐进窗口按回组合丢弃、分组复用既有 `turnGroupStarts`、窗口起点落在节中间时抑制首个 step 头、行身份合成 seq 保旧锚点模型）、`state.ts` 的 `AppState.pipeline` 与 `pipeline-state` action、`layout.ts` 的 `buildTopRegion` 双来源分支、`index.ts` 的 sink 注册与节缓存持有（会话切换重建；`/cls` 清空；`main.ts` 透传 sink 容器）。**整帧等价**：`tests/pipeline-frame.test.ts` 同一语料两条路径 `buildFrame` 逐行一致（2 / 5 回合 × 60x24 / 100x30 / 120x40），恢复重放（缓冲行 → 节）后同样逐行一致。

**c5 证据**：同窗重复出帧零重排；扩窗（3 → 6 组）只排新纳入的更早段（`rowRenderMisses` 计数断言）。

**批 6 前半（完成）**：`pipeline/replay.ts` 恢复重放器（分隔线推回合、step 头推 step、文本按同 kind 连续块聚合、final 块结束时补定型 + 回合结束、工具行还原调用 / 结果）；`App.restoreStartupHistory` 落定后重放节缓存。

**批 5 收尾（完成）**：默认路径已切换（`flag.ts` 缺省开启，`TUI_LAYOUT_PIPELINE=0` 回落）；App 仅在「开关开启 + 注入 sink」时接管（测试 / 嵌入用法不受影响）。文档回写完成（SPEC §9.1 / DESIGN 排版分层 / README 路径开关）。

**App 级等价（新增）**：`tests/pipeline-app.test.ts`——真实 App 装配（sink 注册 → 接收 → 节缓存 → buildTopRegion → 帧）下新旧路径逐步整帧一致（step 头 / 思考 / 工具批 / 正文流片段 / notice / 回合结束）；为此补了回合开始交付（`turn-start`，App 的 turn-begin 时间真源；宿主 `turn/start` 只回填回合号）。唯一已知瞬时差异：分隔线回合号旧路径靠 `turn/start` 回填（晚一帧），用例中整行归一。

**剩余（等待人工验收 c6 后收尾）**：真机目视（滚动 / 扩窗 / 流式 / 面板）→ 通过后清理 BACKLOG 条目并把本追踪文档移入 `TUI/docs/archived/`。`index.ts` 帧循环取新流水线的两 pane 行缓冲（`renderPane`）替代 `buildTopRegion` 的内容行来源；滚动 / 扩窗改新位置模型（偏移 + 显示索引，`rows.ts` 已备）；行身份从「buffer seq 锚点」迁到新模型（旧 `state.buffer` / `seq` 锚点 / `dialogueGeometry` / `windowGroups` 退场，见待续表 1）；帧级等价性矩阵（宽度 × 档位 × 扩窗档）与计数断言全绿后切默认路径。

**真机验收轮（2026-10-09 晚，herdr 开新 tab 实测；发现五类缺陷并全部修复）**：

1. **App 本地写入双写缺口（用户输入被吞 / 注入不显示）**：用户回显、排队认领（followup / steer）、rule-engine 注入、App 本地 notice、本地 shell 只写旧缓冲、未交付节缓存 → 流水线路径下全部不可见。补全双写边界（`b47ea10`）；交付带行号（seq）→ 节条目 → 行 → 布局层按 seq 回查 buffer，用户块符号（活跃 ●/○ / 终态 ✓/✗/■ / steer 续接 ←）与旧路径单源。
1. **会话建立过渡重建丢内容**：`activeSessionId` null → sid 的事件翻转曾触发「会话切换重建」，启动早期的用户节被清掉；改为仅真实 sid 变化重建，建立过渡只登记归属。
1. **回合号本地预测 + 画线判据镜像**：宿主 `turn/start` 回填只改写旧缓冲行，节缓存不可变 → turn-begin 按「上一已知回合 + 1」本地预测（基线只跟 turn-start 交付推进，用户 / 通知交付不推进）；画线判据与 `appendTurnSeparator` 镜像（首回合空历史不画线）；重放器按分隔线行补交付 `turn-start`（恢复路径的时间真源）。
1. **用户块绕过行缓存**：块符号随回合状态变化（运行 ● → 终态 ✓），行缓存按 box 身份命中会渲染旧状态符号。
1. **同一节正文换行后左侧竖线断线**：第 3 步把文本叶子拆散成逐行 box，每行独立调排版，「块内空行竖线连排」看不到邻居 → 空行丢竖线。随嵌套 box 重构一并修复（见下）。

**结构裁定（用户 2026-10-09：box 节内嵌套化，`2c6f27c`）**：第 2 步从「扁平 box 序列」改为嵌套两族（对齐旧 box.ts 容器 / 叶子）：第一级 = 类型块 LayoutBox（role "block"，source 分档 reasoning/assistant/tool/notice/user/shell），细分 = ContentBox 叶子（assistant: text / quote 引用 / list 列表 / code / table；tool: 整批）；表格拆为 table → row（带表头标记）→ cell 叶子（单元格当前均为单行文本，更深拆分预留）。结构细分**仅 assistant**——用户块是逐字原文，markdown 形态（如「1. 」列表行）不再拆分，否则一条输入被拆成多块、状态符号重复（真机观察并修复）。第 3 步文本叶子不再按行拆散：整段过第 4 步按物理行展开（同节正文的行落在同一次排版调用，竖线连排恢复连续）；表格行补 final 归属（曾整表掉进活动区）。

**续接重复注入（发现，待裁定，不在本条目修）**：rule-engine 把 `session/created`（含恢复）派发为 `session-start` → 续接（`-c`）会话时规则重新注入：模型上下文重复 + TUI 历史回放与活通道各显示一次。属 rule-engine / 宿主语义问题，另立条目处理。

**测试与证据（更新）**：全量 **1412 用例全绿**；App 级双写用例 ×3 + 双写整帧等价 ×1（`pipeline-app.test.ts`）；真机回归路径 = herdr 开新 tab 跑 `dsh --profile fff`（注入显示 / 回显 / 流式 / 符号流转 / 分隔线 / 折叠 / 分屏收窄还原均通过；滚动翻页按键注入受 herdr 键集限制，留人工目测）。

## 测试与证据

调研 + 设计阶段无代码改动，证据 = 上文 `文件:行号`。批 0-1 证据：`npm run check` 通过；`TUI/scripts/test.sh` 全量 **1356 用例全绿**（含新增 `tests/pipeline-sections.test.ts` 11 例：重复交付只入一次 / 节内归并 / 无空节 / 工具批配对 / 独立成节 / 冻结）。三张实测表来自三个临时探针（`tmp/seg-probe.mts` / `tmp/phase2-probe.mts` / `tmp/fence2-probe.mts`，跑完已删，数字已抄录进 R1 / R5 / R7）与既有基准：

```
buildFrame 基准｜cols=120 rows=40 buffer≈1000 行｜iterations=30
mode          cache off      cache on      speedup
cold          7.30 ms        0.50 ms       14.6×
warm          6.58 ms        0.17 ms       38.6×
incremental   10.67 ms       0.34 ms       31.6×
```

## 第二阶段：位置模型接管 + 旧排版退役（2026-10-09 用户指示）

**范围裁定（用户 2026-10-09）**：条目 1 的剩余（滚动 / 扩窗迁位置模型）与条目 7（双写退役）合并执行——新路径成为**唯一**路径；`TUI_LAYOUT_PIPELINE` 开关与旧排版结构一次性清空。

### 现状事实（本阶段开工时实测）

1. 出帧已由流水线驱动（`layout.ts:1632-1672` 的双来源分支，`state.pipeline` 存在时走 `pipelineContent`），节 / box / pane / 行 / 重放五层齐备。
1. **未达成项**：`pipeline/rows.ts` 的位置模型（偏移 + 显示索引 + 行数表 + `remap`）在 `src/app` 里**零引用**；滚动仍走 `state.ts:3494 scrollDialogue` 的语义锚点（`moveDialogueAnchor` + 移动前几何 clamp，扩窗判定在其后）+ `layout.ts:245 dialogueTopIdx`；`index.ts:2316` 的几何经 `paneMaxes()`（以 state 引用为键的整帧回填）取得。
1. **旧结构依赖面**：`state.buffer` 既承载会话内容（渲染来源之一）又是用户块状态符号（`layout.ts:2452 userBlockSymbolResolver` 按 `seq` 回查）、PgUp 跳转（`index.ts` `userInputJump` + `dialogueWindow`）与回合分组（`turnGroupStarts(buffer)`）的事实源；`trimBufferHead(buffer, state.scrollAnchor)` 在 `state.ts` 多处调用。

### 分批（依赖顺序；每批独立可验证）

| 批 | 内容 | 验收 |
| --- | --- | --- |
| M1 | **位置模型接管滚动与扩窗**：`state` 的 `scrollAnchor` / `dialogueGeometry` 换成 `dialoguePos`（偏移 + 显示索引）；App 每帧从流水线取两 pane 行缓冲与行数表；扩窗 = 段级前置插入（位移在扩窗后施加）→ 条目 5 的「clamp 先于扩窗」结构上消失 | 单测：撞顶一次 ↑ 恰走 `floor(viewportH/2)` 行；滚动 / 扩窗零重排计数断言 |
| M2 | **单一渲染来源**：`buildTopRegion` 删旧分支；用户块事实（终态 / `steerContinued` / 活跃块）入节模型；占位行由流水线产出；删 `dialogueWindow` / `dialogueSpans` / `dialogueTopIdx` / `indexToAnchor` / `moveDialogueAnchor` / `anchorToOffset` / `DIALOGUE_MARKER_SEQ` / `window-groups` / `anchor-resolved` 死 action / `TUI_LAYOUT_PIPELINE` 开关 | 帧断言全绿；`state.buffer` 不再被构帧读取 |
| M3 | **本地写入与恢复改块交付**：App 本地（用户回显 / 排队认领 / notice / shell / help）只投递块；恢复路径从宿主历史直接产交付（不再经 buffer 重放）；`state.buffer` 与 `nextSeq` 退场 | 恢复重放用例等价；全量测试绿 |
| M4 | **测试与文档收尾**：既有帧断言 / 滚动用例迁到新模型；补滚动零重排计数断言；`check` + `build` + 全量测试；真机目视（滚动 / 扩窗 / 流式 / 面板 / 恢复） | 全绿 + 真机通过 |

### 计划改动文件清单（第二阶段）

| 文件 | 改动 |
| --- | --- |
| `TUI/src/app/layout/pipeline/view.ts`（新） | 每帧视图：节缓存 → 窗口（按段）→ 两 pane 行缓冲 + 行数表 + 占位标记，供 App 定位与 layout 装配共用（单一来源） |
| `TUI/src/app/layout/pipeline/rows.ts` | 行数表接窗口段；段身份（供 `remap` 定位） |
| `TUI/src/app/layout/pipeline/frame.ts` | 由「构帧函数」降为 `view.ts` 的一层；去掉 `turnGroupStarts(buffer)` 依赖 |
| `TUI/src/app/layout/pipeline/types.ts` / `sections.ts` | 用户条目补状态事实（终态 / `steerContinued` / `queued`），接收层按 `turn-end` 原因打标 |
| `TUI/src/app/layout/pipeline/flag.ts` | 删除（开关退场） |
| `TUI/src/app/state.ts` | `dialoguePos` 取代 `scrollAnchor` / `dialogueGeometry`；滚动 action 改位置模型；删死 action；`buffer` / `nextSeq` 退场 |
| `TUI/src/app/layout.ts` | `buildTopRegion` 单源（取 `view.ts` 结果）；删锚点族函数与 `FrameScrollReport` 的几何字段；退化为装配入口 |
| `TUI/src/app/index.ts` | 帧循环取视图行缓冲；滚动 / 扩窗改位置模型；本地写入改块交付；删开关分支 |
| `TUI/src/app/adapter/dsh.ts` | `turn-end` 带原因；用户状态事实随交付；去 buffer 写 |
| `TUI/tests/` | 更新既有帧断言 / 滚动用例；新增滚动零重排与位置 remap 用例 |

### 实现记录（第二阶段）

**M1-a 段键与位置模型**：`panes.ts` 给每个 pane 项发**稳定段键**（节身份 + 节内 box 序号；边界项 `blank@<后项键>` / `sep@<回合>` / `step@<turn:step>` / `step-summary@<节>`）；`rows.ts` 的 `RenderedPane` 增 `keys` / `userRows`，并导出 `positionAt` / `indexOfTop` / `MARKER_KEY` / `TOP_OLDEST_KEY` / `DialogueTop`（位置 = 段键 + 段内行，段键失效回落距底偏移）。

**M1-b 状态与装配**：`AppState.scrollAnchor` + `dialogueGeometry` → **`dialogueTop`**（+ `scrollOffset` 作回落基准）；action `scroll` / `anchor-resolved` / `window-groups` / `user-jump` → **`dialogue-scroll`** / **`window-grow`**；`scrollDialogue` / `dialogueSpans` / `dialogueTopIdx` / `indexToAnchor` / `anchorToIndex` / `anchorToOffset` / `moveDialogueAnchor` / `DialogueAnchor` / `DialogueSpan` / `DialogueGeometry` / `dialogueWindow` / `DIALOGUE_MARKER_SEQ` / `TUI_LAYOUT_PIPELINE`（`flag.ts`）全部删除；`FrameScrollReport` 改为段表口径（`dialogueTotal` / `dialogueCounts` / `dialogueKeys` / `dialogueTopIdx` / `dialogueViewportH` / `dialogueUserRows`）。App 侧新增 `scrollDialogueBy`（**先扩窗、再按扩窗后的段表施加位移** —— 条目 5 的根因链在结构上不存在）与 `syncDialoguePos`（段落收敛 + 窗口撑住）；PgUp/PgDn 改走 `userRowJump`（行号口径，不再回查缓冲）。

**M2 单一内容来源**：`buildTopRegion` 删旧分支（`dialogueWindow` + `buildContentRows` 构帧调用点），内容来源唯一 = `pipelineContent(sectionsOf(state), …)`；`sectionsOf` 在 App 未注入节缓存时按 `state.buffer` 重放（**按逐行对象身份**判缓存命中——缓冲就地变更会换行对象，只比数组身份会拿到过期节缓存）。

**迁移中发现并修掉的口径缺陷**（都有测试固化）：

1. **恢复重放的同 scope 迟到回写**：回合定型后同 scope 的内容被并回总结节（文本直拼成一行、非 final 正文错进会话区）→ 重放器在定型后把 scope 前移一格（不发 step-start，不产生 step 头）。
1. **活动区空行整片消失**：`buildContentRows` 会把裸空 plain 行路由到会话区、并裁掉首行空行 → 空行项改由行层直接出行（`segments: []`、`kind: "plain"`）。
1. **留白规则按旧渲染器口径收紧**：回合区只在「思考 ↔ 正文」之间留白（工具重置上一档，`noteActKind`）；会话区只在「用户块 → 正文」之间留白（`spaceUserAssistant`）。
1. **steer 留白**：`queued: "steer"` / 恢复行的 `spaceBefore` → 节带 `steer` 标记 → 第 3 步在该块之前插空行。
1. **P9 step 概要行**：新增 `step-summary` 交付与 pane 项（恢复路径的 `kind: "step"` 行），渲染复用既有 `kind: "step"` 行口径。
1. **回合分隔线口径**：由 `turn-start` 交付驱动（App 在 turn-begin 交付；重放按分隔线行补交付），时间未知时画**纯虚线**；被窗口丢掉的更早回合不画。
1. **空行吸收三件套**：pane 尾部空行裁剪（`trimTrailingAssistantBlanks`）、notice/shell 拖尾换行剥离、空 notice 在工具批 / step 头之前吸收（`absorbActivityBlank`）。
1. **step 头顺序**：未声明 step 的节不再提前冲刷已声明的头（旧路径的头随 step 事件追加）；重放的分隔线不再重置 step（沿用最近一次声明的 step，与实时线一致）。
1. **本地辅助行**：`subagent` / `hook` / `command` 等工具行不再在恢复时被丢弃 → 文本交付新增 `source: "tool"`（+ `tone`），工具批按 `calls` 有无分流。
1. **step 头时间**：`step` action 把时间写进缓冲行（`time` 字段），恢复重放据此还原 `hh:mm:ss #N`。

**证据**：`npm run check` 全绿；TUI 全量 **1410 用例全绿**（新增 `tests/scroll-position.test.ts`；重写 `scroll-anchor.test.ts` → 段键 / 位置模型；`buffer-trim.test.ts` 改为「裁剪不再为阅读位置让路」；`layout4.test.ts` 的滚动 / 翻页用例迁到新模型 + `appScrollDialogue` 同口径助手；`app.test.ts` 增「对话区 ↑ 位移恒等于半屏（含撞扩窗那一次）」）。

**剩余（未完成，另批处理）**：`state.buffer` 仍作事实源与恢复回放源（App 无 sink 时的回落路径），本地写入（用户回显 / notice / shell / 辅助行）仍是「写缓冲 + 投块」双写；条目 7 的验收（`state.buffer` 不再承载会话内容）未达成 → 见 BACKLOG。真机目视（滚动 / 扩窗 / 流式 / 面板 / 恢复）待人工确认。

### 第三阶段（条目 7 双写退役，进行中）

用户 2026-10-10 裁定：A + B 一起做。侦察结论（双写的精确边界）——渲染已单源（只读节缓存），`state.buffer` 在生产路径只剩三个角色：① 恢复会话的内容入口；② 用户块状态事实（用户行符号按 `seq` 回查 buffer，见 `rows.ts:324,498`、`sections.ts:525`、`replay.ts:57`）；③ 无 sink 时的渲染回退（测试 / 嵌入用法依赖）。此外 pass-through 事件只入 reducer、不投块 → 用户真机「回合区不显示警告」（条目 10）。

| 批 | 内容 | 状态 |
| --- | --- | --- |
| A1 | pass-through 事件（retry / subagent / hook / feedback / retry-started / compaction / compaction-summary / goal-\* / todo-write / mode …）写下的可见行补投块：新增 `App.deliverBufferTail`，复用重放的「行 → 交付」映射（`deliveryOfLine`），step 头 / 分隔线按重放同款转 `step-start` / `turn-start`；**adapter 已直接交付的事件不桥接**（`tool-call` / `tool-result` / `step` / `compaction-prune`，否则回合区出现重复行） | ✓ 完成 |
| A1′ | 顺带修交付层根因：`sections.ts` 的 `appendText` 同来源合并会把辅助行（`source: "tool"` 文本）并进工具批，批渲染忽略 `text` → 辅助行整条消失；改为**只与文本项合并** | ✓ 完成 |
| A2 | 恢复路径改喂**已构造的行**：`replaySectionsFromBuffer()`（回读 `state.buffer`）→ `replaySectionsFromRows(rows)`；启动恢复（`restoreStartupHistory`）与 `/session` 切换（`resumeToSession`）两处都直传 `surfaceToBuffer(...)` 的结果 | ✓ 完成 |
| 范围裁定 | 用户 2026-10-10：条目 7 取**选项 1**——生产路径单源化（live 运行不再写 / 读 buffer 内容），`state.buffer` 保留为**测试与嵌入用**的重放输入并在文档写明；「连测试路径也不再经 buffer」另立 BACKLOG 条目 12（P3，2-3 天）。实现机制：`AppState` 增「是否保留缓冲内容」开关（App 注入 sink 时置否），`reduceState` 的内容分支在该开关关闭时只更新状态事实、不写缓冲行 | 已裁定 |
| B1 | 用户块状态事实进节模型（去掉按 `seq` 回查 buffer）。**已完成**：① `turn-end` 交付带 `reason`（`adapter/dsh.ts` 透传宿主 reason）→ `applyTurnEnd` 落到该回合最后一个用户**条目**的 `userStatus`（已有不覆盖）；② `user-flag` 交付（steer 认领时 App 在投新用户块**之前**发出）→ 上一条用户条目 `steerContinued`；③ 恢复路径由 `deliveryOfLine` 按缓冲行透传 `status` / `steerContinued`（`user` 交付新增两个字段）；④ `panes.ts` 给会话区**最后一条终态未定**的用户项打 `active` → 行层 `active`；⑤ `userBlockSymbolResolver` 改读行自带 `status` / `steerContinued` / `active`，**删掉 `activeSeq` 扫描与按 `seq` 回查 buffer** | ✓ 完成 |
| B2 | 无 sink 回退改测试助手：新增 `tests/helpers/renderFromBuffer.ts`（用 reducer 造 state 的帧测试统一经它把 buffer 行转节并注入 `pipeline`），保留测试能力、不占生产 `state.buffer` | 待做 |
| B3 | 删 `state.buffer` / `nextSeq` / 旧 reducer 内容分支 / `trimBufferHead`；**残留死码已清**（2026-10-10：3 处 `scrollAnchor: null` 死写改 `dialogueTop: null`、`focus-frame.ts` 的 `FRAME_SEP` / `FRAME_DSEP`、`panel.ts` 的 `panelPlainParagraph`） | 部分完成（死码 ✓ / buffer 退场待做） |

**批 A1 证据**：新增回归用例 `tests/pipeline-app.test.ts`「事件驱动的本地写入投块：retry / subagent / hook 在回合区可见」（条目 10 回归）；`npm run check` 全绿；TUI 全量 **1411 用例全绿**。修复后条目 10 的「警告在回合区不可见」已消失（真机目视待确认）。

**批 A2 证据**（2026-10-10）：新增回归用例 `tests/pipeline-app.test.ts`「会话切换：history-resume-ok 的历史行直接进节缓存」；临时探针正反验证——改前该路径重放后只有 1 节（历史不可见，用例失败）、改后 3 节全出。**顺带修掉一个未报告的缺陷**：`/session` 切换路径此前**没有**重放调用 → 切换后的首次交付按「会话已换」重建空节缓存，恢复出的历史在回合区不可见（启动恢复路径有重放，故只有切换路径中招）。`npm run check` 全绿；TUI 全量 **1412 用例全绿**。

### 第四阶段（条目 7 选项 1 收尾：生产读侧迁移 + 关写开关，2026-10-10 完成）

**开工实测**：交接单把第二步记为「加一个开关」，实测该开关一关会打断 7 处仍在读 `state.buffer` 的生产读者（**这不是开关，是读侧迁移**）。

| # | 读点 | 位置 | 处置 |
| --- | --- | --- | --- |
| 1 | A1 事件桥：pass-through 事件写缓冲行后回读补块 | `index.ts` `deliverBufferTail` | **保留**：这些行属 UI 本地行，开关只停「会话内容」写入 → 桥照旧工作 |
| 2 | 底部 toast / 通知区：取缓冲里的 notice 行 | `layout.ts` `buildBottomRegion` | **保留**（同上；`/help` 双列表格的 `hanging` / `noCompact` 2026-10-10 起随交付进节模型——见「验收回归」#1） |
| 3 | `/copy` 最后一条回复 | `index.ts` `copyLastReply` | 迁移 → `lastTextBySource(sectionsOf(state), "assistant")` |
| 4 | `/council` 目标与问答面板来源 | `index.ts` council 分支、`recentQuestionSource(s.buffer)` | 迁移 → `lastTextBySource(…, "user")` / `lastTextOfSources(…, ["assistant","user"])` |
| 5 | 画线判据（活动区清理后是否分隔线） | `index.ts` `beginTurnIfNeeded` | 迁移 → 节模型查询（清理活动区的回合）+ `pipelineAnyContent` / `pipelineSepPending`（交付事实，镜像旧「缓冲非空且末行非分隔线」） |
| 6 | 用户块 `seq`（交付去重键 + 节项 `seqs`） | `index.ts` 的 `lastUserLineSeq` ×4 | **退场**（B1 起终态 / steer 标记已随条目走；A2 先在重放侧去掉） |
| 7 | 无 sink 回退（测试 / 嵌入用法） | `frame.ts` `sectionsOf` | **保留**（条目 12 处理） |

| 批 | 内容 | 状态 |
| --- | --- | --- |
| C1 | 读侧迁移（3-6；1/2/7 保留） | ✓ 完成 |
| C2 | 关写开关：`AppState.bufferRetainsContent`（App 注入 sink 时经 `pipeline-state` 置否）+ `reduceState` 出口的 `dropContentWrites` 丢弃内容类 action 的缓冲写入（状态事实保留；`turn-begin` 另清活动区本地行、历史恢复清空缓冲） | ✓ 完成 |
| C3 | 文档回写（SPEC §9.1/§15.2、DESIGN 层级图、README「排版路径」）+ 关闭条目 7 | ✓ 完成 |

**口径说明（迁移中的三点取舍）**：

1. **`buffer` 的最终定位 = 测试与嵌入用的重放输入 + 生产路径的 UI 本地行**：内容类写入全停（正文 / 用户块 / 思考 / step / 工具行 / 分隔线 / 恢复行），notice / shell / 辅助工具行照写——底部 toast 与 A1 补投依赖它们，且它们不是会话内容（不进模型历史）。「连 UI 本地行也不再经缓冲」未做，属条目 12 的延伸（另立条目时再议）。
1. **`/copy` 语义微调**：改按节模型的末段 assistant 文本（节内同 `(turn, step)` 合并、notice 不切断）——与回合区实际渲染的正文一致；旧口径按缓冲「连续 assistant 行」收集，会把中途 notice 之前的半截回复丢掉（`tests/app.test.ts` 的多行复制断言按新口径更新）。
1. **问答面板来源微调**：改取「最近一段正文（assistant / user 按节序取最后一条）」，跨工具行与旧口径一致，但不再按「本回合 → 上一回合」回退（会话内最近一段正文即同一结果）；`recentQuestionSource`（缓冲块口径）随之退场。

**证据**：`npm run check` / `npm run build` 全绿；TUI 全量 **1416 用例全绿**（新增 `tests/buffer-retire.test.ts` 5 例：内容类不写缓冲 / UI 本地行照写 / 回合开始清活动区行 / 历史恢复清缓冲 / `lastTextOfSources` 取值；`tests/pipeline-app.test.ts` 增「注入 sink 时 /copy 的来源仍在节模型」，该文件含逐步新旧路径**整帧等价**用例——生产口径（sink + 关写）与旧口径逐帧一致；另含下述 4 例真机回归）。

### 验收回归（2026-10-10 真机验收发现，同日修复）

用户真机（`dsh --profile fff`，生产口径 = 已注入 sink）验收发现 4 个缺陷：3 个根因同族（**内容单源换成节缓存后，仍有三条路径只动缓冲 / 只认已物化的行**），1 个是键位覆盖漏了 Turn 面板。

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | `/help` 完全不显示 | `/help` 是唯一不经 `App.notice()` 的本地提示：只 `reduceState(notice)` 写缓冲、不投块 → 节缓存里没有，唯一渲染来源看不到 | `/help` 补 `deliverLocal`；notice 的排版元数据 `hanging`（悬挂缩进）/ `noCompact`（紧凑豁免）由交付 → 节条目 → box → 行透传（`types.ts` / `sections.ts` / `boxes.ts` / `rows.ts` 各加两个可选字段）——旧路径这两项长在缓冲行上 |
| 2 | 对话区翻页无反应（`PgUp` / `PgDn`） | 恢复出的历史只物化最近 `DIALOGUE_KEEP_REPLIES(3)` 组，而 `userRowJump` 只扫已物化行 → 窗口顶找不到目标就什么都不做（旧路径全量重放缓冲，不存在「未物化」） | `handleKey` 的 PgUp 分支：找不到目标且还有更早回合时先 `window-grow` 再跳（与 ↑ 扩窗同口径，上限 4 次） |
| 3 | `/cls` 后新事件一到，清掉的内容全回来 | `clearBuffer` 只把 `state.pipeline` 换成新对象；App 手里的接收层（`this.sections`）没重置 → 下一次 `ingestDelivery` 把旧节缓存重新注入 state | `/cls` 在 App 侧重建接收层（`createSections()` + 归零回合基线 / 画线判据） |
| 4 | Turn 面板（下半区）`Ctrl+↑` / `Ctrl+↓` 与裸 `↑` 同效，没有半屏 | 用户 2026-10-10 的「裸 ↑/↓ 一行、Ctrl+↑/↓ 半屏」裁定只落在对话区分支；活动区分支恒按 1 行走（`focusedLineScroll` 的 `dir` 只有 `1 \| -1`） | `focusedLineScroll` 改为收**位移行数**（`delta: number`）；`handleKey` 的 ↑/↓ 分支在活动区 + `ctrl` 时传 `dialogueHalfPage(frameGeometry().activityH)`（状态列仍是 1 行） |

**回归用例**（均在去掉修复后实测失败）：`tests/pipeline-app.test.ts` —— `/help` 进回合区 + 元数据进节模型；`PgUp` 逐条走到最旧回合（断言最旧回合**正文**——`第 1 问` 会命中标题栏，不能证明回合区滚到位）；`/cls` 后新交付不回流旧内容；`tests/app.test.ts` —— Turn 面板焦点下 `Ctrl+↑/↓` = 半屏（裸 ↑ 仍一行）。

## 收尾

（条目 7「排版流水线双写退役」选项 1 已完成，2026-10-10 关闭；本文件移入 `TUI/docs/archived/`。）

**条目 1「排版流程重构：六步流水线」关闭记录（2026-10-10）**：

- 完成口径：六步流水线为**唯一渲染路径**（生产恒注入 `pipelineSink`；`state.pipeline` 是内容单源）。旧结构全数退场——`TUI_LAYOUT_PIPELINE` 开关、`scrollAnchor` 锚点模型（`moveDialogueAnchor` / `indexToAnchor`）、`dialogueGeometry`、`dialogueWindow` 构帧调用点（全仓 `grep` 零命中，仅注释里保留历史说明）。
- 验收证据：新旧路径**逐帧逐行等价**（`tests/pipeline-equivalence.test.ts` / `pipeline-frame.test.ts`）；宽度不变时同段不重复排版（`rowRenderMisses()` 计数断言）；滚动 / 扩窗只查表（`tests/scroll-position.test.ts` / `layout4.test.ts`）；既有帧断言不回归；用户 2026-10-10 真机复检滚动 / 流式 / 面板 / `/help` / `/cls` / 会话切换通过。
- **未完成的一条计划项**另立条目 13：`markdown.ts` 缓存键去掉 `themeId`（`themeSizedKey` 仍在 3 处，`themeId` 沿调用链传但解析不读）。
- **旧代码残留**另立条目 14：`layout.ts:121-136` 旧视口模型 `ViewportInput` / `Viewport` / `computeViewport`（仅测试引用）、`components/{StatusPanel,JobsPanel,HistoryPanel}.ts` 的三个 `render*Panel` 整屏渲染函数、`layout.ts` 内只自引用的常量与类型。
- 有意保留（不算残留）：`state.buffer` 重放回退（条目 12）、共享排版库（`build-box` / `fill` / `measure` / `markdown` / `table` / `primitives` / `content-rules`）、`layout.ts` 的装配与状态列 / 标题栏 / 几何。
