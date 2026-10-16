# 取消 pane 边界留白空行的竖线（接取条目：TUI/docs/BACKLOG.md「取消 pane 边界留白空行的竖线（会话区与回合区）」）

状态：关闭　　开启：2026-10-16　　关闭：2026-10-16
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

第 3 步（`pipeline/panes.ts`）插入的 pane 边界留白空行（会话区「用户块 → 正文」、回合区「思考 ↔ 正文」、steer 留白）保持**独立出行项**、**裸空行**：不继承相邻正文行的前导竖线段，不带任何前导竖线。会话区与回合区同口径。

不动：**块内**空行（同 kind 块内段落之间）的竖线连排（`build-box.ts` 的 `lineUpBlockBars`）、pane 末尾空行裁剪（`rows.ts` 收尾）、正文文本自身的前导 / 拖尾空行剥离（`rows.ts` 的 `itemLines`）。

## 调研

来源：代码与既有文档（用户 2026-10-16 真机观察触发）。

1. 会话区正文开头那一行空行不是文本空行：文本边缘空行已由 `pipeline/rows.ts:380-391`（`itemLines`）剥掉；用户看到的是 `panes.ts:235-240` 的 `userBlank` 留白（旧渲染器 `spaceUserAssistant` 口径，`build-box.ts:1083`）。
2. 该留白行带蓝色 `┃` 的原因：`pipeline/rows.ts:525-539` 的 `fillBoundaryBars`（`renderPane` 收尾，`:618-619` 调用）在「空行两侧的内容行都有竖线」时把**下一行**（正文首行）的前导竖线段整段复制到空行上（文字 + 样式）。这是 2026-10-10 条目「边界空行丢竖线」的裁定结果，固化在 `TUI/docs/SPEC.md:528`，回归 `tests/pipeline-frame.test.ts:322`、差异归一在 `tests/pipeline-equivalence.test.ts:195-215, 266-269, 293-317`。
3. 全仓引用面（`grep -rn "fillBoundaryBars\|BAR_TEXT\|boundaryBar"`）：生产代码只有 `pipeline/rows.ts`（`:513` 常量、`:525` 函数、`:557-558` 行号记账、`:619` 调用）；测试只有上述两处。
4. 空行的结构身份：留白空行是 pane 项 `{kind:"blank"}`（`panes.ts:191-195`），第 4 步在 `rows.ts:560-568` 直接出一行 `{segments: [], indent: 0, kind: "plain"}`，不经 `buildContentRows`。它本来就是独立出行项，与相邻 box 的文本无耦合；唯一让它「像正文」的是 `fillBoundaryBars` 补的那一段竖线。
5. 端到端影响面（改后由测试抛出）：`tests/layout4.test.ts:1371` 的帧级断言（会话区留白行内容为 `┃`）与 `tests/fixtures/focus-frame-legacy.json`（15 个焦点 / 面板场景的逐行基线，含 23 处该行的 `{text, ansi}`）也会随之变化，需同步。

## 决策

1. 边界留白空行是否挂竖线
   - a. 维持现状（2026-10-10 裁定：两侧都有竖线时继承下一行前导竖线）
   - b. 裸空行（不挂任何竖线）
   - **选定 b**（用户 2026-10-16 指令：留白空行作为独立 box，不加任何前导竖线，回合区也是）。理由：留白行的语义是「两块内容之间的间隔」，挂上正文竖线后视觉上等同于正文块向下延伸，与「文本边缘空行不渲染」的口径也容易混淆。
2. 块内空行（同 kind 块内段落之间）的竖线是否一并取消
   - a. 保留（`lineUpBlockBars` 连排不变）
   - b. 一并取消
   - **选定 a**。理由：用户指令限定「留白的空行」；块内空行属 box 内部段落间隔，不在本次范围（若也要取消，另开条目）。
3. 实现方式
   - a. 保留 `fillBoundaryBars` 结构、把复制段清空（改判据）
   - b. 删除 `fillBoundaryBars` / `blankRows` / `BAR_TEXT`，空行照 `rows.ts:563-568` 直接出行
   - **选定 b**。理由：行为回到「裸空行」后整段逻辑不再有消费者，留着是死代码。

## 规划

任务拆分（单批）：

1. 生产代码删竖线补段（`pipeline/rows.ts`）。
2. 测试改口径：边界空行断言改为裸空行；等价性用例删「已裁定差异」归一，恢复逐行严格一致；端到端帧断言与冻结基线同步。
3. 文档回写：`TUI/docs/SPEC.md:528` 改为取消口径（保留历史沿革一行）。
4. 收尾：BACKLOG 条目清理、追踪文档归档。

计划改动文件清单：

