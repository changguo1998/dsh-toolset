# 消费者 guard 面：`tools/pre-execute` 节点（接取条目：rule-engine/docs/BACKLOG.md「动作面扩展: 在 `tools/pre-execute` 拦截工具调用（消费者 guard 面）」）

状态：关闭　　开启：2026-10-21　　关闭：2026-10-22
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
条目标题原为「动作面扩展: 新增 `deny-tool` 动作（在 `tools/pre-execute` 执行前拦截）」，2026-10-21 用户裁定 B 后改为消费者 guard 面（见决策 1），文件与条目按新口径命名。

## 目标

给 rule-engine 的**消费者框架**加第三个唤醒节点 `tools/pre-execute`：宿主在工具执行前到点唤醒注册在该节点的消费者，消费者自行判断并返回「放行 / 拒绝（含理由）」，rule-engine 只做调度与汇总（任一拒绝胜出 → 返回 `{kind:"deny", reason}`，否则 `next()`）。rule-engine **不内置**任何拦截规则、不扩模型工具面；具体规则由其他插件（首个为 `behavior-correction`，另立项目级条目）以自己的 `config` 实现。

## 调研

（来源：本仓 `rule-engine/src/*`、`auto-approve/src/{gate,main,types}.ts`、`docs/archived/2026-10-07-pre-execute-order-contract.md`、`docs/host/DSH-CTX-API.md`、条目原文）

1. **宿主拦截点**（既有结论，`docs/archived/2026-10-07-pre-execute-order-contract.md:15-20`）：`tools/pre-execute` 是 cordis **waterfall**，缺省解析为 `{kind:"allow"}`；`PreToolDecision` 取 `allow` / `deny{reason, info?}` / `cancel` / `ask{reason?, displayReason?}`（本仓已在 `auto-approve/src/types.ts:77-87` 声明结构子集 `PreExecuteExecution { name, arguments, callId?, agent?, signal? }`）。监听器写法 `ctx.on("tools/pre-execute", (exec, next) => decision | next())`（`auto-approve/src/main.ts:228-232`）。`ctx.tools.guard` 是排在 waterfall 之后的单调守卫，`security-guard` 保有最终否决权——本节点与它不冲突。
2. **消费者框架现状**：`ConsumerRegistration`（`types.ts:267-284`）= `id` / `sources`（缺省 `["turn-end"]`）/ `delivery` / `dedupeInRecord` / `directWrite` / `cooldownTurns` / `cooldownMs` / **同步** `decide(context) → ConsumerFeedback | null`；`registerConsumer`（`engine.ts:287-345`）重复 id 告警、返回注销函数；唤醒与注入在 `engine.ts:765-800`（按注册顺序 `decide`，反馈由引擎统一注入）；`ConsumerContext`（`types.ts:244-254`）= `sessionId` / `turn` / `text` / `trigger` / `event?` / `resumed`。服务面经 `provide("ruleEngine")` 暴露 `list` / `status` / `evaluate` / `registerConsumer` / `onNotice`（`main.ts:248-275`）。已有消费者：`md-table-check`、`symbol-normalizer`、`ponytail`（配置侧）。
3. **规则侧现状**：动作面只有 `inject`（`types.ts:74`；`rules.ts:145-148` 拒绝其它类型）；匹配面 `RULE_SOURCES` 是 10 个会话事件节点（`rules.ts:27-38`），由 `ctx.on("session/event")` 驱动（`main.ts:12`）。
4. **插件装配面**：`inject: ["agents", "sessions"]`（`main.ts:56`），`tools` 刻意不入 inject、经 `ctx.get("tools")` 受保护读取（`main.ts:234-240`）；告警统一走 `warn`（有 TUI 订阅进活动区，否则 stderr）。
5. **既有约束**：子代理会话在 `session/event` 面被过滤（`main.ts:36-52`）；插件整体 fail-open；消费者 `decide` 目前只支持同步。
6. **新插件形态**（供接口与文档对齐，本次不实现）：独立包带 `package.json`（`dsh.bundle`）/ `cordis.patch.yml` / `src/main.ts` / `tests/` / `README.md`，规则数据走自身 `config`，判定可复用本包导出的纯函数 `compileMatcher`（`main.ts:66` 已导出）。

