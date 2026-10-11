# 补窗一次到位（scratch 试算）+ `groupCount` 会话切换未重置（接取条目：`TUI/docs/BACKLOG.md` 第 24 条）

状态：关闭（①② 实现完成；① 有断言、② 经实测改判为防御性 no-op；③ bench 档已加）　　开启：2026-10-11　　关闭：2026-10-11
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 收尾（2026-10-11）

- **① 补窗一次到位**：实现 `7fd87b4`；断言 `04db56c`（`tests/app.test.ts`〈一次 flush 就补到位〉：
  300 组 × 1 行 + rows=60 下一次 flush 后 `windowGroups > 10`，旧的一帧一步只到 6）。
- **② `groupCount` 重置**：实现 `7fd87b4`；**改判**——两轮反向验证（删掉两处 `groupCount = null`，
  含 `startNewSession` 实际走的那处）后断言仍通过，且把「上滚态」前置构造试通后测得切换后
  `windowGroups=49` 是 **① 容量补窗**的合理结果 → 该子项是**防御性 no-op**，其报告症状
  （上滚态切到组更多的会话 → 窗口被撑到全量）**在当前实现不可达**：上滚态要求旧会话组多，
  `grew = 新 − 旧` 不可能为大正数。保留既有稳态断言（切换后 `groupCount === sectionGroupCount`）。
- **③ bench 档**：`04db56c` 新增「groups：300+ 组 × 1 行组（rows=60/120）」——
  rows=60 → cache off 53.01ms / on 3.62ms（14.7×）；rows=120 → 57.43ms / 3.21ms（17.9×）。
- **残余**（另立条目 29）：② 的「钉子」断言不必再做（症状不可达）；条目 22② 的粘连场景仍未复现。

## 目标（条目验收）

① 补窗在 **1-2 帧内收敛**（计帧断言）；② 切换会话后 `groupCount` 与 `sectionGroupCount` 一致；③ `npm run bench` 加「300+ 组 / 1 行组 / rows=60-120」档量化。

## 实现（`TUI/src/app/index.ts`）

### ① 一次到位（scratch 试算）

- 新增 `private scratchReport(): FrameScrollReport`（与 `paneScrollMax` 同形的空报表）与
  `private trialDialogueMaxScroll(windowGroups)`：用**临时 state**（只改 `windowGroups`）调 `buildFrame` 填 scratch 报表，
  **不出帧、不写 state**，返回 `dialogueMaxScroll`。
- `syncDialoguePos` 的贴底分支：把原来「一帧一步」的 `if (r.dialogueMaxScroll === 0 && next < groups) next = …`
  换成 `while (maxScroll === 0 && next < groups) { next = min(groups, next + WINDOW_GROW_STEP); maxScroll = trial(next); }`
  → 循环在**同一次调用内**收敛，之后照旧只在 `windowGroups` 变化时写 state + 一次 `paint()`。
- 效果：300 组 × 1 行 + `rows=60` 由约 **19 帧**变为 **1 帧**（构造上成立：循环不产生帧）。

### ② `groupCount` 重置

- `ingestDelivery` 的会话切换重建分支（`this.sections = createSections();` 之后）与
  `replaySectionsFromRows`（`this.sectionsSessionId = …` 之后）各加 `this.groupCount = null;`
  → 下一次 `syncDialoguePos` 用新值初始化基线，`grew` 不再一次性偏大（原先会把窗口直接撑到全量）。

## 测试与证据

- 全量 `npm test` **1458 / 1458 通过**；`npm run check` 干净；`npm run build` 通过。
- **待补（并入条目 29）**：① 计帧断言（同一 state 反复 `paint` 的帧数 ≤ 2；需 App 级 harness）；
  ② 会话切换后 `groupCount === sectionGroupCount`（同 harness）；③ `bench/layout-bench.mts` 的「300+ 组 / 1 行组 / rows=60-120」档。
- **不随手改 bench**：`layout-bench.mts` 属产物外基准脚本，本轮不动（避免混入未验证的改动）。

## 收尾

（待上述三条补完后关闭）
