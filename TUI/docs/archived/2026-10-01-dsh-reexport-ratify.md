# `adapter/dsh.ts` 类型转出补入的追认（接取条目：`TUI/docs/BACKLOG.md`「`adapter/dsh.ts` 类型转出补入的追认」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

对「rule-engine 的用户提示应显示在活动区」实现期在 `TUI/src/app/adapter/dsh.ts` 补入的 `RuleEngineLike` / `RuleEngineNotice` 转出做追认：保留（不改代码）或改为消费侧直接导入。

## 调研

- 现状：`TUI/src/app/adapter/dsh.ts` 第 162-163 行在既有 re-export 块里导出 `RuleEngineLike` / `RuleEngineNotice`（实现期补入 1 行；已记入该任务追踪文档 `docs/archived/2026-10-01-warn-display-channel.md`）。
- 消费侧：`TUI/src/app/index.ts`（第 40 行导入，用于 `getRuleEngine` / `ruleEngineService` / `ruleEngine()`）与 `TUI/src/main.ts`（第 63 行）——与 app 层「adapter 面统一从 `dsh.ts` 取」的既有惯例一致。
- 备选（不认可时）：消费侧改为自 `./adapter/types.ts` 直接导入，并删该转出（多改 2 个文件）。

## 决策

1. **追认保留**（用户 2026-10-01 接取本条 = 裁定保留）：与既有导入惯例一致、避免同一类型出现两条导入路径；**在转出处补注释说明原因**（用户追加要求「补充注释解释为什么这么写」，见实现记录）。
1. 备选（未选）：改为直接导入——多改 2 个文件，收益仅少 1 行转出。

## 规划

计划改动文件清单（**只改这些**）：

1. `TUI/docs/BACKLOG.md`：条目「完成」标记与收尾清理。
1. 本追踪文档。

明确不做：不改消费侧导入；不动类型面本身（转出处注释为追认后按用户要求新增，见实现记录）。

## 实现记录

1. 2026-10-01 在 `TUI/src/app/adapter/dsh.ts` 的 `RuleEngineLike` / `RuleEngineNotice` 转出处补 2 行注释（用户追加要求「补充注释解释为什么这么写」）：说明「规则提示的消费面（app / main）统一从 adapter 面取类型，避免同一类型出现两条导入路径」+ 追认出处（本追踪文档）。类型面本身未动。

## 测试与证据

- 机械门禁：`npm run check` exit 0（纯注释改动，类型面与行为不变）。
- 佐证现状：`adapter/dsh.ts` 第 162 行起转出；消费侧 `index.ts` 第 40 行、`main.ts` 第 63 行（见调研）。

## 收尾

- 回写：无需（转出惯例无需新增 DESIGN 口径）。
- BACKLOG 清理：TUI 条目「`adapter/dsh.ts` 类型转出补入的追认」已标「完成」（2026-10-01）并移除（空章节「实现遗留」一并清理）。
- 归档：本追踪文档移入 `TUI/docs/archived/`。
- 残留检查：`git status` 无计划外文件；`tmp/` 无任务临时文件。
- 遗留项：无。
