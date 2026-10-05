# `context-report` 重复折叠官方已有投影（接取条目：`docs/BACKLOG.md`「`context-report` 重复折叠官方已有投影」）

状态：调研　　开启：2026-10-05　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让轮次 / 墙钟 / 大纲改用官方已挂载的投影，本包只保留官方没有的 token 与上下文占用口径。

## 调研

来源：本仓与官方包源码实测，无真机运行。

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

（待定；调研倾向：`turns` / `steps` / `llmMs` / `toolMs` / `decodeMs` / `decodeTokens` 改用官方投影；token 分桶保留自折叠；`turnOutline` 作为新增能力另行评估）

## 规划

**计划改动文件清单（待决策后收敛；未列出的文件一律不改）**

- `context-report/src/main.ts` —— 投影读取扩到官方键
- `context-report/src/fold.ts` —— 移除与官方重合的折叠字段（保留 token 分桶）
- `context-report/tests/` —— 更新受影响用例
- `context-report/README.md` —— 口径与数据来源

**明确不做**

- 不注销 `sessionContext` 投影（需先确认下游消费者，**列入实现阶段前置检查**）
- 不删 token 分桶（官方没有）
- 不改 `context_report` 工具的三档参数形态

## 实现记录

- 2026-10-05：接取条目并标记「进行中」；完成现状调研（见上），**无代码改动**。

## 测试与证据

（待实现后补）

## 收尾

（待关闭时补）
