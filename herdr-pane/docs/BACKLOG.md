# herdr-pane 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 条目详情（待办）

**1. 沙箱模式联动：会话处于 `read-only` 时拒绝写类动作**（P2，二期候选）：**现状** —— 首期用「归属 + guard 复查 + 越界审批」三闸覆盖，不看会话沙箱模式；三个闸都放行时，写类动作照常执行。**期望** —— 订阅 `session/event` 的 `sandbox/mode` 折叠当前模式，`read-only` 下对 `send_text` / `send_keys` / `run` / `close`（及 stable 模式的 `wait`）直接拒绝并给「切换沙箱模式」提示。**开口** —— 会话初始模式在无事件时无从判定（`sandbox/mode` 是会话事件、不是可查询服务），需先确认真实时序与重启 / resume 后的补偿路径，否则会把闸门做成误拦或空设（设计文档决策项 12）。**落点** —— `src/main.ts`（订阅 + 折叠）、`src/policy.ts`（纯函数判定）、`tests/`。**验收** —— read-only 会话里写类动作被拒且回执点明原因；切到 `workspace-write` 后同一动作放行；无事件时按「不拦」处理并有单测钉住。**来源** —— `docs/implementation/2026-10-16-herdr-pane-design.md` 决策项 12。

## 已知边界（不打算在本模块解决）

- **跨包登记（闸②）不在本包**：`security-guard` 的 `PLUGIN_COMMAND_TOOLS.herdr_pane` 由条目
  「登记两个新插件工具的命令参数面（`script_run` / `herdr_pane`）」在 `security-guard` 侧落地；
  本包只保证参数面与登记形态一致（`commandKeys: ["command", "text"]` +
  `commandPaths: ["keys[]"]`），并在 `README.md` 写明。
- **抽 tmux / herdr 公共底床层**：与 tmux 条目只约定动作名（`create / list / read / wait /
  send_text / send_keys / run / close`），不建公共层；两条目都落地后另立条目。
- **残留 pane 的后台清理守护**：属「后台常驻守护机制」条目范围；本包只在正常退出时尽力关闭，
  崩溃残留靠 label（缺省 `dsh-pane`）识别 + `list` 查看 + 显式 `close`。
- **`format=ansi` 的颜色语义**：首期不验（socket 侧 `strip_ansi: false` 与 CLI `--format ansi`
  对齐即可，颜色证据本身留给人工看）。
