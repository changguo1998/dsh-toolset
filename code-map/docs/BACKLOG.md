# code-map 待办

> 职责：code-map 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、能力与查询契约（见 `code-map/README.md`）、架构与取舍（见 `code-map/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `code-map/docs/archived/`，不在此重复。

## 待办

- **#1 修 `kindBucket` 对导出符号的分类**〔状态: 待办, 2026-11-01〕（2026-11-01）：`src/report/builder.ts:13` 的 `kindBucket` 按子串判类, `export_statement` 落 `other`, 成员 `property_signature` / `property_identifier` 与空 `astKind` 同样落 `other`, 导致 `report.kindCounts` 对导出符号基本失真 → 期望按 ast-grep `outline` 的实际 kind 取值补映射 (导出声明取被导出节点的 kind, 或把 `export_statement` 归到内层声明), 并给出改前改后的 `kindCounts` 快照 → 改动位置 `src/report/builder.ts` 与报告用例 / 快照 → 验收 `pnpm -C code-map run check` / `test` / `test:integration` 全绿, 快照差异逐项说明 → 来源 `docs/implementation/2026-10-28-history-cleanup-code-map.md` 偏差第 2 条与 `docs/implementation/2026-10-28-history-cleanup-03b-supplement.md` T4 → P3.

（本条会改 `report.kindCounts` 的可见输出, 需单独立项与快照; 阶段 3b 只登记不修。）
