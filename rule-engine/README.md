# @dsh-toolset/rule-engine

DSH（DeepSeek Harness）进程内插件：**规则触发的自动注入**。按设定规则（关键词 / 正则 / 内置谓词）检测模型正文、工具调用与回合边界，命中后**代替用户**向下一个回合注入一条 user-role 消息（如检测到非推荐符号即发更正要求、检测到越界操作即发约束提醒）。

注册模型面工具族 `rule_*`（增删改查 + 干跑），规则可来自插件配置（只读基线）或运行时的工具调用（落状态目录）。

## 能力

### 节点表（`source`，规则与消费者共用）

`source` 可给**单个节点**或**节点数组**（一条规则挂多时机，2026-10-02 起；消费者的对应字段一直是数组 `sources`）。

下表是**会话事件节点**（规则侧 `RULE_SOURCES` 恰为这 10 项）；消费者另有一个专用节点 `tools/pre-execute`（工具执行前拦截），它**不是会话事件、规则侧不接受**，见「消费者面 · guard 面」。

| source | 判定时机 | 判定文本 |
| --- | --- | --- |
| `assistant-text`（缺省） | 回合结束（`turn/end`） | 该回合全部 `assistant/message` 正文按 step 顺序 **以 `\n` 连接**; `surfaceOp: "replace"` 的影子覆盖事件**不进缓冲**（与 TUI 显示面一致）; 单条 step 正文超 200 000 字符**被截断并发告警**（见「已知限制」） |
| `user-message` | `user/message` 到达 | 用户消息 text 块（本引擎自己的注入消息被排除，避免自触发） |
| `tool-call` | `tool/call` 到达 | 工具名 + 模型原始参数 JSON 串 |
| `tool-result` | `tool/result` 到达 | 工具结果消息的 text 块 |
| `turn-start` | `turn/start` 到达 | 空串（边界类） |
| `turn-end` | 回合结束（`turn/end`） | 回合正文；`match` 可省 = **无条件命中** |
| `step-start` | `step/start` 到达 | 空串（边界类） |
| `step-end` | `step/end` 到达 | 空串（边界类） |
| `session-start` | `session/created`（含恢复） | 空串（边界类） |
| `compaction` | 上下文压缩完成（`compaction/end`） | 空串（边界类）；`match` 可省 = **无条件命中** |

`compaction` 只认一次压缩的**终态** `compaction/end`（`compaction/start` / `compaction/summary` / `compaction/prune` 不触发），避免同一次压缩重复判定。

`tools/pre-execute` 只供消费者 guard 用：规则侧 `normalizeRule` / `rule_add` 遇到它直接报错（「该节点只用于消费者 guard」），消费者侧另有 `CONSUMER_SOURCES`（= 上述 10 项 + 该节点）作注册校验。

`turn/end` 的 `reason` **先归一**再判定：字符串按字面；对象形态读 `reason.kind`（与 TUI 侧 `turnEndReason` 同口径）。归一到 `aborted` / `error` / `interrupted` / `forked` 时不唤醒（只认 `completed` / `max-tokens`）；**`reason` 缺省（事件未带该字段）按 `completed` 处理 = 照常唤醒**（2026-10-16 差分对拍实测）；**非法值**（`null` / 数字 / 布尔 / 空对象 / `kind` 非字符串等）**按「不唤醒」处理并发一条告警**（文案含 `reason` 与「非法」，2026-10-16 修正，用例见 `tests/turnEndMatrix.test.ts`）；边界类新节点不受 `reason` 限制，到达即按对齐 flag 判据处理。

**每回合必须发 `turn/start`**：`*-end` 节点的对齐 flag 只由 `*-start` 节点清零（`#bookkeepStart`）；若宿主省略 `turn/start`，同一会话从第 2 个回合起 `turn/end` 会被当成重复而**不再唤醒**消费者（2026-10-16 实测, 用例见 `tests/bufferBoundary.test.ts` 的「bookkeep 清零点」）。

### 命中条件（`match`）

`keywords` / `regex` / `predicates` 三档之间是「**任一档命中即命中**」；`predicates` 内部为**与**关系。

| 档位 | 说明 |
| --- | --- |
| `keywords` | 关键词列表，大小写不敏感，任一出现即命中 |
| `regex` + `flags` | 正则源串列表，任一匹配即命中；`flags` 缺省 `"i"`；非法正则只记 warning，该条视为不命中 |
| `predicates` | 内置谓词名：`always`（恒真）/ `has-non-ascii` / `has-cjk` / `has-code-block` / `session-fresh` / `session-resumed`（后两个按**会话级**上下文判定，见下） |

