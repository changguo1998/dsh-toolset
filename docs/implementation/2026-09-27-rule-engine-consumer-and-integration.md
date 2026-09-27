# rule-engine 消费者框架、symbol-normalizer 插件与仓库级集成（BACKLOG: 项目级 #43 / #44 / #45 / #47 / #48）

状态：进行中　　开启：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
TUI 侧（TUI#18 = #43 的 TUI 侧）过程记录见 `TUI/docs/implementation/2026-09-27-symbol-consumer-change.md`。

## 目标

1. **#47 消费者框架**：rule-engine 提供简单消费者注册面——`registerConsumer({ id, decide })`，`decide(ctx)` 返回**要注入的内容** `{ text, summary? }`（null = 本轮不反馈）；turn-end 时按注册顺序**同步**依次询问、聚合反馈、由 rule-engine **统一注入**（注入器 / 每回合上限 / 同文本去重 / 可选消费者冷却）。另提供只读 `evaluate(text, source)`，同样返回**可注入内容**（命中规则含 `action.text` / `summary`）。
1. **#48 新插件 `symbol-normalizer`（2026-09-27 用户定稿）**：把 TUI 的符号规则迁移为独立插件；启动时以 `registerConsumer` 注册进 rule-engine（框架的第一个验证消费者）；provide `symbolNormalizer` 服务（`normalize` / `onReview` / `status`）。
1. **#44** rule-engine 增设 next-step 注入路径：规则字段 `delivery: "followup"（默认）| "next-step"`（`agent.inject`）。
1. **#45 仓库级集成**：根 `package.json`（check/build）、`scripts/install.sh`（canonical_pkgs）、`scripts/test-parallel.sh`（default_pkgs）、根 `README.md`（插件表/目录树/文档索引）、`AGENTS.md`（插件 12 → 14、包数 13 → 15）。
1. **#43 / TUI#18**：TUI 删除内置符号逻辑与 followup，改经 `symbolNormalizer` 服务消费（展示归一 + notice）；插件缺席 → 原文透传；`/symbol-unify` 开关保留。

## 调研（关键事实）

