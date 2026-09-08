# AUDIT-colors.md — 灰度三语义颜色审计单

审计目标：逐元素核对 TUI 灰度三语义颜色归属（强调 / 前景 / 次要）逻辑是否正确。

审计方式：源码逐点核对 `colorFor` / `style.fg` 归属 + `buildFrame` 双主题渲染帧实测（dark/light × 焦点 none/history/activity/status）。

## 三语义定义（与 theme.ts 头注释一致）

| 语义 | ColorName | 槽位 | dark | light |
| --- | --- | --- | --- | --- |
| 强调（焦点窗口） | `focusFrameColor()` | 端头 | bright[7] `#FFFFFF` | ansi[0] `#000000` |
| 前景（正文/边框） | `brightBlack` | bright[0] | `#787878` | `#555555` |
| 次要（辅助文字） | `gray` | ansi[7] | `#D8D8D8` | `#F4F4F4` |
| 基底前景（正文默认） | `theme.foreground` | bright[0] | `#787878` | `#555555` |

## 元素 → 语义

### 次要文字（gray = ansi[7]）— 全部正确

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

### 前景/边框（brightBlack = bright[0]）— 全部正确

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

### 基底前景（正文默认，theme.foreground = bright[0]）— 正确

对话/活动区普通文本、输入区 prompt、cache 徽标等未显式着色文字走 Screen 帧首铺设的基底前景。

## 帧层实测（rows=24, cols=80）

| 状态 | 分隔竖线 | buildStatusSeparator(┴) | 焦点顶框 |
| --- | --- | --- |---|
| dark none | 120 | 120 | — |
| dark history | 120 | 120 | 255 |
| dark activity | 120 | 255+120 | — |
| dark status | 120 | 120+255 | 255 |
| light 同上 | 85 | 85 / 0 | 0 |

结论：三语义全部归属正确，**未发现逻辑错误**，无需代码修正。

## 修正记录

| 处 | 问题 | 修正 |
|---|---|---|
| demo/main.ts 冒烟断言 | 硬编码 dark 主题彩色 SGR（red/green/yellow w 值 231;70;132 / 132;231;70 / 231;169;70），light 主题下 6 项断言误判 FAIL | 断言改按当前主题槽位动态取色（smokeSgr("red/green/yellow") → hexSgr(ansiNameToHex(theme, name))），dark/light 双主题冒烟均 35 PASS |

> 该处属于冒烟脚本断言层面的颜色硬编码（产品 light 渲染本身正确），一并修复保证双主题机械验证可用。

## 已知项目（非三语义，记录不改）

- `markdown.ts` CODE_BG（行内代码背景）：硬编码 hex `dark #434343 / light #E8E8E8`，属背景色、不属三语义；如需纳入配色方案管理另行讨论。
- 彩色 tone（info/warn/success/error/log 蓝黄绿红）与面板生效色（ro/wr/full、思考紫）不在本次审查范围。