## 决策

01. **架构：消费者裁决，不是规则动作**（用户 2026-10-21 裁定 **B**；选项 A = rule-engine 内置 `deny-tool` 规则动作，C = 两者并存）。**选 B** —— 判定逻辑归各规则插件，rule-engine 只提供节点与调度，与 `md-table-check` / `symbol-normalizer` 同构；具体规则由新插件 `behavior-correction` 实现。
02. **节点归属**：新增 `RuleSource` 值 `"tools/pre-execute"`，仅消费者可用；`RULE_SOURCES`（规则侧）保持 10 项、`normalizeRuleSources` 遇到该节点即报错（「该节点只用于消费者 guard」），另立 `CONSUMER_SOURCES = [...RULE_SOURCES, "tools/pre-execute"]` 供消费者注册校验。
03. **消费者注册扩展**：`ConsumerRegistration` 增可选 `guard(context: ToolGuardContext): ToolGuardDecision | undefined | Promise<ToolGuardDecision | undefined>`；`sources` 含该节点 → 必须给 `guard`、不得给 `decide`，且不得设 `delivery` / `dedupeInRecord` / `directWrite` / `cooldownTurns` / `cooldownMs`（违反即拒绝注册并告警）；不含该节点 → 必须给 `decide`（现状不变）。
04. **上下文与裁决类型**：`ToolGuardContext = { name, arguments, callId?, sessionId?, resumed? }`（结构面从 `exec` 取，不 import 宿主类型）；`ToolGuardDecision = { kind: "allow" } | { kind: "deny"; reason: string }`；返回 `undefined` = 弃权。
05. **汇总顺序**：按消费者注册顺序调用（同步或异步均可，`await` 串行）；**任一 `deny` 立即返回**（安全向：`allow` 不否决后续 `deny`）；全部弃权 / 放行 → `undefined`（调用方 `next()`）。
06. **失败语义**：`guard` 抛错 / 返回非法结构 → `warn` 一行并视为弃权（fail-open，安全兜底仍在 `security-guard`）。**选 a** —— 与插件既有口径一致。
07. **会话范围**：对所有会话生效（含子代理）；`sessionId` / `resumed` 能取到就传，取不到按 `{ resumed: false }`。
08. **可见性**：返回 `deny` 时经 `warn` 打一行「消费者 <id> 拒绝工具 <name>」；**不写审计**、不落 memory-base（条目已裁定「需要审计由人工决定」）。
09. **工具面：不变** —— `rule_add` / `rule_update` 仍只接受 `inject` 动作（用户同日裁定「不给模型工具面」）；消费者 guard 只由插件代码注册，配置无法直接表达拦截规则。
10. **首消费者另立并行任务**（用户 2026-10-21 指令「分开并行实现」）—— 插件 `behavior-correction` 的条目在项目级 `docs/BACKLOG.md`，追踪文档 `docs/implementation/2026-10-21-behavior-correction.md`，按本文件钉死的接口契约并行实现；本任务只交付框架。端到端真机验收在两支合并后做。
11. **文档**：`rule-engine/README.md` 消费者章节补 guard 面（口径、限制、示例代码、与 `security-guard` / `auto-approve` 的顺序）；`rule-engine/docs/DESIGN.md` 边界段把 guard 面纳入（`tag` / `abort` / `memory` 仍不做）。

## 规划

### 计划改动文件清单

