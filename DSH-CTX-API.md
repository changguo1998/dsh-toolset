# DSH 核心 ctx API — 研读笔记（跨插件共享参考）

> 来源：官方 `deepseek-harness` clone（`~/GithubRepos/deepseek-harness`，**`dsh-v0.1.2-rc.1`** = commit `a66e470204`）。
> 上一版：`dsh-v0.1.1-rc.2`（commit `b150a551b8`，已归档至 `archive/DSH-CTX-API-0.1.1-rc.2.md`）。
> 用途：供 dsh-toolset 各插件（TUI、web、CLI、扩展……）在与 DSH 宿主集成时对齐契约；本文件为研读沉淀，只读参考，非实现。
> 状态：2026-09-08 首次对照 0.1.2-rc.1 更新。源码若演进，以仓库为准（版本号标注于每次更新）。

## 0. 运行时总览

- DSH 进程内宿主 = vendored `@deepseek-ai/cordis`：`Context` + `Service` + `Fiber` + `EventsService`。
- 插件（bundle）约定：`export { name, inject, Config, apply(ctx, config) }`，无 default export。
- 装配：`cordis.yml`（顶层 YAML 数组，`!!js` 可用做环境变量插值）；`dsh plugin --profile <p> add <pkg>` 经 bundle patch 自动挂载。
- **配置树机制（相对 0.1.1-rc.2 新增）**：`package.json` 的 `dsh.configTrees` 声明配置树挂载（如 `{ mount: "config/agent-presets", path: "../../packages/preset/agent-presets/presets", scanRoster: true }`）——agent-presets 不再随插件内置 `config/` 目录，而由配置树扫描供给。
- SDK/外部桥是官方推荐的"进程外"对接面（JSON-RPC over stdio），进程内则直接 `apply(ctx)` + `ctx.on`。

## 1. 会话核心 `@deepseek-ai/dsh-session`（`packages/core/session`）

**服务**：`ctx.sessions: SessionStore`（`Service`，inject key `'sessions'`）

- `create(id?, options?): Session` —— 一步创建并进 store + announce
- `prepare(id?, options?)` / `enter(session)`（返回 detach 闭包）/ `announce(session)` —— 拆开的创建事务（agent 工厂用）
- `get(id): Session | undefined` / `list()`
- `flush(session): Promise<boolean>` —— 持久化屏障（await 全部监听者）
- `fork(source, boundary?, childSessionId?): Session`
- `CreateSessionOptions.meta` **新增 `agentPreset?: string`**：会话级 agent 预设（持久化进 `SessionHeader.agentPreset`，决定该会话的工具与提示组合，保证 resume 时组合一致）。

**context 事件（`ctx.on(...)`）**：`session/created` / `session/event` / `session/flush` / `session/disposed` —— 与 0.1.1-rc.2 一致。

**Session 类**：

- `append(type, data, opts?)` —— 追加事件
- `events`（不可变快照）/ `seq`（逻辑序号）/ `firstLiveSeq`（构造来源前缀偏移）/ `header` / `deriveMessages()` / `surface`
- `firstLiveSeq: SessionLogOffset`，与 `session/end-seed`（空载荷、位置+time 表义，定位最后一个）对应。

**序号模型（相对 0.1.1-rc.2 破坏性变更）**：`refactor(session)!` 把**事件逻辑序号 `SessionSeq`** 与**日志偏移 `SessionLogOffset`** 分开（0.1.1-rc.2 里 seq = log length 单一契约）。会话事件内 `seq: SessionSeq`（会话内单调）；持久化偏移为 `SessionLogOffset`（=事件数，可含 gap/prefix/read offset）。两者均为品牌数字类型。

**SessionEvent envelope（0.1.2-rc.1）**：

```ts
type SessionEvent = {
  type: K                       // 判别联合（switch(type) 收窄 data）
  seq: SessionSeq               // 逻辑序号（SessionSeq 品牌）
  time: number                  // Unix epoch 毫秒
  data: SessionEventMap[K]
  ignorable?: true              // ★ 新增：未知类型可安全跳过的标记
} & (surface 事件条件附加：sourceEventSeqs?: SessionSeq[]; surfaceOp?: SurfaceOp)
```

