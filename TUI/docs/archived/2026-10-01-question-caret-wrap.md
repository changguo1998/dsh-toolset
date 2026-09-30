# 问答面板自定义输入换行后光标与字符错位（接取条目：`TUI/docs/BACKLOG.md`「问答面板自定义输入换行后光标与字符错位」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

问答面板「自定义回答」兜底项输入文本折行（soft-wrap 到续行）后，硬件光标（caret）与字符位置错位。修到：折行后 caret 停在正确字符位（行首 / 行中 / 行尾；续行按**视觉行**定位、列含续行缩进）。

## 调研

- 入口：`questionCaretFor(panel, height, width)`（`src/app/components/QuestionPrompt.ts`）→ `layoutQuestionPanel` 的 `customCaretPos`（编辑态来自 `pushOption` 内的 `caretInWrapped`）。
- 坐标链路：调用侧把「文本内字符偏移」折成**行坐标**（`customCaretIndex = ciLead.length + 2 + customPrefix.length + customCaret`，首行含前缀 `${lead}`）；`wrapPrefixed` 折行后给**续行**补 `contIndent`（选项正文起点缩进，本例 7 列）。
- 缺陷定位（复现用例 RED 证实）：`caretInWrapped` 逐行累加**视觉行长度**（含续行缩进）当作文本偏移，续行命中时 `col = displayWidth(rowText.slice(0, caretIndex - offset))` **少算了缩进宽度** → caret 在续行左移 `contIndent.length` 列（实测 RED：`fail 1`，得到列小于期望，差值即缩进宽度）。
- 现有覆盖：`tests/question-custom-caret.test.ts`（编辑态决策层 ✓）、`tests/question-window.test.ts` 的 TUI#35 / TUI#49 用例（单行 caret ✓）——**折行续行未覆盖**（本次补）。

## 决策

1. **逐行扣缩进再折算列**（最小修）：`caretInWrapped(rows, caretIndex, contIndentLen)`——r = 0 视觉行前缀即坐标前缀（不扣）；r ≥ 1 先扣 `contIndentLen` 得 `contentStart`，`col = displayWidth(前缀段) + displayWidth(内容段)`；文本偏移累加同样不计缩进。形参由调用侧传 `contIndent.length`。
1. 备选（未选）：改 `wrapPrefixed` 返回「行 + 内容起点」结构——动折行公共路径、影响面大，无必要。

## 规划

计划改动文件清单（**只改这些**）：

1. `TUI/src/app/components/QuestionPrompt.ts`：`caretInWrapped` 续行缩进折算 + 调用侧传 `contIndent.length`。
1. `TUI/tests/question-window.test.ts`：新增「折行后 caret」用例（定位续行 → 断言列）。
1. `TUI/docs/BACKLOG.md`：条目标「完成」并在收尾清理移除。
1. 本追踪文档。

明确不做：不动 `wrapPrefixed` 与其它折行路径；不改编辑态决策层（`question-transition.ts`）；不做顺手改。

## 实现记录

1. 2026-10-01 先写复现用例（`tests/question-window.test.ts`「折行后 caret：续行按视觉行定位、列含续行缩进」）→ RED（`fail 1`）→ 修 `caretInWrapped`（`contentStart` 折算 + 偏移累加修正）→ 复跑 `npm run test:tui -- question` 全绿（87 pass / 0 fail）。

## 测试与证据

- 单测：`npm run test:tui -- question` → 87 pass / 0 fail（含新增用例；RED → GREEN 见实现记录）。
- 机械门禁：`npm run check` / `npm run build`（点 2 前跑）。
- 真机确认（2026-10-01，点 3 前）：重启载入新构建 → 问答面板「自定义回答」输入长文本（≥120 字符）触发折行 → 用户目视 **通过**（caret 贴着文字、无左偏）。

## 收尾

- 回写：`TUI/docs/DESIGN.md` 无需改（caret 折算属实现细节，未在 DESIGN 描述）；README 不涉及。
- BACKLOG 清理：TUI 条目「问答面板自定义输入换行后光标与字符错位」已标「完成」（2026-10-01）并移除。
- 归档：本追踪文档移入 `TUI/docs/archived/`。
- 残留检查：`git status` 无计划外文件；`tmp/` 无任务临时文件。
- 遗留项：无。
