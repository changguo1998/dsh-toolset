# 注入标准统一与合并（接取条目：`docs/BACKLOG.md`「注入标准统一与合并」；由 `rule-engine` BACKLOG「同一次触发的多条注入合并为一条」与 `symbol-normalizer` BACKLOG「同一进程内的压缩不会补注入开局指南」两条合并而来）

状态：进行中　　开启：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标（用户 2026-10-01 指令要点）

1. rule-engine 统一控制与管理这些「步骤」，增加对更多宿主节点的支持。
1. 其他插件只需在 rule-engine 注册，指明**需要的唤醒时机**和**要进行的操作**，由 rule-engine 在时机到来时唤醒。
1. 两类注入采用**同样的标准**（接取条目口径，见 `docs/BACKLOG.md` 同名条目）；据此顺带修掉「同一进程内的压缩不补注入开局指南」。

## 调研

### 现状（`rule-engine/src/engine.ts`，2026-10-01 读码）

- 规则的匹配面：`tool-call` / `tool-result` / `assistant-text` / `turn-end` / `compaction`（压缩只在 `compaction/end` 评估）。
- 消费者只在 `turn/end` 被询问（`#askConsumers`，`ConsumerContext.trigger` 固定 `"turn-end"`）→ 压缩后消费者收不到唤醒。
- 判空：规则侧 `#inRecord` 读会话可见投影（`deriveMessages()`）；消费者侧无此能力，`symbol-normalizer` 自管 `hasGuideMessage` 与进程内 gate。
- 写入：一条命中一次 `injector.inject(...)`，即一条独立 user 消息。
- 现状唤醒口径：`assistant-text` / `turn-end` 只对 `completed` / `max-tokens` 评估（`:72-75`）。

### 证据（本会话记录，2026-10-01）

- 压缩 seq 8194–8197 之后只有 skill 注入（8198，来自 `compaction` 面），指南无补注入（此后 200+ 事件、含多次回合边界）。
- 指南注入共 6 次：开局 1 次 + 之后 5 次各自紧跟一次压缩（压缩也是 5 次）；两次纯重载无注入 → 缺口属「同进程压缩不补」，不是「跨重启去重失效」。

### `session-start` 注入可达性（作者自定核查，配套「节点表全加」；读宿主源码 `@deepseek-ai/dsh@0.1.7-rc.2`）

agent 工厂发布顺序（`dsh-agent-loop/lib/index.js:1729-1737`）：会话 enter → agent enter（进 registry）→ `sessions.announce(session)`（同步 emit `session/created`）→ `agents.announce(agent, source)`。

- `session/created` 时 `agents.get(sessionId)` **已可用** → 注入可达。
- `agent.inject(msg)` = `send(msg, "next-step", wakeup=false)`（`:812-814`）：只入队不唤醒，在最近的 step 边界交付；inbox 投影持久化，长时间没有回合也不丢。`followup` / `steer` 会主动起工作，`session-start` 节点不用。
- `publish(source)` 的 source 含 `resume`（`:1955`）→ 该节点语义是「会话被 publish（含恢复）」，不是「只新会话」。
- `sessions.announce` 是**同步**派发，宿主注释明确 throwing listener 会回滚会话 attach → 监听器永不抛。
- 在该节点注入的送达点是**第一个 step 边界**，做不到「首个请求前可见」。

## 决策（用户 2026-10-01 裁定）

1. **统一节点派发 + 声明式注册**：rule-engine 统一控制与管理节点并增加节点；插件只注册「唤醒时机 + 要进行的操作」，由 rule-engine 在时机到来时唤醒。
1. **节点表全加**（含 `session-start`），见下「节点表」。
1. **操作第一版只做「返回注入内容」**，不支持在时机上执行工具 / 改状态。
1. **消费者一次唤醒只返回 1 段**（`{ text, summary } | null`）；需要多段由消费者自己合并。
1. **`dedupeInRecord` 改为整型**：含义是「投影里最多允许 N 条本注入」，**0 = 无限制**（缺省）。
1. **合并**：同一次触发的多条命中合并成**一条**注入消息；同一次触发内按 `delivery` 分组，组内合并。
1. **对齐点合并：尺度双 flag**，见下节。
1. **使用约定**：能合并的消费者应行为一致；同一消费者在不同节点需要不同语义（例：`turn-end` 要 `reason`、`step-end` 不要）→ **拆成两个注册**或**关闭合并**。
1. **`delivery` 保持两种枚举**（`next-step` / `followup`），本次不加送达路径。

### 节点表

