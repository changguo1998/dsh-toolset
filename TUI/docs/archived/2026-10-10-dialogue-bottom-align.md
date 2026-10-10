# 会话区内容不足时贴底（接取条目：`TUI/docs/BACKLOG.md`「会话区内容不足时贴顶（应贴底，空白留上方）」）

状态：关闭　　开启：2026-10-10　　关闭：2026-10-10
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

会话区内容短于 pane 可视高度时，内容**贴底**（空白留在上方），与回合区口径一致；内容超出视口时行为完全不变（滚动、扩窗、排队块）。

## 调研

- 现状（条目原文 + 代码走读）：回合区已贴底（`layout.ts:1448` 的 `topPad = activityH - act.length`，`:1500` 按 `rr - topPad` 取行），会话区**贴顶**——`layout.ts:1482-1483` 的 `dialogueRowAt(rr)` 与 `:1491` 的 `dialoguePaneSegs(rr)` 都直接取 `dialogueRows[vp.start + rr]`，内容短于 `viewportH` 时把空行留在后面。
- 视口模型的既有不变量（不能动）：
  - `maxTop = max(0, dialogueRows.length − viewportH)`（`:1364`）——内容不足时 `maxTop = 0`、`topIdx = 0`、`vp = {start: 0, end: 内容长}`；
  - 滚动位置按「段键 + 段内行」表达（`dialogueTop`），与**屏幕行**无关；`report.dialogueTopIdx` / `dialogueUserRows` 供 PgUp/PgDn 计算目标段（`index.ts:2464` 的 `userRowJump`），不做屏幕行换算 → 顶部补白不影响它们；
  - 排队块行固定在 `rr >= viewportH`（`:1487-1489`），`viewportH = dialogueH − 排队块行数`（`:637`）——补白只在视口内，排队块位置不变。

## 决策

