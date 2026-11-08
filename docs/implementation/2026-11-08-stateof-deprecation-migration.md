# sessionProjections.stateOf(session, key) 弃用迁移（接取条目：docs/BACKLOG.md「sessionProjections.stateOf(session, key) 弃用迁移」）

状态：进行中　　开启：2026-11-08　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 消除 rc.1 对三处 `stateOf` 读法的弃用警告：`task-engine`（`tokenUsage`）、`context-report`（`sessionStats` / `sessionContext`）、`rule-engine`。
2. 能拿到领域服务的改读领域服务（如 `tokenMeter`）, 其余改用宿主公开的投影 handle 或后续替代 API。
3. 迁移后功能面零变化、无弃用警告；各包测试与全仓 check / build / test 全绿。
