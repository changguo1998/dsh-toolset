# goal 状态行补 `activation`（接取条目：`docs/BACKLOG.md`「goal 状态行只显示 `phase`，需同时显示 `activation`（用状态符号）」）

状态：完成　　开启：2026-10-04　　关闭：2026-10-04

## 调研（已核）

- 渲染点：`TUI/src/app/layout.ts:1192-1199` 的 goal 块 head 行——当前 `seg("Goal ", blue) + seg(current.goal.phase, GOAL_PHASE_COLOR[phase])`，**直接出 phase 英文词**，无符号、无 activation；`GOAL_PHASE_COLOR`（`:887-892`）已定义 active/complete 绿、paused 黄、blocked **红**（与用户定稿的「blocked 黄」不一致，需改）。历史 goal 行 `:997-1009` 出灰 `<phase>`。
- 数据面：`TUI/src/app/adapter/types.ts:34-40` `GoalSnapshotLike`（id/revision/objective/phase/blockedReason?/maxGoalRounds）**无 activation**；`goal/change` 归一化后存 `state.goalBySession`（state.ts:204-224、2205起），selector 取最新快照。
- 宿主面（`@deepseek-ai/dsh-goal`，只读）：activation 是**进程本地**态（`:284` durable projection「activation is deliberately absent」；`:777` 初始 disarmed）；变化时发**事件** `goal/activation-changed`（`:788-803`，载荷含 `activation`）；resume（须人类请求）→ `setActivation(..., "armed")`；重启/恢复 → disarmed。
- ⇒ **可行路径**：TUI 订阅 `goal/activation-changed`（新增 DshEvent + adapter 归一化 + state 按会话存）→ layout 渲染。当前 `TUI/src` 内无 `activation`/`armed` 字样（与条目描述一致）。
- 符号（用户 2026-10-02 定稿）：phase —— `▷` active（绿）/ `∥` U+2225 paused（黄）/ `✓` complete（绿）/ `△` U+25B3 blocked（黄）；activation —— `⟳` U+27F3，armed 绿 / disarmed 灰。取值 phase = active|paused|blocked|complete；activation = armed|disarmed。

## 决策（待审阅）

1. 新增事件 `goal/activation-changed` → `DshEvent` 成员（`goal-activation`，载荷 `{sessionId, goalId?, activation}`，按会话存 `goalActivationBySession`；`goal/change` 的 clear 分支同时清）。
1. head 行改为：`Goal ` + `<phase 符号><phase 词?>` + `<activation 符号>`——**符号 + 词并存**（符号给扫视、词保可读；`docs/STATUS.md` 口径不动）。历史 goal 行不显示 activation（进程本地态只对当前 goal 有意义）。
1. 颜色：phase 四色按定稿（blocked 由红改黄）——**改 `GOAL_PHASE_COLOR`**；activation 用 `armed: green / disarmed: gray`。
1. 未收到 `goal/activation-changed` 时**不显示** activation 符号（无数据不猜；重启后 disarmed 由宿主事件/首次变化驱动）。
1. 测试：三态（armed 绿 / disarmed 灰 / resume 后转 armed——事件序列驱动）+ 反向验证（撤显示 → 必红）；`TUI/docs/SPEC.md` 补符号与颜色口径。
1. 不做：不动宿主包；不改 `docs/STATUS.md`（用户择时更新）；`tmp/symbol-candidates.mjs` 不入库。

## 决策修订（审阅后，2026-10-04）

- **① 数据源**：`goal/change` 的日志事件**不含** activation（宿主 `index.js:838-857` 组包只有 operation/goal/roundsStarted/createdAt/updatedAt）⇒ 只能订阅 `goal/activation-changed`（`:789-803`，仅真变化时发）。(c) 回读 `ctx.goals.get(agent)` 可作加固但**非必需**（v1 不做，记为已知边界）。
- **② 初值（关键修正，选代 4）**：宿主重启后 `setActivation(disarmed)` 与初值相等 → **不发事件**，故「无数据不显示」会让条目动机失效（重启后仍看不出）⇒ 改为**可推导初值**（reducer 落，不在 layout 猜）：
  `phase !== "active" → disarmed`；`active` 且本进程收到过 armed 边 → `armed`，否则 `disarmed`。
  事件规则：create/resume → armed；pause/complete/block/clear → disarmed；edit → **不改**（宿主语义保留 activation）。按 sessionId 隔离。
