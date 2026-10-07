# 状态列 Goal 块改为「首逻辑行 + 完整折行」（接取条目：`TUI/docs/BACKLOG.md`「状态列 Goal 块改为「首逻辑行 + 完整折行」（撤销 1 行截断）」）

状态：实施（待验证收尾）　　开启：2026-10-07　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。**前置** = 同日的首轮落地（`TUI/docs/archived/2026-10-07-goal-objective-one-line.md`）。

## 目标

用户 2026-10-07 二次裁定纠正首轮口径：**「第一行 / 第一句」指逻辑上的总结**——排版出来可能不止一行，**行数由状态列宽度决定**；不是「无论多少内容都只显示一行」。本条把显示口径改成「首个**逻辑行** + 按列宽完整折行、不截断」，并把「一句概括」的**字数约束挪到起草侧**（`goal-contract` 限首句 ≤40 显示列，见 `docs/implementation/2026-10-07-goal-summary-width-limit.md`）。

## 决策（2026-10-07 用户二次裁定）

**D1｜取哪个「行」** → objective 的**首个非空行**即「逻辑上的第一行 / 概括句」（作者写的第一个逻辑行），状态列只显示它。

**D2｜怎么排版** → 该逻辑行按状态列正文宽**完整折行**：1 行还是 3 行由**宽度与内容**决定，**不截断、不加 `…`**（撤销首轮的「宽列恒 1 行 / 窄列 ≤2 行 + `…`」）。

**D3｜长度约束放在起草侧** → 显示层不再做长度兜底；「一句话概括」的字数由起草方（`goal_contract_draft`）把关：首句 ≤40 显示列。理由：显示层截断会丢信息且与「逻辑行」语义冲突，约束应落在作者能控制的地方。

**D4｜历史行不变** → 历史（旧）goal 行仍**全文折行**（与首轮一致）。

**已知代价**：若某个 goal 的首行本身很长（未经起草侧约束，例如宿主 `create_goal` / `/goal` 建的、或旧 goal），状态列会按宽度折出较多行——这是 D2/D3 的自觉取舍（宁可多占两行，也不静默截断）。

## 规划（计划改动文件清单）

1. `TUI/src/app/layout.ts`：`goalObjectiveRows` 去掉 `GOAL_OBJECTIVE_WIDE_WIDTH` 与 `fitHead` / `truncateToWidth` 截断分支，改为 `wrapLine(首个非空行, 正文宽)`。
1. `TUI/tests/status-column.test.ts`：改写首轮那 4 条按「1 行 / 2 行上限」写死的用例为「折行、无 `…`、末字可见、行数随宽度变化」。
1. `TUI/docs/SPEC.md` §15.1、`TUI/docs/DESIGN.md`（`goal/change` 渲染列）、`TUI/README.md`：按 D1-D3 回写。
1. `TUI/docs/BACKLOG.md`：条目〔进行中〕→ 关闭时移除（余下条目重编）。
1. 本追踪文档：建 → 关闭时移入 `TUI/docs/archived/`。

## 实现记录

- `TUI/src/app/layout.ts`：`goalObjectiveRows` 瘦身为「取首个非空行 + `wrapLine(body, width)`」；删除 `GOAL_OBJECTIVE_WIDE_WIDTH` 常量与截断分支（空 / 全空白仍回落 `（空目标）`，`phase=complete` 的灰 + 删除线不变）。`goalHistoryRows` 未改。
- `TUI/tests/status-column.test.ts`：改写为 4 条新断言口径——「当前 goal 只显示首个逻辑行（完整折行、不截断，断言末字 `（首行结尾）` 可见且无 `…`）」、「行数由列宽决定（66 列首行：正文 19 → 4 行 / 正文 39 → 2 行）」、「首个逻辑行未超宽时只占 1 行」、「多行 objective 只取首个非空行（无 `…`）」；折叠用例（历史旧 goal 撑高）与历史行口径用例保持。
- `TUI/docs/SPEC.md` §15.1、`TUI/docs/DESIGN.md`、`TUI/README.md`：改为「首个**逻辑行** + 按列宽完整折行、不截断；字数在起草侧由 goal-contract 限为 ≤40 显示列」。

## 测试与证据

- `npm run test:tui -- status-column.test.ts`：**26 pass / 0 fail**。
- `npm run check`（全包 `tsc --noEmit`）：exit 0；`npm run build` exit 0；`npm run test`（全仓各包并行）全绿；`npm run demo -- --smoke` → `SMOKE_OK`（exit 0）。
- **构建产物直测**（`tmp/goal-wrap-probe.mjs`，跑完即删）：`WRAP_PROBE_OK` —— 长首行在正文 39 列折 **3 行**（末字「（首行结尾）」可见、无 `…`、不含第二个逻辑行）；66 列首行在正文 19 列折 **4 行**、正文 39 列折 **2 行**；短首行恰 1 行；历史旧 goal 行仍折行。
- 待人工：真机 `dsh --profile fff` 目视（长首行按列宽折行、无 `…`；`/goal` 读全文）。

## 收尾

- 条目「状态列 Goal 块改为「首逻辑行 + 完整折行」」：完成 → 从 `TUI/docs/BACKLOG.md` 移除（余下条目重编号、`来源` 注记同步）。
- 起草侧字数上限（`goal-contract`）属项目级条目，见 `docs/archived/2026-10-07-goal-summary-width-limit.md`。
- 本文件移入 `TUI/docs/archived/`；`tmp/goal-wrap-probe.mjs` 已删。
