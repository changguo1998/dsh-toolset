# 会话区回合分隔线格式（接取条目：`TUI/docs/BACKLOG.md`「会话区回合分隔线改用回合区 step 线的格式」）

状态：规划　　开启：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

session 区（原历史区）的**回合分隔线**采用 turn 区（原活动区）step 线的格式：`╌╌ <文本> ` + 尾部 `╌` 铺满。

## 调研

- 现状：`state.ts:183` `TURN_SEPARATOR = "--------"` 仅作 buffer 内的标记文本；`appendTurnSeparator`（`state.ts:1136-1167`）落 `{ text: TURN_SEPARATOR, kind: "separator" }` 行，**不带时间/回合号字段**；渲染在 `build-box.ts:427-433`：`styled([], { tail: { char: "╌" } })` → 整行 `╌` 铺满、**无文本**。
- 对照：turn 区 step 线渲染在 `build-box.ts:189-191`：`styled([{ text: "╌╌ " + stepHeaderLine(step, time) + " " }], { tail: { char: "╌" } })`；`stepHeaderLine`（`tool-line.ts:43`）= `hh:mm:ss #N`（无时间时 `#N`）。
- resume 折叠路径（P9，`adapter/dsh.ts:299-377`）产出的是 step 摘要行，**不含回合分隔线**（待实现时复核）。

## 决策（2026-10-01 定稿）

1. 回合线文本 = **时间 + 回合号**（`hh:mm:ss #N`，`N` = 回合号），与 step 线同族。
1. `separator` 行补 `time` 与 `turn` 字段：`appendTurnSeparator` 落行时取事件时间（`turn-begin` 侧提供）；`TURN_SEPARATOR` 标记语义不变。
1. 渲染在 `build-box.ts` 的 separator 分支加 `╌╌ <文本> ` 前缀 + 尾部 `╌` 铺满（与 step 线共用格式化函数）。
1. resume 折叠路径（P9）不含回合线，**保持现状（仅 live）**；若后续要补，另开条目。

## 待确认

（无——已按上表定稿；后续新问题按需追加）

## 规划（计划改动文件清单）

1. `TUI/src/app/state.ts`：`appendTurnSeparator` 落 `time`（+ 可选 `turn`）字段；`TURN_SEPARATOR` 标记语义不变。
1. `TUI/src/app/layout/build-box.ts`：separator 分支加前缀与文本（复用 `stepHeaderLine` 或同族格式化函数）。
1. `TUI/src/app/layout/content-rules.ts`：如需要，抽出共用前缀/字形常量。
1. `TUI/tests/`：separator 渲染用例（有无时间的降级）。
1. `TUI/docs/SPEC.md`：分隔线规格。

## 验收口径

真机：session 区每个回合边界显示 `╌╌ <文本> ╌╌╌…`，与 turn 区 step 线视觉同款；无时间信息时降级规则明确；live 与 resume 表现一致（若 resume 也要线）。
