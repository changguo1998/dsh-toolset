# DSH 核心 ctx API（跨插件共享参考）

> 来源：官方 `deepseek-harness` clone（`~/GithubRepos/deepseek-harness`，`dsh-v0.1.5-rc.2` = commit `fb2c4b9e69`）。
> 用途：供 dsh-toolset 各插件（TUI、herdr-integration、knowledge-base、task-engine）在与 DSH 宿主集成时对齐契约；本文件为研读沉淀，只读参考，非实现。
> 版本口径：以 `dsh-v0.1.5-rc.2` 为准。源码若演进，以仓库为准。

## 0. 运行时总览

- DSH 进程内宿主 = vendored `@deepseek-ai/cordis`：`Context` + `Service` + `Fiber` + `EventsService`。
- 插件（bundle）约定：`export { name, inject, Config, apply(ctx, config) }`，无 default export。
- 装配：`cordis.yml`（顶层 YAML 数组，`!!js` 可用做环境变量插值）；`dsh plugin --profile <p> add <pkg>` 经 bundle patch 自动挂载。
- **配置树机制**：`package.json` 的 `dsh.configTrees` 声明配置树挂载（如 `{ mount: "config/agent-presets", path: "../../packages/preset/agent-presets/presets", scanRoster: true }`）——agent-presets 由配置树扫描供给，不随插件内置 `config/` 目录。
- SDK/外部桥是官方推荐的"进程外"对接面（JSON-RPC over stdio），进程内则直接 `apply(ctx)` + `ctx.on`。

## 1. 会话核心 `@deepseek-ai/dsh-session`（`packages/core/session`）

**服务**：`ctx.sessions: SessionStore`（`Service`，inject key `'sessions'`）

- `create(id?, options?): Session` —— 一步创建并进 store + announce
- `prepare(id?, options?)` / `enter(session)`（返回 detach 闭包）/ `announce(session)` —— 拆开的创建事务（agent 工厂用）
- `get(id): Session | undefined` / `list()`
- `flush(session): Promise<boolean>` —— 持久化屏障（await 全部监听者）
- `fork(source, boundary?, childSessionId?): Session`
- `CreateSessionOptions.meta` 支持 **`agentPreset?: string`**：会话级 agent 预设（持久化进 `SessionHeader.agentPreset`，决定该会话的工具与提示组合，保证 resume 时组合一致）。

**context 事件（`ctx.on(...)`）**：`session/created` / `session/event` / `session/flush` / `session/disposed`。

**Session 类**：

- `append(type, data, opts?)` —— 追加事件
- `events`（不可变快照）/ `seq`（逻辑序号）/ `firstLiveSeq`（构造来源前缀偏移）/ `header` / `deriveMessages()` / `surface`
- `firstLiveSeq: SessionLogOffset`，与 `session/end-seed`（空载荷、位置+time 表义，定位最后一个）对应。

**序号模型**：事件逻辑序号 `SessionSeq` 与日志偏移 `SessionLogOffset` 分离。会话事件内 `seq: SessionSeq`（会话内单调）；持久化偏移为 `SessionLogOffset`（=事件数，可含 gap/prefix/read offset）。两者均为品牌数字类型。

**SessionEvent envelope**：

```ts
type SessionEvent = {
  type: K                       // 判别联合（switch(type) 收窄 data）
  seq: SessionSeq               // 逻辑序号（SessionSeq 品牌）
  time: number                  // Unix epoch 毫秒
  data: SessionEventMap[K]
  ignorable?: true              // 未知类型可安全跳过的标记
} & (surface 事件条件附加：sourceEventSeqs?: SessionSeq[]; surfaceOp?: SurfaceOp)
```

- **`ignorable?: true` 兼容机制**：写方只在纯信息记录上置 true；缺省=必需——读取方遇到不认识且未标记可忽略的类型**必须拒绝重建**（防止静默丢失语义）。这是词汇增长的不依赖注册表的兼容机制。
- surface 语义：`SurfaceOp = 'append' | { op: 'replace', start: SessionSeq, end: SessionSeq }`；`sourceEventSeqs` 引用来源事件（如 `assistant/attempt` seqs；`assistant/message` 可用空数组表已知空流）。

