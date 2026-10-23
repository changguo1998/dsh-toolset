# coagent 设计

本文件记录 `coagent` 的机制：状态机、证据优先级、认领算法、前台约束的守门点、落盘与已知限制。
产品契约（工具参数、回执、错误码）见 `README.md`；取舍过程与验收方案见
`docs/implementation/2026-10-22-coagent.md`。

## 定位

一段生命周期里的**两段**：把长驻 dsh 会话拉起来，和把它收掉。

- 拉起：`herdrUse.create`（新终端、前台）→ `herdrUse.run("fffdsh")` → `sessionChannel.peers` 认领。
- 收尾：`herdrUse.run("/quit")` → 等进程退出 → `herdrUse.close(terminal_id)`。

中间的一切不实现：派任务 / 收结果（session-channel）、编排与等级（agent-group）、看屏 / 插话 /
按键（herdr-use 的十个工具）。coagent 不转发对话、不解析结果、不做权限边界。

## 组件

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `main.ts` | 注册期判定服务面、注册工具、退出钩子、配置归一化 | 宿主 `tools` |
| `tools.ts` | 工具 schema 与调用方会话解析 | 动作层 |
| `actions.ts` | `spawn` / `list` / `close`、按 id 串行、异常映射 | 下面全部 |
| `launch.ts` | 命令白名单、脱管痕迹自检、`cwd` 与参数校验 | 无（纯函数 + `stat`） |
| `channel.ts` | `peers` 轮询、匹配、屏文本快速失败 | `sessionChannel` |
| `probe.ts` | 终端存在性 + 前台进程 + `peers` 在线 | `herdrUse` / `sessionChannel` |
| `herdr.ts` | 服务面回执的字段提取与错误归一 | 无 |
| `store.ts` | 索引原子读写、记录目录、配额墓碑 | 文件系统 |
| `types.ts` | 配置 / 记录 / 错误码 / 三个服务面的窄化声明 | 无 |

**不 import 任何 `@dsh-toolset/*` 包**：跨包只走 `ctx.get("herdrUse")` / `ctx.get("sessionChannel")` /
`ctx.get("sessionPaths")`，结构面自声明（先例 `agent-group/src/transport.ts`）。

## 状态机

```
                 create+run 成功
  (无) ─────────────────────────▶ starting ──peers 命中──▶ ready
                                    │                       │
                    屏报错/提交失败 │                       │ list 探测：终端消失 / 掉线且无前台进程
                                    ▼                       ▼
                                 failed                   lost
                                    │                       │
                                    └──────── close ────────┴──▶ closing ──▶ closed
                                                                  │
                                                          close 失败（force 出口）
```

| 状态 | 含义 | 终态 |
| --- | --- | --- |
| `starting` | 终端已建、`fffdsh` 已提交、尚未认领 | 否 |
| `ready` | 已认领 `session_id`，终端有前台进程 | 否 |
| `closing` | 已发 `/quit` 或 `close` 已开始 | 否 |
| `closed` | 终端已关（或本就不存在）+ 记录收尾 | 是 |
| `failed` | 拉起阶段失败；终端已回滚（`terminal_closed` 标是否成功，失败则 `rollback_failed`） | 是 |
| `lost` | 认领超时 / 终端消失 / 掉线且无前台进程；终端可能仍在（F6 故意不关，供排障） | 是 |

`maxLive` 只计 `starting` / `ready` / `closing`。

## 证据优先级

没有退出码可用（herdr 不回报终端内命令的退出码），「起没起来 / 还在不在」按以下顺序判定：

1. **屏文本**：`fffdsh: 环境中缺少 API_KEY` → `launch_failed`；`command not found` → `launch_failed`。
   这是唯一能区分「`fffdsh` 自己失败」与「会话还没上线」的证据，命中也就不必等满认领超时。
2. **`peers` 在线**：`session_id` 在 `peers` 里 = 会话活着。
3. **终端存在性**：`info` 报 `terminal-not-registered` = 终端确实没了；其它错误（herdr 暂时不可用）
   **不改状态**，避免把「连不上」误判成「终端没了」。
4. **时间**：认领超过 `claimTimeoutSec` 判 `lost`；非终态记录超过 `staleAfterSec` 只标 `stale`。

`ready` 与 `lost` 的分界：终端消失 → `lost`；终端在但 `running: false` → 看 `peers`，会话在线则保持
原状态（可能处在上层重启 / 构建间隙），掉线才 `lost`。

## 认领算法

1. 快照已有记录里的 `session_id` 作排除集（`known`）：避免认到同 cwd 的旧会话。
2. 每轮 `peers()`，按以下条件筛：
   - 不在 `known`；
   - `startedAt` 不早于本次提交时刻（容差 5 s；缺失不判）；
   - `profile` 两边都非空时必须相同；`cwd` 两边都非空时必须相同（空串 = 未知，放行）；
   - 多条命中取最早启动的那条。
