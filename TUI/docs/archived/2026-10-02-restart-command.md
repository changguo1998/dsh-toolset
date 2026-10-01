# /restart 命令：显式重启（接取条目：TUI/docs/BACKLOG.md「`/restart` 命令：显式重启（等价退出确认面板第三项）」）

状态：关闭　　开启：2026-10-02　　关闭：2026-10-02
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新增本地命令 `/restart`：输入即执行（不弹确认面板），语义**完全等价**退出确认面板第三项「重启 dsh（保留会话）」——写会话交接文件（当前活跃会话 id）→ 置退出码 `75` → 收尾退出并跳过空会话清理；无 `DSH_RESTART_FILE`（无启动器 / 直接 `dsh` 启动）时只给 notice 提示「重启不可用」，留在 TUI 不退出。

## 调研

来源：`TUI/src/app/index.ts`（`requestExitConfirm` / `finishExitConfirm` / `writeRestartHandoff` / `dispose`）、`TUI/src/main.ts`（`DSH_RESTART_FILE` 接线）、`TUI/docs/DESIGN.md`「信号与退出契约」「退出确认 ·「重启」方案」、`TUI/tests/exit-confirm.test.ts`、用户 2026-10-02 真机反馈。

- **触发起点**：用户报告「`Ctrl+D` 弹退出方式面板，但 `/quit` 直接退出」。2026-09-29 的裁定为**有意设计**（`/quit` 是显式输入，不弹面板；见 `TUI/docs/DESIGN.md`「信号与退出契约」），故不改为命令弹面板。
- **替代方案（用户裁定）**：退出方式不一致不改；改为补一个**显式重启命令** `/restart`，按「输入命令应当直接执行」的不弹面板口径实现。
- **既有重启路径（复用面）**：`finishExitConfirm` 中选中 `EXIT_CONFIRM_RESTART_LABEL` 时执行三件事——`writeRestartHandoff()`（写活跃会话 id 单行、`0600`；无活跃会话 / 写失败只告警）、`process.exitCode = DSH_RESTART_EXIT_CODE`（75）、`restartPending = true` 后 `dispose()`。`restartPending` 使 `dispose()` 跳过空会话清理（`autoCleanEmpty` 分支）。
- **可用性判据（既有）**：`restartAvailable()` —— `deps.restartHandoffPath` 非空（`main.ts` 从 `process.env.DSH_RESTART_FILE` 接线）。面板据此决定是否显示第三项；`/restart` 据同一判据决定「执行」还是「提示不可用」。
- **命名冲突**：仓库内 `"restart"` 命令名与 `"/restart"` 文本零命中（宿主注册表 6 条与各插件命令均无），`LOCAL_COMMANDS` 也无 `restart` 路由 → 可安全新增。

## 决策

1. **口径**：`/restart` = 面板第三项，**不弹确认面板**（用户：「输入命令应当直接执行」）。与 `/quit` 的直接执行口径一致。
1. **无启动器时**：只提示不退出——notice「重启不可用：需由启动器启动（未设置 DSH_RESTART_FILE）」（`tone: warn`），留在 TUI。理由：写不了交接文件时退出码 75 无接收方，会变成「静默普通退出」，与用户预期（重启）不符。
1. **实现方式**：把面板第三项的三步收尾抽成 App 私有方法 `requestRestart()`，面板分支与 `/restart` 共用（单一来源，避免两处漂移）。不新增 deps / 不改 `main.ts` 接线（`restartHandoffPath` 已就位）。
1. **可见性**：`LOCAL_COMMANDS` 增 `restart` 条目（补全候选与路由单一来源）、`/help` 增一行、`COMMANDS.md` §1.1 与 `README.md`「Slash 命令」同步。
1. **不做**：不给 `/restart` 加二次确认或 `--force` 类参数；不做无启动器时的自行 spawn（旧进程未退 / 并发打开同一会话）；不动退出确认面板语义与按键；不顺手改相邻代码。

## 规划

任务拆分（每步的验证）：

