# daemon 开关状态收进标题栏符号区（接取条目：TUI/docs/BACKLOG.md「daemon 开关状态收进标题栏符号区, 状态列 Daemon 块只在打开时显示且不再带开/关文字」）

状态：关闭　　开启：2026-11-08　　关闭：2026-11-08
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 状态列 Daemon 块只在 daemon 打开（`enabled === true` 且 `items.length > 0`）时显示, 关闭时整块不出现。
2. Daemon 块头去掉「开/关」文字, 只保留 `Daemon · running/total`（开/关语意转移到标题栏）。
3. 标题栏左侧符号区新增 daemon 开关符号, 一个符号表达开/关两态, 完全参照既有 `flowTrack` 先例（on 绿 / off 灰, 服务未读到时不显示）。

## 调研

- **先例链路（flowTrack 开关）**: 状态字段 `flowTrackEnabled: boolean | undefined`（`TUI/src/app/state/types.ts:648-650`, 初始 `undefined` = 未读到服务, 不渲染）; 动作 `{ type: "flow-track"; enabled }`（`state/actions.ts:199-200`）+ reducer 分支（`state/reducer-view.ts:82-84`）; 保鲜函数 `maybeRefreshFlowTrack`（`runtime/wiring.ts:278-293`, 读 `ctx.deps.getFlowTrack?.()?.enabled?.()`, 值变化才 `paint()`）; 由状态行 ticker 调用（`runtime/lifecycle.ts:313`）; 最后在 `layout/top-region.ts:480-490` 折进 `titleBarSegments` 的 `switches`。
- **标题栏符号面**: `StatusSwitches`（`layout/title-bar.ts:40-49`）已有 `flowTrack?: boolean | undefined`; `TITLE_ICON`（`:64-75`）是一组 Nerd Font 私有区码位（注释 `:57-63` 标明字义与「宽度实测各 1 列」）; 渲染在 `:131-132` —— `switches.flowTrack !== undefined` 才 push, on 绿 / off 灰。
- **daemon 数据面**: `ctx.deps.getDaemon?.()` 是 `background-daemon` 的只读面, `status()` 给 `{enabled}`, `list()` 给任务清单（`runtime/wiring.ts:220-242`）; 现状快照只在 `list()` 非空时产出, 已带 `enabled` 字段。
- **状态列现状**: 块显示条件是 `extras.daemon.items.length > 0`（`components/StatusColumn.ts:365-382`）, 块头 `Daemon 开/关 · running/total`（`:369-371`）—— 于是 daemon 关闭时块仍出现, 且开关语义只能从块头文字读出。
- **已有测试**: `TUI/tests/status-column.test.ts:674-723` 断言块头 `Daemon 开 · 1/2` 与五块顺序 —— 改文案后该断言必须同步更新（不是新增）。

## 决策

1. daemon 符号字形: a `fa-clock_o`（U+F017, 定时 / 调度语义, FA4 区, 宽 1 列） / b 复用 `fa-tasks`（与 flowTrack 撞符号, 无法区分） / c 用文字字母。
   选定 a —— 与既有符号同属 Nerd Font 私有区、宽度 1 列; 语义上 daemon 是「按会话投递的定时调度」, 时钟比任务清单更贴; b 撞符号, c 破坏符号区一致性。
2. daemon 关闭但有任务时: a 整块隐藏（用户原话「没有打开则不必显示」） / b 仍显示块、只去掉开/关文字。
   选定 a —— 关闭态下任务不会推进, 列出来只会误导; 开关态改由标题栏符号常灰表达。
3. 开关态来源: a 复用 `getDaemon().status().enabled`, 在状态行 ticker 里懒读（与 flowTrack 同款） / b 每次刷新状态列时顺带写进 `statusExtras`。
   选定 a —— 标题栏是同步渲染面, 而 `statusExtras` 是异步取数结果, 走 a 才能在服务晚挂载时自动补上; 也与 flowTrack 的保鲜模式一致。
4. 服务缺失 / 无 `status()`: 保持 `undefined` → 标题栏不渲染该符号（与 flowTrack 同语义）, 状态列也不出块。

## 规划

- 计划改动文件清单:
  - `TUI/src/app/state/types.ts`（新增 `daemonEnabled: boolean | undefined`）
  - `TUI/src/app/state/initial.ts`（初值 `undefined`）
  - `TUI/src/app/state/actions.ts`（新增 `{ type: "daemon"; enabled: boolean }`）
  - `TUI/src/app/state/reducer-view.ts`（新分支, 照 `flow-track` 写法）
  - `TUI/src/app/runtime/wiring.ts`（新增 `maybeRefreshDaemon`, 并挂到 `ctx.self`）
  - `TUI/src/app/runtime/lifecycle.ts`（ticker 里与 `maybeRefreshFlowTrack` 并列调用）
  - `TUI/src/app/layout/title-bar.ts`（`StatusSwitches.daemon?`、`TITLE_ICON.daemon`、渲染分支、注释口径）
  - `TUI/src/app/layout/top-region.ts`（把 `state.daemonEnabled` 透给 switches）
  - `TUI/src/app/components/StatusColumn.ts`（显示条件加 `enabled`、块头去「开/关」）
  - `TUI/tests/status-column.test.ts`（块头断言改 `Daemon · 1/2`; 新增关闭态整块隐藏用例）
  - `TUI/tests/title-bar*.test.ts` 或既有标题栏用例（daemon 符号 on 绿 / off 灰 / 未读到不渲染）
