# herdr pane 尺寸与渲染区域不一致（TUI BACKLOG 旧 #8；外部问题）

状态：归档（外部问题，TUI 侧不做实现）　　开启：2026-09-24　　归档：2026-09-27
2026-09-27 用户裁定：仅作提醒、不做实现。同日 `TUI/docs/BACKLOG.md` 改为只保留未完成项，本条移出为独立记录（本文件只承接取证与结论，不含待办）。
herdr 修复后若需回归验证，另开 BACKLOG 条目。

## 现象

在 herdr pane 里运行 TUI 时，全宽横线（状态栏下边框等）右端比 pane 渲染区少 1~2 列，需 `Ctrl+L` 或拖动 pane 才恢复；同一构建在独立终端里正常（2026-09-24 实测确认）。

## 取证与排查结论

- **抓帧解析**（`script -qec "dsh --profile fff" <cap>`）首帧：帧在它**自己的列数**下满宽（标题下划线 / 状态栏上下边框都到最后一列），活动区行按口径不补空格，布局无缺列；
- **真机 PTY 假应答实验**：`CSI 18t`（终端自报网格）确实由 TUI 发出，但终端的应答**到不了插件**（被宿主按键解码消费）→ 无法用终端查询校正尺寸；
- **实测 Node 的 `stdout.columns` 与 `stdout.getWindowSize()` 都是缓存值**（改 PTY winsize 但不发 SIGWINCH 时都不更新）→ 「实时 ioctl 读尺寸」这条路无效。

## 结论与修复方向

herdr 给 pane 的 PTY winsize 与实际渲染区差 1~2 列；修复应在 herdr 侧（pane 的 PTY 尺寸与渲染区一致，并在尺寸变化时同步下发、含 SIGWINCH）。本仓库 `herdr-integration` 只做状态上报（unix socket），不持有 PTY，无可改点。

## 现场取证脚本

在那台机器上跑（只读、结束恢复终端）：

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
