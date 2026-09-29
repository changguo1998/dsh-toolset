# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**不复用已退役号段（≤ 47）**，`TUI/src`、`TUI/tests` 注释中的 `TUI#n`（n ≤ 26）均为旧编号的历史引用；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。

## 待办

- **待办** **#51 退出确认增加「重启」选项（实现；tmux respawn 优先）**：退出确认面板（`TUI/src/app/index.ts` 的 `EXIT_CONFIRM_PANEL_ID`，现选项 = 取消 / 退出 dsh）新增第三项「重启 dsh（保留会话）」——按 `TUI/docs/DESIGN.md`「退出确认 ·「重启」可行性」（2026-09-29 调研结论）路线 A 实现：`$TMUX` 下用 `tmux respawn-pane -k` 以「同 profile + `--resume <活跃会话 id>`」原地重启；非 tmux 场景不提供该项（或退化为提示）。验收：tmux 内面板重启后会话连续（历史与标题保留）；重启失败回退界面、不丢会话；「取消 / 退出 dsh」既有路径与按键语义不变；补单元用例（面板选项、命令重建、tmux 缺失回退）。来源：TUI#50 调研结论（2026-09-29）。状态：待接取。优先级 P3。
