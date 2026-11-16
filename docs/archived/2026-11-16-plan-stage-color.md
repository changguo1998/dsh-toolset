# plan 段位配色调整：探索与计划合并为青, 实施改黄, 新增「选中未建树」绿

## 背景

真机现象（用户 2026-11-16 反馈）：`/flow-arbiter select plan` 切换到 plan 模式后, 标题栏 plan 状态符号颜色不变（恒灰）。

根因：标题栏 plan 符号只读 plan-mode 服务面 `planStage.current(sessionId)` 的**段位**,
而段位来自 `plan_start` 建树后的帧状态（`stage.ts` 的 `currentStage`）。`/flow-arbiter select plan`
只是选中流程, 不建树, 会话无 plan-mode 映射 → 服务面返回 `null` → 标题栏按灰显示。
「已选中 plan、尚未建树」这一态没有颜色表达, 与「未进 plan 模式」同为灰。

## 用户裁定（2026-11-16）

把状态 / 颜色口径改为：

| 状态 | 触发条件 | 颜色 |
| --- | --- | --- |
| 未选中 plan | 服务面缺席 / 返回 null（未进 plan 模式） | 灰 |
| 已选中 plan, 未建树 | flow_arbiter 选中 plan, 尚未调 plan_start（没有任务） | 绿 |
| 探索 / 计划（合并） | 树已建, 实施未开始 | 青 |
| 实施 | 探索与计划都完成, 正在改代码 | 黄 |

即：探索与计划**合并为同一色（青）**；实施由原来的绿改黄；新增「选中未建树」态用绿。

## 计划改动文件清单

- `plan-mode/src/index.ts`：`planStageCurrent` 无映射分支读 `flowArbiter.current(sessionId)`,
  选中 plan 且 id 命中 → 报带外态 `idle`（绿）, 否则 null（灰）。
- `TUI/src/app/layout/title-bar.ts`：plan 配色映射改四态（灰 / 绿=idle / 青=explore|plan / 黄=implement）。
- `TUI/src/app/runtime/wiring.ts`：`planStageOf` 白名单纳入 `idle`。
- `TUI/src/app/app-deps.ts`：`PlanStageLike` 的 stage 并集加 `idle`。
- `TUI/src/app/state/types.ts`：`PlanStageState` 的 stage 并集加 `idle`。
- `TUI/tests/title-bar.test.ts`：段位用例改新配色（计划改青、实施改黄、新增 idle 绿）。
- `plan-mode/tests/index.test.ts`：新增「选中计划未建树报 idle / 未选中或选别的流程 null」用例。
- 文档：`TUI/docs/DESIGN.md`（标题栏两条配色口径）、`plan-mode/README.md`、`docs/BACKLOG.md`（§1 索引）。

## 实现要点

- `idle` 是**服务面带外态**, 不进 `stage.ts` 的 `Stage` 联合（`Stage` 仍为
  explore / plan / implement / unknown, 供 `currentStage` 与 `guard.decide` 用, 两处类型不串扰）；
  `planStageCurrent` 的返回类型为 `{ stage: Stage | "idle"; readonly: boolean } | null`。
- `idle.readonly` 恒 false（未建树本就没有只读拦截, plan 只读拦截在 `plan_start` 后经映射触发）。
- 只读拦截 / 阶段注入文案（`push.ts` 的探索 / 计划差异）**不改**——那只影响文本提示,
  与标题栏配色解耦。

## 验证

- `pnpm -C plan-mode run build`：通过。
- `pnpm -C TUI run check`：通过（0 错误）。
- `pnpm -C plan-mode run test`：64 例全过（新增 idle 用例 1 例）。
- `pnpm -C TUI run test`：1894 例全过（含更新后的段位配色用例）。
- 真宿主 e2e（`e2e/harness.ts` 起 plan-mode + flow-arbiter）：未选中 → null（灰）；
  `flowArbiter.select(sessionId,"plan")` 后 → `{stage:"idle",readonly:false}`（绿）；
  `plan_start` 建树后 → `{stage:"explore",readonly:true}`（青）。

## 收尾

- `docs/BACKLOG.md` §1 记完成索引, 引用本追踪文档；§2 不需保留（单次完成, 无残留待办）。
