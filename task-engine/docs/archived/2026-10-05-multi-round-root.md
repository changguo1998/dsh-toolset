# 根帧改为「可多轮」：会话 = 解释器，不是一次性 `main()`（接取条目：`task-engine/docs/BACKLOG.md`「根帧改为可多轮」）

状态：进行中　　开启：2026-10-05　　关闭：—

## 计划改动文件清单（只改这些；调研回来后按需收紧）

- `task-engine/src/engine.ts`（根帧创建 / `rootOf` / decompose 门禁 / 中断恢复等用到「根 done」的路径）
- `task-engine/src/events.ts`（`materialize` 多根语义 + `plan/root-created` 载荷加轮次）
- `task-engine/src/types.ts`（根 / 事件类型字段）
- `task-engine/src/tools.ts`（**只改工具描述**：`task_decompose` / `task_status` 补多轮与 `"root"` 别名口径；输出形状不变）
- `task-engine/tests/*.test.ts`（新增多轮用例；修依赖单根的断言）
- `task-engine/README.md` + `task-engine/docs/DESIGN.md`（口径与机制）
- `task-engine/docs/BACKLOG.md`（条目标进行中 → 收尾移除）
- 本追踪文档

## 调研（2026-10-05）

- 现状（实测）：本会话里 `task_decompose` 挂叶子 `c1` → `task_execute`（真起子代理）→ `task_stop c1` 后根帧自动 join 成 `done`；再 `task_decompose(parent_id: "root")` 得到 `父帧 root 状态 done，不可再拆`。引擎实例 = 插件在会话组合建立时注入 → **会话内无重建入口**（`plan/root-created` 只在构造分支发一次，`engine.ts:224-237`）。
- 用户心智模型：会话 = **解释器 / REPL**，任务 = 跑一次程序；`main()` 完成后还能再跑下一次。
- 选定方案 A：保留「一轮任务 = 一棵完整树（根会 done）」不变量，只允许**再起一轮**（自动），旧轮留在事件流。

## 决策（2026-10-05，方案 A）

1. **轮次语义**：一轮 = 一棵完整树（根帧会 `done`，不变量保留）；**新一轮 = 新根帧** `root-<n>`（第二轮回起 `root-2`；首轮仍是 `root`，向后兼容），沿用**同一根契约**（`opts.root` 的 title/spec/acceptance/needDecompose/executor）。旧轮**只读保留**在事件流里。
1. **触发**：`task_decompose` 的父帧是**当前轮根**且 `done` 时 → 自动开新一轮，子帧挂到新根；**非根父帧 done 仍拒绝**；当前轮根 **done 或 failed** 都可开新轮（`failed` 是逃生口——一次失败后不该永久卡死会话）。
1. **事件与树**：`plan/root-created` 载荷加 `round`（缺省 1，旧事件回放兼容）；`TaskTree.rootId` = **当前轮**根，新增 `rootIds`（按轮次顺序）；`task_status` 返回**森林**（每棵树带 `round`），旧轮与新轮同列——TUI 侧 `flattenTasks` 已按数组遍历，兼容。
1. **别名**：`parent_id: "root"` 始终解析为**当前轮**根（不是第一轮）。
1. **id 唯一性**：帧 id 在 `frames` Map 里全局唯一，跨轮重名会覆盖旧轮并污染 pool / worktree 注册表 → 在 decompose 门禁**显式拒绝**（提示该 id 已在第 N 轮使用）。
1. **快照 / 恢复**：`resumeFromSnapshot` 取**最后**一条 `plan/root-created` 作为当前轮（原先取第一条）。
1. **不在本次范围**：TUI 的轮次标识（旧轮与新轮同列但无轮次标签）→ 若需要另开条目。

## 调研落点（子代理，2026-10-05）

`engine.ts`: 构造建根（222-238）→ 抽 `startRound()`；门禁（341-347）→ 仅当前轮根 done 分流；入池（257-259）→ 新根显式入池；`step-verdict` 用父帧 id（614-624）；`root()`/`isComplete()` 读 `rootId`（833-841）→ 当前轮；`resumeFromSnapshot`（910-925）→ 取最后一条。
`events.ts`: `rootId` 被最后一条覆盖（45-54）→ 加 `rootIds`；`materialize` 单根数组（136-152）→ 森林。
`types.ts`: `root-created` 载荷 + `round`；`TaskTree.rootIds`；`NestedTaskItem.round`。
`tools.ts`: `task_status`（271）→ 森林；`parent_id` 解析（176-181）。
消费者：全仓无外部解析 `plan/*` 的包；TUI 只走 `provide["taskEngine"].query()`，`flattenTasks` 兼容多根，`isComplete` 未被 TUI 使用 ✓ 不会渲染错。
测试影响：`events.test.ts:53/64`、`engine.test.ts:299/319/427/643/442/715/769`、`query.test.ts:35/52/74`、`tools.test.ts:77`、`exec-guard.test.ts:289`、`demo/main.ts:171/182/441/509`（`isComplete`）。

## 决策修订（2026-10-05，决策后审阅的阻断项）

