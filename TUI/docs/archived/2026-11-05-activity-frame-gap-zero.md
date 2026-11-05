# 区域右缘框列宽度改为 0（接取条目：TUI/docs/BACKLOG.md「区域右缘框列宽度改为 0」）

状态：完成　　开启：2026-11-05　　关闭：2026-11-05
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

把 `FRAME_RIGHT_COLS` 由 1 改为 0, 使 `contentW = historyWidth`, 会话区 / 回合区内容文字右缘贴到屏幕最右列, 消除两侧各 1 列的区域右缘空白; 横线行 / 焦点框 / 窄终端不破。

## 调研（来源：既有代码）

- `TUI/src/app/layout/frame-rows.ts:116`：`FRAME_RIGHT_COLS = 1`; `:119-122` `regionColumnWidth(historyWidth) = historyWidth − (useFrame ? FRAME_RIGHT_COLS : 0)`, `useFrame = historyWidth >= FRAME_RIGHT_COLS + 1`。
- `TUI/src/app/layout/geometry.ts:375,398-399`：`contentW = regionColumnWidth(historyWidth)`; `dialogueTextW = dialogueW`、`activityTextW = activityW`（纵向时 = contentW）。
- `TUI/src/app/layout/geometry.ts:419`：`rightFrame = historyWidth >= FRAME_RIGHT_COLS + 1`。
- `TUI/src/app/layout/top-region.ts:191,565-577`：`useRightFrame = geom.rightFrame`; 拼行仅在 `rightGlyph !== null`（border 行）时补右缘字形; 内容行（body / rule / activity）`rightEdgeGlyph` 已在上轮（8427fb7a）改为 `null`。
- `TUI/src/app/layout/frame-build.ts:141-142`：焦点矩形 `w = geom.cols − regionX`, 不经 `FRAME_RIGHT_COLS`（右缘恒指屏幕最右列）。
- 改 0 的推导：
  - `regionColumnWidth`：`useFrame = historyWidth >= 1` 恒真（区域必有 ≥1 列）→ `contentW = historyWidth`。
  - `rightFrame = historyWidth >= 1` 恒真——现状（=1）下也恒真（需 historyWidth ≥ 2 才 false, 但区域宽为 1 时 `Math.max(1,…)` 兜底、无实际内容）。语义不变。
  - 横线行满宽到 `cols` 由 `rightEdgeGlyph("border")` 返回 `─` 保证, 与 `contentW` 无关 → 不变。
  - 焦点框右缘按 `cols` 算 → 不变。
  - 因此唯一行为变化: `contentW` +1, 两 pane 内容右缘右移 1 列到屏幕最右列; 相应帧断言 / 基线（focus-frame 15 场景、layout4 / pane-text-margin / ctrl-t-panes 的行宽）需重算 / 重冻。

## 决策

- 决策项 1 = 改 0 后 `rightFrame` / `useRightFrame` 是否保留
  - a. 保留常量与判定（改 0 后恒真）, 最小改动
  - b. 一并删除 `rightFrame` 字段与 `useRightFrame` 分支（拼行不再有条件拼右缘字形）
  - 选定：a。border 行仍需在右缘补 `─`, `rightGlyph !== null` 的分支依赖 `useRightFrame` 存在; 保留判定为最小改动, 语义清晰。
- 决策项 2 = 窄终端口径
  - a. 保持 `Math.max(1, …)` 兜底: 区域宽 ≥1 即 `contentW = historyWidth`
  - b. 为极窄终端保留显式扣列
  - 选定：a。`frame-rows.ts:121` 已有 `Math.max(1, …)` 保底, 屏宽 0 不可能（终端 ≥1 列）。

## 规划

任务拆分：

1. `frame-rows.ts`：`FRAME_RIGHT_COLS` 改 `0`。
2. 重冻帧基线（`freeze-focus-frame.mts`）, 记录重冻原因。
3. 复核 / 同步行宽断言行（`pane-text-margin` / `ctrl-t-panes` / `layout4` / `grid` 若有硬编码 `cols−1` / 40 等）。
4. 同步文档: `TUI/README.md` / `SPEC.md` / `DESIGN.md` 右缘由「保留 1 列」改「0 列, 内容贴右」。
5. `pnpm run check` / `test:tui` / `demo -- --smoke` / `check:docs` 全绿。

计划改动文件清单：

- `TUI/src/app/layout/frame-rows.ts`（`FRAME_RIGHT_COLS = 0`）
- `TUI/tests/fixtures/focus-frame-legacy.json`（重冻）
- 可能: `TUI/tests/{pane-text-margin,ctrl-t-panes,layout4,grid}.test.ts`
- `TUI/README.md` / `TUI/docs/SPEC.md` / `TUI/docs/DESIGN.md`
- `TUI/scripts/freeze-focus-frame.mts`（重冻记录）
- 本追踪文档

