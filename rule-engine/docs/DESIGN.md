# rule-engine 设计

模块：`rule-engine`（项目级 BACKLOG #42）。本文件记架构与设计取舍；契约与用法见 `../README.md`，过程记录见 `docs/archived/2026-09-27-rule-engine.md`（项目级）。

## 目标与边界

按规则检测模型输出与事件流，命中后**代替用户**向下一个回合注入一条 user-role 消息。

明确的边界（本期）：

- 动作只做 `inject`；`tag` / `abort` / `memory` 不做。
- 注入路径三条（与宿主 `Agent` 方法同名）：`followup`（新回合，`agent.followup`）、`steer`（最近 pre-step + 唤醒，`agent.steer`）、`inject`（最近 pre-step 不唤醒，`agent.inject`；宿主 rc.2+）。不自行注册 `agent/pre-step` waterfall 监听者。
- 节点表（规则与消费者共用）共十项：`assistant-text` / `user-message` / `tool-call` / `tool-result` / `turn-start` / `turn-end` / `step-start` / `step-end` / `session-start` / `compaction`；逐 delta 实时匹配不做（正文在回合结束判定）。
- 不改 TUI：符号纠正迁移与 `form:'notice'` 渲染分别是独立条目。

## 分层

```text
main.ts       插件入口：name / inject / provide / Config / apply
              ├─ ctx.on('session/event') → engine.handle(session, event)
              ├─ ctx.tools.register(...) ← tools.ts（缺 tools 时降级告警）
              └─ ctx.provide('ruleEngine', { list, status, evaluate, registerConsumer })
engine.ts     编排：事件分流 → 回合正文聚合 → 匹配 → 节流去重 → 交付注入器
              + 节点派发：规则命中 + 消费者唤醒（按注册的 sources）→ 逐段闸门 → 按 delivery 合并写入
              ├─ match.ts    纯匹配：keyword / regex / 内置谓词 + 消息文本抽取
              ├─ rules.ts    规则归一化 + 两层合并（config 基线 + runtime 层）
              └─ persist.ts  运行时层落盘（{version, state} + tmp/rename 原子写）
inject.ts     注入动作：推迟宏任务 → agents.get → followup → sessions.flush
tools.ts      模型面工具族：rule_add / rule_list / rule_update / rule_remove / rule_test
```

依赖方向单向：`main → engine → {match, rules, persist}`（另取 `inject` 的 `SOURCE_KIND` 常量做去重判据）、`main → {inject, tools}`；`engine` 只依赖 `Injector` 接口与会话投影读取函数，不认识宿主（可注入假实现单测）。

## 关键设计取舍

### 1. 注入必须推迟一个宏任务（红线）

`session/event` 在 `Session.append` 的同步派发窗口内派发（`entry.appending === true`）。窗口内调 `agent.followup()` → `inbox.splice` → 再次 append 撞重入保护，异常被宿主 `logger.warn` 吞掉，现象是「消息不落盘」。因此：

- `engine` 可以同步调 `Injector.inject()`（它不认识时序），**推迟由注入器负责**（`inject.ts` 用 `setTimeout(…, 0)`）；
- 微任务（`queueMicrotask`）在源码机制上可行，但只有 TUI 的宏任务路径有真机实证，本期只用宏任务；
- **启动期顺序契约**（2026-10-04）：App 的启动自检 kickoff 在 `session/created` 之后的微任务窗口内同步入队（TUI 侧），故 `session-start` 注入恒排在 kickoff 之后；调整推迟策略前先复核该顺序（BACKLOG「`[AUTO]` 注入时序」）；
- `followup` / `inject` 之后 `sessions.flush(agent.session)` 确保落盘（官方 schedule / goal-round-driver 的标准写法）。

### 2. 消息构造三项硬要求

`id` 非空 string、`content` 为数组、`source.kind` 非空 string；缺任一项会在 append/resume 校验时抛 `lacks an identified message`（TUI 侧踩过 `SessionPersistenceCorruptionError`）。`buildInjectionMessage` 用 `randomUUID()` + `source.kind = "rule-engine"`（官方无通用 `'plugin'` kind，merge-extensible 要求生产者各自声明）。

### 3. 规则两层：配置基线 + 运行时层

