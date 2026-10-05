# `context-report` 重复折叠官方已有投影（接取条目：`docs/BACKLOG.md`「`context-report` 重复折叠官方已有投影」）

状态：关闭　　开启：2026-10-05　　关闭：2026-10-06
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让轮次 / 墙钟 / 大纲改用官方已挂载的投影，本包只保留官方没有的 token 与上下文占用口径。

## 调研

来源：本仓与官方包源码实测，无真机运行。

> **2026-10-06 更正（决策阶段复核源码后）**：本节两处判断有误，已在「决策」中改正，此处保留原文以便追溯——① 官方 `sessionStats` 的**视图**字段是 `ttftMs` / `ttftSteps`（`firstTokenTime` 是它的内部 state 字段），故「口径待对齐」的顾虑不成立；② 官方 fold 与本包折叠口径经逐项比对**一致**（turns 计法 / llmMs 端点 / decode 的 usage 门控 / ttft 采样）。

### 本包现在读的是自己的投影，不是官方的

`context-report` 注册并读取的投影键是**它自己的** `sessionContext`：

- `context-report/src/main.ts:48` —— `export const PROJECTION_KEY = "sessionContext";`
- 读取点 `context-report/src/main.ts:327` —— `registry.stateOf(session, PROJECTION_KEY)`

也就是说，官方 `sessionStats` / `turnOutline` 挂载之后，本包**完全没有消费它们**，两套折叠并行存在。

### 字段对照

本包自折叠字段（`context-report/src/fold.ts:18-35` `createInitialState`）：
`turns` / `steps` / `llmMs` / `toolMs` / `ttftMs` / `ttftSteps` / `decodeMs` / `decodeTokens` / `uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` / `usageSamples`。

官方 `sessionStats` 字段（官方 lib 实测）：`turns` / `steps` / `llmMs` / `toolMs` / `firstTokenTime` / `decodeMs` / `decodeTokens`。

| 本包字段 | 官方对应 | 判定 |
|---|---|---|
| `turns`、`steps`、`llmMs`、`toolMs` | `sessionStats` 同名 | **可替换** |
| `ttftMs` / `ttftSteps` | `sessionStats.firstTokenTime` | 口径待对齐（见下） |
| `decodeMs` / `decodeTokens` | `sessionStats` 同名 | **可替换** |
| `uncachedInputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`、`usageSamples` | 无 | **官方无**，保留 |
| （无） | `turnOutline`（`turns` + `outline` 回合大纲） | **官方有、本包没有** —— 属新增能力而非重合 |

### 可达性：无需新增依赖

本包已 `inject: ["sessionProjections", "sessions", "tools"]`（`context-report/src/main.ts:43`），且已有经 `registry.stateOf` 取投影的现成路径（`:327`）。读官方投影只需把键从 `sessionContext` 扩到 `sessionStats` / `turnOutline`，**不需要新的 inject 声明**。

`sessionProjections` 缺失时本包已有降级（`:299` 告警「报告将缺省会话累计（仅即时读数）」），可复用同一降级口径。

### 口径风险

「首 token」定义需对齐：本包按「`step/start` 时间戳 → 本步首 token 时间戳」挂账（`fold.ts:38-46` 的步内账簿），官方 `firstTokenTime` 的采样点本轮**未证实同源**。这是实现阶段必须先钉死的一件事，否则替换后数值会静默漂移。

### 未完成项

`context-report/tests/` 未逐一核对哪些用例会因改造而红 —— 列为实现阶段第一件事。

## 决策

2026-10-06 定案：**删除重复折叠 + 读取点合并**（唯一改动方仍是 `context-report`；官方包不动）。

前置检查已完成（原「明确不做」里的待查项）：

