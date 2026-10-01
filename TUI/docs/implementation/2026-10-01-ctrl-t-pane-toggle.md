# Ctrl+T 切换回合/工具区显示（接取条目：`TUI/docs/BACKLOG.md`「新增快捷键 `Ctrl+T`：切换回合区 / 工具区的显示」）

状态：规划　　开启：2026-10-01
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

## 待确认

（无——已按上表定稿；后续新问题按需追加）

## 规划（计划改动文件清单）

1. `TUI/src/app/index.ts`：`handleKey` 加 `Ctrl+T` 分支 + 整帧重排。
1. `TUI/src/app/state.ts`：pane 可见性状态与持久化字段（对齐 `Ctrl+S`）。
1. `TUI/src/app/layout.ts`：`buildTopRegion` 按可见性分配高度与边框。
1. `TUI/tests/`：切换后的帧断言（无残影、焦点循环跳过隐藏 pane）。
1. `TUI/docs/SPEC.md` / `COMMANDS.md`：快捷键表。

## 验收口径

真机：`Ctrl+T` 一键切换、布局立即重排无残影；隐藏期间 session 区可正常读长文；再按恢复；重启/恢复会话与持久化一致；输入态与面板打开态下不吞普通输入。
