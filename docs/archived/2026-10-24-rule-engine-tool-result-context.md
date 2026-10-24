# rule-engine 消费者的 `tool-result` 判定透传结构化上下文（接取条目：`docs/BACKLOG.md`「rule-engine 消费者的 `tool-result` 判定透传结构化上下文」）

状态：已关闭（不立项）　　开启：2026-10-24　　关闭：2026-10-24
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

让 rule-engine 消费者在处理 `tool/result` 时拿到**结构化上下文**（工具的返回值、调用参数、调用 id），而不是只有渲染后的结果文本；从而支持「按 `exitCode` / `sandbox.mode` / 命令形状」判定，摆脱对本地化报错文案的依赖。

前置纪录：`docs/archived/2026-10-24-worktree-git-escalation.md` 的「决策 5 修订」（用户 2026-10-24 选定「扩展 rule-engine 透传结构化 payload」）。

## 现状

- `rule-engine/src/engine.ts:701-712` 处理 `tool/result` 时只取 `messageText(data["message"])` 交给 `decide(text, trigger, ctx)`，事件里的结构化 `value` 被丢弃。
- `rule-engine/src/types.ts` 的消费者 `decide` 只有 `(text, trigger, ctx)`；`ToolGuardContext`（`tools/pre-execute` 用）已有 `name` / `arguments` / `callId`，但那是另一个面。
- 因此消费者只能匹配文案（例如 git 的「只读文件系统」），宿主改文案 / 换 locale 即失效。

## 决策

> 2026-10-24 用户确认 5 项按推荐 (b / b / b / a / b)。
>
> **2026-10-24 关闭：全部作废（不立项）。**

1. **透传形状**：a 只放 `value` · b `{toolName?, callId?, value?}` · c b + 时间 / `agent` 等元数据。**选定 b**。理由：`toolName` 让消费者不必解析文本就能分支，`callId` 是回溯调用参数的唯一键；时间与 agent 目前无消费者，加了只会扩大接口面。
2. **调用参数回溯**：a 不回溯（消费者拿不到参数）· b 维护 `callId → arguments` 的最近 32 条 FIFO 映射 · c 全量不设上限。**选定 b**。理由：判定需要命令形状；全量映射随会话增长，32 条足够覆盖同回合并发调用。
3. **兼容策略**：a 字段必填（破坏既有消费者）· b 可选字段、缺省即旧行为。**选定 b**。理由：既有消费者（`md-table-check` / `behavior-correction` / `preference-analysis`）不应被迫改。
4. **节点范围**：a 只扩 `tool-result` · b 顺带改 `tool-call` 的判定文本形态 · c 十个节点全扩。**选定 a**。理由：`tool-call` 文本已被消费者依赖（正则匹配参数 JSON），改动会破坏既有规则；其余节点没有结构化载荷。
5. **类型来源**：a 直接 import 宿主类型 · b 用结构面子集自写类型。**选定 b**。理由：与 `ToolGuardContext` 既有做法一致，宿主升级不会传导到本仓类型面。

## 规划

计划改动文件清单（草案，实现阶段定稿）：

- `rule-engine/src/types.ts`：新增可选上下文类型（建议 `ToolResultContext = { toolName?: string; callId?: string; value?: unknown }`），并把它挂到消费者 `decide` 的 `ctx` 上；补文档注释说明「可选、缺字段即旧行为」。
- `rule-engine/src/engine.ts`：`tool/result` 分支在现有 `text` 之外透传 `data` 的结构化 `value`；维护 `callId → tool/call arguments` 的最近 N 条映射（建议 N = 32，按插入序淘汰最旧），供消费者按 `callId` 取调用参数。
- `rule-engine/README.md`：节点表 `tool-result` 一行补「附带结构化上下文」；消费者面补一句字段说明与兼容口径。
- `rule-engine/tests/`：结构化 `value` 透传、`callId` 回溯调用参数、缺字段时旧行为不变、映射上限淘汰、`rule_test` 干跑（无会话上下文）不受影响。

明确不做：

- 不改 `tool-call` 的判定文本形态（仍是「工具名 + 参数 JSON」）。
- 不改注入机制（`followup` / `steer`）、冷却、去重与对齐 flag。
- 不扩展到其它 9 个节点；不引入宿主类型（保持结构面子集）。

## 实现记录

（未实现：查证后判定不可行，见「收尾」。）

## 偏差

- 计划透传的 `value` 根本不在 `tool/result` 会话事件里：宿主 `session.append('tool/result', {turn, step, message, error?, meta?})`（`packages/core/agent-loop/src/tool-calls.ts:282-295`），工具返回值只存在于 `ToolExecutionResult.value`，由 `tools/post-execute` 暴露。因此本任务的前提不成立。

## 测试与证据

- 只读核实：`packages/core/agent-loop/src/tool-calls.ts:282-295`（事件载荷字段）、`packages/core/tools/src/index.ts:177`（`tools/post-execute` 签名）与 `:618-621`（`PostToolDecision.additionalContexts`）、`packages/spill/spill-policy/src/index.ts:133`（该钩子的既有用法）。未跑 build / test。

## 收尾

- 条目「rule-engine 消费者的 `tool-result` 判定透传结构化上下文」标「不立项」并从 `docs/BACKLOG.md` 移除。
- 替代方案已落地在 `escalation-hint`：直接订阅 `tools/post-execute`，同时拿到 `exec`（工具名 + 参数）与 `result.value`（`{exitCode, sandbox}`），无需改 `rule-engine`。见 `docs/implementation/2026-10-24-escalation-hint-package.md` 决策 10。
- 本文件移入 `docs/archived/`。
- 未回写 README / DESIGN（`rule-engine` 行为未变）。
