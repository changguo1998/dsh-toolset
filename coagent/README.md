# @dsh-toolset/coagent

DSH（DeepSeek Harness）进程内集成插件：在 herdr **终端**的交互 shell 里发 `fffdsh`，拉起一个**独立进程、上下文零继承**的长驻 dsh 会话，认领它并把 `terminal_id` / `session_id` 交给调用方。

职责只有两段：**拉起**与**收尾**。中间的一切不实现——派任务 / 收结果走 session-channel，编排与等级走 agent-group，看屏 / 插话 / 按键走 herdr-use 的十个工具。

设计依据与取舍见追踪文档 `docs/implementation/2026-10-22-coagent.md`；机制说明见 `docs/DESIGN.md`。

## 能力

注册单个工具 `coagent`，按 `action` 分派三个动作：

| 动作 | 参数 | 语义 |
| --- | --- | --- |
| `spawn` | `cwd?` · `label?` · `claimTimeoutSec?` | 经 herdr-use 服务面 `create` 新建终端（前台、新 tab）→ `run` 一行 `fffdsh` → 轮询 `peers` 认领新会话。成功回执 `terminal_id` / `session_id` / `cmd:"fffdsh"`；失败即 `close(terminal_id)` 回滚并落 `failed` 记录 |
| `list` | `coagent_id?` · `state?` · `probe?` · `limit?` | 列本会话的记录（清理与排障用）。`probe=live`（缺省）对非终态记录做一次 `info` / `peers` 核对并推进状态；不返回任务态与忙闲 |
| `close` | `coagent_id` · `force?` · `keep?` | `/quit` → 等进程退出（`graceSec`）→ `close(terminal_id)`；`force` 直接关。幂等 |

`coagent_id` 形如 `c-<8 位 hex>`；终端 label 固定 `coagent/<coagent_id>`（新契约里 tab 标题与 root pane label 是同一个 label）。`label` 参数只是记录里的展示名（缺省 `coagent-<id>`），不进 herdr。

**动作面故意不含**：`send` / `wait` / `cancel` / `read`。`coagent` 不转发任何对话内容，也不解析任务结果。

## 交接契约（`spawn` 之后怎么用）

`spawn` 回执就是交接点。此后 coagent 不参与：

| 要做的事 | 用谁 | 具体调用 |
| --- | --- | --- |
| 派任务、收结果 | session-channel | `channel_delegate({to: session_id, task, timeoutSec})` → `channel_task status` 轮询；取消用 `channel_task cancel` |
| 看忙闲 | session-channel | `session_channel state` |
| 编组、等级、主从指令 | agent-group | `agent_group add_member({group, name, target: session_id})`，之后 `link` / `send` / `check` |
| 看屏、插话、按键、中断 | herdr-use | `herdr_read` / `herdr_text` / `herdr_key`（同一 `terminal_id`）；中断忙碌回合用 `herdr_key({keys:["ctrl+c"]})` |
| 列终端、确认残留 | herdr-use | `herdr_list`（逐条带 `foreground` / `registered`） |
| 只清终端、不留记录 | herdr-use | `herdr_close({terminal_id})` |
| 停止并清理 | coagent | `coagent close({coagent_id})`；失败时 `force: true` |

边界（避免模型误用）：

- `coagent` **不接受** `text` / `task` / `target` 参数——给 `spawn` 传这些得 `invalid_params`，并提示用 `channel_delegate`。
- `close` 是**整会话收尾**，不是取消一条任务；取消单条任务用 `channel_task cancel`，中断当前回合用 `herdr_key`。
- `session_id` 唯一来源是 `spawn` 回执与 `list`；不要用 `cwd:` 寻址猜会话（同 cwd 多会话必然歧义）。

## 前置条件

1. **herdr-use** 带共用服务面（`ctx.get("herdrUse")`，十工具版本）；本包不自建终端、不调 herdr CLI。
2. **session-channel** 至少挂在本进程（认领要读 `peers`）；子会话所在 profile 也必须有它，否则新会话不上线、认领必然超时。
3. 终端的登录 shell 会加载 `fffdsh`，且 shell 环境里已导出 `*_API_KEY`（`fffdsh` 的前置检查）。缺任一条都会在屏上报错，本包按屏文本判 `launch_failed`。
4. 子会话沿用主会话 profile 与 `DSH_HOME`（`fffdsh` 的缺省行为）。coagent **不承诺隔离**：子会话拿到同一套凭据与工具面。

## 依赖与降级

