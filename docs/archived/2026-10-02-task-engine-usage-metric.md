# executor 用量计量接 usage 口径（接取条目：`docs/BACKLOG.md`「executor 用量计量接 usage 口径」）

状态：完成　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让 subagent 后端的 token 计量走**宿主 `tokenUsage` 投影**（provider 实际上报的 `outputTokens`），标 `tokensKind: "usage"`，从而与 `budget.maxTokens`（已映射宿主 `agentOptions.maxTokens`＝**输出上限**）同口径比较，恢复 `overBudget` 判定。

现状（2026-10-02 真机第二轮）：subagent 只报 `tokensKind: "pressure"`（`tokenMeter.measure(子会话).totalTokens`＝上下文压力），engine 侧为防误报对 pressure 一律不判 `overBudget` → subagent 的预算字段形同虚设。

## 调研（2026-10-02）

- **宿主投影**（`@deepseek-ai/dsh-token-meter`，`lib/types/usage-projection.d.ts`）：投影单元 key = `tokenUsage`，state = `{ totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, last: { turn, step, buckets } | null }`——`totals` 是 **provider 上报的累计**（durable，非估算）；另有 `contextPressure` 单元（`pressureTokens` / `surfaceTokens`），即 `tokenMeter.measure` 的来源。
- **读法先例**（本仓 `context-report`）：`inject: ["sessionProjections", "sessions", "tools"]`；`ProjectionRegistryLike { register(def); stateOf(session, key): unknown }` → `sessionProjections.stateOf(session, "tokenUsage")`。**不 import 宿主包**，只写最小结构类型。
- **`deriveTurnTokenUsage(events)`**（同包 `turn-usage.ts`）：按 turn 折叠「精确记账」，但要求提供该 turn 的 durable 事件序列，且任何边界缺失就整条不可用——本包拿不到子会话的 turn 事件（只有 `run.localAgent?.session` 句柄），故**不作为主路径**（记入边界）。
- **现有计量段**（`task-engine/src/main.ts:324-337`）：子会话结束（`run.result` 落定、`run.dispose()` 之后）读一次 `tokenMeter.measure(childSession).totalTokens` → `tokenFields()` 标 `pressure`；`engine.ts:436-441` 只对非同口径才判 `overBudget`。

## 决策

- **D1（用量口径，审阅后修订）**：优先 `sessionProjections.stateOf(子会话, "tokenUsage")` 的 `totals.outputTokens`（provider 上报的**输出 token 累计**，要求 `last !== null` 即「至少有一个 usage 样本」）→ `{tokens, tokensKind: "usage"}`。**它只作信息量**：累计口径与「每次请求输出上限」不可比（见 D6）。
- **D2（回退链）**：投影不可用（服务缺失 / 子会话无该状态 / `totals.outputTokens` 非有限数）→ 回退 `tokenMeter.measure(childSession).totalTokens` → `tokensKind: "pressure"`（**不参与** `overBudget`，保持 2026-10-02 收紧后的行为，不回归误报）；两者都拿不到 → 不写计量字段。
- **D3（不引依赖）**：新增最小结构类型 `ProjectionRegistryLike { stateOf(session: unknown, key: string): unknown }`（与 `TokenMeterLike` 同款），不 import `@deepseek-ai/*`。
- **D4（读取时机）**：仍在「子会话终态」读一次（`run.result` 已落定、`run.dispose()` 之后）；不改动执行时序。
- **D5（服务解析）**：`sessionProjections` 加入 `serviceResolver` 的解析名与 apply 期探测告警清单（与 `subagents` / `workflowEngine` / `tokenMeter` 同款，执行期解析）。
- **D6（超预算判定，审阅后重定）**：**不做 tokens 数值比较**。审阅用宿主真实 fold 回放 12 个真机 spawn 子会话：`totals.outputTokens` = 6 / 24,920 / 29,537 / 34,082 / 48,564 / 52,417 / 55,232 / 57,065 / 69,197 / 80,270 / 81,955，而仓库里实际声明过的预算是 256 / 512 / 4000 → 数值比较会把 10/12 恒判 `overBudget: true`（从「恒不判」变成「恒真」，条目目标未达成）；`last.buckets.outputTokens` 是「最后一次请求」也不等于「触顶那次」。改用**宿主权威信号**：叶子声明了 `budget.maxTokens` 且子代理 `stopReason === "max-tokens"`（宿主因每次请求的输出上限截断）→ `overBudget: true`；未声明预算或后端无信号 → 不写该字段。`ExecutorResult` 增 `overBudget?: boolean`（后端权威信号），`engine.ts` 只采纳它。
- **D7（文档）**：`task-engine/README.md` 的计量口径一节同步（usage / pressure 两个口径的含义与谁参与判定）；`types.ts` 注释若与实现不符一并改。
- **D8（验证）**：① 包内单测：usage 优先、回退 pressure、两者皆缺、非有限数、投影抛错、`overBudget=true` 判定；② 全仓 `check` / `build` / `test`；③ 真机：重启 TUI 后跑一次真 subagent，确认 `plan/frame-executed` 事件带 `tokensKind: "usage"` 与合理 `tokens`（**需用户重启，作为残余项报告**）。
- **D9（不做，理由经审阅修正）**：不实现 `deriveTurnTokenUsage`——真因是它**不在** `@deepseek-ai/dsh-token-meter` 的 exports（包只导出 `.` / `./client` / `./estimate` / `./src/*`），且读事件所需的 `snapshotEvents` / `eventAt` / `ownEvents` 已被宿主标注 deprecated「new calls are prohibited」（原先写的「拿不到子会话 turn 事件」不成立，已改正）；不做账单口径（缓存读写分桶只进投影、不进本包字段）；workflow 后端的宿主 `WorkflowResult` 只有 `{value?, error?, stopReason, agentsStarted}`（**无 usage 字段**）、command 无会话 → 两者不接 usage（证据写进 DESIGN §8 旁）。

