# 关掉启动自检 kickoff（接取条目：`TUI/docs/BACKLOG.md`「关掉启动自检 kickoff」）

状态：关闭　　开启：2026-10-05　　关闭：2026-10-05
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

按用户 2026-10-05 指示关掉启动自检 kickoff（`[AUTO]` 自检消息，TUI 启动与 `/new` 两条路径），且按「**注释而非删除**」处理：停用调用点、实现原样保留，可随时恢复。

背景（承接同日的参考项目核对）：kickoff 会在用户真实任务之前先跑一轮自检请求，其首个 `tool/call`（`pwd`）即完成晋升 → 用户真实任务拿不到「任务匹配的最小首轮」（首轮锚定窗口被自检占用）；同时参考项目对 V4.1 Flash 的正向证据不足。用户据此裁定关掉。

## 调研

- kickoff **没有独立开关**：`toolBootstrap` 同时控制 kickoff 与锚定过滤（`installToolBootstrap`），关它等于连锚定一起关——用户只要关 kickoff，故走代码注释停用。
- 调用点仅两处，均在 `TUI/src/main.ts`：启动路径 `shouldAutoKickoff(...) ? BOOTSTRAP_KICKOFF_TEXT : undefined` → `main({ bootstrapKickoffText })`；`/new` 路径 `kickoffForNewSession = () => newSessionKickoffText({...})` → `main({ bootstrapKickoffForNewSession })`。
- 下游对 `undefined` 已是「不发送」：`App.startBootstrapKickoff()` 在正文非 string 时早退（`app/index.ts:2435-2437`）；`/new` 路径 `deps.bootstrapKickoffForNewSession?.()` 返回 undefined 即不补发（`app/index.ts:3785`）。
- 既有测试不受影响：`TUI/tests/tool-bootstrap.test.ts` 覆盖纯函数（门控矩阵 / 消息构造 / 首消息读取 / 模式不落定），`TUI/tests/app.test.ts` 的 kickoff 用例显式传入正文测 App 调度——两者保持有效，无需改动。

## 决策

- **注释停用两处门控调用点**（`main.ts`）：原注释与实现原样保留，另加占位赋值（`const kickoffText: string | undefined = undefined` / `const kickoffForNewSession = (): string | undefined => undefined`）与「恢复 = 取消注释、删占位赋值」说明。
- 不动 `toolBootstrap` 语义、不动锚定 filter、不动 App / adapter 的 kickoff 实现、不动测试。
- 文档同步：`TUI/docs/DESIGN.md`「锚定工具引导」kickoff 条目、`TUI/README.md` 锚定段落各补关停说明。

## 规划（计划改动文件清单）

- `TUI/src/main.ts`（两处门控注释停用 + `main()` 选项注释）
- `TUI/docs/DESIGN.md`、`TUI/README.md`（关停说明）
- `TUI/docs/BACKLOG.md`（条目录入 / 收尾清理）
- `TUI/docs/implementation/2026-10-05-disable-bootstrap-kickoff.md`（本文件，收尾移入 `TUI/docs/archived/`）

明确不做：不删 kickoff 相关代码；不改过滤器与门控纯函数；不改 profile（`~/.dsh`）；不新增配置键。

## 实现记录

- `TUI/src/main.ts`：启动与 `/new` 两处门控调用整体注释（原说明注释保留），改为占位赋值恒传 `undefined`；`main()` 的 `bootstrapKickoffText` / `bootstrapKickoffForNewSession` 选项注释补「2026-10-05 用户裁定关掉 kickoff」口径。
- 文档：`TUI/docs/DESIGN.md` 锚定节 kickoff 条目、`TUI/README.md` 锚定段落各补关停说明（实现保留、恢复方式）。

## 测试与证据

- `TUI && npm run check` → 通过（注释后 `shouldAutoKickoff` / `newSessionKickoffText` / `BOOTSTRAP_KICKOFF_TEXT` 仅剩注释引用；tsconfig 未开 `noUnusedLocals`；`readDefaultSelection` 仍在别处使用）。
- 根 `npm run check` → 通过（exit 0）。
- `npm run test:tui` → 全量通过（exit 0）。
- `npm --prefix TUI run build` → 通过。
- 静态行为核对：`undefined` 在两个下游均为「不发送」；`[AUTO]` 消息构造与发送实现保留，恢复路径明确。
- 待人工确认：重启 `dsh --profile fff` 后新开会话应无 `[AUTO]` 消息；`/new` 同样无（锚定过滤与其余注入不受影响）。

## 收尾

- 回写：`TUI/docs/DESIGN.md`、`TUI/README.md`；`TUI/docs/BACKLOG.md` 条目清理移除；本文件移入 `TUI/docs/archived/`。
- 未做：`TUI/docs/STATUS.md`（用户择时）。
