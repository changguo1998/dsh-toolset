# 注入标准统一与合并（接取条目：`docs/BACKLOG.md`「注入标准统一与合并」；由 `rule-engine` BACKLOG「同一次触发的多条注入合并为一条」与 `symbol-normalizer` BACKLOG「同一进程内的压缩不会补注入开局指南」两条合并而来）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
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
1. **两条真实注入统一到 `step-end` 并合并**（2026-10-01 真机压缩路径验证后用户裁定；原两条分别挂 `tool-call` / `compaction` 与 `turn-end` / `compaction`）：
   - 代码：`symbol-normalizer` 指南消费者改 `sources: ["step-end"]` + `delivery: "next-step"`（原缺省 `followup`），`dedupeInRecord: 1` 不变；
   - 运行时（仓库外，经 `rule_add` / `rule_remove` 落地）：两条 skill 规则合并为一条 `id: skill-autoload`（`source: "step-end"` + `delivery: "next-step"` + `dedupeInRecord: 1`）；
   - 效果：同一次 `step-end` 触发下两段同 `delivery` 分组 → **合并为一条注入**（`source.summaries` 两段）；压缩把注入挤出投影后由判空自然补一次，不再依赖 `compaction` 节点。
1. **投递三态：`inject` / `steer` / `followup`**（2026-10-01，真机核对队列后用户裁定）：宿主 `Agent` 有**三条**投放路径，原模型只表达了两条——`followup`（next-turn 队列 + 唤醒）、`steer`（next-step 队列 + 唤醒）、`inject`（next-step 队列、**不唤醒**）；原 `delivery: "next-step"` 映射的是 `inject`，会话空闲时条目要等到下一个回合开启（= 下一条用户输入）才送出，与「注入应当尽快送达」不符。裁定：`delivery` 扩为三值、与宿主方法同名（`inject` / `steer` / `followup`，缺省 `followup` 不变），**两条真实注入改 `steer`**；不把时机与投递拆成组合式固定节点名（两轴正交，拆开即 10 节点 × 3 投递的组合膨胀，而合并键本就是「同节点 + 同 `delivery`」）。

## 实现记录（2026-10-01）

`rule-engine`：

1. `src/types.ts`：`RuleSource` 扩为十项节点；`dedupeInRecord` 改整型（`Rule` / `NormalizedRule`）；`InjectionRequest.summaries`；`ConsumerContext.trigger` 扩为 `RuleSource` 并新增 `event?`；`ConsumerFeedback.reset`；`ConsumerRegistration.sources` / `dedupeInRecord`。
1. `src/rules.ts`：`RULE_SOURCES` 同步十项；`normalizeRule` 的 `dedupeInRecord` 走整型归一（旧布尔 `true → 1` / `false → 0`，非法取 0 并记 warning）。
1. `src/match.ts`：新增 `BOUNDARY_SOURCES`（六项边界节点），空条件 = 无条件命中的口径按它判定。
1. `src/engine.ts`：事件 → 节点映射（`turn/start` / `user/message` / `step/start` / `step/end` / `tool/call` / `tool/result` / `turn/end` → `assistant-text` + `turn-end` / `compaction/end`）；`#dispatch` 统一派发（规则 + 消费者）→ 逐段闸门 → 按 `delivery` 分组 → 合并写入（多段 `source.summaries`）；`#countInRecord` 计数版判空（支持 `summaries`）；尺度双 flag 状态机（清与注册无关、置只在注册节点、`session-start` 无幂等、`reset` 全清）；`sessionCreated()` 供 `session/created` 挂点。
1. `src/inject.ts`：`buildInjectionMessage(text, summary, summaries?)`，多段时写 `source.summaries`。
1. `src/main.ts`：订阅 `session/created`（含恢复）→ `engine.sessionCreated`；`EventBus` 增加该事件签名。
1. `src/tools.ts`：`source` 描述改为节点表；`dedupeInRecord` 入参布尔 → 整型。

`symbol-normalizer`：

