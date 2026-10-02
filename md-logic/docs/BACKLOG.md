# md-logic 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

| # | 条目 | 来源 | 落点 | 工作量 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **节级内容 hash 锚点（漂移盲区）**：现有锚点是标题 + 行范围，挡不住「同标题 + 同范围但节体 / level 已被外部改动」（实测 4 组反例）；建议 `sha256(该节原文行) 前 8 位 hex`——`structure` 输出附 `·#xxxxxxxx`、`replace` 增可选 `section_hash`（不符 → `section_stale`，additive 不动读面语义）；另需说明读→rename 的 TOCTOU（rename 前复 stat ino/size/mtimeMs 或复算 hash） | 2026-10-02 改写面条目的子代理审阅（P1-7） | `md-logic/src/{edit,render,tools}.ts` + 测试 | 1-1.5 h | P2 |
| 2 | **混合换行文件会被整体改写**：风格判定是「含 CRLF 即全文件 CRLF」二值口径 → 混合 EOL 与 CR-only 文件在替换一节后被整体统一（违背「除目标节外字节一致」目标）；建议按行保留各自终止符，只重写目标区间 | 2026-10-02 改写面条目的子代理审阅（P1-5） | `md-logic/src/edit.ts` + 测试 | 0.5-1 h | P2 |
| 3 | **`content` 无结构校验**：`replace` 的 `content` 首行若不是标题行，会把该节静默并入父节（节从节树消失）；`content` 内引入新标题会改动祖先与后续节范围（与 D7「不做插入节」不符）；建议：非空 `content` 首行必须是标题行（ATX / setext），否则 `content_invalid`，并在成功渲染里提示「结构可能已变，继续改请重新 structure」 | 2026-10-02 改写面条目的子代理审阅（P1-9） | `md-logic/src/{edit,tools}.ts` + 测试 + README | 0.5 h | P2 |
