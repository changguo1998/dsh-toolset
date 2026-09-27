# 问题面板自定义答案的光标移动（←/→）（接取条目：`TUI/docs/BACKLOG.md`「问题面板编辑自定义答案时，←/→ 移动光标」）

状态：关闭（真机确认通过）　　开启：2026-09-27　　关闭：2026-09-27
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
- `TUI/tests/question-custom-caret.test.ts`（新建）+ 既有用例同步（`tests/question-window.test.ts`、`tests/focus-cursor.test.ts`、`tests/approval-panel.test.ts`）
- 本追踪文档

明确不做：不改问答面板其它按键语义；不动主输入栏光标逻辑；不做文本选择 / 剪贴板。

## 实现记录

**实现（2026-09-27）**

1. `src/app/state.ts`：`QuestionPanelItem` 增 `customCaret?: number | null`（null/缺省 = 未编辑态）；`setQuestionCustom(state, text, caret)` 同时写文本与光标；新增 `moveCustomCaret`（clamp 到 `[0, 串长]`，无变化返回原状态）；`question-custom` action 增可选 `caret`，新增 `custom-caret` action；`moveQuestion` 移项即 `customCaret: null`；`selectQuestionOption` 单选清空 custom 时一并清光标。
1. `src/app/question-transition.ts`：决策类型 `{kind:'custom'}` → `{kind:'custom-edit', text, caret}`，新增 `{kind:'custom-caret', delta}`；新增纯助手 `customChars` / `customCaretOf` / `customInsert`（按 **code point** 计数，与 reducer 的 clamp 口径一致）；退格改「编辑态删光标左字符（删空回 null）／未编辑态删末字符」；`←/→` 改「自定义项编辑态 → 移动光标；否则 → 切题 nav」。
1. `src/app/index.ts`：问答按键分派 `custom` → `custom-edit`（带 caret）+ 新增 `custom-caret` 分支。
1. `src/app/components/QuestionPrompt.ts`：`pushOption` 返回「光标在选项窗内的行/列」（新增 `caretInWrapped`，按折行后行内**字符偏移累加显示宽度**定位，含 CJK）；自定义项传 `customCaret` → 答案文本起点偏移；caret 段改为「编辑态才产出、列取光标位」（原先恒取末行行尾）。
1. 测试：新增 `tests/question-custom-caret.test.ts`（5 例）；同步既有 caret 用例（原「恒取文本末尾 / 移项即产 caret」的断言随语义更新）。

**关键取舍**：

- `customCaret` 用 **null = 未编辑** 而不是「恒存在的光标」（草稿 §决策）：串光标在 0 位时 `←` 若被吞会像按键坏掉；用 null 区分「还没开始编辑」与「编辑中」，删空/移项都回到 null，避免死锁感。
- 编辑态判定不新增状态位，由 `customCaret !== null` 直接表达；`←/→` 的两种语义因此只有一处判据。

## 测试与证据

| 命令 | 结果 |
| --- | --- |
| `npm run check`（tsc --noEmit） | 通过 |
| `npm test`（TUI 全量） | **1161 例全通过**（1161 pass / 0 fail，含新增 5 例与既有用例同步后的回归） |

新增用例（`tests/question-custom-caret.test.ts`）：

1. 编辑态 `←/→` 串内移动；右端到头不前进、左端到头停住且**不切题**；
1. 中间定位的插入 / 退格（光标随编辑推进）；
1. 退格删空 → 回未编辑态，`←/→` 恢复切题；空串退格 no-op；
1. 移项退出编辑态但保留文本；单选选预设清空文本与光标；
1. 决策层判据：有文本 → `custom-caret`；移回预设项 → `nav`。

既有用例同步（语义变更点）：

- `tests/question-window.test.ts`：caret 列改断言「光标位（ab 之后）」而非文本末尾，并补「有文本但 caret=null 时无 caret」；
- `tests/focus-cursor.test.ts`：移到自定义项但未编辑 → 无 caret；键入一个字符后 → 有 caret；
- `tests/approval-panel.test.ts`：数字键决策期望改为 `{kind:'custom-edit', text:'2', caret:1}`。

## 收尾

- 已回写 `TUI/docs/DESIGN.md`（问答面板「两窗与焦点窗」一节的编辑态 caret 口径——本轮按 TUI#35 语义更新）；
- 计划外文件：`tests/question-window.test.ts` / `tests/focus-cursor.test.ts` / `tests/approval-panel.test.ts` 为语义变更后的**既有用例同步**（已补进计划清单）；
- 真机确认（2026-09-27）：用户在 `dsh --profile fff` 下打开带 markdown 题干的问答面板，实测「键入 abc → ←×2 串内移动 → 插入 X 得 aXbc → Backspace 删光标左字符」与题干 markdown、前文段默认前景色全部通过；
- 原待办：用户人工确认（真机：自定义答案中间插入/退格、`←/→` 与切题分流）（已完成，本文档归档于 `TUI/docs/archived/`）。