决策后审阅（只读子代理）判「需改设计」，三条已在本实现内修正：

1. **[阻断] 开轮时机在门禁之前** → 门禁 / 蕴含打回也先建轮：留空轮；更糟的是打回计数记到**新根**，3 次（coverage / 过粗很常见）即新根 `failed`，而当时口径「根 failed 不开轮」→ 会话**永久卡死**。→ 改为：门禁 + 蕴含**通过后**才落盘开轮；自动开轮路径的打回**不记账**（不污染旧轮 retryCount）；并把「当前轮根 `failed`」也纳入可开新轮的情形（恢复路径）。
1. **[重要] 根契约本身是叶子（`needDecompose:false` / 带 `executor`）仍开轮** → 新根标叶子却挂子帧，破「根 done ⇒ 全树 done」。→ 显式拒绝并提示调整根契约。
1. **[重要] 生成的 `root-<n>` 可能撞前轮子帧 id**（门禁只防「新 id 与已有 id 重名」的向后方向）→ `frames.set` 静默覆盖旧轮树。→ 新增 `freeRootId()`：开轮前扫空闲名（子帧占了 `root-2` 就用 `root-3`）。
1. **[次要] 别名只覆盖 `parent_id`** → `implement`/`stop`/`execute` 传 `"root"` 会落到第一轮根；→ 抽 `resolveId()`，四处统一。
1. **[次要] resume 后 `rootTemplate` 是空占位** → 新一轮继承空契约（无验收）。→ 构造时从事件流里**最后**一条 `plan/root-created` 恢复根契约（`resumeFromSnapshot` 的 root 参数降级为纯占位）。
1. **[次要] `task_status` 森林随轮数膨胀 / TUI 无轮次标识** → 记入 `docs/BACKLOG.md` 后续条目 2、3（本次不做，避免范围膨胀）。

## 实现记录（2026-10-05）

- `src/types.ts`：`plan/root-created` 载荷加 `round?`；`TaskTree` 加 `rootIds`（`rootId` = 当前轮）；`NestedTaskItem` 加 `round?`。
- `src/events.ts`：`materialize` 记 `rootIds`；`toNested` 返回**森林**（每棵树根带 `round`）。
- `src/engine.ts`：构造改用 `buildRootFrame(id)`（首轮 `root`）；新增 `freeRootId()` / `resolveId()` / `openRound(id)`（**门禁通过后**才调用）；`decompose` 里当前轮根终态 → 临时新根校验 → 通过后开轮；跨轮子帧 id 冲突拒绝；`resumeFromSnapshot` 取最后一条 `root-created`；恢复时根契约取自事件流。
- `tests/engine.test.ts` +8 例、`tests/events.test.ts` +2 例（多轮 4 例 + 审阅修正 4 例 + 森林 2 例）。
- `README.md`：`task_status` 行改为森林口径 + 新增「多轮根帧」bullet。`docs/DESIGN.md`：事件溯源段补多轮语义。

## 测试与证据（2026-10-05）

- `task-engine`：`npm run check` ✓、`npm test` **131 例全绿**（原 121 + 新增 10）。
- 根级：`npm run check` 0 错误；`npm run test` **21 包全绿**（TUI 1320、task-engine 131、其余见并行汇总）。
- 反向验证（mutation）：把「当前轮根终态 → 开新轮」分支条件置 `false` → 多轮 3 例红；恢复后全绿。
- 用例覆盖：第一轮完成后自动开第二轮（新根 `root-2`、旧轮保留 done、事件流两条 `root-created`）；第二轮独立跑完并 join；跨轮复用 id 拒绝；非根帧 done 仍拒；**门禁打回不建轮、旧轮不翻 failed、打回 3 次后仍能开新轮**；根即叶子显式拒绝；`root-<n>` 撞名先扫空闲名；resume 后新轮继承事件流里的根契约；森林两轮 / 单轮兼容。

## 子代理审阅

1. **决策后**（只读，2026-10-05）：结论「需改设计」——1 阻断 + 2 重要 + 2 次要，全部处理（见上方「决策修订」），其中次要项 6 转 BACKLOG 后续条目。
1. **收尾前**（只读，2026-10-05）：待补。

## 收尾（2026-10-05）

- 条目从 `task-engine/docs/BACKLOG.md` 移除；审阅提出的两个后续项（`task_status` 摘要形态、TUI 轮次标识）已作为新条目留在该表（P3）。
- 本追踪文档移入 `task-engine/docs/archived/`；本次变更合并为一次提交。
- 复跑记录：`task-engine` `npm run check` ✓ / `npm test` 131 例 ✓ / `prettier --check` ✓；根 `npm run check` ✓ / `npm run test` 21 包全绿 / `npm run build` ✓。
- **未做（另开条目）**：`task_status` 的显示形态（当前全量森林）、TUI 面板轮次标识。
- 真机确认：本会话已实测「第一轮跑完 → 再 decompose → 自动开第二轮 + 真起子代理执行」路径（见追踪文档调研段）；`dsh` 会话内验证需重启后生效。
