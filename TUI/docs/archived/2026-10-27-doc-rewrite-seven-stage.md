# 文档回写：DESIGN.md / SPEC.md 按七段链路重写（接取条目：TUI/docs/BACKLOG.md「文档回写：`DESIGN.md` / `SPEC.md` 按七段链路重写」）

状态：关闭　　开启：2026-10-27　　关闭：2026-10-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本任务只改文档，不改代码；同批处理的 BACKLOG 卫生项（#1 卡死条目关闭、#2 `<br>` 条目不立项）记在「收尾」。

## 目标

把 `TUI/docs/DESIGN.md` 与 `TUI/docs/SPEC.md` 的链路描述改到 2026-10-26 落地的七段渲染流水线：
旧符号（`build-box` / `buildBox` / `buildContentRows` / `boxes.ts` / `panes.ts` / `boxToLines` / 六步流水线）
不再出现；链路描述与 `pipelineContent` 实际调用顺序一致；并写明「面板 / chrome 仍走旧 Box 链」的边界。

## 调研

- 实际生产链（`TUI/src/app/layout/pipeline/frame.ts:177` `pipelineContent`）：
  窗口 → `split.ts`（`splitOldSectionsIndexed`）→ `parse.ts` → `route.ts` / `routeTable.ts`
  → `renderPaneNew`（`rows.ts:447`：`structure.ts` 的 `buildTrees` → `measure.ts` → `flatten.ts`
  → 槽位行归属 + 行数表 + 视口）→ 逐 pane `ContentRow[]`；`layout.ts` 的 `buildTopRegion` 拼帧。
- 恢复路径：`replay.ts` 把 `HistoryRow[]` 重放成节；`sections.ts` 是事件累积（节缓存）。
- 唯一折行：`pipeline/wrap.ts` 的 `wrapLeaf`；表格结构解析在 `layout/table.ts`（`parseTableAt` /
  `isTableStart`），列宽 `fitCols` 在 `measure.ts` 调用，网格在 `flatten.ts` 铺。
- 旧 Box 链仍在生产：`layout.ts:66` 引入 `layout/measure.ts`（chrome 用）；`components/*` 引入
  `layout/box.ts` + `layout/fill.ts`（`fillBoxTree`）；`notice-line.ts` 是旧栈迁出的共用呈现参数。
  `build-box.ts`、`boxes.ts`、`panes.ts`、`boxToLines`、`buildContentRows`、`lineUpBlockBars`、
  `compactActivityLine` 已不存在（`grep` 无命中；仅在历史注释里出现）。
- 现存文档偏差（`grep` 统计）：DESIGN 6 处、SPEC 18 处旧符号；DESIGN「六步流水线」整段过时；
  SPEC §9.1 整节过时；SPEC §3 / §3.2 / §6.7 / §6.8 / §15.5 / §15.6 的部分落点引用旧文件。

## 决策

- 决策项 1　改写方式
  - a) 只替换旧符号名（机械替换）。
  - b) 按七段重写链路段落与落点表，保留行为规格正文；旧 Box 链章节标注「面板 / chrome」边界。
  - **选定 b**：机械替换会把「构建期」等语义错误留下（表格已改到 parse / measure / flatten）。
- 决策项 2　旧 Box 链章节（SPEC §2 / §6 / §7 / §8）
  - a) 整章删掉。
  - b) 保留并在章首标注「面板 / chrome 仍走此链」。
  - **选定 b**：面板与 chrome 确实仍用 `box.ts` + `layout/measure.ts` + `fill.ts`，删掉会丢真实契约。
- 决策项 3　表格章节口径
  - a) 保留「构建期降级」叙述，只改文件名。
  - b) 改为「解析在 parse、列宽在 measure、网格在 flatten」。
  - **选定 b**：这是七段重构的核心变化之一，保留旧叙述会与实现相反。

## 规划

任务拆分：

1. `TUI/docs/DESIGN.md`：术语节（六步 → 七段 + 边界）、文件树 `layout/`、模块归属表、面板节、
   状态符号 / 排队块两处落点。
2. `TUI/docs/SPEC.md`：§2 章首边界注、§3（映射 + 3.1 + 3.2 表格）、§6.7 / §6.8（旧 fill 归属与
   活动区压缩落点）、§9 / §9.1（七段）、§11.3 示意行、§15.5 / §15.6 落点引用。
