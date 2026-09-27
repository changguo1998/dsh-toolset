# /session 行内时间改显示编辑时间（BACKLOG: TUI#22）

状态：规划　　开启：2026-09-27
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`/session` 列表**行首时间**改显示**编辑时间**（`updatedAt`，缺失回退 `createdAt`），与列表排序（#1）、`/continue` / CLI `-c` 的选择口径一致。来源：2026-09-27 用户真机发现「活跃会话行内时间仍是 13:??（创建时间）」并裁定方案 A。

## 调研

- 现状：`src/app/components/HistoryPanel.ts` 的 `listLine` 用 `fmtTime(rec.createdAt)`；而排序用 `updatedAt`（TUI#1）→ 同一行两个时间口径不一致。
- 数据面已就绪：`SessionInfo.updatedAt?`（`adapter/types.ts`）由 `listSessionRecords` 填充（`listEvents` 末条 time，缺事件回退 `createdAt`）→ 无需改 adapter。
- 测试面：列表渲染用例（`tests/app.test.ts`「/session：列表渲染——当前 live 行…」）只断言标记与标题，无时间断言 → 补断言。
- 文档面：`README.md` 的 `/session` 行与 `docs/IMPLEMENTATION.md` 的「编辑时间与列表顺序」条目需同步。

## 决策

| # | 维度 | 选项 → 选定 | 理由 |
|---|------|------------|------|
| D1 | 行内时间口径 | 保留创建时间 / **改编辑时间（缺省回退创建时间）**（用户裁定 A） | 与排序、`/continue`、CLI `-c` 同口径；消除「活跃会话显示旧时间」的困惑 |
| D2 | 格式 | **不变**（`MM-DD HH:mm`） | 改动最小、列宽不变 |
| D3 | 标注 | 不加标注 | 时间即编辑时间，无需额外列宽 |

## 规划

计划改动文件清单（= 落点；计划外文件不改）：

- `TUI/src/app/components/HistoryPanel.ts`（行渲染 + 文件头/行注释）
- `TUI/tests/app.test.ts`（列表渲染用例：夹具补 `updatedAt` + 时间断言）
- `TUI/README.md`（`/session` 行）、`TUI/docs/IMPLEMENTATION.md`（编辑时间条目）
- `TUI/docs/BACKLOG.md`（#22 状态）
- 本追踪文档（关闭时移入 `TUI/docs/archived/`）

明确不做：不改排序 / 选择逻辑、不改别的面板时间显示、不做顺手优化。

## 实现记录

1. `src/app/components/HistoryPanel.ts`：`listLine` 时间改 `fmtTime(rec.updatedAt ?? rec.createdAt)`；文件头与 `listLine` 注释同步（行首时间 = 编辑时间，缺省回退创建时间）。
1. `tests/app.test.ts`：`/session：列表渲染…` 用例——夹具 s99 补 `updatedAt`（与 `createdAt` 不同），新增三条断言（显示编辑时间 / 不再显示创建时间 / 无 `updatedAt` 回退创建时间）。
1. 文档：`README.md`（`/session` 行）、`docs/IMPLEMENTATION.md`（编辑时间条目）补行内时间口径。

## 测试与证据

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run check` | 干净（0 error） |
| 全量单测 | `npm test` | **1172 pass / 0 fail** |
| 定向用例 | `npm test -- app.test.ts` | 165 pass / 0 fail（含新增时间断言） |
| 构建 | `npm run build` | 通过（dist 已刷新，重启 `dsh --profile fff` 即生效） |

## 收尾

- `TUI/docs/BACKLOG.md` #22 标「完成」；本追踪文档移入 `TUI/docs/archived/`。
- 真机目视：待用户重启 TUI 后打开 `/session` 确认行首时间（属批次行为人工确认清单的一项）。
- `STATUS.md` 不改（用户择时更新）。