**事件词汇表**（`KNOWN_SESSION_EVENT_TYPES`，`packages/core/session/src/known-event-types.ts`，generated；当前 53 项）：

- **流式事件**：`assistant/attempt`（载荷 `{turn, step, stream: AssistantStreamRecord[]}`，流记录数组；早期 `assistant/chunk` 仅存于 v0 迁移器历史类型）。
- **工具派发**：`tool/ptc-dispatch` / `tool/ptc-dispatch-start`（PTC；早期 `tool/code-dispatch*` 更名）。
- **其余主要事件**：`assistant/message`、`turn/start` / `turn/end`、`agent/status`（agent 层，不在会话词汇表）、`goal/change`、`todo/write`、`plan/mode`、`sandbox/mode`、`permission/preset`、`step/start` / `step/end`、`subagent/descriptor`、`subagent/catalog`、`subagent/model-selection-policy`、`compaction/summary` / `compaction/prune`、`model/selection`、`session-log-deepseek/delivery-accepted`、`deliverables/presented`、`feedback/record` / `feedback/message-delete` / `feedback/message-put`、`system/message`（system role 消息，requireOpenStep）、`agent-preset/selected`、`llm/retry` / `llm/retry-started`、`tool-workflow/*`、`command/run` / `command/done`、`hook/*`、`schedule/change`、`approval/policy`、`approval/asked` / `approval/decided`、`agent/inbox/spliced`、`team/*`（实验包）、`session/end-seed`、`session/title-llm-request`、`request/header` / `request/context`、`web/deepseek-search-llm-request`。
- `agent-preset/selected`（连字符）为正确事件名，载荷 `{ agentPreset: string }`。
- 事件载荷要点：`assistant/message.interrupted?: true`（取消流中途已交付文本/reasoning 前缀标记）；`tool/result.meta?: JsonValue`（工具私有展示载荷，JSON-serializable，`Session.append` 运行时校验）；`turn/end` reason：`completed | aborted{reason} | blocked | error{error} | max-tokens | interrupted`；`compaction/summary` 含 `shadowedRange{start, end: SessionSeq}`、`shadowedSeqs[]`、`shadowedTokenCount`、`sourceCommandId?`。
- `SESSION_FORMAT_VERSION = 3`：resume 历史经 v0→v1→v2→v3 迁移器后方可读。

## 2. 流式契约 `StreamChunk`（`packages/llm/llm/src/types.ts`）

```
block-start{index, blockType} / text-delta{index,text} / reasoning-delta{index,text}
tool-call-delta{index,id,name?,argumentsDelta} / block-end{index,block}
usage{usage} / finish{reason, replayState?}
```

- 7 变体；对应会话事件为 `assistant/attempt`（`stream: AssistantStreamRecord[]`）。
- ContentBlock **含 `FileBlock`**（`type: 'file'`，`attachment: FileAttachmentRef`）：文件以确定性句柄文本投递（名称/字节数/只读保存路径），持久化日志保留结构化引用。
- `SystemPromptUpdate = 'in-history'` 与 `LlmCallConfig.systemPromptUpdate?`；`system` prompt 语义区分 one-shot（直接映射 system slot）与 loop-built（leading system-role message）。
- **LLM 默认模型**：Chat Completions 默认 **DeepSeek V41 Flash**（V4 / V4 Flash Vision Exp 目录项并存）。
- LLM 后端插件集：`llm-deepseek`、`llm-pi-ai`、`llm-replay`、`deepseek-llm-api-extensions`、`token-meter`；model discovery 复用 profile headers、provider headers 校验。
- 消费端折叠范例参考 web client `PartialAccumulator`（`packages/client/runtime/src/client/sessions/partial.ts`）。

## 3. 审批 `@deepseek-ai/dsh-user-approval`（`packages/interaction/user-approval`）

