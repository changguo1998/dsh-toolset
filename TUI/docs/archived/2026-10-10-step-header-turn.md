# step 分隔线补回合号（接取条目：`TUI/docs/BACKLOG.md`「step 分隔线补回合号：`时间 回合号 步骤号`」）

状态：关闭　　开启：2026-10-10　　关闭：2026-10-10
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

step 分组头由 `hh:mm:ss #M` 改为 `hh:mm:ss ⇆N #M`（**时间 → 回合号 → 步骤号**），回合号沿用回合分隔线已用的 `⇆` 标记、步号沿用 `#M`；任一片段缺失按既有省略口径。渲染形制为 `╌╌ hh:mm:ss ⇆N #M ╌╌…`。

## 调研

- 生产者与渲染点：
  - `layout/tool-line.ts:48-51` `stepHeaderLine(step, time)` → `hh:mm:ss #N`（时间缺 → `#N`）；
  - `layout/pipeline/rows.ts:422`（`itemLines` 的 `step-head` 分支，生产渲染路径）调用它，`PaneItem` 已带 `turn`（`panes.ts` 由 `declaredSteps` 的 `"turn:step"` 键解析，`headUpTo` 处 push）；
  - `state.ts:2340`（状态层把 step 头写进缓冲行，供旧路径与回放）调用它，`step` action 已带 `turn`（`state.ts:2858`）；
  - 旧路径（`build-box.ts` 的 `tool` 分支）按缓冲行文本原样渲染，改文本即改形制。
- 解析侧（**必须不回归**）：
  - `layout/pipeline/replay.ts:26-29` `stepOf(text)`：正则 `/(?:^|\s)#(\d+)\s*$/` 以**行尾 `#N`** 锚定——回合号插在 `#` **之前**，尾锚仍成立，新旧文本都能解出步号（`index.ts:514` 的按键判据、回放的 step 识别都依赖它）；
  - `layout/content-rules.ts:104` `isStepHeader(text)`：`/^(?:\d{2}:\d{2}:\d{2} )?#\d+$/` **需要放宽**——多出 `⇆N ` 段后必须仍识别（`build-box.ts:258/309` 用它做分组与 `/verbose step` 档位判据）；
  - 全仓没有从 step 头文本反解**回合号**的消费者（`grep ⇆` 只有回合分隔线的生产与渲染）——本条目只加显示片段。

## 决策

- **D1 形制**：`[时间, ⇆回合号, #步号]` 三段按序拼接、空格分隔；缺项即省略（时间缺 → `⇆N #M`；回合号缺 → 时间 + `#M`；两项都缺 → `#M`，与既有「缺时间只出 `#N`」同口径）。
- **D2 签名保序**：`stepHeaderLine(step: number, time?: number, turn?: number)`——前两个参数位置不变（既有 3 处调用与测试只补第三参），避免无谓改名扩散。
- **D3 `isStepHeader` 放宽**：`/^(?:\d{2}:\d{2}:\d{2} )?(?:⇆\d+ )?#\d+$/`（时间与回合号各自可选、顺序固定）。
- **D4 `stepOf` 与回放口径不动**：尾锚正则对新旧文本都成立；回放的回合号来自 `scope.turn` / `declaredSteps` 键，与文本片段同源，不做文本反解（避免两套真相）。
- **D5 明确不做**：不改回合分隔线（`⇆N`，无步号）；不给恢复路径的 step 概要行（P9）加回合号（其形制是 `hh:mm:ss #N ╌╌ 工具名×次数`，属另一条）；不动 `stepOf` 正则。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout/tool-line.ts`（`stepHeaderLine` 增 `turn` 段）、`TUI/src/app/layout/pipeline/rows.ts`（step-head 渲染传 `item.turn`）、`TUI/src/app/state.ts`（step 头落行传 `action.turn`）、`TUI/src/app/layout/content-rules.ts`（`isStepHeader` 放宽）。
- tests：`TUI/tests/step.test.ts`（`stepHeaderLine` 形制矩阵 + 缺 time 回退用例的期望形制）、`TUI/tests/content-rules.test.ts`（新形制识别 + 旧形制仍识别）、`TUI/tests/pipeline-frame.test.ts` / `pipeline-equivalence.test.ts`（旧缓冲侧构造补 turn，保等价）、必要时 `TUI/tests/pipeline-panes.test.ts`（step 头项带 turn 的契约）。
- 文档：`TUI/docs/SPEC.md`（§3.1 内容元素映射表里的 step 分组头形制行）、`TUI/docs/BACKLOG.md`（进行中 → 完成并移除）；**另需在条目 3 的追踪文档与 BACKLOG 注记里写明**：演示自检的 `step-header` 期望正则（`/\d{2}:\d{2}:\d{2} #1 /`）在本次形制变更后必然失配，收口时改为 `hh:mm:ss ⇆N #M`（该条目已阻塞在 7/10/11/18）。

