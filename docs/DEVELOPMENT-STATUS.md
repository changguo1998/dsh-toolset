# 插件开发状态追踪

> 依据 `DEVELOPMENT-BACKLOG.md` 插件规划；各插件待办任务见其插件目录下 `TASKS.md`，本表只记状态、不记细节。
> 状态：未开始 / 进行中 / 阻塞 / 完成（另有：暂缓）。
> 更新约定：状态变化时更新本表；任务完成并合入本分支后清理对应 `TASKS.md`。
> **里程碑进度**：里程碑一（P0）已完成（herdr-integration / task-engine / knowledge-base 均已合入 main）；里程碑二（P1）待启动。

| 插件 | 阶段 | 分支 | 状态 | 备注 |
|------|------|------|------|------|
| herdr-integration | P1 | — | 完成 | 已合入本分支与 main；分支已清理；脚手架已验证 |
| task-engine | P0 | — | 完成 | 首版最小闭环已合入本分支与 main；分支已清理 |
| knowledge-base | P0 | — | 完成 | 四表双 FTS5 + ctx_knowledge + 记忆 CRUD 已合入；分支已清理 |
| goal-contract | P1 | — | 未开始 | task-engine 契约已稳定，可启动 |
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
