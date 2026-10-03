# md-logic 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **`content` 首行标题与 `heading` 不校验一致性**：`replace` 只要求非空 `content` 以标题行开头，不校验其文本 / 级别与 `heading` 的关系——换标题文本（属合法重命名）与改层级（h2 → h3 会连带改动后续节的层级归属）都被静默接受；建议（待裁定）：级别不一致时拒绝或提示，文本不一致放行 | 2026-10-04 md-logic「content 结构校验」任务的子代理审阅 | `md-logic/src/edit.ts` + 测试 + README | 0.25-0.5 h | P3 |
| 2 | **节级内容 hash 锚点（漂移盲区）**：现有锚点是标题 + 行范围，挡不住「同标题 + 同范围但节体 / level 已被外部改动」（实测 4 组反例）；建议 `sha256(该节原文行) 前 8 位 hex`——`structure` 输出附 `·#xxxxxxxx`、`replace` 增可选 `section_hash`（不符 → `section_stale`，additive 不动读面语义）；另需说明读→rename 的 TOCTOU（rename 前复 stat ino/size/mtimeMs 或复算 hash） | 2026-10-02 改写面条目的子代理审阅（P1-7） | `md-logic/src/{edit,render,tools}.ts` + 测试 | 1-1.5 h | P2 |
