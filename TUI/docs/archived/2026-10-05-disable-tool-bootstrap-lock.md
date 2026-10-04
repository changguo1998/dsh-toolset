# 不要锁定（停用锚定工具引导挂载）（接取条目：`TUI/docs/BACKLOG.md`「不要锁定（停用锚定工具引导挂载）」）

状态：关闭　　开启：2026-10-05　　关闭：2026-10-05
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按用户 2026-10-05 指示「不要锁定」：停用锚定工具引导的两阶段工具锁定-释放（首请求只暴露 core 目录 + persona-only + contexts 清空），按与 kickoff 相同的「**注释而非删除**」方式处理——注释 `main.ts` 的 `installToolBootstrap` 挂载，实现原样保留。

背景：同日先关掉 kickoff（追踪文档 `TUI/docs/archived/2026-10-05-disable-bootstrap-kickoff.md`）；用户确认「不要锁定」= 连锁定一起关，首请求恢复原样透传。

## 调研

- 锁定的唯一挂载点：`TUI/src/main.ts` `makeSetup()` 内 `void installToolBootstrap(agentCtx, { enabled: config?.toolBootstrap ?? true })`（与 `installSessionModelSelection` 并列，同一条 `system-prompt/assemble` waterfall）。
- `toolBootstrap` 是唯一开关；kickoff 门控已注释后，该开关只剩锁定在用。
- 既有测试不受影响：`TUI/tests/tool-bootstrap.test.ts` 直接调用 `installToolBootstrap(runtime)` 测过滤器本身（纯行为），与挂载点无关。

## 决策

- **注释停用挂载**（`main.ts`），实现（`installToolBootstrap` 与 `tool-bootstrap.ts` 全部逻辑）原样保留；注释写明「恢复 = 取消注释（`toolBootstrap` 开关随挂载一并恢复生效）」。
- `toolBootstrap` 选项注释同步（挂载停用期间开关不生效）。
- 文档同步：`TUI/docs/DESIGN.md` 锚定节「健壮性」条、`TUI/README.md` 锚定段落。
- 不做：不删代码、不改过滤器与纯函数、不改 profile、不动测试。

## 规划（计划改动文件清单）

- `TUI/src/main.ts`（挂载注释 + 选项注释）
- `TUI/docs/DESIGN.md`、`TUI/README.md`
- `TUI/docs/BACKLOG.md`（条目录入 / 收尾清理）
- `TUI/docs/implementation/2026-10-05-disable-tool-bootstrap-lock.md`（本文件，收尾移入 `TUI/docs/archived/`）

明确不做：不删 kickoff / 锁定相关代码；不改 profile（`~/.dsh`）；不新增配置键。

## 实现记录

- `TUI/src/main.ts`：`installToolBootstrap` 挂载整体注释；`toolBootstrap` 选项注释补「2026-10-05 用户裁定不要锁定：挂载已注释停用，开关暂不生效」。
- 文档：`TUI/docs/DESIGN.md` 锚定节、`TUI/README.md` 锚定段落各补关停说明（与原 kickoff 关停说明并列）。

## 测试与证据

- `TUI && npm run check` / 根 `npm run check` / `npm run test:tui`（全量）/ `npm --prefix TUI run build` → **全部通过**（exit 0）。
- 静态行为核对：挂载注释后 `system-prompt/assemble` 不再做工具过滤与 persona / contexts 改写（另一挂载 `installSessionModelSelection` 不受影响）。
- 待人工确认：重启 `dsh --profile fff` 后新会话首请求为全量工具目录（无锁定、无 persona-only）。

## 收尾

- 回写：`TUI/docs/DESIGN.md`、`TUI/README.md`；`TUI/docs/BACKLOG.md` 条目清理移除；本文件移入 `TUI/docs/archived/`。
- 未做：`TUI/docs/STATUS.md`（用户择时）。