- 配置（`Config.rules`）是**只读基线**：改它要改 profile 的 `cordis.patch.yml`（`config` 段是整行替换、非深合并）。
- 运行时层（工具族增删改）落状态目录 `~/.dsh/rule-engine/rules.json`，形态 `{rules, removed}`：同 id 覆盖基线（就地替换、保持顺序）、新 id 追加、`removed` 屏蔽基线 id。
- 合并语义集中在 `rules.ts#effectiveRules`：纯函数、可单测；两层各自归一化，坏规则跳过并记 warning，不因一条错配置拒绝整层。

不用宿主 `ctx.storage` / `storageDomain`：需 profile 配必填 `backend`，对单文件状态属过度设计；沿用 metric-loop 的 `{version, state}` + 原子写 + 版本不符拒载惯例。

### 4. 匹配语义：三档或关系、空条件按节点区分

`keywords`（大小写不敏感包含）/ `regex` / `predicates` 三档任一命中即命中，`predicates` 内部与关系。空条件时边界类节点（`turn-start` / `turn-end` / `step-start` / `step-end` / `session-start` / `compaction`，无文本）= 无条件命中，其余节点 = 永不命中——「文本类空条件」若也算无条件，会把每条正文都变成命中，属误配置。

内置谓词只做无参数的纯性质判定（`always` / `has-non-ascii` / `has-cjk` / `has-code-block`），不做 JS 表达式求值（避免任意代码执行面）。

**多节点（2026-10-02）**：匹配面 `source` 可给单节点或**节点数组**（一条规则挂多时机，不拆两条规则；归一化后字段为 `sources`）。空条件语义随之从「编译期按 source 定死」改为**判定期按触发节点**裁决（`match(text, source)`）——同一条规则在边界节点无条件命中、在文本节点永不命中，互不影响。

### 5. 判定时机：正文在回合结束，工具在事件到达

- `assistant/message` 累积该回合正文（按 step 顺序），`turn/end` 时统一判定 `assistant-text` 与 `turn-end` 规则——与符号纠正先例一致，且天然避免「同一段正文被判多次」。
- `tool/call` / `tool/result` 到达即判定（越界操作提醒不必等回合结束）；注入仍由注入器推迟，落下一个回合。
- `turn/end` 的 `reason` 不在 `completed` / `max-tokens` 时跳过（用户中断/报错/分叉的回合不该被追问）。
- 上下文压缩面 `compaction` 在 `compaction/end`（一次压缩的终态）判定、文本入参为空串：只作「记录可能已被裁掉」的边界触发；`start` / `summary` / `prune` 不触发（一次压缩只判一次）。
- 其余边界节点（`turn-start` / `step-start` / `step-end` 由对应事件到达、`session-start` 由 `session/created`（含恢复）经入口的第二个挂点派发、`user-message` 由 `user/message` 到达，且排除本引擎自己的注入消息）文本入参同样为空串。

### 6. 节流与去重

- 规则级：`cooldownTurns`（回合差）、`cooldownMs`（毫秒差）。
- 回合级：`maxInjectionsPerTurn` 上限 + 同回合同正文只发一次（跨规则去重，防止两条规则发同一句话）。
- 原设计的 `oncePerTurn` 开关在「同回合同正文去重」落地后成为冗余（同一规则同回合的正文恒定），已删除，避免无用旋钮。
- 记账是进程内内存态（`Map<sessionId, SessionState>`，超 64 会话淘汰最早者、回合缓冲只留最近 4 回合）：`dsh` 重启后 cooldown 清零，规则本身仍在状态目录里。
- `dedupeInRecord`（2026-10-01，整型化 + 对消费者开放）：值 = 「会话可见投影里最多允许 N 条本注入」，`0` = 无限制（缺省）。注入前读**会话可见投影**（`sessions.get(id).deriveMessages()`），按 `source.summary` 或合并消息的 `source.summaries` 命中该 key 的**条数**与 N 比较，已达上限则跳过（仍记命中以免每次触发都重读投影）——跨重启不重复注入；压缩把注入挤出投影后计数下降，自然恢复可注入（配合 `compaction` 节点即「压缩后补一次」）。投影不可读 → 照旧注入（fail-open：宁可重复，不可永久丢注入）。旧布尔值兼容归一 `true → 1` / `false → 0`。
- `directWrite`（2026-10-02，规则与消费者同口径）：声明的节点**跳过 `dedupeInRecord` 投影判断**、直接写入（项须是匹配面 / 消费者的 `sources` 子集，越界项归一化时丢弃并 warning）。用于「会话建立 + 压缩完成必须出现、不等步末」的场景：`session-start`（含恢复）不判断 → 恢复会话会再注入一次，`step-end` 仍按投影判断兜底。