条件为空（无任何有效档位）时：**边界类节点**（`turn-start` / `turn-end` / `step-start` / `step-end` / `session-start` / `compaction`，文本载荷为空）视为无条件命中，其余节点视为**永不命中**（防误配置把每条正文都当命中）。该判定在**判定期按触发节点**裁决，故一条规则挂多节点时各节点语义独立。

#### 会话谓词（`session-fresh` / `session-resumed`）

| 谓词 | 命中条件（与文本无关） |
| --- | --- |
| `session-fresh` | 本进程内**新建、无历史**的会话 |
| `session-resumed` | 从记录**恢复 / 重载**的会话（含 fork / 种子继承） |

- **判据**：宿主 Session 的 `seq`（事件日志长度 getter）`> 0` **或** `inheritedEventCount`（fork 继承前缀长度）`> 0`；字段缺失 / 读取抛错按 fresh 兜底。
- **判定时机**：引擎**首次见到该会话**时判一次并记住（`session/created` → `session-start`；插件后挂载错过该事件时，用首个事件携带的 session 兜底判定），此后**会话内稳定**——`seq` 会随事件增长，每次现读会让 `session-fresh` 在 `session-start` 之后立刻变假。同一 `sessionId` 再次 `session/created`（宿主重放 / 重复触发）沿用首次判定、不重判。
- **边界**：`session-fresh` 只表示「本进程内新建、无历史」——**恢复出来的空会话**（`seq === 0` 且无继承）仍算 fresh。
- **消费者侧同一口径**：`decide(ctx)` 的 `ctx` 继承 `MatchContext`，`ctx.resumed` 可直接作为匹配器第三参（`match(text, trigger, ctx)`）复用这两个谓词。
- **无会话上下文的判定面**：`rule_test` 干跑与 `evaluate()` 只读判定按缺省 `{ resumed: false }`（= fresh）处理；`session-resumed` 在其中恒不命中。
- **与 `dedupeInRecord: 1` 的分工**：后者按**会话记录**判重（记录不可读即 fail-open 照旧注入），只回答「这条注入是不是已经发过」；本谓词只回答「这个会话是不是恢复来的」，用于需要**精确区分**或给恢复 / 全新会话不同文案的场景，两者可叠加。

### 动作（`action`）

本期只有 `inject`：`{ type: "inject", text, summary? }`。

- `text`：注入正文（代替用户发出的那条消息）；
- `summary`：一行摘要（元数据；TUI 之外的呈现面与日志可用）；
- 注入消息形如 `{ id: <uuid>, role: "user", content: [{type:"text", text: "[RULE] " + text}], source: { kind: "rule-engine", summary } }`。

**呈现方式**（2026-09-29 起）：**不带 `source.form:'notice'`**——dsh-toolset 的 TUI 按**用户输入块**显示（实时经 `rule-injection` 事件追加用户行、历史恢复折叠为用户消息块），正文统一以 `[RULE] ` 前缀标明自动注入（与启动自检的 `[AUTO]` 同口径）。早期版本的 `form:'notice'` 一行提示形态已弃用（#46 的通用 notice 机制仍保留给其它插件来源）。

### 送达路径（`delivery`）

| 值 | 行为 | 宿主面 |
| --- | --- | --- |
| `followup`（缺省） | 作为**独立新回合**的消息注入（会唤醒 agent） | `agent.followup` |
| `steer` | 挂到**最近一个 pre-step**（同回合内模型可见）并**唤醒**：会话空闲时立刻开新回合，不必等下一条输入 | `agent.steer` |
| `inject` | 挂到**最近一个 pre-step**、**不唤醒**（会话空闲时挂起到下次唤醒） | `agent.inject`（宿主 rc.2+） |

三条路径的消息构造一致（`source: { kind: "rule-engine", summary }`，正文带 `[RULE] ` 前缀）；旧宿主无 `agent.steer` 时 `steer` 记 warning 并**回退 `inject`**（不唤醒，内容不丢），无 `agent.inject` 时 `inject` 记 warning 并跳过。

### 节流与去重（同一会话内）

