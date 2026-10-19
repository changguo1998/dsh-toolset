# 思考内容排版支持更多列表类型（接取条目：TUI/docs/BACKLOG.md「思考内容排版时支持更多的列表类型」）

状态：规划　　开启：2026-10-19　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

在思考与正文共用的 `wrapAssistantLine` 管线（`src/app/layout/markdown.ts`）上扩充列表分类，支持更多列表类型；补齐范围与嵌套深度开工时裁定（候选：有序 `1)` 分隔 / 字母编号 / 圆括号编号 / 嵌套层级缩进 / 有序任务列表 `1. [ ]` / 定义列表）；当前只认无序 `• ` 与有序 `\d+.`、任务列表只认无序前缀、无嵌套。

## 调研

（待写 —— 用户指示：新建追踪文档后、调研前先停下。已预置的核实点：`LIST_RE` / `TASK_RE` / `assistantLineRows` / `wrapListRows` 现状与 `layout4` / 思考双轨用例的口径。）

## 决策

（待写。待决点：① 补齐范围；② 嵌套实现方式（按缩进深度在管线里建层级 vs 仅渲染层加缩进，影响 `wrapListRows` 的 `prefixWidth` 与悬挂对齐）；③ 与行内 markdown 是否叠加；④ 现有单测与帧断言的口径同步。）

## 规划

任务拆分：

- 裁定范围与嵌套方式（决策节）。
- 实现：`markdown.ts` 的 `LIST_RE` / `TASK_RE` / `assistantLineRows` / `wrapListRows` 扩展。
- 测试与文档：各类型帧级断言（思考与正文一致）、`SPEC.md` 块级元素口径同步。

计划改动文件清单（预估）：

- `TUI/src/app/layout/markdown.ts`
- `TUI/tests/**`（列表类型帧断言）
- `TUI/docs/SPEC.md`（块级元素口径）
- `TUI/docs/DESIGN.md`（如机制沉淀需要，按现有口径）
- 本追踪文档

明确不做：不引入新排版引擎；只扩既有 `assistantLineRows` 分类，不做行内 markdown 之外的解析扩展。

## 实现记录

（待写。）

## 偏差

（待写。）

## 测试与证据

（待写。）

## 收尾

（待写。）
