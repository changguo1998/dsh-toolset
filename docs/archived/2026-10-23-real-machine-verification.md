# 真机验证清单（herdr-use 终端面 / coagent / 三个适配插件 / TUI 表格）

状态：14 项全部判读完成，现全部通过（#5 跨 lane 清理于 2026-10-24 补验；#8 前提不成立按通过记）　　开启：2026-10-23　　关闭：2026-10-24
本文件是真机验证阶段的过程记录与落点；每验完一项就地补「结果」列与证据（工具回执 / 屏幕摘要 / 命令输出）。

## 前置

1. `npm run build`（2026-10-23 23:38 已跑，产物含 `herdr_run` 与 `provide`）—— profile 以 `link:` 挂载，重启 dsh 即生效。
2. 重启 dsh（用户 2026-10-23 执行）：当前会话跑的是合并前的旧 dist。
3. `coagent` 未接根级线（根 `package.json` / `AGENTS.md` / 两份 README / `scripts/*.sh` / profile），**未挂载**；涉及 coagent 与「服务面被消费方取到」的项需先完成该接线（项目级条目 6）。

## 清单

| # | 区块 | 验什么 | 怎么做 | 判据 |
| --- | --- | --- | --- | --- |
| 1 | herdr-use | 十工具主链 | 让模型 `herdr_create` -> `herdr_run "echo hello"` -> `herdr_read` -> `herdr_close` | 回执含 `terminal_id`；读屏见 `hello`；close 后 tab 消失 |
| 2 | herdr-use | 后台 lane | `herdr_create {foreground:false}` 后 `herdr_list` | 该终端标 `foreground:false`，且落在 herdr 会话 `dshbg` |
| 3 | herdr-use | 后台 socket | 后台终端跑 `sleep 5`，再 `herdr_wait {stable:true, timeout_ms:8000}` | 不报 socket / 路径错误，能判稳返回 |
| 4 | herdr-use | label | `herdr_label {terminal_id, label:"x"}` | tab 标题与 root pane label 同时变（`herdr_list` 对账） |
| 5 | herdr-use | 退出清理 | 建 1 个后台终端后退出 dsh | 退出后该 tab 被关；workspace 内无自建 pane 时 workspace 关掉（自带 root pane 不登记，按 README 已知边界可能留着） |
| 6 | security-guard | 命令层仍拦 | `herdr_run` 注入 `rm -rf /tmp/xxx` 类危险命令 | 被 security-guard 拒绝（deny 回执），不落到终端 |
| 7 | behavior-correction | 指路文案 | 让模型在 `bash` 里跑 `herdr pane list` | 被拦，理由文案指向 `herdr_run` / `herdr_text` / `herdr_key` / `herdr_read`，不再出现 `herdr_use` 与 `pane_*` |
| 8 | auto-approve | 审批请求面 | 开审批面板后连续调读类工具（`herdr_read` / `herdr_info`）与写类工具 | 观察读类是否逐次弹确认（当前裁定：不纳入只读类 → 会弹） |
| 9 | TUI 表格 | 分隔行少列成表 | 让模型发一条「表头 3 列 + 分隔行 2 列」的表格回复 | 成表（有 `═`、无残留 `|`），不退回原文 |
| 10 | TUI 表格 | 思考行表格 | 让模型在思考里放一张 markdown 表格 | 成表且左缘竖线为紫（`brightMagenta`） |
| 11 | md-table-check | 已下线 | 发一条列数不一致的表格 | 不再出现 `[md-table-check]` 提示（若 profile 自带 `enabled: true`，先改 profile） |
| 12 | coagent（需接线） | 拉起与认领 | `coagent spawn` | 回执 `terminal_id` / `session_id`，新 tab 可见，`session_channel peers` 里在线 |
| 13 | coagent（需接线） | 收尾 | `coagent close` | `/quit` 生效或 `force` 关掉；peers 掉线；tab 消失 |
| 14 | 服务面（需接线） | 共享 registry / 锁 | 挂 coagent 后看它是否注册工具并成功 `ctx.get("herdrUse")` | coagent 会创建、herdr-use 工具能看到同一批终端 |

## 执行约定

- 每项验完即在本表补结果：`通过` / `不通过（现象）` / `跳过（原因）`。
- 不通过的项：先判断是契约偏差还是实现缺陷，再决定改代码还是改文档；跨包改动先回报。
- 真机结论只写实测看到的东西，不用单测结果代替。
- 涉及 herdr 面板观感的项（5 / 9 / 10），屏上截图或文字摘要一并记下。