- **回合级**：`maxInjectionsPerTurn`（插件配置，缺省 `3`）= 同一会话、同一**来源回合**最多注入条数（按触发事件所属回合计数）；同回合同内容只注入一次（固定开启，不同规则同文案也只发一条）。
- **规则级**：`cooldownTurns`（缺省 `0`；`1` = 隔回合才允许再次命中）、`cooldownMs`（缺省 `0` = 不限制）；记账是**进程内**内存态，`dsh` 重启后清零（规则本身仍持久化）。
- **记录级**：`dedupeInRecord`（缺省 `0` = 无限制，**整型**：会话记录 = 可见投影（`deriveMessages()`）**加**仍在 inbox 待消费的注入里最多允许 N 条本注入；`1` = 已有就跳过（重载不重复注入，压缩把注入挤出记录后才补），`N≥2` = 最多 N 条；计数按 `source.summary` / `summaries` 命中该 key 的**条数**，记录不可读 → fail-open 照旧注入，旧布尔值归一 `true → 1` / `false → 0`）；`directWrite`（缺省 `[]`：这些节点**跳过 `dedupeInRecord` 记录判断**直接写入，项须是匹配面 / `sources` 的子集，越界项归一化时丢弃并记 warning）。判定细节与设计理由见 `docs/DESIGN.md` 取舍 6。

### 与官方 `repeat-tool-reminder` 的分工（不竞争，2026-10-05 定论）

官方 `repeat-tool-reminder`（base 已挂载，`thresholds: [3, 5, 8]`）与本引擎**既不同注入点、也不同通道**：

| 维度 | 本引擎 | 官方 `repeat-tool-reminder` |
| --- | --- | --- |
| 触发条件 | 规则表判定（关键词 / 正则 / 谓词）+ 消费者 `decide` | 同一工具重复调用计数达阈值 |
| 注入通道 | `agent.followup` / `steer` / `inject` 注入**消息记录**（落 next-step inbox，呈现为用户输入块） | 在 `tools/post-execute` 返回值里附 `additionalContexts`——**步骤级上下文，不产生消息记录** |
| 订阅节点 | session / turn / step / tool 边界 + `compaction`（**不含 `agent/pre-step`**） | `tools/post-execute`（注入）；`agent/pre-step` 仅用于「收到真实用户消息即清零重复计数」 |

故：注入预算互不挤占（`maxInjectionsPerTurn` 只计本引擎自己的注入段）；同一回合各出一条提醒**不构成冲突**（触发条件互不相关、通道与文案均不同，无需去重）。本引擎**不**为避让官方 reminder 而收窄触发面（调研与实测依据见 `docs/archived/2026-10-05-rule-engine-reminder-overlap.md`）。

### 工具族

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `rule_add` | `id`、`text`、`source?`（节点或节点数组）、`delivery?`、`match?`、`summary?`、`cooldownTurns?`、`cooldownMs?`、`dedupeInRecord?`、`directWrite?`、`description?`、`enabled?` | 新增规则（id 已存在则报错，指向 `rule_update`） |
| `rule_list` | 无 | 只读列出生效规则（含来源层 `origin`）与引擎状态 |
| `rule_update` | `id`、`patch` | 浅合并更新（可只改 `text` / `match` / `cooldownTurns` 等）；基线规则被更新后以运行时版本生效 |
| `rule_remove` | `id` | 删除规则：运行时规则移除；基线规则进运行时屏蔽列表（配置文件不动） |
| `rule_test` | `text`、`source?` | 干跑：列出会命中的规则 id（不注入、不改状态） |

工具返回值统一 `{ ok, error, ... }`，异常转结构化错误（不向宿主抛）。

`tools` 不在 `inject` 声明中，经 `ctx.get('tools')` 读取（cordis 严格模式禁止未注入服务的直接属性访问；2026-09-27 真机实测踩坑）；缺失时工具族降级告警，事件面照常。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `stateDir` | `~/.dsh/rule-engine` | 运行时层状态目录；环境变量 `RULE_ENGINE_STATE_DIR` 优先 |
| `rules` | `[]` | 配置基线规则（只读，结构同工具参数） |
| `maxInjectionsPerTurn` | `3` | 同一会话同一回合注入上限 |

规则两层合并（按 `id`）：配置基线按声明顺序生效 → 运行时层同 id **覆盖**（就地替换）→ 运行时新 id **追加**到末尾 → `removed` 列表屏蔽同名基线规则。

状态文件 `<stateDir>/rules.json` 为 `{version, state}` 外壳 + 原子写（tmp + rename）；版本不符时**拒载且拒写**（避免旧 schema 覆盖新数据），只记 warning 后以空运行时层继续。

bundle 契约：`name = "rule-engine"` / `inject: ["agents", "sessions"]`（硬依赖，缺失则插件整体等待）/ `provide: ["ruleEngine"]` / `Config`（类型声明，无运行时 schema）/ `apply`。

## 配置示例（profile `cordis.patch.yml`）

