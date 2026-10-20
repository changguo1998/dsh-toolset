# agent 状态检查（待机 / 工作 / 卡死, 跨进程状态牌）（接取条目：docs/BACKLOG.md「agent 状态检查（待机 / 工作 / 卡死, 跨进程状态牌）」）

状态：规划　　开启：2026-10-20　　关闭：
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

- 派单（2026-10-20 生效, 单一分支）: 归 **dsh/agent-group** 分支（agent-group worktree 会话承接, session-channel 发布 / 读数面 + agent-group 消费判定一并实现, 与「轮次与终止的三个细节」同任务）。此前曾一试拆分 dsh/session-channel 分支的派单已作废回滚, 本条以最新派单为准。
- 步骤：核实 `agent/status` 事件 → session-channel 发布 + 读数面 → agent-group 判定 + 巡查 + 状态视图 → 测试 → 真机（≥2 会话: 待机 / 工作 / 疑似卡死 / 离线 四态）→ 收尾。
- 计划改动文件清单（预估）：
  - `session-channel/src/**`（发布 `state:<sessionId>`、读数面、工具扩展）
  - `agent-group/src/**`（判定 + 巡查 + 状态视图）
  - `session-channel/README.md` / `docs/DESIGN.md`、`agent-group/README.md` / `docs/DESIGN.md`
  - `agent-group/docs/implementation/2026-10-19-agent-group-rounds.md`（#4 裁定记录; 该文档由分支侧更新）
  - 本追踪文档；项目级 `docs/BACKLOG.md`（接取已标; 收尾时清理）
- 明确不做：不建新插件包；不改宿主代码；不做组级轮次预算。

## 实现记录

（待写。）

## 实现记录

**session-channel（发布 + 读数面）**：

- `session-channel/src/keys.ts`：新增 `stateKey(sessionId)`（`dsh:session-channel:state:<sid>`）、`STATE_PATTERN`、`sessionIdFromStateKey`。
- `session-channel/src/types.ts`：新增 `AgentState { status: "idle"|"running"; at }`；`SessionChannelConfig` 加 `agentStatus`（缺省开）与 `agentStateTtlSec`（缺省同 presenceTtlSec）。
- `session-channel/src/broker.ts`：新增 `announceAgentState`（转换时带 `at` 写值 + TTL）、`touchAgentState`（**只 EXPIRE 续期，不写值不刷 at**）、`clearAgentState`（关闭清理）、`readAgentState` / `parseAgentState`（形状容错）。
- `session-channel/src/index.ts`：
  - `#agentStates` 内存转换态（Map\<sessionId, AgentState>）；`agent/status` 事件（`agent.session.id` → 会话）**仅在状态转换时**更新 `at = now` 并写状态牌，同态事件不刷 at；`agent/created` 读 `agent.status` 作初始态（已有转换态不覆盖）；
  - `#heartbeat` 追加 `touchAgentState`（只续 TTL）；`stop()` 清理状态牌并清内存；
  - 读数面 `statusOf(sessionId)`（读单牌，无牌 → `{ok:true, state?}`）；`SERVICE_FACE_METHODS` / `provide("sessionChannel")` 同步注册（D5 守卫）；
  - 模块 helper `agentSessionIdOf` / `agentStatusOf`（顶层 `status` 优先、`agent.status` 兜底，结构面容错）。
- `session-channel/tests/agent-state.test.ts`（新，6 用例）：parse 边界；broker 写/续期/清；TTL 熬过验证（续期后 at 不变）；服务层 created 初始态 → 转换刷 at → 同态与心跳不刷 at；关闭清理；跨实例 B 经 statusOf 读 A 发布的牌。

**agent-group（消费判定 + 状态视图）**：

