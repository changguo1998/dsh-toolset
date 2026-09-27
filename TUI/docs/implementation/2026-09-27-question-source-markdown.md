# 问题面板「上一条消息」段改走 markdown 渲染并取消青色（接取条目：`TUI/docs/BACKLOG.md`「问题面板的「上一条消息」段改走 markdown 渲染并取消青色」）

状态：规划（决策已通过审阅，待实现）　　开启：2026-09-27　　关闭：——
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 逐条审阅第 6 条（本条），决策**通过**。

## 目标

问答面板描述窗顶部的问题前正文（`panel.source`，活动区正文复述，≤6 行）从「纯文本 + 青色」改为与题干同口径的 markdown 渲染 + 默认前景色；空行与折行口径随 markdown 渲染统一。

## 调研

来源：TUI 源码。

- 现状实现：`components/QuestionPrompt.ts` 的 `sourceText` 段——`(panel.source ?? "").trim()` 后按 `\n` 切分，逐行 `wrapByWidth(part, descW)`，产出 `{ text: " " + r, color: { fg: "cyan" } }`（约 211-218 行）。
- 题干 / detail 走 markdown：同文件 `pushMarkdown(text)` → `panelMarkdownRows(text, descW, themeId)`（历史区同口径解析器），产出段数组（样式段**不含行首 1 列**，渲染时补空格）。
- 裁定沿革：`BACKLOG TUI#6` 曾裁定该段「保持纯文本，只有题干 / detail / 审批草稿走 markdown」；青色为 `BACKLOG 3.2.10` 人工反馈（灰太暗）所加——本条目即**改两条旧裁定**，实现时须在文档里同步说明。
- 折行差异：`wrapByWidth` 是纯文本定宽折行；`panelMarkdownRows` 处理块识别（列表 / 代码 / 引用 / 表格等）与行内样式，行首缩进由渲染补齐。

## 决策

选项 → 选定（本次实现自定，**待用户审阅**）：

1. 渲染：该段改调 `pushMarkdown`（与题干同口径），**删除** `fg:"cyan"` 硬编码 → 默认前景。
1. 行首口径：与题干一致——markdown 产出的首列留空由渲染补（`descRows.push({ text: "", segments: segs })`），不再手工 `" " + r`。
1. 空行口径：markdown 渲染器的空行处理为准（不再手工 `continue` 跳过空行——由解析器决定段落间距）；该段与题干之间的分隔空行保留。
1. 颜色来源：若日后需要视觉区分该段，走主题样式名而非硬编码（本项不改主题表，只回默认前景）。

## 规划

任务拆分：

1. `src/app/components/QuestionPrompt.ts`：`sourceText` 段改用 `pushMarkdown`；删去青色与手工折行 / 空行分支；更新该段注释里的旧裁定说明（TUI#6 / 3.2.10 → 本条）。
1. 测试：`source` 含 markdown（如 `**粗体**` / 列表 / 行内代码）时产出对应样式段；颜色为默认（无 `fg:"cyan"`）；宽度与题干一致（首列留白口径）；空 `source` 不占行。
1. 文档：`TUI/docs/DESIGN.md` 问答面板段落口径同步（若其中记有该段「纯文本」说法）。

计划改动文件清单（**只改这些**）：

- `TUI/src/app/components/QuestionPrompt.ts`
- `TUI/tests/`（问答面板相关用例，按现有文件补）
- `TUI/docs/DESIGN.md`（口径回写，如涉及）
- 本追踪文档

明确不做：不改 `panel.source` 的产生逻辑（内容仍是活动区正文复述、≤6 行）；不改题干 / detail 的渲染；不动整体配色主题。

## 实现记录

（待实现）

## 测试与证据

（待补：`npm run check` / `npm run test:tui` 输出）

## 收尾

（待补：DESIGN 回写、是否移入 `docs/archived/`）
