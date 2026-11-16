# flow 流程记录删除失败（FOREIGN KEY constraint failed）修复

- 日期: 2026-11-16
- 条目: 【项目级 §2】flow 流程记录删除失败（FOREIGN KEY constraint failed）(P2, 待排查)
- 方案: 修复类, 走标准流程
- 状态: 进行中

## 现象

`flow_remove`(按 slug) / `flow_rollback` 在 memory-base 项目层删记录时抛
`Error: FOREIGN KEY constraint failed`, 记录一条未删。

## 根因（已复现）

`KnowledgeService.evict()`(`memory-base/src/knowledge.ts:729-765`) 重算
`sources.chunk_count` 时, 其遍历面 `#existingEntries()` 只统计**当前进程已注册且已建表**
的 kind(`knowledge.ts:252-256`, 取自 `KindRegistry.list()`)。若项目层库中存在**某未注册 kind**
残留的分类表仍引用该 source（历史插件改名 / 卸载后表仍在, 或跨会话装载集不一致）, 该引用被漏计
→ source 的 chunk_count 被误算为 0 → `DELETE FROM sources WHERE chunk_count = 0`
(`knowledge.ts:758`) 触发 `REFERENCES sources(id)`(`schema.ts:109`) 外键失败, 事务回滚,
上报该错误。

node:sqlite 默认 `PRAGMA foreign_keys = 1`（启用）, 外键约束生效, 故该漏计场景必然报错。

复现: 在项目层库构造残留分类表 `kind_orphan_old` 引用某 flow source, 仅注册 flow kind 执行
evict 删除, 重算漏计残留引用后删 source 即报 `FOREIGN KEY constraint failed`。副本已复现,
当前 `docs/BACKLOG.md` 思路（库被 `PRAGMA foreign_keys=ON` 打开 / 旧库残留引用）方向正确,
具体机制为本条。

## 修复

`evict` 重算 `chunk_count` 的遍历面改为「库中实际存在的业务分类表」（枚举
`sqlite_master` 中 `kind_*` 且非 FTS/影子表）, 而非仅当前进程注册集合。这样即使某 kind 未注册
（表残留）, 只要它仍引用 source, 就计入 chunk_count, source 不会被误删, 删除操作成功。
原有「chunk_count 归零的 source 被清理」语义在无残留引用的正常库上保持不变。

## 计划改动文件清单

- `memory-base/src/knowledge.ts`: 新增 `#kindTables()`（枚举库中实际业务分类表）, `evict` 改用之。
- `memory-base/tests/knowledge.test.ts`: 新增「未注册残留表仍引用 source 时不误删 / 不抛外键错」用例。
- `docs/archived/2026-11-16-flow-remove-fk.md`: 本文。
- `docs/BACKLOG.md`: 完成后把 §2 该条目标记完成并清理移除。

## 验证

- 反向验证: 真实库副本 + 构造残留表场景, 旧实现（仅 `#existingEntries()`）下 `DELETE sources` 报
  `FOREIGN KEY constraint failed`（复现成功）。
- 修复后: `pnpm run check` 通过; memory-base `pnpm run test` 91 例全绿（含新增「未注册残留表仍
  引用 source 时不误删」用例, 含 source 保留与清残留后归零两断言）; `pnpm run build` 通过;
  全仓 `pnpm run check` / `pnpm run test` 全绿（flow-track 85 例不受影响）。
- 未验证: 真实宿主端到端 `flow_remove` 调用（需要真实该类库现场; 机制已在本库副本复现确认）。

## 收尾

- 已从 `docs/BACKLOG.md` §2 清理该条目。