- `agent-group/src/types.ts`：`AgentGroupConfig` / `ResolvedConfig` 加 `stuckAfterMs`（缺省 5 min）与 `statusPollMs`（缺省 20 s）；新类型 `AgentStateVerdict = offline|idle|working|stuck` 与 `MemberStateView`；`GroupTransport` 加 `peers()`（在线集）与 `statusOf(sessionId)`。
- `agent-group/src/transport.ts`：`SessionChannelFace` 加可选 `statusOf?`；实现 transport 的 `peers`（face.peers → sessionIds）与 `statusOf`（旧版无 statusOf → `transport_error` 带下一步）。
- `agent-group/src/core.ts`：
  - `judgeAgentState`（纯函数，判据③）：不在在线集 = offline；idle = idle；running 且 `now - at ≤ stuckAfterMs` = working；running 且超阈值 = stuck；在线无牌按 idle（不误报卡死）；
  - `memberStatesOf(group, lookup, now, stuckAfterMs)`：在线集一次取 + 每成员状态牌单读；transport 失败 → undefined（不阻塞只读）；
  - `readGroupStatus` 加可选 `opts`（`memberLookup` / `now` / `stuckAfterMs`），提供时每组附 `memberStates`；
  - `GroupService.status()` 动作附 `memberStates`（成员状态视图，不落盘不镜像）。
- `agent-group/tests/core.test.ts`：FakeTransport 补 `peers` / `statusOf`（可注入 `online` / `agentStates` / 失败）；新增 3 用例——judgeAgentState 四态与边缘；status 成员状态视图与 transport 失败降级；readGroupStatus 带 lookup / 缺省。
- `agent-group/docs/implementation/2026-10-19-agent-group-rounds.md`：#4 裁定记录（1 不设组级预算；2 检查间隔由状态牌巡查承担；3 仅组长可关 / 关闭=任务结束+未结终止+连接关闭 / 不连带关成员；本轮不实现 `close_group`）。

## 偏差

- **巡查落地**（决策②）：未在 agent-group 内建常驻 `interval` 巡查器——agent-group 无「组长 → 其组」的会话表，多实例会重复读同一批状态牌；落地为「状态牌判定面 + status / 只读服务每次调用现算」（调用即巡查，间隔由调用方决定），`statusPollMs` 参数已接受为配置面。真机以「心率观察 + 跨实例读牌」验证四态可判。
- **读数面选型**（决策①）：从「`peers()` 增量带 `{status,at}` 或新增 `statusOf`」二选一，选 **新增 `statusOf(sessionId)`**——不动 `PeerInfo` 落盘形状与既有 peers 消费方；group 成员是固定小集合，逐成员单读即廉价（无推理）。
- 状态牌 TTL 复用 `presenceTtlSec`（默认 15 s），不新增第三套 TTL 配置（心跳 5 s 续期足够）。

## 测试与证据

- `npm --prefix session-channel run check` 通过；`npm --prefix session-channel run test` **69/69** 绿（新增 `tests/agent-state.test.ts` 6 用例，含 TTL 熬过验证与「同态 / 心跳不刷 at」）。
- `npm --prefix agent-group run check` 通过；`npm --prefix agent-group run test` **59/59** 绿（新增 judgeAgentState / status 状态视图 / readGroupStatus lookup 3 用例）。
- `npm --prefix session-channel run build`、`npm --prefix agent-group run build` 通过。
- （真机 ≥2 会话四态验证安排在合 main + 重建 dist + 重启会话后进行，见收尾。）

## 收尾

- 待办：格式化改动文件 → 提交询问点（§5：实现后 check+build 已过 → 问一次是否提交代码与测试）→ 用户同意后提交 → 向协调会话 `ui-ravine-5e31` 汇报（含 check/test 结果、是否需合并主分支）→ 协调合 main + 重建 dist → 真机 ≥2 会话四态（待机 / 工作 / 疑似卡死 / 离线；心跳不刷 at；离线不依赖对端）→ 收尾（追踪文档关闭 + BACKLOG 条目 1 移除 + 归档 + 收尾提交）并经 channel 回报含可否关闭。
