# 工具结果 diff 摘要：`tool-result` 交付透传 `meta`（接取条目：`TUI/docs/BACKLOG.md` 的〈演示冒烟现状〉②）

状态：进行中　　开启：2026-10-12
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

工具结果行重新显示 diff 摘要 `(+N/-M)`（宿主 `tool/result` 的 `data.meta` 给 before/after 时）：`tool-result` 交付带上 `meta` → 节模型 `ToolResult` 透传 → `toolResultLine` 用 before/after 算摘要。真机（实时与恢复两条路径）与 demo 冒烟都能看到。

## 现状

- 旧缓冲路径本来就用 `data.meta` 算摘要（`adapter/dsh.ts` 工具结果分支传 `data.meta` 给 `toolResultLine`）；
- 六步流水线上，`BlockDelivery` 的 `tool-result` **没有 `meta` 字段** → `rows.ts` 只能调 `toolResultLine(ok, detail)` → 摘要永不出现（BACKLOG〈演示冒烟现状〉② 记的正是这条；demo 冒烟 `tool-meta-diff` 因此恒红）。

## 计划改动文件清单

- `TUI/src/app/layout/pipeline/types.ts`：`tool-result` 交付加 `meta?: { before?: string; after?: string }`；节模型 `ToolResult` 同步带该字段。
- `TUI/src/app/adapter/dsh.ts`：工具结果交付（实时线 + 恢复线两处）带上 `data.meta`。
- `TUI/src/app/layout/pipeline/sections.ts`：结果入批时透传 `meta`。
- `TUI/src/app/layout/pipeline/rows.ts`：`toolResultLine(ok, detail, meta)`。
- `TUI/tests/`：交付带 meta → 结果行含 `(+1/-0)` 的用例（含恢复路径）。
- 本文档 + `TUI/docs/BACKLOG.md`。

## 实现记录

（待补）

## 测试与证据

（待补）

## 审阅记录

（待补）

## 收尾

（待补）