1. `rule-engine/src/types.ts` —— `RuleSource` 增 `"tools/pre-execute"`；新增 `ToolGuardContext` / `ToolGuardDecision`；`ConsumerRegistration` 增 `guard` 并把 `decide` 放宽为可选；`CompiledConsumer` 类型同步。
2. `rule-engine/src/rules.ts` —— 新增 `CONSUMER_SOURCES`；`normalizeRuleSources` 拒绝该节点（文案指向消费者 guard 面）。
3. `rule-engine/src/engine.ts` —— `registerConsumer` 的 guard 分支校验与 `CompiledConsumer` 组装；新增 `guardTool(exec)`（注册顺序串行、`deny` 立即返回、异常弃权 + 告警）。
4. `rule-engine/src/main.ts` —— 注册 `tools/pre-execute` 监听器（`await guardTool` → `deny` 或 `next()`），补事件常量与 ctx 结构面类型；服务面不新增方法（消费者仍走 `registerConsumer`）。
5. `rule-engine/tests/consumerGuard.test.ts`（新） —— 注册校验（含节点缺 guard / 同时给 decide / 带 delivery 冷却等）、`deny` 胜出与顺序、`allow` 不否决、异步 guard、异常弃权、子代理会话、注销后不再唤醒。
6. `rule-engine/tests/rules.test.ts`、`tests/main.test.ts` —— 规则侧拒绝 `tools/pre-execute`、监听器注册与 `next()` 调用次数、`deny` 回执。
7. `rule-engine/README.md`、`rule-engine/docs/DESIGN.md` —— 消费者 guard 面口径与示例。
8. `rule-engine/docs/BACKLOG.md` —— 条目状态与口径；本文件。仓库清单（根 `package.json` / `install.sh` / `AGENTS.md` / 根 README）由并行的 bc 任务独占，本任务不碰。
   **明确不做**：内置 `deny-tool` 动作；模型工具面 / 人工命令面；审计；`cancel` / `ask` 裁决；`ctx.tools.guard` 单调守卫接入；`tag` / `abort` / `memory` 动作；`behavior-correction` 插件与仓库清单同步（并行任务）；profile 挂载与 pnpm 安装（仓库外，合并后由主线获批准后执行）。

### 步骤

1. 类型与常量（1-2）：节点值、裁决类型、规则侧拒绝。
2. 注册与判定（3）：`registerConsumer` guard 分支 + `guardTool`。
3. 挂载（4）：`tools/pre-execute` 监听器，fail-open。
4. 测试（5-6）+ 反向验证（`guardTool` 恒返回 `undefined` → 拦截用例转红）。
5. `npm --prefix rule-engine run check` → 包内 `npm test` → `npm --prefix rule-engine run build`。
6. 文档（7）。
7. 关闭（8）：条目标完成并移出 BACKLOG、本文件归档、合并后真机验证（需 `behavior-correction` 就位才能端到端看到拦截）。

### 验收

- 注册：`sources: ["tools/pre-execute"]` + `guard` 成功；缺 `guard` / 同时给 `decide` / 带 `delivery` 或冷却 → 拒绝注册并告警。
- 汇总：两个消费者分别 `allow` 与 `deny` → 返回 deny（与顺序无关）；都放行 / 弃权 → `undefined` 且监听器调 `next()` 1 次；命中 `deny` 后不再调用后续消费者。
- 异步 guard 正常 `await`；guard 抛错 → 告警 + 视为弃权、调用照常放行。
- 规则侧：`normalizeRule({source:"tools/pre-execute", …})` 报错；`rule_add` 同。
- 子代理会话同样被唤醒（`sessionId` 有值）。
- `check` / 包内测试全绿 / `build` 通过；真机（合并 + profile 挂载后）工具被拒且回执含 reason。

### 风险与待实现时确认

