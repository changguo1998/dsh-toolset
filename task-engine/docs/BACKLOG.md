# task-engine 待办

> 职责：task-engine 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与能力（见 `task-engine/README.md`）、架构与设计取舍（见 `task-engine/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `task-engine/docs/archived/`，不在此重复。

## 待办

| # | 事项 | 来源 | 落点 | 工作量（估） | 优先级 |
|---|------|------|------|--------------|--------|

| 1 | **`task_status` 在多轮后随轮数膨胀（森林全量）**：每轮根标题相同、旧轮 done 占 token。期望：默认返回**当前轮完整 + 旧轮根摘要**（或加 `rounds` 计数）。来源：2026-10-05 多轮根帧的收尾审阅（次要项） | `src/tools.ts`（输出映射）+ `README.md` 工具表 | 30 min | P3 |
| 2 | **TUI 任务面板多轮无轮次标识**：旧轮 done 与新轮同列，用户分不清哪棵是新轮。期望：面板按 `round` 分组 / 给旧轮打标（`provide["taskEngine"].query()` 已能拿到森林）。来源：同上（跨包但与本包多轮语义同源） | `TUI/src/app/dsh.ts`（任务面板）+ `TUI/docs/SPEC.md` | 1 h | P3 |
