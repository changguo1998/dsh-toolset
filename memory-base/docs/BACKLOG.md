# memory-base 待办

> 职责：memory-base 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、契约与边界（见 `memory-base/README.md` 与 `memory-base/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `memory-base/tests/`，不在此重复。
> 条目结构（2026-10-17 起）：现象 / 现状 → 期望 → 前置 → 落点 → 验收 → 估时 → 来源·状态·优先级。

## 待办

（当前无未完成项）

> 2026-10-18 关闭：「按「只提供分层记忆内容」的新定位瘦身，并补四项纯存储面」已完成并**从本清单移除** —— 追踪文档归档为 `memory-base/docs/archived/2026-10-17-slim-and-storage-surfaces.md`。结论：全局面收窄到八键（`registerKind` / `checkPrivacy` / `getSummary` / `whenReady` / `usage` / `migrate` / `list` / `search`，无写无删）、写入与删除只经 `registerKind` 返回的作用域句柄（`writableTiers` + `preWrite` + 真删返条数）、新增按 kind 列举 `list`、层级恒开启且库惰性创建、S 层落点经 `sessionPaths.sessionDirFor(sessionId)`；提升链 / 候选队列 / 事件沉淀 / 文档索引 / 记忆域 / 容量族连同 7 个源文件与 11 个用例文件一并删除；新增只读工具 `memory_query`。证据：包 `npm run check` / `build` 通过、`npm test` 61 例全绿、`demo` 末行 `demo OK`，合入后全量 29 包 `check` / `build` / `test` 通过。