| 服务 | 姿态 | 缺席时 |
| --- | --- | --- |
| `herdrUse` | 硬前置（注册期判定） | 不注册工具 + 告警一次；不降级到 herdr-use 库面 |
| `sessionChannel` | 硬前置（注册期判定） | 同上（认领必需） |
| `sessionPaths` | 可选 | 记录降级到 `$DSH_HOME/coagent/<会话 id>/` + 告警一次 |

三个服务都不写进 `inject`（只声明注册面 `tools`），由 `ctx.get` 读取。调用期服务消失时返回 `herdr_unavailable` / `session_unavailable`。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 显式 `false` 关闭（不注册工具） |
| `maxLive` | `4` | 同会话并行上限：`starting` / `ready` / `closing` 计入；超限 `limit_exceeded`，不排队 |
| `maxRecords` | `50` | 记录条数上限；超出删最老的终态目录，索引留墓碑 |
| `claimTimeoutSec` | `180` | 认领新会话的上限（`fffdsh` 首次可能触发构建） |
| `pollIntervalMs` | `1000` | 认领轮询与取屏间隔 |
| `graceSec` | `15` | `close` 的优雅退出等待上限 |
| `gracePollMs` | `250` | `close` 的探活轮询间隔 |
| `staleAfterSec` | `21600` | 非终态记录久未推进 → `list` 标 `stale`（只标记，不自动杀） |

## 状态与落盘

状态：`starting` → `ready` → `closing` → `closed`；另有 `failed`（拉起阶段失败）与 `lost`（认领超时 / 终端消失）。

目录：`sessionPaths.sessionDirFor(父会话 id)/coagent/`（缺 `sessionPaths` 时降级到 `$DSH_HOME/coagent/<父会话 id>/`）：

- `index.json`：索引（`{version:1, records:{...}}`，tmp + rename 原子写，目录 0700）；
- `<coagent_id>/meta.json`：记录快照（`terminal_id` / `session_id` / 时间线 / 失败码 / 回滚标记）；
- `<coagent_id>/claim.log`：认领轮询摘要；
- `<coagent_id>/screen.log`：失败时的屏摘要。

清理：`close` 的 `keep=false`（缺省）删记录目录，索引留墓碑；`maxRecords` 超出时同样只删目录、留墓碑。父进程正常退出时把非 `closed` 记录标 `closed(reason=parent-exit)`（终端的关闭由 herdr-use 的退出清理负责）。

## 错误码

| 类别 | 码 |
| --- | --- |
| 参数 / 环境 | `invalid_action` / `invalid_params` / `session_unavailable` / `session_paths_unavailable` / `herdr_unavailable` |
| 前置 | `cwd_invalid` / `limit_exceeded` / `not_found` |
| 拉起 | `terminal_create_failed` / `launch_forbidden` / `launch_failed` / `claim_timeout` / `record_write_failed` |
| 收尾 | `close_failed` |

失败回执统一 `{ok:false, error, reason, next?}`：`error` 稳定码、`reason` 给人看、`next` 给下一步。

## 明确不做

- 不自建终端、不起进程、不调 herdr CLI、不 import 任何 `@dsh-toolset/*` 包（只消费服务面）。
- 不做一次性任务（无 `mode`、无 NDJSON、无退出码文件）。
- 不实现 `send` / `wait` / `cancel` / `read`，不转发对话内容，不解析任务结果。
- 不写 agent-group 状态、不做等级。
- 不参数化 profile / `DSH_HOME` / 凭据；不允许任何脱管手段（`nohup` / `setsid` / `&` / `disown` / `bg` / `screen` / `tmux` 一律拒），不使用 `foreground: false` 的后台 lane。
- 不做 TUI 面板、不做真机 CI。

## 验证

```sh
cd coagent
npm run check   # tsc --noEmit（含 tests）
npm test        # node --test：T1-T13（fake herdrUse + fake sessionChannel + 假时钟）
npm run build
```

真机脚本（人工跑，不进 CI）：

```sh
cd coagent
npm run verify              # 拉起 → 认领 → 交接提示 → 收尾 → 残留核对
npm run verify -- --negative  # 追加 cwd 非法与 target 参数被拒两项
```

**诚实边界**：单测全部由 fake 服务面驱动；herdr-use 服务面落地前，`create` / `run` / `read` / `info` / `close` 的真实回执形状未在真机核对，`fffdsh` 拉起 / 认领 / 交接链路也未在真实 herdr 上跑过。