```yaml
- insert:
    - id: rule-engine
      name: '@dsh-toolset/rule-engine'
      config:
        rules:
          - id: ascii-symbols
            source: assistant-text
            match:
              regex: ['[（）【】“”]']
            action:
              type: inject
              text: '[符号规范] 回复里出现了非推荐符号，请改用 ASCII 半角符号重述要点。'
              summary: 符号规范提醒
            cooldownTurns: 1
          - id: no-destructive-shell
            source: tool-call
            match:
              regex: ['rm\s+-rf', 'git\s+push\s+--force']
            action:
              type: inject
              text: '[约束] 不要执行破坏性命令；如确需执行，先说明影响并取得确认。'
          - id: session-guide
            source: ['session-start', 'compaction', 'step-end']
            directWrite: ['session-start', 'compaction']
            delivery: steer
            dedupeInRecord: 1
            action:
              type: inject
              text: '[指南] 本会话的规范要点：…'
              summary: 会话开局指南
          - id: resumed-notice
            source: session-start
            match:
              predicates: ['session-resumed']
            action:
              type: inject
              text: '[提示] 本会话由历史记录恢复：先复核已有上下文，不要重复已完成的工作。'
              summary: 恢复会话提示
        maxInjectionsPerTurn: 2
```

`config` 段是**整行替换、非深合并**（宿主 patch 语义），多层叠加需自行写全。

## 消费者面

`provide("ruleEngine")` 面向其他插件：

| 方法 | 说明 |
| --- | --- |
| `list()` | 生效规则只读清单（`id` / `enabled` / `sources` / `directWrite` / `delivery` / `origin` / `description` / `text` / 节流参数） |
| `status()` | 规则条数、运行时条数、被运行时删除的基线条数、状态目录、每回合注入上限 |
| `evaluate({ text, source? })` | 只读判定：返回命中规则（含**可注入内容** `text` / `summary`）与未启用规则 id；不注入、不改状态 |
| `registerConsumer({ id, sources?, delivery?, cooldownTurns?, cooldownMs?, dedupeInRecord?, directWrite?, decide })` | 注册消费者：在注册的**节点**（`sources`，缺省 `["turn-end"]`）按注册顺序**同步**询问，`decide(ctx)` 返回要注入的内容 `{ text, summary?, reset? }`（null = 不反馈），反馈由本引擎统一注入；`directWrite` 列出的节点跳过投影去重判断；返回注销函数。`sources` 含 `tools/pre-execute` 时改为 guard 形态（必须给 `guard`、不得给 `decide` 与注入 / 冷却参数），见下「guard 面」 |
| `onNotice(listener)` | 订阅插件告警（完整展示行 + tone） |

- **共用闸门**：逐段上限（`maxInjectionsPerTurn` 以「**段**」计）、同文本去重、`dedupeInRecord` 判空；消费者级 `cooldownTurns` / `cooldownMs` 可选（按注入记账），更细粒度冷却由消费者自理。同一次触发的全部命中（规则 + 消费者）按 `delivery` 分组、**每组合并为一条**注入消息（正文空行分隔；多段时 `source.summaries` 记录各段摘要）。
- **时序约束**：`decide` 运行在 `session/event` 的同步派发窗口内——须廉价，且不得调用宿主 API（注入一律由本引擎推迟宏任务）；`ctx.trigger` 是实际触发的节点 id，`ctx.event` 是原始宿主事件（`session-start` 上是宿主 Session），`ctx.resumed` 是本会话是否为恢复 / 重载（会话内稳定，可直接喂给匹配器复用会话谓词）。
- **对齐点（尺度双 flag）与复杂度边界**见 `docs/DESIGN.md` 取舍 10：尺度层级 `session ⊃ turn ⊃ step ⊃ tool`，`*-start` 清更粗 / 更细 flag、`*-end` 查或后置位，「清」与是否注册无关，`decide` 返回 `reset: true` 清空本消费者 flag，`compaction` 不参与合并、每次到达都触发。

### guard 面（`tools/pre-execute`，工具执行前拦截）

**节点**：`sources: ["tools/pre-execute"]` 的消费者在宿主 `tools/pre-execute`（cordis **waterfall**）唤醒，上下文是 `ToolGuardContext { name, arguments, callId?, sessionId?, resumed? }`（宿主 exec 的结构面子集；`sessionId` 取自 `exec.agent.session.id`，`resumed` 按会话级判据补齐）。裁决是 `ToolGuardDecision = { kind: "allow" } | { kind: "deny"; reason }`，返回 `undefined` = 弃权。

