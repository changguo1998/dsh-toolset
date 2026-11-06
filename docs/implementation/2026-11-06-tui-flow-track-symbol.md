# TUI 标题栏加 flow-track 注入开关符号

接取条目：`docs/BACKLOG.md`「TUI 标题栏加 flow-track 注入开关符号」

## 目标

- 标题栏状态符号组末尾追加一个符号（U+F0E8，sitemap 三节点层级字形），表示 flow-track 的注入开关：打开绿 / 关闭灰。
- 状态从 flow-track 的只读服务面读取；未挂载 flow-track 时不渲染该符号。
- 验收：单测覆盖「未挂载不渲染 / 关灰 / 开绿」三态；真机 `/flow-track on` 后标题栏变色。

## 调研

- 标题栏符号组：`TUI/src/app/layout/title-bar.ts:50`（`TITLE_ICON` 注释与码位表）、`:72`（`titleBarSegments` 参数 `switches: StatusSwitches`）、`:113`（四个开关按压入，on 绿 / off 灰）；`StatusSwitches` 定义在 `:35`。
- 调用点：`TUI/src/app/layout/top-region.ts:476`；`switches` 由 `state` 直接派生（`:479`）。
- 状态：`TUI/src/app/state/types.ts:595`（`symbolUnify` / `notifyEnabled` 等字段写法）、`TUI/src/app/state/initial.ts:84`（缺省值）、`TUI/src/app/state/reducer-view.ts:81`（`symbol-unify` action 的 reducer 写法）。
- 周期面：`TUI/src/app/runtime/lifecycle.ts:294`（`StatusTicker`，1s，`apply` 里已有多个「懒读服务 → 有变化才重绘」的调用：`refreshModelStatus` / `maybeRefreshAgents` / `maybeRefreshSessionAlias`）；`TUI/src/app/runtime/wiring.ts:147` 是 `refreshAgentsQuiet` 的懒读写法。
- 服务读取先例：`TUI/src/main.ts:928`（`getSessionChannel` / `getRuleEngine` 懒读 `ctx.get(...)`，容忍插件装载顺序）；服务提供先例：`task-engine/src/plugin.ts:377`（`ctx.provide("taskEngine", …)` 防御式调用）。
- 装载顺序：profile `dsh.profile.bundles` 里 `@dsh-toolset/tui` 排在第三位（`~/.dsh/profiles/fff/package.json:48`），flow-track 在其后 —— 挂载时推总线事件或启动时直读都会漏，必须懒读。
- flow-track 侧：开关是 apply 闭包里的 `switcher`（`flow-track/src/flow-track/src 无`，实为 `flow-track/src/index.ts:206` → `createFlowSwitch()`），工具 `flow_enable` 与 `/flow-track` 命令都会改它。

## 决策

1. 符号与位置：**用户 2026-11-06 裁定** —— `md-sitemap` 形 U+F0E8，状态符号组末尾（顺序变为 沙箱 / policy / plan / verbose / 符号统一 / 声音 / flow-track）。
2. 数据通道：**b 选定** —— flow-track 新增只读服务面 `flowTrack.enabled()`；TUI 在状态行 ticker（1s）里懒读并派 action。a. 总线事件（TUI 早于 flow-track 装载，首次事件收不到）；c. 启动时直读（同样受装载顺序影响）。
3. 未挂载表现：**a 选定** —— `AppState.flowTrackEnabled: boolean | undefined`，`undefined` = 还没读到服务（不渲染），读到后才渲染；避免在没装 flow-track 的 profile 里显示一个恒灰的符号。
4. 颜色：**a 选定** —— 沿用开关口径，打开 `green` / 关闭 `gray`。

## 计划改动文件清单

- `flow-track/src/index.ts`：`export const provide = ["flowTrack"]`；apply 里防御式 `ctx.provide("flowTrack", { enabled })`。
- `flow-track/tests/main.test.ts`：断言服务面存在、`enabled()` 随 `flow_enable` / `/flow-track` 变化。
- `TUI/src/app/state/types.ts`、`initial.ts`、`actions.ts`、`reducer-view.ts`：新字段 `flowTrackEnabled`（缺省 `undefined`）与 `flow-track` action。
- `TUI/src/app/app-deps.ts`、`TUI/src/main.ts`：`getFlowTrack` 懒读依赖（`ctx.get("flowTrack")`）。
- `TUI/src/app/runtime/wiring.ts`：`maybeRefreshFlowTrack()`（读服务 → 变化才派 action）。
- `TUI/src/app/runtime/lifecycle.ts`：ticker `apply` 里调用上述方法。
- `TUI/src/app/layout/title-bar.ts`、`top-region.ts`：`TITLE_ICON.flowTrack` + 组末压入 + `switches.flowTrack`。
- `TUI/tests/*`：标题栏三态与 ticker 懒读用例。
- 文档：`TUI/docs/SPEC.md`、`TUI/docs/DESIGN.md`（符号组最多 6 → 7、顺序表、码位表）、`flow-track/README.md`（服务面）。

**明确不做**：不加 TUI 命令去切开关（用户面命令仍是 `/flow-track`）；不做开关持久化；不改 flow-track 的注入门槛与八阶段定义；不做总线事件。

## 实现记录

（实现后补）

## 测试与证据

（实现后补）

## 偏差

（实现后补）

## 收尾

（关闭时补）
