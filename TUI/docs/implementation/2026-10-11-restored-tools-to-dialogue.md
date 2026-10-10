# 恢复的工具批改放会话区（接取条目：`TUI/docs/BACKLOG.md` 第 26 条）

状态：进行中（实现完成，待真机复核）　　开启：2026-10-11　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

恢复出来的工具批（调用行 + 结果行）渲染在**会话区**，不再铺满回合区；实时路径不变（进行中的工具仍归回合区）。

## 调研（为什么之前 0 行）

1. 路由判据在 `pipeline/panes.ts` 的 `isDialogue(box, final)`：原来只认「用户块」与「`final` 的 assistant 正文」→ 工具批一律进回合区。
1. 节上的 `final` 是「回合最终总结节」标记（`turn-end` 时打），**不是**「历史行」标记。
1. 2026-10-11 实测（先给工具行补 `final`、再给节加 `history`）：工具项确实进了会话区（探针：会话区 992 项含 `tool批=702`），**但渲染出来 0 行**。
1. 根因：`layout/build-box.ts` 的 `flushToolRun` 把整批工具节点**无条件** `activityLeaves.push(...)`，无视 `:406` 的 `line.final ? dialogueLeaves : activityLeaves` 分流 → 工具批永远落在活动区叶数组，会话区那一遍直接丢弃。

## 决策

- 新增**节级** `history: true`（恢复重放产出 = 整节都是历史），不挪用 `final` 的语义。
- 工具批的落点由**首行的分流**决定（`runTarget`），`flushToolRun` 推 `runTarget ?? activityLeaves`。
- 会话区渲染只留「历史行」：历史节的工具行按 `final` 上屏（`rows.ts` 的工具分支）。

## 规划改动文件清单

`TUI/src/app/layout/pipeline/types.ts`（`Section.history`）、`TUI/src/app/layout/pipeline/replay.ts`（`sectionsFromBuffer(rows, {history})`）、`TUI/src/app/layout/pipeline/boxes.ts`（`BoxBase.history` + 透传到子盒）、`TUI/src/app/layout/pipeline/panes.ts`（`isDialogue` 认工具 + 调用点传 `history`）、`TUI/src/app/layout/pipeline/rows.ts`（历史节的工具行带 `final`）、`TUI/src/app/layout/build-box.ts`（`runTarget`）、`TUI/src/app/index.ts`（恢复入口传 `{history:true}`）。

## 实现记录

- 2026-10-11：按上表全部落地（7 个文件）。
  - `types.ts`：`Section.history?: true`。
  - `replay.ts`：`sectionsFromBuffer(lines, opts?: {history?: boolean})`，重放结束后把 `sections` / `current` 整节标 `history`。
  - `boxes.ts`：`BoxBase.history?: true`；`buildBoxes` 对历史节的块与子盒透传该标记。
  - `panes.ts`：`isDialogue` 放行 `final`（或历史）节里的 `tool`；调用点改传 `section.final === true || section.history === true`。
  - `rows.ts`：工具分支对「会话区 + 历史盒」的行加 `final: true`（会话区只留历史行）。
  - `build-box.ts`：批落点 `runTarget`（首行分流时定，批结束时清），`flushToolRun` 推 `runTarget ?? activityLeaves`。
  - `index.ts`：`replaySectionsFromRows` 调 `sectionsFromBuffer(rows, { history: true })`（只影响恢复入口，实时不动）。

## 测试与证据

- 真机日志探针（`tmp/probe-item25b.ts`，未入库；数据源 = 本会话 `session.v4.jsonl.zstd` 解压后）：
  - 改前：会话区 `tool批=0`、回合区 `tool批=793` / 带 `✓` 行 903。
  - 改后：**会话区 `tool批=793`、带 `✓/✗` 行 986**；**回合区 `tool批=0`、带 `✓` 行 0**（只剩 `step-head=29` 与 `notice=30`）。
- 全量 `npm test`：**1445 / 1445 通过**；`npm run check` 干净；`npm run build` 通过。
- 待补：帧级回归用例（「恢复的工具行在会话区列区间可见、在回合区列区间不可见」）——下一轮补，并在真机复核通过后随收尾一起提交。

## 审阅记录

（待补——真机复核后进行收尾审阅）

## 收尾

（待补——需真机复核：重启后回合区不再满屏 `✓`，工具批出现在会话区）
