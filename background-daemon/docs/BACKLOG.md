# background-daemon 待开发功能清单

> 模块级 BACKLOG（项目级条目见 `docs/BACKLOG.md`）；关闭后条目移入 `background-daemon/docs/archived/`。

## 未完成项

**1. background-daemon 默认不开启, 需显式命令开启（1b）**（2026-10-20 登记, 来源: 用户检查插件初始设置时确认的口径「默认不打开, 需人工用命令开启」）：**现象 / 现状** —— 插件经 fff `dsh.profile.bundles` 挂载后, `runtime.scheduler.start()` 随 apply 启动, 空任务表即闲置, **无「开关」语义**; 任何会话只要挂了插件就能直接建任务 / 投递, 没有「未开启先拦截」的阶段。**期望** —— 显式**开启**命令（如 `/daemon start`）; **默认关闭**: 未开启时模型侧工具 `daemon_task` 与 `/daemon` 子命令按「未开启」口径处理（提示先开启 / 拒绝排程）, 执行开启命令后调度与投递生效**优先级** —— P3。

**2. 创建指向不可解析会话的 S 档任务时仍弹 memory 写透告警**（2026-10-21 登记, 来源: 「取消跨实例传播」任务真机验证途中发现）：**现象 / 现状** —— `daemon_task create` 成功返回后, `TaskStore.create → mirror.save` 对 `sessionPaths.sessionDirFor` 无法解析的会话抛错, 镜像记失败并 stderr 告警（`tui-local.jsonl` 出现 error-tone 行, 实测 `ts=1792514637835`）; 到点路径已由 `skipped` 抑制覆盖, 创建路径没有。**期望** —— 二选一: 创建期对 S 档目标会话做可解析性校验并以明确错误码拒绝（不落半截任务）, 或把该写透失败降级为一次性 debug 记录（不弹 error 行）。**优先级** —— P3。
