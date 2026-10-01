# steer 排队项认领进历史的标记：留白 + 上一条输入 `←`（接取条目：`TUI/docs/BACKLOG.md`「steer 排队项认领进历史时：与上一条输入之间空一行，且上一条输入的状态符号永久改为 `←`」）

状态：已完成　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

`<`（steer）排队项被核心认领、转入历史流时（`queued-claim-steer`）落两处标记：

1. 该 steer 输入与**上一条输入**之间**空一行**（仅 steer 适用；followup 认领是下一回合的自然续接，不加标记）。
1. **上一条输入**的状态符号**永久改为 `←`**——不再显示 ✓/✗/■/●/○/`?`，回合结束（turn-end）后也不恢复，表示「这条输入的回合被 steer 续接过」。

用户裁定（2026-10-01，三问三答）：`←` 标在**被 steer 续接的那条较早输入**上；空行**仅 steer 适用**；`←` **永久显示**。

## 计划改动文件清单

代码：

- `TUI/src/app/state.ts`：`BufferLine` 增 `spaceBefore` / `steerContinued`；新增 `markSteerClaim()`；`queued-claim-steer` 分支在落用户行后调用（followup 路径不变）。
- `TUI/src/app/layout.ts`：`userBlockSymbolResolver` 增 `←`（优先于终态与运行态）。
- `TUI/src/app/layout/build-box.ts`：用户块渲染时按 `spaceBefore` 在其上方留一个空行（渲染期留白）。

测试：

- `TUI/tests/steer-queued-display.test.ts`：新增两例——reducer 级（steer 认领打两标；followup / 会话首条不打标）与渲染级（`←` 出现在上一条输入行、steer 块与上一条输入之间有空行）。

文档：

- `TUI/docs/SPEC.md` §（语义 → 色名）：用户块状态符号表补 `←`；`TUI/docs/BACKLOG.md` 条目状态维护与收尾清理。
- 本文件。

## 设计

- **标记而不改文本**：两处标记都是 `BufferLine` 的布尔字段，历史行文本不动——`←` 由 `userBlockSymbolResolver` 在排版层给出（与既有 `USER_BLOCK_SYMBOL` 同源），留白由 `build-box.ts` 产一个空 `text("")` 叶子（`meta` 按 `kind:"plain"` 挂，避免被回复组分组逻辑当成用户块续行）。
- **不做 buffer 空行**：`appendStream` 的 P5 规则会丢弃异 kind 之后的纯空白分片，故留白不落在数据层；渲染期留白同时也避免影响滚动锚点与分块口径（#1）。
- **认领路径**：`markSteerClaim` 只在 `queued-claim-steer` 之后调用；`queued-claim`（followup）零改动。
- **无参照物不标**：会话首条输入即 steer（其上没有用户输入）→ 既不标 `←` 也不留白（验收 ④）。

## 验证

- `npm run check`（TUI 单包）：通过。
- `npm run test:tui`：见下（全量回归）；本次定向 `steer-queued-display.test.ts` **7 通过 / 0 失败**（含新增 2 例）。
- **真机验证项（待人工确认）**：① 运行中 `<` 模式提交 → 认领后历史区该输入与上一条输入之间空一行；② 上一条输入左侧状态符号显示 `←`，回合结束后仍为 `←`；③ followup 排队项认领不插空行、不改上一条输入符号；④ 会话首条即 steer 时不留白、不标符号。

## 过程记录

- 采用「渲染期留白 + 布尔标记」而非 buffer 空行：规避 P5 空白分片丢弃规则，且不动 #1 的分块口径与滚动锚点。
- `←` 颜色取默认前景（与 `?` 同口径）——`←` 表达「被续接」语义而非成败，故不入 `USER_BLOCK_SYMBOL` 的绿/红/灰语义色。
