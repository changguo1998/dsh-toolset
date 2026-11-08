# 状态列 Task 块内容范围: 只显示当前帧到根路径（接取条目：TUI/docs/BACKLOG.md「状态列 Task 块内容范围: 只显示「当前帧 → 根」路径, 根在下、当前帧在上」）

状态：关闭　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. Task 块只列「当前正在进行的帧 → 根节点」链路, 不铺全部任务。
2. 根节点在下、当前帧在上（最上层 ● 黄 = 当前帧, 其余 ○ 灰, 与现状分层渲染形态一致）。
3. 若宿主 `frameStack` 的栈顺序与期望相反, TUI 侧反转或与宿主对齐；配套帧测试。

## 调研

- **宿主 `frameStack` 不是路径, 是就绪池**: `EngineStore.frameStack()` 返回 `[...this.pool]`（`task-engine/src/engine-store.ts:135-138`）, 注释写明「DFS 栈的只读副本；数组末位 = 下一待处理帧」。池里装的是**所有** pending 帧（构造时 `task-engine/src/engine.ts:128-131` 全量入池, 运行中按 `pushPool` / `pushPoolFront` 增删）, 不是「当前帧 → 根」的一条链。
- **当前帧从哪来**: `nextReady()` 从池里 `pop` 后把该帧置 active（`engine-store.ts:72-82`）, 即**在途帧不在池里**; `activeCount()` 数 `status === "active"` 的帧（`engine-store.ts:58-65`）。所以要还原「当前帧」需要两路: 有在途帧时取 active 帧, 否则取池顶（`stack.at(-1)` = 下一待处理帧）。
- **路径可直接自建**: 快照 `tasks` 是嵌套树, 每个 `NestedTaskItem` 带 `id` / `parentId` / `title` / `status` / `children`（`task-engine/src/types.ts:225-237`）, 沿 `parentId` 上溯即可得到「当前帧 → 根」链路, 顺序天然是根在前; 展示要「根在下、当前帧在上」, 渲染时反序即可。
- **TUI 现状**: 条目 4 已把取数抽成纯函数 `TUI/src/app/runtime/task-status.ts` 的 `taskExtrasOf`, 其中 `stack` 仍是宿主池的 id 序列（`stack.map((id) => titles.get(id) ?? id)`）。`StatusColumn.ts:299-311` 自底向顶渲染 `stack`, 末位（池顶）标 ● 黄 —— 于是列表里会出现「池里所有待处理帧」, 且末位不一定是「当前帧到根」的链。
- **在途帧不可见**: 帧被 `nextReady()` 取走后池里就没有它了, 若此时池为空, 现逻辑（`stack.length === 0` → 不建块）会让 Task 块在任务执行期间消失 —— 条目 4 的收尾遗留已登记此点, 本任务一并修。

## 决策

1. 「当前帧」的取法: a 有 active 帧时取 active 帧, 无 active 时取池顶（下一待处理帧） / b 只取池顶 / c 只取 active 帧。
   选定 a —— b 在任务执行期间（帧被 pop 出池）会拿不到当前帧, 导致块消失; c 在两次执行之间（无在途帧）没有当前帧。
2. 路径构造: a TUI 侧沿 `parentId` 上溯自建链路 / b 让 `task-engine` 把 `frameStack` 改成返回链路。
   选定 a —— b 是跨包语义改动, `frameStack` 的池语义还被 `nextReady` / `peekNextReady` / step 裁决使用; a 只用快照里已有的 `parentId`。
3. `total` / `active` 口径: a 保持现状（`total` = 有标题的帧数, `active` = 宿主 `activeCount`） / b 改成只数路径上的帧。
   选定 a —— 块头 `Task active/total` 表达的是整棵树的进度, 改口径会让用户失去「还有多少任务」的信息; 本任务只改 `stack` 内容。
4. 有 active 帧但存在多个时: a 取 `tasks` 先序里第一个 active 帧 / b 全部 active 帧各出一条链。
   选定 a —— 块只显示一条「当前」链, 多执行器并发时取先序第一个; 块头 `active/total` 仍如实给出总数。

## 规划

- 计划改动文件清单:
  - `TUI/src/app/runtime/task-status.ts`（`taskExtrasOf`: 由「池 id 序列」改为「当前帧 → 根」链路; 新增私有 `currentFrameOf` / `pathToRoot`）
  - `TUI/tests/task-status.test.ts`（改写与新增: 多帧池只出链 / 根在下当前帧在上 / 在途帧优先 / 无 active 取池顶 / 无任务仍不建块）
  - `TUI/src/app/components/StatusColumn.ts`（如需: 块头与 ● 标记的注释口径; 渲染本身不变）
- 明确不做: 不改 `task-engine`、不改 `Task active/total` 口径、不改条目 6（daemon 符号）、不改条目 4 的「无任务隐藏」判据。
- 验证: `pnpm run test:tui`、`pnpm run check`、`pnpm -C TUI run build`、`pnpm run demo -- --smoke`、`pnpm run check:docs`。

## 实现记录

- 2026-11-08: `TUI/src/app/runtime/task-status.ts` 改写取数: 新增 `currentFrameOf`（先序第一个 `active` 帧, 没有则池顶）与 `pathToRoot`（沿 `parentId` 上溯并倒序成「根 → 当前帧」）, `taskExtrasOf` 的 `stack` 由「整池 id 序列」改为这一条链路; `total` / `active` 口径不变。
- 2026-11-08: 父链断开时**不**把查不到的父 id 混进展示（`byId.has(parentId)` 才继续上溯）, 成环靠 `seen` 截断。
- 2026-11-08: 顺手修掉条目 4 的收尾遗留 —— 在途帧把池取空时仍能建块（当前帧来自 `active` 帧, 不再依赖池非空）。

## 偏差

- 计划里「`StatusColumn.ts` 如需改注释」实际未改: 其注释「当前任务栈（自底向顶; 最上层 = 当前帧）」与 `state/types.ts` 的 `StatusExtras.task` 注释在新语义下依然准确（`stack` 末位就是当前帧）。

## 测试与证据

- `pnpm -C TUI exec node --experimental-transform-types --test tests/task-status.test.ts`: 11 pass / 0 fail（含新增: 多帧池只出链 / 深层嵌套倒序 / 在途帧优先于池顶 / 在途帧取空池仍建块 / 全完成不建块 / 父链断开就地停 / 成环不无限上溯 / 未知 id 原样显示）。
- `pnpm run test:tui`: 1870 pass / 0 fail。
- `pnpm run demo -- --smoke`: SMOKE_PASS 42 项。
- `pnpm run check` / `pnpm -C TUI run build`: 通过。
- `pnpm run check:docs`: 119 篇现行 Markdown / 959 个 .ts, 错误 0 / 警告 0。

## 收尾

- BACKLOG 条目已移除, 本文件移入 `TUI/docs/archived/`。
- 回写: 无 README / SPEC 变更（块头文案与 ● / ○ 分层渲染形态未变, 变的只是条目来源）。
- 遗留: 多执行器并发时只显示先序第一个 active 帧的链路（决策 4 = a 的既定取舍）; 若将来要显示多条链, 另开条目。
