# 交付窗口折叠改为视口容量驱动（接取条目：`TUI/docs/BACKLOG.md`）

状态：关闭　　开启：2026-10-10　　关闭：2026-10-10
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

会话区**还有空位就不折叠**：内容没占满 pane 视口（`dialogueMaxScroll === 0`）且仍有未物化的更早回合组时，继续按 `WINDOW_GROW_STEP` 物化；装不下才折叠并出 `...(更早回复已折叠)` 占位行。长会话仍受视口约束（不一次性全量物化，避免排版量爆炸）。

## 调研

- 折判决据现状：`frame.ts` 的 `windowSections(sections, groups)` 按**尾部 N 个回合组**取窗口，`groups` 来自 `state.windowGroups`（初值 `DIALOGUE_KEEP_REPLIES = 3`）；`dropped > 0` 时 `layout.ts` 在会话区顶部插 `DIALOGUE_MORE`（`...(更早回复已折叠)`）占位行。
- 扩窗现状：只有**按键路径**（`scrollDialogueBy` / Home / PgUp）与「上滚时尾部新增组把窗口顶挤出」的 `syncDialoguePos` 分支会扩窗；**贴底**（`dialogueTop === null`）时窗口恒为初值 → 2 回合的短会话也折叠（条目里探针实测：60x24、2 回合、7 行里就出现占位行，同时活动区还空着 9 行）。
- `FrameScrollReport`（`paneMaxes()` 回填）已有 `dialogueMaxScroll` / `dialogueTotal` / `dialogueViewportH`，但**没有** `dropped` —— 补窗需要知道「还有多少没物化」。

## 决策

