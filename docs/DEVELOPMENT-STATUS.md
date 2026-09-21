# 插件开发状态追踪

> 依据 `DEVELOPMENT-BACKLOG.md` 插件规划；各插件待办任务见其插件目录下 `TASKS.md`，本表只记状态、不记细节。
> 状态：未开始 / 进行中 / 阻塞 / 完成（另有：暂缓）。
> 更新约定：状态变化时更新本表；任务完成并合入本分支后清理对应 `TASKS.md`。
> **里程碑进度**：三插件首版 + r2、P1 七插件（goal-contract / metric-loop / output-compress / fs-digest / hash-edit / ast-tools / security-guard）均已完成并合入 main；**TUI 排版重构（主线 A 契约迁移 + 主线 B Box 模型）已完成并合入 main**（见 `TUI/TASKS.md`，2026-09）；**TUI 排版性能（折行/宽度有界缓存 + `charWidth` 码点表 + paint 同 tick 合帧，`TUI_LAYOUT_CACHE=0` 可关）已完成**（机制与基准见 `TUI/IMPLEMENTATION.md`「排版缓存与绘制合帧」）；**TUI 主题调色板可配置化已完成**（`tui.config.json` theme 段：内联 > `paletteDir` 上游文件 > 内置兜底；语义槽位 `gray/border/code/focus` 数据化，随上游 fff 配色更新不再内嵌漂移；`/theme` 协议不变）；**P2 部分功能与命令扩展已完成并合入 main**：`/workflows` 面板（P2#16，`343a3f2`）、`/council` 二次意见（P2#18，`083ca77`）、`/search` 多 provider 聚合（P2#24，`8ebe163` + 审计整改 `e44a8a5`）、声音提醒（P2#33，`87935ae`），以及 A1-A5 命令 `/task` `/guard` `/memory` `/loop` `/contract`（对应插件只读查询面已落地，`c31f4ec`→`ec94879` 等）；剩余 P2 插件未开始，rate-guard 已取消（不迁移，见对比文档 §5.4）。

| 插件 | 阶段 | 分支 | 状态 | 备注 |
|------|------|------|------|------|
| herdr-integration | P1 | — | 完成 | 首版 + r2（turn/end blocked 桥源，0.1.5 对齐）已合入 main |
| task-engine | P0 | — | 完成 | 首版 + r2（第二迭代：fan-out/语义验收/step 裁决/蕴含门，0.1.5 对齐）已合入 main |
| knowledge-base | P0 | — | 完成 | 首版 + r2（0.1.5 对齐 + 宿主联调 smoke）已合入 main |
| goal-contract | P1 | — | 完成 | 访谈式 Done-when 契约起草 + 落 dsh-goal 事件源，35 单测；已合入 main |
| metric-loop | P1 | — | 完成 | 指标循环引擎与计划续排，35 单测；已合入 main | /loop 接线（A4）✅ · /contract 接线（A5）✅ |
| output-compress | P1 | — | 完成 | 大输出摘要与切片索引入库（knowledge-base 共享库），42 单测；已合入 main |
| fs-digest | P1-P2 | — | 完成 | outline/signatures/pruned 三模式文件摘要，42 单测；已合入 main |
| hash-edit | P1 | — | 完成 | LINE:HASH 锚定读写编辑，43 单测；已合入 main |
| ast-tools | P1 | — | 完成 | ast-grep 搜索/替换/大纲，27 单测；已合入 main |
| security-guard | P1-P2 | — | 完成 | 危险命令黑名单 + 敏感文件保护，37 单测；已合入 main |
| rate-guard | P2 | — | 已取消 | pi 侧已移除（能力由 pi 核心 provider-retry 内建 + 扩展 provider-guard 承接），不迁移（对比文档 §5.4） |
| workflow-ext | P2 | — | 未开始 | |
| code-map | P2 | — | 未开始 | 设计已定（2026-09-21，见 `code-map/DESIGN.md`）：结构层索引 + 调用图 + 报告，首版不含 LSP 语义层 |
| web-ext | P2 | — | 未开始 | |
| session-broker | P2 | — | 未开始 | |
| command-template | P2 | — | 未开始 | |
| context-report | P2 | — | 未开始 | |
| TUI 扩展 | P2 | — | 完成（P2 部分） | /workflows 面板（P2#16）、/council（P2#18）、/search（P2#24）、声音提醒（P2#33）与 A1-A5 命令（/task /guard /memory /loop /contract，C1-C5）均已合入 main；C6/C7 裁定维持排除、C8 /review 裁定搁置；另新增启动自动清理空会话（`session.autoCleanEmpty`，默认关，复用 `/session` 清理判据全目录执行）；活动区排列（`activityPlacement` 黄金比自动选上下/左右）与「agent 工作中 Enter 排队（官方 followup 逐条入队）+ 未认领消息以排队块钉在历史区右下角（灰竖线）」、排版尺寸收敛到单一 `frameGeometry`；**2026-10 增量（已合入）**：状态栏 git 段（分支 + ↑/↓ 领先落后 + 未暂存 `+ ~ -`）、历史区与活动区滚动解耦（非 final 输出不再撑大回合组）、渲染帧率上限 `frameIntervalMs`（真实接线 10Hz，窗口末合帧）、**活动区详略两态 `/verbose on\|off`**（SPEC §6.8 状态 2 紧凑：每条目 1 行 + 行尾 `…`）、测试入口（根 `npm test` 并行调度 + `test:tui` 过滤）、状态列宽 `statusColumnDivisor` 5（1/5） |
| 内容资产 | P2 | — | 未开始 | workflow 模板 + skill 内容 |