1. `src/main.ts`：指南改声明式注册（`sources: ["turn-end", "compaction"]` + `dedupeInRecord: 1`），删除进程内 gate 与 `hasGuideMessage` 判空；`inject` 依赖由 `["ruleEngine", "sessions"]` 收敛为 `["ruleEngine"]`。
1. `src/guide.ts`：删除 `SymbolGuideGate` / `hasGuideMessage` / `RULE_ENGINE_SOURCE_KIND`，头注释改述统一标准。

**二次修改（2026-10-01，真机验证后按用户裁定）**：`symbol-normalizer/src/main.ts` 指南注册改 `sources: ["step-end"]` + `delivery: "next-step"`（`ConsumerRegistrar` 结构面补 `delivery`）；`src/guide.ts` 头注释与 `README.md` / `docs/DESIGN.md` 同步；`TUI/docs/DESIGN.md`（skill 承载段）改为「一条 `step-end` 规则 + 同节点同组合并」；测试 `tests/main.test.ts` 断言同步（`sources` / `delivery` / `dedupeInRecord`）。运行时（仓库外）`~/.dsh/rule-engine/rules.json`：`skill-autoload-on-unlock`（`tool-call`）与 `skill-autoload-after-compaction`（`compaction`）合并为一条 `skill-autoload`（`step-end` / `next-step` / `dedupeInRecord: 1`）。

文档：`rule-engine/README.md`（节点表 / 空条件 / `dedupeInRecord` 整型 / 消费者面 + 合并与对齐点小节 / 单测条数）、`rule-engine/docs/DESIGN.md`（边界 / 分层 / §4 / §5 / §6 / §10）、`symbol-normalizer/README.md` 与 `docs/DESIGN.md`（指南去重口径与依赖）。

**三次修改（2026-10-01，队列核对后按用户裁定）**：`rule-engine` —— `RuleDelivery` 改三态（`inject` / `steer` / `followup`，与宿主 `Agent` 方法同名）、`RULE_DELIVERIES` 与消费者面校验同步（非法值回退 `followup` 并告警）、`inject.ts` 按 `delivery` 分派（`steer` 走 `agent.steer`；宿主缺 `steer` 时**回退 `inject`** 并记 warning，内容不丢）、`AgentLike` 补 `steer?`、`tools.ts` 的 `delivery` 描述重写；`symbol-normalizer` 指南消费者改 `delivery: "steer"`；测试 `tests/inject.test.ts` 的注入路径用例拆为 inject / steer / steer 回退 / steer 抛错四条并扩 `fakeHost`（`noSteer` / `steerThrows`），`rules.test.ts` 显式字段用例改 `steer`；文档 `rule-engine/README.md`（送达路径表 + 已知限制）、`rule-engine/docs/DESIGN.md`（边界 + §11）、`symbol-normalizer/README.md` / `docs/DESIGN.md`、`TUI/docs/DESIGN.md` 同步。运行时（仓库外）`~/.dsh/rule-engine/rules.json`：`skill-autoload` 的 `delivery` 由 `next-step` 改为 `steer`（description 同步）。

## 测试与证据（2026-10-01）

