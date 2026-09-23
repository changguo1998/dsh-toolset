# 灰度三语义颜色约定

> 背景：原为一次灰度三语义颜色审计单（逐元素核对「强调 / 边框 / 次要」归属与双主题帧实测）。以下沉淀为**当前**配色约定；色值以 `src/renderer/theme.ts` 的 `semantics` 与内置兜底调色板为准。

## 三语义槽位（与 `theme.ts` 头注释一致）

| 语义 | ColorName | 来源槽位 | dark | light |
| --- | --- | --- | --- | --- |
| 次要（辅助文字） | `gray` | bright[0] | `#80878E` | `#475863` |
| 边框 / 分隔 | `border` | ansi[4] | `#5A98F3` | `#1256B2` |
| 行内代码背景 | `code` | ansi[0] / ansi[7] | `#272336` | `#E9EBEE` |
| 强调（焦点框） | `focus`（`focusColor()`） | bright[7] / ansi[0] | `#FFFFFF` | `#121418` |
| 基底前景（正文默认） | `theme.foreground` | 方案源文件值 | `#C9DCDE` | `#3D3B4F` |

## 语义灰（gray）元素

仅以下内容显式使用 `gray`：

- 对话折叠占位 `...(更早回复已折叠)`（`DIALOGUE_MORE`，走 `NOTICE_TONE_COLOR.log`）
- todo 完成项：`✓` 标记与正文（正文另加删除线）；job 完成行同理（`✓` 灰 + 正文灰 + 删除线）
- 状态列 Mode 块未生效的属性值（枚举类项生效值按语义色强调：sandbox/permission `ro` 绿 / `wr` 黄 / `full` 红、policy `ask` 绿 / `auto` 红、preset 洋红；on/off 类项单符号 `✓` 用该项生效色——plan / verbose / symbol-unify 青、bell 绿——`✗` 一律灰）；权限等级取值未知时 `permColor` 亦回落 gray
- 列表面板：标题右侧按键提示（`JobsPanel` / `CommandListPanel`）、空态与加载态占位（`（无后台任务）` / `加载中…`）、取消/停用状态符号（`statusMark` 的 `○`；`✓` 为默认前景，jobs 完成行的灰 + 删除线由 `layout.ts` 单独实现）
- notice 的 `log` tone 与工具行的灰行（进度/状态类）

## 边框（border）元素

非焦点态：活动区 / 状态区分隔线、分隔列与框格连接字（`│` `┤` `┬` `┴`）、状态区上/下分隔（上下逻辑不同：上方随焦点，下方恒边框色）、Mode 块项间 `|` 分隔、markdown 水平分隔线、空标题 `<title>` 占位。

## 强调（focus）

焦点态由 `layout/focus-frame.ts` 的全局 `FocusFrame` 覆写实现，取色走语义槽位 `focus`（`focusColor()`）：状态列焦点顶框（屏幕最左起、右端止于 D 列）与左缘框格、历史/活动区焦点框（D 列/内部分隔列连接字 + 区域外缘框列角字）、焦点时的活动区分隔线与连接字。**不再按主题 ID 推断**（旧的 `dark=brightWhite / light=black` 分支已删除）。

## 基底前景

未显式着色的文字一律走 Screen 帧首铺设的基底前景 `theme.foreground`——包括对话/活动区正文、输入区文本与提示符（单字符模式符号）、按键提示区、状态列正文（goal objective / todo 待办等）、状态块之间虚线 `╌`（与字体同色，不染边框蓝）、会话标题（非 `<title>` 占位）、模型段的 effort 后缀、cache 徽标、markdown 正文；代码块语言标签为默认前景斜体，代码块正文行整体带 `code` 背景。**例外：状态区最左侧的命令状态符号按输入状态着色**（`STATUS_SYMBOL_COLOR`：成功绿 / 失败红 / 运行中与等待交互黄；回退占位 `?` 不着色），其后的分隔竖线 `│` 与组间框线 `│` 用边框色（`border`，与状态栏上方/下方横线同色，框线向上/下横线画交点 `┬`/`┴` 相接成格）。排版层只携带语义色名，不落 hex；主题切换后由渲染层重新铺设基底。

## 权威源与引用规则

- 解析优先级（`theme-config.ts`）：内联 `palettes.<id>` → `paletteDir/<file>.json` → `theme.ts` 内置兜底 `THEMES`（`paletteDir` 查找链：配置值 → `$FFF_HOME/config/terminal-colortheme` → `~/fff/config/terminal-colortheme`）；启动时解析一次，不热重载。
- 语义槽位可经 `palettes.<id>.semantics` 覆盖（支持 `"ansi.N"` / `"bright.N"` 槽位引用或字面 hex）。
- 颜色引用一律经 ColorName → `ansiNameToHex(theme, name)` 映射取 SGR，不得散落硬编码 SGR/hex。

## 语义槽位现状说明

- `code` 是背景色槽位（不属灰度三语义）：与 `gray` / `border` / `focus` 一样是 `SemanticColorName` 之一（`theme.ts`），内置值按各主题底色调性取槽位（dark ansi[0] / light ansi[7]），可由内联 `palettes.<id>.semantics` 覆盖，语义随主题解析。
- 彩色 tone（info 蓝 / warn 黄 / success 绿 / error 红）与面板生效色（`ro` / `wr` / `full`、思考紫、plan 青、preset 洋红）不在灰度三语义范围内。