- 明确不做: 不改 `background-daemon` 服务面、不改 `statusExtras` 的 daemon 字段形状、不动其他块、不改 `tui-state.json` 持久化（开关态是进程本地态）。
- 验证: `pnpm run test:tui`、`pnpm run check`、`pnpm -C TUI run build`、`pnpm run demo -- --smoke`、`pnpm run check:docs`。

## 实现记录

- 2026-11-08: 状态与动作: `state/types.ts` 加 `daemonEnabled: boolean | undefined`（注释写明「未读到服务时符号按关灰显示」）, `state/initial.ts` 初值 `undefined`, `state/actions.ts` 加 `{ type: "daemon"; enabled: boolean }`, `state/reducer-view.ts` 加分支（照 `flow-track` 写法）。
- 2026-11-08: 保鲜: `runtime/wiring.ts` 新增 `maybeRefreshDaemon()`（读 `getDaemon().status().enabled`, 值变化才 `apply` + `paint`）, 挂到 `ctx.self`; `runtime/lifecycle.ts` 在状态行 ticker 里与 `maybeRefreshFlowTrack()` 并列调用。
- 2026-11-08: 标题栏: `layout/title-bar.ts` 的 `StatusSwitches` 加 `daemon?: boolean | undefined`、`TITLE_ICON` 加 `daemon: "\u{F017}"`（`fa-clock_o`）、渲染分支 `push(TITLE_ICON.daemon, switches.daemon === true ? on : off)` —— **无条件 push**, 未读到服务时按关灰; `layout/top-region.ts` 把 `state.daemonEnabled` 透进去。
- 2026-11-08: 状态列: `components/StatusColumn.ts` 的 Daemon 块显示条件加 `extras.daemon.enabled`（关闭即整块隐藏）, 块头改为 `Daemon · running/total`。
- 2026-11-08: 冻结基线重冻（用户明确许可「允许审查 diff 后重冻」）: 重跑 `TUI/scripts/freeze-focus-frame.mts`, 15 场景中 11 个 w60 场景的第 0 行多一个符号、行尾补白少 2 列; 4 个 w20 场景无变化（列宽不足, 符号组本就整组让位）。重冻原因已追加到脚本头注释。

## 偏差

- 决策 4 改为「符号始终显示」: 原计划沿用 flowTrack 的「未读到服务（`undefined`）→ 整项省略」, 用户 2026-11-08 裁定「1 的符号, 但该符号始终显示」; 落地为 `undefined` 也渲染、按关（灰）配色。
- 计划里「`TUI/tests/title-bar*.test.ts` 新增用例」落地在既有 `tests/title-bar.test.ts`（本包没有 `title-bar*.test.ts` 通配文件）; 另按实际影响更新了两处既有断言: `tests/title-bar.test.ts` 的中宽场景 40 → 44 列（符号组多一个符号后 40 列会整组让位, 优先级语义不变）、`tests/status-column.test.ts` 的块头 `Daemon 开 · 1/2` → `Daemon · 1/2`。

## 测试与证据

- 冻结基线逐场景 diff（重冻前备份 vs 重冻后, 脚本比对）: 15 个场景, 仅 11 个 w60 场景第 0 行变化 —— 例 `focus-null@w60` 由 `…\u{F09AA} \u{F04C6} \u{F009F}  <title>…` 变为 `…\u{F09AA} \u{F04C6} \u{F009F} \u{F017}  <title>…`（行尾补白 26 → 24 列）; `focus-*@w20` 四个场景 0 差异。
- `pnpm run test:tui`: 1871 pass / 0 fail（重冻前同样本为 11 fail, 全部是 focus-frame 基线）。
- 新增用例: 标题栏 `daemon 开关符号始终显示（开绿 / 关灰 / 未读到服务也按关灰）`; 状态列「daemon 关闭 → 整块隐藏」并入既有五块用例。
- `pnpm run demo -- --smoke`: SMOKE_PASS 42 项。
- `pnpm run check` / `pnpm -C TUI run check` / `build`: 通过。
- `pnpm run check:docs`: 通过（119 篇现行 Markdown / 959 个 .ts, 错误 0 / 警告 0）。

## 途中发现

- `TUI/src/app/app-deps.ts:95-103` 有**重复注释行**（`getPinNotes` / `getDaemon` / `getAgentGroup` 各写了两次, 来自提交 `1ea1e74b`）——与本任务无关, 已按流程在 `TUI/docs/BACKLOG.md` 登记新条目。

## 收尾

- BACKLOG 条目已移除, 本文件移入 `TUI/docs/archived/`。
- 回写: 无 README / SPEC 变更（状态列块头文案变化已由测试固化; `TUI/docs/SPEC.md` 未列 Daemon 块头字面量）。
- 遗留: 无。
