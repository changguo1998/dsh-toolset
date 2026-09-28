# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**不复用已退役号段（≤ 47）**，`TUI/src`、`TUI/tests` 注释中的 `TUI#n`（n ≤ 26）均为旧编号的历史引用；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。

## 待办

- **待办** **#48 启动后自动触发首轮工具调用（代替用户完成锚定解锁）**：`toolBootstrap` 生效（全部 `deepseek-*` 模型 + 开关未关）且会话**未解锁**的启动场景（新建 / 未解锁的恢复会话），由 TUI 代替用户发一条自检消息（`source.kind:'tool-bootstrap'`，按用户输入模式显示、正文以 `[AUTO]` 开头），驱动模型发起首个工具调用，完成锚定解锁；该消息不参与任务模式分类，模式仍在真实首消息到达时才落定；`rule-engine` 的 skill 自动加载随之在启动阶段完成。落点：`TUI/src/main.ts`（门控）、`TUI/src/app/index.ts`（调度与回显）、`TUI/src/app/adapter/tool-bootstrap.ts`（判据 / 消息构造 / 模式缓存修正）。来源：用户 2026-09-28 需求（启动即完成锚定；显示形态同日定）。状态：进行中。优先级 P2。
