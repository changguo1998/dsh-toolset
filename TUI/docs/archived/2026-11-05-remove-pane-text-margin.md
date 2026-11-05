# 取消会话区 / 回合区的文字右缘留白（接取条目：`TUI/docs/BACKLOG.md`「取消会话区 / 回合区的文字右缘留白」）

状态：完成　　开启：2026-11-05　　关闭：2026-11-05
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

删除 `PANE_TEXT_MARGIN_COLS`（右缘防溢出留白 1 列）：两 pane 的文字排版宽直接等于 pane 正文宽——横向会话区 = `dialogueW`、横向回合区 = `activityW`、纵向两 pane 各 = `contentW`。横线（标题栏下划线、回合区分隔线、回合分隔线 `╌`、状态行边框）与外框列字形不变。

## 背景

`TUI/src/app/layout/frame-rows.ts:126` 的 `PANE_TEXT_MARGIN_COLS = 1` 只收窄「右缘贴着外框列」的文字排版宽：横向会话区不留（右缘贴内部分隔竖线）、横向回合区与纵向两 pane 各让 1 列。目的是字形宽度估算偏差（CJK / 组合字符）时多出的列落在留白里，不顶到外框列触发整行折行。

用户 2026-11-05 要求取消这些留白（先问「这一列空白是否用于防溢出」，确认后要求全部取消）。

## 决策（用户 2026-11-05）

**全部取消**：不再区分「右缘是否贴外框列」，两 pane 的文字排版宽 = pane 正文宽，宁可接受字形宽度估算偏差的风险，也不要行尾多出的空白列。

## 规划（计划改动文件清单）

01. `TUI/docs/BACKLOG.md`：条目按完成清理（关闭时）。
02. `TUI/docs/implementation/2026-11-05-remove-pane-text-margin.md`：本文件。
03. `TUI/src/app/layout/frame-rows.ts`：删除 `PANE_TEXT_MARGIN_COLS` 与 `paneTextWidth`（及注释）。
04. `TUI/src/app/layout.ts`：移除二者导出。
05. `TUI/src/app/layout/geometry.ts`：删 `paneTextWidth` import；`dialogueTextW` / `activityTextW` 直接取 `split` 宽；`FrameGeometry` 字段注释同步。
06. `TUI/src/app/layout/top-region.ts`：回合分隔行注释去掉 `PANE_TEXT_MARGIN_COLS` 口径。
07. `TUI/tests/pane-text-margin.test.ts`：改写为「无右缘留白」守成测试（两 pane 文字宽 = pane 宽、文字铺到正文右缘、横线与外框列不变、窄终端不出现负宽）。
08. `TUI/tests/layout4.test.ts`：三处 `paneTextWidth(regionColumnWidth(...), true)` 改为 `regionColumnWidth(...)`，顺带改相关注释。
09. `TUI/docs/SPEC.md`：§「文字右缘留白」（725）改写为已取消口径；622 / 728 / 795 三处引用同步。
10. `TUI/docs/DESIGN.md`：203 条同口径。
11. `TUI/README.md`：43 行顶部区域说明同步。

不改：`messageGutter`（用户块左缘与回复右缘的对称留白，另一机制）、回合区分隔线 / 标题栏下划线 / 状态行边框的满宽行为、渲染层 `grid` 与 `rightEdgeGlyph` 的分支。

## 实现记录

## 实现记录

- `src/app/layout/frame-rows.ts`：删除 `PANE_TEXT_MARGIN_COLS` 与 `paneTextWidth`（连同其注释块）；`FRAME_LEFT_COLS` / `FRAME_RIGHT_COLS` 与 `regionColumnWidth` 不动。
- `src/app/layout.ts`：移除上述两个导出。
- `src/app/layout/geometry.ts`：删 `paneTextWidth` import；`dialogueTextW = split.dialogueW`、`activityTextW = split.activityW`（排队块改用同宽）；`FrameGeometry` 的两条字段注释同步。
- `src/app/layout/top-region.ts`：回合分隔行注释去掉 `contentW − PANE_TEXT_MARGIN_COLS` 口径（行为不变：内容层已铺到文字宽，补白仍按 `contentW`）。
- `tests/pane-text-margin.test.ts`：整文件改写为「无文字右缘留白」——两 pane 文字宽 = 正文宽（横纵都不断言让列）、文字铺到正文右缘且不越外框列、横线与边框行仍满宽、回合分隔线右端仍与正文右缘对齐、窄终端文字宽 ≥ 1。
- `tests/layout4.test.ts`：三处 `paneTextWidth(regionColumnWidth(...), true)` → `regionColumnWidth(...)`，删 import，两处注释同步。
- `tests/small-terminal-warning.test.ts`：新增 `squash()`（去空白与框线字符）——取消留白后宽 16 的首帧折行点改变，`终端尺寸` 被折成两行，原 `includes(MARK)` 与 `markCount()` 改按压平文本判定（负向断言不放宽）。
- `tests/fixtures/focus-frame-legacy.json`：重冻（`pnpm exec node --experimental-transform-types scripts/freeze-focus-frame.mts`，15 场景 114 行变化，抽样核对为「内容右缘多 1 列 / 行尾少 1 空格 / 用户块 `┃` 右移 1 列」）。
- `scripts/freeze-focus-frame.mts`：追加本次重冻记录（计划外补充：夹具变化的出处说明，随本次改动一并提交）。
- `docs/SPEC.md`（§15.4 留白条目、§3 字段注释、§15.6 两 pane 宽度）、`docs/DESIGN.md`（右缘留白条与回合区条引用）、`README.md`（顶部区域）口径同步为「文字宽 = 正文宽，无右缘留白」。

## 测试与证据

- `TUI`：`pnpm run check` 通过；`pnpm run test` **1834/1834**（首次运行 16 例红：15 条帧基线 + 1 条窄屏警告断言，均按上述方式处理）；`pnpm run demo -- --smoke` **42 SMOKE_PASS + SMOKE_OK**。
- 全仓：`pnpm run check` 通过、`pnpm run build` 退出 0、`pnpm run check:docs` 0 错误 0 警告。
- 真机未验证：需 `pnpm run build` 后重启会话（主 profile 走 `scripts/install.sh --profile fff --sync`），目视确认会话区 / 回合区行尾无多余空白列、横线仍满宽、CJK 混排下不出现折行错位。

## 收尾

- 代码 + 测试 + 夹具 + 文档随任务关闭后的一次提交。
- 关闭日期：2026-11-05。