1. 宿主 inbox 面（rc.2）：`agent.inject(m)` = `send(m, 'next-step', false)`（挂到最近 pre-step，不唤醒）；`agent.steer(m)` = `send(m, 'next-step', true)`；`agent.followup(m)` = `send(m, 'next-turn', true)`（各自成回合）。来源：`GithubRepos/deepseek-harness/packages/core/agent-loop/src/agent.ts:154-172`、`packages/core/agent/src/runtime-types.ts:204-241`。
1. `agent/pre-step` 为 waterfall（payload `{agent, messages, turn, step, signal}`，返回 `PreStepDecision` enter/reject），官方有 `{prepend:true}` 监听者先例（model-selection 注入模型切换 notice，`packages/core/agent/src/model-selection.ts:113-126`）。**决定不自行注册 listener**，直接使用官方 next-step inbox——语义即「消息进入 step 前」，且避免与官方 prepend 监听者的顺序 / 空 step 语义纠缠。
1. 官方 agent-loop 有拦截 / 追加入口（`agent/pre-step` waterfall、`agent.inject` = next-step inbox；先例：model-selection notice、repeat-tool-reminder、hooks-\* 外部命令钩子桥），但**没有「依次询问已注册插件并聚合」的调度层**——该中介职责由 rule-engine 承担（2026-09-27 用户确认的模块定位）。
1. rule-engine 现状：provide 仅 `list()` / `status()`；注入器仅 `agent.followup`；规则字段无 delivery（见 `rule-engine/README.md`、`rule-engine/src/main.ts:104-108`）。
1. TUI 现状（迁移前）：`TUI/src/app/symbols.ts`（459 行，治理区段 / 推荐白名单 / 别名表 / `normalizeSymbols`）；App 流式归一（`index.ts:958-967`）、回合报告累积（`index.ts:1237-1252`）、turn-end 冷却过滤 + notice + followup（`index.ts:1259-1341`）；配置 `tui.config.json` `symbols` 段（`config.ts:240-286`）；单测 `tests/symbols.test.ts`。
1. 插件模板与集成点：新包以 `rule-engine/` 为模板（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` + check/build/test/demo 脚本）；仓库级集成点 = 根 `package.json`、`scripts/install.sh`（canonical_pkgs）、`scripts/test-parallel.sh`（default_pkgs）、根 `README.md`、`AGENTS.md`。

## 决策

| # | 维度 | 选定 | 理由 |
|---|------|------|------|
| D1 | 消费者框架（2026-09-27 定稿） | 注册面 `registerConsumer({id, delivery?, cooldownTurns?, cooldownMs?, decide})`；`decide(ctx)` **返回注入内容** `{text, summary?}`（null = 不反馈）；turn-end 同步按注册顺序询问、聚合、统一注入；另提供 `evaluate` 返回可注入内容。异步 / priority / 复杂框架不做 | 中介定位：插件排队 + 提供内容，rule-engine 统一注入 |
| D2 | 暴露面 | `RuleEngine.{evaluate, registerConsumer}` + `ruleEngine` 服务（同面）+ 具名导出 | 消费者经 `ctx.get('ruleEngine')` 注册 / 查询 |
| D3 | next-step 路径 | 规则字段 `delivery: "followup"（默认）| "next-step"`；next-step 走官方 `agent.inject` | 官方 next-step inbox 即该语义；不另注册 waterfall listener |
| D4 | 旧宿主缺 `agent.inject` | 记 warning 并跳过（不回退 followup） | 不静默改变语义；基线 rc.2 具备该 API |
| D5 | 符号规则归属（2026-09-27 定稿） | **迁出 TUI** → 新插件 `symbol-normalizer`（暂名，可改）；TUI 删除 `symbols.ts` / 冷却表 / followup | 用户定稿：框架 + 第一个验证消费者插件 |
| D6 | 插件接入方式 | `inject: ["ruleEngine"]` 硬依赖；apply 时 `registerConsumer`；rule-engine 缺席 → 插件不加载（TUI 回退原文透传） | 插件职责就是注册为消费者，硬依赖语义清楚 |
| D7 | 触发与通知链路 | 插件在消费者 `decide` 内做回合审查（逐符号冷却）→ 反馈内容交 rule-engine 注入；人类 notice 经服务 `onReview` 回调推给 TUI | 冷却只消费一次、口径统一 |
| D8 | 冷却归属 | 插件逐符号冷却（10min / 3run，配置可调，按会话记账）；引擎级按消费者冷却可选（本插件不设） | 动态文案 + 领域语义 |
| D9 | TUI 缺席行为 | 原文透传、无 notice / 无提醒（彻底迁移，不保留内置兜底） | 用户要求「迁移」；避免双份逻辑 |
| D10 | 配置迁移 | `tui.config.json` 的 `symbols` 段废弃 → 插件 config（recommended / aliases / warnModel / cooldownMs / cooldownRuns） | 规则随代码一起迁移 |
| D11 | 真机验证 | 新临时 profile（不改 `fff`）；验证后删除 | 用户 2026-09-27 裁定 |

## 规划

### 计划改动文件清单

rule-engine（#44 / #47）：

| 文件 | 改动 |
|------|------|
| `src/types.ts` | `RuleDelivery`；`Rule.delivery` / `NormalizedRule.delivery`；注入请求 `delivery`（`ruleId` → `sourceId`）；`RuleHit` / `EvaluateResult` / `ConsumerRegistration` / `ConsumerContext` / `ConsumerFeedback`；`RuleSummary.delivery` |
| `src/rules.ts` | `RULE_DELIVERIES`；`normalizeRule` 校验 / 归一 `delivery` |
| `src/engine.ts` | `evaluate()`；`registerConsumer()` + turn-end 调度（同步依次询问 / 聚合 / 冷却 / 统一注入）；`test()` 改薄包装；`#fire` 传 delivery；`update()` 支持 delivery；`summaries()` 带 delivery |
| `src/inject.ts` | `deliver()` 按 delivery 分流（followup / inject），缺 `agent.inject` 告警跳过 |
| `src/tools.ts` | `delivery` 参数（add / update），描述同步 |
| `src/main.ts` | 服务增加 `evaluate` / `registerConsumer`；导出新类型 / 常量 |
| `tests/` | `inject.test.ts`、`rules.test.ts`、`engine.test.ts`、`main.test.ts` 增补用例 |
| `README.md` / `docs/DESIGN.md` | 消费者框架 / 两条注入路径 / evaluate 契约、限制更新 |

