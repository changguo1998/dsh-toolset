# 问题面板自定义答案的光标移动（←/→）（接取条目：`TUI/docs/BACKLOG.md`「问题面板编辑自定义答案时，←/→ 移动光标」）

状态：规划（决策已通过审阅，待实现）　　开启：2026-09-27　　关闭：——
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。
审阅：用户 2026-09-27 逐条审阅第 3 条（本条），决策**通过**。

## 目标

问题面板（`ask_user_question`）在「自定义回答」项上编辑文本时，`←`/`→` 在输入串内左右移动光标，插入与退格在光标处生效，渲染显示光标位置；其余按键行为不变（`Tab` 切焦点窗、`↑/↓` 选项移动 / 描述窗滚动）。

## 调研

来源：TUI 源码。

- 现状：`question-transition.ts` 的 `questionKeyDecision` 中 `left`/`right` **无条件**走 `{kind:"nav", delta:±1}`（切题），`backspace` 与可打印字符无条件在串尾增删（`text.slice(0, len-1)` / `text + ch`），自定义答案没有任何光标概念。
- 状态：`QuestionPanelItem.custom: string` 见 `state.ts`（`setQuestionCustom`，`state.ts:2962` 附近）。
- 复杂度提示：同文件的 `←/→` 在**未编辑**时承担切题导航，本项要加的是「编辑态内移动」，不是把 `←/→` 全部改写。
- 既有 caret 机制（BACKLOG 3.2.7）已把硬件光标定位到面板编辑行，但只按「光标在串尾」算（`questionCaretFor` / `layoutQuestionPanel` 的 caret 产出）——本项须让其落在**光标位置**而非串尾。
- 主输入栏的既定做法可对齐：`App.insertChar` / paste 按 `inputCursor` 在串中插入并推进光标（`index.ts:1780-1790` 附近），`move-cursor` 为纯 reducer。

## 决策

选项 → 选定（本次实现自定，**待用户审阅**）：

1. 游标存哪：`QuestionPanelItem` 新增 `customCaret: number | null`（null = 未编辑态）。选择「null = 未编辑」而非默认 `0`/串尾，是为了**不给用户制造死锁**：若编辑态下光标恒存在，串光标在 0 位时 `←` 只能原地不动，用户会以为按键坏了；用 null 区分「还没开始编辑」与「编辑中」。
1. 按键分流：
   - 无编辑态（`customCaret === null`）：`←/→` 保持**切题导航**（原文行为，控件手感不变）；
   - 编辑态（`customCaret !== null`）：`←/→` 在串内移动（右端到头停下不切题）；`Backspace` 删光标左字符、光标左移；可打印字符 / 空格 / 数字键在光标处插入并推进光标；
   - `Backspace` 把串删空 → 回到 null（`←/→` 恢复切题），与「删空即未编辑」的直觉一致；
   - `Tab`（切焦点窗）与 `↑/↓`（选项移动 / 描述窗滚动）**不变**。
1. 渲染：caret 列 = 自定义选项行内文本起点 + 光标处显示宽度（CJK 宽度走既有 `displayWidth`），仅编辑态输出。

## 规划

任务拆分：

1. `src/app/state.ts`：`QuestionPanelItem` 增 `customCaret`；`setQuestionCustom` 改为「在光标处插入 / 删除 + 推进光标」（带 `caret` 入参）的纯函数。
1. `src/app/question-transition.ts`：`questionKeyDecision` 增编辑态分支与决策类型（如 `{kind:"custom-caret", delta}`）；`custom` 决策改携 `caret`。
1. `src/app/index.ts`：`question-custom` 动作分发带上 cursor 语义。
1. `src/app/components/QuestionPrompt.ts`：caret 计算按 `customCaret` 定位（含折行行内列）。
1. 测试：串中插入、光标处退格、右端到头不切题、串空恢复导航、跨题 `←/→` 仍工作、CJK 宽度下的 caret 列。

计划改动文件清单（**只改这些**）：

- `TUI/src/app/state.ts`
- `TUI/src/app/question-transition.ts`
- `TUI/src/app/index.ts`
- `TUI/src/app/components/QuestionPrompt.ts`
- `TUI/tests/question-*.test.ts`（按现有问答用例文件补，必要时新建 `question-custom-caret.test.ts`）
- 本追踪文档

明确不做：不改问答面板其它按键语义；不动主输入栏光标逻辑；不做文本选择 / 剪贴板。

## 实现记录

（待实现）

## 测试与证据

（待补：`npm run check` / `npm run test:tui` 输出）

## 收尾

（待补：`TUI/docs/DESIGN.md` 问答面板 caret 口径回写、是否移入 `docs/archived/`）
