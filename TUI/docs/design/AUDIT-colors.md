# 灰度三语义颜色约定

> 职责：配色语义约定（灰度三语义槽位与元素归属）
> 不负责：主题配置项清单（见 `TUI/README.md`）
> 过期条件：无

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
- 标题栏状态符号的次要态：开关类图标（plan / verbose / symbol-unify / bell）`off` 用 `gray`，`on` 用默认前景（不着色）；沙箱取值不是 `ro` / `wr` / `full` 时图标同样回落 `gray`；此外还有状态列旧 goal 的标题行与 objective（灰 + 删除线，与已完成 todo 同口径）
- 列表面板：标题右侧按键提示（`JobsPanel` / `CommandListPanel`）、空态与加载态占位（`（无后台任务）` / `加载中…`）、取消/停用状态符号（`statusMark` 的 `○`；`✓` 为默认前景，jobs 完成行的灰 + 删除线由 `layout.ts` 单独实现）
- notice 的 `log` tone 与工具行的灰行（进度/状态类）

## 边框（border）元素

非焦点态：活动区 / 状态区分隔线、分隔列与框格连接字（`│` `┤` `┴`，横向排列下标题栏下划线与内部分隔列的 `┬`）、状态区上/下分隔（上下逻辑不同：上方随焦点，下方恒边框色）、markdown 水平分隔线、空标题 `<title>` 占位。状态栏的组内与组间分隔自 P2 起统一为 `•`（默认前景、1 列、无空格），不再是边框色竖线 `│`，其上方/下方横线也随之没有组间交点 `┬`。

## 强调（focus）

焦点态由 `layout/focus-frame.ts` 的全局 `FocusFrame` 覆写实现，取色走语义槽位 `focus`（`focusColor()`）：状态列焦点顶框（屏幕最左起、右端止于 D 列）与左缘框格、历史/活动区焦点框（D 列/内部分隔列连接字 + 区域外缘框列角字）、焦点时的活动区分隔线与连接字。**不再按主题 ID 推断**（旧的 `dark=brightWhite / light=black` 分支已删除）。

## 基底前景

未显式着色的文字一律走 Screen 帧首铺设的基底前景 `theme.foreground`——包括对话/活动区正文、输入区文本与提示符（单字符模式符号）、按键提示区、状态列正文（goal objective / todo 待办等）、状态块之间虚线 `╌`（与字体同色，不染边框蓝）、会话标题（非 `<title>` 占位）、模型段的 effort 后缀、cache 徽标、markdown 正文；代码块语言标签为默认前景斜体，代码块正文行整体带 `code` 背景。**例外（按语义着色，各有一张排版层常量表）**：

- **用户块首行左侧的状态符号**（`USER_BLOCK_SYMBOL` / `userBlockSymbolResolver`）：终态 `✓` 绿（success）/ `✗` 红（failure）/ `■` 灰（aborted）；最新未终态块在忙时 `●`/`○` 黄（虚拟 token 交替）、审批/问答面板打开时 `△` 黄；其余无终态块（恢复的历史等）`?` 不着色；排队块不显示符号。
- **标题栏状态符号组**（`TITLE_ICON` + `titleBarSegments`，按语义值取色，不以主题分支）：沙箱图标 `read-only` 绿 / `workspace-write` 黄 / `danger-full-access` 红 / 其它值灰；policy `ask` 黄 / `never` 绿；plan / verbose / symbol-unify / bell 开关 `on` 默认前景 / `off` 灰；preset 图标 + 预设名默认前景。`permission` 不再显示（值仍随会话状态快照保存）。图标是 Nerd Font 私有区字形（各 1 列，码位见 `layout.ts` 的 `TITLE_ICON`），终端字体不支持时显示豆腐块——那是字体缺字形，与本文件的配色口径无关。
- **状态栏分隔**：组内与组间统一 `•`（U+2022）取默认前景色（P2；1 列、两侧无空格），组间不再有边框色竖线，横线上也不再有交点 `┬`；状态列右缘（D 列）的 `┴`/`├` 等连接字仍取 `border`/焦点色。

排版层只携带语义色名，不落 hex；主题切换后由渲染层重新铺设基底。

## 权威源与引用规则

- 解析优先级（`theme-config.ts`）：内联 `palettes.<id>` → `paletteDir/<file>.json` → `theme.ts` 内置兜底 `THEMES`（`paletteDir` 查找链：配置值 → `$FFF_HOME/config/terminal-colortheme` → `~/fff/config/terminal-colortheme`）；启动时解析一次，不热重载。
- 语义槽位可经 `palettes.<id>.semantics` 覆盖（支持 `"ansi.N"` / `"bright.N"` 槽位引用或字面 hex）。
- 颜色引用一律经 ColorName → `ansiNameToHex(theme, name)` 映射取 SGR，不得散落硬编码 SGR/hex。

## 语义槽位现状说明

- `code` 是背景色槽位（不属灰度三语义）：与 `gray` / `border` / `focus` 一样是 `SemanticColorName` 之一（`theme.ts`），内置值按各主题底色调性取槽位（dark ansi[0] / light ansi[7]），可由内联 `palettes.<id>.semantics` 覆盖，语义随主题解析。
- 彩色 tone（info 蓝 / warn 黄 / success 绿 / error 红）与面板生效色（选中行绿 / 焦点行黄）、沙箱危险等级色（`ro` / `wr` / `full` → 绿 / 黄 / 红）、思考紫不在灰度三语义范围内。
