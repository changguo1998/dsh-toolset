# `task_status` 多轮视图：当前轮完整 + 旧轮根摘要（接取条目：`task-engine/docs/BACKLOG.md`「`task_status` 在多轮后随轮数膨胀（森林全量）」）

状态：关闭　　开启：2026-10-05　　关闭：2026-10-05
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

多轮会话（一轮 = 一棵树，旧轮只读保留）之后，`task_status` 默认把每轮全量展开：旧轮根标题与新轮相同、子帧全 `done`，占 context 却不含新信息。本任务让默认输出**只展开当前轮**，旧轮降为根摘要，并随附 `rounds` 计数。落点限定在工具输出映射层，不动引擎视图（`nested()` / `query()`）与 TUI。

## 调研

- `src/tools.ts:271`（默认分支）：`return { ok: true, tree: engine.nested() }` —— 森林全量直出，无截断。
- `src/events.ts:140` `toNested()`：森林 = `tree.rootIds.map(...)`，每轮根带 `round: index + 1`，子帧先序完整展开。
- `src/engine.ts:900` `query()`：`tasks: this.nested()` —— **TUI 任务面板的消费面**（多轮无轮次标识另见 BACKLOG #2），本任务不改。
- 既有断言：`tests/tools.test.ts:96` 用 `status.tree[0].children[0].executorKind`（单轮场景，不受影响）。
- 工具描述 `src/tools.ts:322` 已说明「多轮返回森林 / 根带 `round`」，但未说明默认截断行为 → 需同步。

## 决策

选项：

- A（选定）：`tree` 仍是森林数组，形状不变；**只有最后一轮全量**，更早的轮只留根节点，补 `children: []` + `descendantCount` + `truncated: true`；顶层加 `rounds`。
- B：拆成两个字段（`tree` = 当前轮，`previous` = 旧轮摘要）—— 破坏既有形状，模型要处理两种结构并按轮次拼接。
- C：加 `round` 入参按需取历史轮全量 —— 无需求（旧轮只读，细节在事件流与追踪文档里），白增一个参数与校验分支。

选 A 的理由：形状与读法单一（沿 `tree` 逐项读即可），增量最小（一个纯函数 + 一处调用），且「有摘要但被截断」在字段上显式（`truncated` + `descendantCount`），不依赖模型去猜 `children: []` 的含义。

明确不做：不加取历史轮的入参；不改 `toNested` / `query()`；不做 TUI 面板轮次标识（BACKLOG #2）；不改 STATUS.md。

## 规划

任务拆分：

1. `src/tools.ts`：加 `statusView(forest)` 纯函数（`rounds` + 旧轮截断映射，含 `countDescendants` 辅助）；默认分支改用它；`task_status` 描述补默认截断口径；补 `NestedTaskItem` 类型导入。
1. `tests/tools.test.ts`：多轮场景（跑完一轮 → 开第二轮 → status）断言 `rounds: 2`、旧轮 `truncated` / `descendantCount` / `children` 空、当前轮全量；单轮场景断言 `rounds: 1`、全量、无 `truncated`。
1. `README.md`：工具表 `task_status` 行补默认视图口径。

计划改动文件清单（**除此之外一律不改**）：

- `task-engine/src/tools.ts`
- `task-engine/tests/tools.test.ts`
- `task-engine/README.md`
- `task-engine/docs/BACKLOG.md`（条目状态「进行中」→「完成」→ 清理）
- `task-engine/docs/implementation/2026-10-05-task-status-round-view.md`（本文件）

## 实现记录

- 2026-10-05 决策审阅（子代理，只读，结论「需修：无架构级阻断」）——3 处修订已并入上方决策与下列实现：
  1. `childCount` → **`descendantCount`**（原名不符实：它数的是后代帧数，紧邻 `children: []` 会被读成「直接子帧数」）。
  1. `truncated` 语义写成工具描述**硬条款**：本工具不提供取回（`truncated` 在其它插件 —— fs-digest / md-map / output-compress —— 里是「换参数重取」的意思，不写死会被模型读成可重取）；当前轮**不带**该字段（缺省，非 `false`）。
  1. 视图类型落点定在 `src/tools.ts` 本地类型 `StatusRoundView`（不动 `src/types.ts` 的 `NestedTaskItem`，避免多余属性检查与清单外文件）。
