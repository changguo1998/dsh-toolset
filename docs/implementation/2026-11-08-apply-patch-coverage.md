# apply_patch 写面覆盖（接取条目：docs/BACKLOG.md「apply_patch 写面覆盖: security-guard 与 escalation-hint」）

状态：进行中　　开启：2026-11-08　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 启用 `apply_patch` 工具前补齐写面覆盖：`security-guard` 的 `FILE_TOOLS` / `WRITE_FILE_TOOLS` 未登记它（参数只有 `input` 补丁文本, 目标路径藏在补丁文本里）——从补丁文本解析目标路径, 或把整工具按写类拒绝。
2. `escalation-hint` 的 write / edit 类提示补 `apply_patch` 的同类提示。
3. 同步 `security-guard` / `escalation-hint` 两份 README 的覆盖边界说明。
4. 保持 rc.1 出厂 `applyPatch: false`（本任务只补覆盖面, 不启用工具；启用与否的取舍见「宿主升级待裁定」条目）。
