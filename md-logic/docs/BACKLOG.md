# md-logic 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **改写面：按节替换 + 锚点安全**：`md_logic` 目前只读（structure / blocks / links），条目原话是「供模型按节读、**按节改**」。要落地需设计安全语义：替换前校验目标节的标题行与行范围仍与解析时一致（漂移即拒）、整批原子写、失败不落盘；可选注册 `md_logic` 的 `replace_section` action 或独立工具，并在描述里与 `hash_edit`（行级锚点）/ 官方 `edit`（文件级版本守卫）划清分工。本条落地时同时补 README 的改写段 | 2026-10-02 建包条目的取舍（`docs/archived/2026-10-02-md-logic-package.md` D5） | `md-logic/src/{parse,edit,tools}.ts` + 测试 + README | 2-3 h | P2 |
