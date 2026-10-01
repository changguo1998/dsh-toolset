# skill 自动加载的触发条件改为「会话记录被压缩后」（接取条目：`rule-engine/docs/BACKLOG.md`「skill 自动加载的触发条件改为「会话记录被压缩后」（当前为「首个工具调用」）」）

状态：进行中　　开启：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

把行为 skill 的自动加载从「发生过工具调用即注入」改为「会话记录被压缩、skill 正文从可见上下文里消失后才注入」：

- 未压缩的恢复（重载）会话**不再重复注入**（现状：`cooldownTurns` 记账在进程内存，重启必再注入一次）；
- 压缩把 skill 正文裁掉后**能补回**（现状：冷却已吃掉，且压缩不是 `tool-call` 事件，永不补）。

## 调研

1. **宿主压缩事件面存在且落库**：本会话记录（`~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/<sessionId>/session.v4.jsonl.zstd`）中真实事件 `compaction/start` / `compaction/end` / `compaction/summary` / `compaction/prune` 各 5 条（一一对应，5 次压缩）。`compaction/summary` 载荷含 `compactionId` / `summary`（摘要正文）/ `shadowedSeqs[]` / `shadowedRange{start,end}` / `shadowedTokenCount`（`docs/host/DSH-CTX-API.md:144`）。宿主另有压缩缝 `ctx.compaction` 与 `compaction-basic`（fff 覆盖 `thresholdRatio: 0.5`）、`compaction-tool-result-pruner`（`docs/host/HOST-PACKAGES.md:84-87`）。
1. **rule-engine 已能看见这些事件**：`ctx.on("session/event")` → `engine.handle(session, event)`（`rule-engine/src/main.ts:194`），事件形态 `SessionEventLike { type, data?, seq?, time? }`（`src/types.ts:114-119`）——新增压缩触发面**不需要新宿主依赖**，只需在 `handle` 内分派。
1. **匹配面白名单**：`RuleSource = assistant-text | tool-call | tool-result | turn-end`（`src/types.ts:14`；`src/rules.ts:26-29`）；空条件的语义按匹配面区分，仅 `turn-end` 视为无条件命中（`src/match.ts:74-77`）。
1. **「按记录去重」有现成先例**：symbol-normalizer 的会话开局指南按 `source.kind + summary` 扫会话投影、跨重启去重（`symbol-normalizer/src/guide.ts:23-33` + `src/main.ts:168-179`），读投影用 `sessions.get(sessionId)?.deriveMessages?.()`（同文件 `:89-97`）。rule-engine 已硬依赖 `sessions`（`inject: ["agents","sessions"]`），同一模式可复用。
1. **现有规则形态**（运行时层 `~/.dsh/rule-engine/rules.json`）：`skill-autoload-on-unlock` —— `source: "tool-call"` + `predicates: ["always"]` + `cooldownTurns: 10000` + `delivery: "next-step"`；`cooldownTurns` 记账在进程内存（`docs/DESIGN.md` §6），故「每会话一次」实际是「每进程一次」。

## 决策（2026-10-01 用户裁定：**方案 B**；A / C 仅存档备查）

- **方案 B（推荐）**：触发机会 = 首个工具调用（解锁，保持现状）+ 压缩面（新增 `compaction`）；真正的注入判据 = **会话可见投影里是否还看得见本规则的注入**（看不见才注入）。效果：新会话首次解锁照旧加载；未压缩的重载会话不重复；压缩把注入冲掉后补回；压缩后若注入仍在投影里（未被 shadow）则不重复。
- **方案 A（字面最小）**：只留压缩触发面——新增规则 `skill-autoload-after-compaction`（`source: "compaction"`）、删除/停用 `tool-call` 版。效果：重载不重复、压缩后补；**全新会话在首次压缩前不加载 skill**（相对现状的行为回归）。
- **方案 C（只加去重、不加压缩面）**：仅「按投影去重」+ `cooldownTurns: 0`。效果：重载不重复；压缩后要靠模型**再次发起工具调用**才有机会补（压缩后不再调工具就不补）。

## 规划（计划改动文件清单）

按方案 B 列出（选 A/C 则相应减少；实现前不改任何文件）：

1. `rule-engine/src/types.ts`：`RuleSource` 增加 `"compaction"`。
1. `rule-engine/src/rules.ts`：`RULE_SOURCES` 白名单同步。
1. `rule-engine/src/match.ts`：空条件对 `compaction` 与 `turn-end` 同口径（无条件命中）。
1. `rule-engine/src/engine.ts`：`handle` 分派 `compaction/end` → `#evaluate("compaction", "", …)`（该面只作边界触发，文本入参为空串）；新增**按投影去重**——注入前查会话投影是否已有同 `source.summary` 的 `rule-engine` 注入，有则跳过（投影不可读 → 按现状注入，fail-open 到「照旧注入」）。
1. `rule-engine/src/main.ts`：把 `sessions` 面同时交给引擎（现只交给注入器）。
1. `rule-engine/src/tools.ts`：工具面文案补 `compaction` 匹配面。
1. `rule-engine/README.md`：匹配面表 + 去重口径。
1. `rule-engine/docs/DESIGN.md`：§4（空条件口径）/ §5（判定时机）/ §6（节流与去重：跨重启去重与压缩重置）同步。
1. `TUI/docs/DESIGN.md`：「解锁后自动加载行为 skill」小节补新触发面与去重口径（规则重建依据）。
1. `rule-engine/tests/`：压缩事件分派、去重命中（跳过）/ 未命中（注入）、投影不可读（照旧注入）、空条件无条件命中。
1. 运行时（非仓库，写出需用户同意）：`~/.dsh/rule-engine/rules.json` —— 新增 `skill-autoload-after-compaction`（`source: "compaction"`、`predicates: ["always"]`、`cooldownTurns: 0`、`delivery: "next-step"`、正文同 `skill-autoload-on-unlock`），并给 `skill-autoload-on-unlock` 的 `description` 补去重口径说明。

## 实现记录

（待实现）

## 测试与证据

（待实现）

## 收尾

（待关闭）