## 计划改动文件清单

- `task-engine/src/main.ts`（`ProjectionRegistryLike` + 计量段取数链 + 服务解析名）
- `task-engine/tests/*.test.ts`（新增计量用例；现有 `pressure` 用例保持）
- `task-engine/README.md`（计量口径说明）
- `docs/BACKLOG.md`（开工标「进行中」→ 关闭时清理）、本追踪文档
- 若 `task-engine/src/types.ts` 的 `TokenKind` 注释与实现不符则一并改（否则不动）

## 实现记录

| 文件 | 改动 |
|---|---|
| `task-engine/src/main.ts` | ① 新增 `ProjectionRegistryLike`（最小结构类型：`stateOf(session, key): unknown`，不 import 宿主包）；② 新增导出 `readUsageOutputTokens(state)`（取 `totals.outputTokens`，非有限数 → undefined）；③ 新增导出 `measureChildTokens({session, resolve, warn})`——usage 投影优先、pressure 回退、两者皆缺不写字段；④ subagent 分支的计量段改为一行调用（原先的 `tokenFields(tokens)`/pressure 硬编码删除）；⑤ `sessionProjections` 加入执行期服务解析名与 apply 期探测告警清单 |
| `task-engine/src/types.ts` | `budget.maxTokens` 注释改为「**输出 token** 上限（subagent 走宿主 `agentOptions.maxTokens`，事后按 `tokenUsage` 投影计量）」（`TokenKind` 定义本就含 `usage`，未改值域） |
| `task-engine/tests/usage.test.ts`（新） | 5 组 10 断言：投影结构正例（含 0）/ 12 种非法输入、usage 优先且**不碰** `tokenMeter`、投影缺状态回退 pressure、投影抛错告警 + 回退、两服务皆缺 → 空字段、无子会话句柄 → 不解析服务 |
| `task-engine/tests/engine.test.ts` | 新增 2 例：usage 参与 `overBudget`（超限 `true` / 未超限 `false`）、未声明预算不写 `overBudget` |
| `task-engine/README.md` | 计量口径一节改写（usage 投影优先 + 回退链 + 谁参与判定）；宿主服务清单补 `sessionProjections` |

## 测试与证据（2026-10-02）

- `task-engine` 包内：`npm run check` / `build` 通过；`npm run test` **71 例全绿**（改前 62 例，新增 9）。
- 全仓：`npm run check` exit 0、`npm run build` exit 0、`npm run test` **20 包全 OK**（task-engine 71；其余包无回归）。
- **dist 产物端到端核对**（加载 `task-engine/dist/index.js`，用假宿主服务驱动真 subagent 后端，走 `apply` → `task_decompose` → `task_execute`）：
  - **usage 路径**（`sessionProjections.stateOf` 返回 `{totals:{outputTokens:4321}}`、`budget.maxTokens=256`）：
    `{"ok":true,"evidence":"子代理产出正文","usage":{"tokens":4321,"tokensKind":"usage","overBudget":true}}`；
    `stateOf` 调用 1 次、`tokenMeter` 调用 **0 次**（证明没有走回退，也没有多余探测）。
  - **回退路径**（不提供 `sessionProjections`）：`{"usage":{"tokens":19413,"tokensKind":"pressure"}}`——**不带** `overBudget`（保持 2026-10-02 收紧后的行为，不回归误报）。
