# 提问上下文取正文修复 + 选项行格式调整（BACKLOG: TUI#3.2.12）

状态：关闭　　开启：2026-09-26　　关闭：2026-09-26

本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. **修复 R8**：`recentQuestionSource` 取不到来源正文（面板顶部无灰色上下文）。
1. **格式调整**：选项行改为「缩进 → 光标/标记 → 编号 → 内容」，解释与续行缩进对齐内容起点（数字悬挂）。

## 调研

- `ask_user_question` 是工具调用：宿主先落一行 `tool`（活动区 `⚙ …` 概要行），随后才发 `question` 事件。`recentQuestionSource` 原实现「自末尾收集**紧邻**连续 `assistant` / `plain` 行，遇其它 kind 即止」→ 首行即 `tool` → 立即返回空串（人工验收 R8「完全没显示」）。
- 现行选项行：` 1.>* 选项正文`（编号在光标前），续行与解释缩进为固定 4 / 6 列；用户要求编号在光标标记之后、解释与续行对齐内容起点。

## 决策

1. `recentQuestionSource(lines, opts?)`：先自末尾**跳过后缀非正文行**（`tool` / `step` / `notice` / `separator`；`thinking` 也不取但计入跳过；上限 12 行——超过则视为「本回合没有正文」，返回空串，避免跨轮取到旧回复），再向前收集连续 `assistant` / `plain` 正文（≤ 6 行，空行即止）。
1. 选项行：` ${cursor}${mark} ${num}. ${text}`；编号按该列表最大编号位数右对齐（`1.` / `10.`）。**内容起点** = `1 + 2 + 1 + numW + 1 + 1 = numW + 6` 列；续行与 `description` 一律缩进到内容起点（数字悬挂，续行不重复编号）。

## 规划

计划改动文件清单：`src/app/state.ts`、`src/app/components/QuestionPrompt.ts`、`tests/approval-panel.test.ts`、`tests/question-wrap.test.ts`、`tests/app.test.ts`、`tests/fixtures/focus-frame-legacy.json`、`docs/SPEC.md` §7.1。

不做：审批面板的选项行（沿用相同前缀函数，无需单独改）、`/help` 等未接取条目。

## 实现记录

- `state.ts`：`recentQuestionSource` 增加「跳过后缀非正文行」阶段（`SOURCE_SKIP_MAX = 12`；`tool` / `step` / `notice` / `separator` / `thinking` 均跳过），随后仍按「连续正文 ≤ 6 行、空行即止」收集。
- `components/QuestionPrompt.ts`：`optionLead` 改为 `${光标}${标记} ${编号}.`；`optTextStart = numW + 6`；`contIndent = optTextStart`（数字悬挂）；`description` 缩进改用 `contIndent`（与内容左对齐）。
- `components/ApprovalPrompt.ts`：审批选项行同格式（` ${光标}  ${编号}. ${内容}`，标记位留空）。
- 测试/基线/冒烟适配：`question-wrap`（续行 7 列、起始行 4 列前缀、极窄退回 4 列保留）、`question-window`（光标行断言带编号）、`app.test.ts`（首选项 / 标记 `*` `+` 断言改正则 `\* \d+\. 文本`、着色断言按新前缀）、`approval-panel.test.ts`（审批选项前缀 + 新增「跳过后缀工具行」「跳过超限」两条来源断言）、`tests/fixtures/focus-frame-legacy.json`、`demo/main.ts`（问答首选项着色断言）。

## 测试与证据

- 全量 `node --experimental-transform-types --test tests/*.test.ts`：**1134 pass / 0 fail**。
- `npm run demo -- --smoke`：**43 pass / 0 fail**；冻结基线重跑（22 行变化：选项行前缀 + 提示行）。
- `npm run check` / `npm run build` 通过。
- 人工复验点：提问时描述窗顶部出现灰色来源正文（修复项）；选项行形如 ` >* 1. 生产环境`，解释与续行与内容左对齐（数字悬挂）。

## 收尾

- 条目 3.2.12 标「完成」；文档回写 `docs/SPEC.md` §7.1（选项行形态 / 来源口径）与 `docs/IMPLEMENTATION.md`；本追踪文档归档 `TUI/docs/archived/`。
- 未做：审批面板的标记位语义（审批无多选标记）、其它未接取条目。

## 补充修复（人工复验发现首版修复不完整）

首版修复（先跳过后缀非正文行、再取连续正文）在**真机仍取不到正文**。加临时诊断后拿到证据：

```
[DIAG] buf=955 tail=assistant|…|tool|tool
```

即 buffer 末尾**确有** `assistant` 行（工具行也在跳过范围内），但收集阶段「遇空正文行即止」——真机正文尾部常带空行 → 立即返回空串（`buf=955` 也说明长会话里缓冲很大）。

据此重写 `recentQuestionSource`（`state.ts`）：

- 由「两段式（先跳过后缀、再收集）」改为**自末尾向前单次扫描**：收集最近 ≤6 行**非空**正文（`assistant` / `plain`），**空正文行跳过而不终止**；一旦已收到正文，遇到非正文行即停止（保持「紧邻一段」语义）；未收到正文时可继续跨过工具 / 思考 / 提示 / 分隔行。
- 扫描上限 `SOURCE_SCAN_MAX = 40` 行（取代原跳过上限 12），超出即视为本回合无正文，避免跨轮取到旧回复。
- 来源段颜色由 `border`（暗灰）改为 `cyan`（人工反馈「灰色太暗难辨认」）。
- 测试：重写 `recentQuestionSource` 用例（新增「真机形态：正文尾部空行 + 多个工具行」「扫描超限」两条断言），并新增端到端用例「流式正文跨工具行带入面板」（`tests/app.test.ts`）。
- 证据：全量 **1135 pass / 0 fail**；`demo --smoke` 43 pass / 0 fail；冻结基线重跑无新增差异；`check` / `build` 通过。
- 临时诊断（`index.ts` 的 `[DIAG]` 分支）已在定位后移除。

## 人工复验结果（2026-09-26，重启后）

- **R8 通过**：描述窗顶部出现青色来源正文（内容为最近一条非思考正文；取值语义即「最近一条」，故工具调用前那句短说明之后取到的是上一条完整说明，属预期）。修复前「恒为空」的两个成因（工具行截断 + 尾部空行终止）均已消除。
- **选项行新格式通过**：` >* 1. 内容`（缩进 → 光标/标记 → 编号 → 内容）。
- **解释与内容左对齐通过**（数字悬挂）。
- **数字键标记通过**：只标记不提交、可再按取消。