明确不做：

- 不动 `FRAME_LEFT_COLS`（左缘由状态列外缘, 与本问题无关）
- 不动 `rightFrame` 字段 / `useRightFrame` 分支结构（决策项 1 a）
- 不改 `focus-frame.ts`（右缘本就按 cols）
- 不改横向内部分隔列逻辑

## 实现记录

- 2026-11-05: `TUI/src/app/layout/frame-rows.ts` `FRAME_RIGHT_COLS` 1 → 0（含注释更新）。
- 2026-11-05: `TUI/src/app/layout/geometry.ts:419` `rightFrame` 判定加 `FRAME_RIGHT_COLS > 0` 守卫——常量归零后恒 false, 拼行不再追加右缘字形（否则 border 行 contentSegs 已铺满到最右列又追加 ─ 会溢出 1 列, 实测 61 > 60）。
- 2026-11-05: `TUI/src/app/layout/grid.ts` `rightEdgeGlyph` 简化为恒 `null`, 删除 `ACTIVITY_SEPARATOR` import（横线满宽由 contentSegs 承担）。
- 2026-11-05: 测试同步——
  - `TUI/tests/grid.test.ts`：右缘一律 null 断言。
  - `TUI/tests/layout4.test.ts`：`histBody` 辅助函数 `contentW` 由 `historyWidth − 1` 改 `historyWidth`（无右缘扣除）; `frameGeometry` 断言 `dialogueW` 53 → 54; 短用户消息行宽 39 → 40。
  - `TUI/tests/layout-horizontal.test.ts`：等宽用例调试提示——改 cols 101（历史正文宽 68 → 回合区 34 / 会话区 33 不等宽, 交汇字形用例恢复不等宽前提）。
  - `TUI/tests/fixtures/focus-frame-legacy.json`：**重冻**（15 场景, 内容行右缘右移 1 列铺到最右）。
- 2026-11-05: `TUI/scripts/freeze-focus-frame.mts` 追加重冻记录。

## 偏差

- 决策项 1 原选 a（保留 `rightFrame` / `useRightFrame` 结构）——实现时发现若保留「rightGlyph=border 返回 ─」会把 border 行撑出 1 列（contentW 已含最右列, 再追加 ─ 溢出）, 故改为 `rightFrame` 加 `FRAME_RIGHT_COLS > 0` 守卫 + `rightEdgeGlyph` 恒 null。结构上仍保留 `rightFrame` 字段与拼行分支（恒不触发）, 符合最小改动; 语义从「保留判定」修正为「常量归零即整机制关闭」。

## 测试与证据

- `pnpm run check`：通过（EXIT 0）。
- `pnpm run build`：通过（EXIT 0）。
- `pnpm run test:tui`：**1837 / 1837 全绿**。
- `pnpm run demo -- --smoke`：`SMOKE_PASS` / `SMOKE_OK`，EXIT 0。
- `node dev/standard/index.mjs --all`：`✓ check:docs 通过: 112 篇现行 Markdown / 901 个 .ts, 规则 0 项, 错误 0 / 警告 0`。
- 中途失败记录：`FRAME_RIGHT_COLS=0` 但未改 `rightFrame` 守卫时, border 行宽 61 > 60（contentSegs 铺满又追加 ─）；修正守卫后全绿。等宽用例 original cols=100 下两 pane 恰好等宽（contentW 67 → 33/33），改 cols=101（contentW 68 → 34/33）恢复不等宽前提。

## 收尾

- **提交**: 实现 + 测试 + 帧基线重冻 + 文档同步随 `8e7ee833`（fix(TUI): FRAME_RIGHT_COLS 改 0, 区域内容铺满到屏幕最右列）提交; 本条收尾（追踪文档补完 + BACKLOG 清理 + 归档）随关闭后收尾提交。
- **BACKLOG**: 条目「区域右缘框列宽度改为 0」完成并移出清单（该层现无未完成项）。
- **归档**: 本文件移入 `TUI/docs/archived/2026-11-05-activity-frame-gap-zero.md`。
- **人工确认**: 用户裁定「改为 0 (推荐)」; 全量验证后两 pane 内容文字铺到屏幕最右列、横线 / 焦点框 / 窄终端不破。
- **遗留**: 无未结项; 新登记「回合区输出时状态行上边框左段缺横线」(TUI/docs/BACKLOG.md, 未接取) 与本次改列无直接因果, 属既有渲染增量残留, 留待复现取证。
