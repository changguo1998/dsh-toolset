# 插件开发状态追踪

> 依据 `DEVELOPMENT-BACKLOG.md` 插件规划；各插件待办任务见其插件目录下 `TASKS.md`，本表只记状态、不记细节。
> 状态：未开始 / 进行中 / 阻塞 / 完成（另有：暂缓）。
> 更新约定：状态变化时更新本表；任务完成并合入本分支后清理对应 `TASKS.md`。
> **里程碑进度**：三插件首版 + r2、P1 七插件（goal-contract / metric-loop / output-compress / fs-digest / hash-edit / ast-tools / security-guard）均已完成并合入 main；剩余 P2 插件未开始，rate-guard 暂缓。

| 插件 | 阶段 | 分支 | 状态 | 备注 |
|------|------|------|------|------|
| herdr-integration | P1 | — | 完成 | 首版 + r2（turn/end blocked 桥源，0.1.5 对齐）已合入 main |
| task-engine | P0 | — | 完成 | 首版 + r2（第二迭代：fan-out/语义验收/step 裁决/蕴含门，0.1.5 对齐）已合入 main |
| knowledge-base | P0 | — | 完成 | 首版 + r2（0.1.5 对齐 + 宿主联调 smoke）已合入 main |
| goal-contract | P1 | — | 完成 | 访谈式 Done-when 契约起草 + 落 dsh-goal 事件源，33 单测；已合入 main |
| metric-loop | P1 | — | 完成 | 指标循环引擎与计划续排，31 单测；已合入 main |
| output-compress | P1 | — | 完成 | 大输出摘要与切片索引入库（knowledge-base 共享库），42 单测；已合入 main |
| fs-digest | P1-P2 | — | 完成 | outline/signatures/pruned 三模式文件摘要，41 单测；已合入 main |
| hash-edit | P1 | — | 完成 | LINE:HASH 锚定读写编辑，43 单测；已合入 main |
| ast-tools | P1 | — | 完成 | ast-grep 搜索/替换/大纲，27 单测；已合入 main |
| security-guard | P1-P2 | — | 完成 | 危险命令黑名单 + 敏感文件保护，32 单测；已合入 main |
| rate-guard | P2 | — | 暂缓 | 已入计划，先不实现 |
| workflow-ext | P2 | — | 未开始 | |
| code-intel | P2 | — | 未开始 | |
| web-ext | P2 | — | 未开始 | |
| session-broker | P2 | — | 未开始 | |
| command-template | P2 | — | 未开始 | |
| context-report | P2 | — | 未开始 | |
| TUI 扩展 | P2 | — | 未开始 | /workflows 面板、声音提醒 |
| 内容资产 | P2 | — | 未开始 | workflow 模板 + skill 内容 |
