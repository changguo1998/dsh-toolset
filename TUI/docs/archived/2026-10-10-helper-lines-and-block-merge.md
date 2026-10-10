# 辅助行独立成段 + 辅助行被吞 + 跨块正文粘行（接取条目：`TUI/docs/BACKLOG.md` 的三条）

- 〈辅助行独立成段（不与工具批共用同一段）〉
- 〈同节内「辅助行 → 工具调用」顺序会让辅助行消失〉
- 〈同一步内「工具调用前后的正文」被粘成一行〉

状态：关闭　　开启：2026-10-10　　关闭：2026-10-10
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. 辅助行（`source: "tool"` 的**文本**，subagent / hook / command / 重试提示等本地行）与工具批**分槽**：各自成条、各自成段、都可见，同节内按到达序排列。
1. 同来源文本**只在同一块内**合并（流式续写语义）；跨块（同节不同 `index`，或中间夹了工具批 / 用户行 / 分隔线）不合并，按到达顺序各成一项。

## 调研（探针 `tmp/probe-mixed.ts`，未入库）

- 改前：同一步内「正文甲 → 工具调用 → 结果 → 正文乙」被并成一条（`assistant:助手正文甲助手正文乙`）→ 渲染成一行无分隔的长行。
- 改前：同节内「辅助行 → 工具调用」时辅助行整条消失（`toolAt` 只按来源找项，把批挂到辅助行文本项上 → 渲染走批分支，文本不再出）。
- 根因：`appendText` 只按 `item.source === source` 找可并项（不看块身份）；`toolAt` 只按 `item.source === "tool"` 找复用项（不看是否已是批）。两者互为镜像：一个缺「块身份」判据，一个缺「批」判据。

## 决策

