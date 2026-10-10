# 边界空行带竖线（接取条目：`TUI/docs/BACKLOG.md`「边界空行丢竖线」）

状态：关闭　　开启：2026-10-10　　关闭：2026-10-10
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

pane 边界空行（回合区 / 会话区正文块之间的那一行）在**两侧内容行都带竖线**时补上同样的竖线段，使正文块之间的分隔不把竖线切断；两侧没有竖线时维持裸空行不变。

## 调研

- 复现（探针 `tmp/probe2b.ts`，交付流：`user 第一问` + `reasoning（先想）` + `final assistant 中间正文`，宽 60）：
  - 会话区行 = `[separator]` / `[user] "…第一问" + "┃"@brightRed`（右缘）/ `[plain] (empty)` / `[assistant] "┃"@brightBlue + 中间正文`。第 3 行就是本条目说的边界空行：`segments: []`。
  - 回合区行 = `[tool]` step 头 + `[thinking] "┃"@brightMagenta + （先想）`（本次语料的 assistant 是 final，故不进回合区）。
- 边界空行**不是** box 层产物：它由 `panes.ts` 的 `blank()` 插入（`userBlank` = 会话区「用户块 → 正文」、`pairBlank` = 回合区「思考 ↔ 正文」、steer 留白），到行层时是 `item.kind === "blank"`；`rows.ts:492-497` 给它 `{ segments: [], indent: 0, kind: "plain" }`。
- **块内**空行的竖线已有机制：`build-box.ts` 的 `lineUpBlockBars()`（kind `user` / `assistant` 的空行若其后还有同 kind 则补 prefix/suffix）。同一条正文里的段落空行（文本内 `\n\n`）实测**已带** `┃`（探针 `tmp/probe2c.ts` 第 4 行 = `"┃"@brightBlue`，kind assistant）——即本缺陷只在 pane 边界的空行上，块内不缺。
- 竖线的表示：`fill.ts` 把 `prefix` / `suffix` 逐行展开成段（`decorateRows`，`:271-292`）；全仓竖线字形只有 `┃`（`build-box.ts` 五处 prefix + 用户块右缘 suffix；`table.ts` 的左缘 `┃`）。故「有竖线」= 行段里存在 `┃`（前导或行尾）。
- 旧路径（`build-content-rows` 的缓冲输入）对这类边界空行同样不给竖线：`spaceUserAssistant()`（`build-box.ts:867-881`）插的空行节点是纯 `styled([{text:""}])`。**故本条目是口径变更（不是流水线回归）**，`tests/pipeline-equivalence.test.ts` 的「新旧逐行一致」断言会因此产生一处**已裁定差异**（会话区该空行多一个 `┃` 段），需在该测试里显式登记。

## 决策

