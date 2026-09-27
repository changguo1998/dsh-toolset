# 问题面板「上一条消息」段改走 markdown 渲染并取消青色（接取条目：`TUI/docs/BACKLOG.md`「问题面板的「上一条消息」段改走 markdown 渲染并取消青色」）

状态：测试（实现完成、机械验证通过，待用户人工确认）　　开启：2026-09-27　　关闭：——
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

**实现（2026-09-27）**

1. `src/app/components/QuestionPrompt.ts`：`sourceText` 段改为**调用 `pushMarkdown(sourceText)`**（与题干同一 markdown 子集解析），删除 `fg:"cyan"` 硬编码与手工循环 `wrapByWidth` + 跳过空行 + 手工 `" " + r` 行首补齐；与题干之间保留一个空行 `descRows.push({ text: "" })`。注释同步更新旧裁定沿革（旧 TUI#6「保持纯文本」、3.2.10「青色醒目」→ 本条改）。

**关键口径**：markdown 渲染产出的样式段**不含行首 1 列**（渲染时补空格 / bar），故来源段行首留白与题干完全一致；空行由解析器决定（不再手工丢弃），折行口径与题干统一。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `npm run check`（tsc --noEmit） | 通过 |
| `npm test`（TUI 全量） | **1169 例全通过**（1169 pass / 0 fail） |

既有用例同步（`tests/approval-panel.test.ts`「提问上下文：来源段渲染在描述窗顶部」）：

- 旧断言「着色但非标题（含 `\x1b[38;2;` 且无 `\x1b[1m`）」→ 改为「**默认前景**（无颜色 SGR、无加粗）」；
- 新增同用例内 markdown 生效断言：`source: "**加粗来源**"` 的来源行含 `\x1b[1m`（与题干同口径）；
- 保留「来源段在题干之上」「无来源时不占行」两条既有断言。

## 收尾

- `TUI/docs/DESIGN.md`：**无需回写**（该文只记「面板内文本编辑时渲染行带 caret」等机制，未记来源段的样式裁定；来源段口径在组件注释与本追踪文档中记录）；
- 无计划外文件；
- 待办：用户人工确认（真机：问答面板来源段与题干样式一致、markdown 生效、不再青色）→ 条目转「完成」、本文档移入 `TUI/docs/archived/`。