- **③ 文案**：head 行 `Goal ▷ active ⟳`（符号 + 词并存）；**activation 只对 `phase === "active"` 显示**（其它相位恒 disarmed，显示是噪声）；历史行不显示；既有 `includes("Goal active"…)` 断言不受影响。
- **④ 颜色**：blocked 由红改黄无明文冲突（`turn/end blocked` 已是黄、blockedReason 行也已是黄 tone），但要同批改**文档文案**：`TUI/README.md:147`、`TUI/docs/DESIGN.md:221`（另 `layout.ts:887` 注释）。新用例须**显式断色**（含 blocked 黄）。
- **⑤ 宽度（新发现）**：`⟳` U+27F3 不在 `WIDTH_UNCERTAIN_RANGES`（`TUI/scripts/gen-width-table.mts:88-91`）→ 永远按 1 列且无自校正；建议把 `[0x27c0,0x27ef]` 补进去后重生成 `eaw-table.ts`（序列同批）。
- **⑥ 文档同步清单（补进计划）**：`TUI/docs/SPEC.md:661`、`TUI/docs/DESIGN.md:147/221/404-405`、`TUI/README.md:147`、`layout.ts` 注释、`adapter/dsh.ts` 回放注释。
- **⑦ 测试**：新增 `TUI/tests/goal-activation.test.ts`（reducer 矩阵 + **重启回归**：只有 create(active)、零 activation 边 → 灰 `⟳`）；`status-column.test.ts` 补三态渲染/颜色 + blocked 黄；`adapter.dsh.test.ts` 补事件归一化与非活跃会话丢弃；反向验证 = 撤 layout 符号渲染 → 用例必红。demo/mock（`TUI/demo/mockAdapter.ts:302-340`、`demo/main.ts:441-455`）可选加一条 activation 事件。
- 落地顺序：先事件 + reducer 推导（验收线先绿）→ 再 layout 符号/颜色 → 最后文档与宽度表。

## 规划（下回合实现）

- 计划改动文件清单（**只改这些**）：`docs/BACKLOG.md`（状态）、本追踪文档、`TUI/src/app/adapter/types.ts`、`TUI/src/app/adapter/dsh.ts`（订阅 + 归一化）、`TUI/src/app/state.ts`（新状态 + reducer）、`TUI/src/app/layout.ts`（head 行 + 颜色）、`TUI/docs/SPEC.md`、`TUI/tests/`（新用例 + 既有 goal 用例更新）。
- 验证：`npm run check` + `npm run build` + `npm run test:tui`（反向验证含在内）；根 `npm run check`。

## 探针记录（2026-10-04，实现前）

- **⟳ 宽度表项：不并入本条目**。实测 `cd TUI && npm run gen:width-table`：生成器与检入的 `src/app/layout/eaw-table.ts` **不同步**——仅补一段 ranges 重生成即产生 **229 行** diff（108 insert / 122 delete，区间归并差异），噪声远超本次收益；已 `git checkout` 还原（工作区干净）。⇒ 宽度项（把 `[0x27c0,0x27ff]` 补进 `SYMBOL_UNCERTAIN_RANGES`，注意审阅给的 `[0x27c0,0x27ef]` **不含** U+27F3）**另开条目**：先解决生成器漂移（谁生成、为何不一致），再谈补字符。本条目渲染层按「⟳ 恒 1 列」处理，风险记在 §决策修订⑤。
- 实现仍未开工；落点清单与顺序见上（types/dsh → state → layout → tests → docs）。

## 实现记录（2026-10-04）

