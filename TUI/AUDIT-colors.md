# 灰度三语义颜色约定

> 背景：原为一次灰度三语义颜色审计单（逐元素核对「强调/边框/次要」归属与双主题帧实测，结论未发现逻辑错误；详细审计记录见 git 历史）。以下沉淀为**当前**配色约定。

## 三语义定义（与 theme.ts 头注释一致）

| 语义 | ColorName | 槽位 | dark | light |
| --- | --- | --- | --- | --- |
| 强调（焦点窗口） | `focusFrameColor()` | 端头 | bright[7] `#FFFFFF` | ansi[0] `#000000` |
| 正文/边框 | `border` | dark ansi[7] / light bright[0] | `#D8D8D8` | `#555555` |
| 次要（辅助文字） | `gray` | dark bright[0] / light ansi[7] | `#787878` | `#F4F4F4` |
| 基底前景（正文默认） | `theme.foreground` | 方案源文件值 | `#D8D8D8`（=ansi[7]） | `#555555`（=bright[0]） |

## 语义灰（gray）元素

仅以下内容使用语义灰 `gray`：

- 对话折叠占位 `… 共 N 组更早内容`（DIALOGUE_MORE/TOOL_MORE，走 NOTICE_TONE_COLOR.log）
- todo/goal 完成 `✓` 与删除线正文
- 空标题 `<title>` 占位
- Mode 块未生效的属性值
- JobsPanel 次要描述（无后台任务 / 操作提示行）
- notice `log` tone（进度/状态）

## 正常前景色（非 gray）

以下内容**不带灰色 SGR**，走基底前景（含内嵌色的行保持原色）：effort 后缀（model 段 `:effort`）、按键提示区 HINT_LINE、状态列正文纯内容行（goal objective / todo 待办等）、会话标题（非 `<title>` 占位，占位保持边框色）、markdown 渲染（图片占位、任务列表 `[x]/[ ]` 前缀与正文、引用 `>` 前缀与正文、列表前缀、代码块语言标签——保留斜体/删除线等其余样式）。

## 边框与强调

- **边框**（`border`，非焦点态）：活动区分隔线、分隔列竖线 `│`、框格连接字 `┤/┘/┐`、对话 separator 行（`─/╌`）、状态区上/下分隔（上下分隔逻辑不同：上方随焦点，下方恒边框色）、状态块分隔 `╌`（Goal/Todo/Jobs 之间）、Mode 项目竖线、markdown 水平分隔线。
- **强调**（`focusFrameColor`，焦点态）：历史/状态列焦点顶框、左缘框格、右上角 `┐/┌`、焦点时活动区分隔线/分隔竖线/连接字、焦点时 buildStatusSeparator 钩边——dark `#FFFFFF` / light `#000000`。

## 基底前景

对话/活动区普通文本、输入区 prompt、cache 徽标等未显式着色文字走 Screen 帧首铺设的基底前景。dark 下基底前景与边框（border=ansi[7]）同色、light 下二者不同——按用户指定与方案源文件取值，TUI 内嵌跟随，不作推导覆盖。

## 权威源

- 配色权威 = `~/fff/config/terminal-colortheme/` 方案源文件；`src/renderer/theme.ts` 的 `THEMES` 内嵌**跟随源文件**，改源文件需手动同步副本。
- 颜色引用一律经 ColorName → `ansiNameToHex(theme, name)` 槽位映射，不得散落硬编码 SGR/hex（渲染层仅 markdown CODE_BG 为已知硬编码背景，见下）。

## 已知项（记录不改）

- `markdown.ts` CODE_BG（行内代码背景）：硬编码 hex `dark #434343 / light #E8E8E8`，属背景色、不属三语义；如需纳入配色方案管理另行讨论。
- 彩色 tone（info/warn/success/error/log 蓝黄绿红）与面板生效色（ro/wr/full、思考紫）不在灰度三语义范围内。