1. `TUI/docs/BACKLOG.md` 条目 + 本追踪文档 → 验证：条目「进行中」、文件头条目按标题引用。
1. `TUI/src/app/commands.ts`：`SlashRoute` 增 `"restart"`，`LOCAL_COMMANDS` 增 `{ name: "restart", route: "restart", desc: "重启 dsh（保留会话；需启动器）" }` → 验证：`npm --prefix TUI run check`。
1. `TUI/src/app/index.ts`：`handleSlash` 增 `case "restart"` → `this.handleRestartCommand()`；新增 `handleRestartCommand()`（判据 → `requestRestart()` 或 notice）；抽 `requestRestart()`；`finishExitConfirm` 的重启分支改调 `requestRestart()`；`helpLines()` 增 `/restart` 行 → 验证：`check` + `test:tui`。
1. `TUI/tests/exit-confirm.test.ts`：新增两条用例（有交接文件路径 → 写 id、退出码 75、关 renderer、释放 adapter、不触发空会话清理；无路径 → notice 且不退出）→ 验证：`npm run test:tui -- exit-confirm.test.ts`。
1. 文档：`TUI/docs/DESIGN.md`（退出契约段 + 重启方案交互段）、`TUI/docs/COMMANDS.md`（§1.1 计数）、`TUI/README.md`（Slash 命令） → 验证：`format` + 自查 diff。
1. 门禁：`npm --prefix TUI run check` / `run build` / `npm run test:tui` + 真机（启动器启动后 `/restart` 由外层循环以 `--resume <id>` 拉起）→ 验证：输出与真机现象记录在「测试与证据」。

计划改动文件清单（**只改这些**）：

- `TUI/docs/BACKLOG.md`（条目：进行中 → 完成并清理）
- `TUI/docs/implementation/2026-10-02-restart-command.md`（本追踪文档，关闭时移入 `TUI/docs/archived/`）
- `TUI/src/app/commands.ts`
- `TUI/src/app/index.ts`
- `TUI/tests/exit-confirm.test.ts`
- `TUI/docs/DESIGN.md`
- `TUI/docs/COMMANDS.md`
- `TUI/README.md`

明确不做：不改 `/quit` 与退出确认面板语义（2026-09-29 裁定保留）；不加命令参数与二次确认；不做无启动器时的进程自拉起；不动宿主面 (`TUI/src/main.ts` 的 `DSH_RESTART_FILE` 接线已就位)；不改其它包。

## 实现记录

2026-10-02：

- `TUI/src/app/commands.ts`：`SlashRoute` 增 `"restart"`；`LOCAL_COMMANDS` 在 `/exit` 后增 `{ name: "restart", route: "restart", desc: "重启 dsh（保留会话；需由启动器启动）" }`。
- `TUI/src/app/index.ts`：`handleSlash` 增 `case "restart"` → `handleRestartCommand()`；新增 `requestRestart()`（把面板第三项原三步收尾抽为单一来源：`writeRestartHandoff()` → `process.exitCode = DSH_RESTART_EXIT_CODE` → `restartPending = true` → `dispose()`）与 `handleRestartCommand()`（`restartAvailable()` 为否 → notice warn 且不退出；为是 → `requestRestart()`）；`finishExitConfirm` 的重启分支改调 `requestRestart()`（行为不变）；`helpLines()` 增 `/restart` 行。
- `TUI/tests/exit-confirm.test.ts`：文件头注释补 `/restart` 口径；新增两条用例——① 有交接文件路径：写活跃会话 id `s1\n`、退出码 `75`、关 renderer、释放 adapter、不触发空会话清理、不弹确认面板；② 无路径：notice「重启不可用」、不退出、未释放 adapter、不置退出码 75。
- 文档：`TUI/docs/DESIGN.md`（退出契约段 + 重启方案「交互」段）、`TUI/docs/COMMANDS.md`（§1.1 计数 40 条 = 35 命令 + 5 别名）、`TUI/README.md`（「重启 dsh（保留会话）」段 + 本地命令表 + 退出契约段）。

## 测试与证据

- `npm --prefix TUI run check`：通过（无 `error TS`）。
- `npm run test:tui -- exit-confirm.test.ts`：9 pass / 0 fail（较改动前 +2 条）。
- `npm run test:tui`（全量）：1293 pass / 0 fail。
- `npm --prefix TUI run build`：通过（`tsc -p tsconfig.json`）。
- 真机（2026-10-02 用户确认通过）：由启动器（`fffdsh` 之类）启动后输入 `/restart` → 进程以退出码 75 结束、外层循环以 `--resume <id>` 拉起同会话；直接 `dsh --profile fff` 启动时 `/restart` 只提示「重启不可用」。

## 收尾

- 回写：`TUI/docs/DESIGN.md`（「信号与退出契约」段 + 「退出确认 ·「重启」方案」交互段）、`TUI/docs/COMMANDS.md`（§1.1 本地命令计数 40 条 = 35 命令 + 5 别名）、`TUI/README.md`（「重启 dsh（保留会话）」段、本地命令表、退出契约段）——已随 `ce74daa` 提交。
- BACKLOG：`TUI/docs/BACKLOG.md`「`/restart` 命令：显式重启（等价退出确认面板第三项）」标完成并从待办清理移除（条目已不再列于该文件，历史见本追踪文档与 git 历史）。
- 遗留项：无。真机确认通过（2026-10-02），未发现新问题。
- 临时文件：无（本轮未产生 `tmp/` 产物）。
- 本文件移入 `TUI/docs/archived/2026-10-02-restart-command.md`。
