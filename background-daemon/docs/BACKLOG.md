# background-daemon 待开发功能清单

> 模块级 BACKLOG（项目级条目见 `docs/BACKLOG.md`）；关闭后条目移入 `background-daemon/docs/archived/`。

## 未完成项

**1. background-daemon 默认不开启, 需显式命令开启（1b）**（2026-10-20 登记, 来源: 用户检查插件初始设置时确认的口径「默认不打开, 需人工用命令开启」）：**现象 / 现状** —— 插件经 fff `dsh.profile.bundles` 挂载后, `runtime.scheduler.start()` 随 apply 启动, 空任务表即闲置, **无「开关」语义**; 任何会话只要挂了插件就能直接建任务 / 投递, 没有「未开启先拦截」的阶段。**期望** —— 显式**开启**命令（如 `/daemon start`）; **默认关闭**: 未开启时模型侧工具 `daemon_task` 与 `/daemon` 子命令按「未开启」口径处理（提示先开启 / 拒绝排程）, 执行开启命令后调度与投递生效。**接取时裁定** —— ① 「关闭」语义: 未开启时工具 / 命令可用但拒绝排程, 还是直接提示未开启（不透出子命令）; ② 开启状态持久化: 每会话独立还是全局开关, 存哪里（memory / JSON）; ③ 重启后是否保持开启（或默认回关闭）。**落点（预估）** —— `background-daemon/src/main.ts`（开启门 + 命令/工具口径）+ `background-daemon/README.md`; 追踪文档一份 `background-daemon/docs/implementation/<date>-bgdaemon-enable-gate.md`。**验收** —— 未开启时创建任务被拦截并给出可读提示; 执行开启命令后正常排程 / 投递; 状态按裁定持久化; 全量 check / build / test 通过。**估时** —— 待细化（初判 0.5 天）。**优先级** —— P3。
