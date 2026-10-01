# 三区域命名与窗口标题（接取条目：`TUI/docs/BACKLOG.md`「三区域改名（Session / Turn / Tool pane）+ 窗口左上角标题（聚焦青色）」）

状态：测试　　开启：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

UI 呈现层改名并加窗口标题：session 区（原历史区）→ **Session pane**、turn 区（原活动区）→ **Turn pane**、问答/审批/命令等交互面板 → **Tool pane**；三窗**左上角**写名字（形如 `-- Session --`、`-- Turn --`，并排即 `-- Session --|-- Turn --`）；名字配色：未聚焦 = 与边框同色（`fg: "border"`），聚焦 = **青色**（`semantics.focus` 同步改青，焦点框一起——与 #4 共用改动点）；**水平状态栏、垂直状态栏、输入栏不加标题**；**不做术语替换**（文档/代码可继续用旧词）。

## 调研

- 现状无任何窗口标题：窗与窗之间只有分隔线（`content-rules.ts` 的 `ACTIVITY_SEPARATOR` / `STATUS_TOP_SEPARATOR`，`layout.ts` 绘制时 `fg: "border"`）与焦点框（`focus-frame.ts`）。
- 标题只能写在**既有边框行**上（顶边框/分隔线行的左端），否则会占内容列——与 #4 的"不新增边框列"约束一致。
- 焦点色单源 `focusColor()` → `"focus"`（现 dark `#FFFFFF` / light `#121418`），改青只需改 `theme.ts` 的 `semantics.focus`（两主题各选合适青色槽位）。
- 状态列可见性由 `Ctrl+S` 控制（P7），隐藏时不画垂直状态栏 → 标题渲染需处理该退化。

## 决策（2026-10-01 定稿）

1. 标题写在 pane **顶边行的左端**（`-- Session --` / `-- Turn --` / `-- Tool --`），不新增行、不占内容列。
1. **Turn 与 Tool 共用同一标题位**：该位显示流输出时写 `-- Turn --`；出现问答/审批/命令等工具面板时该位写 `-- Tool --`（谁在显示就写谁）。
1. 配色：未聚焦 = `fg: "border"`；聚焦 = **青色**（`semantics.focus` 改青，与「焦点框只改颜色」共用）；聚焦同时换更粗字形（同该条）。
1. 水平状态栏、垂直状态栏、输入栏**不加标题**；**不做术语替换**（文档/代码可继续用旧词）。
1. 窄窗降级：放不下就整条省略（不折行、不占内容列）。
1. 与「焦点框只改颜色」共用改动点（`semantics.focus` 改青 + 框线样式覆写），建议同一实现批次内完成。

## 待确认

（无——已按上表定稿；后续新问题按需追加）

## 规划（计划改动文件清单）

1. `TUI/src/app/layout/content-rules.ts`：标题文本/字形常量。
1. `TUI/src/app/layout.ts`：顶边框行写标题（含状态列隐藏、横向/纵向布局两种形态）。
1. `TUI/src/renderer/theme.ts`：`semantics.focus` → 青（与 #4 共用）。
1. `TUI/tests/`：标题渲染与聚焦变色用例（含窄窗降级、状态列隐藏）。
1. `TUI/docs/SPEC.md`：窗口标题规格（标题文本、位置、配色）。

## 实现记录

2026-10-01：

1. `layout.ts`（`buildTopRegion`）：新增 `sessionFocused` / `lowerFocused` / `toolPaneShowing`（approval|question|picker|statusPanel）与 `titledRow(width, title, focused)`——把 `-- <title> --` 写进**既有边框行左端**并用边框线补满，放不下（标题后不足 1 列线）时返回 null 表示整条省略。

1. 落点：垂直排列——Session 标题写标题栏下划线行左端、Turn/Tool 标题写活动区分隔行左端（下半区顶边）；横向排列——同一行两 pane 各自左端（`-- Session --┬-- Turn --`）。

1. 配色与「焦点框只改颜色」同源：未聚焦 `fg: "border"`，聚焦取 `focusColor()`（主题 `semantics.focus`，现为青）。

1. 不加标题的对象保持无标题：水平状态栏、垂直状态栏（状态列）、输入栏。

1. 测试：新增 `tests/pane-titles.test.ts`（位置/左端、未聚焦=边框色、聚焦=青、面板态写 Tool、窄窗省略、输入栏无标题）；受影响的既有用例改为"先剥标题再判定"——`app.test.ts`/`layout4.test.ts` 的 `isSepRow`、`barRowCount`、下划线行正则；冻结基线 `fixtures/focus-frame-legacy.json` 15 个场景全部按新实现重新冻结（临时 FREEZE_FOCUS 钩子，用完已还原）。

1. 人工确认反馈：标题两侧改用**边框线字形**（`── Session ──`）——用户原话里的 `--` 只是输入不便的示意；横线补满与标题连成一体。

## 测试与证据

- `npm run check` ✓、`npm run build` ✓。
- **全量 `npm run test:tui` 1238/1238 pass**（含新增 4 条）。
- 待人工确认（真机）：三窗左上角显示 `-- Session --` / `-- Turn --` / `-- Tool --`；未聚焦与边框同色、聚焦转青；状态栏与输入栏不出现标题；窄窗（\<16 列）标题整条消失且不破版。

## 验收口径

真机：三窗左上角分别显示 `-- Session --` / `-- Turn --` / `-- Tool --`；未聚焦 = 边框色、聚焦 = 青色（Tab 循环可见，深浅主题各一次）；状态栏与输入栏不出现标题；窄窗不破版。
