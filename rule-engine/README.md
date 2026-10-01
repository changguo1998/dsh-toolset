# @dsh-toolset/rule-engine

DSH（DeepSeek Harness）进程内插件：**规则触发的自动注入**。按设定规则（关键词 / 正则 / 内置谓词）检测模型正文、工具调用与回合边界，命中后**代替用户**向下一个回合注入一条 user-role 消息（如检测到非推荐符号即发更正要求、检测到越界操作即发约束提醒）。

注册模型面工具族 `rule_*`（增删改查 + 干跑），规则可来自插件配置（只读基线）或运行时的工具调用（落状态目录）。

## 能力

### 节点表（`source`，规则与消费者共用）

| source | 判定时机 | 判定文本 |
| --- | --- | --- |
| `assistant-text`（缺省） | 回合结束（`turn/end`） | 该回合全部 `assistant/message` 正文按 step 顺序拼接 |
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

`turn/end` 的 `reason` 为 `aborted` / `error` / `interrupted` / `forked` 时不唤醒（只认 `completed` / `max-tokens`）；边界类新节点不受 `reason` 限制，到达即按对齐 flag 判据处理。

### 命中条件（`match`）

`keywords` / `regex` / `predicates` 三档之间是「**任一档命中即命中**」；`predicates` 内部为**与**关系。

| 档位 | 说明 |
| --- | --- |
| `keywords` | 关键词列表，大小写不敏感，任一出现即命中 |
| `regex` + `flags` | 正则源串列表，任一匹配即命中；`flags` 缺省 `"i"`；非法正则只记 warning，该条视为不命中 |
| `predicates` | 内置谓词名：`always`（恒真）/ `has-non-ascii` / `has-cjk` / `has-code-block` |

条件为空（无任何有效档位）时：**边界类节点**（`turn-start` / `turn-end` / `step-start` / `step-end` / `session-start` / `compaction`，文本载荷为空）视为无条件命中，其余节点视为**永不命中**（防误配置把每条正文都当命中）。

### 动作（`action`）

本期只有 `inject`：`{ type: "inject", text, summary? }`。

- `text`：注入正文（代替用户发出的那条消息）；
- `summary`：一行摘要（元数据；TUI 之外的呈现面与日志可用）；
- 注入消息形如 `{ id: <uuid>, role: "user", content: [{type:"text", text: "[RULE] " + text}], source: { kind: "rule-engine", summary } }`。

**呈现方式**（BACKLOG TUI#49，2026-09-29 起）：**不带 `source.form:'notice'`**——dsh-toolset 的 TUI 按**用户输入块**显示（实时经 `rule-injection` 事件追加用户行、历史恢复折叠为用户消息块），正文统一以 `[RULE] ` 前缀标明自动注入（与启动自检的 `[AUTO]` 同口径）。早期版本的 `form:'notice'` 一行提示形态已弃用（#46 的通用 notice 机制仍保留给其它插件来源）。

### 送达路径（`delivery`）

| 值 | 行为 | 宿主面 |
| --- | --- | --- |
| `followup`（缺省） | 作为**独立新回合**的消息注入（会唤醒 agent） | `agent.followup` |
| `steer` | 挂到**最近一个 pre-step**（同回合内模型可见）并**唤醒**：会话空闲时立刻开新回合，不必等下一条输入 | `agent.steer` |
| `inject` | 挂到**最近一个 pre-step**、**不唤醒**（会话空闲时挂起到下次唤醒） | `agent.inject`（宿主 rc.2+） |

三条路径的消息构造一致（`source: { kind: "rule-engine", summary }`，正文带 `[RULE] ` 前缀）；旧宿主无 `agent.steer` 时 `steer` 记 warning 并**回退 `inject`**（不唤醒，内容不丢），无 `agent.inject` 时 `inject` 记 warning 并跳过。

### 节流与去重（同一会话内）

| 机制 | 默认 | 说明 |
| --- | --- | --- |
| `maxInjectionsPerTurn`（插件配置） | 3 | 同一会话、同一**来源回合**最多注入条数（按触发事件所属回合计数） |
| 同内容去重 | 固定开启 | 同一回合内相同正文只注入一次（不同规则同文案也只发一条） |
| `cooldownTurns`（规则） | 0 | 两次命中的最小回合间隔；`1` = 隔回合才允许再次命中 |
| `cooldownMs`（规则） | 0（不限制） | 两次命中的最小毫秒间隔 |
| `dedupeInRecord`（规则 / 消费者） | `0` | **整型**：会话可见投影里最多允许 N 条本注入。`0` = 无限制；`1` = 已有就跳过（重载会话不重复注入；压缩把注入挤出投影后才补）；`N≥2` = 允许最多 N 条。计数按 `source.summary` 或合并消息的 `source.summaries` 命中该 key 的**条数**。投影不可读 → 照旧注入（fail-open）。旧布尔值兼容归一：`true → 1`、`false → 0` |

