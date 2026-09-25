# TUI 状态

> 职责：TUI 包的现状快照（完成情况、命令面、与宿主升级的适配状态）
> 不负责：项目级状态与宿主基线（见 `docs/DEVELOPMENT-STATUS.md`）、待办与开放项（见 `TUI/docs/BACKLOG.md`）
> 过期条件：无（状态变化即更新）

## 现状

- **界面与渲染**：排版重构（Box 模型）、排版缓存与绘制合帧、主题调色板可配置化、命令扩展与空会话自动清理均已完成。细节修复两轮：P1–P9 已归档（`archive/TUI-P1-P9-FIX-RECORD.md`）；其后一轮已合入——`Ctrl+S` 隐藏状态列后状态区上方分隔行的残留 / 错位交点、用户块状态符号改占左侧留白（正文列与续行对齐不受影响）、标题栏沙箱字形换 `md-package_variant[_closed]`、四个开关 `on` 绿 / `off` 灰、`/help` 字母序与文案汉化。口径见 `TUI/docs/SPEC.md`、`TUI/docs/IMPLEMENTATION.md`、`TUI/README.md`（重构任务清单已完成并归档：`archive/TUI-REFACTOR-TASKS.md`）。
- **命令面**：7 项纯 TUI 命令 + A1–A5（`/task` `/guard` `/memory` `/loop` `/contract`）+ `/workflows` `/council` `/search` 已完成；另有声音提醒、`/verbose` 两态、会话自动清理（`session.autoCleanEmpty`，默认开）。命令清单与层归属见 `TUI/docs/COMMANDS.md`，规格见 `TUI/docs/COMMANDS-SPEC.md`。
- **宿主升级适配（0.1.7-rc.2）**：`jobs` 的 caller / 增量订阅形态、`/agents` 的数据源（`listDescendants` 优先、投影目录降级）已做双栈兼容。交互验收通过：`/jobs` 能列出会话自有任务且 `Enter` 取消生效；`/agents` 显示 `continuable · inactive`（富条目路径生效）。
- **已知外部问题**：herdr pane 的 PTY 尺寸与其渲染区域差 1~2 列（同一构建在独立终端正常）——取证与修复方向见 `TUI/docs/BACKLOG.md` §3。
