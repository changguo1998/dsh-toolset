# task-engine 待办

> 职责：task-engine 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与能力（见 `task-engine/README.md`）、架构与设计取舍（见 `task-engine/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `task-engine/docs/archived/`，不在此重复。

## 待办

（当前无未完成项）

## 记录

> 2026-11-04 关闭：「子任务数改口径：不设上限，超阈值必须声明枚举来源」完成并移出清单：门禁硬上限 `maxChildren = 7` 改为声明阈值 `enumerationThreshold = 8`（数量不设上限），超阈值时 `task_decompose` 须带 `enumeration`（`source` + 逐条 `items`）并给每个子任务填 `enum_item`，机械门禁校验「条目数 = 子任务数、双向一一对应」；`engine.decompose` 透传、工具参数与描述同步；新增 9 例（gate 6 / tools 3），包内 180 例与根 `check` / `build` 全过。追踪文档 `task-engine/docs/archived/2026-11-04-child-count-enumeration.md`。

> 2026-10-27 关闭：「子帧 failed 后整棵树卡死」已修（`failFrame` 失败向上传播，祖先与根一并 failed，根进终态后可开新一轮）；`pnpm test` 151 例全绿，追踪文档 `task-engine/docs/archived/2026-10-27-task-engine-failure-cascade.md`。

（当前无未完成项；TUI 任务面板多轮标识已按改动位置移入 TUI，并已于 2026-10-05 完成归档——见 `TUI/docs/archived/2026-10-05-task-panel-rounds.md`）