- **D1 块身份取交付的 `index`**（条目 18 的裁定问题 ①）：接收层已把 `(turn, step, index)` 作为文本交付的块键，直接用它打标即可，不另建「块键 → 条目下标」映射表（映射表要在节的不可变复制里维护下标，收益不抵复杂度）。
- **D2 并入判据 = 同来源 + 文本项 + 同块**（裁定问题 ②）：同一块的增量 / 整块仍并（含两线对账）；无块身份的路径（notice / shell / user / 恢复重放的整行）保持原样（`block === undefined` 只与同为 undefined 的项并）。
- **D3 `toolAt` 只复用「已是工具批」的项**：与 `appendText` 的排除判据对称——辅助行文本项不再被挂 calls，从而不再消失；批之间不互并（旧行为是「同节第一个 tool 项」一律复用）。
- **D4 `/copy` 改为跨块拼接**：块身份只用于**渲染分段**，`/copy` 要的是「整条最后回复」（既有文档口径：节内同 (turn, step) 的正文按序合并）。新增 `joinedLastTextBySource`（最后一个含该来源文本的节内，各条目按序拼接），`/copy` 改用它；`/council` 等仍用 `lastTextBySource`（不动）。
- **D5 三条一并落地**（裁定问题 ③）：三处落点重叠在 `sections.ts` 的同一段归并逻辑，分开改会互相推翻。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout/pipeline/types.ts`（`Item.block`）、`TUI/src/app/layout/pipeline/sections.ts`（`appendText` 块判据、`toolAt` 批判据、`joinedLastTextBySource`）、`TUI/src/app/index.ts`（`/copy` 改用拼接版）。
- tests：`TUI/tests/pipeline-sections.test.ts`（② 契约改判据 + 辅助行用例）、`TUI/tests/pipeline-panes.test.ts`（⑩ 辅助行各自成段）。
- 文档：本文件；`TUI/docs/BACKLOG.md`（三条状态）；必要时 `TUI/docs/DESIGN.md`（「按来源归并」口径 → 「按块归并」）。

明确不做：`final` 的粒度（会话区 / 回合区归属仍按**节**判定，不按块；本条目不改 pane 归属）；`replay.ts` 的块聚合口径；工具批之间的合并语义（D3 后同节多批各自成条）。

## 实现记录

- 2026-10-10：
  - `types.ts`：`Item` 增 `block?: number`（附口径注释：块身份来自交付 `index`，流式续写同块才并）。
  - `sections.ts`：`appendText` 增 `block` 参数并把它并入并入判据（`item.block === block`）、创建时落 `block`；调用点传 `delivery.index`；`toolAt` 复用判据收紧为「已是工具批」（`calls !== undefined || results !== undefined`）；新增导出 `joinedLastTextBySource`。
  - `index.ts`：`/copy` 改用 `joinedLastTextBySource`（整条回复 = 节内 assistant 各块按序拼接）。
  - 测试：`pipeline-sections.test.ts` ② 契约改判据（同块交错续写仍合并 / 跨块正文各自成条）+ 新增「辅助行独立成条：辅助行 → 工具调用 两个方向都不丢、不并进批」；`pipeline-panes.test.ts` 新增 ⑩「辅助行各自成段：与工具批不同段、都可见（含批前后各一段）」。
- 复核（回应审阅关心点，自行核对）：`replay.ts` 的恢复路径**按「同 kind 连续行」聚合成块后**才取 `index`（`run` + `flushRun` + `indexByScope` 按 `turn:step` 递增）→ 同一逻辑块只有一个 index，恢复历史不会因块身份而碎成多条；`block` 只对文本路径打标（notice / shell / user / 批不带），`block === undefined` 的项只与同为 undefined 的同来源项并（口径不变）。

## 测试与证据

- 探针 `tmp/probe-mixed.ts`（未入库，演示式缓冲回放的接收层结果）**改前 / 改后**：
  - 改前：`items=["reasoning:混合思考行","assistant:混合中间输出混合最终总结","tool: calls=1"]`（两段正文粘成一条）。
  - 改后：`items=["reasoning:混合思考行","assistant:混合中间输出","tool: calls=1","assistant:混合最终总结"]`（各成一条、顺序即到达序）。
- 全量：`npm test`（TUI）**1434 / 1434 通过**（改动前 1432 + 本批次 2 条新用例；过程中 2 条既有用例按新口径更新：`pipeline-sections` ② 契约、`app.test` 的 `/copy` 期望在改用拼接后仍成立）。
- 契约变化与处置：① `sections.ts` 的「节内按来源归并」→「同来源 + 同块」；`pipeline-sections.test.ts` 的 ② 与文件头契约注释同步；② `/copy` 的读取由「最后一条同来源文本」→「最后节内该来源各块按序拼接」，`app.test.ts` 的 `/copy` 多行断言**不改**（口径一致）。
- 未做：真机目视；`final` 粒度（会话区 / 回合区归属）仍按节判定，不在本批次范围。

## 测试与证据

（待补）

## 审阅记录

- **收尾前审阅**（子代理，只读，5 次工具调用内返回）：结论「无数据丢失 / 崩溃类阻塞问题；1 处真回归 + 2 处口径不一致」。**采纳并已修**：① **真回归**——step 级结算走 `index = -1`（`adapter/dsh.ts` 的 `assistant/message` 结算），`block = -1 ≠ 流式块 0` → 同一逻辑块被拆成两个条目 / 两个框（代码块、表格还会被从中间劈开），已在 `applyText` 按「结算并回该来源**最后一条**文本条目」修掉：结算与该条目文本对账（不再拿 `…:-1` 的交付账当 previous 而重复入账），新增用例「结算交付（index < 0）与该来源已流出正文并成同一条」。② 评审核对无「该并没并 / 不该并却并」的其它路径（notice / shell / user 两侧 block 都是 undefined；工具批被 calls/results 判据排除，与 `toolAt` 对称）。③ 指出我的注释不准确（回放文本**是**带 index 的）——已改。
  **未采纳进本批次（另立条目 22）**：`index` 的三四套来源互不一致（实时线 = 宿主 index、结算 = -1、`deliverBufferTail` 每次调用从 0 起逐行递增、replay 按聚合 run 递增）→ 同一逻辑块经不同路径会二次入账成新条目；`deliverBufferTail` 的逐行 index 让「跨调用的两条辅助行」仍会粘；`joinedLastTextBySource` 节内不去重（`/copy` 可能拼成「甲乙甲乙」）；`toolAt` 收紧后同节多批仍并成一批（要分离需批身份）。
- 自行核对的结论（同「实现记录」的复核段）：恢复路径按块聚合 ✓；无块身份的路径口径不变 ✓；`toolAt` 收紧后同节多批各自成条（旧行为是并成一个 item，属**有意的口径修正**：批之间没有配对语义）。

## 收尾

- **关闭**：三条（〈辅助行独立成段〉〈同节内「辅助行 → 工具调用」顺序会让辅助行消失〉〈同一步内「工具调用前后的正文」被粘成一行〉）2026-10-10 完成——接取时标〔进行中〕，本次提交内按流程从 `TUI/docs/BACKLOG.md` 移除。
- **回写文档**：`TUI/docs/DESIGN.md` 未提「按来源归并」，无需改；`TUI/docs/SPEC.md` 的拼行口径讲的是渲染层，未涉及节内归并，无需改。口径落在代码注释与 `pipeline-sections.test.ts` 的文件头契约。
- **遗留 / 已知**：`final` 粒度仍按节（工具调用前后的正文在 final 节里会**都**进会话区；旧路径只让后一块进）——不属本三条的期望，若需要另立条目；`replay.ts` 的块聚合口径未动。
- **归档**：本文件自 `TUI/docs/implementation/` 移入 `TUI/docs/archived/`。
- **提交链**：实现 + 测试 `3f14bd1` → 关闭归档 `d2c552b` → 审阅回归修复（结算并回最后一条 + 用例 + 注释纠正 + 新条目 22）。