- `sessionContext` 投影的消费者**只有本包自己**（`grep sessionContext` 全仓 → 本包源码 / 测试 / 文档 + 两处根 README 表述）；`provide("contextReport")` 服务在本仓**无外部消费者**（TUI 与其余 19 包零引用）→ 可以改本包状态形状，不必保留兼容层。
- 官方 `sessionStats` **视图**字段实测（`dsh-session-stats/lib/index.js:28-37`）：`turns` / `steps` / `llmMs` / `toolMs` / `ttftMs` / `ttftSteps` / `decodeMs` / `decodeTokens` —— **与本包 8 个字段逐一同名**（调研期误记为 `firstTokenTime`，那是它的**内部 state** 字段，不是视图字段）。
- 口径比对（官方 fold 源码）：`turns` 同回合多步只计一次（`state.lastTurn === turn` 判定）、`llmMs` = 步内 `startTime → assistant/message`、`decodeMs`/`decodeTokens` 同受 usage 门控、`ttftMs` = 首 token − 步起点并计 `ttftSteps` —— 与本包折叠口径**一致**，替换不会静默漂移。

选定做法：

- `SessionContextState` 瘦身为「官方没有的部分」：token 分桶五件套 + `usageSamples` + `asOfSeq` + 可选 `provider` / `model`；`fold.ts` 删除 `turns` / `steps` / `llmMs` / `toolMs` / `ttftMs` / `ttftSteps` / `decodeMs` / `decodeTokens` 的折叠逻辑。
- 投影 `stateVersion` **2 → 3**（序列化字段变更，宿主据此丢弃旧缓存行——这正是该字段的用途）。
- 报告时经 `registry.stateOf(session, "sessionStats")` 读官方视图，在**读取点合并**（local token 状态 + 官方会话统计）；官方缺省时该组数字缺省并把来源降级标注，不再回退自折叠（删除优先于双实现）。
- 报告 `projection` 字段从 `"sessionContext" | "unavailable"` 扩为 `"sessionStats+sessionContext" | "sessionStats" | "sessionContext" | "unavailable"`，如实标注两组来源的在位情况。

理由：条目的病灶是「同一件事两处实现」；只把读取点改到官方、却留着自折叠逻辑（或拿它当 fallback）等于没治病。删掉重复折叠后，本包职责收敛为「官方空缺的 token 分桶 + 上下文占用 + 三档渲染」。

## 规划

**计划改动文件清单（未列出的文件一律不改）**

- `context-report/src/fold.ts` —— 删 8 个与官方重合的累计器及其事件分支；保留 token 分桶与 `asOfSeq`
- `context-report/src/types.ts` —— `SessionContextState` 瘦身；新增 `SessionStatsLike`（官方视图子集）；`ContextReportInput` 增 `stats`
- `context-report/src/schema.ts` —— 数值字段白名单同步删 8 项
- `context-report/src/main.ts` —— `STATE_VERSION` 2→3；报告路径读 `sessionStats` 并在读取点合并；`projection` 来源标注
- `context-report/src/report.ts` —— `turns` / `steps` / `durations` 取自 `stats`，`tokens` 取自本地状态；文本渲染加来源与口径提示
- `context-report/tests/{fold,main,report}.test.ts`、`helpers.ts` —— 受影响用例更新；补「官方视图优先 / 缺省时降级标注」断言
- `context-report/README.md` —— 数据来源与口径节改写
- 本追踪文档、`docs/BACKLOG.md`（关闭时清理条目）

**明确不做**

- 不注销也不改官方投影；不注册新投影键
- 不删 token 分桶（官方没有）
- 不改 `context_report` 工具的三档参数形态与返回结构骨架
- `turnOutline`（回合大纲）**不在本条目范围**——它是官方有、本包没有的**新增能力**，如需另开条目
- 不保留自折叠 fallback（见「决策」理由）

## 实现记录