3. 每轮取屏（`read`，`recent-unwrapped` / 120 行 / 剥色）查失败证据。
4. 到 `claimTimeoutSec` 仍无命中 → `lost`，**不关终端**（屏上可能有排障信息），清理交给 `close`。

为什么必须轮询：session-channel 不做启动枚举、事件无回放，子会话要先产生第一条 `session/event`
才进 `peers`；`fffdsh` 首次启动还可能触发多包构建（分钟级）。

## 前台约束的守门点

| 层 | 手段 |
| --- | --- |
| 命令面 | 提交给终端的命令是常量 `fffdsh`（`LAUNCH_COMMAND`），没有透传入口 |
| 文本自检 | `checkForegroundText` 拒绝 `nohup` / `setsid` / `&` / `disown` / `bg` / `screen` / `tmux`（词边界） |
| 终端落点 | `create` 固定 `foreground: true`，不使用 `foreground: false` 的后台 lane |
| 对象归属 | 只操作 `create` 回执返回的 `terminal_id`，不接受调用方传入 |
| 参数面 | `spawn` 只接受 `cwd` / `label` / `claimTimeoutSec`；`target` / `task` / `text` / `env` 一律 `invalid_params` |

## 落盘

目录 `<父会话目录>/coagent/`（`sessionPaths.sessionDirFor`；缺席降级 `$DSH_HOME/coagent/<会话>`）：

```
coagent/
  index.json          {version:1, records:{<coagent_id>: CoagentRecord}}   0600，tmp+rename
  <coagent_id>/
    meta.json         记录快照（含 terminal_id / 时间线 / 失败码）          0600
    claim.log         认领轮询摘要（每轮一行）
    screen.log        失败时的屏摘要（尾部 800 字符）
```

- 目录 0700；索引写前 `mkdir -p`，写后显式 `chmod 0600`（已存在文件的 mode 不受 `writeFile` 影响）。
- 配额：记录数超过 `maxRecords` 时按 `updated_at` 从旧到新删**终态**记录目录，索引里把记录标
  `pruned: true`（墓碑）。非终态不裁剪（`maxLive` 已挡住并行）。
- `close` 的 `keep=false`（缺省）与配额裁剪都只删目录、留墓碑，`list` 能看到「为什么少了一条」。
- 父进程正常退出：`process.once("exit")` 把非 `closed` 记录标 `closed(reason=parent-exit)`，
  同步写索引与 meta；终端的关闭由 herdr-use 的退出清理按同一份登记表完成。`kill -9` 不跑钩子，
  残留由下次 `list(probe=live)` 判 `lost`。

## 并发与锁

- **`spawn` 进程级排他**：并发拉起会同时写 `$DSH_HOME/profiles`（启动期做删除式操作），也可能
  在认领时抢同一个新会话；故 `spawn` 全程串行。
- **按 `coagent_id` 串行**：同一记录的 `close` / 探测不并发写索引。
- **索引读改写串行**：`FileCoagentStore.update` 内部排队，避免同进程两次写互相覆盖。

## 依赖降级

| 服务 | 姿态 | 缺席行为 |
| --- | --- | --- |
| `herdrUse` | 注册期硬前置 | 不注册工具 + 告警；不降级到 herdr-use 库面（会得到第二份登记表与第二把锁） |
| `sessionChannel` | 注册期硬前置 | 不注册工具 + 告警（认领必需） |
| `sessionPaths` | 可选 | 记录降级到 `$DSH_HOME/coagent/<会话 id>/` + 告警一次 |

调用期服务消失：`herdr_unavailable` / `session_unavailable`；`sessionDirFor` 抛错：
`session_paths_unavailable`；索引读坏 / 写失败：`record_write_failed`。

## 已知限制

- **不隔离**：子会话与父会话同 profile、同 `DSH_HOME`、同凭据库、同工具面。coagent 不是权限边界。
- **依赖 `fffdsh`**：终端登录 shell 必须加载它且导出 `*_API_KEY`，否则 `launch_failed`。
- **认领可能误判**：同 profile + 同 cwd 同时拉起多个会话时，靠「排除已有记录 + 最早启动」降低
  误认，但不能完全消除竞态；`spawn` 的进程级锁把它压到最小。
- **会话标识依赖 session-channel**：子会话所在 profile 没挂 session-channel 时永远认领不到。
- **不做 resume**：`fffdsh` 自己的重启循环（退出码 75）由它处理，coagent 不介入。

## 未验证

- herdr-use 服务面（I 组实现中）的真实回执形状只在 fake 上核对过；`create` 的 `terminal_id` 字段名、
  `close` 对已消失终端的错误码，都要在服务面落地后复核。
- `fffdsh` 真正拉起后的认领时序（构建耗时、`peers` 上线延迟）未在真机测过。
