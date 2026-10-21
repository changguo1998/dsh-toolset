# session-title-cutoff 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 条目详情（待办）

**1. 0.2.1 宿主下标题生成真机仍落 fallback（provider 已注册但 `generate` 无产出）**（2026-10-21 登记, 来源: 升级适配 0.2.1 任务的 D3 真机实测, 追踪文档 `docs/archived/2026-10-21-host-upgrade-0.2.1-rc.2.md`「偏差」节）：**现象 / 现状** —— 宿主 0.2.0 → 0.2.1 后, helper `@deepseek-ai/dsh-session-title-llm` 的导出从 `generateSessionTitleWithLlm` 改名 `executeSessionTitleLlm`（签名改为接收 `prepared` 并内部走 `ctx.llm.prepareCall`）; 本包已完成适配（helper 结构面 + 本地 prepared 组装 + 旧 API 兼容分支, 单测 11 例全绿, dist 含 execute 分支, profile 路由已切 `tollgate/ds4f`, 独立 tab 实例加载新构建）——但真机实测 `session/title` 事件 `source` 仍为 `{"kind":"fallback"}`, **无 `session/title-llm-request` 事件、无 `[session-title-cutoff] warn`**。**期望** —— 定位宿主侧差异：① 0.2.1 `sessionTitle.register` 对 provider `generate` 返回形状的要求是否与 0.2.0 相同（execute 分支返回 `{title, messageSeqs, model}` 与宿主期望逐字段核对）; ② provider 异常是否被宿主静默吞并记 fallback（必要时在 pane 里用日志钩子抓 provider 错误）; ③ `DSH_SESSION_SEED` 等自定义环境变量是否干扰会话身份 / 标题触发。修复后真机四项复验（标题生成 / llm-request 事件携带 `provider` 与 `route` / `/rename` 覆盖 / restart 后标题保留）。**优先级** —— P2（标题为 TUI 可见性辅助, 不影响功能主线）。**状态注记** —— 进行中: 2026-10-21（追踪文档 `session-title-cutoff/docs/implementation/2026-10-21-title-fallback-config-split.md`; 真因更正为「配置键面未按 0.2.1 收窄, provider 从未注册」, 见该文档调研 05 / 06）。
