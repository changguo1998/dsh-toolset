# TUI app-deps 依赖注释去重（接取条目：TUI/docs/BACKLOG.md「app-deps.ts 三处依赖注释重复写了两遍」）

状态：关闭　　开启：2026-11-09　　关闭：2026-11-09
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. `TUI/src/app/app-deps.ts` 里 `getPinNotes` / `getDaemon` / `getAgentGroup` 三个字段各只留一行注释。

## 调研

- `TUI/src/app/app-deps.ts:95-103`：三个字段各带两行一模一样的 `/** … */` 注释（`getPinNotes` 95-96、`getDaemon` 98-99、`getAgentGroup` 101-102）; TypeScript 把相邻 JSDoc 合并, 展示层只剩最后一段, 但源码噪音留着。
- 同处 `:92-93` 的 `getTaskEngine` 也是两行, 但内容不完全相同（第二行多「（结构化读取）」）——同一类合并残留, 只是没写成逐字相同。

## 决策

1. 三处逐字重复：保留第一行、删第二行（内容相同）。
2. `:92-93` 的近似重复一并合并为一行, 保留信息更全的「状态列 Task 块：任务引擎只读快照（结构化读取）。」——同文件、同类、零行为影响；超出条目字面列举的三处, 见「偏差」。
3. 不做其它格式整理。

## 规划

- 计划改动文件清单：`TUI/src/app/app-deps.ts`（第 92-103 行的注释）
- 明确不做：不动同文件其它注释与类型、不重排字段。
- 验证：`pnpm -C TUI run check`、`pnpm run test:tui`、`pnpm run check:docs`。

## 实现记录

- 2026-11-09：`app-deps.ts` 92-103 行的四对相邻注释合并为四行（`getTaskEngine` 保留带「（结构化读取）」的那句；`getPinNotes` / `getDaemon` / `getAgentGroup` 各留一行）。删除 4 行注释, 字段与类型零变化。

## 偏差

- 条目只列 `getPinNotes` / `getDaemon` / `getAgentGroup` 三处逐字重复；`92-93` 的 `getTaskEngine` 近似重复一并合并（同文件同类、零行为影响, 已在「决策」2 写明）。

## 测试与证据

- `pnpm -C TUI run check`：通过。
- `pnpm run test`（根, 38 包并行）：TUI **1877 例 / pass 1877 / fail 0**。
- `pnpm run check:docs`：通过（119 篇现行 Markdown / 959 个 .ts, 错误 0 / 警告 0）。
- 复读 `app-deps.ts:92-99`：四个字段各一行注释。

## 收尾

- BACKLOG 条目已移除；本文件移入 `TUI/docs/archived/`。
- 回写：无（注释清理, 不改能力面）。