- **D1 判定层次**：在行层 `renderPane()` 收尾处做（`rows.ts`）——边界空行只在 pane 项里存在，box 层看不到邻居（`lineUpBlockBars` 的输入是同一 box 的叶子列表）。
- **D2 判定条件**：空行的**上一行**与**下一行**都含竖线段，且**下一行**的竖线是**前导**段（`┃` 起首）时，空行取该前导段（文字 + 样式原样复制）。仅一侧有竖线、或下一行竖线只在行尾（如 steer 留白两侧都是用户块右缘竖线）时维持裸空行。
- **D3 取值来源**：取**下一行**（正文块的首行）的竖线，不取上一行——会话区里上一行是用户块的**行尾**红竖线，取它会把用户块向下延伸一行；取下一行则读作「正文块自这一行起」。
- **D4 样式与门限**：复制段对象（含 `style`），不重新套用 `minWidth` 门限——相邻内容行已按自己的门限决定是否画竖线，空行只跟随结果，避免在窄宽下出现「内容行无竖线、空行有竖线」。
- **D5 明确不做**：不改块内空行机制（`lineUpBlockBars`）与全空正文段丢弃（上一条目刚落）、不改 pane 末尾空行裁剪（`renderPane` 收尾）、不给 step 头 / 工具批 / 回合分隔线附近造竖线。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout/pipeline/rows.ts`（`renderPane()`：记录空行下标 + 收尾补段）。
- tests：`TUI/tests/pipeline-frame.test.ts`（交付驱动：会话区「用户块 → 正文」与回合区「思考 ↔ 正文」两种边界空行都带 `┃`；steer 留白 / 无竖线邻居保持 `segments: []`）；`TUI/tests/pipeline-equivalence.test.ts`（登记本条目引入的已裁定差异，逐行断言仍生效）。
- 文档：`TUI/docs/BACKLOG.md`（进行中 → 完成，收尾时移除条目）；`TUI/docs/SPEC.md`（空行竖线口径一行）。

**规划修正（实现期，2026-10-10）**：全量回归暴露两处**期望类**测试因本行为变更而失败，按「不得只改代码、期望要随口径走」处理，追加进清单：

- `TUI/tests/layout4.test.ts`（「会话流：用户块与回答/思考之间恰有一行空行」——该空行现在带 `┃`，期望随口径更新）。
- `TUI/tests/fixtures/focus-frame-legacy.json`（冻结基线，用既有生成脚本 `TUI/scripts/freeze-focus-frame.mts` 重跑；该脚本「一次性工具、新增场景须双处同步」，历史上随渲染口径变更重跑过多次）。

明确不做：不改旧路径 `buildContentRows` 的空行行为；不动 `frame.ts` / `panes.ts`；不为该行为加开关。

## 实现记录

- 2026-10-10：
  - `rows.ts`：`renderPane()` 空行分支记 `blankRows`（空行仍先产出裸空行，形状与旧口径一致，缓存 / 段键 / 行数表均不动）；循环后加「收尾 1」`fillBoundaryBars(rows, blankRows)`，**在 pane 末尾空行裁剪之前**（尾部空行没有「下一行」→ 仍是裸空行 → 照旧被裁）。
  - `fillBoundaryBars()` 判定：上一行**任一段**是竖线（`/^┃+$/`，前导或行尾皆算）且下一行**前导段**是竖线 → 空行替换为 `{ segments: [{ ...下一行前导段 }], indent: 0, kind: "plain" }`（文字 + 样式原样复制，不重判 `minWidth`）。字形集合按 D6 收窄为 `┃`（原 `[┃│]` 的 `│` 属误扩，见决策）。
  - 探针反验：`tmp/probe2b.ts` 改动前会话区空行 `[plain] (empty)`，改动后 `[plain] "┃"@brightBlue`。
  - 期望类测试同步：`tests/layout4.test.ts`（`histContent` 期望 `""` → `"┃"`，文案说明竖线延续）；冻结基线重跑 `node --experimental-transform-types scripts/freeze-focus-frame.mts`（15 场景，diff = 23 行 × (text + ansi)，逐条核对**全部**是边界空行多一个 brightBlue `┃`，无其它变化）。

## 测试与证据

- 新增用例（`tests/pipeline-frame.test.ts`「边界空行带竖线」，交付驱动）：① 会话区「用户块 → 正文」空行 = `┃` 且断言语义 = 下一行前导段（文字 + 样式）；② 回合区「思考 ↔ 正文」同理；③ 反例：空行上一行是 step 头（只有一侧有竖线）→ `segments: []`；④ 反例：steer 留白两侧竖线都在行尾 → `segments: []`。
- **反向验证**（`git stash push TUI/src/app/layout/pipeline/rows.ts`）：新用例在改动前失败（`AssertionError: 会话区边界空行带竖线（裸空行 → 竖线段）`）；`tests/pipeline-equivalence` 的「已裁定差异」断言同样在改动前失败（纯竖线行数 0 ≠ 2）→ 改动后两处均通过。
- 全量：`npm test`（TUI）**1424 / 1424 通过**（改动前基线 1423 + 本条目 1）；`npm run check` 干净；`npx tsc --noEmit --noUnusedLocals` 0 条；`npm run build` 干净。
- 已裁定差异（写进 `tests/pipeline-equivalence.test.ts`）：新旧路径逐行比较对**可归因行**（新侧纯竖线行且旧侧同行为空）归一成空行，并用「新侧可归因行下标 == 各用户块末行下标 + 1」逐点 deepEqual **钉死位置**，另逐处断言竖线段 == 下一行前导段（文字 + 样式）。旧路径 `spaceUserAssistant()` 插的空行本就无竖线 → 属**口径变更**而非流水线回归；块内空行（两侧都是纯竖线行）不参与归一，不会掩盖差异。
- 期望类既有测试的 16 项失败（实现前审阅实跑确认范围）：`tests/focus-frame.test.ts` 15 个场景（冻结基线逐行 text/ansi）+ `tests/layout4.test.ts:1220`；处理方式见「规划修正」与「实现记录」。**注意**：`tests/fixtures/focus-frame-legacy.json` 由 `scripts/freeze-focus-frame.mts` 调**当前** `buildFrame` 重跑 → 它从此是**自洽快照基线**，不再是「旧路径 oracle」（脚本里的迁移前实现早已不存在）；diff 已逐行核对 = 23 行 × (text + ansi)，去掉新增的 `┃` 后与旧文本逐字相同、无其它变化。
- 未做 / 已知未覆盖：真机目视（本会话无法起真机——沙箱禁写 `~/.dsh`）；**窄窗漏补边界**（两轮审阅都提到）：表格行首 `┃` 来自 `table.ts` 的 `vLineLeaf`（**无 `minWidth` 门限**），而正文行的 `┃` 受 `USER_MIN_LEFT_GUTTER + 2` 门限 → 终端宽 ≤ 7 时「正文段（已丢线）↔ 表格行」之间的空行按 D2 保持裸空行（判定要求两侧都有竖线），表格竖线在空行处断开；属既有宽度降级口径的延伸，未加测试锁定（登记为已知边界）；**零宽字符段造成的跨项邻接**（`panes.ts:181-188` 用 `trim()` 门禁、`rows.ts` 的 blank 判定含零宽 → 只含 U+200B 的段过门禁却产 0 行，空行的「语义邻居」可能不是「项邻居」）——视觉自洽，登记为已知边界。

## 审阅记录

- **实现前审阅**（子代理，只读代码 + 实跑）：判定层次正确（行层是唯一同时拿得到「折行后邻接」与「宽度门限结果」的层）；`counts` / `keys` / `userRows` / `rowCache` / 末尾裁剪均不受破坏（空行项从不进行缓存；补段是同下标替换，且补段行必有下一行故不可能是末尾行）。**4 点修正全部采纳**：① 字形收窄为 `┃`（D6）；② 注释写明上一行允许行尾竖线的依据（D7）；③ 等价性差异改为可归因归一 + 位置钉死（D8）；④ 16 项期望类失败登记（见「测试与证据」）与冻结基线性质变更说明。
- **收尾前审阅**（子代理，只读 + 实跑全量）：结论「无阻塞性问题」，逐条核对缓存无别名污染、`indent: 0` 的正确性依据（`fill.ts` 的 `decorateRows` 把缩进空格作为 `segments[0]` 前置 → 「行首段是纯竖线」等价于缩进 0）、窄宽 `minWidth` 降级自洽、不会误命中横向 `│` / step 头 / 回合分隔线。**追加采纳**：等价性再补「位置钉死」（原本只钉条数，补错行仍能通过）+ SPEC 补「上一行竖线在行尾亦计入」半句。**登记为已知边界**（不属本条目范围）：窄窗下表格行首竖线无 `minWidth` 门限 → 空行处断开；零宽字符段的跨项邻接。
- **途中发现的新问题（按流程另立条目，未顺手改）**：同 step 内 `notice` 与正文的**到达顺序丢失**——探针 `tmp/probe-notice.ts` 实测 `reasoning → notice → assistant` 时，新流水线回合区为 `[step 头, ┃（先想）, ┃, ┃中间正文, （提示）]`（notice 落到正文之后），旧路径为 `[step 头, ┃（先想）, （提示）, "", ┃中间正文]`（到达序）。成因线索 = standalone notice 节与后到正文所属的**更早那个仍打开的节**之间「节顺序 ≠ 到达顺序」（`sections.ts` 的块归并口径）。已作为 BACKLOG 新条目「同 step 内 notice 与正文的到达顺序丢失（notice 被排到正文之后）」登记（本表第 17 条）。

## 收尾

- **关闭**：条目「边界空行丢竖线」2026-10-10 完成——接取时标〔进行中〕，本提交内标「完成」并从 `TUI/docs/BACKLOG.md` **移除**（BACKLOG 只留未完成项；完成记录 = 本文 + git 历史）。
- **编号口径**：本轮按用户指定顺序连续接取第 2-12、14 条，故**暂不重编**剩余条目编号（编号每次整理时重编、仅供阅读；留到本轮全部关闭后的整理提交统一重编，避免与用户指定的开工顺序失去对应）。
- **回写文档**：`TUI/docs/SPEC.md` §9.1 加「边界空行带竖线」一条（口径 + 实现 + 回归用例）；`TUI/README.md` / `TUI/docs/DESIGN.md` 无需改（分层、命令面与架构无变化；`STATUS.md` 按流程不由本任务改）。
- **遗留 / 已知边界**（不属本条目范围）：窄窗（≤ 7 列）下表格行首竖线无 `minWidth` 门限 → 空行处断开；零宽字符段造成的跨项邻接；真机目视未做（会话内无法起真机）。
- **归档**：本文件自 `TUI/docs/implementation/` 移入 `TUI/docs/archived/`。
- **提交链**：`2ae2905`（实现 + 测试 + 冻结基线重跑 + SPEC 口径）→ 收尾提交（归档 + BACKLOG 移除条目）。
