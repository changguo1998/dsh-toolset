# 插件开发状态追踪

> 依据 `DEVELOPMENT-BACKLOG.md` 插件规划；各插件详细任务见其 worktree 内 `TASKS.md`，本表只记状态、不记细节。
> 状态：未开始 / 进行中 / 阻塞 / 完成（另有：暂缓）。
> 更新约定：状态变化时更新本表；细节与过程记录回各 `TASKS.md`。

| 插件 | 阶段 | 分支 | 状态 | 备注 |
|------|------|------|------|------|
| herdr-integration | P1 | — | 完成 | 已合入本分支与 main；分支已清理；脚手架已验证 |
| task-engine | P0 | feat/task-engine | 未开始 | 主线最小闭环；worktree 已建 |
| knowledge-base | P0 | feat/knowledge-base | 未开始 | 并行线，与 task-engine 零依赖；worktree 已建 |
| goal-contract | P1 | — | 未开始 | 待 task-engine 契约稳定 |
| metric-loop | P1 | — | 未开始 | |
| output-compress | P1 | — | 未开始 | 依赖 knowledge-base |
| fs-digest | P1-P2 | — | 未开始 | |
| hash-edit | P1 | — | 未开始 | |
| ast-tools | P1 | — | 未开始 | |
| security-guard | P1-P2 | — | 未开始 | |
| rate-guard | P2 | — | 暂缓 | 已入计划，先不实现 |
| workflow-ext | P2 | — | 未开始 | |
| code-intel | P2 | — | 未开始 | |
| web-ext | P2 | — | 未开始 | |
| session-broker | P2 | — | 未开始 | |
| command-template | P2 | — | 未开始 | |
| context-report | P2 | — | 未开始 | |
| TUI 扩展 | P2 | — | 未开始 | /workflows 面板、声音提醒 |
| 内容资产 | P2 | — | 未开始 | workflow 模板 + skill 内容 |
