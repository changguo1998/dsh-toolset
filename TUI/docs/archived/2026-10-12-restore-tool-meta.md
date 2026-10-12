# 恢复路径的历史工具行没有 diff 摘要？（接取条目：`TUI/docs/BACKLOG.md` 的〈恢复路径的历史工具行没有 diff 摘要（`HistoryRow` 不带 `meta`）〉）

状态：已结（**条目撤回：前提不成立**）　　开启：2026-10-12
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标（原条目）

原判断：恢复路径的工具行由 `replay.ts` 从 `HistoryRow` 造交付，而 `HistoryRow` 不带 `meta` → 恢复出来的会话里编辑类工具的结果行看不到 `(+N/-M)`；修法 = `HistoryRow` 加 `meta?` + 恢复产行带 `data.meta` + `replay.ts` 透传。

## 验证（不改代码，先证前提）

- 读码：恢复产行时摘要**已经算进行文本**了 —— `adapter/dsh.ts:417-421` 就是 `toolResultLine(!failed, toolResultDetail(data.message), data.meta)`；`replay.ts` 的 `case "tool"` 只剥状态前缀（`text.replace(/^[✓✗]\s?/, "")`），后缀原样保留 → 渲染出的行与实时线逐字相同。
- 探针（`TUI/tmp/probe-restore-tool-meta.mjs`，走真实 `dist`，调 `normalizeHistoryMessages`）实测：
  - 带 `meta: { before: "a\nb", after: "a\nb\nc" }` → 恢复工具行文本 **`✓ 已写入 (+1/-0)`**；
  - 不带 meta → `✓ 已写入`。

## 结论

**前提不成立：恢复路径本来就显示 `(+N/-M)`**（在产行时算好，属「行文本自带摘要」而非「渲染期按 meta 现算」——两条路径用户可见结果一致）。故本条目**撤回**，不做 `HistoryRow.meta` 的透传（YAGNI）。

## 实现记录

无需改动（零代码变更）。

## 测试与证据

见上「验证」的探针实测输出；未新增用例（无行为缺口可守）。

## 审阅记录

自审：原条目是我在 2026-10-12 冒烟收尾时**凭推断**登记的（未实测恢复路径），本次接入后先验证前提再动手，避免了一次无用改动（`state.ts` / `dsh.ts` / `replay.ts` 三处 plumbing）。

## 收尾

- **实现**：无（条目撤回）。
- **BACKLOG**：移除该条；余下两条按工作量重排编号（终端探测 → 1，工具块显示格式 → 2）。
- **归档**：本文件移入 `TUI/docs/archived/`。
