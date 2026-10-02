# md-map 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **ref 边的可见性与影响面口径**：① 未命中的行内代码路径 token（本仓实测去重 1629 个）完全不可见——文档改名 / 写错路径时静默丢边，建议 report 增「未解析行内代码路径 token：N（仅计数、不进 broken）」作为漂移探针；② ref 计入 backlinks 稀释 impact 语义（`callers(docs/BACKLOG.md)=146` 全为 ref、`impact` 覆盖 204 篇里的 154 篇），建议 callers / impact 增可选 kind 过滤或分离计数；③ `summary()` 未暴露 `refEdges`（与 `report` 不对称） | 2026-10-02 ref/代码区条目的子代理审阅（问题 5-6 + 漏项） | `md-map/src/{query,render,tools}.ts` + 测试 + README | 1 h | P2 |
