# herdr-integration 待办

> 职责：herdr-integration 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、能力面与边界（见 `herdr-integration/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史、`herdr-integration/docs/archived/` 与 `herdr-integration/tests/`，不在此重复。
> 条目结构（2026-10-14 起）：现象 / 现状 → 期望 → 落点 → 验收 → 估时 → 来源·状态·优先级。

## 待办

**#2 压缩会话历史期间应显示为工作中（现显示 idle）**（2026-10-14 登记）：**现象 / 现状** —— 上下文压缩（`/compact` 或自动触发）期间 herdr 面板显示 `idle`，但此时确实有摘要在跑（LLM 调用）；用户 2026-10-14 实测看到空闲态。**根因（已定位到代码）** —— 活跃度只由根 agent 状态推导：`agentActive = roots.some((agent) => agent.status === "running")`（`src/main.ts:189`，启动期同口径 `:272`），而压缩在 turn 循环之外执行、不产生 `agent/status` 的 `running` 转移，故压缩全程 `agentActive === false` → `desiredState()`（`src/state.ts:55`）落到 `idle`。**可用信号（已核宿主契约，无需新增订阅面）** —— 压缩是**会话事件**，本包既有的 `session/event` 订阅（`src/main.ts:213`）即可收到：`compaction/start {compactionId, sourceCommandId?, turn}` 与 `compaction/end {compactionId, sourceCommandId?, turn, error?}`（另有 `compaction/summary` / `compaction/prune`）；声明见宿主 `SessionEventMap`（`@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js:647`，同一份声明在 `dsh-api-session-controller` 等包重复出现），发射点见 `@deepseek-ai/dsh-compaction-basic/lib/index.js:469`（start）与 `:484` / `:495`（end，失败关闭也发一条）。
**期望** —— `compaction/start` 到对应 `compaction/end` 之间上报 `working`；`compaction/end` 带 `error` 时同样必须恢复（不能卡在 working）。**不要复用 `BlockTracker`** —— 那会把状态做成 `blocked` + message，语义错（面板那个态的含义是「等用户」）。做法：`desiredState()` 增加一个「压缩中」入参（例如 `desiredState(agentActive, blocked, blockedMessage, compacting)`，`compacting` 与 `agentActive` 同为 working 输入、`blocked` 优先级不变），`main.ts` 按 `compactionId` 计数 start / end。**接取时裁定** —— ① 是否只对**根会话**的压缩计数：`session/event` 的 session 参数当前被忽略（`src/main.ts:213` 形参 `_session`），子 agent 会话也会压缩，是否过滤成 `currentSessionRef.id` 需定口径；② 上报要不要带 message（如 `compacting context`，便于面板区分两种 working）；③ 是否区分 `/compact`（`sourceCommandId` 非空）与自动压缩（初判不区分，都是 working）。**落点** —— `src/state.ts`（`desiredState` 增参）、`src/main.ts`（`handleSessionEvent` 增两个分支与计数）、`tests/state.test.ts` + `tests/main.test.ts`（补用例）、`README.md`（「能力」表补压缩期状态一行）。**验收** —— ① 单测：start 后上报 `working`、end 后回落，含 `error` 分支与「压缩中同时 turn 阻塞 → blocked 优先」；② 真机 `dsh --profile fff` 在 herdr 面板内跑一次 `/compact`，压缩全程面板显示工作中；③ `npm run check` + `npm run build` + `npm test`（现 35 例）。**估时** —— 0.5 天以内（信号已确认，改动集中在一个推导函数与一个事件分支）。**优先级** —— P2（展示偏差，不影响功能；长会话里压缩可持续数十秒，观感影响真实）。**来源** —— 2026-10-14 用户要求（「压缩会话历史时也应当显示为工作中（现在是 idle）」）。〔待办: 2026-10-14 登记〕
