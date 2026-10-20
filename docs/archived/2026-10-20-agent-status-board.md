# agent 状态检查（待机 / 工作 / 卡死, 跨进程状态牌）（接取条目：docs/BACKLOG.md「agent 状态检查（待机 / 工作 / 卡死, 跨进程状态牌）」）

状态：关闭　　开启：2026-10-20　　关闭：2026-10-20
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

跨进程状态牌：每个会话把自身 agent 忙闲发布到 session-channel 的 Redis, 旁观者（组管理器等）只读判定 **离线 / 待机 / 工作 / 疑似卡死**。约束（用户指定）：判定不依赖目标 agent 工作循环、不涉及模型推理, **目标卡死时依然可判**。并入 agent-group 成员状态（`/group` 状态面 / 工具）。

## 调研

（已核实, 2026-10-20, 以 `~/GithubRepos/deepseek-harness` 源码为准）

- **事件**: `agent/status`, 载荷 `{ agent: Agent, status: AgentStatus }`; `AgentStatus = 'idle' | 'running'`（仅两态; 类型注释: `idle` = 无 driver 在跑, `running` = 被唤醒输入开始, 「不是第三个可观察状态」; `Agent.status` 同步镜像当前态）。事件声明在 `packages/core/agent/src/runtime-types.ts:280`（scoped, `this: Scoped<Agent>`）。
- **发射点**: `packages/core/agent-loop/src/agent.ts:150` `this.dispatch.emit('agent/status', { status })` —— 每个 agent driver（含子代理）各自发; 根 `ctx.on('agent/status', ({agent,status}) => …)` 可收全部, payload 带 `agent`。
- **agent → session 映射**: `Agent` 接口含 `readonly session: Session`（runtime-types.ts:168）—— 用 `agent.session.id` 把状态贴到对应会话; 主会话与子代理会话（`sub-*` 前缀 id）天然分开, 无串扰。
- **官方消费先例**: `goal-round-driver`（idle 检查点）、`compaction-basic`（回合结算）、`experimental/agent-team`、`sdk/server`、`session-controller` 均为根 `ctx.on('agent/status')` 订阅。
- **设计含义**: 订阅时不回放当前态 → 发布端 = **事件驱动更新 `state:<sessionId>` + 心跳(5 s)循环续期/兜底 + 关闭清理**; 读取端判据见「决策」③。
- **初始态（审计补）**: 发射点唯一（转换时），无订阅回放 → 在 **`agent/created`**（runtime-types.ts:261, 载荷 `{agent, source, signal}`）时读 `agent.status` 作初始值，之后事件驱动更新。
- 结论: 前置条件满足, session-channel 可经根 `ctx.on('agent/status')` + `agent.session.id` 实现发布, 无需宿主改动。

## 决策

（2026-10-20 用户裁定，与「轮次与终止的三个细节」同任务一并处理）

- ① 承载：**不新插件** —— session-channel 增**发布**（订阅 `agent/status` → 由现有非 agent 心跳循环刷 `state:<sessionId>` = `{status, at}` + 关闭清理）与**读数面**（`peers()` 增量带 `{status, at}` 或新增 `statusOf(sessionId)`）；agent-group **消费**判定。
- ② 检查间隔：组长侧**自动定时巡查**, 缺省 **20 s** 可配（廉价 Redis 读, 无推理、无目标交互）。
- ③ 卡死阈值：`stuckAfterMs` 缺省 **5 min** 可配；判据：alive 过期 = 离线; running 且 `at` 新 = 工作; running 且 `at` 超阈值 = 疑似卡死; idle = 待机。**`at` = 最近一次 `agent/status` 转换时刻（事件驱动写），心跳循环只续期 TTL、绝不更新 `at`** —— 否则卡死判不了（审计 2026-10-20 补正）。
- ④ 不做组级「轮次预算」（用户裁定「1 不定」）；组关闭语义（用户裁定）：「只有组长（创建组的 agent）可关闭；关闭 = 组内派发任务结束、未结任务终止；是连接关系的关闭，不连带关闭成员 agent（成员是否关由拉起方决定）」—— 落 #4 追踪文档 `agent-group/docs/implementation/2026-10-19-agent-group-rounds.md`。

## 规划

- 派单（2026-10-20 拆分, 按「每分支只改对应模块」原则）：
  - **dsh/session-channel**（本分支）: session-channel 发布端 + 读数面 + 工具扩展 + README/DESIGN。
  - **dsh/agent-group**: agent-group 消费判定 + 状态视图（含巡查配置面、四态判据），串行等本分支合 main。
