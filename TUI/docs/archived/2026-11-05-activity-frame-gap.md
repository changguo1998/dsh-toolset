# 会话区右缘框列去空白占位（接取条目：TUI/docs/BACKLOG.md「会话区右缘框列去空白占位」）

状态：完成　　开启：2026-11-05　　关闭：2026-11-05
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

去掉上下排列时会话区右侧多出的 1 列空白（右缘框列空白占位），使其与回合区一致：内容行不落右缘字形，聚焦时不新增右缘边框；横线行仍满宽到最右列。

## 调研（来源：既有代码）

- `TUI/src/app/layout/grid.ts:44-52`：`rightEdgeGlyph(role)` —— `activity` 返回 `null`（回合区行不落字形）、`border` 返回 `─`（横线铺满）、`body` 与 `rule` 返回 `" "`（空白占位）。
- `TUI/src/app/layout/top-region.ts:543-577`：行拼装 `actRow`（回合区行）不补白、`rightGlyph !== null` 才拼右缘框列；`ruleRow`（回合分隔线）补到 contentW、右缘框列留空。
- `TUI/src/app/layout/focus-frame.ts:148-161,222-234`：`emphasize` 只对 `FRAME_GLYPHS`（框线字形）改色；history 分支右缘 `emphasize(rows, r, rEdge)` 处，若该列为空白占位 → 非框线 → no-op。即会话区聚焦时右缘空白列变不成边框，占位纯冗余。
- `TUI/src/app/layout/geometry.ts:294-299,398-399,418-419`：纵向 `dialogueTextW = activityTextW = contentW`；`rightFrame = historyWidth >= FRAME_RIGHT_COLS + 1`（`FRAME_RIGHT_COLS = 1`）。
- 横向排列时 `emphasize` 右缘改为内部分隔列（框线 `│`），不在本次问题内。
- 结论：只需把 `rightEdgeGlyph` 的 `body` 分支由 `" "` 改为 `null`（`rule` 行右缘本就是留空，与 `body` 一并改成一致即可——需评估）；`FRAME_RIGHT_COLS` 宽度扣除与 `border` 满宽不变。

## 决策

- 决策项 1 = `rule`（回合分隔线）行右缘是否一并去字形
  - a. `body` 与 `rule` 都改 `null`（与 activity 一致，右缘均不落字形）
  - b. 只改 `body`，`rule` 维持空白占位
  - 选定：a。`rule` 行当前补到 contentW 后右缘留空，形态与会话区内容行同面；统一为不落字形避免两态并存。需验证对「回合分隔线宽度 = 文本宽度」裁定（2026-10-27）无回归。
- 决策项 2 = 聚焦时序
  - a. 不作专门处理：右缘无既有框线，`emphasize` 天然 no-op，聚焦不新增竖线（现状即如此）
  - b. 额外在聚焦时右缘落线
  - 选定：a。用户明确「不要这个了」，不新增聚焦边框。

## 规划

任务拆分：

1. `grid.ts`：`rightEdgeGlyph` 的 `body` / `rule` 分支返回 `null`（保留 `border` 满宽、`activity` null）。
2. 检查 `top-region.ts:574` 拼行在该改动下的行为（`rightGlyph !== null` 不拼列，行尾即 contentW）。
3. 更新文档口径：`TUI/README.md`（第 43 行附近右缘框列描述）、`TUI/docs/SPEC.md`（§布局/边框）、`TUI/docs/DESIGN.md`（§布局）。
4. `pnpm run check` + `pnpm run test:tui` + `pnpm run demo -- --smoke` 全绿；涉及帧断言则同步更新并说明。

计划改动文件清单：

- `TUI/src/app/layout/grid.ts`（`rightEdgeGlyph` body/rule → null）
- `TUI/README.md`（右缘框列口径）
- `TUI/docs/SPEC.md`（边框/右缘描述）
- `TUI/docs/DESIGN.md`（§布局右缘描述）
- 可能：`TUI/tests/*`（帧断言若锁定 `" "`）

明确不做：

