# TUI 待办与开放项

> 职责：TUI 包的**未完成**待办（TUI 的变更优先写在本目录）；跨包待办见 `docs/BACKLOG.md`，TUI 现状见 `TUI/docs/STATUS.md`
> 编号口径：扁平连续 `#n`，本文件内唯一，**仅供阅读**——不用于追踪文档的命名与引用（追踪文档按条目标题引用，见 `docs/WORKFLOW-STANDARD.md` §6/§7）；**不复用已退役号段（≤ 46）**，`TUI/src`、`TUI/tests` 注释中的 `TUI#n`（n ≤ 26）均为旧编号的历史引用；本文件的 `#n` 与项目级 `docs/BACKLOG.md` 的 `#N` 互不关联
> 本文件只列未完成项；已完成项见 git 历史与 `TUI/docs/archived/`，不在此重复。

## 待办

- **待办** **#47 mock demo 冒烟（`npm run demo -- --smoke`）在 HEAD 上两项断言失败（`compaction-summary-toast` / `shell-submit`）**：① `TUI/demo/main.ts:253` 断言 `sent.includes("ls")`，但 `$` shell 模式已改本地执行（TUI#37）不再进 `adapter.sent`；② `TUI/demo/main.ts:408` 断言帧含「压缩完成：已压缩182条历史消息」，实际未出现（文案 / payload 漂移待核）。已用 clean tree（HEAD `8671b82`）复现 `SMOKE_FAIL n=2`，与 #45 改动无关。落点：`TUI/demo/main.ts`（断言与序列同步）。来源：2026-09-28 跑 demo 冒烟做附加验证时发现。状态：待接取。优先级 P2。