| 节点 id | 宿主事件 | 文本载荷 |
|---------|----------|----------|
| `session-start` | `session/created`（context 事件，另一挂点） | 空 |
| `user-message` | `user/message` | 消息文本 |
| `turn-start` | `turn/start` | 空 |
| `assistant-text` | `turn/end`（回合缓冲） | 回合正文 |
| `turn-end` | `turn/end` | 回合正文 |
| `step-start` | `step/start` | 空 |
| `step-end` | `step/end` | 空 |
| `tool-call` | `tool/call` | 工具名 + 参数 |
| `tool-result` | `tool/result` | 结果文本 |
| `compaction` | `compaction/end` | 空 |

### 对齐点合并：尺度双 flag

**用户给定的骨架**：尺度层级 `session` ⊃ `turn` ⊃ `step` ⊃ `tool`；每个尺度两个 flag（end-flag 在 start 清、start-flag 在上一轮 end 清）；收尾按顺序触发、触发前查 flag 的或，为真则不再触发；允许 `reset` 指定值；合并缺省开启；能合并的消费者行为应一致，不一致就拆成两个注册或关闭合并。

**动作定义**（用户要求区分三者的含义与时机）：

- **查（read）**：唤醒前的判据读取，只读不改。
- **置（set true）**：唤醒之后，把「本窗口已按此方向唤醒过」记为真。
- **清（set false）**：开新窗口（`*-start`）或关闭本窗口（`*-end`）时，把上一轮的记录作废。

**含义**：状态是「每消费者 × 每会话 × 每尺度 × {start, end}」；尺度 S 的窗口 = `S 的 start` → `S 的 end`；`startFired[S]` = 本窗口 start 已唤醒过（窗口内幂等）；`endFired[S]` = 本窗口 end 已唤醒过（供本尺度与更粗尺度的 end 判据使用）。

**时机表（实现细化，非用户裁定；待实现时验证）**

| 事件 | 先「查」（只读） | 唤醒条件 | 唤醒后「置 / 清」 | 被吞时 |
|------|------------------|----------|-------------------|--------|
| `*-start`（尺度 S） | `startFired[S]` | 为**假** | 置 `startFired[S]`；清 `endFired[S 及更细]`、`startFired[更细]` | 「清零」照常，不置位 |
| `*-end`（尺度 S） | `endFired[S 及更细]` 的或 | 全**假** | 置 `endFired[S]`；清 `startFired[S]` | 「清 `startFired[S]`」照常，`endFired` 不动 |

**其余实现细化**

- **未注册的节点绝不唤醒、绝不置位**：只有被该消费者注册的节点才参与「查」与「置」（否则每回合先到的 `step/end` 会替消费者置位，把已注册的 `turn-end` 永久吞掉）。
- **「清」与注册无关，按宿主事件无条件执行**：`*-start` 的清零、`*-end` 到达时的「清 `startFired[S]`」都要做——清零是窗口账簿，跨回合 / 跨步的恢复全靠它（只注册 `turn-end` 的消费者也必须在每个 `turn/start` 恢复，否则第二次起永远被吞）。
- `*-end` 的「清 `startFired[S]`」与是否唤醒无关：窗口关闭即清（否则被吞的那一轮会把 `startFired[turn]` 留成真，下一回合的 `turn-start` 也被吞）。
- `*-start` 的清零范围与时机表一致：清 `endFired[本尺度及更细]`、清 `startFired[更细]`（本尺度的 `startFired` 由本尺度 `*-end` 清）。开新窗口意味着上一轮更细窗口必然已结束（异常中断时可能残留 `startFired[step]` 之类）。
- `session` 尺度没有 end 节点 → `session-start` **不设窗口幂等**（不使用 `startFired[session]`），每次 `session/created` 到达都唤醒（否则同进程内 resume / 重新 attach 时会被永久吞）。
- 节点 → 尺度归属：`session-start` → session(start)；`user-message` / `turn-start` → turn(start)；`assistant-text` / `turn-end` → turn(end)；`step-start` → step(start)；`step-end` → step(end)；`tool-call` → tool(start)；`tool-result` → tool(end)；`compaction` **不参与合并**（每次到达都触发）。
- 消费者 `decide()` 的返回值可带指定值 `reset`：**全清**本消费者的 flag（用户裁定），表示「这次唤醒不算吞并」。

**走查一（正常回合，示意 2 步，含回合末尾的吞并）**

前提：该消费者注册了表中全部节点（`turn-start` / `step-start` / `step-end` / `turn-end`）。只注册其中一部分时：未注册节点不唤醒、不置位，但「清」照常。