- **D1 落点**：`layout.ts` 的会话区行放置层——新增 `dialoguePadTop = max(0, viewportH − dialogueRows.length)`，`dialogueRowAt` / `dialoguePaneSegs` 的行号映射改为「先扣补白，再取 `vp.start + 行`」；`rr < dialoguePadTop` → 空行。
- **D2 只补白、不改模型**：`maxTop` / `topIdx` / `vp` / 段表 / 报告字段一律不动（内容超出视口时 `dialoguePadTop = 0`，逐字节同现状）。
- **D3 折叠占位行（「更早回复已折叠」）跟随整体贴底**：它已是 `dialogueRows` 的第一行，补白后落在内容块顶部。构造该组合需要「更早回合被窗口丢弃且剩余内容短于视口」，属罕见场景；因它与内容同属一个视口序列，不单独特殊化（YAGNI）。
- **D4 与回合区口径对齐**：命名与算法照 `topPad`（`:1448`/`:1500`），避免两区各写一套。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout.ts`（`dialoguePadTop` + 两处行号映射）。
- tests：`TUI/tests/`（帧断言：短内容 + 高终端 → 会话区内容紧贴 pane 底边、其上方为空；内容超视口 → 与现状逐行相同；排队块 / 滚动 / 扩窗用例不回归）。若冻结基线 `tests/fixtures/focus-frame-legacy.json` 因本行为变更失配，用既有脚本重跑并逐行核对差异只来自补白。
- 文档：`TUI/docs/BACKLOG.md`（进行中 → 完成并移除）；`TUI/docs/SPEC.md`（会话区行放置口径一行，若有对应小节）。

明确不做：不改滚动 / 窗口 / 段键模型；不动排队块与折叠占位行的语义；不为该行为加开关。

## 实现记录

- 2026-10-10：
  - `layout.ts`：`vp` 之后新增 `const dialoguePadTop = Math.max(0, viewportH - (vp.end - vp.start));`；`dialogueRowAt` 改为 `rr >= dialoguePadTop && rr < viewportH ? dialogueRows[vp.start + rr - dialoguePadTop] : undefined`；`dialoguePaneSegs` 的视口分支加 `if (rr < dialoguePadTop) return []`，取行与 `vp.end` 判据同时扣补白。排队块分支（`rr >= viewportH`）未动。
  - **按视口实有行数算补白**（实现前审阅加固）：初版用 `viewportH - dialogueRows.length`，滚动中（`topIdx > 0` 且内容总长 < viewportH 不成立时才为 0）会与「贴底补白」冲突；改用 `vp.end - vp.start` 后，滚动窗口下补白恒为 0。
  - 期望类测试同步：`tests/layout4.test.ts` 的「四区顺序与高度正确」把「历史区内容在 `top[2]`」放宽为「在顶部区域内任意一行」（口径变更）；冻结基线 `tests/fixtures/focus-frame-legacy.json` 用 `scripts/freeze-focus-frame.mts` 重跑（15 场景，w60 的 11 个场景各下移 pad 行，w20 的 4 个场景无变化——窄窗内容本就超出 pane）。

## 测试与证据

- 新增用例：
  - `tests/pipeline-frame.test.ts`「会话区内容不足时贴底」（交付驱动）：短内容 + 60x30 → 会话 pane 内补白行（剥掉 `│` 与空白后为空）在**上方**、pane 最后一行是正文（贴底）、正文行紧邻 Turn 分隔行；内容超视口（5 回合 60x24）→ pane 首行即内容（补白为 0，与改动前一致）。
  - `tests/layout-horizontal.test.ts`「会话区内容底部对齐（两种排列一致）」：与既有活动区姊妹用例并列，`auto` / `vertical` 两种排列都断言最新一行贴底、首行不是内容，并读帧报告断言 `dialogueMaxScroll === 0`、`dialogueTopIdx === 0`（补白不影响视口模型）。
- 冻结基线核对（重跑后逐行比对，脚本化）：15 个场景**行数不变**、每帧的**非空内容行序列逐字符相同**（内容整体下移 pad 行、`╌` 填充行随移）；唯一例外 `panel-jobsPanel@w60` 是「左侧任务面板行与右侧会话行原本共处一行、下移后不再同行」——逐行打印核对：会话内容 `第一行` / `┃` / `中间输出一段` 由第 2-4 行移到第 5-7 行（恰 3 行 = 该场景补白），任务面板行（8 行起）逐字节未变。
- 全量：`npm test`（TUI）**1426 / 1426 通过**（改动前 1424 + 本条目 2）；`npm run check` 干净；`npm run build` 干净。
- 未做：真机目视（会话内无法起真机）；PgUp / PgDn / Home / End 在「短内容」下的实跑按键序列未做（审阅建议补）——帧报告字段已断言为 0 余量，按键路径由既有 `scroll-position` / `app.test` 用例覆盖。

## 审阅记录

- **实现前审阅**（子代理，只读 + 实跑）：结论「无阻塞性问题」。**采纳**：① 补白改用 `viewportH - (vp.end - vp.start)`（原写法在滚动中会产生错误补白，见「实现记录」）；② 用例落点选 `tests/layout-horizontal.test.ts` 的姊妹用例（与活动区底部对齐并列，覆盖两种排列）+ 帧报告断言。**确认无需改**：`maxTop` / `topIdx` / `vp` / 段表 / `report.*` 不动；4 个调用点（横向补齐字符、横向左 pane、纵向对话区、`ruleRow` 判定）都应随内容下移；报告字段消费方（`userRowJump`、Home/End）在内容索引空间，与屏幕行无关。
- **审查给出的已知边界**（不属本条目范围，未处理）：内容长度达到视口高的瞬间（如粘贴多行）补白由 `k` 跳到 0，内容从贴底变贴顶并滚掉最旧一行（边界跳变属预期语义）；面板打开时活动区顶部对齐与会话区贴底观感不对称；`pad > 0` 时折叠占位行（DIALOGUE_MORE）随块贴底（D3 已记录）。
- **收尾前审阅**（子代理，只读 + 侧证）：结论「无阻塞性问题」，并**证明**了补白前提——`indexOfTop` 四条返回路径都把 `topIdx` 夹在 `[0, maxTop]`，故 `内容 ≥ 视口 ⇒ vp.end − vp.start ≡ 视口高 ⇒ 补白恒 0`（含「内容恰等于视口高」），`内容 < 视口 ⇒ topIdx = 0 且补白 > 0`；排队块分支在补白判断之前、横排 `actColOffset` 不受影响；全仓无「帧行 → 内容行」反向映射（`/copy` 走节模型、`dialogueUserRows` 是内容模型行号）→ 无漏扣补白处。**采纳的修正**：① `layout-horizontal` 用例里 `m.mode === "horizontal" ? m.titleRows : m.titleRows` 是死三元（两种排列实际没分别跑到）→ 改为遍历 `vertical` / `horizontal` 并断言 `m.mode === placement`，补白行数与内容原位按帧报告精确断言；② `layout4` 的放宽改为**收窄到会话 pane 行范围**（`top.slice(2, 2 + dialogueH)`）+「内容上方为补白」；③ 补「排队块 + 短内容」用例（排队行仍钉 pane 底、视口高 = pane 高 − 排队行数）；④ 补**补白不变量扫描**（1..6 回合跨越「短 → 超视口」：补白行数恒 = `max(0, 视口高 − 内容行数)`，覆盖「内容恰等于视口高」的零回归边界）；⑤ SPEC 措辞由「与活动区 topPad 同口径」改「同语义」（活动区按切片长度、会话区按视口交集，效果等价、表达式不同）。
- **未验证**（审阅说明）：其沙箱内无法实跑测试（`npx tsx` 触发只读 npm 缓存报错），故其结论来自代码走读 + git 侧冻结基线比对；本任务已在本地实跑全量（1426 通过）并逐场景核对基线下移行数。

## 收尾

- **关闭**：条目「会话区内容不足时贴顶（应贴底，空白留上方）」2026-10-10 完成——接取时标〔进行中〕，本次提交内标「完成」并从 `TUI/docs/BACKLOG.md` 移除（编号留到本轮全部关闭后统一重编）。
- **回写文档**：`TUI/docs/SPEC.md`「横向排列·拼行」补一句会话 pane 恒底部对齐（公式 + 「补白行不属分隔行」+ 回归用例）；`TUI/docs/DESIGN.md` / `TUI/README.md` 无需改（命令面与架构无变化）。
- **遗留 / 已知边界**（不属本条目范围）：内容长度由 `< 视口高` 变为 `≥ 视口高` 的瞬间补白一步归零（内容上跳一行，属贴底语义，与活动区既有行为一致）；面板打开时活动区顶部对齐与会话区贴底的观感不对称；有折叠占位行且内容短于视口时占位行落在补白之下。
- **归档**：本文件自 `TUI/docs/implementation/` 移入 `TUI/docs/archived/`。
- **提交链**：实现 + 测试 + 基线重跑 + SPEC → 收尾提交（归档 + BACKLOG 移除）。
