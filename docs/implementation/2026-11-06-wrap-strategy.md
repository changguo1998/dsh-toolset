# 折行策略可配置（按词 / 按字符 / 不折行）（接取条目：docs/BACKLOG.md「折行策略可配置（按词 / 按字符 / 不折行）」）

状态：调研（决策待用户裁定）　　开启：2026-11-06　　关闭：
本文件是本任务唯一的追踪文档与文档改动位置；计划外的文件不改。

## 目标

折行风格从「`wrap: true | false` 两档」扩成枚举，至少三档：`char`（逐字符，现状）/ `word`（按词）/ `none`（单行截断）。三档共用同一套缩进与截断口径（悬挂缩进、续行宽、行尾 `…`），CJK 在 `word` 下不被强制按空格断，状态列条目可逐条选风格，且缺省行为与今天逐字一致。

## 调研

来源：本仓代码实测（`TUI/src` 全量 grep + 逐文件精读），文档口径 `TUI/docs/SPEC.md`。

### 1. 今天有两条并存的折行路径，都在线上

- **内容区（会话 / 回合）走 pipeline**：`pipeline/parse.ts` → `structure.ts` → `pipeline/measure.ts` / `pipeline/flatten.ts`，唯一折行入口 `pipeline/wrap.ts:40` 的 `wrapLeaf`，内部核 `wrapSegmentsAt`（`pipeline/wrap.ts:104-130`）**逐字符**切（只判 `curW > 0 && curW + w > limitW`）。
- **面板与 chrome（状态列 / 标题栏 / 状态行 / 输入区 / 提示行 / 各类面板）走 legacy 排版库**：`box.ts` 节点树 → `layout/measure.ts:389` → `fill.ts`。其中两个分支各有一套字符核：
  - `Paragraph`：`measure.ts:428-435` 的 `wrapParagraph`——`wrap !== false` 走 `primitives.ts:92-110` 的 `computeWrapLine`（逐字符），`wrap === false` 走单行 + `…`。
  - `StyledText`：`fill.ts:443-446`——`wrap === false` 走 `splitPhysical`（`fill.ts:479`，只按 `\n` 切、超宽整行保留），否则走 `splitAndWrapSegments`（`fill.ts:493`）→ `markdown.ts:773` 的 `wrapFrameSegments`（逐字符）。
- **拼帧层兜底截断**：状态列每格超 `statusBodyW` 时 `truncateSegs(w−1) + "…"`（`top-region.ts:460-477`）；紧凑模式同类截断 `pipeline/rows.ts:432-440` 的 `foldRows`。
- 分化口径见 `TUI/docs/SPEC.md:248`（面板与 chrome 用 legacy，内容区用 `wrapLeaf`），是已有裁定，不是待修缺陷。

### 2. 逐字符折行核今天有 3 份通用副本 + 2 份专用变体

| 位置 | 入参 | 备注 |
|---|---|---|
| `primitives.ts:92-110` | 纯文本 | 带缓存（`wrapLine`，`primitives.ts:85-89`） |
| `markdown.ts:773-801` | 样式段 | 带 `hanging` 参数；缓存见 `wrapInlineMarkdown` / `wrapAssistantLine` |
| `pipeline/wrap.ts:104-130` | 样式段 | 带 `limit(globalRow)` 回调（首行 / 续行分档） + 平衡折行计数 |
| `content-rules.ts:71-98` | 纯文本 | 专用：工具行悬挂 2 列 + 5 行上限 |
| `frame-rows.ts:41-75` | 纯文本 | 专用：提示行先按 `·` 断，超宽再回落 `wrapLine` |

结论：**加一种风格前必须先收敛折行核**，否则 5 处各改一遍必然漂移（现状已有 3 份逐字符实现互为复刻，注释里多处写「对齐」）。

### 3. `wrap: false` 今天承载两种不同语义

- `measure.ts:428-435`：单行 + 行尾 `…`（高度恒 1）。
- `fill.ts:443-446` / `:479`：只按 `\n` 切物理行，**超宽整行保留**，不截断。
- 面板族靠后者的「精确行长」写法（构建期自己按宽截断）保证不溢出：全仓 `wrap: false` 共 **57 处**（`StatusColumn.ts` 12 处、面板组件约 30 处、`layout/panel.ts` / `status-line.ts` 等）。
- 状态列条目另有自己的字段 `StatusItem.wrap?: false`（`StatusColumn.ts:79-97`），在 `itemLeaves`（`StatusColumn.ts:184-193`）落到叶子上；L3 折叠强制一条一行（`StatusColumn.ts:188` 的 `level >= 3`）。

