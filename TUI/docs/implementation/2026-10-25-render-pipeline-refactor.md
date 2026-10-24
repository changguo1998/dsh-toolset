# 重构 TUI 渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析（接取条目：`TUI/docs/BACKLOG.md`「重构渲染流水线：结构分类在摊平阶段丢失，measure 与 fill 各自解析」）

状态：调研　　开启：2026-10-25
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
本轮只建立文档（接取），调研与实现均未开始。

## 目标

让结构分类成为单一源（随节点进入摊平阶段，不再按文本二次分类），并让折行只有单一入口（measure 与本文件所述 fill 共用同一实现，前缀 / 悬挂回到节点字段，修掉 `void contWidth` 造成的几何分叉）；保持表格仍在构建期算列宽、折叠基线不静默重冻。

## 调研

（未开始。既有事实摘要见 `TUI/docs/BACKLOG.md` 该条目正文与 `TUI/docs/implementation/2026-10-24-table-layout-side-effects.md`「流程梳理」；`SPEC.md:148` 与 `SPEC.md:805-810` 的列表项口径冲突待一并确认。）

## 决策

（待调研后填写。）

## 规划

计划改动文件清单（草案，开工时定稿）：

- `TUI/src/renderer/pipeline/boxes.ts`、`TUI/src/renderer/pipeline/panes.ts`（分类随节点下传）
- `TUI/src/renderer/pipeline/rows.ts`（`boxToLines` 不再把内容压回纯行文本）
- `TUI/src/renderer/build-box.ts`（去掉按文本的二次分类）
- `TUI/src/renderer/markdown.ts`（列表符 / 标题 / 引用竖线 / 任务框改由节点字段表达）
- `TUI/src/renderer/measure.ts`（修 `void contWidth`，与 fill 共用折行）
- `TUI/docs/SPEC.md`（列表项规格与实现对齐）
- `TUI/tests/`（`pipeline-frame` / `pipeline-equivalence` 行数断言，逐条人工确认）

明确不做：

- 不动表格列宽算法（仍在构建期计算）。
- 不重冻折叠基线；如确需调整，先取得用户明确许可并逐场景记明。

## 实现记录

（待开工。）

## 偏差

（待实现阶段填写。）

## 测试与证据

（待实现阶段填写。）

## 收尾

（待关闭时填写。）
