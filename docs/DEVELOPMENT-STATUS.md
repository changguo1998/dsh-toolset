# 插件开发状态追踪

> 依据 `DEVELOPMENT-BACKLOG.md` 插件规划；已完成插件的 `TASKS.md` 已随任务收尾清理，后续任务见文末「后续任务」节。
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

## 后续任务（已实现插件的未完成部分）

> 由三插件现状导出（对照各自交付注记与 profile 挂载实况）。执行方式：**后续各建新分支 + worktree 推进**；当前阶段仅同步状态、不建分支。

| 来源插件 | 后续任务 | 状态 | 备注 |
|----------|----------|------|------|
| task-engine | 第二迭代：fan-out 多执行器（#13，就绪池 + agent-team DAG）；semantic 级验收（独立 audit run + outputSchema）；step 级 `accepted`/`next` 裁决（#5）；语义蕴含校验（门禁第二道，§17.2） | 待办 | 首版已挂 profile、4 个 task\_\* 工具注册成功 |
| knowledge-base | 真实 DSH profile 挂载联调（dsh.bundle + cordis.patch.yml）+ `ctx_knowledge` 宿主注册与人工确认 | 待办 | 代码 + 31/31 测试 + glla 审计已过；profile 现仅挂 task-engine |
| herdr-integration | profile 挂载验证（link:，勿用 file:）+ 端到端人工接入 herdr 面板（`scripts/verify-herdr.mjs`）；先复核真实完成度 | 待办 | TASKS.md 未回填，git 记录不足以证明已验证 |
