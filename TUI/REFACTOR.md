# TUI 模块拆分约定

> 背景：renderer/app 层曾经历一次大拆分（RFC v3，历史执行记录见 git）。以下沉淀为**当前**的拆分原则与边界，后续同类拆分沿用。

## 原则

- **拆文件不拆架构、只拆纯逻辑**。分层方向（renderer ← app ← adapter 单向下行）与各文件公共导出保持不变；不引入框架、不抽象通用 Panel、不改运行时行为。
- 副作用（adapter 调用、paint、notice、异步）一律留在 `App`（`index.ts`）；`commands.ts` / `normalize.ts` / `markdown.ts` / `question-transition.ts` / `model-transition.ts` 只承载**纯状态转换与纯函数**。

## 当前文件归属

| 文件 | 内容 |
|---|---|
| `src/app/commands.ts` | `formatModelCatalog`/`resolveModelSpec` + slash 路由/决策纯函数（`routeSlashCommand`/`modelCommandSpec`/`themeCommandDecision` + `SlashRoute`/`ThemeCommandDecision`） |
| `src/app/adapter/types.ts` | 纯类型（29 个，adapter 归一化域） |
| `src/app/adapter/normalize.ts` | `parseSlashCommand`/`buildApprovalPrompt`/`buildUserMessage`/`normalizeAgentStatus`/`readDefaultSelection` |
| `src/app/layout/markdown.ts` | 宽度原语 + markdown 行内/块级解析（`parseInlineMarkdown`/`wrapInlineMarkdown`/`wrapAssistantLine` 等）；**只导外部真正需要的函数，内部正则与 helper 不做公共 API** |
| `src/app/question-transition.ts` | 问答纯状态转换（`QuestionKeyDecision`/`questionKeyDecision`/`buildQuestionAnswers`） |
| `src/app/model-transition.ts` | 模型选择纯状态转换（`PickerInit`/`buildPickerInit`/`pickerEffortIndex`/`resolvePickerSelection`/`ModelSwitchPlan`/`planModelSwitch`） |

- `state.ts`、`renderer/` 为拆分禁区（reducer/渲染层保持整体）。
- 兼容策略：原有文件重导公共符号（`index.ts` 重导 `formatModelCatalog`/`resolveModelSpec`；`layout.ts` 重导 markdown 纯函数；`adapter/dsh.ts` 显式类型/函数重导，**不用 `export *`**，避免 verbatimModuleSyntax 与循环依赖），外部 import 路径不变。

## 触发标准

满足其一再启动拆分：新增 2+ 个交互面板；DSH API 大版本变更导致 `dsh.ts` 扩散；单文件反复改动使某测试文件难维护；出现跨层或循环依赖。否则保持现状（YAGNI）。

## 边界（明确不做）

- 不换 TUI 框架、不加事件总线/中间件。
- 不为 Approval/Question/ModelPicker 建共享 Panel 基类。
- 不把控制逻辑装进 `components/` 渲染文件。
- 不做「带副作用 controller」——只搬纯逻辑，副作用编排留 App 层。
