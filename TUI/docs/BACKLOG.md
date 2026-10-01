# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**每次整理时按当前顺序从 1 起重新编号**（故 `TUI/src`、`TUI/tests` 注释中的 `TUI#n` 仅作历史线索）；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。
> 组织：按主题分组（组内按编号）；条目统一结构——现象 / 现状 → 期望 →（可选）复现 / 疑似范围 / 接取时裁定 → 落点 → 验收 → 来源·状态·优先级。

## 待办

> 临时分组（2026-10-02：#1 接取后重编；已完成条目已清理）：
>
> 当前条目：`#1` 进行中，其余无。

### 1. `/restart` 命令：显式重启（等价退出确认面板第三项）

- **现状**：重启只能经退出确认面板第三项「重启 dsh（保留会话）」触发——须先 `Ctrl+D` / 750ms 双击 `Ctrl+C` 弹面板，且仅在启动器经 `DSH_RESTART_FILE` 声明时该项才出现；无命令入口（`/quit` 为显式输入、直接退出，2026-09-29 裁定保留）。
- **期望**：新增 `/restart`，输入即执行（显式命令不弹确认面板，与 `/quit` 同口径）：写会话交接文件 → 置退出码 75 → 收尾退出（跳过空会话清理）；无 `DSH_RESTART_FILE`（无启动器 / 直接 `dsh` 启动）时只给 notice「重启不可用」提示，留在 TUI 不退出。
- **落点**：`TUI/src/app/commands.ts`（`SlashRoute` + `LOCAL_COMMANDS`）、`TUI/src/app/index.ts`（`handleSlash` case + 抽出面板第三项共用的重启路径 + `/help` 行）、`TUI/tests/exit-confirm.test.ts`、`TUI/docs/DESIGN.md`、`TUI/docs/COMMANDS.md`、`TUI/README.md`。
- **验收**：`npm --prefix TUI run check`、`npm --prefix TUI run build`、`npm run test:tui`（新增用例：有交接文件路径 → 写文件 + 退出码 75 + 不触发空会话清理；无路径 → notice 且不退出）；真机由启动器启动后 `/restart` 生效（外层循环以 `--resume <id>` 拉起同会话）。
- **来源**：用户 2026-10-02 口述（退出方式行为不一致讨论的替代方案）。状态：**进行中**。优先级：P2。