## 结果

| # | 结果 | 证据 |
| --- | --- | --- |
| 1 | 通过 | `herdr_create` -> `wZ3:p2`; `herdr_run "echo hello-verify"`; `herdr_read` 见到 `hello-verify`; `herdr_info` 回 `running=true shell_pid=2586074`（进程为 zsh）; `herdr_close` 后 `herdr_list` 只剩宿主 pane． |
| 2 | 通过（手动起 server + 自动拉起复核） | 首轮失败：`dshbg` 的 herdr server 未运行，`herdr session attach dshbg` 在 pane 内被拒（`nested herdr is disabled by default`）、去 TTY 则客户端立刻退出．**找到正解**：`herdr server` 是 headless server，`setsid herdr --session dshbg server >/tmp/dshbg-server.log 2>&1 < /dev/null &` 后 `herdr session list` 里 `dshbg` 变 `running`（log 打印 `herdr server running` 与 socket 路径）；随后 `herdr_create {foreground:false}` 回 `已建终端 w1:p2（后台 dshbg）`，`herdr_list` 同时列出前台 `wZ3:p4` 与后台 `w1:p2` 并各标 `[本插件]`．2026-10-24 复核自动拉起：先 `herdr session stop dshbg`，再 `herdr_create {foreground:false}` 回 `w2:p2`（新 workspace）；`herdr_list` 标 `[本插件]`，`herdr_run "echo autostart-ok"` 后 `herdr_read` 见 `autostart-ok`，`herdr_close` 注销，server 由 `ensure()` 自动拉起． |
| 3 | 通过 | 后台终端 `w1:p2` 上 `herdr_run "sleep 2; echo bg-ok"` -> `herdr_wait {match:"bg-ok"}` 命中 -> `herdr_wait {stable:true}` 判稳（502 / 602 ms，走 socket）-> `herdr_read` 见 `bg-ok`．后台 lane 的 socket 解析正常． |
| 4 | 通过 | `herdr_label {label:"verify-main-2"}` 成功，`herdr_list` 里该终端 label 随之变成 `verify-main-2`，且标 `[本插件]`． |
| 5 | 通过（跨 lane 补验） | `herdr_close` 后 `herdr_list` 只剩宿主 pane `wZ3:p1`；2026-10-24 跨 lane 退出清理补验：建后台终端 `w2:p3`（label `verify-exit-bg`）后正常退出 dsh，`~/.config/herdr/sessions/dshbg/herdr-server.log` 于 14:09:55 记 `tab.close`，`sessions/dshbg/session.json` 里 workspace `w2` 只剩 root pane（tabs=1 / panes=1），server 仍在运行（socket 在，14:10 仍有客户端连入）；workspace 因自带 root pane 不关，按 README 已知边界． |
| 6 | 通过 | `herdr_run "echo mkfs-probe"` 被 security-guard 拦下，回执明写「拦截来源：插件命令工具「herdr_run」的命令参数（command）」——改名后登记仍生效．另注：`rm -rf /tmp/...` 未被拦（黑名单不含通用 rm，属既有策略，与本改名无关）． |
| 7 | 通过 | `bash` 里跑 `herdr status` 被拦，理由为「bash 里不要跑 herdr 命令: 改用 herdr_run / herdr_text / herdr_key（写类）与 herdr_read / herdr_list（查看类）」，已无 `herdr_use` / `pane_*`． |
| 8 | 通过（前提不成立） | herdr 工具定义无审批元数据（`herdr-use/src/tools.ts:200` 的 `HerdrUseToolDef` 不含 ask / approval 字段），不发起 `approval/request`；2026-10-24 实测 `herdr_list` 未弹面板，2026-10-23 连续调用 `herdr_create` / `run` / `read` / `info` / `label` / `close` 同样无面板．只读名单是否收 herdr 读类（`auto-approve/src/config.ts:11` 的 `DEFAULT_READONLY_TOOLS` 不含）因此不影响体验． |
| 9 | 通过 | 2026-10-24 在 TUI 里发「3 列表头 + 2 列分隔行」的表格回复，目视成表（双线边框、无残留竖线），未退回原文． |
| 10 | 通过 | 2026-10-24 思考行里放 markdown 表格，目视成表且左缘竖线为紫（`brightMagenta`）． |
| 11 | 通过（配置 + 运行时） | `~/.dsh/profiles/fff/cordis.patch.yml` 无 `md-table-check` 条目 → 走 bundle 默认（已改 `enabled: false`）；2026-10-24 发列数不一致的表格回复（3 列表头 + 2 列分隔行），未出现 `[md-table-check]` 提示． |
| 12 | 通过 | `coagent spawn {label:"verify-12", cwd:".../dsh-toolset"}` -> 回执 `coagent_id=c-44dc4f93` / `terminal_id=wZ3:p7` / `session_id=tui-294e7a43-...` / `state=ready`，认领耗时约 4.4 s（180 s 上限内）；`herdr_list` 里该终端标 `[本插件]`、label `coagent/c-44dc4f93`；`herdr_read` 读到子会话的 dsh 界面（工具提示行可见）；`session_channel peers` 里有该 session，`state` 回 `running`． |
| 13 | 通过 | `coagent close {coagent_id}` -> `state=closed` / `closed_with=quit` / `removed_files=true`；`herdr_list` 只剩宿主 pane；`session_channel peers` 已无 `tui-294e7a43`（子会话确实退出）．注：`session_channel state` 对该 session 仍回 `running`（退出后的缓存），以 `peers` 为准． |
| 14 | 通过 | 服务面与工具面同源：coagent 经 `herdrUse` 建的终端出现在 `herdr_list` 并同标 `[本插件]`，`herdr_read` 可直接读它的屏；`coagent close` 关掉后工具面也同步消失． |