- `npm run check`（全仓）✓、`npm run build`（全仓）✓、`npm run test`（全仓并行）✓——16 个包全绿；`rule-engine` **76/76**（原 67 + 新 9）、`symbol-normalizer` **38/38**（删除 gate / 历史判空用例 5 条）。
- 新增/改写的单测（`rule-engine/tests/`）：节点派发（四种按注册唤醒）；`user-message` 排除本引擎注入；`session-start` 经 `sessionCreated` 唤醒 + `compaction` 不参与合并；对齐合并三条（末步 `step-end` 先唤醒而 `turn-end` 被吞 / 只注册 `turn-end` 每回合都能唤醒 / `reset` 放行下一层 end）；消费者 `dedupeInRecord` 0 / 1 / N；合并写入（多条命中 → 一条消息、正文按段拼接、多段 `summaries`）；`apply` 层 `session/created` 端到端。
- **真机验证（2026-10-01，用户重启后核对会话记录）**：
  1. **新代码已生效**：`rule_test` 传 `source: "step-end"` 返回 `ok`（旧代码会报 source 非法）；`rule_add` 返回的规则 `dedupeInRecord: 0`（整型）。
  1. **重启后指南按预期重注入**：seq 10030（紧随 `turn/end` 10028，`target: next-turn`）——旧逻辑的进程内 gate 已失效，说明走的是统一判空。
  1. **同一次触发的多条命中合并为一条**（自检规则 `selfcheck-merge-a` / `-b`，`turn-end` + 无条件，验证后已 `rule_remove`）：seq 10065 只有**一条**注入，`source.summary = 自检合并 A`、`source.summaries = [自检合并 A, 自检合并 B]`，正文两段空行分隔。
  1. **压缩路径按预期各补一次**（用户执行 `/compact`，压缩 684 条历史约 300060 tokens）：`compaction/end`（seq 10117）之后**恰好两条**注入——seq 10118（`target: next-step`，`source.summary` = 解锁后加载 skill）与 seq 10119（`target: next-turn`，`source.summary` = 符号规范（会话开局指南））；两条均单段，故不写 `source.summaries`。按 `delivery` 分组 → 不同组各写一条；随后 `turn/start`（10120）把两条从 inbox 记账移除（10121 / 10122 `removedCount: 1`）。
  1. **活动区无告警**：`command/done`（10123）文本为「Compacted 684 history items (~300060 tokens).」；该段记录内无引擎 warning。
  1. **指南补注入 = 原 `symbol-normalizer` BACKLOG 条目「同一进程内的压缩不会补注入开局指南」的修复生效**：旧指南（seq 10030）已被压缩挤出投影，`dedupeInRecord: 1` 判空放行 → 补注入一次；此后本回合多次 `tool/call` 未再出现 skill 注入（投影中已含同 `summary`）。
- 补充（实现后自查）：`session/created` 派发与 `session/event` 同口径**跳过子代理会话**（commit `7128df0`）；`npm run demo`（mock 事件流）在新引擎上跑通（命中 → 注入、`aborted` 回合不注入、每回合上限生效）。
- **dist 产物冒烟**（临时脚本跑 `rule-engine/dist/index.js`，跑完已清理）：
  1. 两个消费者在同一次 `session/created` 唤醒 → **合并为一条** `[RULE] 甲提醒\n\n乙提醒`，`source.summary = 甲`、`source.summaries = [甲, 乙]`；
  1. 压缩链路：首个回合末注入 1 条 → 投影里还在 → 不重复 → 投影清空 + `compaction/end` → **补一次** → 下一回合再压再补 → 同回合 `turn-end` 同正文不再重复 → 合并消息的 `source.summaries` 第二段命中 → 计数 1 → 跳过。
- **二次修改后复跑**（2026-10-01）：`npm run check` ✓、`npm run build` ✓、`npm run test` ✓——16 包全绿（`rule-engine` 76/76、`symbol-normalizer` 38/38）。
- **dist 冒烟（`step-end` 合并，临时脚本跑完已清理）**：真实 `rule-engine/dist` + `symbol-normalizer/dist` 接线，注入器记录请求——① 首次 `step-end`：**恰好一条**注入，`sourceId = skill-autoload+consumer:symbol-normalizer-guide`、`delivery: next-step`、`source.summary` = 首段摘要、`source.summaries = [解锁后加载 i-have-adhd / karpathy-guidelines, 符号规范（会话开局指南）]`，正文两段以空行分隔；② 同投影内再 `step-end`：不重复；③ 投影清空后再 `step-end`：补一条同样合并的注入。
- **二次修改的真机确认（2026-10-01，重启 + 压缩后核对会话记录）**：
  1. **重启加载新 dist 后不重复注入**：重启后首个 `step-end`（seq 10412）未写注入——投影里两条旧注入仍在，`dedupeInRecord: 1` 判空挡下（旧 `turn-end` 口径下此处会再补一次）。
  1. **压缩后由判空自然补齐且只有一条**：用户执行 `/compact`（`command/done` seq 10432：「Compacted 124 history items (~83873 tokens).」）把两条旧注入挤出投影；随后用户消息「压缩好了」开启新回合，`step-end`（seq 10446）只写**一条**注入（seq 10447 `agent/inbox/spliced`，`target: next-step`）——`source.kind = "rule-engine"`、`source.summary` = 首段摘要「解锁后加载 i-have-adhd / karpathy-guidelines」、`source.summaries` = [「解锁后加载 i-have-adhd / karpathy-guidelines」,「符号规范（会话开局指南）」]，正文两段空行分隔；该段记录内无引擎 warning。该条同时暴露队列问题（见下条「三次修改」）：`next-step` 条目由 pre-step 领取，撞上 pre-step 快照时延后一步生效，若撞上回合收尾则滞留到下一条用户输入。
