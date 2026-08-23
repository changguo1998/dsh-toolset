# DSH 核心 ctx API — 研读笔记（跨插件共享参考）

> 来源：官方 `deepseek-harness` clone（`~/GithubRepos/deepseek-harness`，git pull 至 `b150a551b8` = `dsh-0.1.1-rc.2`）。
> 用途：供 dsh-toolset 各插件（TUI、web、CLI、扩展……）在与 DSH 宿主集成时对齐契约；本文件是阶段 0（ctx API spike）研读的沉淀，属只读研究结论，非实现。
> 状态：2026-08-23 首次沉淀。源码若演进，以仓库为准（版本号标注于每次更新）。

## 0. 运行时总览

- DSH 进程内宿主 = vendored `@deepseek-ai/cordis`：`Context` + `Service` + `Fiber` + `EventsService`。
- 插件（bundle）约定：`export { name, inject, Config, apply(ctx, config) }`，无 default export。
- 装配：`cordis.yml`（顶层 YAML 数组，`!!js` 可用做环境变量插值）；`dsh plugin --profile <p> add <pkg>` 经 bundle patch 自动挂载。
- SDK/外部桥是官方推荐的"进程外"对接面（JSON-RPC over stdio），进程内则直接 `apply(ctx)` + `ctx.on`。

## 1. 会话核心 `@deepseek-ai/dsh-session`

**服务**：`ctx.sessions: SessionStore`（`Service`，inject key `'sessions'`）

- `create(id?, options?): Session` —— 一步创建并进 store + announce
- `prepare(id?, options?)` / `enter(session)`（返回 detach 闭包）/ `announce(session)` —— 拆开的创建事务（agent 工厂用）
- `get(id): Session | undefined` / `list()`
- `flush(session): Promise<boolean>` —— 持久化屏障（await 全部监听者）
- `fork(source, boundary?, childSessionId?): Session`

**context 事件（`ctx.on(...)`）**：

| 事件 | 载荷 | 语义 |
| ------------------ | ------------------ | ---------------------------------------------------------- |
| `session/created` | `(session)` | 进库时同步宣告；同步抛出可否决回滚 |
| `session/event` | `(session, event)` | append 后 fire-and-forget 推送（提交后回调、观察失败隔离） |
| `session/flush` | `(session)` | 持久化 checkpoint，awaitable |
| `session/disposed` | `(session)` | 离开 store |

**Session 类**：

- `append(type, data, opts?)` —— 追加事件（opts 仅 surface 事件用，携带 `surfaceOp`）
- `events`（不可变快照）/ `seq`（= log length 连续契约）/ `header` / `deriveMessages()` / `surface`
- `firstLiveSeq`（本进程构造来源；注意持久化事件才是权威）

**事件词汇表**（`KNOWN_SESSION_EVENT_TYPES`，generated，勿手改）：
`user/message` `assistant/message` `assistant/chunk` `tool/call` `tool/result` `turn/start` `turn/end`
`approval/asked` `approval/decided` `approval/policy` `session/title` `goal/change` `todo/write`
`plan/mode` `feedback/record` `compaction/*` `command/run|done` `request/context|header`
`sandbox/mode` `subagent/descriptor` `agent/preset/selected` …… 完整集合见 `KNOWN_SESSION_EVENT_TYPES`。

- **surface 语义**：`user/message`|`assistant/message`|`tool/result` 需 `surfaceOp`（`'append'` 或 `{op:'replace', start, end, ...}` + `sourceEventSeqs`）。模型可见历史只由 surface 事件推导；人可读 transcript 应取 **append-origin** 事件（`isAppendSurfaceEvent`），因为 replace 会影子覆盖已展示内容。

## 2. 流式契约 `StreamChunk`（`@deepseek-ai/dsh-llm`）

```
block-start{index, blockType} / text-delta{index,text} / reasoning-delta{index,text}
tool-call-delta{index,id,name?,argumentsDelta} / block-end{index,block}
usage{usage} / finish{reason, replayState?}
```

- `assistant/chunk` 会话事件载荷 = `{turn, step, chunk}`。
- 消费端折叠范例：web client 的 `PartialAccumulator`（`packages/client/runtime/src/client/sessions/partial.ts`）把 chunk 折叠成 `AssistantBlock[]`（块级不可变，delta 只换块引用），`block-index` 可乱序（稀疏数组洞）。TUI 流式区照此累计。

