# 恢复记录：用户块终态符号 + 工具批还原（接取条目：`TUI/docs/BACKLOG.md` 的两条）

- 〈恢复的会话记录也保留用户块终态符号（不要显示 `?`）〉
- 〈恢复的记录要能区分输入 / 正文 / 工具调用（现工具调用位置是空行）〉

状态：实现 / 测试　　开启：2026-10-10　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. 恢复出来的用户块按该回合记录里的 `turn/end` reason 显示当时的终态符号（`✓` / `✗` / `■`），不再一律 `?`，口径与实时路径一致。
1. 恢复出来的记录能区分**输入 / 正文 / 工具批**：工具调用与结果逐条还原（与实时路径同形制），不再折成一行 step 摘要、也不留空行。

## 调研（接取先查，条目里点名的两个前置问题）

- **恢复链路已经有原始事件**：`adapter/dsh.ts` 的 `normalizeHistoryMessages(events)` 直接拿 `sessionQuery.readSurface` / `readSession` 返回的**事件数组**（`tool/call`、`tool/result`、`turn/end` 都在里面），所以两条都不需要更换读取接口——缺的是这个函数**故意**把工具折成 step 摘要（P9 设计）、且没读 `turn/end` 的 reason。
- **终态通路已经完整**：`HistoryMessage.status` →（本次新增透传）→ `surfaceToBuffer` 的 buffer 行 `status` → `replay.ts` 的 `deliveryOfLine`（已有 `status` 透传）→ `sections.ts` 的 `delivery.status → userStatus` → 符号渲染。缺的只是最上游把 reason 读出来。
- **工具行通路也已经完整**：`surfaceToBuffer` 产 buffer 行 → `replay.ts` 的 `deliveryOfLine` 已能把工具行还原成 `tool-call`（合成 callId `replay:<turn>:<step>:<index>`）/ `tool-result`（`✓`/`✗` 前缀）/ 辅助行文本交付。缺的只是上游产出**工具行**而不是摘要行。
- P9 原设计（`docs/DESIGN.md`）明确写「恢复不还原逐条工具行，而是折叠成一行 step 概要」——本次是**按用户条目改口径**，不是修 bug，故 DESIGN 一并回写。

## 决策

- **D1 终态按 `turn/end` reason 读回**：`normalizeHistoryMessages` 记 `(turn → status)`（completed → `success` / aborted → `aborted` / error → `failure`，其余原因不落终态），循环结束后落到**该回合最后一个**用户消息上——与实时路径 `sections.ts` 的 `applyTurnEnd`、`state.ts` 的 `markUserBlockStatus` 同口径。
- **D2 工具批逐条还原**：`step/start` → `role:"step"` 的 step 头行（`stepHeaderLine(step, time, turn)`）、`tool/call` → `role:"tool"` 的调用行（`toolCallLine(name, summarizeToolArguments(args))`）、`tool/result` → `role:"tool"` 的结果行（`toolResultLine(!error, toolResultDetail(message), meta)`）——三个构造器都是实时路径在用的同一批纯函数（复用，不新写格式化）。
- **D3 摘要行删除**：`flushStep` 不再产摘要行（只清 step 状态）；step 头改为 `step/start` 即落一行。**该 step 没有回合区内容时不会变孤儿头**——第 3 步（step 头内容驱动）保证只有有内容才渲染，两条改动天然配合。
- **D4 透传链**：`HistoryMessage.role` 增 `"tool"`、增 `status`；`surfaceToBuffer` 把 `"tool"` 映射成 `kind:"tool"`、把 `status` 透传；`state.ts` 的两处 `history-*` 行类型接受 `"tool"` 与 `status`。
- **D5 不改**：reading API（仍走 `readSurface` / `readSession` 既有优先级）、thinking 不还原（沿用既有口径）、`replay.ts` 的行 → 交付还原逻辑。

## 规划

计划改动文件清单：

- src：`TUI/src/app/adapter/types.ts`（`HistoryMessage`）、`TUI/src/app/adapter/dsh.ts`（`normalizeHistoryMessages`）、`TUI/src/app/commands.ts`（`surfaceToBuffer`）、`TUI/src/app/state.ts`（两处 `history-*` 行类型）。
- tests：`TUI/tests/adapter.dsh.test.ts`（P9 两例改写 + 三处历史会话期望）、`TUI/tests/resume-summary.test.ts`（终态映射 + 帧断言 + 工具批帧断言）。
- 文档：`TUI/docs/DESIGN.md`（P9 两处口径改写）、本文件、`TUI/docs/BACKLOG.md`。

明确不做：thinking 还原；工具行的参数明细（仍只还原摘要首行，与实时路径的 buffer 行一致）；`replay.ts` 的 callId 合成口径。

## 实现记录

- 2026-10-10：
  - `adapter/dsh.ts`：`normalizeHistoryMessages` 导出（供测试）；新增 `turnStatus` 映射与 `turn/end` 分支；末尾把状态回填到该回合最后一个用户消息；`step/start` 落 step 头行（`stepHeaderLine`）；`tool/call` / `tool/result` 各落工具行（`toolCallLine` + `summarizeToolArguments` / `toolResultLine` + `toolResultDetail`）；`flushStep` 只清状态（不再产摘要行）。
  - `adapter/types.ts`：`HistoryMessage.role` 增 `"tool"`；新增可选 `status`（附口径注释）。
  - `commands.ts`：`surfaceToBuffer` 支持 `role:"tool"` → `kind:"tool"`，用户行透传 `status`。
  - `state.ts`：两处 `history-*` 的 `rows` 类型接受 `"tool"` 与 `status`。
  - `docs/DESIGN.md`：P9 两处口径改为「逐条还原工具批 + step 头行」，并同步 `sanitizeText` 段的括注。

## 测试与证据

- 新增用例（`tests/resume-summary.test.ts`）：
  1. 终态映射——`completed → success`、`error → failure`、`max-tokens` 不落终态；并断言随用户行透传。
  1. **帧断言**——恢复含两个回合（一成 `completed`、一败 `error`）的会话，两个用户块分别显示 `✓` 与 `✗`（不再是 `?`）。
  1. **帧断言**——恢复「输入 + 工具调用 + 结果 + 正文」，帧里出现工具名 `bash`、结果符号 `✓`、正文与用户块（不再只剩空行）。
- 既有用例按新口径更新（`tests/adapter.dsh.test.ts`）：P9 两例（折叠摘要 → step 头 + 逐条工具行）、三处「历史会话」期望（工具行不再被省略）；结果事件夹具改用宿主真实形状（`message.content[].content[]` 文本块）。
- 全量：`npm test`（TUI）**1438 / 1438 通过**；`npm run check` 干净；`npm run build` 通过。
- 未做：真机 `/resume` 目视（会话内无法起真机）；thinking 还原（既有口径，不在条目范围）。

## 审阅记录

（待补）

## 收尾

（待补）

## 测试与证据

（待补）

## 审阅记录

（待补）

## 收尾

（待补）