- **未验证（残余）**：宿主**真机**里子会话的 `tokenUsage` 投影是否可直接经 `sessionProjections.stateOf(子会话, "tokenUsage")` 读到——dist 核对用的是假 registry；真机确认需重启 TUI 后跑一次真 subagent（见关闭记录残余 ②）。

## 审阅（子代理，2026-10-02，设计 + 实现一并审）

**结论：有条件通过** → 1 项高 + 2 项中 + 2 类低与 5 项漏项全部处置：

| 审阅发现 | 处置 |
|---|---|
| 【高】D1/D6「与 `budget.maxTokens` 同口径」不成立：投影 `totals` 是**跨请求累计**，宿主 `maxTokens` 是**每次请求**上限（真机回放 12 个子会话 totals 6–81,955 vs 实际预算 256/512/4000 → 10/12 恒判超预算） | 采纳建议①：`overBudget` 改用**宿主权威信号** `stopReason === "max-tokens"`（声明了预算时），tokens 只作信息量；`ExecutorResult` 增 `overBudget?: boolean`，`engine.ts` 删掉数值比较分支；README / DESIGN §8 同步改写（含三条候选读数的口径对比表） |
| 【中】`totals` 读到 0（尚无样本）被当有效读数，且会屏蔽 pressure 回退 | `readUsageOutputTokens` 加 `last !== null` 前置（「有样本」才算），并把「上报过 0」与「没上报过」写进注释与测试 |
| 【中】D9 排除理由事实错误（事件拿得到；真因是 `deriveTurnTokenUsage` 未导出 + 事件同步读 API 已 deprecated） | D9 改正；同时补记 workflow（宿主结果无 usage 字段）/ command（无会话）两条硬理由 |
| 【低】`>` vs `>=`、重试计入、`measure().totalTokens` 构成（= baseline + surface 增量） | 数值比较整体移除，`>`/`>=` 之争消失；README/DESIGN 写明 usage 累计**含重试尝试**、pressure 的真实构成 |
| 【低】`stateOf` 返回宿主 state 而 `snapshot()` 是裸 4 桶（BACKLOG 原文写的是 `snapshot`，易被照抄） | DESIGN §8 明确两者不同构 + key 由 `dsh-token-meter` 注册；关闭本条目时同步 BACKLOG 索引口径 |
| 【漏项】`task-engine/docs/DESIGN.md` §8 未列入改动清单（落地即过期） | 已改写（§8「用量只记信息量；超预算只认权威信号」+ 投影坐标 + spawn/fork 边界） |
| 【漏项】README :124「62 例」、:127 smoke 描述 stale | 已改（72 例；smoke 描述改为 usage 投影 + 回退 + max-tokens） |
| 【漏项】`scripts/executor-smoke.mjs` 仍固定在 pressure 断言；该 harness 是**不重启**即可验证 usage 通路的地方 | 已扩：默认 registry 加 `sessionProjections` 假面，新增 4 条断言（usage 投影口径且 `measures === 0`、声明预算 + `max-tokens` → `overBudget: true`、未声明预算不采纳信号、无投影 → 回退 pressure 且不判超预算）；`npm run smoke:executor` → **SMOKE_PASS** |
| 【漏项】spawn 无 seed（换 fork 会含父会话前缀） | 记入 DESIGN §8 |
| 【漏项】`docs/STATUS.md` 无需改 | 与约定一致，无需动作 |

## 关闭记录

- 条目从 `docs/BACKLOG.md` §2 清理；其余条目重编（命令模板终态 → #1，executor 隔离 → #2，STATUS 对齐 → #3）；§1 索引 / §2 顺序依据 / §3 里程碑同步；索引里该条的措辞同步为「投影 `stateOf`（非 snapshot）+ 权威信号判超预算」。
- **残余**：① 会话内生效需重启 TUI（`task-engine` 为已挂载插件，`dist` 已重建）；② 「宿主真机子会话的 `tokenUsage` 投影可读」由**审阅用真实会话日志 + 宿主真实 fold 回放**证明（12 个子会话），并在 smoke harness 用假投影跑通全链路，但**尚未在运行中的 TUI 里跑一次真 subagent** 复看事件字段——重启后可一条命令确认（见下）；③ 模块级后续项见 `task-engine/docs/BACKLOG.md`（若有）。
- 本追踪文档移入 `docs/archived/`。
