# 修改默认揭示工具列表（接取条目：tool-consult/docs/BACKLOG.md「修改默认揭示工具列表（initialTools 改为 9 个: 保留 write, 去掉 edit / todo_write, 加 hash_read / hash_edit）」）

状态：进行中　　开启：2026-11-08　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 把 `tool-consult` 缺省 `initialTools` 从 9 个核心工具调整为 9 个：`bash` / `read` / `glob` / `grep` / `ask_user_question` / `skill` / `hash_read` / `hash_edit` / `write` —— **保留 `write`**（整文件创建 / 覆写, 无追加与局部替换能力, 用户核实后决定保留）, 去掉 `edit` / `todo_write`, 新增 `hash_read` / `hash_edit`（工具名已核对 `hash-edit/src/index.ts:300,332`）。
2. 同步 `tool-consult/README.md`：`initialTools` 缺省值、包定位段的「缺省只留 9 个核心工具」表述改为新名单（仍为 9 个）。
3. 更新配套缺省名单断言（`tool-consult/tests/`）, 全仓 check / build / test 全绿。