- **`ignorable?: true`（新增兼容机制）**：写方只在纯信息记录上置 true；缺省=必需——读取方遇到不认识且未标记可忽略的类型**必须拒绝重建**（防止静默丢失语义）。这是词汇增长的不依赖注册表的兼容机制。
- surface 语义保持：`SurfaceOp = 'append' | { op: 'replace', start: SessionSeq, end: SessionSeq }`；`sourceEventSeqs` 引用来源事件（如 `assistant/chunk` seqs；`assistant/message` 可用空数组表已知空流）。

**事件词汇表**（`KNOWN_SESSION_EVENT_TYPES`，`packages/core/session/src/known-event-types.ts`，generated）：

- 0.1.1-rc.2 共 **48** 项 → 0.1.2-rc.1 共 **52** 项；**新增 3 项**：
  - `model/selection`
  - `session-log-deepseek/delivery-accepted`
  - `subagent/model-selection-policy`
  - （即 0.1.1-rc.2 文档「master 前瞻」所列 3 项，现已进词汇表）
- 其余命名延续，注意：**`agent-preset/selected`（连字符）**是正确事件名（0.1.1-rc.2 旧文档 §1 笔误写成 `agent/preset/selected`），载荷 `{ agentPreset: string }`。
- 事件载荷新增字段（0.1.2-rc.1）：
  - `assistant/message`：新增 `interrupted?: true`（取消流中途已交付文本/reasoning 前缀的标记）
  - `tool/result`：新增 `meta?: JsonValue`（工具私有展示载荷，如 `dsh-tool-fs` 的结果时上下文 diff；必须是 JSON-serializable，`Session.append` 运行时校验）
  - `turn/end` reason 扩展：`completed | aborted{reason} | blocked | error{error} | max-tokens | interrupted`（`interrupted` 是持久化后端重开 crash-orphan turn 时由加载方补记）
  - `compaction/summary`：**新增 `shadowedRange {start, end: SessionSeq}` 与 `sourceCommandId?`**（0.1.1-rc.2 只有 `shadowedSeqs[]`）

## 2. 流式契约 `StreamChunk`（`packages/llm/llm/src/types.ts`）

```
block-start{index, blockType} / text-delta{index,text} / reasoning-delta{index,text}
tool-call-delta{index,id,name?,argumentsDelta} / block-end{index,block}
usage{usage} / finish{reason, replayState?}
```

- 7 变体与 0.1.1-rc.2 完全一致；`assistant/chunk` 会话事件载荷 `{turn, step, chunk}` 不变。
- LLM 后端在 0.1.2-rc.1 拆出插件集：`llm-deepseek`、`llm-pi-ai`、`llm-replay`、`deepseek-llm-api-extensions`、`token-meter`；model discovery 复用 profile headers、provider headers 校验。
- 消费端折叠范例仍参考 web client `PartialAccumulator`（`packages/client/runtime/src/client/sessions/partial.ts`）。

## 3. 审批 `@deepseek-ai/dsh-user-approval`（`packages/interaction/user-approval`）

