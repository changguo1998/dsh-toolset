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

- 派单（2026-10-20 拆分, 按「每分支只改对应模块」原则）：
  - **dsh/session-channel**（新分支）: session-channel 发布端 + 读数面 + 工具扩展 + README/DESIGN。
  - **dsh/agent-group**（已有分支, 会话已开工）: 仅 `agent-group/` 消费判定 + 巡查（20 s）+ 状态视图; 不碰 `session-channel/`。
  - 协作顺序（串行）: session-channel 先实现合 main + 重建 → agent-group 基于已合并读数面实现消费 → 真机四态（需 session-channel 已在 profile 生效）。
  - 接口契约: 读数面签名由 session-channel 定（`peers()` 增量带 `{status, at}` 或新增 `statusOf(sessionId)`）, agent-group 按契约消费。
- 步骤：session-channel 发布 + 读数面 → agent-group 判定 + 巡查 + 状态视图 → 测试 → 真机（≥2 会话: 待机 / 工作 / 疑似卡死 / 离线 四态）→ 收尾。
- 计划改动文件清单（预估）：
  - `session-channel/src/**`（发布 `state:<sessionId>`、读数面、工具扩展）
  - `agent-group/src/**`（判定 + 巡查 + 状态视图）
  - `session-channel/README.md` / `docs/DESIGN.md`、`agent-group/README.md` / `docs/DESIGN.md`
  - `agent-group/docs/implementation/2026-10-19-agent-group-rounds.md`（#4 裁定记录; 该文档由分支侧更新）
  - 本追踪文档；项目级 `docs/BACKLOG.md`（接取已标; 收尾时清理）
- 明确不做：不建新插件包；不改宿主代码；不做组级轮次预算。

## 实现记录

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
