# task-engine 待办

> 职责：task-engine 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与能力（见 `task-engine/README.md`）、架构与设计取舍（见 `task-engine/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `task-engine/docs/archived/`，不在此重复。

## 待办

| # | 事项 | 来源 | 落点 | 工作量（估） | 优先级 |
|---|------|------|------|--------------|--------|
| 1 | **executor 子代理的工具面未收窄（可反向操作引擎 / 树）**：`subagent` executor 子代理与裁决子代理同为完整 agent，工具面里带 `task_decompose` / `task_implement` / `task_execute` / `task_stop` / `task_status`，故执行方也能操作任务树（例：自行 `task_stop` 别人的帧、`task_decompose` 别人的父帧）；裁决 run 已于 2026-10-04 收窄（`toolFilter.deny`），执行 run 未收窄——而执行方并不需要 `task_*`（它的产物由调用方经 `task_implement` / `task_stop` 回写）。期望：执行后端同样传 `toolFilter.deny`（复用 `judgeToolFilter` + `ownToolNames`），或明确裁定保留该可见性并写进 README。来源：2026-10-04「裁决子代理可见 `task_*` 工具」任务的决策审阅（范围裁定外，按流程登记） | `task-engine/src/main.ts`（executor 适配器的 `runChildOnce` 调用）+ README | 0.5 h | P3 |
| 2 | **裁决 run 的 `toolFilter` 失效兜底**：deny 名单按**本实例注册成功**的名字收集，宿主 `restrict()` 按**全局注册表**校验——名字在发起时已失效（插件 remount / 卸载重注册的空窗）会让裁决 run 直接发起失败（audit fail-closed 打回，而这不是模型的判定）。期望：带 filter 的 `svc.start` 失败时**去 filter 重试一次**并在告警留痕（加固不该让裁决 run 挂掉）。来源：2026-10-04「裁决子代理可见 `task_*` 工具」任务的收尾审阅（提示项） | `task-engine/src/main.ts`（`runChildOnce` 的 start 失败路径）| 0.5 h | P3 |
