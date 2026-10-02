# fs-digest 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **`render` 非全函数**：`render({}, undefined)` 抛 `TypeError`、`{ok:true, mode:"signatures"/"pruned"}` 抛 `TypeError`、`{ok:true, mode:"outline"}` 抛 "list is not iterable" —— 与 `#3 render 全函数性` 同类但形态是「对非法形状抛错」；建议按 `hash-edit` 的 `jsonText` 口径兜底（或对每个 mode 分支做形状守卫），并补「非法 / 缺字段形状不抛」用例 | 2026-10-02 其余包 render 顺序探针条目的子代理审阅（漏项） | `fs-digest/src/main.ts` + 测试 | 0.5-1 h | P2 |
