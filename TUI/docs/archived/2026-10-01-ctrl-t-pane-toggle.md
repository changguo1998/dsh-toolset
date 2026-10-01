# Ctrl+T 切换回合/工具区显示（接取条目：`TUI/docs/BACKLOG.md`「新增快捷键 `Ctrl+T`：切换回合区 / 工具区的显示」）

状态：关闭　　开启：2026-10-01　　关闭：2026-10-01
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新增 `Ctrl+T`：切换 turn 区（原活动区）/ 工具区（交互面板区）的显示。

## 调研

- `Ctrl+T` 当前**未被占用**：`handleKey` 现有 `Ctrl+S`（垂直状态列显隐，P7）、`Ctrl+L`（强制整帧重绘）、`Ctrl+D`（退出确认）、`Tab`（焦点循环）等；`index.ts` 内无 `"t"` 按键分支。
- 可复用的先例：`Ctrl+S` 的 P7 实现——`state.ts` 的 `statusColumnVisible` + `tui-state.json` 持久化 + 隐藏后整帧重排（`index.ts:1864` 附近）；隐藏时焦点从该 pane 移开（`state.ts:1963-1969`）。
- 高度分配与边框绘制集中在 `layout.ts` 的 `buildTopRegion`（含 `innerDividerCol`、各 pane 的 `rects`）；焦点框按 `rects` 画（`focus-frame.ts`），隐藏 pane 需一并处理。

## 决策（2026-10-01 定稿）

1. **Turn + Tool 一起切换**：隐藏时两者高度归零、空间并入 session 区；**输入栏保留可输入**。
1. 隐藏的 pane **退出 `Tab` 焦点循环**（沿用 `Ctrl+S` 的"隐藏即不聚焦"口径）。
1. 可见性**随会话持久化**到 `tui-state.json`（对齐 `Ctrl+S`）。
1. 隐藏期间其标题位不显示（与「三区域命名与窗口标题」的共用标题位联动）。
1. 隐藏对象 = Turn pane（流输出）+ Tool pane 的**面板区**，**输入栏保留**；隐藏期间交互面板（问答 / 审批 / 命令）**仍照常弹出**（临时显示，不改变用户的可见性状态）。

## 待确认

（无——已按上表定稿；后续新问题按需追加）

## 规划（计划改动文件清单）

1. `TUI/src/app/index.ts`：`handleKey` 加 `Ctrl+T` 分支 + 整帧重排。
1. `TUI/src/app/state.ts`：pane 可见性状态与持久化字段（对齐 `Ctrl+S`）。
1. `TUI/src/app/layout.ts`：`buildTopRegion` 按可见性分配高度与边框。
1. `TUI/tests/`：切换后的帧断言（无残影、焦点循环跳过隐藏 pane）。
1. `TUI/docs/SPEC.md` / `COMMANDS.md`：快捷键表。

## 实现记录

2026-10-01：

1. `state.ts`：新增字段 `lowerPanesVisible`（缺省 true）与动作 `{type:"lower-panes"; visible?}`（visible 缺省取反）——隐藏时若焦点落在 activity 则移开（隐藏即不聚焦）；`focus-panel-cycle` 在隐藏时把 `activity` 从循环里过滤掉（与 P7 状态列的 skip 同写法）。

1. `layout.ts`：`frameGeometry` 里在 `topPaneSplit` 之后按 `!state.lowerPanesVisible && !panelShownInActivity(state)` 把活动区尺寸归零、空间并入对话区（纵向并入高度、横向并入宽度）；抽出 `panelShownInActivity()` 供标题位（#5）与几何共用——**面板打开时仍照常显示**（临时显示，不改用户可见性状态）。

1. `index.ts`：`Ctrl+T` 分支（镜像 `Ctrl+S`：apply → `scheduleSessionStateSave()` → `paint()`）；快照写入 `lowerPanes` 字段、恢复路径新增 `ui-flags.lowerPanes` 处理。

1. `adapter/dsh.ts` + `adapter/types.ts`：`ui-flags` 事件带上 `lowerPanes`（快照 → 事件的透传字段）；`session-ui-state.ts` 的 `SessionUiState` 增 `lowerPanes?`。

1. 输入栏不受影响（隐藏的只是 Turn 流与 Tool 面板区）。

1. 人工确认反馈：隐藏时改为**按单 pane 出图**——`activityW/activityH` 归零、`dialogueW = contentW`、`dialogueH = contentTopH - titleRows`、`mode = "vertical"`（横向排列下若只把 activityW 归零，会残留内部分隔竖线紧贴正文、行尾框线不与其它行对齐）。

## 测试与证据

- `npm run check` ✓、`npm run build` ✓。
- **全量 `npm run test:tui` 1244/1244 pass**（新增 `tests/ctrl-t-panes.test.ts` 4 条：切换动作、隐藏时移开焦点且循环跳过、几何归零并入对话区、面板打开仍显示）。
- 待人工确认（真机）：`Ctrl+T` 一键收起/展开下半区、会话区读长文正常、输入栏可输入；重启/恢复会话后与 `tui-state.json` 一致。

## 验收口径

真机：`Ctrl+T` 一键切换、布局立即重排无残影；隐藏期间 session 区可正常读长文；再按恢复；重启/恢复会话与持久化一致；输入态与面板打开态下不吞普通输入。
