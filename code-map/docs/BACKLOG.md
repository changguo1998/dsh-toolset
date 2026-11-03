# code-map 待办

> 职责：code-map 包内的缺陷与待办（包内变更优先写在本包文档）
> 不负责：跨包待办（见 `docs/BACKLOG.md`）、能力与查询契约（见 `code-map/README.md`）、架构与取舍（见 `code-map/docs/DESIGN.md`）
> 编号口径：扁平连续 `#n`，**仅供阅读**——不用于追踪文档的命名与引用；**每次整理时按当前顺序从 1 起重新编号**；与其它层 BACKLOG 的编号互不关联
> 过期条件：无
> 本文件只列未完成项；已完成项见 git 历史与 `code-map/docs/archived/`，不在此重复。

## 待办

（当前无未完成项。）

> 2026-11-03 关闭：条目「修 `kindBucket` 对导出符号的分类」完成并移出清单（追踪文档 `code-map/docs/archived/2026-11-03-kind-bucket.md`）：`CodeMapSymbol` 增 `symbolType`，`kindBucket` 优先按语义 kind 归一（导出声明与成员不再落 other），缺失时退回 `astKind` 词根；`check` / `build` / `test` 37 例 / `test:integration` 15 例全过，`tmp/kindsample` 快照由 `{other:11, function:1, variable:1}` 变为 8 类分布。
