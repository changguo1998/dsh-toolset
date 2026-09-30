# Agents 条目改列表式悬挂对齐（续行与文字对齐）（接取条目：`TUI/docs/BACKLOG.md`「Agents 条目改列表式悬挂对齐（续行与文字对齐）」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

状态列 Agents 块条目换行时，**续行起点 = 首行文字起点**（跳过开头的符号 / 分隔符），与仓库既有 hanging 语义一致；首行仍按整幅宽。

## 调研

- 现状：`layout.ts#agentItemRows` 用 `wrapLine(text, width)` 折行——续行从 0 列起（与开头的 `● ` / `○ ` / `! ` 符号对齐）。用户真机确认（2026-10-01，第 3 条验证时指出）。
- 既有语义：`layout.ts#wrapWithHanging(text, width, hanging)`（BACKLOG 3.1.1 的底部 notice 视图用，与活动区 Box 的 hanging 一致）：首行按整宽、续行按 `width − hanging` 重折并补 `hanging` 空格 → 直接复用。
- 宽度口径：仓库 `displayWidth`（含 EAW 处理）——悬挂列取符号显示宽（`● ` / `○ ` / `! ` = 2 列），与折行口径自洽。

## 决策

1. `agentItemRows` 折行改用 `wrapWithHanging(text, width, displayWidth(sym))`：续行停在首行文字起点；不动符号 / 配色 / 文本内容（内容口径见「Agents 列表显示别名 + 工作内容」）。
1. 备选（未选）：在状态列层统一给所有块加悬挂——其它块形态不同，超出本条范围。

## 规划

计划改动文件清单（**只改这些**）：

1. `TUI/src/app/layout.ts`：`agentItemRows` 折行改 `wrapWithHanging`。
1. `TUI/tests/status-column-agents.test.ts`：新增「续行悬挂对齐」用例（窄宽折行 → 续行前缀 = 符号宽度空格、起点与首行文字列一致）。
1. `TUI/docs/BACKLOG.md`：条目「完成」标记与收尾清理。
1. 本追踪文档。

明确不做：不改符号 / 配色；不改行文本内容；不动其它块（标题 / 折叠提示）的折行。

## 实现记录

1. 2026-10-01 改 `layout.ts#agentItemRows`：折行 `wrapLine` → `wrapWithHanging(text, width, displayWidth(sym))`（续行缩进 = 符号显示宽，本例 2 列；首行仍整幅宽）；行文本 / 符号 / 配色未动。
1. 测试：`tests/status-column-agents.test.ts` 新增「续行悬挂对齐」用例（宽 20 折行 → 续行前导空格 = 首行文字列；首版用例误把列右框线填充行当续行，已加 `"│"` 终止判据）。

## 测试与证据

- 单测：`npm run test:tui -- status-column-agents.test.ts` → 8 pass / 0 fail（含新增用例）。
- 全量：`npm run test` → 16 包全绿（TUI 1228 / 0 fail）。
- 机械门禁：`npm run check` exit 0；`npm run build` exit 0。
- 真机确认（2026-10-01，点 3 前）：重启载入新构建 + 长命令验证子代理（条目折行）→ 用户目视 **通过**（续行缩进 2 列、对齐首行文字起点）。

## 收尾

- 回写：无需（行渲染口径为实现细节，`DESIGN.md` / `SPEC.md` 未描述该块折行；`/agents` 面板未变）。
- BACKLOG 清理：TUI 条目「Agents 条目改列表式悬挂对齐（续行与文字对齐）」已标「完成」（2026-10-01）并移除。
- 归档：本追踪文档移入 `TUI/docs/archived/`。
- 残留检查：`git status` 无计划外文件；`tmp/` 无任务临时文件。
- 遗留项：无。