### 工具族

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `rule_add` | `id`、`text`、`source?`、`delivery?`、`match?`、`summary?`、`cooldownTurns?`、`cooldownMs?`、`dedupeInRecord?`、`description?`、`enabled?` | 新增规则（id 已存在则报错，指向 `rule_update`） |
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
        maxInjectionsPerTurn: 2
```

`config` 段是**整行替换、非深合并**（宿主 patch 语义），多层叠加需自行写全。

## 消费者面

`provide("ruleEngine")` 面向其他插件：

| 方法 | 说明 |
| --- | --- |
| `list()` | 生效规则只读清单（`id` / `enabled` / `source` / `delivery` / `origin` / `text` / 节流参数） |
| `status()` | 规则条数、运行时条数、状态目录、每回合注入上限 |
| `evaluate({ text, source? })` | 只读判定：返回命中规则（含**可注入内容** `text` / `summary`）与未启用规则 id；不注入、不改状态 |
| `registerConsumer({ id, sources?, delivery?, cooldownTurns?, cooldownMs?, dedupeInRecord?, decide })` | 注册消费者：在注册的**节点**（`sources`，缺省 `["turn-end"]`）按注册顺序**同步**询问，`decide(ctx)` 返回要注入的内容 `{ text, summary?, reset? }`（null = 不反馈），反馈由本引擎统一注入；返回注销函数 |
| `onNotice(listener)` | 订阅插件告警（完整展示行 + tone） |

消费者与规则共用闸门：逐段上限（`maxInjectionsPerTurn` 以「**段**」计）、同文本去重、`dedupeInRecord` 判空；消费者级 `cooldownTurns` / `cooldownMs` 可选（按注入记账），更细粒度冷却由消费者自理。`decide` 运行在 `session/event` 的同步派发窗口内：须廉价，且不得调用宿主 API（注入一律由本引擎推迟宏任务）。`ctx.trigger` 是实际触发的节点 id，`ctx.event` 是原始宿主事件。

### 合并与对齐点（尺度双 flag）

同一次触发的全部命中（规则 + 消费者）按 `delivery` 分组，**每组合并为一条**注入消息（正文空行分隔；多段时 `source.summaries` 记录各段摘要）。逐段过闸门：段数上限、同正文去重；`dedupeInRecord` 逐段判空。

对齐点（例：回合末尾的 `step-end` 紧跟 `turn-end`）用**尺度双 flag** 合并唤醒——尺度层级 `session ⊃ turn ⊃ step ⊃ tool`，每消费者 × 每会话 × 每尺度各有一对 `startFired` / `endFired`：

- `*-start` 到达：清本尺度及更细尺度的 `endFired`、更细尺度的 `startFired`；注册了该节点才置位并唤醒（`session-start` 无 end 节点，不设窗口幂等）。
- `*-end` 到达：查本尺度及更细尺度 `endFired` 的或，注册了该节点且全假才唤醒并置位；无论是否唤醒都清本尺度 `startFired`（窗口关闭）。
- 「清」与是否注册无关（窗口账簿，保证跨回合恢复）；被吞时不再唤醒。
- `decide` 返回 `reset: true` = 清空本消费者的 flag（「这次唤醒不算吞并」）。
- `compaction` 不参与对齐合并，每次到达都触发。

## 时序约束（重要）

`session/event` 监听器运行在 `Session.append` 的**同步派发窗口**内，此刻直接调用 `agent.followup()` 会撞重入保护（异常被宿主吞掉，现象是「消息不落盘」）。因此注入一律 `setTimeout(…, 0)` 推迟一个宏任务后再 `agents.get(sessionId)`，按 `delivery` 调 `followup(message)`（新回合）/ `steer(message)` / `inject(message)`（最近 pre-step），随后 `sessions.flush(agent.session)` 确保落盘。会话非 live（`agents.get` 返回 undefined）时跳过并记 warning。

## 已知限制

- **「提示人」已由 TUI 支持**：注入消息按**用户输入块**渲染（正文 `[RULE] ` 前缀标明自动注入，BACKLOG TUI#49）；未实现该分支的客户端按普通 user 消息块渲染（行为退化为默认，不丢消息）。
- 只有 `inject` 一种动作：`tag` 打标 / `abort` 中断 / `memory` 写知识库未实现。
- `inject` 路径需要宿主 rc.2+（`agent.inject`）；旧宿主上记 warning 跳过（不回退 followup）。`steer` 缺 API 时回退 `inject` 并记 warning（内容不丢，只是不唤醒）。
- 节流记账是**进程内**内存态：`dsh` 重启后 cooldown 计数清零（规则本身持久化）；需要跨重启不重复的规则用 `dedupeInRecord`（按会话可见投影去重）。
- 逐 delta 实时匹配未实现：文本类规则只在回合结束判定（实时需订阅 `agent/assistant-stream`）。

## 开发

```sh
npm run check   # tsc --noEmit
npm run build   # 编译到 dist/
npm test        # node --test（76 条单测：匹配 / 规则层 / 持久化 / 引擎 / 注入器 / 插件入口）
npm run demo    # mock 事件流跑「规则命中 → 注入」，不依赖 DSH
```

架构与设计取舍见 `docs/DESIGN.md`。