- 不动 `FRAME_RIGHT_COLS` / `contentW` / `rightFrame` 宽度扣除
- 不动 `border` 行（横线仍铺满到最右列）
- 不动横向排列与 `innerDividerCol`
- 不改 `focus-frame.ts`（其语义已天然满足）

## 实现记录

- 2026-11-05: `TUI/src/app/layout/grid.ts` 的 `rightEdgeGlyph` 把 `body` / `rule` 分支由 `" "`（空白占位）改为 `null`（不落字形）；`border` 仍返回 `ACTIVITY_SEPARATOR`（横线铺满到最右列）。头注释同步更新。
- 2026-11-05: `TUI/src/app/layout/top-region.ts` 右缘框列注释由「恒空白占位（供 focusFrame 覆写）」改为「内容行一律不落字形」。
- 2026-11-05: 测试同步——
  - `TUI/tests/grid.test.ts`：`rightEdgeGlyph` 断言 rule/body 由 `" "` 改 `null`。
  - `TUI/tests/layout4.test.ts`：短用户消息行宽 `40` → `39`（右缘空列消除）。
  - `TUI/tests/ctrl-t-panes.test.ts`：隐藏态内容行宽过滤由「= cols」改「= cols−1 或 cols（border 满宽）」。
  - `TUI/tests/pane-text-margin.test.ts`：删除「标题与边框行满宽」对 body 行满宽的断言（覆盖已由 154-167 的独立 border 断言承担），标题行改断言铺到区域正文右缘。
  - `TUI/tests/fixtures/focus-frame-legacy.json`：**重冻**（15 场景，全部仅行尾少 1 个空格，无字形 / 行数变化）。
- 2026-11-05: 文档同步——`TUI/README.md`（顶部区域段）、`TUI/docs/SPEC.md`（§文字右缘不留白 / §列口径）、`TUI/docs/DESIGN.md`（§布局 grid / §文字右缘段）、`TUI/scripts/freeze-focus-frame.mts`（重冻记录）。

## 偏差

- 决策项 1 原计划「rule 一并改 null」已按 a 执行；决策项 2 按 a（不新增聚焦边框）。
- 帧基线重冻属预期（本条目改动直接改变帧内容）；已按流程在 freeze 脚本记录重冻原因，未静默重冻。

## 测试与证据

- `pnpm run check`：通过（5 包 tsc --noEmit，EXIT 0）。
- `pnpm run build`：通过（EXIT 0）。
- `pnpm run test:tui`：**1837 / 1837 全绿**。
- `pnpm run demo -- --smoke`：`SMOKE_PASS preset-badge / jobs-panel / jobs-kill`、`SMOKE_OK sent=[...] interrupts=1`，EXIT 0。
- `node dev/standard/index.mjs --all`：`✓ check:docs 通过: 112 篇现行 Markdown / 901 个 .ts, 规则 0 项, 错误 0 / 警告 0`。
- 差异形态核对：重冻后旧/新基线对比仅「行尾少 1 空格」（focus-null@w60 / focus-history@w60 / panel-approval@w60 各 24 行中 7 行变化，全部为尾部空格）。

## 收尾

- **提交**: 实现 + 测试 + 帧基线 + 文档同步随 `8427fb7a`（fix(TUI): 会话区/回合分隔线右缘不再落空白占位列）提交; 本条收尾（追踪文档补完 + 关联条目清理 + 归档）随关闭后收尾提交。
- **BACKLOG**: 条目「会话区右缘框列去空白占位」已完成并移出清单; 残余右缘 1 列由后继条目「区域右缘框列宽度改为 0」(8e7ee833) 继续取消。
- **归档**: 本文件移入 `TUI/docs/archived/2026-11-05-activity-frame-gap.md`。
- **人工确认**: 用户聚焦态右缘不出现边框后裁定「不要这个了」, 并在下一条目确认右缘留白整体取消。
- **遗留**: 无未结项; 右缘留白整体取消见下一条目追踪文档 `2026-11-05-activity-frame-gap-zero.md`。
