# 核查各工具执行路径, 确认是否需要走官方围栏（接取条目：docs/BACKLOG.md「核查各工具执行路径, 确认是否需要走官方围栏」）

状态：进行中　　开启：2026-11-08　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

1. 系统核查本仓全部写入面 / 工具的执行路径, 逐条标注是否走官方 `ctx.fs`（围栏 / 观察守卫 / 审批瀑布）——已确认绕开的: `hash-edit` / `ast-tools`（`ast_replace`）/ `md-logic`（`replace`）; 待核查: memory-base / fs-digest / output-compress / preference-analysis / background-daemon / session-paths 等数据目录写入面。
2. 按判定口径逐条给出结论: ① 写用户 / 项目工作文件 → 需要走围栏; ② 写插件自有数据目录 → 可不走, 但写明边界与越界风险; ③ 有安全敏感的越界写 → 需要走。
3. 产出「工具写路径 × 是否走围栏」核对表 + 逐条结论; 判定需改走的, 登记为后续 BACKLOG 条目（如 `hash-edit` 改走 `ctx.fs`, 即重开 `docs/ARCHITECTURE-REUSE.md` §4 D 的改造点）。
4. 本条为核查 / 调研任务, 不改任何代码; 产出落文档与条目。
