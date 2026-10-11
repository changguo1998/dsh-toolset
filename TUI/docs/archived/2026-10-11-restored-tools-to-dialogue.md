# 恢复的工具批改放会话区（接取条目：`TUI/docs/BACKLOG.md` 第 26 条）

状态：关闭（真机复核通过）　　开启：2026-10-11　　关闭：2026-10-11
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
- **回归用例已补**（2026-10-11）：`tests/pipeline-panes.test.ts` 的〈条目 26：历史节里的工具批进会话区〉——同一批工具条目，普通节 → 回合区；`history: true` 节 → 会话区（且不再进回合区）。13/13 通过。

## 审阅记录

（待补——真机复核后进行收尾审阅）

## 收尾

**真机复核通过（2026-10-11）**：用户确认「会话区工具结果行现在正常了」（工具批进会话区 + 结果带详情）；回合区不再满屏 `✓`。

同一轮真机复核还揪出并修掉两条相关缺陷（并入本次收尾）：

- **条目 27｜恢复的用户块恒 `?`**：共**五处叠加根因**，逐层定位（第四、五处靠临时诊断把「用了哪个源 / 事件数 / 回合边界数 / 有终态用户块数」写进 `tmp/restore-debug.log` 才看清）：
  1. live 事件源里没有 `turn/end` → 从持久源补（`0f83a5f`）；
  1. 宿主把用户输入记在 `turn/start` **之前**且不带 `turn` → 用户块挂到上一个回合，收尾永远匹配不上 → 用 `pendingUsers` 在 `turn/start` 时回填（`b5a1b76`）；
  1. 补持久源时优先 `readSurface` 而它对 live 会话是**空的** → 改两段式（空则退 `readSession`）（`3255995`）；
  1. 真机恢复实际走 **surface 分支**，而 surface fold **不含回合边界事件**（实测 `turnStart=0 / turnEnd=0`）→ surface 分支也并入回合边界（`dc65f12`）；
  1. 并入时**追加在数组末尾** → 51 个用户块全被判成回合 1 → 改按 `seq` 归位（`95c658d`）。
     最终真机数据：`turnStart=60 / turnEnd=60 / usersWithStatus=43`（余下 9 个是注入 / 频道 / goal 提示与正在跑的回合，本就没有终态）。诊断代码已在复核通过后删除。
- **条目 28｜工具结果详情恒空、失败也画 `✓`**：`toolResultDetail` 只认嵌套形态，真机是扁平 `message.content=[{type:"text",text}]`；失败标记在 `message.isError` 而代码只读 `data.error`。修后真机实测结果行为 `✓ <skill_content …>` 等带详情形态（`bfc9b93`）。

**归档**：本文件移入 `TUI/docs/archived/`；BACKLOG 移除「恢复出来的工具批改放会话区」「恢复的终态读不到」「工具结果详情恒空」三条。

**遗留**：无（`layout4` 等段 B/C 迁移在条目 16 的追踪文档里继续）。
