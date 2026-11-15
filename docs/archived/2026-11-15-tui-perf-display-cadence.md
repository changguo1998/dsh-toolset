# TUI 性能读数显示节奏调整（接取条目：docs/BACKLOG.md「TUI 性能读数显示节奏调整」）

状态：已完成　　开启：2026-11-15　　关闭：2026-11-15
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

状态行「首字节延时（TTFB）+ 解码速率（t/s）」两个读数的显示节奏调整，用户 2026-11-15 提出的两点要求：

1. **计算与显示分离**：计算可以随每条 chunk 快速做（保持实时累积），但显示仍每秒更新一次。
2. **统计频率降到每秒一次**：速率 = 本 1 秒窗口内产出的总 token ÷ 1s（不再是「首块以来累计平均」）。

## 现状（调研结论）

- 数据流：`agent/assistant-stream` 每条 chunk → `dsh-events.ts` `onAssistantFrame` 累积 `stepPerf`（`firstChunkTime` + `estTokens`）→ `emitLivePerformance` 按 `LIVE_PERF_MIN_MS`（当前 250ms）节流投递 `performance` 事件 → wiring 直通 reducer `case "performance"` → `paint()`（帧率上限 10Hz）。
- 即当前「计算」与「显示」同 250ms 节律：流式时数字每秒最多变 4 次。
- 速率口径（`perf.ts` `perfReadingOf`）：`est ÷ (now − firstChunkTime)`，即首块以来累计平均；首块后不足一个节流窗口记 0。
- TTFB 口径：`firstChunkTime − step 起点`（实测近似值），首块到达即投递，该步收尾归零（`assistant/message` 处投 `0 / 0`）。
- 收尾归零与非流式回落（无 chunk 时给平均）已存在，不在本任务改动面。

## 决策

- 决策项 1 = 实现位置 = **adapter 侧节流 + 采样（a）**：不改 wiring / reducer / 状态行渲染，只改 `perf.ts` 常量与口径、`dsh-events.ts` 的 `emitLivePerformance` 采样写回。显示频率由投递节流直接决定（投递节流 = 显示节流），不新增定时器、不新增 App→adapter 拉取面。
- 决策项 2 = 显示节流 = **`LIVE_PERF_MIN_MS` 250 → 1000**：每秒最多投递一次 `performance` → 数字每秒最多更新 1 次，与状态行 1s 节律一致。
- 决策项 3 = 速率口径 = **窗口采样（b）**：`stepPerf` 增 `lastSampleAt` / `lastSampleTokens`；每次投递时速率 = `(estTokens − lastSampleTokens) ÷ ((now − lastSampleAt)/1000)`（≈ 每秒产出 token 数），随后写回采样点。首块首次投递无上一采样 → 速率 0（不足 1s 数据，如实显示）。TTFB 口径不变。
- 明确不做：不改渲染槽位（`status-line.ts` `performanceText`）；不改收尾归零；不改非流式回落；不做严格时钟对齐的 1Hz 定时采样（投递节流即 1s，事件驱动投递在客流正常时即约 1Hz）；不动 STATUS.md（用户择时更新）。

## 计划改动文件清单

- `docs/BACKLOG.md`（条目标进行中 / 完成）
- 本追踪文档
- `TUI/src/app/adapter/perf.ts`（`LIVE_PERF_MIN_MS = 1000`；`StepPerf` 增 `lastSampleAt` / `lastSampleTokens`；`perfReadingOf` 速率改窗口口径）
- `TUI/src/app/adapter/dsh-events.ts`（`emitLivePerformance`：计算读数后写回采样点）
- `TUI/tests/adapter.dsh.test.ts`（B1 用例按新速率口径改断言；新增「1s 节流：窗口内多条 chunk 只投一次 / 跨秒投第二次且速率为 Δtoken/1s」用例）
- `TUI/docs/COMMANDS-SPEC.md`（`state.performance` 口径同步：投递 1s 节流 + 速率窗口口径）

## 实现记录（2026-11-15）

- **`perf.ts`**：`LIVE_PERF_MIN_MS` 250 → 1000；`StepPerf` 增 `lastSampleAt` / `lastSampleTokens`；`perfReadingOf` 速率改为窗口口径 `Δest ÷ Δt`（首投无上一采样记 0，`est=0` 时记 0，负值钳 0）。
- **`dsh-events.ts`**：`emitLivePerformance` 在节流放行后把采样点写回（`lastSampleAt/now`、`lastSampleTokens/estTokens`），注释同步 1s 节流口径。收尾归零与非流式回落的既有路径未动。
- **测试**：`adapter.dsh.test.ts` 的 B1 用例重写（首投 TTFB=100 速率 0 / 工具内容在窗口内只累计不新投 / 跨秒第二投速率为 Δtoken/Δt / 收尾归零）；新增 B2 用例（窗口速率 vs 累计平均判定：第三投窗口速率 ≈54.5 显著高于累计平均 ≈34.8，可区分两种口径；窗口内不新投；收尾归零）。
- **文档**：`TUI/docs/COMMANDS-SPEC.md`（`state.performance` 口径：1s 节流 + 窗口速率）、`TUI/README.md`（LLM 组性能槽位口径同改）。

## 验证记录

- `pnpm run test:tui -- adapter.dsh.test.ts`：通过（该文件含新 B1/B2）。
- `pnpm run test:tui`：**1892 例全过**（原 1891 + 新增 B2 1 例；B1 重写、既有 1890 例无退化）。
- `pnpm run check`（全仓 41 包 tsc）：退出 0。
- `pnpm run build`（全仓 41 包）：41 OK / 0 FAIL。
- `pnpm run check:docs`：122 篇现行 Markdown / 1002 个 .ts，错误 0 / 警告 0（`perf.ts` 注释引用的追踪文档路径同步为归档路径）。

## 收尾

- 追踪文档归档到 `docs/archived/2026-11-15-tui-perf-display-cadence.md`。
- `docs/BACKLOG.md` §2 条目移除，§1 完成索引补记录（含提交号）。
- 残留：`docs/STATUS.md` 由用户择时更新（本任务不涉及）。
