# 状态列 Task 块: 没有任务时不显示（接取条目：TUI/docs/BACKLOG.md「状态列 Task 块: 没有任务时不显示」）

状态：关闭　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 代码核实宿主 `task-engine` 的 `frameStack` 在无任务时的实际取值（空数组 vs 含默认根帧）。
2. 没有任何真实任务（帧栈为空, 或栈内无有效标题）时, 状态列不出现 Task 块；有任务时才显示 `Task active/total` 与栈条目。
3. 判定口径与「Task 块只显示当前帧到根路径」同源, 一并接取时统一定义。

## 调研

- **`frameStack` 恒非空**: 宿主 `task-engine` 在构造时就落一条 `plan/root-created`（`task-engine/src/engine.ts:104-110`, 空日志分支）, 根帧标题缺省 `当前任务`（`task-engine/src/plugin.ts:103-108`）。随后把树里所有 `pending` 帧入就绪池（`engine.ts:128-131`）—— 于是没有任何用户任务时, 池里也有那一个空转根帧。
- **`frameStack` 的语义是就绪池, 不是「当前路径」**: `EngineStore.frameStack()` 返回 `[...this.pool]`（`task-engine/src/engine-store.ts:135-138`）, 注释写明「DFS 栈的只读副本；数组末位 = 下一待处理帧」。它既不是「当前帧 → 根」的链路, 也不排除空转根帧。
- **TUI 现状**: `TUI/src/app/runtime/wiring.ts:160-201` 以 `stack.length > 0` 产出 `next.task` 快照, `active` 取 `activeCount`, `total` 取「有标题的帧数」（含根帧, 故无任务时是 `Task 0/1`）; `TUI/src/app/components/StatusColumn.ts:299-311` 再以 `stack.length > 0` 建块。所以「没有任务却显示 Task 块」成立, 成因是空转根帧, 不是宿主返回了全部任务。
- **可用的判据**: 宿主快照 `tasks` 是嵌套树（`NestedTaskItem` 带 `parentId` / `status` / `children`, `task-engine/src/types.ts:225-237`）, 顶层即根帧; `activeCount`（`engine-store.ts:58-65`）数 `status === "active"` 的帧。

## 决策

1. 「无任务」的判定口径: a TUI 侧判定「树里除根帧外无其他帧, 且没有 active 帧」→ 不建块 / b 改 `task-engine`, 无用户任务时 `frameStack` 返回空 / c 只按 `active === 0 && total <= 1` 简化判定。
   选定 a —— 语义最贴「没有真实的活」: 根帧被拆过（有子帧）或被激活（`active`）都算有任务; b 是跨包语义改动, 会波及 `nextReady` / `isComplete` / 快照契约; c 在有子帧但全部 done 时会误隐藏（用户仍希望看到 `Task 0/3`）。
2. 是否与条目 5 合并实现: a 先单独落地「无任务隐藏」（本任务） / b 与「只显示当前帧到根路径」一起改。
   选定 a —— 两条目各有追踪文档与关闭流程, 且隐藏判据不依赖路径渲染; 5 改的是同一处快照构造, 紧随其后做, 不重复改。

## 规划

- 计划改动文件清单:
  - `TUI/src/app/runtime/wiring.ts`（`refreshStatusExtras` 的 Task 段: 先按 `tasks` / `activeCount` 判断「是否有真实任务」, 再产出快照）
  - `TUI/tests/`（新增帧 / 快照用例: 只有空转根帧 → 无 Task 块; 有子帧 → 照常显示; 根帧 active → 显示）
- 明确不做: 不改 `task-engine`、不动 `StatusColumn.ts` 的建块条件（快照不产出即无块）、不改条目 5 的渲染顺序。
- 验证: `pnpm run test:tui`、`pnpm run check`、`pnpm run demo -- --smoke`、`pnpm run check:docs`。

## 实现记录

- 2026-11-08: 新增纯函数模块 `TUI/src/app/runtime/task-status.ts`（`taskExtrasOf(snapshot)`: 先序展平嵌套任务树, 判「除根帧外无其他帧且无 active 帧」→ 返回 `undefined` 不建块; 否则给 `{active, total, stack}`）。
- 2026-11-08: `TUI/src/app/runtime/wiring.ts` 的 Task 段改为调用该纯函数（原来内联的 `walk` 与 `stack.map` 一并移出, 约 −35 行内联逻辑）, 快照不产出时 `next.task` 缺省, `StatusColumn` 的 `stack.length > 0` 建块条件自然不成立。

## 偏差

- 原计划「清单不写新文件」（只说改 `wiring.ts` 与测试）: 实际新拆了 `src/app/runtime/task-status.ts`。理由: 判定规则要能被单测覆盖, 而 `wiring.ts` 依赖整个 `AppContext`、无现成测试入口; 该模块也承接条目 5 的「当前帧 → 根路径」计算。

## 测试与证据

- `pnpm -C TUI exec node --experimental-transform-types --test tests/task-status.test.ts`: 6 pass / 0 fail（空转根帧不建块 / 快照缺失与空栈 / 根已拆子帧 / 子帧全 done 仍显示 / 根自身在途 / 未知 id 原样显示）。
- `pnpm run test:tui`: 1865 pass / 0 fail。
- `pnpm run demo -- --smoke`: SMOKE_PASS 42 项, 收尾 `SMOKE_OK`。
- `pnpm run check`: 通过; `pnpm -C TUI run build`: 通过。
- `pnpm run check:docs`: 119 篇现行 Markdown / 959 个 .ts, 错误 0 / 警告 0。

## 收尾

- BACKLOG 条目已移除, 本文件移入 `TUI/docs/archived/`。
- 回写: 无 README / SPEC 变更（状态列块头文案未变, 只是不再出现空块）。
- 遗留: 在途帧被取走后就绪池可能为空 → 该帧在途期间 Task 块会消失; 归入条目「状态列 Task 块内容范围: 只显示「当前帧 → 根」路径」（下一条）处理, 本任务不改。