## 3. 审批 `@deepseek-ai/dsh-user-approval`

- 服务：`ctx.approval: ApprovalService`（inject `'approval'`）。
- 应答链事件：**`approval/request`**（waterfall 模式）——监听者返回 `ApprovalOutcome` 即裁定；无人应答 fail-closed → `'unavailable'`。
- `ApprovalRequest = { agent, toolName, callId?, reason?, signal? }`。
- `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（规范词汇；异常/非词汇返回值统一归一为 `unavailable`，失败闭合）。
- 会话审计对：`approval/asked {id, toolName, callId?, reason?}` / `approval/decided {id, outcome}`（log-only，非 surface）。
- 策略：`approval/policy`（`'ask'`默认 | `'never'` 恒拒）；`effectiveApprovalPolicy(events)` 折叠。
- **关键约束：`approval.request()` 必须在 open turn 内**（`turn/start` 未闭合前），否则抛错——TUI 触发审批的时机要放在 turn 内。
- 配置：`Config.policy`（部署默认），`ctx.approval.setPolicy(agent, policy)` 运行时切换。

## 4. Agent（`@deepseek-ai/dsh-agent` + `dsh-agent-loop`）

- `ctx.agents: AgentRegistry`（inject `'agents'`）；创建由 loop 插件注册的 `AgentFactory` 提供（`setFactory`）。
- `create/createAgent(ownerCtx, options): Promise<AgentHandle>`；`AgentHandle = { agent, dispose() }`。
- 发送消息：`agent.followup(message)` → loop 端 `session.append('user/message', …, {surfaceOp:'append'})` → `turn/start` → `assistant/chunk*` → `turn/end`。
- 事件 `agent/status({agent, status})` — **是 agent 层事件，不在 session 日志词汇表**（注意：早期社区文档误把 `agent/status` 列进 session 事件；以本文件为准）。
- `resume(ownerCtx, options)` 恢复持久化会话。

## 5. 官方外部桥（进程外对接）

- `@deepseek-ai/dsh-sdk-protocol`（types/transport/JsonRpcLineTransport）+ `@deepseek-ai/dsh-sdk-jsonrpc-server`。
- JSON-RPC over stdio：stdout 全留给协议帧（**不得加载 stdout logger / approval UI / user-questions**）。
- Methods: `initialize`（readiness 界；会 await loader settle）→ `session/prompt {sessionId, contentBlocks} → {messageId}` → close；`shutdown`（flushes、dispose 根、exit 0）。
- Notifications: `session/event {sessionId, event}`、`session.status {sessionId, idle|running}`、`subagent.started|finished`。
- `inject: ['agents']`；`maxTokensAsSuccess` 决定 token 截断是否算成功。
- 参考实现：`examples/jsonrpc-agent/`（README + cordis.yml + minimal.py）。

## 6. 对 dsh-toolset(特别是 TUI)插件的落点

- **Adapter 契约**（`DshAdapter`）自然对应：`onEvent`（订阅 `session/event` 转 `{sessionId, event}`）+ `session/prompt`/`agent.followup` 对应 `sendMessage` + `approval/request` 应答对应 `approve(allow)`。
- 事件子集关注：stream（`assistant/chunk` 的 `text-delta/reasoning-delta`）、message（`user/message`、`assistant/message`）、approval（`approval/request`+审计对）、agentStatus（`agent/status`）。
- **surface/transcript 规则**：TUI 展示会话历史取 append-origin 事件；chunk 按 `{turn,step,index}` 折叠。
- 退出契约：宿主侧 `shutdown`（flush→dispose root→exit 0）；进程外桥 stdout 归协议；`dsh` bin 管 EOF/信号退出。
- 状态标注：`session.status`(idle/running) 与 `agent/status` 用于 header 状态栏。

## 7. 验证口径

- 契约对齐以本仓库源码为准；如需自动校验可跑 `grep -r "KNOWN_SESSION_EVENT_TYPES" packages/core/session` 与 `grep "approval/request" packages/interaction/user-approval`。
- 后续升级：pull master 后重述第 1/2/3 节关键类型（`SessionEventMap`、`StreamChunk`、`ApprovalRequest/Outcome`）。