- 服务：`ctx.approval: ApprovalService`（inject `'approval'`）。
- 应答链事件：**`approval/request`**（waterfall）——监听者返回 `ApprovalOutcome` 即裁定；无人应答 fail-closed → `'unavailable'`。
- `ApprovalRequest = { agent, toolName, callId?, reason?, signal? }`；`id: ApprovalRequestId = randomUUID()`。
- `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（规范词汇；异常值统一 `unavailable`）。
- 会话审计对：`approval/asked {id, toolName, callId?, reason?}` / `approval/decided {id, outcome}`（log-only）。
- 策略：`ApprovalPolicy = 'ask' | 'never'`（`APPROVAL_POLICIES`）；`setApprovalPolicy(session, policy)` / `ctx.approval.setPolicy(agent, policy)`；`effectiveApprovalPolicy(events)` 折叠；`approval/policy` 会话事件。
- **关键约束**：`approval.request()` 必须在 open turn 内（`turn/start` 未闭合前）——审计对必须 turn-enclosed（turn 间裸事件重载会成 crash-tail 垃圾），否则抛错。

## 4. Agent（`packages/core/agent` + `dsh-agent-loop`）

- `ctx.agents: AgentRegistry`（inject `'agents'`）；创建由 loop 插件注册的 `AgentFactory` 提供（`setFactory`）。
- `AgentFactory.createAgent(ownerCtx, options): Promise<AgentHandle>` / `resume(ownerCtx, options)`；`AgentHandle = { agent, dispose() }`。
- 发送消息：`agent.followup(message)` → loop 端 `session.append('user/message', …, {surfaceOp:'append'})` → `turn/start` → `assistant/attempt`\* → `turn/end`。
- `agents.create` 支持 `{ sessionId, meta: { cwd, … }, agentOptions: { provider, model, reasoningEffort?, maxTokens? } }`。
- 事件 `agent/status({agent, status})` — **agent 层事件，不在 session 日志词汇表**。
- **inbox 模块化**：`agent/inbox/inserted`、`agent/request`、`agent/pre-step` 事件名与载荷不变（`runtime-types.ts`）；inbox 实现位于 `agent-loop/src/inbox.ts`，引入持久化投影 `inbox = {next-turn, next-step}`（wire 层 `InboxWireState` JSON 安全形）。时序：projection registry 提交事件先于 `Session.append()` 返回。
- **model-selection 模型切换通知**：provider/model 变化时经 `agent/pre-step`（`{prepend: true}` 监听者）向下一 request 注入 user-role `[model changed: A → B]` 通知消息；effort 级变化、空决策不注入。`agent/pre-step` 出现官方 prepend 监听者，监听顺序语义注意。
- **scope 事件表**：`agent/assistant-stream`（agent 作用域事件，args 取 `agent`，与 `assistant/attempt` 分属两条线）；remotes 含 `goal/activation-changed`。

## 5. 官方外部桥（进程外对接，`packages/sdk/{client,protocol,server}`）

- JSON-RPC over stdio：stdout 全留给协议帧（**不得加载 stdout logger / approval UI / user-questions**）。
- **Methods**：`initialize{provider, model, reasoningEffort?, maxTokens?, cwd?}`（readiness 界，await loader settle；校验 reasoningEffort 非空、maxTokens 正安全整数、provider 有注册 adapter）→ `session/prompt {sessionId, contentBlocks} → {messageId}`（sessionId 惰性创建、并发去重）→ `shutdown`（flushes、dispose 根、exit 0）。未知方法回 JSON-RPC error。
- **Notifications**：`session.event {sessionId, event}`、`session.status {sessionId, idle|running}`、`subagent.started` / `subagent.finished`。
- 参考实现 `examples/acp-agent/`、`examples/jsonrpc-agent/`、`examples/headless-agent/`。

## 6. 对 dsh-toolset（特别是 TUI）插件的落点

- Adapter 契约：`onEvent`（订阅 `session/event` 转 `{sessionId, event}`）+ `sendMessage`（`session/prompt` / `agent.followup`）+ `approve(allow)`（`approval/request` 应答）。
- **seq 守卫**：改用事件内 `seq: SessionSeq` 做会话内单调去重/防倒序；日志偏移（offset）不参与。
- **未知事件处理**：TUI 只消费已知子集，词典外事件若 `ignorable` 缺省时「上游负责拒重建」，TUI 可安全忽略并旁路展示。
- **tool/result.meta**：TUI tool 行可借用 `meta` 展示 `+N/-M` 类工具私有 diff。
- **assistant/message.interrupted**：TUI 流式区对取消流中途前缀做中断标记展示。
- **agent-preset/selected {agentPreset}**：per-session 预设选择事件；TUI preset 目录/当前值数据源（`agentPresetCatalog`）对应 `agent-preset/selected` 与 preset 配置树。
- Mode 块载荷：`plan/mode {active}`、`sandbox/mode {mode, source?}`、`permission/preset {preset}`。
- 状态标注：`session.status`(idle/running) 与 `agent/status` 用于 header。
- **流式归一化**：消费 `assistant/attempt` 的 stream 数组；工具派发匹配 `tool/ptc-dispatch*`。`assistant/message` / `turn/start` / `turn/end` / `agent/status` 不变。
- **FileBlock**：消息渲染按块类型分发时需覆盖 `type:'file'` 块。
- **模型切换 notice**：0.1.5 起切模型注入 user-role notice 消息块，消息列表/流式区需容忍展示；当前模型经 `session.requestHeader()` 读取。
- **format v3**：resume 历史经 v0→v1→v2→v3 迁移后方可读；TUI 只展示不重建。

## 7. 验证口径

- 词汇表：`grep -r "KNOWN_SESSION_EVENT_TYPES" packages/core/session/src/known-event-types.ts`（绝对数以 generated 文件为准）。
- 审批：`grep "approval/request" packages/interaction/user-approval/src`。
- 格式版本：`SESSION_FORMAT_VERSION`（`packages/core/session/src/types.ts`，当前 3；含 v0→v1→v2→v3 迁移器）。
- seq/offset 品牌：`SessionSeq` / `SessionLogOffset`（同文件）。

## 8. 事件载荷与 TUI 映射

| 事件 | 载荷 | TUI DshEvent | 存储 |
| --- | --- | --- | --- |
| `goal/change` | `GoalChangeMeta` 含 `version: 1`：非 clear 带 `{operation, goal: GoalSnapshot, roundsStarted, createdAt, updatedAt}`；clear 带 `{cleared, clearedAt}` | `goal-change` 判别联合 | `goalBySession` |
| `todo/write` | `{todos: TodoItem[]}`（全量快照 last-write-wins） | `todo-write {todos}` | `todoBySession` |
| `plan/mode` | `{active: boolean}` | `mode {kind:'plan'}` | `modeBySession` |
| `sandbox/mode` | `{mode: 'read-only'\|'workspace-write'\|'danger-full-access', source?: 'delegation'}` | `mode {kind:'sandbox'}` | 同上 |
| `permission/preset` | `{preset: string}`；`PresetSpec{sandbox, approval, label?, …}` | `mode {kind:'permission'}` | 同上 |
| `step/start` / `step/end` | `{turn, step}` | `step {turn, step, phase}` | 透传 |
| `subagent/descriptor` | `SUBAGENT_DESCRIPTOR_VERSION = 3`；continuable 增 `agentReasoningEffort?`；其余 `{version, mode: one-shot\|continuable, provider, label?, agentProvider?, agentModel?, persona?, toolFilter?}` | `subagent {label(无 label 回落 provider), mode}` | 透传 |
| `compaction/summary` | `{compactionId, summary: ContentBlock[], shadowedSeqs[], shadowedTokenCount, shadowedRange{start,end}: SessionSeq, sourceCommandId?, provider, model, usage?}` | `compaction-summary {text, raw}` | `compactionBySession` |
| `agent-preset/selected` | `{agentPreset: string}`，服务层另以 `ctx.emit('agent-preset/selected', sessionId, preset)` 转播 | `agent-preset {preset}` | `presetBySession` |

- seq 守卫：adapter 按 sessionId 记 lastSeq（`SessionSeq`），`event.seq <= lastSeq` 丢弃；非当前活跃会话沿用丢弃。
- 事件词汇表来源：`packages/core/session/src/known-event-types.ts`（当前 53 项）。