- **事件注册是否需 inject `tools`**：预期不需要（`ctx.on` 是事件面；`auto-approve` 注入 `tools` 是为读 `ctx.tools`）；真机若不触发，改为「`ctx.get("tools")` 存在才注册」并记录。
- **`decide` 变可选后的兼容面**：`md-table-check` / `symbol-normalizer` / `ponytail` 的注册调用需保持通过类型检查；实现后跑全仓 `npm run check`。
- **异步 guard 与 waterfall**：宿主支持异步决定（`auto-approve` 已异步）；监听器里的 `await` 与 `next()` 调用顺序需单测锁定。
- **端到端验收依赖并行任务**：单支只能验证框架层与包内测试；真机拦截效果要等 `behavior-correction` 合并并挂进 profile（仓库外，需批准）。
- **`RuleSource` 扩展波及面**：grep 全仓 `RULE_SOURCES` / `RuleSource` 与「长度 = 10」类硬编码断言。

## 实现记录 / 测试与证据（2026-10-22，分支 `dsh/rule-engine-guard`，基线 `fc20f46`，已合并主线 `c1b91e0`）

按「决策 1-9」「规划 1-8」落地；`behavior-correction` 与仓库清单（根 `package.json` / `install.sh` / `AGENTS.md` / 根 README）按范围变更**不在本分支**（由并行 bc 分支独占）。未关闭条目、未归档本文件、未动 `docs/STATUS.md`、未改帧基线。

实测数字：

- `npm --prefix rule-engine run check` 通过（`tsc --noEmit` 无输出）。
- `npm --prefix rule-engine test`：168 条，pass 168 / fail 0（新增 `tests/consumerGuard.test.ts` 11 条；`tests/rules.test.ts` / `tests/tools.test.ts` / `tests/main.test.ts` 增补）。
- `npm --prefix rule-engine run build` 通过。
- 全仓 `npm run check` 通过（30 个包的检查链，含 `md-table-check` / `symbol-normalizer` / `ponytail`，既有三个消费者的注册调用未被 `decide` 可选化破坏）；既有消费者测试：md-table-check 73 / 73、symbol-normalizer 43 / 43、ponytail 5 / 5。
- 反向验证：临时在 `guardTool` 开头插入「恒返回 `undefined`」→ `test` 变 168 条 / pass 158 / fail 10（`tests/consumerGuard.test.ts` 8 条 + `tests/main.test.ts` 的 deny 回执与 fail-open 告警 2 条）；恢复后 168 / 168 全绿、`check` 通过。
- 规则侧：`normalizeRule({ source: "tools/pre-execute" })` 与 `rule_add` 同参数均报错（「该节点只用于消费者 guard」）；`RULE_SOURCES` 仍 10 项，`CONSUMER_SOURCES` 11 项。
- 子代理会话：`guardTool` 对 `sessionId` 已具备的会话（含 `origin: "subagent"` / `resumed` 为真）照常唤醒并透传 `resumed`。

证据位置：`tests/consumerGuard.test.ts`（注册校验 / 顺序与 `deny` 胜出 / `allow` 不否决 / 异步 / 异常弃权 / 上下文透传 / 子代理 / 注销）、`tests/rules.test.ts`（规则侧拒绝与源枚举）、`tests/tools.test.ts`（`rule_add` 拒绝）、`tests/main.test.ts`（监听器注册、`next()` 调用次数、deny 回执、fail-open）。

## 真机验收（2026-10-22，合并后另开新会话，profile fff）

- 环境：main 合并 `73af605`（bc 插件）+ `907e066`（bc 的 ruleEngine 硬依赖修正）后，profile 挂载
  `behavior-correction`（`- insert:` 条目，排在 `rule-engine` 之后），另起新会话执行。
- 结果：`bash` + `herdr pane list` → 被拒，回执「bash 里不要跑 herdr 命令: 改用 herdr_pane 工具」；
  `bash` + `echo herdr` → 同样被拒；`bash` + `ls -la` → 正常执行。
- 告警：活动区两条 `[rule-engine] warn: 消费者 "behavior-correction" 拒绝工具 bash`（消费者 id 与
  工具名均正确）。
- 结论：guard 面的注册、唤醒、汇总（deny 回执给宿主）与告警链路在真机成立；框架无遗留缺陷。
