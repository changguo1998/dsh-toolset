# 活动区 step 分割线改为 step/start 时画（接取条目：`TUI/docs/BACKLOG.md`「活动区 step 分割线改为真分割线：`step/start` 时画」）

状态：规划　　开启：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

turn 区（原活动区）的 step 分割线改成**真分割线**：宿主 `step/start` 到达即画 `╌╌ hh:mm:ss #N ╌╌╌…`（`#N` = 步号、时间 = 事件时间），其后的思考/工具/正文都归入该步。**session 区（原历史区）不变**（resume 的 P9 折叠行口径照旧）。

## 调研

- 现状（惰性插头）：`state.ts:1020-1038` `appendStepToolLine`——在**该 step 的第一条工具行**到来时先插 `stepHeaderLine(step, time)`，再用 `headerEmitted` 标记避免重复；因此：只有含工具调用的 step 有线；线的位置由"第一条工具行"决定（思考/正文可能落在其上方）。
- 分组状态：`state.ts:2128-2141` `case "step"`——`step/start` 打开 `stepGroup`（含 `step`/`time`/`headerEmitted`），`step/end` 置 null。
- 渲染：`build-box.ts:181-201`（`isStepHeader` → `╌╌ <text> ` + tail `╌`）；`stepHeaderLine` 在 `layout/tool-line.ts:43`。
- 与 #3（session 区回合线格式）共用同族字形；与 #6（内容归属、buffer 行 step 标）共用"step 标"概念。

## 决策（2026-10-01 定稿）

1. `case "step"` 的 `phase === "start"` 分支**直接 append `stepHeaderLine(step, time)`**；`appendStepToolLine` 去掉惰性插头与 `headerEmitted` 字段（`stepGroup` 保留，供工具分组渲染使用）。
1. **每步都画**：含 step 1 与无工具调用的步。
1. step 行仍为 `kind: "tool"`，随 `turn-begin(clearActivity)` 清掉（现状不变）；它与「会话区回合分隔线」分属 turn 区 / session 区，不存在相邻冲突。

## 待确认

（无——已按上表定稿；后续新问题按需追加）

## 规划（计划改动文件清单）

1. `TUI/src/app/state.ts`：`case "step"` 直接产线；`appendStepToolLine` 去掉 `headerEmitted` 逻辑。
1. `TUI/tests/`：用例——`step/start` 立即产线（含无工具调用的 step）、`step/end` 不开新组、活动区清空语义不变。
1. `TUI/docs/SPEC.md`：step 线时机口径。

## 验收口径

真机：任意回合（含纯思考步、纯正文末步）在 `step/start` 时刻立即出现 `╌╌ hh:mm:ss #N`；同一 step 不重复画线；思考/正文不再落在线上方；resume 后 session 区折叠行与现状一致。
