# `/memory` 的 `replace` 与 `remove` 子命令（接取条目：`docs/BACKLOG.md` §2「1. `/memory` 的 `replace` 与 `remove` 子命令」）

状态：进行中（仅接取：本文档已建，调研未开始）　　开启：2026-10-22　　关闭：—
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

给 TUI 的 `/memory` 增加两个写子命令：`remove`（删除指定条目）与 `replace`（用新内容替换，语义为先删后写）。目标是让错误的 U / P 层条目有**唯一且受控的删除路径**——现在 `memory-base` 的 `forget` 服务面已就绪但全仓无调用方。

交付：命令可定位条目（按 id / 关键字命中后确认）、删除后 `search` 不再返回、计数正确；`replace` 的半途失败可回滚。

边界：不动 S 层（系统层按设计只读）；不改检索排序与写入闸门；不恢复已移除的 `review` 审阅面板（只顺手修 `commands.ts` 里过期描述）。

## 调研

（待填；重点：写权归属 —— memory-base 另开管理面 vs TUI `registerKind`）

## 决策

（待填）

## 规划

### 计划改动文件清单

（初判，调研后定稿）

- `memory-base/src/`（写面或管理面；现写侧只经 `MemoryScope.forget`，见 `memory-base/src/scope.ts:46`）
- `TUI/src/app/index.ts`（`handleMemoryCommand`）、`TUI/src/app/commands.ts:319-320`（描述仍写已移除的 `review`）
- 两侧测试：`memory-base/tests`、`TUI/tests`

### 验收

（初判）

- 删一条 U / P 条目后 `search` 不可见、计数正确；不存在的 ref 返回 0；S 层越权明确拒绝