| 文件 | 改动 |
| --- | --- |
| `TUI/src/app/layout/pipeline/rows.ts` | 删 `fillBoundaryBars` 调用与函数体、`blankRows` 记账、`BAR_TEXT` 常量；更新相关注释 |
| `TUI/tests/pipeline-frame.test.ts` | 「边界空行带竖线」用例改为「边界空行不带竖线（两个 pane）」 |
| `TUI/tests/pipeline-equivalence.test.ts` | 删边界竖线差异归一（`isBarOnly` / `boundaryBarRows` / `withoutBoundaryBar` 与断言），改回严格逐行一致 |
| `TUI/tests/layout4.test.ts` | 帧级断言：会话区留白行为裸空行（原断言内容 `┃`） |
| `TUI/scripts/freeze-focus-frame.mts` | 追加一条重冻记录注释（说明本次为预期差异） |
| `TUI/tests/fixtures/focus-frame-legacy.json` | 重冻（`node --experimental-transform-types scripts/freeze-focus-frame.mts`）；勿跑 `format` |
| `TUI/docs/SPEC.md` | §边界空行口径改写（取消补竖线，留沿革） |
| `TUI/docs/BACKLOG.md` | 新增本条目（进行中）→ 关闭后移除 + 关闭记录 |
| `TUI/docs/implementation/2026-10-16-boundary-blank-bare.md` | 本追踪文档（新建）→ 关闭后移入 `archived/` |

明确不做：块内空行竖线连排、pane 末尾空行裁剪、`itemLines` 的前导 / 拖尾空行剥离、`build-box.ts` 的 `spaceUserAssistant`（旧回落路径的留白本身）。

## 实现记录

- 2026-10-16：建档（BACKLOG 新增条目「取消 pane 边界留白空行的竖线（会话区与回合区）」，标〔进行中〕）。
- 2026-10-16：`pipeline/rows.ts` 删除 `BAR_TEXT` / `fillBoundaryBars` / `blankRows` 记账与收尾调用；`renderPane` 的空行分支改为唯一出口（裸空行），pane 末尾空行裁剪保持在收尾。
- 2026-10-16：`tests/pipeline-frame.test.ts` 用例改为断言边界空行 `segments` 为空、相邻行仍带竖线；`tests/pipeline-equivalence.test.ts` 删除边界竖线差异归一工具与断言，会话区改回严格逐行一致。
- 2026-10-16：首次全量回归暴露 14 个失败（13 个 `focus-frame 基线：*` + `layout4.test.ts` 的会话流用例）——均为本次预期差异：留白行由「纯 `┃` 段」变「无段」。据此同步 `tests/layout4.test.ts:1387` 断言，并跑冻结脚本重刷 `tests/fixtures/focus-frame-legacy.json`（15 场景，diff = 23 处 `{text, ansi}`，全部是去掉 `┃` 与对应 ansi 段）。

## 偏差

1. 用户指令原文为「留白的空行作为独立的 box」；实现上留白空行仍是 **pane 边界项**（`{kind:"blank"}`）而非 Box 树节点——它本来就独立出行（不经 `buildContentRows`、不并入相邻 box 文本），本次只取消其竖线；把边界项改造成 Box 节点会牵动第 3 / 4 步的段键与行数表，且对可见结果无影响，故未做（若确需结构层变更，另开条目）。
2. 计划改动文件清单原列 6 项，实际为 9 项：新增 `tests/layout4.test.ts`、`scripts/freeze-focus-frame.mts`、`tests/fixtures/focus-frame-legacy.json`（均为端到端帧断言与冻结基线的同源改动，由首次全量回归发现，属本次变更的必要同步，未越出条目范围）。

## 测试与证据

- `npm run check`（TUI，`tsc --noEmit`）：通过（无输出）。
- `npm test`（TUI 全量，`scripts/test.sh`）：**1627 用例全绿**（与改动前同量；改动中首轮 14 例失败 → 同步断言与夹具后归零）。
- `npm run build`（TUI）：通过。
- `npm run demo -- --smoke`：`SMOKE_OK`（含 `SMOKE_PASS preset-badge` / `jobs-panel` / `jobs-kill`）。
- 定向回归：
  - `tests/pipeline-frame.test.ts`「边界空行不带竖线」：会话区留白行 `segments` 为空、上一行（用户块）行尾仍有 `┃`、下一行（正文首行）仍有前导 `┃`；回合区留白行同样为空（期望序列 `["<step>", "┃（先想）", "", "┃中间正文"]`）。
  - `tests/pipeline-equivalence.test.ts`：宽 40 / 80 / 120 下会话区与旧路径**逐行严格一致**（不再需要「已裁定差异」归一）。
  - `tests/fixtures/focus-frame-legacy.json`：`git diff --stat` = 46 insertions / 46 deletions（23 处 `{text, ansi}`，仅去掉 `┃`）。
- 真机目视（`dsh --profile fff`）未做：profile symlink 指向主检出，需合并后生效。

## 收尾

- 回写：`TUI/docs/SPEC.md`（§边界空行口径改为「留白空行不带竖线」，保留 2026-10-10 沿革）；`TUI/docs/BACKLOG.md`（条目标完成并移除 + 关闭记录）；`scripts/freeze-focus-frame.mts`（重冻记录）。
- 遗留：无（块内空行竖线连排按决策 2 保留；`pane` 边界项结构不变，见「偏差」1）。
- 归档：本文件移入 `TUI/docs/archived/2026-10-16-boundary-blank-bare.md`。
