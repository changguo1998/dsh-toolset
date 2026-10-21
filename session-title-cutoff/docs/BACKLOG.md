# session-title-cutoff 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 条目详情（待办）

（无。）

> 2026-10-21 关闭：「0.2.1 宿主下标题生成仍落 fallback（provider 已注册但 `generate` 无产出）」已修复并**从本清单移除** —— 真因是 0.2.1 helper 的 `resolveSessionTitleLlmConfig` 键面收窄（只认 `maxInputBytes` / `maxOutputTokens` / `timeoutMs` / `provider` / `model`），本包把含 `targetWords` / `targetCjkCharacters` 的整份配置透传，每次 `apply` 抛 `unknown config key` 并在注册前早退，**provider 从未注册**。修法：只把执行控制键交 helper、措辞两键本包校验、删 0.2.0 兼容分支（合并提交 15806bc；本包 16 例全绿）。真机 3 项通过：标题 `source.kind=provider` 且 `provider=session-title-cutoff`；`session/title-llm-request` 带 `titleProvider` 与 `route={provider:"tollgate",model:"ds4f"}`；`/rename` 后新增 `source.kind=user` 的标题。restart 后标题保留未验证（`/restart` 需由启动器启动，未设置 `DSH_RESTART_FILE`）。追踪文档归档为 `session-title-cutoff/docs/archived/2026-10-21-title-fallback-config-split.md`。