- 审阅方实测口径（全仓 grep，非推测）：`task_status.tree` 的既有消费方（`tests/tools.test.ts` / `tests/exec-guard.test.ts` / `tests/semantic.test.ts` / `scripts/executor-smoke.mjs`）**全是单轮**，不受影响；吃「全量森林」的是另一条面 —— TUI `/task` 与 demo 走 `engine.query()` / `nested()`，本任务不动 → README 里注明两面分叉。
- `src/tools.ts`：加 `StatusRoundView` / `countDescendants()` / `statusView()`；默认分支改为 `{ok, rounds, tree: statusView(forest)}`；`task_status` 描述补「只展开当前轮 + 折叠语义 + 不可取回」。
- `tests/tools.test.ts`：新增 5 例（未 decompose 单轮 / 两轮 / 三轮 / 折叠轮多子帧深树 / 旧轮根 `failed`）。
- `README.md`：工具表 `task_status` 行更新（返回 `{ok, rounds, tree}` + 默认折叠口径）；折叠细则下沉为「多轮根帧」bullet 的续段，并写明引擎面（`nested()` / `query()` / TUI 面板 / demo）不被折叠。

实现中的两个自测修正（留痕）：

1. `countDescendants` 首版写成 `n + countDescendants(c)`（漏数子帧自身）→ 折叠轮恒报 0；改为 `n + 1 + countDescendants(c)`。修前反向验证即暴露（三轮用例实测 `[0, 0, undefined]`）。
1. 造「根 `failed`」时先试「根验收命令失败 + 反复 `stop` 子帧」不通：`stop` 对 `done` 帧直接拒绝（`engine.ts:611`），join 不会重触发；改用与 `engine.test.ts:428` 同源的路径 —— 连续 3 次门禁打回 → 根 `failed`。

收尾审阅（2026-10-05，子代理只读，结论「可提交 / 需先收尾」）与处置：

1. 〔次要〕正文残留旧名 `childCount` / `countFrames` → 已在「决策 / 规划」节就地订正为 `descendantCount` / `countDescendants`。
1. 〔次要〕BACKLOG 条目仍挂〔进行中〕、追踪文档未归档 → 在本节收尾中完成。
1. 〔次要〕`default` 分支里的 `const forest = engine.nested()` —— 其余 `case` 提前 return，实际不可达且无性能影响，保留（更紧的挪位无实际收益）。
1. 〔提示〕补「多子帧 / 深树」折叠累加用例 → 已补（`m1 + g1 + m2` 期望 `descendantCount === 3`，实测通过）；该用例同时挡住「递归漏数」回归。
1. 〔提示〕README 单元格过长（430 字符）→ 已把细则下沉到 bullet，单元格只留形状与「默认只展开当前轮」。
1. 审阅方另核：`engine.nested()` 每次重建对象（`events.ts:140`），折叠对象为展开副本、`children: []` 是新数组 → 无共享引用污染 TUI / 事件流；`statusView([])` 的退化路径因 `materialize` 保证 `rootIds` 非空而不可达。

## 测试与证据

- `cd task-engine && npm run check` → 通过（`tsc --noEmit` 无输出）。
- `cd task-engine && npm run test` → `tests 136 / pass 136 / fail 0`（本任务前为 131，新增 5）。
- 反向（变异）验证：把 `statusView` 折回「原样返回全量」后仅跑 `tests/tools.test.ts` → 折叠相关 3 例失败（`pass 4 / fail 3`）；恢复实现后全通过。
- 根 `npm run check` + `npm run build` → 通过；根 `npm run test` → 21 包全 `fail 0`（task-engine 136；TUI 1320、md-logic 57、md-map 49 等与基线一致）。
- 临时文件：调试脚本 `tmp/dbg-roundview.ts`、变异备份 `tmp/tools.ts.bak` 已删除（`tmp/dbg-status.ts` 为本次调试产生的 0 字节残留，一并删除）。

## 收尾

- 回写文档：`README.md` 工具表行 + 「多轮根帧」bullet 续段（模型面折叠 vs 引擎面全量）。`DESIGN.md` 不改：模型面契约由 README 承载，引擎视图与会话面语义未变（`nested()` / `query()` / 事件流不动）。
- BACKLOG：`task-engine/docs/BACKLOG.md` 条目 1 已清理（只留条目 2：TUI 任务面板轮次标识）。
- 追踪文档：本文件移入 `task-engine/docs/archived/`。
- 遗留项：无；临时文件已清理，工作区只含本次变更。
