# herdr-pane 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 条目详情（待办）

**1. herdr 工具面添加 tab / workspace 操作**（2026-10-21 登记, 来源: 升级 0.2.1 真机验证时发现——新开独立验证实例只能走 herdr CLI `tab create`, 建出的 tab pane 不在插件登记范围, `herdr_pane` 写类动作拒收; 且工具面 10 个动作全为 pane 层, 无 tab / workspace 语义）：**现象 / 现状** —— `herdr_pane` 工具动作枚举仅 `create / list / read / wait / send_text / send_keys / run / label / info / close`（`src/tools.ts`），无一覆盖 tab（`herdr tab create/list/get/focus/rename/close`）与 workspace（`herdr workspace ...`）; 需要独立窗口 / 独立会话验证（如本次 dsh 升级真机复测）时只能退到 bash 调 CLI, 且对非插件创建的 pane 写类操作被拒。**期望** —— 工具面补充 tab / workspace 类动作（如 `tab_create` / `tab_list` / `tab_close` 与 workspace 查询 / 切换）, 新建 tab 内的 pane 走插件登记, 使写类动作（run / send_text / 等）可作用于其中; 复用既有 `allowForeignPanes` / label 归属与安全边界。**优先级** —— P3。**状态注记** —— 进行中: 2026-10-21（追踪文档 `herdr-pane/docs/implementation/2026-10-21-herdr-pane-tab-workspace.md`）。

> 2026-10-19 关闭：「沙箱模式联动：会话处于 `read-only` 时拒绝写类动作」已完成并从本清单移除 —— 新增沙箱门（闸④，`tools/pre-execute` 里先于审批返回 `deny`），模式问宿主 `ctx.sandboxPolicy.resolve()`；同处修正了审批门的载荷字段名（`name` / `arguments` / `agent`，原实现读 `toolName` / `args`，导致审批门在生产路径恒放行）；121 例单测（+12）与两次反向验证；追踪文档归档 `herdr-pane/docs/archived/2026-10-19-herdr-pane-sandbox-mode.md`。

## 已知边界（不打算在本模块解决）

- **跨包登记（闸②）不在本包**：`security-guard` 的 `PLUGIN_COMMAND_TOOLS.herdr_pane` 由条目
  「登记两个新插件工具的命令参数面（`script_run` / `herdr_pane`）」在 `security-guard` 侧落地；
  本包只保证参数面与登记形态一致（`commandKeys: ["command", "text"]` +
  `commandPaths: ["keys[]"]`），并在 `README.md` 写明。
- **抽 tmux / herdr 公共底床层**：与 tmux 条目只约定动作名（`create / list / read / wait / send_text / send_keys / run / close`），不建公共层；两条目都落地后另立条目。
- **残留 pane 的后台清理守护**：属「后台常驻守护机制」条目范围；本包只在正常退出时尽力关闭，
  崩溃残留靠 label（缺省 `dsh-pane`）识别 + `list` 查看 + 显式 `close`。
- **`format=ansi` 的颜色语义**：首期不验（socket 侧 `strip_ansi: false` 与 CLI `--format ansi`
  对齐即可，颜色证据本身留给人工看）。