- 2026-10-05：接取条目并标记「进行中」；完成现状调研（见上），**无代码改动**。
- 2026-10-06：决策定稿（删除重复折叠 + 读取点合并），追踪文档更新（状态 → 决策）。
- 2026-10-06：实现（8 个文件，全在 `context-report/`）——
  - `src/types.ts`：`SessionContextState` 瘦身为 token 分桶 + `usageSamples` + `asOfSeq`（+ 可选 `provider`/`model`）；新增官方视图子集 `SessionStatsLike`；`ContextReportInput` 增 `stats`；`ContextDurations` 增 `ttftSteps` / `decodeTokens`；`ContextReport.projection` 扩为四态来源标注。
  - `src/fold.ts`：删除回合 / 步 / 墙钟 / 首 token / 解码的累计器与事件分支（`turn/start`、`tool/call`、`tool/result`、`assistant/attempt`、首 token 采样助手），`FoldScratch` 收窄为 `{seq, open}`，`StepLedger` 只留 `usage`；保留 token 分桶与水位语义。
  - `src/schema.ts`：数值白名单同步删 8 项。
  - `src/main.ts`：`STATE_VERSION` 2 → 3；新增 `STATS_KEY = "sessionStats"` 与 `statsFor()`（形状校验 `isStats`，缺失即 undefined，不回退自折叠）；`isState()` 改判 `outputTokens`；`collect()` 合并官方统计。
  - `src/report.ts`：`turns` / `steps` / `durations` 取自 `stats`；`projection` 由两组在位情况推导；首 token 均值改用官方 `ttftSteps`、解码速率改用官方 `decodeTokens`/`decodeMs`（同源）；文本标注两组来源与降级提示。
  - `tests/helpers.ts`：`stateFixture` 瘦身 + 新增 `statsFixture`；`tests/fold.test.ts` 重写为 token 分桶口径（删回合 / 墙钟 / 首 token 用例，补「未匹配事件返回同一引用」）；`tests/main.test.ts` 假注册表按 key 分派（官方 `sessionStats` 视图）、补「官方不在位 → 整组缺省 + 来源降级」用例；`tests/report.test.ts` 补「stats 优先 / 只有官方 stats」用例。
  - `README.md`：承载面、报告样例、口径（新增「数据来源」表）、边界与限制、与宿主投影的分工节全部改写；单测数 44 → 41。

## 测试与证据

- `cd context-report && npm run check` → 通过（tsc strict）
- `cd context-report && npm run build` → 通过
- `cd context-report && npm test` → **41 / 41 通过**
- 反向验证（本次改造的判定性证据）：
  - 改前 8 个字段属本包折叠、官方投影零消费；改后 `src/` 中除 `STATS_KEY` 读取外无任何回合/墙钟计算路径（`grep -n "llmMs\|toolMs\|ttftMs\|decodeMs\|turns\|steps" context-report/src/` 只剩类型与读取）。
  - 官方不在位用例：`projection === "sessionContext"`、`turns/steps === 0`、`durations === undefined`、文本含「官方 sessionStats 投影未在位」——证明没有静默回退自折叠。
  - 假注册表按 key 分派后，`stateOf(session, "sessionStats")` 返回官方视图即被采用（`report.durations.llmMs === 500`）。

## 收尾

- 条目「`context-report` 重复折叠官方已有投影」已从 `docs/BACKLOG.md` §2 **清理移除**（只留未完成项），其余条目重编号；本文件移入 `docs/archived/`。
- 关闭后回写（本次共 7 份）：包内 `context-report/README.md`（承载面 / 报告样例 / 口径「数据来源」表 / 边界 / 分工节）；根 `README.md` + `README.zh.md`（英中同步的插件总表行）；`docs/ARCHITECTURE-REUSE.md` 三处（§0 结论总表标「保留（已收窄）」、§3 分工行、§4 A 标已完成）；`docs/BACKLOG.md` §1 已完成索引措辞。
- 途中发现的新问题：无。
- 遗留：`turnOutline`（回合大纲）本包仍未接——属**新增能力**（官方有、本包没有），本条目范围外，需要时另开条目。
- `STATUS.md` 按流程由用户择时更新，本次不改。
- 提交：本次为**关闭后一次性提交**（决策 / 代码 / 测试 / 文档回写 / 归档合并；前三个询问点用户均选择留到关闭后）。
