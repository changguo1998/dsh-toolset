# 宿主升级待裁定: fs-observation-policy 守卫恢复 与 apply_patch 启用取舍（接取条目：docs/BACKLOG.md「宿主升级待裁定: fs-observation-policy 守卫恢复 与 apply_patch 启用取舍」）

状态：进行中　　开启：2026-11-08　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 由用户裁定是否恢复官方「读后改前」守卫：恢复则 profile patch 加 `- id: fs-observation-policy` + `disabled: false`；不恢复则维持 rc.1 出厂形态并在文档注明取舍。
2. 由用户裁定是否启用 `apply_patch`：启用则先完成「apply_patch 写面覆盖」再开 `tool-fs` 的 `config.applyPatch: true`；不启用则维持 `false` 并同步 `escalation-hint` 提示面边界。
3. 裁定结果落 profile（fff / fff-test）与相关文档, 并回写 `docs/host/HOST-UPGRADE-0.2.2-rc.1.md` §12 的待裁定状态。