- **三次修改后复跑**（2026-10-01）：`npm run check` ✓、`npm run build` ✓、`npm run test` ✓——16 包全绿（`rule-engine` **79/79**：新增 steer 分派 / steer 缺 API 回退 / steer 抛错 3 条；`symbol-normalizer` 38/38）。
- **dist 冒烟（`steer` 分派，临时脚本跑完已清理）**：真实 `rule-engine/dist/src/inject.js` + 假宿主（`inject` / `followup` 设为抛错探针）——`delivery: "steer"` 的合并请求**恰好一次** `agent.steer` 调用，消息 `role: user`、`source.kind = "rule-engine"`、`source.summaries` 两段、正文 `[RULE] ` 前缀 + 空行分隔 → `SMOKE_PASS`。
- **三次修改的真机确认（2026-10-01，重启后核对会话记录）**：
  1. **新代码已加载**：重启后 `rule_list` 正常列出运行时规则，`delivery: "steer"` 被接受并回显（旧代码会把该值判非法）。
  1. **`steer` 在会话空闲时立刻开新回合**：临时自检规则 `selfcheck-steer`（`turn-end` + `steer` + `dedupeInRecord: 1`；`rule_add` 挂上，验证后已 `rule_remove`）——回合 166 结束（seq 10837 `turn/end`，reason `completed`）→ seq 10838 `agent/inbox/spliced`（`target: next-step`、`source.summary` = 「自检：steer 唤醒」）→ **seq 10839 `turn/start` turn 167，其间没有任何用户消息**（`user/message` 只在 10842 以注入本体出现）→ 10841 `step/start` 167/1 领取并落盘该条。对照：同样的 `turn-end` 注入在用 `inject`（旧映射）时不会唤醒，条目滞留到用户下一条消息（本案 10447 的条目即延后一步生效）。

## 收尾

已关闭（2026-10-01）：

1. **交付**：`rule-engine` 统一节点派发（十节点）+ 消费者注册面（`sources` / `delivery` / `dedupeInRecord`）+ 合并注入（同节点同 `delivery` 归一段组、多段写 `source.summaries`）+ 按会话可见投影判空；`symbol-normalizer` 指南改声明式注册（`step-end` / `steer` / `dedupeInRecord: 1`），进程内 gate 与历史判空删除；运行时（仓库外）`skill-autoload` 单规则同口径——两段注入合并为一条，压缩把注入挤出投影后自然补一次。
1. **验证**：全仓 `check` / `build` / `test` 绿（`rule-engine` 79/79、`symbol-normalizer` 38/38）；dist 冒烟两项（合并写入、`steer` 分派）；真机两轮（重启 + `/compact` 后只写一条合并注入；重启后 `steer` 在会话空闲时立刻开新回合）——证据见上节。
1. **提交**：`e2164eb`（docs，决策后）/ `7341861`（feat，实现后）/ `7128df0`（fix，子代理会话）/ `88f3c93`（feat，投递三态 + `steer`）；**收尾（本节 + BACKLOG 清理 + 归档）随最后一次提交**。
1. **未做 / 后续**：无新增 BACKLOG 条目（接取条目已从 `docs/BACKLOG.md` 清理）；`delivery: "inject"`（不唤醒）暂为备用档，留给「不希望叫醒会话」的规则；不采用 `agent/pre-step` waterfall 自建前置注入（理由见 `rule-engine/docs/DESIGN.md` §11）。