- 步骤：session-channel 发布 + 读数面 → agent-group 判定 + 状态视图 → 测试 → 真机（≥2 会话: 待机 / 工作 / 疑似卡死 / 离线 四态）→ 收尾。
- 计划改动文件清单（本分支侧）：
  - `session-channel/src/keys.ts`（`stateKey` / `STATE_PATTERN` / `sessionIdFromStateKey`）
  - `session-channel/src/types.ts`（`AgentState`；配置 `agentStatus` / `agentStateTtlSec`）
  - `session-channel/src/broker.ts`（`announceAgentState` / `touchAgentState` / `clearAgentState` / `readAgentState` / `parseAgentState`）
  - `session-channel/src/index.ts`（订阅 `agent/status` / `agent/created` / `agent/disposed`、心跳续期、关闭清理、`statusOf`、工具 `action=state`、D5 服务面）
  - `session-channel/tests/agent-state.test.ts`（新）
  - `session-channel/README.md` / `docs/DESIGN.md`
  - 本追踪文档；项目级 `docs/BACKLOG.md`（收尾时清理由协调侧统一）
- 明确不做：不建新插件包；不改宿主代码；不做组级轮次预算。

## 接口契约（本分支：session-channel 发布端 + 读数面）

> 消费方 = agent-group 分支（串行）：判定逻辑归 agent-group，本契约只定义 session-channel 侧。

- **发布端**：根 `ctx.on('agent/status', ({agent, status}))`（宿主 `AgentStatus = 'idle' | 'running'`，`agent.session.id` 映射会话）→ 写 `state:<sessionId>` = JSON `{"status","at"}`；`at` = **最近一次状态转换时刻**（事件驱动写，epoch ms）。初始态：`agent/created` 无回放，读 `agent.status` 作初始值。清理：`agent/disposed`（代理离开注册表）删牌；`stop()` 清全部；崩溃靠 TTL 兜底。
- **心跳只续期、绝不刷 `at`**：心跳（`heartbeatMs`，5 s）对 `#agentStates` 各会话 `EXPIRE` 续 TTL（`touchAgentState`，不写值不刷 at）；同态 `agent/status` 事件也不刷 at —— 否则「running 且 `at` 超阈值 = 疑似卡死」判不了。
- **键位**：`dsh:session-channel:state:<sessionId>`（String，值 = `AgentState` JSON，TTL = `agentStateTtlSec`，缺省同 `presenceTtlSec` = 15 s）。`agentStatus: false` 关发布。
- **读数面（本分支新增）**：
  - 服务方法 `statusOf(sessionId)` → `{ok, state?: AgentState, error?}`；`state` 缺失 = 无状态牌（离线或发布端未就绪），离线判定仍以 alive+pid 为准。
  - 工具 `session_channel` 新增 `action=state`（`sessionId` 必填）→ `{ok, state?, error?}`。
- **判据映射（供 agent-group 消费，落 agent-group 分支）**：alive 过期 / pid 死 = 离线；`state.status='idle'` = 待机；`='running'` 且 `now-at <= stuckAfterMs` = 工作；`='running'` 且 `now-at > stuckAfterMs` = 疑似卡死；在线但无牌按待机（发布端未就绪短窗，不误报卡死）。`stuckAfterMs` 缺省 5 min 由 agent-group 配置。
- **不变量**：`at` 只被状态转换（`agent/status`）与初始（`agent/created`）写；心跳续期不写 `at`；`agent/disposed` / `stop()` 删牌后不再续 —— 「卡死」与「离线」都可在目标无响应时由旁观者只读判定（无模型推理、无目标交互、不要求目标进程协作）。

## 实现记录

（2026-10-20 实现并全量验证；含对协调侧交付实现的复核与两处补强）

- `session-channel/src/keys.ts`：新增 `stateKey(sessionId)`（`dsh:session-channel:state:<sid>`）、`STATE_PATTERN`、`sessionIdFromStateKey`。
- `session-channel/src/types.ts`：新增 `AgentState { status: "idle"|"running"; at }`；`SessionChannelConfig` 加 `agentStatus`（缺省开）与 `agentStateTtlSec`（缺省同 `presenceTtlSec`）。
- `session-channel/src/broker.ts`：新增 `announceAgentState`（转换时带 `at` 写值 + TTL）、`touchAgentState`（**只 EXPIRE 续期，不写值不刷 at**）、`clearAgentState`（关闭清理）、`readAgentState` / `parseAgentState`（形状容错）。
- `session-channel/src/index.ts`：
  - `#agentStates` 内存转换态（Map\<sessionId, AgentState>）；`agent/status` 事件（`agent.session.id` → 会话）**仅在状态转换时**更新 `at = now` 并写状态牌，同态事件不刷 at；`agent/created` 读 `agent.status` 作初始态（已有转换态不覆盖）；
  - **补强 1（本分支）**：订阅 `agent/disposed` → 删状态牌并清内存——已死代理（子代理收尾 / 会话销毁）不会被心跳续期，不会留下恒为 running 的「卡死假象」（原交付只靠 stop/TTL，已死子代理的 running 牌会被续期挂住）；
  - `#heartbeat` 追加 `touchAgentState`（只续 TTL）；`stop()` 清理状态牌并清内存；
  - 读数面 `statusOf(sessionId)`（读单牌，无牌 → `{ok:true, state?}`）；`SERVICE_FACE_METHODS` / `provide("sessionChannel")` 同步注册（D5 守卫）；
  - **补强 2（本分支）**：`session_channel` 工具新增 `action=state`（`sessionId` 必填）——读数面在工具侧可查（原交付只有服务面）；
  - 模块 helper `agentSessionIdOf` / `agentStatusOf`（顶层 `status` 优先、`agent.status` 兜底，结构面容错）。
