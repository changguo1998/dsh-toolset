# herdr-use 待办（模块级）

跨模块条目见项目级 `docs/BACKLOG.md`；本文件只收本模块条目。

## 条目详情（待办）

> 2026-10-22 完成并关闭：「tab_create 之后不必再建 pane: 工具描述与回执要说清『新 tab 自带 root pane』」已修并合入 main（提交 `5121690`，走快速流程）—— `src/tools.ts` 的主描述改写 `tab_create` 句（「新 tab 自带 root pane，回执的 pane_id 即该 pane，可直接 pane_run / pane_send_text / pane_read 等，无需再 pane_create」）并给 `pane_create` 句补「刚建完 tab 时不必调用，tab 自带 root pane」；`tab_create` 回执渲染点明自带 root pane。同步：`tests/tool.test.ts` 三条描述断言 + 回执断言、`README.md` 动作表两行。证据：包 `check` / `build` 通过、`npm test` 156 例全绿、全仓 30 包 `check` 通过。真机未复验（纯文案改动）。

> 2026-10-21 关闭：「herdr 工具面添加 tab / workspace 操作」已完成并从本清单移除 —— 工具面 10 → 13 个动作（`tab_create` / `tab_list` / `tab_close`），workspace 面整体不出工具面（每个 dsh 会话由插件内部绑定一个 herdr workspace，`create` 落点是该 workspace 的活动 pane，`tab_close` 只认本 workspace 已登记的 tab）；合并 `b3f45ea` / `b17ad5c` / `ef94191`；本包 155 例单测全绿；真机 `--with-tab --check-cascade` 20 步全链路通过（含 `send_text` / `send_keys` / `run` 静默成功修复生效），关掉 tab 的最后一个 pane 只级联关 tab、workspace 由插件退出清理关闭且无残留；追踪文档归档 `herdr-use/docs/archived/2026-10-21-herdr-pane-tab-workspace.md`。剩余未验证项：用户后来在 workspace 里开的 pane 会阻止内部关 workspace 的保护分支未在真机构造验证。

> 2026-10-19 关闭：「沙箱模式联动：会话处于 `read-only` 时拒绝写类动作」已完成并从本清单移除 —— 新增沙箱门（闸④，`tools/pre-execute` 里先于审批返回 `deny`），模式问宿主 `ctx.sandboxPolicy.resolve()`；同处修正了审批门的载荷字段名（`name` / `arguments` / `agent`，原实现读 `toolName` / `args`，导致审批门在生产路径恒放行）；121 例单测（+12）与两次反向验证；追踪文档归档 `herdr-use/docs/archived/2026-10-19-herdr-pane-sandbox-mode.md`。

## 已知边界（不打算在本模块解决）

- **跨包登记（闸②）不在本包**：`security-guard` 的 `PLUGIN_COMMAND_TOOLS.herdr_use` 由条目
  「登记两个新插件工具的命令参数面（`script_run` / `herdr_use`）」在 `security-guard` 侧落地；
  本包只保证参数面与登记形态一致（`commandKeys: ["command", "text"]` +
  `commandPaths: ["keys[]"]`），并在 `README.md` 写明。
- **抽 tmux / herdr 公共底床层**：与 tmux 条目只约定动作语义（本包动作名按对象分组：pane 类 `pane_` 前缀、tab 类 `tab_` 前缀），不建公共层；两条目都落地后另立条目。
- **残留 pane 的后台清理守护**：属「后台常驻守护机制」条目范围；本包只在正常退出时尽力关闭，
  崩溃残留靠 label（缺省 `dsh-pane`）识别 + `list` 查看 + 显式 `close`。
- **`format=ansi` 的颜色语义**：首期不验（socket 侧 `strip_ansi: false` 与 CLI `--format ansi`
  对齐即可，颜色证据本身留给人工看）。
