# TUI 模块拆分约定

> 职责：renderer / app 层模块拆分原则与边界
> 不负责：历史拆分执行记录（见 git 历史）
> 过期条件：无

> 背景：renderer / app 层经历过一次大拆分（`layout.ts` 拆出 Box 排版层文件），历史执行记录见 git。以下沉淀为**当前**的拆分原则与边界，后续同类拆分沿用。

## 原则

- **拆文件不拆架构、只拆纯逻辑**。分层方向（renderer ← app ← adapter 单向下行）与各文件公共导出保持不变；不引入框架、不抽象通用 Panel、不改运行时行为。
- 副作用（adapter 调用、paint、notice、异步）一律留在 `App`（`index.ts`）；`commands.ts` / `adapter/normalize.ts` / `layout/markdown.ts` / `question-transition.ts` / `model-transition.ts` 只承载**纯状态转换与纯函数**。
- 拆分后原文件的公共导入路径保持不变（兼容重导，见下），避免一次性改穿所有调用点。

## 当前文件归属

域命名遵循 `TUI/docs/DESIGN.md`「术语：渲染 vs 排版」：**逻辑** = 纯状态/决策；**排版** = 状态 → 带语义样式的行；**外部边界** = DSH 归一化；渲染 = `renderer/` 层（拆分禁区）。

| 文件 | 域 | 内容 |
|---|---|---|
| `src/app/commands.ts` | 逻辑 | 本地命令目录与路由（`LOCAL_COMMANDS` / `routeSlashCommand` / `SlashRoute`）+ 模型目录决策（`formatModelCatalog` / `resolveModelSpec`）+ 主题、详略、重命名等命令决策纯函数 |
| `src/app/question-transition.ts` | 逻辑 | 问答纯状态转换（`QuestionKeyDecision` / `questionKeyDecision` / `buildQuestionAnswers`） |
| `src/app/model-transition.ts` | 逻辑 | 模型选择纯状态转换（`PickerInit` / `buildPickerInit` / `pickerEffortIndex` / `resolvePickerSelection` / `ModelSwitchPlan` / `planModelSwitch`） |
| `src/app/adapter/types.ts` | 外部边界 | 纯类型：宿主服务结构化面（`<Svc>Like`）、事件联合（`DshEvent`）、`DshAdapter` 出站面 |
| `src/app/adapter/normalize.ts` | 外部边界 | `parseSlashCommand` / `buildApprovalPrompt` / `buildUserMessage` / `normalizeAgentStatus` / `readDefaultSelection` / `localTitleFromText` |
| `src/app/adapter/dsh.ts` | 外部边界 | 真实 adapter：ctx 订阅与事件归一化、服务调用与降级；纯函数（`forkErrorMessage` / `contractSummaryText` / 多 provider 搜索结果聚合） |
| `src/app/layout.ts` | 排版 | 几何唯一来源 `frameGeometry` + 四区域帧组装；重导 `layout/` 下的宽度原语、markdown 纯函数、内容规则与 help 排版 |
| `src/app/layout/*.ts` | 排版 | `box`（类型）、`measure`（measure/allocate）、`fill`（fill 摊平）、`build-box`（分区树 + 内容映射）、`focus-frame`（焦点框覆写）、`panel`（面板场景原语）、`table`（表格构建期降级）、`markdown`（宽度原语 + 行内/块级解析）、`tool-line`（工具行文本）、`content-rules`（跨文件共享的排版规则常量）、`primitives`（宽/折行原语）、`cache`（排版缓存）、`help`（/help 双列排版）——逐文件职责见 `TUI/docs/DESIGN.md`「Box 排版模型 · 模块归属」 |
| `src/app/components/*` | 排版 | 各面板 / 输入框的 Box 生成器（`buildXxxBox`，薄包装 `fillBoxTree`） |

- `state.ts`、`renderer/` 为拆分禁区（reducer / 渲染层保持整体）。
- 兼容策略：原文件重导公共符号（`index.ts` 重导 `formatModelCatalog` / `resolveModelSpec`；`layout.ts` 重导 `layout/` 的宽度原语与 markdown 纯函数；`adapter/dsh.ts` 显式重导 `normalize.ts` 函数与 tool-bootstrap 符号，**不用 `export *`**，避免 verbatimModuleSyntax 与循环依赖），外部 import 路径不变。

## 触发标准

满足其一再启动拆分：新增 2+ 个交互面板；DSH API 大版本变更导致 `dsh.ts` 扩散；单文件反复改动使某测试文件难维护；出现跨层或循环依赖。否则保持现状（YAGNI）。

**现状**：`layout/*` 已按上表归属落地（Box 排版重构设计见 `TUI/docs/DESIGN.md`「Box 排版模型」）。

## 边界（明确不做）

- 不换 TUI 框架、不加事件总线 / 中间件。
- 不为 Approval / Question / ModelPicker 建共享 Panel 基类。
- 不把控制逻辑装进 `components/` 渲染文件。
- 不做「带副作用 controller」——只搬纯逻辑，副作用编排留 App 层。
