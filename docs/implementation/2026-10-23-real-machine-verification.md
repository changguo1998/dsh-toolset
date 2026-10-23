# 真机验证清单（herdr-use 终端面 / coagent / 三个适配插件 / TUI 表格）

状态：待执行（2026-10-23 会话重启后在本会话内逐项跑）　　开启：2026-10-23
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
| 2 | **不通过** | `herdr_create {foreground:false}` 回 `workspace-unavailable`: `no herdr server is running at ~/.config/herdr/sessions/dshbg/herdr.sock`．查明：`herdr session list` 只有 `default`；`herdr --session dshbg tab/workspace list` 同样 server_not_running；在 herdr pane 内起 `herdr session attach dshbg` 被拒: `nested herdr is disabled by default`；`setsid`（去 TTY）则客户端立即退出、server 仍不起．结论：**named session 的 server 只能由一个非 herdr 的交互终端 attach 起来**，"使用或创建" 的假设不成立． |
| 3 | 阻塞 | 依赖 #2（后台 lane 建不出来，stable 判稳无从验）． |
| 4 | 通过 | `herdr_label {label:"verify-main-2"}` 成功，`herdr_list` 里该终端 label 随之变成 `verify-main-2`，且标 `[本插件]`． |
| 5 | 部分通过 | `herdr_close` 后 `herdr_list` 只剩宿主 pane `wZ3:p1`；进程退出时跨 lane 清理未验（后台 lane 不可用）；workspace 自带 root pane 不登记 → 退出后 workspace 不自动关，按 README 已知边界，未另测． |
| 6 | 通过 | `herdr_run "echo mkfs-probe"` 被 security-guard 拦下，回执明写「拦截来源：插件命令工具「herdr_run」的命令参数（command）」——改名后登记仍生效．另注：`rm -rf /tmp/...` 未被拦（黑名单不含通用 rm，属既有策略，与本改名无关）． |
| 7 | 通过 | `bash` 里跑 `herdr status` 被拦，理由为「bash 里不要跑 herdr 命令: 改用 herdr_run / herdr_text / herdr_key（写类）与 herdr_read / herdr_list（查看类）」，已无 `herdr_use` / `pane_*`． |
| 8 | 待判读 | 本次连续调用 `herdr_create` / `run` / `read` / `info` / `label` / `close` 均未弹审批请求；读类是否逐次确认无法从本会话观察（未出现审批面板）． |
| 9 | 待用户目视 | 单测与 smoke 已覆盖（1748/1748、SMOKE_OK），真机需在 TUI 里看「3 列表头 + 2 列分隔行」是否成表． |
| 10 | 待用户目视 | 同上；需在 TUI 里看思考行表格是否成表且左缘竖线为紫． |
| 11 | 配置层面通过 | `~/.dsh/profiles/fff/cordis.patch.yml` 无 `md-table-check` 条目 → 走 bundle 默认（已改 `enabled: false`）；运行时「不再注入提醒」待一条列数不一致的回复确认． |
| 12-14 | 未做 | `coagent` 尚未接根级线（未挂载），服务面消费与拉起链路无从验． |

## 阻塞与待决策

- **#2 是一个契约级缺口**：`foreground:false`（后台 `dshbg` lane）在真机上起不来。可选处置：
  - a 契约收窄：声明后台 lane 需要预先存在 `dshbg` 会话（人工在 **非 herdr** 终端执行 `herdr session attach dshbg` 并保持附着），插件在该会话缺失时给出这条指引（当前报错是 herdr 原文，提示的是 attach，但没说明「不能在 herdr 内做」）。
  - b 改实现：后台 lane 不另开 session，改在同一 session 内建 tab 并标 `foreground:false`（放弃 session 级隔离）。
  - c 砍掉 `foreground:false`，只留前台 lane。
- #8 需要真机看到审批面板才能定；#9 / #10 需要用户在 TUI 里看一眼。
