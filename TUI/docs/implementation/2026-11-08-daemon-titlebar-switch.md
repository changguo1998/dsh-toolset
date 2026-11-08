# daemon 开关状态收进标题栏符号区（接取条目：TUI/docs/BACKLOG.md「daemon 开关状态收进标题栏符号区, 状态列 Daemon 块只在打开时显示且不再带开/关文字」）

状态：进行中　　开启：2026-11-08　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 状态列 Daemon 块只在 daemon 打开（`enabled === true` 且 `items.length > 0`）时显示, 关闭时整块不出现。
2. Daemon 块头去掉「开/关」文字, 只保留 `Daemon · running/total`（开/关语义转移到标题栏）。
3. 标题栏左侧符号区新增 daemon 开关符号, 一个符号表达开/关两态, 完全参照既有 `flowTrack` 先例（on 绿 / off 灰, 服务未读到时不显示）。
