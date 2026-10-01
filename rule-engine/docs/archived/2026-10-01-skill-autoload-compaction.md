# skill 自动加载的触发条件改为「会话记录被压缩后」（接取条目：`rule-engine/docs/BACKLOG.md`「skill 自动加载的触发条件改为「会话记录被压缩后」（当前为「首个工具调用」）」）

状态：完成　　开启：2026-10-01　　关闭：2026-10-01
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
1. 运行时（非仓库，写出需用户同意）：`~/.dsh/rule-engine/rules.json` —— ① 给 `skill-autoload-on-unlock` 开 `dedupeInRecord: true`（这是「重载不重复注入」的开关）并在 `description` 记明；② 新增 `skill-autoload-after-compaction`（`source: "compaction"`、`predicates: ["always"]`、`dedupeInRecord: true`、`cooldownTurns: 0`、`delivery: "next-step"`、正文与 summary 同 `skill-autoload-on-unlock`）。

## 实现记录（2026-10-01）

按方案 B 落地：6 个源文件 + 3 个测试文件 + 3 份文档。

1. `src/types.ts`：`RuleSource` 增 `"compaction"`；`Rule` / `NormalizedRule` 增 `dedupeInRecord`（缺省 `false`）。
1. `src/rules.ts`：`RULE_SOURCES` 同步；`normalizeRule` 归一 `dedupeInRecord`。
1. `src/match.ts`：空条件对 `compaction` 与 `turn-end` 同口径（无条件命中）。
1. `src/engine.ts`：`handle` 增 `compaction/end` → `#evaluate("compaction", "", …)`；`EngineOptions.messagesOf` + `#inRecord()` 实现按投影去重（命中则跳过注入、仍记本次命中以免每次工具调用重读投影；投影不可读 → 照旧注入）；`update()` 的 patch 白名单补 `dedupeInRecord`；头部注释同步两条口径。
1. `src/main.ts`：`PluginContext.sessions` 增只读 `get?`；新增 `sessionMessagesOf()`（`deriveMessages()`），经 EngineOptions 注入引擎。
1. `src/tools.ts`：`rule_add` / `rule_update` 的参数与描述补 `compaction` 匹配面与 `dedupeInRecord`。
1. 文档：`README.md`（匹配面四类 + `dedupeInRecord` 行 + 工具参数 + 已知限制）、`docs/DESIGN.md`（边界 / 分层依赖 / §4 空条件 / §5 判定时机 / §6 节流与去重）、`TUI/docs/DESIGN.md`「解锁后自动加载行为 skill」（补两条规则与去重口径）。

**实现期细化（仍在计划文件清单内）**：去重做成**规则级开关** `dedupeInRecord`，而非对所有注入无条件生效——symbol-normalizer 的回合审查反馈 summary 固定（`符号规范提醒`），无条件去重会让「模型再次违规」的新提醒被历史里的旧注入永久压制。

## 测试与证据

- `rule-engine`：`npm run check` ✓、`npm run build` ✓、`npm run test` ✓ **67/67 通过**。新增 3 条单测：`compaction` 只认终态 `compaction/end`（start / summary / prune 不触发）、`dedupeInRecord` 三态（投影已有同 summary → 跳过 / 只有别的注入 → 注入 / 读不到投影 → 注入）、「压缩把注入挤出投影后由 compaction 规则补回一次」；并同步 `rules.test.ts` 缺省值断言与 `match.test.ts` 空条件口径。
- **真机验证（2026-10-01，用户重启 + `/compact` 后核对会话记录 `~/.dsh/sessions/--home-guochang-Projects-dsh-toolset--/tui-9c0c2a21-…/session.v4.jsonl.zstd`）**：
  1. 恢复会话（记录里的 skill 注入在 8054，晚于上次压缩 7660，仍在投影内）→ 新进程首个工具调用**不再**注入：历史里「每次重启后必经一次注入」的链条（… 6594 / 7168 / 7630 / 7675 / 8054）中断，新进程开工直到用户触发压缩前无任何新注入。
  1. `/compact`（`compaction/start` 8194 → `compaction/summary` 8195 → `compaction/end` 8197）→ **恰好补一次**：`agent/inbox/spliced` seq 8198，`target: next-step`，summary「解锁后加载 i-have-adhd / karpathy-guidelines」。
  1. 补注入之后的工具调用（turn 113 连续多次 `tool/call`）未再触发注入：压缩把旧注入挤出投影时补一次，补完即被去重拦住，无重复。
  1. 全程无异常告警：记录内无 warning 类事件，活动区无用户可见异常提示。

## 收尾

- 结论：按方案 B 落地并验证通过——触发机会保留「首个工具调用」（锚定解锁点），真正判据改为「会话可见投影里是否还看得见本规则的注入」；新增 `compaction` 匹配面用于压缩后补一次。
- 代码 + 测试用例：commit `1995793`（6 个源文件 + 3 个测试文件）。
- 剩余文档（`README.md` / `docs/DESIGN.md` / `TUI/docs/DESIGN.md` / 本文件 / BACKLOG 清理）随关闭后的最后一次提交。
- 仓库外运行时规则 `~/.dsh/rule-engine/rules.json`：`skill-autoload-on-unlock` 补 `dedupeInRecord: true`；新增 `skill-autoload-after-compaction`（`source: "compaction"` + `predicates: ["always"]` + `delivery: "next-step"` + `dedupeInRecord: true`）。重建口径已回写 `TUI/docs/DESIGN.md`「解锁后自动加载行为 skill」。