结论：`none` 只应表达「单行 + `…`」（验收要求「现有 `wrap: false` 行为不变」正好对上）；面板的「精确行长、不软折、不截断」不是折行风格，不进枚举。

### 4. pipeline 里的 `wrap` 字段是死的

`pipeline/ir.ts:351-352` 声明了 `wrap?: boolean`（注释同样写「false = 单行截断不换行」），但 `parse.ts` / `structure.ts` / `measure.ts` / `flatten.ts` **都不读它**；`wrapLeaf` 的 `WrapOptions`（`pipeline/wrap.ts:27-34`）也只有 `prefixW` / `hanging` / `balance`。全仓没有一处给 pipeline 叶子写过 `wrap: false`。

结论：内容区今天做不到「不折行」，要么让字段生效（与 legacy 对齐），要么删掉。

### 5. 配置与状态通道（决定「可配置」怎么落地）

- 配置文件：`tui.config.json` 的 `layout` 段（`config.ts:27-38` 类型、`config.ts:196-235` 归一化），**启动读一次**（`config.ts:331`）；`TUI/docs/SPEC.md:232` 已记「除 `theme` 外其余键需重启才生效」。
- 注入链：`TuiLayoutConfig` → `AppDeps`（`app-deps.ts:58-62`）→ `AppState`（`state/types.ts:556-558`、`state/initial.ts:51-55`）→ `runtime/context.ts:362-363` → 各处组件。这条链上今天跑的是 `activityPlacement` / `statusColumnDivisor`。
- 运行时切换范式：本地命令改 state 字段、不落盘，如 `/collapse`（`commands.ts:481-483`）改 `state.activityCompact`。
- 缓存键：`cache.ts:78-80` 的 `sizedKey(text, size)` 只含「文本 + 宽」——加策略必须进键，否则同一文本切两档会串味；pipeline 折行暂未做缓存（`pipeline/wrap.ts:19-21`）。

### 6. 文档口径现在写在两处

- `TUI/docs/SPEC.md:107`——「`wrap: false`：不换行、单行截断加省略号」。
- `TUI/docs/SPEC.md:248`——面板与 chrome 走 legacy、内容区走 `wrapLeaf`。
- `TUI/docs/SPEC.md:694`——状态列折叠 L3 = `wrap:false`。
- 配置键说明在 `TUI/README.md:188-232`（`TUI/tui.config.json` 段）。

### 7. 现状的直接痛点（本次要解的部分）

- 长英文单词 / URL / 路径被从中间切开（逐字符切，无断点概念）。
- 状态列条目只有「折行 / 压一行」两态，长 slug 要么折成多行挤掉别的块，要么被 `…` 一刀切。
- 用户无法按喜好切换风格，也没有「不折行」的全局开关（只有代码里逐点写死的 `wrap: false`）。

## 决策

待用户裁定；每项给出推荐项（推荐 = a）。

### 1. 作用面：策略要覆盖哪条路径

- a. 两条路径都做：`wrapLeaf`（内容区）与 legacy（面板 / chrome）共用同一策略值。会话正文是主要阅读面，只做面板等于名不副实。
- b. 只做 legacy；pipeline 维持逐字符（改动最小，但 `none` / `word` 对正文无效）。

推荐 a。

### 2. 配置入口

- a. `tui.config.json` 的 `layout.wrap` 定缺省值（启动生效） + 本地命令 `/wrap char|word|none` 运行时可切（不落盘，与 `/collapse` 同族）。
- b. 只做配置文件，不做运行时命令。
- c. 只做环境变量（如 `TUI_WRAP`），不进配置文件。

推荐 a。

### 3. 缺省值

- a. `char`（与今天逐字一致，全部现有帧基线不动）。
- b. `word`（更符合阅读习惯，但要复核所有「恰好折在字符中间」的帧测试与 demo 基线）。

推荐 a；若选 b，测试面要按第 4 节「测试与证据」补一轮基线复核。

### 4. `word` 的断点口径

- a. 断点 = 空白处（断点空格吃掉，续行不以空格开头）+ `-` / `/` 之后可断；**单元超宽时回落逐字符**；CJK 与无空格文本按字符可断（不强制按空格）。
- b. 同 a，但断点空格保留在上一行行尾（缩进与右侧补白口径需另定）。
- c. 只按空白断，`-` / `/` 不可断；其余逐字符。

推荐 a。**明确不做**禁则（避头尾点 / 行首禁排标点），另立条目。

