# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**不复用已退役号段（≤ 47）**，`TUI/src`、`TUI/tests` 注释中的 `TUI#n`（n ≤ 26）均为旧编号的历史引用；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。

## 待办

- **待办** **#48 会话别名的 TUI 显示桥**：session-channel 的「会话别名」功能（`session-channel/docs/BACKLOG.md` F1）需 TUI 侧只读桥把别名显示到界面上——标题栏或状态列的会话块显示别名（未设别名时维持现状）。数据经 `ctx.get("sessionChannel")` 的只读面（F1 落地后提供别名查询/列表）。落点：`TUI/src/app/adapter/dsh.ts`（读取别名面）+ `TUI/src/app/state.ts` 与渲染层（标题栏 / 状态列）。依赖：F1 实现后才有别名数据与查询面；本条目只动 TUI 侧，不改 session-channel。验收：设别名后 TUI 对应会话显示别名；未设别名时行为不变；session-channel 未挂载时静默降级（不报错、不空占位）。来源：2026-09-29 #30 交付后用户提出。状态：待接取。优先级 P2。
