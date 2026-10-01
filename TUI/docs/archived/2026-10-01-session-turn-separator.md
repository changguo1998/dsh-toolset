# 会话区回合分隔线格式（接取条目：`TUI/docs/BACKLOG.md`「会话区回合分隔线改用回合区 step 线的格式」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
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
1. 实现口径：`adapter/dsh.ts` 的 `turn/start` 由「忽略」改为转发 `{type:"turn-start", turn}`（现状注释见 `:17`）；`index.ts` 记录当前回合号并在 `beginTurnIfNeeded` 透传给 `turn-begin`；`time` 取落行时刻（宿主事件不带时间）。

## 实现记录

2026-10-01：

1. `state.ts`：`BufferLine` 增 `time?` / `turn?`（回合分隔线用）；`turn-begin` 动作增 `time?` / `turn?` 并透传给 `appendTurnSeparator`（已画的线按缺省补齐字段）；新增动作 `turn-number` + `numberTurnSeparator()` 从尾部回填最近一条分隔线的回合号（已有号不覆盖）。

1. `tool-line.ts`：新增 `turnHeaderLine(turn?, time?)` → `hh:mm:ss #N`（任一片段缺失即省略）。

1. `build-box.ts`：separator 分支改为 `╌╌ <label> ` + 尾部 `╌` 铺满；label 为空（旧会话 / mock）时退回纯线。

1. `adapter/dsh.ts` + `adapter/types.ts`：`turn/start` 不再被忽略，转发 `{type:"turn-start", turn}`；`index.ts` 收到后派发 `turn-number`，`beginTurnIfNeeded` 落线时带 `time: Date.now()`。

1. 测试：新增 `tests/turn-separator.test.ts`（标签降级、时间落行、回填与不覆盖、重复 turn-begin 不重复画线、渲染形态、退回纯线）；更新 `tests/app.test.ts` 的横线行计数（标签不再当内容）与 `tests/adapter.dsh.test.ts` 的 turn/start 期望。

1. 人工确认反馈：回合号标记由 `#` 改为 `⇆`（水平双箭头、左箭头在上；中间试过 `♺`，用户看效果后改定 `⇆`）——`╌╌ hh:mm:ss ⇆164 ╌╌`，与 step 线的 `#N` 区分；`turnHeaderLine` 降级口径不变（`⇆N` / `hh:mm:ss` / 空串）。

## 测试与证据

- `npm run check`（TUI 包 tsc）✓。
- **全量 `npm run test:tui` 1234/1234 pass**（含新增用例；无回归）。
- 待人工确认（真机）：会话区每个回合边界显示 `╌╌ hh:mm:ss #N ╌╌╌…`，与 turn 区 step 线视觉同款；断网/旧会话（无 turn/start）退回纯线。

## 验收口径

真机：session 区每个回合边界显示 `╌╌ <文本> ╌╌╌…`，与 turn 区 step 线视觉同款；无时间信息时降级规则明确；live 与 resume 表现一致（若 resume 也要线）。
