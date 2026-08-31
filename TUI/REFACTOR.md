# TUI 拆分实施方案（RFC v3，已执行 2026-08-31）

> 本文件原为 RFC 规划，已于 2026-08-31 按 6 步全部执行并合入 `main`（commit `5bb189b`→`134ff09`，门禁逐步全绿、233 测试零断言改动）。以下正文保留为实施记录与模板，后续同类拆分可复用。
> 原则：**拆文件不拆架构、只拆纯逻辑**。分层方向（renderer ← app ← adapter 单向下行）与各文件公共导出保持不变；不引入框架、不抽象通用 Panel、不改任何运行时行为。副作用（adapter 调用、paint、notice、异步）一律留在 `App`，本方案只搬运**纯状态转换与纯函数**。
> 基线（执行前）：`npm run test` 233 测试全绿；每一步完成后原有测试全部通过（零断言改动）。

## 现状与切分边界（基于真实符号结构核实）

| 文件 | 行数 | 真实结构 | 处置 |
|---|---|---|---|
| `src/app/adapter/dsh.ts` | 692 | 29 个纯类型 + `installSessionModelSelection` + `createRealDshAdapter` + 5 个纯函数 | 已拆 2026-08-31 |
| `src/app/layout.ts` | 566 | 25 个导出；宽度/viewport 计算与 markdown 解析分居 | 已拆 2026-08-31 |
| `src/app/index.ts` | 818 | `App` 类 ~28 方法 + slash/模型/问答纯逻辑 | 已拆 2026-08-31 |
| `src/app/state.ts` | 711 | 37 个导出，大 reducer + 面板子 reducer，结构清晰 | **不动** |
| `src/renderer/*` | 98–261 | 已符合「极简渲染层」目标 | **不动** |

### 拆分后新增文件（2026-08-31）

| 文件 | 内容 |
|---|---|
| `src/app/commands.ts` | `formatModelCatalog`/`resolveModelSpec` + slash 路由/决策纯函数（`routeSlashCommand`/`modelCommandSpec`/`themeCommandDecision` + `SlashRoute`/`ThemeCommandDecision`） |
| `src/app/adapter/types.ts` | 29 个纯类型原样迁移 |
| `src/app/adapter/normalize.ts` | `parseSlashCommand`/`buildApprovalPrompt`/`buildUserMessage`/`normalizeAgentStatus`/`readDefaultSelection` |
| `src/app/layout/markdown.ts` | 宽度原语 + markdown 行内/块级解析（`parseInlineMarkdown`/`wrapInlineMarkdown`/`wrapAssistantLine` 等） |
| `src/app/question-transition.ts` | 问答纯状态转换（`QuestionKeyDecision`/`questionKeyDecision`/`buildQuestionAnswers`） |
| `src/app/model-transition.ts` | 模型选择纯状态转换（`PickerInit`/`buildPickerInit`/`pickerEffortIndex`/`resolvePickerSelection`/`ModelSwitchPlan`/`planModelSwitch`） |

## 执行记录（2026-08-31，已全部完成）

| 步 | commit | 内容 |
|---|---|---|
| 1 | `5bb189b` | 提取模型目录纯函数（`commands.ts`） |
| 2 | `ddf4829` | 拆分 adapter 类型与归一化工具 |
| 3 | `ebe6c2e` | 拆分 layout markdown 解析 |
| 4 | `49b401e` | 提取问答纯状态转换 |
| 5 | `88e08ef` | 提取模型选择纯状态转换 |
| 6 | `134ff09` | 提取 slash 命令解析 |

- 门禁：6 步每步 `npm run check`/`test`（233 全绿）/`build`/`git diff --check` 通过后提交，`DSH-CTX-API.md`、`state.ts`、`renderer/` 全程零改动。
- 后续事项：`IMPLEMENTATION.md`/`DESIGN.md` 同步了新文件布局；`dsh.ts` 14 个未使用 `import type` 名（TS 6196 警告级）留作后续清理。

依赖方向（不变）：`main.ts` → `App` → `state/适配器`；`layout.ts` → 组件渲染函数（`renderQuestionPanel`/`renderModelPicker`）。

## 执行顺序（每步一个 commit，风险递增）

### 0. 依赖清单（已采集，见附录 A；不改代码）

### 1. 提取 `commands.ts` 纯函数（风险最低，先做）

把 `index.ts` 底部已是纯函数的 `formatModelCatalog`、`resolveModelSpec` 迁入 `src/app/commands.ts`；`index.ts` 改为 `export { formatModelCatalog, resolveModelSpec } from "./commands.ts";` 保持兼容（`tests/app.test.ts` 直接引用二者，import 路径不改）。

- commit：`refactor: 提取模型目录纯函数`
- 门禁特点：零副作用、零状态，是最安全的第一个切割。

### 2. 拆 `adapter/dsh.ts`

**新建 `src/app/adapter/types.ts`**：29 个纯类型原样迁移。
**`dsh.ts` 末尾显式类型重导**（不用 `export *`，避免 verbatimModuleSyntax 与循环依赖问题）：

```ts
export type {
  AgentStatus, SessionMeta, ApprovalItem, DshEvent, DshAdapter, ModelInfo,
  ModelSelection, SessionModelSelectionRef, ModelCatalog, SessionEventType,
  StreamChunk, ApprovalRequest, ApprovalOutcome, QuestionOption, QuestionIntent,
  QuestionItem, QuestionAnswerItem, QuestionAnswer, UserQuestionsLike,
  UserQuestionRequestLike, SessionEventDataMap, SessionEvent, DshRuntime,
  DshAgentLike, DshUserMessageLike, DshCommandLike, LlmLike,
  AgentDefaultModelLike, RealAdapterOptions,
} from "./types.ts";
```

