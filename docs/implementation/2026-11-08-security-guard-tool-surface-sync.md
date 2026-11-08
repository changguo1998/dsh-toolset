# security-guard 宿主工具面清单过期同步（接取条目：docs/BACKLOG.md「security-guard 宿主工具面清单过期同步」）

状态：进行中　　开启：2026-11-08　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 按 rc.1 实际安装树重跑 `scripts/tool-surface-check.mjs`, 用新输出核对登记表。
2. 更新 `security-guard/README.md` 的「已知多报 / 覆盖边界」清单：`schedule_*` 改名（`schedule_update` → `schedule_edit` 等）、`list_agents` 并入 `dsh-tool-subagent-control`（`list-agents` 行移除）、工具执行器拆分（`tool-executor-native` / `tool-executor-ptc`）。
3. 有漏拦则补登记（可与「apply_patch 写面覆盖」条目一并处理, 同涉 security-guard 登记表与 README）。