| 事件 | 查（结果） | 置 / 清 |
|------|------------|---------|
| `turn/start` | `startFired[turn]` = 假 | 置 turn.startFired；清 turn/step/tool 的 endFired、清 step/tool 的 startFired |
| `step/start` | `startFired[step]` = 假 | 置 step.startFired；清 step/tool 的 endFired、清 tool.startFired |
| `step/end` | `endFired[step/tool]` = 假 | 置 step.endFired；清 step.startFired |
| `step/start`（第 2 步） | `startFired[step]` = 假（上一步 `step/end` 已清） | 同第一步 |
| `step/end`（第 2 步） | `endFired[step/tool]` = 假 | 置 step.endFired；清 step.startFired |
| `turn/end` | `endFired[turn/step/tool]`：step 已真 | **吞掉**；`endFired` 不动，但仍清 `startFired[turn]` |
| `turn/start`（下一回合） | `startFired[turn]` = 假（上一回合 `turn/end` 已清） | 清 turn/step/tool 的 endFired、清 step/tool 的 startFired → 全部恢复 |

**走查二（异常残留：回合被中断，没有 `step/end`）**

前提同上。`turn/start` → `step/start`（置 step.startFired）→ 中断 → `turn/end`（`endFired` 全假；本例只示意 flag 残留，该回合是否唤醒取决于唤醒口径，见「决策补充」）→ 下一回合 `turn/start` 清掉 step.startFired，残留不会误吞。

## 计划改动文件清单（实现落点）

1. `rule-engine/src/types.ts`：节点枚举扩展（5 个新节点）；`ConsumerRegistration` 加 `sources?: RuleSource[]`、`dedupeInRecord?: number`；`ConsumerContext` 扩展 `trigger` 取值并新增 `event?`；注入消息元数据加 `summaries: string[]`；规则侧 `dedupeInRecord: boolean` → `number`。
1. `rule-engine/src/rules.ts` / `src/match.ts`：`RULE_SOURCES` 与空条件口径随新节点同步（`dedupeInRecord` 整型归一化：旧 `true → 1`、`false → 0`，非法值取缺省 0 并记 warning）。
1. `rule-engine/src/engine.ts`：事件 → 节点映射（含 `session/created` 第二挂点）；统一派发（规则命中 + 消费者唤醒）；尺度双 flag 状态机；逐段闸门；合并写入；逐段记账。
1. `rule-engine/src/inject.ts`：合并写入形态。
1. `rule-engine/src/main.ts`：订阅 `session/created`；服务面透传新字段。
1. `rule-engine/src/tools.ts`：`rule_add` / `rule_update` 的 `source` 描述补新节点，并把 `dedupeInRecord` 入参从布尔改为整型。
1. `symbol-normalizer/src/main.ts` / `src/guide.ts`：指南改 `sources: ["turn-end", "compaction"]` + `dedupeInRecord: 1`，删进程内 gate 与 `hasGuideMessage`；回合审查保持 `turn-end`、`dedupeInRecord: 0`（缺省）。
1. 测试：`rule-engine/tests/{engine,match,rules,inject,main}.test.ts`、`symbol-normalizer/tests/{main,guide}.test.ts`（含 `dedupeInRecord` 0 / 1 / N 三态、尺度 flag 时机表、`reset`）。
1. 文档：两包 `README.md` / `docs/DESIGN.md`（+ 需要时 `TUI/docs/DESIGN.md`）。

**实现注意**

- `session/created` 监听器永不抛（宿主会回滚会话 attach）。
- `user-message` 会包含本引擎自己注入的 user-role 消息 → 需按 `source.kind` 排除，避免自触发。
- `step-start` / `step-end` 频次高（本会话 1300+ 次），派发要廉价。

## 决策补充（2026-10-01 追加裁定）

1. **唤醒口径**（用户裁定「可以」＝沿用现状）：`turn-end` / `assistant-text` 只认 `completed` / `max-tokens`；其余节点（`session-start` / `user-message` / `turn-start` / `step-start` / `step-end` / `tool-call` / `tool-result` / `compaction`）不受 reason 限制，到达即按 flag 判据处理。
1. **合并元数据与计数单位**（用户授权作者决定）：
   - 注入消息 `source` 保留 `summary`（取首段摘要）并新增 `summaries: string[]`（按段顺序）；
   - `dedupeInRecord` 计数 = 会话可见投影中命中该 key（`summary` 或 `summaries` 命中）的消息**条数**；
   - 每回合上限以「**段**」计（`maxInjectionsPerTurn` 缺省 3）；超限的段丢弃并记 warning，其余段照常合并写入；同回合同正文去重仍逐段。

## 实现记录

（待实现后填）

## 测试与证据

（待实现后填）

## 收尾

（待关闭）
