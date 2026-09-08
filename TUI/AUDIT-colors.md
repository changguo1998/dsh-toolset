# AUDIT-colors.md — 灰度三语义颜色审计单

审计目标：逐元素核对 TUI 灰度三语义颜色归属（强调 / 前景 / 次要）逻辑是否正确。

审计方式：源码逐点核对 `colorFor` / `style.fg` 归属 + `buildFrame` 双主题渲染帧实测（dark/light × 焦点 none/history/activity/status）。

## 三语义定义（与 theme.ts 头注释一致）

| 语义 | ColorName | 槽位（用户手动指定 2026-09-17） | dark | light |
| --- | --- | --- | --- | --- |
| 强调（焦点窗口） | `focusFrameColor()` | 端头 | bright[7] `#FFFFFF` | ansi[0] `#000000` |
| 正文/边框 | `border` | dark ansi[7] / light bright[0] | `#D8D8D8` | `#555555` |
| 次要（辅助文字） | `gray` | dark bright[0] / light ansi[7] | `#787878` | `#F4F4F4` |
| 基底前景（正文默认） | `theme.foreground` | 方案源文件值 | `#D8D8D8`（=ansi[7]） | `#555555`（=bright[0]） |

## 元素 → 语义

### 次要文字（gray = dark bright[0] / light ansi[7]）— 全部正确

| 元素 | 位置 |
| --- | --- |
| 对话折叠占位 `… 共 N 组更早内容`（DIALOGUE_MORE/TOOL_MORE，走 NOTICE_TONE_COLOR.log） | layout.ts |
| todo/goal 完成 `✓` 与删除线正文 | layout.ts（TODO_MARKER/goal ✓） |
| 空标题 `<title>` 占位 | layout.ts |
| 状态列空占位 STATUS_COL_EMPTY | layout.ts |
| Mode 块未生效的属性值 | layout.ts |
| 代码块语言标签（灰斜体） | layout.ts / markdown.ts |
| effort 显示 | layout.ts |
| 按键提示区 HINT_LINE | layout.ts |
| 状态列正文纯内容行（cg 整行上灰；含内嵌色标题行跳过） | layout.ts |
| JobsPanel 次要描述：（无后台任务）/ 操作提示行 | components/JobsPanel.ts |
| markdown：checkbox `[x]/[ ]`、blockquote `>`、未知行前缀、链接旁的说明 | markdown.ts |
| 会话标题后缀（model 名 `/后缀`） | layout.ts |

### 边框（border = dark ansi[7] / light bright[0]，= 正文前景）— 全部正确

| 元素 | 位置 |
| --- | --- |
| 活动区分隔线（非焦点） | layout.ts sepStr |
| 分隔列竖线 `│`（非焦点） | layout.ts buildTopRegion/divFor |
| 框格连接字 `┤/┘/┐`（非焦点） | layout.ts divFor |
| 活动区分隔行端点（非焦点） | layout.ts |
| 对话 separator 行（`─/╌`） | layout.ts |
| 状态区上方分隔 buildStatusSeparator（非焦点） | layout.ts |
| 状态区下方分隔 makeSep（恒边框色，不随焦点变——设计） | layout.ts |
| 状态块分隔 `╌`（Goal/Todo/Jobs 之间） | layout.ts |
| Mode 项目竖线（项目间分隔） | layout.ts |
| markdown 水平分隔线 `─` | markdown.ts |

### 强调（focusFrameColor = 端头）— 全部正确

| 元素 | dark | light |
| --- | --- | --- |
| 历史/状态列焦点顶框、左缘框格、右上角 `┐/┌` | `#FFFFFF` | `#000000` |
| 焦点时活动区分隔线、分隔竖线、连接字 | `#FFFFFF` | `#000000` |
| 焦点时 buildStatusSeparator 钩边（activity 亮左段+┴、status 亮┴+右段） | `#FFFFFF` | `#000000` |

### 基底前景（正文默认，theme.foreground = 源文件值：dark ansi[7] / light bright[0]）— 正确

对话/活动区普通文本、输入区 prompt、cache 徽标等未显式着色文字走 Screen 帧首铺设的基底前景。
dark 下基底前景=#D8D8D8 与边框（border=ansi[7]）同色——用户指定正文/边框同取 ansi[7]，方案源文件 foreground 亦为此值；TUI 内嵌跟随源文件取值，不作推导覆盖。

## 帧层实测（rows=24, cols=80）

| 状态 | 分隔竖线 | buildStatusSeparator(┴) | 焦点顶框 |
| --- | --- | --- |---|
| dark none | 216（border=ansi[7]） | 216 | — |
| dark history | 216 | 216 | 255 |
| dark activity | 216 | 255+216 | — |
| dark status | 216 | 216+255 | 255 |
| light 同上 | 85（border=bright[0]） | 85 / 0 | 0 |

