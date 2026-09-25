# TUI 待办与开放项

> 职责：TUI 包的待办、开放项与已知外部问题（TUI 的变更优先写在本目录）
> 不负责：跨包功能待办（见 `docs/DEVELOPMENT-BACKLOG.md`）、TUI 现状（见 `TUI/docs/STATUS.md`）
> 过期条件：无

## 1. 命令扩展

- 7 项纯 TUI 命令与 A1-A5 已完成，9 项候选当前无待办。裁定理由见 `TUI/docs/COMMANDS-SPEC.md` §7（`/clear`、`/login` `/logout` 维持排除；`/review` 搁置，可随 `docs/DEVELOPMENT-BACKLOG.md` 的 #17 一并考虑）；命令清单与层归属见 `TUI/docs/COMMANDS.md`；实施清单（已完成）见 `archive/TUI-COMMANDS-TASKS.md`。

## 2. 已完成、不再跟踪

- 排版重构（Box 模型）与符号统一（白名单 / 归一 / 同符号冷却）均已完成，机制与配置见 `TUI/README.md`、`TUI/docs/SPEC.md`、`TUI/docs/IMPLEMENTATION.md`。

## 3. 开放项（已评估，未排期）

- **排版性能**：区域级帧输出 memo（状态列 / 状态栏 / footer，实测仅占单帧 1-4%）与「只测量可见窗口」的懒排版（需块高度前缀和 + 折叠 / 滚动边界处理）——现有有界缓存 + 同 tick 合帧已缓解主要成本。
- **`/help` 持续增长**：命令加行后 help 超过一屏，且既有测试存在依赖 help 行数的脆弱断言；改 help 前先检查相关断言（改动后需重跑 `scripts/freeze-focus-frame.mts` 并审查冻结基线）。
- **`state.usage` 语义**：`/stats` 展示「最近一次模型调用」，不是会话累计；要累计值需另行采集（`tokenMeter.measure` 接入成本高）。
- **面板占满活动区**：面板打开期间瞬态输出不可见（与 `/jobs` 行为一致），暂不改变。
- **herdr pane 尺寸与其渲染区域不一致（外部问题，TUI 侧无法自行校正）**：在 herdr pane 里运行时，全宽横线（状态栏下边框等）右端比 pane 渲染区少 1~2 列、需 `Ctrl+L` 或拖动 pane 才恢复；同一构建在独立终端里正常（2026-09-24 实测确认）。取证与排查结论：
  - 抓帧解析（`script -qec "dsh --profile fff" <cap>`）首帧：帧在它**自己的列数**下满宽（标题下划线 / 状态栏上下边框都到最后一列），活动区行按口径不补空格，布局无缺列；
  - 真机 PTY 假应答实验：`CSI 18t`（终端自报网格）确实由 TUI 发出，但终端的应答**到不了插件**（被宿主按键解码消费）→ 无法用终端查询校正尺寸；
  - 实测 Node 的 `stdout.columns` 与 `stdout.getWindowSize()` 都是**缓存值**（改 PTY winsize 但不发 SIGWINCH 时都不更新）→ 「实时 ioctl 读尺寸」这条路无效。
  - 结论：herdr 给 pane 的 PTY winsize 与实际渲染区差 1~2 列；修复应在 herdr 侧（pane 的 PTY 尺寸与渲染区一致，并在尺寸变化时同步下发、含 SIGWINCH）。本仓库 `herdr-integration` 只做状态上报（unix socket），不持有 PTY，无可改点；待 herdr 修复后回归验证。
  - 现场取证（在那台机器上跑，只读、结束恢复终端）：
    ```sh
    python3 - <<'EOF'
    import os,select,termios,tty
    fd=0; old=termios.tcgetattr(fd)
    try:
        tty.setraw(fd); os.write(1,b"\x1b[18t")
        r=select.select([fd],[],[],0.5)[0]
        print("终端自报网格:", os.read(fd,32) if r else "无应答", "| PTY:", os.get_terminal_size(1))
    finally:
        termios.tcsetattr(fd,termios.TCSADRAIN,old)
    EOF
    ```
- **`/agents` 刷新方式**：宿主无 subagent 状态事件面，现为打开期间每 2s 定时刷新 + `r` 手动；宿主补事件面后可改为事件驱动。