- `session-channel/tests/agent-state.test.ts`（新，8 用例）：parse 边界；broker 写/续期/清（touch 幂等不建键）；TTL 熬过验证（续期后 at 不变）；服务层 created 初始态 → 转换刷 at → 同态与心跳不刷 at；`agent/disposed` 清牌且心跳不复活；工具 `action=state` 可查；关闭清理；跨实例 B 经 statusOf 读 A 发布的牌。

## 偏差

- **读数面选型**（决策①）：从「`peers()` 增量带 `{status,at}` 或新增 `statusOf`」二选一，选 **新增 `statusOf(sessionId)`**——不动 `PeerInfo` 落盘形状与既有 peers 消费方；组内成员是固定小集合，逐成员单读即廉价（无推理）。
- **状态牌 TTL**（决策③同族）：复用 `presenceTtlSec`（缺省 15 s）为缺省、`agentStateTtlSec` 可覆盖，不新增第三套 TTL 配置；心跳 5 s 续期足够，「两轮巡查（20 s）之间牌不消失」。
- **`agent/disposed` 补强**（相对原交付）：决策③「关闭时清理」补上「代理离开注册表即删牌」一环，避免已死子代理的 running 牌被心跳持续续期造成卡死假象；TTL 仍是最终兜底。
- **首连重试窗口**：`agent/created` 可能早于连接建立（Redis 晚起），事件不回放 → 该会话首个转换前无牌。判据把「在线无牌」按待机处理，不误报卡死；首个 `agent/status` 转换后自动补齐（接受，与协调侧偏差一致）。

## 测试与证据

- `npm --prefix session-channel run check` 通过；`npm run build` 通过；`npm run test` **71/71** 绿（含 `tests/agent-state.test.ts` 8 用例）。
- 关键不变量断言：① 同态 `agent/status` 与心跳都不刷新 `at`（broker `touchAgentState` 只 EXPIRE + 服务层跨多心跳核验）；② TTL 只续期可熬过原 TTL（1 s 牌续期后跨过 1.2 s 仍可读且 at 不变）；③ `agent/disposed` 后内存与 Redis 双清、心跳不复活；④ 跨实例经 `statusOf` 读到异地发布的牌。
- **真机**（2026-10-20，实时 Redis + 真实 dsh 进程；临时隔离 profile 挂本分支构建，用后即清）：启动即发布（新会话 `agent/created` → `state:<id>` = `{"status":"idle","at":<启动时刻>}`，TTL 随心跳刷新 10→14 s）；转换驱动（经通道注入一条消息 → 对端真实消费并回复 → 状态 `idle → running( at=注入时刻 ) → idle( at=回合结束时刻 )`，`at` 两次都等于事件时刻）；心跳不刷 at（跨多次心跳 `at` 恒定 1792491907187）；进程退出后 alive/state 键 ≤ ~15 s 内被 TTL 清除（残留 0 键）。
- **真机四态复验**（agent-group 消费端，2026-10-20，`dsh --profile fff` 两会话 A/B，A 建组 group-1 + 加 B 为成员，A 经 `agent_group` 工具 `status` 读 `memberStates`）：
  - **待机**：初始与 B 长任务结束回落均为 `state=idle`（rawStatus=idle）✓；
  - **工作**：A 处理回合期间自身 `manager=working`（rawStatus=running，`at` 新）✓；
  - **疑似卡死**：把 B 的状态牌手工置为 `running` 且 `at` 超 5 min，跨 24 s 心跳后 `at` 仍是手工旧值（心跳只续 TTL，不刷 at），A 经轮询缓存刷新后判 `b=stuck`（rawStatus=running）✓；
  - **离线**：关闭 B 进程 → alive 键 ≤15 s 过期 → A 判 `b=offline`（无 rawStatus；离线不依赖对端参与）✓；
  - 心跳不刷 at + 离线不依赖对端在两个环节分别确认；全程判定只读 Redis、无模型推理、不触碰对端工作循环。

## 收尾

- 已完成：session-channel 发布 / 读数面（dsh/session-channel 分支, 合 main 705d39a）与 agent-group 消费端（判据③ + 2b 组长轮询 + close_group, dsh/agent-group 分支, 合 main 5dec007 + 双分支真机验证）全部落地; 全量 check / build / test 通过（session-channel 71/71, agent-group 63/63）; 真机四态复验通过; 本追踪文档关闭并归档; BACKLOG 条目 1 移除（归协调侧统一清理）; #4 rounds 追踪文档归档。