**新建 `src/app/adapter/normalize.ts`**：`parseSlashCommand`、`buildApprovalPrompt`、`buildUserMessage`、`normalizeAgentStatus`、`readDefaultSelection`；`dsh.ts` 具名重导：`export { parseSlashCommand, … } from "./normalize.ts";`

- `dsh.ts` 保留：`installSessionModelSelection` + `createRealDshAdapter`（含事件归一化映射表）。
- 引用者（4 文件，见附录 A）import 路径一行不改。
- commit：`refactor: 拆分 adapter 类型与归一化工具`

### 3. 拆 `layout.ts`

**新建 `src/app/layout/markdown.ts`**：`parseInlineMarkdown`、`wrapInlineMarkdown`、`wrapAssistantLine` 及其内部私有 helper（`ANSI_RE`/`bracketText`/块级规则等）顺迁；**只导出外部真正需要的函数，内部正则与 helper 不做公共 API**。
**`layout.ts`** 保留宽度/viewport/`buildFrame` 等，从 `./layout/markdown.ts` import 并在顶部 re-export `parseInlineMarkdown`/`wrapInlineMarkdown`（`tests/layout*.test.ts` 引用，路径不改）。

- commit：`refactor: 拆分 layout markdown 解析`

### 4. question 纯状态转换

先给 `handleQuestionKey`/`submitQuestion`/`cancelQuestion`（L488–592）各列一张表：**读状态**（`state.question` 字段）、**写状态**、**异步副作用**（`adapter.answerQuestion` 之类）；把**读/写状态的纯转换**提为 `src/app/question-transition.ts`：

```text
key event + AppState → 纯 transition → StateAction；副作用与提交仍由 App 执行
```

- 不做「带副作用的 controller」，不预先规定 `{state?, effects}` 回调接口；适配器调用、paint、notice 留 App。
- `components/QuestionPrompt.ts`（`renderQuestionPanel`）保持纯渲染不动。
- commit：`refactor: 提取问答纯状态转换`

### 5. model picker 纯状态转换

同法处理 `openModelPicker`（~150 行）、`reloadPickerEfforts`、`confirmModelPicker`、`applyModelSelection`：只提**纯状态转换**（候选列表位置游标、选中项、phase 推进）到 `src/app/model-transition.ts`；**`modelCatalog()`/`modelEfforts()`/`setSessionModel()` 等异步调用全部留在 App**。

- `handleModelCommand` 不在此步。
- `components/ModelPicker.ts`（`renderModelPicker`）保持纯渲染不动。
- commit：`refactor: 提取模型选择纯状态转换`

### 6. slash 命令副作用编排（最后）

`handleSlash`/`handleModelCommand`/`handleThemeCommand` 的解析/决策拆为纯函数（`src/app/commands.ts` 内，输入 `AppState` + 行文本 → 结果类型），副作用编排留 App。**放最后是因为它最容易改变 `await` 顺序与副作用时机**；审阅 diff 重点核对 await 顺序、条件分支、异常路径。

- commit：`refactor: 提取 slash 命令解析`

## 每步模板

```text
目标：
移动/新增的确切符号：
保留在原文件的符号：
受影响的 import：
公共导出兼容策略：
允许的行为变化：无
异步/副作用审查点：
测试断言变化：必须为零
门禁：
回滚 commit：
```

## 每步门禁（不可跳过）

```sh
timeout 120 npm run check
timeout 120 npm run test    # 原有测试全部通过
timeout 120 npm run build
git diff --check
git diff --find-renames --stat
```

- 验收条件：原有测试**断言**零改动、全部通过；公共导出与运行时行为不变；条件分支、常量、调用顺序、副作用点无变化。**可以新增**针对新纯函数的测试（总数只增不减），但不能以新增测试替代原测试。
- 回滚点：每步一个中文 Conventional Commit，门禁不过即 `git revert`，不带着红状态进下一步。
- 违规信号：任何一步需要改原有测试**断言**，即视为切分边界错误，回滚并调整。

## 明确不做

- 不换 TUI 框架、不加事件总线/中间件。
- 不为 Approval/Question/ModelPicker 建共享 Panel 基类。
- 不把控制逻辑装进 `components/` 渲染文件。
- 不做「带副作用 controller」——本方案只搬纯逻辑。
- 不拆 `state.ts`、不动 `renderer/`。

## 附录 A：依赖清单（2026-08-30 采集；dsh.ts 29 个类型已逐符号核实为纯类型）

- `adapter/dsh.ts` ← `tests/adapter.dsh.test.ts`（19 符号）、`tests/app.test.ts`（5）、`demo/mockAdapter.ts`（7）、`src/main.ts` ×2（4 + 7）
- `layout.ts` ← `tests/layout4.test.ts`（8）、`tests/status.test.ts`（1）、`tests/layout.test.ts`（8）
- `index.ts` ← `tests/app.test.ts`（`App` + 2 纯函数）、`demo/main.ts`（`App`）、`src/main.ts`（`App`）
- `components/QuestionPrompt.ts` ← `layout.ts`；`components/ModelPicker.ts` ← `layout.ts`、`tests/modelpicker.test.ts`
- `state.ts` ← 4 个测试文件（不动，仅记录）

## 何时执行

> 已于 2026-08-31 执行完毕（触发条件：单文件反复改动、`dsh.ts`/`layout.ts`/`index.ts` 持续膨胀）。以下为原始触发标准，留档参考：

满足其一再启动：新增 2+ 个交互面板；DSH API 大版本变更导致 `dsh.ts` 扩散；单文件反复改动使某测试文件难维护；出现跨层或循环依赖。否则保持现状。