symbol-normalizer（#48，新包，模板同 rule-engine）：

| 文件 | 职责 |
|------|------|
| `package.json` / `tsconfig.json` / `cordis.patch.yml` / `.gitignore` / `LICENSE` / `index.ts` | 包骨架与 bundle 契约（`id: symbol-normalizer`） |
| `src/symbols.ts` | 自 `TUI/src/app/symbols.ts` 迁入：治理区段 / 文本区段 / 白名单 / 别名 / `normalizeSymbols` |
| `src/review.ts` | 回合审查：逐符号冷却（按会话）+ notice 文案 + 模型反馈文案 |
| `src/main.ts` | 入口：`inject: ["ruleEngine"]`、`Config`、apply（注册消费者 + provide `symbolNormalizer`） |
| `src/types.ts` | 配置 / 报告 / 审查类型 |
| `tests/symbols.test.ts` | 自 `TUI/tests/symbols.test.ts` 迁入并适配 |
| `tests/review.test.ts` / `tests/main.test.ts` | 冷却 / 文案 / 注册与降级用例 |
| `demo/main.ts` | mock：正文 → 审查 → notice + 反馈内容（不依赖 DSH） |
| `README.md` / `docs/DESIGN.md` | 模块契约与架构 |

TUI（#43 / TUI#18）见 `TUI/docs/implementation/2026-09-27-symbol-consumer-change.md`。

仓库级（#45）：

| 文件 | 改动 |
|------|------|
| `package.json` | check / build 追加 `rule-engine`、`symbol-normalizer` |
| `scripts/install.sh` | `canonical_pkgs` 追加两个包 |
| `scripts/test-parallel.sh` | `default_pkgs` 追加两个包 |
| `README.md` | 插件表、目录树、文档索引、包数（12→14、13→15） |
| `AGENTS.md` | 插件事数（三处 + 子包清单） |

流程文档：`docs/BACKLOG.md`（#43 / #45 / #47 / #48 状态）、本文件；`TUI/docs/BACKLOG.md` 与 TUI 追踪文档。

### 任务拆分（每步验证）

1. 框架（#47）：evaluate + registerConsumer + 调度 + 测试 → `npm --prefix rule-engine run check` + `npm --prefix rule-engine test`
1. next-step（#44）：delivery + inject 分流 + tools + 测试 → 同上
1. 新包（#48）：骨架 → 迁移 symbols → review → 注册与服务 → demo → 文档与测试 → `npm --prefix symbol-normalizer run check` + `test` + `demo`
1. TUI 改造（#43 / TUI#18）：服务消费 + 删除内置逻辑 + 测试 → `npm run test:tui`
1. 仓库集成（#45）：脚手架与根文档 → `npm run check`（全包）+ `sh scripts/test-parallel.sh rule-engine symbol-normalizer`
1. 全量验证：全部包 `check` / `build`；**临时 profile 真机验证**（rule-engine + symbol-normalizer + TUI 同时挂载，实测符号提醒注入与 notice）
1. 收尾：BACKLOG 标完成、追踪文档归档、README / AGENTS 回写核对

### 明确不做

- 异步 `decide`、priority、脚本谓词注册面、`tag` / `abort` / `memory` 动作、逐 delta 实时匹配、TUI `/rule` 面板
- 不改 `~/.dsh/profiles/fff`；不改 `docs/STATUS.md`（用户择时更新）
- TUI 不保留内置符号兜底（D9）

## 实现记录

（按时间追加）

## 测试与证据

（验证命令与结果，收尾时汇总）

## 收尾

（关闭时填：回写文档、遗留项、归档）