明确不做：不改 `stepOf`；不动 step 概要行；不为新旧形制加开关（旧缓冲行文本是历史数据，渲染按原文本原样显示，无需兼容分支）。

## 实现记录

- 2026-10-10：
  - `tool-line.ts`：`stepHeaderLine(step, time, turn?)` 按「时间 → 回合号 → 步号」拼接，`filter` 掉缺项；**回合号 `0` / 负数按缺项省略**（实现前审阅指出：宿主 `data.turn ?? 0`、回放 scope 起始 0 都会给出 0，直接拼会渲染出无意义的 `⇆0`）。
  - `rows.ts`（step-head 渲染）传 `item.turn`；`state.ts`（step 头落缓冲行）传 `action.turn`——两条生产路径同源。
  - `content-rules.ts` 的 `isStepHeader` 放宽为 `/^(?:\d{2}:\d{2}:\d{2} )?(?:⇆\d+ )?#\d+$/`（新旧形制都认）；`replay.ts` 的 `stepOf` **未动**（尾锚 `#M` 使回合号插在 `#` 前不影响回解）。
  - 期望类测试同步：`tests/step.test.ts`（B3 系列缓冲行文本 + 形制矩阵 + 缺 time 回退正则）、`tests/layout4.test.ts`（`stepHead(n, turn = 1)` 助手 + 用例名）、`tests/content-rules.test.ts`（四态）、回放侧构造助手（`pipeline-frame` / `pipeline-equivalence`）补 `delivery.turn`。
  - 文档/注释口径同步：`docs/SPEC.md`（step 分组头形制行）、`docs/DESIGN.md`（三处）、`state.ts` / `panes.ts` / `replay.ts` / `content-rules.ts` 注释。P9 step 概要行的 `hh:mm:ss #N` 形制**未动**（属另一条）。

## 测试与证据

- 新增/更新断言：形制矩阵 6 条（`03:04:05 ⇆2 #3` / `⇆45 #123` / 24 小时制 / 缺时间 `⇆3 #7` / 缺回合号 `03:04:05 #3` / 全缺 `#7`）+ `turn=0` 与负数省略 2 条；`stepOf` 回解 4 条（新形制 / 缺时间新形制 / 旧形制 / 全缺）；`isStepHeader` 四态（新形制、缺时间新形制、旧形制、`step 2` 不认）。
- 全量：`npm test`（TUI）**1426 / 1426 通过**；`npm run check` 干净；`npx tsc --noEmit --noUnusedLocals` 0 条。
- 帧级证据：`tests/layout4.test.ts` 的 step 分组头帧断言用新形制 `╌╌ 03:04:05 ⇆1 #123 ` 通过（该路径经「缓冲回放 → 六步流水线」，覆盖 `rows.ts` 的 `item.turn`）。
- **旁证（不是本条目引入的问题）**：条目 4（会话区贴底）落地后演示自检 `policy-notice` 由通过转失败（`/policy never` 提示的折行续行丢失）；2×2 A/B 判据表明与 step 头形制无关（换回条目 4 前的 `layout.ts` 即恢复），已按流程另立条目「会话区贴底后，演示自检的 `/policy never` 提示尾部丢失」，见 BACKLOG。
- 未做：真机目视（会话内无法起真机）。

