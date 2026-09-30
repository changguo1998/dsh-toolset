# 子代理会话参与消费者评估 → 已关闭句柄 flush 告警（接取条目：`rule-engine/docs/BACKLOG.md`「子代理会话参与消费者评估 → 已关闭句柄 flush 告警（SessionHandleClosedError）」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

子代理会话结束不再产生 flush 告警（也不再把子代理会话纳入消费者评估）；用户会话的规则 / 消费者注入行为不变。

## 调研

- 事件入口：`src/main.ts` 的 `ctx.on("session/event", (session, event) => engine.handle(session, event))`——**不过滤会话**；`engine.handle` 对全部会话累计回合、评估规则与消费者。
- 消费者链路：`engine.ts` 的 `turn/end` → 消费者评估 → `injector.inject`（`inject.ts`，推迟一个宏任务）→ `agents.get(sessionId)` → `followup / inject` → `sessions.flush(agent.session)`；flush 失败一律 `warn`（`inject.ts` 146-152）。
- 宿主判据（`dsh-subagent` 源码）：子代理会话的 `session.header` 含 `{ origin: "subagent", delegationDepth: n ≥ 1 }`（`delegationDepthOf()` 读 `header.delegationDepth`）；用户会话无此标记。
- 既有类型面：`SessionLike` 仅 `{ id }`（`types.ts`）——header 需宽容读取（与引擎「畸形事件安全跳过」口径一致）。
- 触发场景（2026-09-30 真机）：子代理结束 → 其 `turn/end` 仍被消费者评估 → 推迟的 flush 打到已关闭句柄 → `warn: 来源 "consumer:symbol-normalizer-guide" flush 失败：SessionHandleClosedError…`。

## 决策

1. **① 跳过子代理会话**（订阅过滤，`main.ts`）：`header.origin === "subagent"` 或 `header.delegationDepth > 0` 时直接 return——本引擎面向用户会话（消费者 / 注入面），子代理不参与。
1. **② 已关闭句柄静默**（`inject.ts`）：flush 拒绝的错误名 / 信息含 `SessionHandleClosed` 时不 warn（会话已结束属正常竞态）；其它 flush 失败照旧 warn。
1. 备选（未选）：只做 ②——消费者仍对子代理空跑（无谓评估，且 flush 前的其它告警面仍在），不符合条目 ① 的口径。

## 规划

计划改动文件清单（**只改这些**）：

1. `rule-engine/src/main.ts`：订阅过滤 + 导出 `isSubagentSession`（纯函数，供测试）。
1. `rule-engine/src/inject.ts`：flush 失败按错误类型分流（关闭句柄静默）。
1. `rule-engine/tests/main.test.ts`：`isSubagentSession` 单测 + apply 级「子代理会话不进引擎」用例。
1. `rule-engine/tests/inject.test.ts`：flush 关闭句柄静默 / 其它错误仍 warn 用例。
1. `rule-engine/docs/BACKLOG.md`：条目「完成」标记与收尾清理。
1. 本追踪文档。

明确不做：不改匹配 / 节流 / 注入语义；不动 `evaluate()` 服务面（调用方自决）；不改 TUI。

## 实现记录

1. 2026-10-01 `src/main.ts`：导出纯函数 `isSubagentSession`（`header.origin === "subagent"` 或 `header.delegationDepth > 0`；宽容读取，配合引擎「畸形事件安全跳过」口径）；`session/event` 订阅处先判、子代理会话直接 return。
1. 2026-10-01 `src/inject.ts`：新增 `isClosedHandleError`（错误 name / message 含 `SessionHandleClosed`）；flush 拒绝时命中即静默，其它失败照旧 `warn`。
1. 测试：`tests/main.test.ts` 增 `isSubagentSession` 单测 + apply 级「子代理会话事件被跳过（无评估 / 无注入）；用户会话注入不变」；`tests/inject.test.ts` 增「flush 关闭句柄静默；其它失败仍 warn」。
1. 途中修正：测试里 `assert.deepEqual(warnings, [])` 会把 `warnings` 收窄为 `never[]`（node assert 的 asserts 签名），第二段改用独立账本 `warnings2`；`hostWith` 返回值显式标注 `InjectionHost`。

## 测试与证据

- 单测：`cd rule-engine && npm run test` → 63 pass / 0 fail（含新增 3 例）。
- 全量：`npm run test`（根）→ 16 包全绿（rule-engine 63 / TUI 1228 / 0 fail）。
- 机械门禁：`npm run check` exit 0；`npm run build` exit 0（rule-engine 包内）。
- 真机确认（2026-10-01，点 3 前）：重启载入新构建 + 起 25 秒验证子代理 → 子代理结束后活动区**无** `flush 失败：SessionHandleClosedError` 告警（用户确认「通过」）。

## 收尾

- 回写：无需（`rule-engine/docs/DESIGN.md` / README 未描述会话过滤口径；本次为实现层修正，追踪文档即记录）。
- BACKLOG 清理：rule-engine 条目「子代理会话参与消费者评估 → 已关闭句柄 flush 告警（SessionHandleClosedError）」已标「完成」（2026-10-01）并移除。
- 归档：本追踪文档移入 `rule-engine/docs/archived/`。
- 残留检查：`git status` 无计划外文件；`tmp/` 无任务临时文件。
- 遗留项：真机复验时发现**状态列滞留已结束子代理**（与本任务无关，属 TUI 表现）→ 已按流程在 `TUI/docs/BACKLOG.md` 追加条目「状态列 Agents 块只列运行中 / 存活的子代理」交后续处理；`evaluate()` 服务面保持原样（见决策「明确不做」）。