- 数据面：`adapter/types.ts` 新增 `GoalActivation` + `DshEvent` 成员 `goal-activation`；`adapter/dsh.ts` 订阅宿主 `goal/activation-changed`（载荷实测 `{sessionId, goal?: {id, revision, activation}}`，`goal` 缺省 = 无当前 goal → 事件不带 `activation`），**不按活跃会话过滤**（切走再切回仍须显原值）；`adapter/dsh.ts` 另补 `GoalActivation` 的类型再导出（`layout.ts` / `state.ts` / 测试都从 `adapter/dsh.ts` 取类型，缺它 `tsc` 报 TS2305）。同文件回放注释补「activation 不在日志里」。
- 状态面：`state.ts` 新增 `goalActivationBySession`（末条边、按会话、不落盘）+ reducer `goal-activation`（无 `activation` = 清记录）+ selector `activeGoalActivation`（仅 `phase === "active"` 有值，无记录 → `disarmed`）；`app/index.ts` 的 action 转发补 `goal-activation`。
- 渲染面：`layout.ts` 新增 `GOAL_PHASE_SYMBOL` / `GOAL_ACTIVATION_SYMBOL` / `GOAL_ACTIVATION_COLOR`，`GOAL_PHASE_COLOR.blocked` 由红改黄；head 行 = `Goal ` + 符号 + phase 词 + （仅 active）` ⟳`；`statusBlocks` / `renderStatusColumn` / `buildTopRegion` 串接 `activation` 参数。
- **更正决策修订③**：「既有 `includes("Goal active"…)` 断言不受影响」不成立——head 行插入符号后文本变为 `Goal ▷ active`，既有 5 处断言实测全红（含列宽 10 的截断断言，实际文本 `Goal ▷ ac`），已按新口径更新。
- 测试：新增 `TUI/tests/goal-activation.test.ts`（5 例：边覆盖 / 清记录 / 门控 / **重启回归**（只有 create、零边 → disarmed）/ resume 序列 + edit 不改 activation）；`status-column.test.ts` 补 phase 符号与取色（含 **blocked 红 → 黄** 的显式断色）、`⟳` 两态取色（绿 / 灰，按 SGR 前缀精确断言）、历史行无符号；`adapter.dsh.test.ts` 补事件归一化、非活跃会话不过滤、缺 `goal` → 清记录语义。反向验证：撤掉 `layout.ts` 的符号渲染 → 上述渲染用例必红（已实测，见验证记录）。
- 文档：`TUI/docs/DESIGN.md`（状态事件映射新增 `goal/activation-changed` 行、顶部状态列、会话恢复口径、按会话隔离口径）、`TUI/docs/SPEC.md` §15.1（新 bullet：符号 / 取色 / 推导口径 + 回归清单）、`TUI/README.md`（界面图 `Goal ▷ active ⟳`、Goal 块说明）。
- 未做：`⟳` 宽度表项（仍按恒 1 列，见上探针记录，已登记 `TUI/docs/BACKLOG.md`「宽度表生成器与检入表不同步」条目）；demo/mock 加 activation 事件（列为可选，本次不动，保持 diff 面最小）。

## 子代理审阅（收尾前，2026-10-04）

只读审阅（未改文件；另在 `/tmp` 副本做变异测试）。结论「需修」三条，均已修并补测：

1. **[重要] 切走再切回的陈旧 armed**：宿主 `agents.resume` 经 `agents.sessions.prepare` → **重建 Session**（`dsh-session` create/fromRestore 均 `new Session`），进程本地 activation 归 disarmed，且 `setActivation(disarmed)` 与初值相同 → **不发边**，TUI 会沿用切换前的 armed 错显绿。修：`resumeTo` 成功后补一条清空边（`emit({type:"goal-activation", sessionId: id})`），交由「无记录 → disarmed」推导；订阅处注释同步更正（原「切走再切回仍须显绿」的前提不成立——TUI 切换会 dispose 旧 handle）。用例：`adapter.dsh.test.ts`「resumeTo：清该会话的 activation 旧边」。
1. **[次要] SPEC 口径自相矛盾**：原文写「未收到 activation 时不显示 `⟳`」，与实现及同句「无记录 → disarmed」冲突（active + 无记录实为灰 `⟳`）。修：`TUI/docs/SPEC.md` §15.1 改为「`phase !== "active"` 时不显示；无记录按 disarmed 显示灰 `⟳`」，并补「会话切换清边」口径。
1. **[次要] 宽度表条目悬空**：SPEC 与本文档均写「见 BACKLOG / 另开条目」，而两层 BACKLOG 都没有该条。修：登记 `TUI/docs/BACKLOG.md`「宽度表生成器与检入表不同步」（含「`[0x27c0,0x27ef]` 不含 U+27F3」的坑）。

采纳的次要 / 提示项（同批修）：测试补强——新增端到端帧断言用例（守 `app/index.ts` 事件分派 + `buildTopRegion` 接线，审阅实测撤这两处原本 0 红）、边序无关用例、缺 `sessionId` 兜底与非法 `activation` 用例；phase 取色断言精确到符号段（整行 `includes` 会漏掉符号错色）；未知 phase 不再多出一个空格；带 `goal` 但 `activation` 非法时**忽略整条事件**（不误当「无当前 goal」清空）。未采纳：demo/mock 加 activation 事件（保持最小 diff，已记在「未做」）。

## 验证记录（2026-10-04）

- `npm run check`（根，20 包）✓ 0 错；`npm run build` ✓；`npm run test:tui` **1317 例全绿**（含本次新增 15 例：`goal-activation.test.ts` 7 + `status-column.test.ts` 4 + `adapter.dsh.test.ts` 4；另有既有断言更新 5 处）；修完审阅项后复跑三文件 209 例全绿（7 + 19 + 183）。
- 反向验证：临时删除 `layout.ts` head 行的 phase 符号段 → `status-column.test.ts` 7 例红（含新增符号用例），恢复后 19 例全绿（脚本式验证，未留痕）。
- 人工确认：符号与颜色需在真机 `dsh --profile fff` 目视核对（本任务未跑真机会话，界面上 `⟳` 的绿/灰取值请以重启前后各观察一次为准）。