### 7. Config 用类型声明、不做运行时 schema

沿用本仓 11 个包的松口径：`Config` 不导出运行时校验器 → 宿主跳过校验、配置原样透传；非法值由 `normalizeRule` / `effectiveRules` 收敛（跳过 + warning）。好处是换宿主版本不炸，代价是配置错误只体现在 stderr warning。

### 8. 结构化宿主访问

不引入 `@deepseek-ai/dsh-*` 运行时依赖：`ctx` 按结构面访问（`PluginContext` / `InjectionHost` / `EventBus` 等最小接口），够用且与 metric-loop / task-engine 同模式；`inject: ["agents", "sessions"]` 是硬依赖（缺则整体等待），`tools` 缺失只降级告警（事件面与工具面解耦）。

### 9. 可观测性

- apply 内 stderr 自证日志（`已加载：规则 N 条…`）：cordis 的 `inject` 不可用是「等待」而非报错，插件静默不加载时靠它排查。
- 所有异常路径（状态文件损坏、非法正则、会话非 live、followup / inject / flush 抛错、消费者 decide 抛错）只 warning，不向宿主抛。

### 10. 消费者面：声明式注册（节点 + 闸门）+ 同步调度（2026-10-01 扩展）

- 只做简单注册：`registerConsumer({ id, delivery?, cooldownTurns?, cooldownMs?, decide })`；`decide(ctx)` 同步返回要注入的内容 `{ text, summary? }`（null = 跳过）。
- 注册时声明 `sources`（唤醒节点，缺省 `["turn-end"]`）、`dedupeInRecord`（与规则同口径）与 `directWrite`（这些节点跳过投影判断，2026-10-02）；在对应节点按注册顺序**同步**询问 `decide`，与规则命中**合并**后交同一注入器（共用逐段上限 / 同文本去重；消费者冷却可选、按注入记账）。
- **对齐点合并（尺度双 flag）**：尺度层级 `session ⊃ turn ⊃ step ⊃ tool`，每消费者 × 每会话 × 每尺度一对 `startFired` / `endFired`；`*-start` 清本尺度及更细的 `endFired` 与更细的 `startFired`（注册才置位/唤醒，`session-start` 无幂等）；`*-end` 查本尺度及更细 `endFired` 的或（注册且全假才唤醒并置位），无论是否唤醒都清本尺度 `startFired`。`reset: true` 清空本消费者 flag。`compaction` 不参与合并。
- 异常隔离：`decide` 抛错 / 空反馈只记 warning 并跳过该消费者，其余照常；注册返回注销函数（消费者 dispose 时调用）。
- 复杂度边界：不做异步、priority、脚本谓词注册面；`evaluate` 作为轻量只读判定另备。

### 11. 注入路径三条（delivery）

`followup`（缺省，新回合）、`steer`（`agent.steer`：最近 pre-step + 唤醒，会话空闲时立刻开新回合）与 `inject`（`agent.inject`：最近 pre-step、不唤醒；旧宿主无此 API → warning 跳过；`steer` 缺 API 时回退它并记 warning）。语义与取舍：官方 next-step inbox 就是「消息进入 step 前」的正规出口，不自行注册 `agent/pre-step` 监听者，避免与官方 prepend 监听者（model-selection）的顺序和空 step 语义纠缠；`steer` 与 `inject` 共用该队列，差别只在**唤醒**——不唤醒时条目会一直挂到下次有回合开启（实测：`step-end` 注入撞上回合收尾时会滞留到下一条用户输入）。

### 12. 告警出口：总线优先、stderr 兜底（2026-10-01，「rule-engine 的用户提示应显示在活动区」方案 B）

- `provide("ruleEngine")` 增 `onNotice(listener)`：插件 `warn` 在**有订阅者**（TUI 启动后订阅）时把完整展示行 + tone 发总线（展示层渲染进活动区），**无订阅者**（headless）回退 `process.stderr.write`。
- 理由：告警是给人看的、不该写进会话/模型上下文（对比 `source.form:'notice'` 会话消息写法）；且对「告警所涉会话已关闭」的场景同样可送达（进程内推送，不经会话句柄）。
- 引擎（规则归一 / 消费者）/ 注入器（followup / inject / flush 失败）/ 入口三处告警共用同一 `warn`，总线一并覆盖。
