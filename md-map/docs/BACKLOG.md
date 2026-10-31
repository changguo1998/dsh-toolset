# md-map 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | `apply` 缺 `ctx` 守卫 | `docs/implementation/2026-10-28-history-cleanup-md-map.md`「测试与证据」（2026-11-01 集成层装配时实测） | `src/index.ts` 的 `apply` | 小 | P3 |
| 2 | `warn` 的 `??` 依赖 `info()` 返回值 | 同上（集成层实测） | `src/index.ts` 的 `warn` | 小 | P3 |

## #1 apply 缺 ctx 守卫〔状态: 待办, 2026-11-01〕

`apply(ctx)` 未判断 `ctx === null || typeof ctx !== "object"`, 传 `undefined` 时抛 `TypeError: Cannot read properties of undefined (reading 'tools')`, 与「缺 `ctx.tools` 时降级不抛」的口径不一致 → 期望非对象 `ctx` 也按降级处理（不注册、不 provide、不抛）→ 与 `hash-edit` 的 #1 同源, 收口归阶段 3。

## #2 warn 的 ?? 依赖 info() 返回值〔状态: 待办, 2026-11-01〕

`ctx.logger?.(name).info(message) ?? process.stderr.write(...)` 中 `info()` 的回调返回值决定右侧是否执行: 常规 logger 返回 `void` 时右侧恒执行（有 logger 也重复落 stderr）; 若 logger 返回非 `undefined`（如 pino 返回日志句柄）则 stderr 告警被吞 → 期望改为显式分支: 有 logger 只走 logger, 否则写 stderr。