## 遗留与下一步

- **后台 lane 的前置已查清并已实现**：`herdr server` 是 headless server（文档 CLI reference「Server」节：「runs the headless server explicitly ... for supervised or service-style setups」），配 `--session dshbg` 即可在无常驻 TUI 的情况下拉起具名会话。实测通过（见 #2 / #3）。
  - 落地方式（用户 2026-10-23 裁定）：`herdr-use` 在后台命令前 `ensure()` —— 探测 `session list --json`，缺则 detached spawn `herdr --session dshbg server` 并轮询到 running（10 s / 250 ms），**只拉起不关闭**、不记「谁起的」；并发单飞、失败清缓存下次重探，失败返回 `background-session-unavailable` 不退化前台。实现见 `herdr-use/src/background.ts`（合并 `8de0816`，4 个提交 `bfdbea5` / `d4bfa4b` / `aa44c2c` / `e184ffe`，135 例单测全绿）。
  - **真机核过探测面**：`herdr session list --json` 的真实形态是**顶层 `{"sessions":[{"name":"default","running":true,…},{"name":"dshbg","running":true,…}]}`**（不是 `{result:{…}}` 信封、也不是裸数组）；实现里 `obj(root.result) ?? root` 的回落正好覆盖，字段取 `name` 与 `running: true`，与本机输出一致。
  - 附带发现：`herdr session attach <name>`（TUI 客户端）与 `herdr server`（headless）是两条不同入口；此前误以为只有 attach。
  - 自动拉起已复核通过（2026-10-24：停掉 `dshbg` 后由后台工具触发，见 #2 结果补充）。
- #8 / #9 / #10 / #11 运行时于 2026-10-24 判读完成（见上表）。
- #12 至 #14 已完成（coagent 接线后重启验过，见上表）。
- 接线过程中修掉一个真实缺陷：`coagent` 原先只把 `herdrUse` / `sessionChannel` 放在 `ctx.get` 里取，cordis 不保证对方先 `provide`，取到 `undefined` 就走「缺服务」分支直接 return，表现为重启后工具静默不出现；已改为静态 `inject`（`231f26a`）。
- 后台 lane 的 headless server 由 `ensure()` 拉起后仍在运行（日志 `~/.config/herdr/sessions/dshbg/herdr-server.log`）；要还原用 `herdr session stop dshbg`。

## 收尾

- 关闭：2026-10-24；本文件由 `docs/implementation/` 移入 `docs/archived/`。
- 引用回写：仓内 7 个文件共 9 处 `docs/implementation/2026-10-23-real-machine-verification.md` 改为 `docs/archived/` 路径（`docs/BACKLOG.md` 2 处、`docs/archived/2026-10-23-herdr-use-terminal-surface.md` 2 处，其余 4 个归档文档各 1 处）；DESIGN / README / ROADMAP 无相关内容，不改。
- BACKLOG：本任务不对应条目，无需清理。
- 遗留项：无（#5 跨 lane 清理已于 2026-10-24 补验通过）。
- 范围外：`auto-approve/docs/archived/2026-10-22-worktree-git-escalation.md` 已于 2026-10-24 关闭（用户裁定规则保留）。
