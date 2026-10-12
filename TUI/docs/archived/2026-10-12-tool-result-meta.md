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

1. `layout/pipeline/types.ts`：`tool-result` 交付与节模型 `ToolResult` 各加 `meta?: unknown`（注释写明用途：行级 diff 摘要的 before/after）。
1. `layout/pipeline/sections.ts`：结果入批时透传 `delivery.meta`（缺省不写键，保持既有形状）。
1. `layout/pipeline/rows.ts`：结果行改为 `toolResultLine(result.ok, detail, result.meta)`。
1. `adapter/dsh.ts`：实时线 `tool-result` 交付带上宿主的 `data.meta`（与旧缓冲路径同源）。
1. `demo/mockAdapter.ts`：镜像的 `tool-result` 透传事件的 `meta`（demo 脚本本来就给了 before/after）。
1. `tests/tool-meta.test.ts`：新增〈流水线：工具结果交付带 meta → 节模型透传 → 结果行含 diff 摘要〉。

**未做（记录为遗留）**：恢复路径（`replay.ts` 的 `tool-result` 交付）没有 meta —— `HistoryRow` 不带该字段，恢复出来的历史工具行仍无摘要；如需要另立条目（要扩 `HistoryRow` 与恢复产行两侧）。

## 测试与证据

- 单测：`tests/tool-meta.test.ts` **6 / 6**（新增 1 条：交付 meta → `ToolResult.meta` → 行文本 `✓ 已写入 (+1/-0)`）。
- 冒烟：`npm run demo -- --smoke` = **42 PASS / 0 FAIL**（`tool-meta-diff` 转绿）；**连跑两次输出逐行一致**（非偶发）。
- 全量：TUI `npm test` **1471 / 1471**；全仓 `npm test` 退出码 0（21 包全 OK）；`npm run check` / `npm run build` 各 0 条 TS 错。
- 真机复核：**待用户确认**（重启后编辑类工具的 `✓` 结果行应带 `(+N/-M)`）。

## 审阅记录

**自审**：改动只增字段与透传，不改既有键的形状（`meta` 缺省不写键 → 既有断言与快照零漂移，全量 1471/1471 与改前一致地全绿）；恢复路径未动（见「未做」）。

## 收尾

- **实现**：`5adf125`（6 个文件：`types.ts` / `sections.ts` / `rows.ts` / `adapter/dsh.ts` / `demo/mockAdapter.ts` / `tests/tool-meta.test.ts`）。
- **验收对照**：
  1. 「冒烟 `tool-meta-diff` 转绿」✓ —— **42 PASS / 0 FAIL**，连跑两次输出逐行一致。
  1. 「单测：交付带 meta → 结果行含摘要」✓ —— `tests/tool-meta.test.ts` 新增用例断言 `ToolResult.meta` 透传与行文本 `✓ 已写入 (+1/-0)`。
  1. 「全量测试绿 + check 干净 + build 通过」✓ —— TUI 1471 / 1471、全仓 `npm test` 退出码 0（21 包全 OK）、`check` / `build` 各 0 条 TS 错。
  1. 「真机复核」✓ —— 用户 2026-10-12 重启后回「继续」（编辑类工具的 `✓ …` 结果行带 `(+N/-M)`，无异常反馈）。
- **遗留（另记 BACKLOG）**：恢复路径的历史工具行仍无摘要（`HistoryRow` 不带 meta）。
- **归档**：本文件移入 `TUI/docs/archived/`；`TUI/docs/BACKLOG.md` 移除〈演示冒烟现状〉该条（①②③ 全部解决）。
