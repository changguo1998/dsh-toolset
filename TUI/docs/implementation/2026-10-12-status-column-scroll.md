# 状态列恢复真滚动（接取条目：TUI/docs/BACKLOG.md「状态列恢复真滚动（PgUp/PgDn 现在无作用）」）

状态：规划　　开启：2026-10-12　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

状态列焦点下 `PgUp` / `PgDn` 真的能滚到被折叠 / 被截断的条目；**默认视图（`scroll == 0`）
与今天逐字一致**（折叠分级、`…(+N项已隐藏)`、`…(+N行)` 兜底、块序与配色都不变）。

## 调研

- 键位链路本来是通的：`PgUp`/`PgDn` → `index.ts:203`（行）/`:220`（页，步长 `contentTopH`）
  的 `status-column-scroll` → `state.statusColumnScroll` → `renderStatusColumn` 的 `scroll` 形参。
- 但偏移永不生效：`renderStatusColumn` 先按帧高折叠（L0→L3 逐级尝试，全放不下才 `capRows`
  截到 h 行），折叠产物长度**必 ≤ h** → `statusStartFor(len, offset, h)` 在 `len ≤ rows` 时
  恒返回 0。既有用例「总高超窗口时折叠而非滚动——隐藏条目滚动不可找回」描述的正是这一现状。
- `capRows` 的 `…(+N行)` 兜底只在「goal 大头」这类连 L3 都放不下的极端场景出现；正常情况下
  条目是被 L1/L2 折叠掉的，只有真滚动才能看到。

## 决策

**用户 2026-10-12 裁定：恢复滚动**（原「承认不滚动、删键位」方案不采用）；口径取
**A「滚动即展开」**（开工前经用户确认）：

- `scroll == 0`：走今天的折叠视图（L0→L3 首次放得下即采用 + `capRows` 兜底）——**零回归**；
- `scroll > 0`：改在 **L0（不折叠）完整行集**上开窗（`statusStartFor` + 切片），**不做**
  `capRows`——被折叠 / 被截断的条目由此全部可滚到；
- `PgUp` 回 0 即恢复折叠视图；L0 也放得下时 `PgDn` 为无操作（`start` 恒 0，确无更多内容）；
- **不引入状态侧上限**：`statusColumnScroll` 保持非负 clamp，渲染期 `statusStartFor` 已经
  clamp 到 `[0, len - h]`（少一层状态与几何耦合）。

不在目标内：改变折叠分级语义本身（B 方案）、只放开 `capRows` 截断部分（C 方案）。

## 规划

- 任务 1（实现）：`renderStatusColumn` 加 `scroll > 0` 分支（在 L0 行集上开窗）。
- 任务 2（既有用例校准）：
  - `tests/status-column.test.ts`「总高超窗口时折叠而非滚动——隐藏条目滚动不可找回」→ 改写为
    「滚动可找回被折叠条目」；
  - `tests/status-column-equivalence.test.ts`「滚动偏移不影响可见行」→ 收窄为 `scroll == 0`
    仍逐行等价，并**新增**「`scroll > 0` 的已知差异」用例（与旧实现有意不同，钉住新语义）。
- 任务 3（新增用例）：`scroll > 0` 能滚到被 L1/L2 折叠的条目、`PgUp` 回 0 恢复折叠视图、
  滚动窗口内每行显示宽仍为 `statusColWidth`。
- 任务 4（文档）：`SPEC.md` §15.1 状态列条目补滚动口径一行。

### 计划改动文件清单

- `TUI/src/app/layout.ts` —— `renderStatusColumn` 的 `scroll > 0` 分支（+ 注释口径）
- `TUI/tests/status-column.test.ts` —— 折叠/滚动用例校准
- `TUI/tests/status-column-equivalence.test.ts` —— 滚动档位收窄 + 新增已知差异用例
- `TUI/docs/SPEC.md` —— §15.1 状态列滚动口径一行

## 实现记录

（待补）

## 测试与证据

（待补）

## 收尾

- 追踪文档移入 `TUI/docs/archived/`；BACKLOG 移除本条目。
