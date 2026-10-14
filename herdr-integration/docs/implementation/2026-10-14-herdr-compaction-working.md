# 压缩会话历史期间显示为工作中（接取条目：herdr-integration/docs/BACKLOG.md「压缩会话历史期间应显示为工作中（现显示 idle）」）

状态：决策　　开启：2026-10-14　　关闭：-
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

上下文压缩（`/compact` 手动或自动触发）期间，herdr 面板上报 `working` 而不是 `idle`；压缩正常结束与带 `error` 结束都必须回落，不卡在 `working`；阻塞态优先级不变（压缩中同时 turn 阻塞仍上报 `blocked`）。

## 调研

来源：宿主包（全局安装的 dsh 0.9.4 依赖树，非本仓代码）+ herdr 0.9.4 文档与 schema + 本机会话日志实测 + 本包既有源码。

1. **根因（本包代码）**：活跃度只由根 agent 状态推导 —— `agentActive = roots.some((agent) => agent.status === "running")`（`src/main.ts:189`，启动期同口径 `:272`）。压缩在 turn 循环之外执行，不产生 `agent/status` 的 `running` 转移，故压缩全程 `agentActive === false`，`desiredState()`（`src/state.ts:55`）落到 `idle`。

2. **可用信号（宿主契约已核）**：压缩是会话事件，本包既有的 `session/event` 订阅（`src/main.ts:265`）即可收到，无需新增订阅面。声明见 `@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js` 的 `SessionEventMap`：

   - `compaction/start`：`{ compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }`
   - `compaction/end`：`{ compactionId; sourceCommandId?; turn: number | null; error?: string }`
   - 另有 `compaction/summary` / `compaction/prune`（不做状态用）。

   发射点：`@deepseek-ai/dsh-compaction-basic/lib/index.js:469`（start）与 `:484`（成功 end）、`:495`（失败路径同样发 `compaction/end`，带 `error`）——**end 必然配对，含失败分支**。手动压缩 `owner === null`（无开放 turn），自动压缩 `turn` 为当前 turn。

3. **监听者收到的第一参数是 Session 实例**（`dsh-session/lib/index.js:1468` 把 `[this, event]` 传给 `session/event`；`Session.id` 取 `header.id`，`dsh-session/lib/types/index.js:356`），故订阅处可用会话 id 过滤。

4. **herdr 0.9.4 协议面**：`PaneReportAgentParams.message` 为可选字符串（`herdr api schema --json`），且官方文档「Agent state reporting」的示例就是 `state: "working"` + `message: "building docs"`（https://herdr.dev/docs/socket-api/ ），说明 working 态带 message 是被支持的展示语义（`state_labels` 是另一套展示覆盖机制，本包不用）。

5. **子 agent 压缩存在性（实测）**：解压本机 12 份会话日志（`~/.dsh/sessions/*/*/session.v4.jsonl.zstd`）统计 —— 其中 2 份为子 agent 会话（`origin: subagent`），**均无 `compaction/start`**；2 份根会话含压缩。样本不支持「子 agent 会压缩」，但订阅面确实会收到子会话事件（`session/event` 为会话作用域，根 ctx 订阅者收全部会话）。

## 决策

决策项 1（压缩计数口径）：选项 (a) 只算根会话；(b) 所有会话都算 —— **选定 (a)**。理由：与 README 既有边界「只跟踪根 agent」一致；子 agent 压缩不该点亮主面板（否则根 agent 空闲时面板显示工作中，语义错）。实现上用会话 id 比对 `currentSessionRef.id`（启动期同步后已就位）。

决策项 2（是否带 message）：选项 (a) 带，且只给 working 态；(b) 带并按状态切换、转换时改写；(c) 不带 —— **选定 (a)**。理由：herdr 的 `message` 是「记录当前态」的语义（每次 `pane.report_agent` 全量描述当前态），转 blocked/idle 时不再带 message 即已不显示，无需回头改写（选项 b 的额外发送路径改动没有收益）。文案在 `state.ts` 内定为常量 `COMPACTING_MESSAGE = "compacting context"`，由 `desiredState` 计算，避免调用方各写一份。

决策项 3（是否区分压缩类型）：选项 (a) 不区分；(b) 区分手动 `/compact`（`sourceCommandId` 非空）与自动压缩 —— **选定 (a)**。理由：两者都是 LLM 摘要在跑，观感一致；区分需两套文案与分支，收益有限。

## 规划

任务拆分：

1. `state.ts`：`desiredState()` 增第四参 `compacting`（压缩中），优先级 `blocked > working > idle`，working 两种来源（`agentActive` / `compacting`）共用，压缩期带 `COMPACTING_MESSAGE`。
2. `main.ts`：`session/event` 分支认 `compaction/start` / `compaction/end`，用 `Set<compactionId>` 配对（只收当前根会话的事件），end 无论有无 `error` 都移除条目；移除后重算并上报。
3. 单测：`tests/state.test.ts` + `tests/main.test.ts` 补压缩期用例（含 error 分支、blocked 优先、子会话过滤、未配对 end 兜底）。
4. `README.md`：「能力」表补压缩期一行，测试计数与概要同步。

计划改动文件清单（本清单之外的文件不改）：

- `herdr-integration/docs/BACKLOG.md`（条目状态：进行中 → 完成 → 收尾清理）
- `herdr-integration/docs/implementation/2026-10-14-herdr-compaction-working.md`（本文件）
- `herdr-integration/src/state.ts`
- `herdr-integration/src/main.ts`
- `herdr-integration/tests/state.test.ts`
- `herdr-integration/tests/main.test.ts`
- `herdr-integration/README.md`

明确不做：

- 不新增订阅面（复用既有 `session/event`）；不改 `BlockTracker`（压缩不是「等用户」，不复用阻塞语义 —— 见条目「不要复用 BlockTracker」）。
- 不区分 `/compact` 与自动压缩（决策 3），不读 `sourceCommandId`。
- 不上报 herdr 的 `done` 状态（本包只用 `working` / `blocked` / `idle` 三态，与现状一致）。
- 不做压缩进度百分比之类的新展示面（herdr 协议无此语义）。
- 不改 `src/herdr.ts`（message 透传路径已存在，`sendState` 已按 `message !== undefined` 附带）。
- 不改 `scripts/verify-herdr.mjs`（已支持 `node scripts/verify-herdr.mjs working "compacting context"`，真机验证够用）。

## 实现记录

（待补）

## 偏差

（待补）

## 测试与证据

（待补）

## 收尾

（待补）