结论：三语义全部归属正确，**未发现逻辑错误**，无需代码修正。

## 修正记录

| 处 | 问题 | 修正 |
| --- | --- | --- |
| demo/main.ts 冒烟断言 | 硬编码 dark 主题彩色 SGR（red/green/yellow w 值 231;70;132 / 132;231;70 / 231;169;70），light 主题下 6 项断言误判 FAIL | 断言改按当前主题槽位动态取色（smokeSgr("red/green/yellow") → hexSgr(ansiNameToHex(theme, name))），dark/light 双主题冒烟均 35 PASS |

> 该处属于冒烟脚本断言层面的颜色硬编码（产品 light 渲染本身正确），一并修复保证双主题机械验证可用。

| 处 | 问题 | 修正 |
| --- | --- | --- |
| TUI 基底前景 THEMES.foreground | 灰度框架推导曾把 dark 基底前景改为 #787878，并要求方案源文件同步——违背「源文件为权威，TUI 内嵌跟随源文件」 | 撤销推导：TUI dark 基底前景恢复为源文件值 #D8D8D8（=ansi[7]）、light 保持 #555555（=bright[0]）；不再触碰 `~/fff` 源文件；断言随之适配（dark 允许基底/次要同色对 #D8D8D8） |

| 处 | 问题 | 修正 |
| --- | --- | --- |
| 三语义色值（gray/border） | 既往按「对比度等级框架」自动推导槽位（dark 次要=ansi[7]、边框=bright[0]），且 light 慢变不可读；用户 2026-09-17 手动指定权威色值 | 按用户指定落地：次要 gray=dark bright[0] `#787878` / light ansi[7] `#F4F4F4`；正文/边框 border=dark ansi[7] `#D8D8D8` / light bright[0] `#555555`；强调不变（dark bright[7] `#FFFFFF` / light ansi[0] `#000000`）。边框引用由 `brightBlack` 更名为语义名 `border`（layout.ts 14 处 + markdown.ts 1 处）。源文件未改 |

## 全文件全元素核对（src/ 全部 .ts，含此前未覆盖文件）

对 `TUI/src/` 全部 27 个 .ts 逐一扫描颜色出口（`colorFor` / `hexSgr` / `style.fg|bg` / SGR 字面量）：

| 文件 | 出口数 | 核对结论 |
| --- | --- | --- |
| src/app/layout.ts | 71 | 三语义逐点核过：gray×13=次要、border×14=边框、fc×N=强调；彩色（blue/yellow/magenta/cyan/green/brightMagenta/brightRed/brightBlue/red）为生效/状态语义，均走槽位 |
| src/app/layout/markdown.ts | 25 | gray=次要（语言标签/checkbox/引用/前缀）、border=水平线、blue=链接、brightCyan=标题强调（HEADING_FG 为槽位非硬编码）、CODE_BG=背景 hex（已知项）；hexSgr 收尾机制与 screen 一致 |
| src/renderer/screen.ts | 13 | 基底前景/背景铺设 + style→SGR（38;2/48;2），每段收尾复位主题基底；hexSgr 硬编码仅注释说明 |
| src/renderer/theme.ts | 8 | 定义层（THEMES/ansiNameToHex/colorFor/hexSgr） |
| src/app/components/JobsPanel.ts | 6 | gray=次要描述、yellow/red/cyan/green=任务状态 |
| src/app/components/StatusPanel.ts | 3 | yellow/green/blue=面板交互彩色 |
| src/app/components/ApprovalPrompt.ts | 3 | yellow=标题、red/green=y/n 批准拒绝（用户指定） |
| src/app/components/QuestionPrompt.ts | 2 | yellow=光标、green=选中 |
| src/app/components/ModelPicker.ts | 2 | yellow=焦点、green=选中 |
| src/app/commands.ts | 1 | 非颜色出口：仅 ANSI 剥离（stripAnsi）与 OSC 52 剪贴板编码 |
| 其余 17 个（renderer/terminal,input,index、main、app/status,state,index,config,question-transition,model-transition,layout/tool-line、components/TextInput,HistoryPanel、adapter/\*） | 0 | 无颜色出口 |

结论：所有渲染颜色均经 ColorName → ansiNameToHex 槽位映射，无散落硬编码；SGR/hex 字面量全量仅 markdown.ts CODE_BG（背景，已知项，记录不改）。

## 已知项目（非三语义，记录不改）

- `markdown.ts` CODE_BG（行内代码背景）：硬编码 hex `dark #434343 / light #E8E8E8`，属背景色、不属三语义；如需纳入配色方案管理另行讨论。
- 彩色 tone（info/warn/success/error/log 蓝黄绿红）与面板生效色（ro/wr/full、思考紫）不在本次审查范围。
