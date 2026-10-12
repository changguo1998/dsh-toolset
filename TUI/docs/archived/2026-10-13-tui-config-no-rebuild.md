# 2026-10-13 tui 行配置变更不再重建 fiber（不丢会话）

- 层：TUI
- 接取条目（按标题引用）：〈tui 行非热应用配置变更会重建 fiber 并把 dsh 一起带退出（已修 theme，其余键仍会）〉
- 开始：2026-10-13　状态：完成

## 目标

dsh 运行中改写 profile patch 里 `tui` 行的**任意**配置键，都不再让 dsh 退出、不丢会话：

- 可热应用的键（当前＝`theme`）→ 当次生效；
- 其余键 → 保留会话并在活动区提示「需重启 dsh 才生效」（不静默忽略、也不重建 fiber）。

## 调研

沿用上一任务（`archived/2026-10-13-tmux-detach-and-hmr-theme-exit.md`）的机制链与结论：

- dsh-hmr 看住 `profile.patchPath` → cordis `Fiber.update()` → 默认 `restart()` = 卸载 + 重装本行插件；
- 卸载走本插件 effect 清理 → `disposeApp()` → `app.dispose()` → `finishDispose()` → `renderer.close()` → `process.exit(process.exitCode ?? 0)`；
- 上一任务只把「只含 `theme` 的更新」接进 per-fiber `internal/update` 钩子并否决重启；其余键仍走默认重启 → 进程退出。

本任务要判定的是：**放开「否决重启」到全部键**是否安全，以及「保留会话」是否成立。

## 决策

1. **本行 fiber 的配置更新一律否决重启**（`internal/update` 钩子恒不调 `next`）。理由：重建会把 dsh 进程一起带退出（丢会话），而配置值是「下次启动才需要」的数据，没有任何场景需要为此重建正在跑的 UI。
2. **不做**「重建但退出改为不退出」（原条目候选 ②）：它要动 renderer 的 `exitOnClose` 语义、`App.dispose` 的退出职责与启动器 75 号重启契约（`/quit`、退出确认、`/restart` 三条真机路径都要回归），而收益只是「配置全部当次生效」——用户可见差异可以用一条提示替代，风险/收益不成比例。
3. **不做**「扩大热应用面」（原条目候选 ① 的加宽版）：`messageGutter` 存在 `AppState` 里、经 `initialState` 一次性落定，热改要新增 reducer + 处理排版缓存失效（正是刚修过的 boxcache 那类回归面）。本次只保留既有 `theme` 热应用。

## 规划 / 计划改动文件清单

- `TUI/src/main.ts`：把 `isLiveConfigUpdate` 换成 `planConfigUpdate`（分类：可热应用的键 + 需重启的键），`makeConfigHotUpdateHandler` 改为「恒否决重启 + 应用 theme + 对未支持键发提示」；`themeSink` 扩成 `configSink`（应用 + 提示两个出口）。
- `TUI/src/app/index.ts`：无需改（提示走既有公开 `appendExternalLog`）。
- `TUI/tests/config-hot-update.test.ts`：改/补用例（任何键变更都不调 `next`；未支持键发提示且不重建；theme 仍当次生效）。
- `TUI/README.md`：`config.theme` 段附近补「配置热更新一律不重建本行插件；未支持键提示需重启」。
- `TUI/docs/BACKLOG.md`：收尾移除条目。

## 实现记录

- `main.ts`：`isLiveConfigUpdate`（布尔判定）换成 `planConfigUpdate(current, next) → { patch, restartKeys }`
  —— 键集合比较 + 键序无关序列化（沿用原 `stableJson`），`LIVE_CONFIG_KEYS = ["theme"]` 决定归类；
  新增 `LiveConfigPatch` / `ConfigUpdatePlan` / `LiveConfigSink` 三个类型。
- `main.ts`：`makeConfigHotUpdateHandler(current, sink)` 现在**恒不调 `nextStep`**（否决重启），
  只做两件事：`patch.theme` 有值 → `sink.apply(patch)`；`restartKeys` 非空 → `sink.notice(...)`
  （文案「profile 配置变更需重启 dsh 才生效: <keys>（会话保留）」）。
- `main.ts`：`main()` 的 `themeSink` 换成 `configSink`（`apply` → `app.applyTheme`，
  `notice` → `app.appendExternalLog(text, "warn")`，进活动区可回溯）。App 侧无需改动。
- `apply()`：`internal/update` 钩子改传 `configSink`；注释改述「任何配置变更都否决重启」。
- `tests/config-hot-update.test.ts`：按新语义重写（10 例），核心断言是**任何变更档 `nextCalls() === 0`**。

## 测试与证据

- `tsc -p tsconfig.json --noEmit` → 通过；`npm run build` → 通过。
- 全量 `sh scripts/test.sh` → **1495 / 1495 通过**（上一基线 1494；本任务删 9 例、加 10 例）。
- 端到端（隔离 profile 探针，真 dsh + 真 patch 文件；方法与上一任务同一套）：
  把 `tui` 行的 `theme: dark → light` **并新增** `messageGutter: 8`（模拟「非热应用键 + 主题」混合变更）后 8 秒：
  - `pane_dead=0`、`cmd=node` → **进程存活、会话保留**（修复前这类变更会 `restart()` → `process.exit()`）；
  - 活动区出现提示行「profile 配置变更需重启 dsh 才生效: messageGutter…」；
  - 帧内调色板码整体切换（`38;2;100;214;230` → `38;2;0;119;132` 等）→ `theme` 当次生效。

## 收尾

- BACKLOG：条目移除（其后条目顺延编号）。
- 文档回写：`README.md` 的 `theme` 段改为「profile 配置的任一变更都不重建本行插件；可热应用键当次生效，其余提示需重启且会话保留」。
- 遗留：① 除 `theme` 外的键仍未热应用（设计选择，见「决策」3；要加需按键单独做，`messageGutter` 涉及 `AppState` reducer 与排版缓存失效）；② 探针台 `tmp/dshhome` 随收尾清理（复现步骤见上一任务追踪文档，可重建）。