- 服务：`ctx.approval: ApprovalService`（inject `'approval'`）。
- 应答链事件：**`approval/request`**（waterfall）——监听者返回 `ApprovalOutcome` 即裁定；无人应答 fail-closed → `'unavailable'`。
- `ApprovalRequest = { agent, toolName, callId?, reason?, signal? }`；`id: ApprovalRequestId = randomUUID()`。
- `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（规范词汇；异常值统一 `unavailable`）。
- 会话审计对：`approval/asked {id, toolName, callId?, reason?}` / `approval/decided {id, outcome}`（log-only）。
- 策略：`ApprovalPolicy = 'ask' | 'never'`（`APPROVAL_POLICIES`）；`setApprovalPolicy(session, policy)` / `ctx.approval.setPolicy(agent, policy)`；`effectiveApprovalPolicy(events)` 折叠；`approval/policy` 会话事件。
- **关键约束保留**：`approval.request()` 必须在 open turn 内（`turn/start` 未闭合前）——审计对必须 turn-enclosed（turn 间裸事件重载会成 crash-tail 垃圾），否则抛错。

## 4. Agent（`packages/core/agent` + `dsh-agent-loop`）

- `ctx.agents: AgentRegistry`（inject `'agents'`）；创建由 loop 插件注册的 `AgentFactory` 提供（`setFactory`）。
- `AgentFactory.createAgent(ownerCtx, options): Promise<AgentHandle>` / `resume(ownerCtx, options)`；`AgentHandle = { agent, dispose() }`。
- 发送消息：`agent.followup(message)` → loop 端 `session.append('user/message', …, {surfaceOp:'append'})` → `turn/start` → `assistant/chunk*` → `turn/end`。
- `agents.create` 支持 `{ sessionId, meta: { cwd, … }, agentOptions: { provider, model, reasoningEffort?, maxTokens? } }`。
- 事件 `agent/status({agent, status})` — **agent 层事件，不在 session 日志词汇表**。

## 5. 官方外部桥（进程外对接，`packages/sdk/{client,protocol,server}`）

- JSON-RPC over stdio：stdout 全留给协议帧（**不得加载 stdout logger / approval UI / user-questions**）。
- **Methods**：`initialize{provider, model, reasoningEffort?, maxTokens?, cwd?}`（readiness 界，await loader settle；校验 reasoningEffort 非空、maxTokens 正安全整数、provider 有注册 adapter）→ `session/prompt {sessionId, contentBlocks} → {messageId}`（sessionId 惰性创建、并发去重）→ `shutdown`（flushes、dispose 根、exit 0）。未知方法回 JSON-RPC error。
- **Notifications**：`session.event {sessionId, event}`、`session.status {sessionId, idle|running}`、`subagent.started` / `subagent.finished`。
- 与 0.1.1-rc.2 的接口面一致；参考实现 `examples/acp-agent/`、`examples/jsonrpc-agent/`、`examples/headless-agent/`。

## 6. 对 dsh-toolset（特别是 TUI）插件的落点

- Adapter 契约同 0.1.1-rc.2：`onEvent`（订阅 `session/event` 转 `{sessionId, event}`）+ `sendMessage`（`session/prompt` / `agent.followup`）+ `approve(allow)`（`approval/request` 应答）。
- **seq 守卫更新**：改用事件内 `seq: SessionSeq` 做会话内单调去重/防倒序；日志偏移（offset）不参与。
- **未知事件处理**：TUI 只消费已知子集，识别的词典外事件若 `ignorable` 缺省时「上游负责拒重建」，TUI 可安全忽略并旁路展示。
- **tool/result.meta**：TUI tool 行可借用 `meta` 展示 `+N/-M` 类工具私有 diff（0.1.2-rc.1 起可用）。
- **assistant/message.interrupted**：TUI 流式区对取消流中途前缀做中断标记展示。
- **agent-preset/selected {agentPreset}**：per-session 预设选择事件（连字符名）；TUI preset 目录/当前值数据源（`agentPresetCatalog`）对应 `agent-preset/selected` 与 preset 配置树。
- Mode 块相关载荷稳定：`plan/mode {active}`、`sandbox/mode {mode, source?}`、`permission/preset {preset}`（0.1.2-rc.1 不变）。
- 状态标注：`session.status`(idle/running) 与 `agent/status` 用于 header。

## 7. 验证口径

- 词汇表：`grep -r "KNOWN_SESSION_EVENT_TYPES" packages/core/session/src/known-event-types.ts`（计数断言 52）。
- 审批：`grep "approval/request" packages/interaction/user-approval/src`。
- 格式版本：`SESSION_FORMAT_VERSION`（`packages/core/session/src/types.ts`，当前 0）。
- seq/offset 品牌：`SessionSeq` / `SessionLogOffset`（同文件）。

## 8. P2 事件载荷备注（2026-09-08，对照 dsh-v0.1.2-rc.1 源码核实）

> 与 0.1.1-rc.2 相比 9 项中有 2 项载荷变化（`subagent/descriptor` 版本号与应用、`compaction/summary` 字段），其余稳定；新增第 10 项 `agent-preset/selected`。TUI DshEvent 归一化规则沿用 0.1.1-rc.2 归档文档。

| 事件（0.1.2-rc.1 载荷） | 相对 0.1.1-rc.2 变化 | TUI DshEvent | 存储 |
| --- | --- | --- | --- |
| `goal/change` | `GoalChangeMeta` 增 `version: 1`（语义同前）：非 clear 带 `{operation, goal: GoalSnapshot, roundsStarted, createdAt, updatedAt}`；clear 带 `{cleared, clearedAt}` | `goal-change` 判别联合 | `goalBySession` |
| `todo/write` | 不变 `{todos: TodoItem[]}`（全量快照 last-write-wins） | `todo-write {todos}` | `todoBySession` |
| `plan/mode` | 不变 `{active: boolean}` | `mode {kind:'plan'}` | `modeBySession` |
| `sandbox/mode` | 不变 `{mode: 'read-only'\|'workspace-write'\|'danger-full-access', source?: 'delegation'}` | `mode {kind:'sandbox'}` | 同上 |
| `permission/preset` | 不变 `{preset: string}`；`PresetSpec{sandbox, approval, label?, …}` | `mode {kind:'permission'}` | 同上 |
| `step/start` / `step/end` | 不变 `{turn, step}` | `step {turn, step, phase}` | 透传 |
| `subagent/descriptor` | **`SUBAGENT_DESCRIPTOR_VERSION = 3`**；continuable 增 `agentReasoningEffort?`；其余 `{version, mode: one-shot\|continuable, provider, label?, agentProvider?, agentModel?, persona?, toolFilter?}` | `subagent {label(无 label 回落 provider), mode}` | 透传 |
| `compaction/summary` | **新增 `shadowedRange{start, end}: SessionSeq`、`sourceCommandId?`**；其余 `{compactionId, summary: ContentBlock[], shadowedSeqs[], shadowedTokenCount, provider, model, usage?}` | `compaction-summary {text, raw}` | `compactionBySession` |
| `agent-preset/selected` | **（新增条目）**`{agentPreset: string}`，服务层另以 `ctx.emit('agent-preset/selected', sessionId, preset)` 转播 | `agent-preset {preset}` | `presetBySession` |

- seq 守卫：adapter 按 sessionId 记 lastSeq（`SessionSeq`），`event.seq <= lastSeq` 丢弃；非当前活跃会话沿用丢弃。
- 事件词汇表来源：`packages/core/session/src/known-event-types.ts`（0.1.2-rc.1 计 52 项）。

## 9. 版本差异速览（0.1.1-rc.2 → 0.1.2-rc.1）

接口/契约面：

1. **session 序号模型拆分为 SessionSeq / SessionLogOffset**（破坏性），并新增 `SESSION_FORMAT_VERSION`（当前 0）与 `session/end-seed`。
2. **SessionEvent 新增 `ignorable?: true`** 兼容机制（词汇外事件可安全跳过）。
3. **事件载荷新字段**：`assistant/message.interrupted`、`tool/result.meta`、`turn/end` reason 扩展、`compaction/summary.shadowedRange`/`sourceCommandId`。
4. 词汇表 48 → 52（新增 `model/selection`、`session-log-deepseek/delivery-accepted`、`subagent/model-selection-policy`）。
5. **agent-presets 交付改配置树（`dsh.configTrees`）+ 会话级预设**（`SessionHeader.agentPreset`、`agent-preset/selected`）。
6. 会话持久化 JSONL-only（移除 SQLite 后端，0.1.2-rc.1 有 `session-persistence-jsonl` / `session-checkpoint-policy`）。
7. host 面：`dsh-host-apiproxy` 移除，unary RPC 迁 `dsh-api` Remote controllers + connection 持 RPC transport；`dsh-llm-*` 后端插件化；新增 webhook / hooks-claude-code / hooks-codex / sdk-app / sdk-minimal / acp / attachment-local / credentials-local / sandbox 系 / user-approval 等插件。
8. CLI：移除 demo；code-mode 更名 **PTC**。

> 完整源码对照：`git diff dsh-v0.1.1-rc.2 dsh-v0.1.2-rc.1`（1735 提交）。
