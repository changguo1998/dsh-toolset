# task-engine 待办

> 职责：task-engine 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与能力（见 `task-engine/README.md`）、架构与设计取舍（见 `task-engine/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `task-engine/docs/archived/`，不在此重复。

## 待办

| # | 事项 | 来源 | 落点 | 工作量（估） | 优先级 |
|---|------|------|------|--------------|--------|
| 1 | **语义面接线（`audit` / `entail`）**：插件形态只接 `runCommand` / `snapshotPath` / `maxConcurrent` —— semantic 验收缺 `audit` hook → 一律 fail-closed；`entail` 语义蕴含门缺 hook → 跳过。即「双重门禁」的语义半边与 semantic 验收在真机**不生效**（README「边界与外包」记为注入式 hook 边界，但此前无接线计划）。期望：用 `ctx.subagents` fork 一个 audit run（或等价机制）接上，并定 prompt / `outputSchema` 口径 | 撰写 `docs/DESIGN.md` 时发现（2026-10-02） | `task-engine/src/main.ts`（hook 接线）、`src/acceptance.ts`（`AuditRequest` / `AuditVerdict` 已就位） | 1.5 h | P2 |