3. `TUI/docs/BACKLOG.md`：本条置「进行中」，收尾时标完成并清理；同批关闭 #1、#2 两条并记录。

计划改动文件清单：

- `TUI/docs/DESIGN.md`
- `TUI/docs/SPEC.md`
- `TUI/docs/BACKLOG.md`
- `TUI/docs/implementation/2026-10-27-doc-rewrite-seven-stage.md`（本文件）

明确不做：不改任何源码 / 测试；不重新设计渲染行为；不改 `README.md` 与 `COMMANDS*.md`；
不重冻基线；不动 `docs/STATUS.md`。

## 实现记录

- 2026-10-27　`DESIGN.md`：术语节「六步流水线」整段改为七段（分节 → 解析 → 分流 → 结构 → 测量 → 摊平 → 组装，带实际文件名）并写明「面板 / chrome 仍走旧 Box 链」；文件树 `layout/` 改为 `pipeline/` 七段 + 旧链三文件 + 其余模块；「Box 排版模型」节改为 Box（面板 / chrome）与 `Node/Leaf`（内容）双模型，层级图与管线示意改到 `pipelineContent`；模块归属表重写为七段 / 旧链 / 公共模块并补回 `grid.ts` 行；面板节标明 `fillBoxTree`；状态符号落点改 `structure.ts` 的 `userSym`；排队块落点改 `renderQueuedBlocks` → `renderPaneNew`。
- 2026-10-27　`SPEC.md`：§2 加边界注（Box 模型 = 面板 / chrome）；§3 改为「Block → Node/Leaf」映射表；§3.1 改为块闭集 → 节点映射；§3.2 表格改为「解析在 parse / 列宽在 measure / 网格在 flatten」，接口改 `isTableStart` / `parseTableAt` / `fitCols`；§6 与 §6.7 / §6.8 加「旧 Box 链」边界，适配落点表改到 `routeTable` / `rows.foldRows` / `frame.windowSections`；§9 / §9.1 整节重写为七段（含唯一解析 / 唯一折行 / 空行唯一来源 / 缓存与窗口口径）；§11.3 示意行更新；§15.5 类型间隔 / 六开关 / 思考 markdown / 两 pane 宽度落点更新；§15.6 列表与表格落点更新，删净旧符号。
- 2026-10-27　`BACKLOG.md`：本条置进行中（开工），收尾标完成并移出；同批关闭「新会话卡死」（真机复验通过）与「表格单元格 `<br>`」（不立项）两条。

## 偏差

- 无代码改动。§3.2 的「窄终端」口径按现状写成「`fitCols` 返回 null → 每列 1 列兜底」，未沿用旧的「退回普通文本行」叙述（旧渲染链已删除，`table.ts` 文件头注释仍留旧口径，属代码注释、不在本任务改动范围）。

## 测试与证据

- 旧符号 grep（`build-box` / `buildBox` / `buildContentRows` / `boxes.ts` / `panes.ts` / `boxToLines` / 六步 / 六段 / `wrapListRows` / `compactActivityLine` / `lineUpBlockBars` / `tableBox` / `BuildBoxOptions` / `visibleAtLevel` / `noteActKind` / `bodyRun`）：两份文档零命中。
- 链路顺序对照 `TUI/src/app/layout/pipeline/frame.ts:177` `pipelineContent`：窗口 → `splitOldSectionsIndexed` → `parse` → `route` → `renderPaneNew`（`buildTrees` → `measure` → `flatten` → 行归属）→ `ContentRow[]`；`rows.ts:447` / `frame.ts:177` / `layout.ts:1082` 逐点核对一致。
- 本任务只改文档，未跑代码测试（无需）；文档改动已过 `format`（`mdformat`）。

## 收尾

- 2026-10-27：条目「文档回写：`DESIGN.md` / `SPEC.md` 按七段链路重写」标「完成」并从 `TUI/docs/BACKLOG.md` 移除（待办区写「当前无未完成项」）；本文件移入 `TUI/docs/archived/`。
- 同批 BACKLOG 卫生：#1「新会话卡死」真机复验通过并关闭（用户 2026-10-27 确认目前无问题；修法提交 `5070fe4`）；#2「表格单元格 `<br>` 换行」按用户裁定不立项关闭。
- 回写：`DESIGN.md`、`SPEC.md`（本任务内完成）；未改 `README.md` / `COMMANDS*.md` / `STATUS.md`。
- 遗留：无。