## 审阅记录

- **实现前审阅**（子代理，只读 + 实跑）：结论「能落地，无阻塞性问题」。核对：`PaneItem` 的 step-head 确实带 `turn`（`panes.ts` 由 `declaredSteps` 的 `turn:step` 键构造）、`state` 的 `step` action 带 `turn`、三条渲染路径同源（同一 `stepHeaderLine`，回放只转交付不重建文本）；`stepOf` / `isStepHeader` / `isToolCall` / `build-box` step 分支 / 恢复路径 / 宽度类测试逐项实核**都不坏**。**采纳**：① `turn <= 0` 按缺项省略（原设计只判 `undefined`）；② 补 `stepOf` 对新形制的回解断言（条目验收明确要求，原计划只补旧形制）；③ 补 `turn=0` / 负数用例；④ 指出 `docs/DESIGN.md` 三处仍写旧形制（本任务已同步）；⑤ 指出 `demo/main.ts` 的 `step-header` 正则在形制变更后必然失配——该文件属条目 3 的落点（其自检已因真实缺陷阻塞），已在条目 3 的追踪文档与 BACKLOG 注记里写明「收口时按新形制更新正则」。
- **收尾前审阅**（子代理，只读 + 实跑 `tests/step.test.ts` 10/10）：结论「无阻塞性问题，可收尾」。逐条核对：三段拼接与缺项省略、缺时间不留前导空格、两处调用点的 turn 来源（`action.turn` / `item.turn`）均为必填字段、`isStepHeader` 只加**可选** `⇆N` 段不会误吞工具行与回合分隔线（后者缺尾部 `#M`）、`stepOf` 尾锚未动且新旧形制回解正确。**采纳**：补护栏断言 `!isStepHeader("03:04:05 ⇆3")`（回合分隔线标签不得被认成分组头）。**未采纳（说明理由）**：帧级断言已由 `tests/layout4.test.ts` 的 `stepHead(n, turn = 1)` 系列覆盖（其断言的是渲染后的帧文本，本任务内实测通过）；新旧 step 头混排的等价性由 `pipeline-equivalence` / `pipeline-frame` 的回放侧构造补 `delivery.turn` 覆盖。**审查记录的已知边角（非本次回归）**：`turnHeaderLine` 对 `turn = 0` 仍出 `⇆0`（与 step 头的新口径不一致，纯外观、既有行为）；多行工具结果的某个物理行若恰为 `⇆3 #2` 会按分组头渲染（旧正则同款边角）。

## 收尾

- **关闭**：条目「step 分隔线补回合号：`时间 回合号 步骤号`」2026-10-10 完成——接取时标〔进行中〕，本次提交内标「完成」并从 `TUI/docs/BACKLOG.md` 移除（编号留到本轮全部关闭后统一重编）。
- **回写文档**：`TUI/docs/SPEC.md`（step 分组头形制行：改为 `hh:mm:ss ⇆N #M` + 缺项省略 + 两标记的分工）、`TUI/docs/DESIGN.md`（事件映射表 / 分组头说明 / tool 行组装三处）；`TUI/README.md` 无需改。
- **遗留**（不属本条目，已另立条目）：演示自检 `step-header` 的正则需按新形制更新（随条目 3 收口）；条目 4 引入的 `policy-notice` 回归（新条目）。
- **归档**：本文件自 `TUI/docs/implementation/` 移入 `TUI/docs/archived/`。
- **提交链**：实现 + 测试 + 文档同步 → 收尾提交（归档 + BACKLOG 移除条目）。

## 测试与证据

（待补）

## 审阅记录

（待补）

## 收尾

（待补）