- **D1 折判决据留在窗口层，补窗决策交给 App**：`windowSections` 不动（仍按组数取窗口）；App 在贴底分支按「容量 + 剩余丢弃组数」决定是否继续扩窗。理由：容量只有出帧后才知道（`dialogueMaxScroll`），而窗口层是纯函数。
- **D2 `dropped` 进 `FrameScrollReport`**：布局层已经在算 `built.dropped`（占位行判据），一并回填给 App 即可，不新增计算。
- **D3 补窗步长与上限沿用既有常量**：每轮 `+WINDOW_GROW_STEP`、上限 = `sectionGroupCount(...)`（全量）；条件里带 `next < groups`，故**不会超发**，也不会全量物化长会话（一旦装不下 `dialogueMaxScroll > 0` 立即停）。
- **D4 只作用于贴底**：用户已上滚（`dialogueTop !== null`）时位置优先，既有「按新增组数撑住视口顶」的口径不变——扩窗只在视口上方插段、画面不动。
- **D5 不自激**：每轮 `windowGroups` 严格增加且以 `groups` 为上界；`paint()` 是「标脏 + 同 tick 合帧」，故多轮补窗最多追加有限次出帧（实测短会话 1-2 轮即达全量）。
- **D6 不改**：`DIALOGUE_KEEP_REPLIES` 的初值语义（仍是「初始窗口」）、Home/End 与滚键的窗口口径、活动区窗口。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout.ts`（`FrameScrollReport.dropped` + 回填）、`TUI/src/app/index.ts`（贴底补窗；`paneScrollMax` 初值补字段）。
- tests：`TUI/tests/app.test.ts`（两条容量用例）、`tests/layout-horizontal.test.ts` / `tests/layout4.test.ts` / `tests/pipeline-frame.test.ts`（报告字面量补字段）。
- 文档：本文件；`TUI/docs/BACKLOG.md`；必要时 `TUI/docs/DESIGN.md`（渐进窗口口径一句话）。

明确不做：活动区窗口容量驱动（条目只讲会话区）；`bench` 阈值（既有口径：只报告不设阈值）。

## 实现记录

- 2026-10-10：
  - `layout.ts`：`FrameScrollReport` 增 `dropped: number`（注释说明「> 0 = 还有更早内容未物化」）；`report.dropped = built.dropped` 回填。
  - `index.ts`：`syncDialoguePos()` 的贴底分支新增容量补窗（`dropped > 0 && dialogueMaxScroll === 0 && next < groups` → `min(groups, next + WINDOW_GROW_STEP)`），有变化则写 state 并 `paint()`；`paneScrollMax` 初值补 `dropped: 0`。
  - 测试报告字面量补字段：`tests/app.test.ts` / `tests/layout-horizontal.test.ts`（2 处）/ `tests/layout4.test.ts`（2 处）/ `tests/pipeline-frame.test.ts`。
  - 新用例（`tests/app.test.ts`）：① 6 组单行 + `rows=40` → `windowGroups` 补到 6（全量）且帧里**无**「更早回复已折叠」；② 12 组 × 3 行 + `rows=30` → `windowGroups` 保持默认 3 且 `paneScrollMax.dropped > 0`（长会话不被一次性全量物化）。

## 测试与证据

- 全量：`npm test`（TUI）**1443 / 1443 通过**（改动前 1441 + 本条目 2 条）；`npm run check` 干净。
- 排版量（验收项 ④）：`npm run bench`（60x24 语料）——cold 3.87 ms / warm 3.71 ms / incremental 12.35 ms（cache on：0.30 / 0.14 / 2.32 ms）。与改动前同量级（bench 只报告不设阈值，无退化迹象）。
- 行为证据（验收项 ①②③）：短会话（内容远小于视口）→ 全量物化、无占位行；长会话（3 组即超视口）→ 停默认窗口、`dropped > 0`（占位行由布局层据此生成）；补窗上界 = 全量组数（`next < groups` 条件保证不超发）。
- 未做：真机目视（会话内无法起真机）；活动区窗口（不在条目范围）。

## 测试与证据

（待补）

## 审阅记录

- **收尾前审阅**（子代理，只读，7 次工具调用）：结论「**无阻塞性问题**」，并逐条核对：`paint()` 只标脏 + 微任务合帧 → 补窗链**不自激**、终止条件完备（`next` 单调增 + `min(groups,…)` 封顶 + 装不下即停）；上滚分支完全走原路径（零额外排版）；`paintExitNotice` 期间 `disposed=true` → `paint()` 立即返回；`dropped` 与 `dialogueTotal` 的 +1/−1 不与增长判据互搏。
  **采纳并已改**：审阅指出 `windowSections` 返回的 `dropped` 其实是**节下标**而注释写「回合组数」——而 App 侧 `next < groups` 本就等价表达「还有未物化的组」，故**直接删掉新增的 `report.dropped` 字段**（连带撤掉 5 处测试字面量的 `dropped: 0`），并把 `frame.ts` / `layout.ts` 里 `dropped` 的注释改成准确口径（节下标、只当布尔用）。
  **未采纳进本条目（另立条目 24）**：补窗一帧一步（长会话逐段展开、`End` 后重播），建议 scratch 试算一次到位；`groupCount` 会话切换未重置会让 `grew` 一次性偏大（过度物化，无害）。
- **自检**（审阅返回前先做的核对）：补窗每轮 `windowGroups` 严格递增且以 `sectionGroupCount` 为上界 → 有限轮收敛；`paint()` 走「标脏 + 同 tick 合帧」，同一 tick 内多轮补窗只多出有限次渲染；贴底分支与上滚分支互斥（`dialogueTop === null` 判断在前），上滚口径未动。

## 收尾

- **关闭**：条目「交付窗口折叠改为视口容量驱动（不在还有空位时提前折叠）」2026-10-10 完成——接取时标〔进行中〕，本次提交内按流程从 `TUI/docs/BACKLOG.md` 移除。
- **回写文档**：`TUI/docs/DESIGN.md` 的渐进窗口口径补一句「贴底时按视口容量补窗」；`TUI/docs/SPEC.md` 无需改（占位行形制未变）。
- **遗留 / 已知**：活动区不做容量驱动（条目只讲会话区）；`DIALOGUE_KEEP_REPLIES` 仍是初始窗口值（语义未变）。
- **归档**：本文件自 `TUI/docs/implementation/` 移入 `TUI/docs/archived/`。
- **提交链**：实现 + 测试 + 文档 → 收尾提交（归档 + BACKLOG 移除条目）。