### 5. `none` 的语义

- a. 单行 + 行尾 `…`（与 `measure.ts:428-435` 一致）；面板「精确行长不软折、不截断」保持现状 `wrap: false` 不动。
- b. `none` 同时接管面板那种「整行保留」语义（会让 57 处 `wrap: false` 语义分叉，且与验收「现有行为不变」冲突）。

推荐 a。

### 6. 状态列逐条选风格的粒度

- a. 代码级：`StatusItem.wrap?: WrapMode`（缺省取全局值），由各块构建函数决定（jobs / 阻塞原因 / 长 slug 各自选）。
- b. 配置级：`layout.statusWrap` 按块给风格（`{ jobs: "none", flow: "word" }`），不改组件代码。
- c. 两者都做：配置给按块缺省，条目字段可覆盖。

推荐 c（b 满足「可配置」、a 满足「逐条」；工作量增加有限）。

### 7. 折行核收敛方式

- a. 新增一个纯函数核（按「折行单元」序列工作：单元 = 1 个字符或 1 个词），3 份通用实现改为调用它；两份专用变体（工具行、提示行）保持各自外壳、内部同样调核。
- b. 每处各加一个 `mode` 参数，不抽公共核。

推荐 a。

## 规划

决策定稿后补全。当前为草稿，按「决策 1=a、2=a、3=a、5=a、6=c、7=a」预估：

### 任务拆分（预估）

1. 抽折行核（纯函数 + 单元切分 + 三档策略），补单测。
2. legacy 两条分支接入策略（`primitives.wrapLine` / `markdown.wrapFrameSegments` / `measure.wrapParagraph` / `fill` 的 styled 路径），缓存键加策略。
3. pipeline 接入策略（`WrapOptions.mode`），并让 `pipeline/ir.ts` 的 `wrap` 生效或删除（决策定稿时二选一）。
4. 状态列条目字段扩展（`StatusItem.wrap`）+ 各块按需选风格。
5. 配置与命令接线：`config.ts` 的 `layout.wrap` / `layout.statusWrap`、`AppDeps`、`AppState`、`/wrap` 命令。
6. 文档回写与测试。

### 计划改动文件清单（草稿）

- 核心：`TUI/src/app/layout/wrap-core.ts`（新增，纯函数）、`TUI/src/app/layout/primitives.ts`、`TUI/src/app/layout/cache.ts`、`TUI/src/app/layout/markdown.ts`、`TUI/src/app/layout/fill.ts`、`TUI/src/app/layout/measure.ts`、`TUI/src/app/layout/content-rules.ts`、`TUI/src/app/layout/frame-rows.ts`、`TUI/src/app/layout/frame-build.ts`。
- pipeline：`TUI/src/app/layout/pipeline/wrap.ts`、`pipeline/measure.ts`、`pipeline/flatten.ts`、`pipeline/ir.ts`。
- 状态列：`TUI/src/app/components/StatusColumn.ts`、`TUI/src/app/layout/top-region.ts`（透传策略）。
- 配置与状态：`TUI/src/app/config.ts`、`TUI/src/app/app-deps.ts`、`TUI/src/app/state/types.ts`、`state/initial.ts`、`state/actions.ts`、`TUI/src/app/commands.ts`、`TUI/src/app/runtime/context.ts`。
- 测试：`TUI/tests/wrap-strategy.test.ts`（新增）、`tests/pipeline-wrap.test.ts`、`tests/layout4.test.ts`、`tests/layout-cache.test.ts`、`tests/status-column-equivalence.test.ts`、`tests/tool-call-wrap.test.ts`、`tests/content-rules.test.ts`、`tests/config.test.ts`。
- 文档：本文件、`TUI/docs/SPEC.md`（§3 折行口径、§15 相关）、`TUI/README.md`（配置键）、`docs/BACKLOG.md`（条目状态 / 关闭清理）。

### 明确不做的部分

- CJK 禁则（避头尾点 / 行首禁排标点）。
- 图形字符宽度治理（`SPEC.md` §15.7 已有独立机制）。
- 跨 box 行内折行（`SPEC.md` §3.1 已裁定不做）。
- 代码块内「不折行」策略（围栏内仍按现状折行 + 底色补齐）。
- 工具行的 5 行上限与提示行的「1 至 2 行」上限口径改动（只换折行核，不改上限）。

## 实现记录

（未开始。）

## 偏差

无。

## 测试与证据

（待实现后补。）

## 收尾

（待关闭时补。）
