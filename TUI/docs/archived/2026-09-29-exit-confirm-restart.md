# 退出确认增加「重启」选项（接取条目：`TUI/docs/BACKLOG.md`「退出确认增加『重启』选项（实现；启动器循环方案）」）

状态：进行中　　开启：2026-09-29
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

退出确认面板（`EXIT_CONFIRM_PANEL_ID`）新增第三项「重启 dsh（保留会话）」：TUI 只发信号，重启由用户启动器完成。契约定稿见 `TUI/docs/DESIGN.md`「退出确认 ·「重启」方案」（2026-09-29 定稿，提交 `8fc60d6`）：

- 触发 = 退出码 `75`；载荷 = `DSH_RESTART_FILE` 指向的交接文件（写当前活跃会话 id，单行，`0600`）。
- 仅当 `DSH_RESTART_FILE` 存在时显示该选项；写失败只告警仍退 75（启动器退回 `-c`）。
- 重启路径**跳过**「退出时清理空会话」；「取消 / 退出 dsh」既有语义不变。

## 决策

- 交互：沿用合成问答面板（回车确认高亮项，无二次确认）；默认高亮仍为「取消」。
- 环境变量读取放在 `main.ts`（接线），`App` 只接收 `deps.restartHandoffPath`（保持 app 层可测）。
- 退出码经既有机制传递：`process.exitCode = 75` 后走 `renderer.close()`（renderer 尊重既有退出码，TUI#14 行为）。
- 不做（边界）：非启动器启动时不显示该项；不自己 respawn；不顺带实现启动器侧的其它 TODO。

## 规划

计划改动文件清单：

1. `TUI/src/app/index.ts`：常量 `DSH_RESTART_EXIT_CODE`、`AppDeps.restartHandoffPath`、面板第三项（门槛判断）、`finishExitConfirm` 重启分支（写文件 + 置退出码 + 跳过空会话清理）、`dispose()` 增加跳过条件。
1. `TUI/src/main.ts`：把 `process.env.DSH_RESTART_FILE` 接进 deps。
1. `TUI/tests/exit-confirm.test.ts`：新增用例（无变量时不显示该项；有变量时显示并写 id + 退出码 75 + 跳过空会话清理；写失败降级；既有路径不变）。
1. `TUI/README.md`：启动器片段（契约规范版）与说明。
1. 本追踪文档；`TUI/docs/BACKLOG.md` 状态与收尾。

## 实现记录

- 2026-09-29：`TUI/src/app/index.ts` —— 新常量 `DSH_RESTART_EXIT_CODE = 75` 与
  `EXIT_CONFIRM_RESTART_LABEL`；`AppDeps.restartHandoffPath`（门槛）；`requestExitConfirm`
  按门槛追加第三项；`finishExitConfirm` 增重启分支（`writeRestartHandoff` 写 session id →
  `process.exitCode = 75` → `restartPending = true` → `dispose()`）；`dispose()` 在
  `restartPending` 时跳过「退出清理空会话」直接 `finishDispose()`。
- 2026-09-29：`TUI/src/main.ts` —— `main()` 选项与 AppDeps 透传 `restartHandoffPath`，
  实际接线取 `process.env.DSH_RESTART_FILE`。
- 2026-09-29：`TUI/tests/exit-confirm.test.ts` —— `makeApp` 支持 deps 覆盖；新增 3 例
  （无变量不显示第三项；有变量显示 + 写 id + 退出码 75 + 跳过清理扫描 + 释放 adapter；
  写失败只告警仍退 75）。
- 2026-09-29：`TUI/README.md` —— 新增「「重启 dsh（保留会话）」与启动器约定（BACKLOG #51）」
  小节：契约三条 + 启动器片段 + 直接启动时的行为说明。

## 测试与证据

- `npm --prefix TUI run check` ✓；`npm --prefix TUI run build` ✓。
- `npm run test:tui` 全量 1214/1214 ✓（含既有 4 例退出确认用例未回归）。
- 用例覆盖：门槛（无 `DSH_RESTART_FILE` 不显示）、重启分支（交接文件内容 `s1\n`、退出码 75、
  跳过空会话清理扫描、renderer/adapter 正常释放）、写失败降级（ENOENT 只告警仍退 75）。
- 真机（2026-09-30，通过）：用户把循环片段贴进 `~/fff/config/aliases.d/10-ai.sh` 的 `fffdsh`
  （我按其授权代改，`bash -n` / `zsh -n` 通过）后重启验证：面板出现第三项，选中后进程自动被拉起、
  会话连续 ✓。真机同时发现一个**面板排版残留**（上下键移动选中时首项上方多出一行）——与重启功能
  无关，已按流程追加 `TUI/docs/BACKLOG.md` #52（待接取）交后续处理，本任务不改该处代码。
- 真机链路核对：选中第三项 → 进程以 75 退出 → 启动器读交接文件 → `--resume <id>` 拉起 →
  会话历史与标题连续（用户确认「功能正常」）。

## 收尾

- 状态：**完成**（`TUI/docs/BACKLOG.md` #51 从待办清单移除；真机验证 2026-09-30 通过）。
- 落点：`TUI/src/app/index.ts`（面板第三项 + 重启分支 + 跳过退出清理）、`TUI/src/main.ts`
  （`DSH_RESTART_FILE` 接线）、`TUI/tests/exit-confirm.test.ts`（3 例）、`TUI/README.md`
  （启动器契约与片段）；启动器侧改动在项目外（`~/fff/config/aliases.d/10-ai.sh`，用户授权代改）。
- 遗留：真机发现的面板排版残留另立 `TUI/docs/BACKLOG.md` #52（与重启功能无关，本任务未改）。
- 提交：本任务最后一次提交（收尾提交，含实现 + 测试 + 文档 + 归档）。
