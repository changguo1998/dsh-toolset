# 起草 goal 时 objective 首行 = 一句话概括（接取条目：`docs/BACKLOG.md` §2「起草 goal 时要求 objective 首行 = 一句话概括」）

状态：完成（2026-10-07）　　开启：2026-10-07　　关闭：2026-10-07
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

TUI 状态列 Goal 块改成**只显示 objective 首个非空行**（同批落地，见 `TUI/docs/archived/2026-10-07-goal-objective-one-line.md`）。官方 `GoalSnapshot` 是严格白名单、加不了概括字段，所以概括只能写进 objective 首行。本条给**起草面**加约定，让首行确实是一句概括，而不是被截断的正文开头。

## 调研（沿用同批结论，宿主源码实测）

- `dsh-goal/lib/index.js:86-102`：快照解码器严格白名单（`id` / `revision` / `objective` / `phase` / `maxGoalRounds`，blocked 相位另加 `blockedReason`），多一个键就抛错 → **没有概括字段可加**。
- 官方 `dsh-tool-goal`（`create_goal` / `update_goal`）的 schema 由宿主维护、本仓不可改 → 官方工具路径**无载体**。
- 官方 Web UI 同样是显示层截断（`dsh-client-ui-goal/lib/client.js:129` 的 `text-overflow:ellipsis`），也没有字段。
- 本包 `goal_contract_draft` 是**我们自己的工具**：入参 schema 由 `compileParameters` 生成（`goal-contract/src/tool.ts:118`），工具描述与参数说明都由本包维护 → 约定载体就放这里。

## 决策（2026-10-07 用户裁定）

**D1｜载体**：只放 `goal-contract` 的**工具描述 + `objective` 参数描述**。不加快照字段、不 fork 官方工具 schema、不新增注入载体（rule / skill）。理由：零新组件、与渲染口径（首行截断）天然对齐；官方 `create_goal` 路径暂无载体，属**已知覆盖边界**。

**D2｜措辞**：写明「objective 首行必须是一句话概括（TUI 状态列只显示首个非空行；全文经宿主 `/goal` 命令输出读）」。

**D3｜不做的**：不动 `buildObjective` / `parseContract` 的 `<objective>\n\nDone-when:\n<JSON>` 封装与回读口径（首行约定不引入新标记行，往返比对不受影响）；不做「首行像不像概括」的校验（无客观判据，误拦风险大于收益）。

## 规划（计划改动文件清单）

1. `goal-contract/src/tool.ts`：`TOOL_DESCRIPTION` 补一条 + `objective` 参数 `description` 补写。
1. `goal-contract/README.md`：能力表 `objective` 行同步。
1. `goal-contract/tests/tool.test.ts`：JSON Schema 用例里加断言（工具描述与参数描述都含约定、且写明全文入口 `/goal`）。
1. `docs/BACKLOG.md`：条目〔进行中〕→ 关闭时移除（余下条目按编号口径重编）。
1. 本追踪文档：建 → 关闭时移入 `docs/archived/`。

**估时** 30-45 min。**验收**（条目原文）：`goal-contract` 单测断言工具定义里含该约定；README 参数表同步；`check` / `build` / `test` 全绿。

## 实现记录

- `goal-contract/src/tool.ts:64`：`TOOL_DESCRIPTION` 增一条「objective 首行必须是一句话概括（TUI 状态列只显示首个非空行；全文经宿主 /goal 命令输出读）。」
- `goal-contract/src/tool.ts:123`：`objective` 参数 `description` 增同口径一句（保留原有「不得包含独占一行的 `'Done-when:'`」）。
- `goal-contract/README.md:11`：能力表 `objective` 行同步。
- `goal-contract/tests/tool.test.ts:308-325`：JSON Schema 用例新增 3 条断言（工具描述含约定、参数描述含约定、参数描述含 `/goal`）。
- 未改：`contract.ts` 的封装 / 回读口径、访谈状态机、`src/types.ts`、任何宿主面。

## 测试与证据

- `goal-contract`：`npm run check` exit 0；`npm run test` **37 pass / 0 fail**（断言并入既有 JSON Schema 用例，例数不变）。
- 全仓回归（与本批另一条同轮执行）：`npm run check` / `npm run build` / `npm run test` / `npm run demo -- --smoke` — 证据记在 `docs/archived/2026-10-07-pre-execute-order-contract.md`「测试与证据」。
- 待人工：真机起草一次 goal，确认首行是概括、状态列只显示该行、`/goal` 能读到全文。

## 收尾

- 条目「起草 goal 时要求 objective 首行 = 一句话概括」：完成 → 从 `docs/BACKLOG.md` 移除（余下条目重编）。
- **已知覆盖边界**：只有走 `goal_contract_draft` 的 goal 拿到这条起草期约定；宿主 `create_goal` / `/goal` 命令创建的目标没有载体 —— 显示层口径一致（仍取首个非空行），只是没有起草期约束。
- 本文件移入 `docs/archived/`。
- 本次未产生临时 / 调试文件。
