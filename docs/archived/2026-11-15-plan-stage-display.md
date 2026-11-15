# plan 模式段位展示（TUI 标题行符号）（实施追踪）

接取条目：`docs/BACKLOG.md` §2「plan 模式段位展示（TUI 状态行）」（2026-11-15 接取）。
落点更正：段位在**标题行开头的符号区**（`title-bar.ts` 的 `titleBarSegments`）, 非底部状态行（P1 起状态行不承载符号）。
附加交办（用户 2026-11-15）: 符号顺序调整——工作流符号（plan / flow-track）排到符号区最右, 与其余符号用 `•` 隔开。

## 计划改动文件清单

1. `TUI/src/app/app-deps.ts`：加 `PlanStageLike` 接口与 `AppDeps.getPlanStage` 懒读读取器
2. `TUI/src/main.ts`：接线选项 + `ctx.get('planStage')` 读取器 + 传入 AppDeps
3. `TUI/src/app/state/types.ts`：`AppState` 加 `planStage` 快照（undefined=未接线 / null=未进模式 / 对象=当前段）
4. `TUI/src/app/state/actions.ts` + `reducer-view.ts` + `initial.ts`：`plan-stage` action 三件套
5. `TUI/src/app/runtime/wiring.ts`：`maybeRefreshPlanStage()`（仿 `maybeRefreshCacheHit`）+ 返回对象登记
6. `TUI/src/app/runtime/lifecycle.ts`：StatusTicker 同节律调用
7. `TUI/src/app/layout/title-bar.ts`：符号组分两组（环境/行为开关组 + 工作流组 plan/flow-track）, 组间 `•` 分隔; plan 符号按段着色（null=灰 / 探索=青 / 计划=黄 / 实施=绿）, 不再由宿主 `mode.plan` 驱动
8. `TUI/tests/title-bar.test.ts` + `TUI/tests/policy.test.ts`：顺序与配色断言更新 + plan 段位四态新用例
9. 追踪文档（本文件）与 `TUI/docs/DESIGN.md`（如涉标题栏口径）

不接线的既有机制保留：`mode.plan`（宿主 plan/mode 事件）不再驱动标题栏 plan 符号, 字段与 reducer 不进破坏性删除（其它引用面未动）。

## 推进记录

2026-11-15：按计划清单实施完毕, 全部验证通过（明细见下）。过程中两处偏差, 均已处理:

- 用户两次细化颜色与分组: ① 「探索属于计划」, readonly（探索 + 计划）先统一青色; ② 再细分「探索保持青色, 计划用黄色」——最终配色: 未进模式灰 / 探索青 / 计划黄 / 实施绿; 工作流组最终定为仅 plan + flow-track（daemon 留在环境组）。
- 用户更正呈现位置: 段位在**标题行开头的符号区**, 非底部状态行（BACKLOG 与追踪文档头部已同步）。
- focus-frame 冻结基线: 标题栏结构变化影响 11 个 w60 场景, 按惯例重冻 `fixtures/focus-frame-legacy.json` 并追加 freeze 记录。

## 验证与证据

- `pnpm -C TUI run check`：通过。
- `sh TUI/scripts/test.sh`：1891 项全过（含新增「plan 段位四态」「环境组 `•` 工作流组」用例与重冻后的基线对照）。
- `pnpm run check` / `pnpm run build` / `pnpm run test`：全仓全绿。
- `pnpm run check:docs`：通过（详见收尾）。

## 收尾

- 本追踪文档关闭, 移入 `docs/archived/2026-11-15-plan-stage-display.md`。
- BACKLOG：§2「plan 模式段位展示」完成清理, §1 加完成索引行。
- 不删除既有机制：`mode.plan`（宿主 plan/mode 事件）字段与 reducer 保留, 仅标题栏不再消费（快照与兜底仍用）。
