# hash-edit 待办

> 职责：hash-edit 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与能力（见 `hash-edit/README.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史、`hash-edit/docs/archived/` 与 `hash-edit/tests/`，不在此重复。

## 待办

- **#1 apply 缺 ctx 守卫**〔状态: 待办, 2026-11-01〕（2026-11-01）：`apply(ctx)` 未判断 `ctx === null || typeof ctx !== "object"`, 传 `undefined` 时抛 `TypeError: Cannot read properties of undefined (reading 'tools')`, 与「缺 `ctx.tools` 时告警降级」的口径不一致 → 期望非对象 `ctx` 也只写一条 stderr 告警并返回 → P3 → 来源: `docs/implementation/2026-10-28-history-cleanup-hash-edit.md`（阶段 2 集成层装配时实测; 同类判断散落见总追踪调研 1.8, 统一收口归阶段 3）