```ts
service.registerConsumer({
  id: "my-guard",
  sources: ["tools/pre-execute"],
  guard: (context) =>
    context.name === "bash" && String(context.arguments?.command ?? "").includes("herdr")
      ? { kind: "deny", reason: "bash 里不要跑 herdr 命令: 改用 herdr_use 工具" }
      : undefined,
});
```

- **注册约束**（违反即拒绝注册并告警，返回 noop）：该形态**必须**给 `guard`（同步或异步均可）、**不得**给 `decide`，也**不得**带 `delivery` / `dedupeInRecord` / `directWrite` / `cooldownTurns` / `cooldownMs`（guard 只裁决、不注入、不去重、不记账）。不含该节点的注册仍必须给 `decide`。
- **汇总顺序**：按**注册顺序串行** `await`，任一 `deny` **立即返回**（安全向：`allow` 不否决后续 `deny`）；全部放行 / 弃权 → `undefined`，监听器走宿主 `next()`。
- **失败语义**：`guard` 抛错 / 返回非法结构 / `deny` 但理由为空 → 告警并视为弃权（fail-open）。最终否决权仍在 `security-guard`（`ctx.tools.guard` 单调守卫），本面不接管。
- **会话范围**：对所有会话生效（含子代理）。
- **可见性**：`deny` 时经 `warn` 打一行「消费者 `<id>` 拒绝工具 `<name>`」；**不写审计**、不落 memory-base。
- **工具面**：`rule_*` 仍只接受 `inject` 动作 —— 消费者 guard 只由插件代码注册，配置无法直接表达拦截规则；规则由各消费者插件自己的 `config` 提供（首个消费者 `behavior-correction` 是并行任务，口径见项目级 `docs/implementation/2026-10-21-behavior-correction.md`）。
- **与相邻拦截层的关系**：`security-guard`（危险命令 / 敏感路径，单调守卫，拥有最终否决）与 `auto-approve`（`approval/request` 审批裁定）职责不变；本面只表达「应改用专用工具」。

## 时序约束（重要）

`session/event` 监听器运行在 `Session.append` 的**同步派发窗口**内，直接调用 `agent.followup()` 会撞重入保护（异常被宿主吞掉，现象是「消息不落盘」）。因此注入一律 `setTimeout(…, 0)` 推迟宏任务后再 `agents.get(sessionId)`，按 `delivery` 调 `followup` / `steer` / `inject`，随后 `sessions.flush(agent.session)`；会话非 live 时跳过并记 warning。启动期顺序、注入到步边界才被 claim 与 `dedupeInRecord` 的配合见 `docs/DESIGN.md` 取舍 1 与 6。

## 已知限制

- **「提示人」已由 TUI 支持**：注入消息按**用户输入块**渲染（正文 `[RULE] ` 前缀标明自动注入）；未实现该分支的客户端按普通 user 消息块渲染（行为退化为默认，不丢消息）。
- 只有 `inject` 一种动作：`tag` 打标 / `abort` 中断 / `memory` 写知识库未实现。
- `inject` 路径需要宿主 rc.2+（`agent.inject`）；旧宿主上记 warning 跳过（不回退 followup）。`steer` 缺 API 时回退 `inject` 并记 warning（内容不丢，只是不唤醒）。
- 节流记账是**进程内**内存态：`dsh` 重启后 cooldown 计数清零（规则本身持久化）；需要跨重启不重复的规则用 `dedupeInRecord`（按会话记录去重：可见投影 + 未消费 inbox）。
- 逐 delta 实时匹配未实现：文本类规则只在回合结束判定（实时需订阅 `agent/assistant-stream`）。
- **观测口径与 TUI 显示不完全一致（2026-10-16 实测，同日修正并放宽两项）**：显示面是各 step 正文**直接相接**（TUI 丢弃 `surfaceOp: "replace"` 的正文、但空白 step 照常显示）, 而本引擎的 `assistant-text` 是各 step 正文用 `\n` 连接（N step 多 N-1 个换行）。因此行号 / 片段定位可能与界面差若干字符。两项已处理: ① `surfaceOp: "replace"` 的消息**不进缓冲**（与显示面一致，不再要求「修正」屏幕上不存在的内容）; ② 单条 step 超 200 000 字符时判定只见截断后的前缀，**截断时发一条告警**（文案含「截断」与上限数字），不再静默丢内容。

## 开发

```sh
npm run check   # tsc --noEmit
npm run build   # 编译到 dist/
npm test        # node --test（168 条单测：匹配 / 规则层 / 持久化 / 引擎 / 注入器 / 模型面工具族 / 插件入口）
npm run demo    # mock 事件流跑「规则命中 → 注入」，不依赖 DSH
```

架构与设计取舍见 `docs/DESIGN.md`。
