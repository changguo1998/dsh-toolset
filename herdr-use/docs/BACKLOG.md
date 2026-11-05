# herdr-use 待办（包级）

跨包条目见项目级 `docs/BACKLOG.md`；本文件只收本包条目。

## 条目详情（待办）

（当前无未完成项。）

## 已知边界（不打算在本包解决）

- **残留 pane 的后台清理守护**：属「后台常驻守护机制」条目范围；本包只在正常退出时尽力关闭，
  崩溃残留靠 label（缺省 `dsh-pane`）识别 + `list` 查看 + 显式 `close`。
- **`format=ansi` 的颜色语义**：首期不验（socket 侧 `strip_ansi: false` 与 CLI `--format ansi`
  对齐即可，颜色证据本身留给人工看）。
