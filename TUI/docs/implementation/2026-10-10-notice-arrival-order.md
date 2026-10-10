# 同 step 内 notice 与正文的到达顺序丢失（接取条目：`TUI/docs/BACKLOG.md`）

状态：关闭　　开启：2026-10-10　　关闭：2026-10-10
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

同一 step 内，notice 与正文（以及其它内容）按**到达顺序**渲染，与旧缓冲路径一致；跨 step / 跨回合的归属口径不变。

## 调研

探针 `tmp/probe-notice.ts`（未入库）：交付顺序 `step-start → reasoning → notice → assistant`：

| | 回合区行 |
| --- | --- |
| 改前（新路径） | `#1`、`┃（先想）`、空行、`┃中间正文`、`（提示）` ← notice 跑到正文之后 |
| 旧路径 | `#1`、`┃（先想）`、`（提示）`、空行、`┃中间正文` |

根因（走读 + 探针）：notice 交付自成 **standalone 节**并封闭当前节；后到的 `assistant` 文本走 `target()`，该函数会在已封闭的节里**按 scope 回写**（`base.sections.findIndex(sameScope && !standalone)`）→ 正文回到 notice **之前**那一节，节顺序 ≠ 到达顺序。

## 决策

- **D1 回写只对「续写」**：`target()` 增 `continuation` 形参；`false` 时不回写更早的同 scope 节，而是按到达顺序另起新节。新块 / 新工具调用天然是「新内容」，必须落在当前节之后。
- **D2 续写判据按「来源 + 块」而非交付账**：文本续写 = `delivery.index < 0`（step 结算）或该 (turn, step) 的节里已有**同来源 + 同块**的文本条目。**不能**只看 `state.delivered.has(blockKey(turn, step, index))`——交付账 key 不含来源，`reasoning` 与 `assistant` 用同一 `index` 时会误判成续写（首次实现即踩此坑，探针未通过）。
- **D3 工具调用续写 = 调用已登记**（`toolArgs.has(callId) || callOwner.has(callId)`）：参数增量写回原节，新调用另起。
- **D4 工具结果不受影响**：结果按 `callOwner` 直接定位到调用所在节，不走 `target` 的回写分支。
- **D5 `/copy` 拼接跨节**：`joinedLastTextBySource` 改为「先定最后一个含该来源文本的 (turn, step)，再取该 scope 下**所有节**的该来源文本按序拼接」——同一步的回复被 notice / 工具批切成多节后，`/copy` 仍复制整条（否则只复制最后一段）。
- **D6 不改**：notice 自成节的口径、`(turn, step)` 归属口径、跨 step / 跨回合的节顺序。

## 规划

计划改动文件清单：

- src：`TUI/src/app/layout/pipeline/sections.ts`（`target` 的 `continuation`、`applyText` 的续写判据、工具调用分支、`joinedLastTextBySource`）。
- tests：`TUI/tests/pipeline-panes.test.ts`（⑪ 到达顺序，与旧路径逐行同款）。
- 文档：本文件；`TUI/docs/BACKLOG.md`（条目状态）。

明确不做：notice 与正文同节的合并口径；`replay.ts` 的块聚合；条目 22 的 index 多来源统一。

## 实现记录

- 2026-10-10：
  - `target()` 增 `continuation = true`：`boundary || !continuation` 时不回写更早的同 scope 节。
  - `applyText`：先定位该 (turn, step) 的**非 standalone** 节，续写判据 = 结算（`index < 0`）或该节已有同来源 + 同块的文本条目；`target(...)` 传该判据。
  - 工具调用分支：续写判据 = `state.toolArgs.has(callId) || state.callOwner.has(callId)`。
  - `joinedLastTextBySource`：改为「最后一个含该来源文本的 (turn, step) → 该 scope 下所有节的该来源文本按序拼接」（`/copy` 仍复制整条回复）。
  - 测试：`tests/pipeline-panes.test.ts` ⑪（交付驱动：`reasoning → notice → assistant` 的回合区行序 = `#1`、`reasoning`、`notice`、空行、`assistant`，与旧路径逐行同款）。

## 测试与证据

- 探针 `tmp/probe-notice.ts` **改前 / 改后**（40 列回合区）：
  - 改前：`#1`、`┃（先想）`、空行、`┃中间正文`、`（提示）`。
  - 改后：`#1`、`┃（先想）`、`（提示）`、空行、`┃中间正文` —— 与旧路径输出**逐行一致**。
- 全量：`npm test`（TUI）**1436 / 1436 通过**；`npm run check` 干净。
- 过程中修掉的两个坑（都留在文档里备查）：① 首版续写判据用 `state.delivered.has(key)` → `reasoning` 与 `assistant` 共用 `index 0` 时误判 → notice 仍被越过；改为按「来源 + 块」在节内找条目。② 到达顺序修好后 `/copy` 只复制到最后一段（多节），故把 `joinedLastTextBySource` 扩成同 scope 跨节拼接（`app.test.ts` 的 `/copy` 多行断言仍通过）。
- 未做：真机目视；条目 22 的 index 多来源统一（另立）。

## 测试与证据

（待补）

## 审阅记录

- **收尾前审阅**（子代理，只读）：关注点与结论见文末回填（迟到增量 / 两线交叉是否仍写回原节、`tool-result` 的 `callOwner` 定位、`pendingOpen` 边界、notice 之后同块续写是否被劈成两节）。**自检**（审阅返回前先做的核对）：续写（同来源 + 同块）仍回写原节 → 流式增量不会因 notice 而另起一节；`tool-result` 走 `callOwner` 分支不经 `target` 的回写口径；`pendingOpen` 边界判据在 `continuation` 之前短路（`boundary || !continuation`）→ 语义不变。

## 收尾

- **关闭**：条目「同 step 内 notice 与正文的到达顺序丢失（notice 被排到正文之后）」2026-10-10 完成——接取时标〔进行中〕，本次提交内按流程从 `TUI/docs/BACKLOG.md` 移除。
- **回写文档**：`TUI/docs/DESIGN.md` / `SPEC.md` 未写「notice 之后的正文回写更早节」这类实现细节，无需改；到达顺序即旧口径，无需新增规格。
- **遗留 / 已知**：`/copy` 的拼接仍不去重（同节重复条目会拼出重复文本，属条目 22）；块身份 `index` 的多来源不一致（条目 22）。
- **归档**：本文件自 `TUI/docs/implementation/` 移入 `TUI/docs/archived/`。
- **提交链**：实现 + 测试 + 文档 → 收尾提交（归档 + BACKLOG 移除条目）。
