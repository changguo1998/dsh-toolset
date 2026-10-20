# @dsh-toolset/session-channel

DSH 进程内插件：**本机跨会话消息通道**——把消息从一个 dsh 会话（或另一个 dsh 进程）投递到目标会话的下一回合，并回执。

## 能力

注册 4 个工具：`session_channel`（会话 / 通道运维）、`channel_delegate` / `channel_task` / `channel_task_result`（委托任务，planner-worker）。

| 入口 | 参数 | 说明 |
| --- | --- | --- |
| `session_channel` `peers` | — | 列在线会话（sessionId / pid / cwd / profile / 启动时刻） |
| `session_channel` `send` | `to`, `text`, `waitMs?` | 发消息：`to` = 会话 id、别名或 `cwd:<绝对路径>`；正文注入目标会话（形如 `[CHANNEL](来源) 正文`，来源 = 发送方别名，无别名时用会话 id） |
| `session_channel` `inbox` | `sessionId`, `count?` | 查某会话最近收到的消息（只读，新→旧，缺省 20 条） |
| `session_channel` `state` | `sessionId` | 查某会话的 agent 忙闲状态（`state` = `{status: idle\|running, at}`，`at` 为最近转换时刻；无牌时 `state` 缺省） |
| `session_channel` `alias` | `op` = `set`/`list`/`clear`, `name?`, `to?`, `force?` | 别名管理：`set` 设别名（`to` 缺省 = 调用方会话，`force` 覆盖他人占用）、`list` 列别名（带在线标记）、`clear` 清别名（传 `name` 按别名、传 `to` 按会话） |
| `session_channel` `status` | — | 连接状态、服务端版本、已跟踪会话、错误信息、自动别名计数（`aliasesAuto` / `aliasesFailed`） |
| `channel_delegate` | `to`, `task`, `timeoutSec?`, `waitMs?` | 把任务委托给另一个会话执行（planner-worker）；返回任务记录（`task.id`），结果自动 / 显式回传 |
| `channel_task` | `action` = `status`/`list`/`cancel`, `taskId?`, `sessionId?`, `status?`, `limit?` | 任务管理：查状态 / 列任务（`sessionId` 缺省 = 调用方会话）/ 取消 |
| `channel_task_result` | `taskId`, `text`, `failed?`, `error?` | worker 侧显式回传结果（优先于轮末自动回收） |

服务面：`ctx.get("sessionChannel")`，17 个方法，逐方法签名与返回见下「服务面契约」。

接收侧：注入消息带 `source.kind:"session-channel"`，TUI 按**用户输入块**显示（与 `[RULE]` / `[AUTO]` 同通道）；历史恢复后仍在。

## 前置：专用 Redis 实例

插件用**专用** Redis 实例（unix socket），不占用系统 Redis（也不碰它的配置）：

```sh
cd <repo> && sh session-channel/scripts/setup-redis.sh --linger
# 幂等；--uninstall 卸载（--purge 连数据）；--manual 只写文件不调 systemctl；--dry-run 只打印
```

脚本写入 `~/.dsh/session-channel/redis.conf`（`port 0` + `$XDG_RUNTIME_DIR/dsh-session-channel.sock`、独立数据目录、`noeviction`、`appendonly yes`）与用户级服务 `~/.config/systemd/user/dsh-session-channel-redis.service`，并 `enable --now`。验证：`redis-cli -s "$XDG_RUNTIME_DIR/dsh-session-channel.sock" ping` → `PONG`。

**连接失败不阻塞启动**：首连失败只降级（`status.error` 记最后一次错误），并按 `RETRY_DELAY_MS`（2 s）后台重试到连上为止——连上后补齐心跳 / 读循环并清 `error`（`stop()` 终止重试）。故 Redis 晚起或启动期事件循环被占住导致的「假超时」都会在数秒内自愈。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `url` | `$DSH_SESSION_CHANNEL_REDIS_URL` → `$XDG_RUNTIME_DIR/dsh-session-channel.sock` | `redis://…` URL 或 unix socket 路径 |
| `heartbeatMs` | `5000` | 心跳间隔（刷新在线键 + 给 agent 状态牌续期 TTL） |
| `presenceTtlSec` | `15` | 在线键 TTL（应大于心跳间隔）；也是 agent 状态牌 TTL 的缺省 |
| `agentStatus` | `true` | 是否发布 agent 状态牌（`state:<sessionId>`；`false` = 关发布） |
| `agentStateTtlSec` | 同 `presenceTtlSec` | agent 状态牌 TTL（心跳只续 TTL、绝不刷新 `at`） |
| `maxTextBytes` | `8192` | 单条正文上限（UTF-8 字节） |
| `prefix` | `"[CHANNEL]"` | 注入正文前缀（正文 = `<prefix>(<来源>) <正文>`） |
| `readBlockMs` | `15000` | 阻塞读单次等待上限 |
| `instanceId` / `profile` | 随机 / `$DSH_PROFILE` | 在线元数据（排障用） |
| `disabled` | `false` | `true` = 只加载不连接 |

键位（全部 `dsh:session-channel:` 前缀）共 11 个：`inbox:<sessionId>` / `alive:<sessionId>` / `state:<sessionId>` / `cursor:<sessionId>` / `alias:<alias>` / `ack:<messageId>` / `kv:<key>` / `kvver:<key>` / `task:<id>` / `tasks:<sessionId>` / `meta`——逐键类型（Stream / String / List）、TTL 与语义见 `docs/DESIGN.md` §3。

### 服务面契约（逐方法签名与返回）

**返回约定**：所有方法返回**普通对象**，`ok` 表示成败；可选字段**缺失即不存在**，
不会出现值为 `undefined` 的键（工具出口另有同口径归一 `pruneUndefined`，见
「边界与限制」的 `INVALID_TOOL_OUTPUT` 一条）。

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `peers()` | — | `{ok, peers?: PeerInfo[], error?}`；`PeerInfo` = `{sessionId, pid, instanceId, cwd, profile, startedAt}` |
| `statusOf(sessionId)` | — | `{ok, state?: AgentState, error?}`；`AgentState` = `{status: idle\|running, at}`；无牌 / 形状不符 → 只有 `ok:true` |
| `status()` | — | `SessionChannelStatus` = `{enabled, connected, address, version, sessions, aliasesAuto, aliasesFailed, aliasesLastError?, error?}` |
| `send(req)` | `{to, text, from?, waitMs?}` | `{ok, messageId?, delivered?, target?, error?, candidates?}`；`delivered` **只在 `waitMs > 0` 时出现** |
| `inbox(sessionId, count?)` | — | `{ok, messages?: InboxMessage[], error?}`；`InboxMessage` = `{id, from, fromCwd, text, ts}`，新→旧，缺省 20 条 |
| `aliasSet(alias, sessionId, opts?)` | `opts = {force?}` | `{ok, alias?, sessionId?, replaced?, error?, message?, holder?}`；冲突 → `error:"alias_taken"` + `holder`；改别名时 `replaced` 给被顶掉的自身旧名 |
| `aliasList()` | — | `{ok, aliases?: Array<{alias, sessionId, online}>, error?}` |
| `aliasClear(opts)` | `{alias?, sessionId?}` | `{ok, cleared?: string[], error?}` |
| `kvSet(key, value, opts?)` | `opts = {expectedVersion?, ttlSec?}` | `{ok, entry?, current?, error?, message?}`（版本号在 `entry.version`）；CAS 冲突 → `error:"kv_conflict"` + `current` |
| `kvGet(key)` | — | `{ok, entry?: KvEntry, error?, message?}`；`KvEntry` = `{key, value, version, updatedAt}`；不存在时只有 `ok:true` |
| `kvList()` | — | `{ok, entries?: KvEntry[], error?}`（按键名排序） |
| `kvDelete(key)` | — | `{ok, deleted?: boolean, error?, message?}` |
| `delegate(req)` | `{from?, to, text, timeoutSec?, ttlSec?, waitMs?}` | `{ok, task?, messageId?, delivered?, target?, error?, message?, candidates?}`；`task.id` 即指令 id |
| `taskStatus(taskId)` | — | `{ok, task?: TaskRecord, error?}`；**读取时懒判定超时**并通知委托方 |
| `taskList(opts?)` | `{sessionId?, status?, limit?}` | `{ok, tasks?: TaskRecord[], error?}`（新→旧，缺省按会话索引、20 条） |
| `taskCancel(taskId)` | — | `{ok, task?: TaskRecord, error?}` |
| `taskResult(input)` | `{taskId, text, failed?, error?}` | `{ok, task?, error?, message?}`；`resultSource:"tool"` 优先于轮末自动回收 |

`TaskRecord`（`src/types.ts`）字段：`id` / `from` / `to` / `text` / `createdAt` / `updatedAt` /
`status`（`pending` / `running` / `done` / `failed` / `canceled` / `timeout`）/ `triggerSeq?` /
`messageId?` / `result?` / `resultSource?`（`tool` / `auto`）/ `resultTruncated?` / `error?` / `deadline?`。

`SessionChannelStatus` 的两个可选键（`aliasesLastError` / `error`）**按需拼装**：
无值时不出现（不是 `undefined`）。

## 群组编排用法与成员寻址口径

群组编排插件（`agent-group`）只经服务面做两个操作，各自对应的现有方法（无缺口，均为既有签名）：

| 操作 | 方法 | 要点 |
| --- | --- | --- |
| 投递指令 | `delegate({from?, to, text, timeoutSec?, ttlSec?, waitMs?})` | 返回的 `task.id` 即指令 id；worker 下一回合被注入 `TASK <id>: <正文>`（完成后可结束本轮自动回传，或调 `channel_task_result` 显式回传） |
| 收取回报 | `taskStatus(taskId)` / `taskList({sessionId?, status?, limit?})` | 主方按指令 id 读；`taskStatus` 读取时懒判定超时；批量按会话索引（新→旧） |
| 读成员忙闲 | `statusOf(sessionId)` | agent 状态牌（跨进程只读）；成员忙闲四态判定（离线 / 待机 / 工作 / 疑似卡死）由消费方按 `alive` + `state` 现算 |

口径（下游按此实现）：

- **「成功 / 失败 / 受阻」三态不进 `TaskStatus`**：通道只搬运，不规定语义。`failed` 位只表达「是否算失败」，成因走 `error`；三态判别由 `agent-group` 在**结果正文**里自描述（通道不解析正文）。
- **两条硬约束**：① 从方（worker）会话必须**也挂着本插件**——注入由目标进程自己的 reader 循环完成；② 目标必须**在线**，离线直接 `target_offline`、**不排队**（无 spool）。
- **成员登记用 sessionId 或显式 `alias set`**：自动别名不保证分配成功（生成时机见下方「边界与限制」的别名条），登记不要依赖它。
- **寻址须唯一命中**：`to` 取会话 id 精确匹配 → 别名 → `cwd:<绝对路径>`；0 命中 `target_offline`、多命中 `target_ambiguous`（回带 `candidates`）。同 cwd 有多个会话时 `cwd:` 形态必然歧义，改用会话 id 或别名。

## 使用示例

```jsonc
// 1) 看谁在线
{ "action": "peers" }
// 2) 给当前会话起别名（to 缺省即调用方会话）
{ "action": "alias", "op": "set", "name": "docs" }
// 3) 发消息（to 支持会话 id / 别名 / cwd:<绝对路径>；等回执 3 秒）
{ "action": "send", "to": "docs", "text": "构建完成，可以继续了", "waitMs": 3000 }
// 4) 查别名清单 / 查收件箱
{ "action": "alias", "op": "list" }
{ "action": "inbox", "sessionId": "<sessionId>", "count": 10 }
```

profile 挂载（与其他插件同法）：

```yaml
- insert:
    - id: session-channel
      name: '@dsh-toolset/session-channel'
```

## 边界与限制

- **仅本机**：unix socket + 文件权限（0700）；不跨机（跨机需换 store/网络后端，属后续条目）；**离线直接报错**（目标心跳过期或 pid 已死 → `target_offline`，不做 spool / 离线队列）；**不做限流**（本地单用户场景；单条正文上限 8 KB）；**范围外**（后续条目）：消息历史检索。
- **不重复注入**：投递位置记在无 TTL 的 `cursor:<sessionId>`，**只在该条注入成功后推进**——已投递过的消息（即便回执键早已过期）不会重复注入，注入失败的消息仍会补投；游标的读写起点、`cursorReady` 门与 7 天懒清理见 `docs/DESIGN.md` §3 的游标条。消息本身留在邮箱流里（`inbox` 可查）。
- **别名**：`[A-Za-z0-9_-]{1,32}`，保留字（`inbox/alive/ack/cursor/alias/meta/peers/send/status`）不可用；一会话一别名（设新的顶掉旧的）；被别的会话占用需 `force`；别名键无 TTL，`alias clear` 手工清理。
- **自动别名**（2026-10-17 起）：`<前缀><词>-<4 位 hex>`，前缀 `ui-`（用户启动）/ `sub-`（子代理），词与后缀同出自 `sha256(sessionId)` → **同一会话恒得同名**（resume 复用 sessionId，恢复后不漂移）；分配失败不静默，计入 `status()` 的 `aliasesFailed` / `aliasesLastError`（成功计 `aliasesAuto`）。命名、生成时机、碰撞重试与旧格式见 `docs/DESIGN.md` §3.1；占用冲突耗尽后不保证一定拿到别名，成员登记勿依赖（用 sessionId 或显式 `alias set`）。
- **共享 KV**（#55）：`kvSet` / `kvGet` / `kvList` / `kvDelete`，last-value + 单调版本号（CAS 用 `expectedVersion`），键 `[A-Za-z0-9_.-]{1,64}`、值 JSON 可序列化且 ≤ `maxTextBytes`；**拉取式**（无订阅 / 通知）、仅本机共享；写入脚本与 TTL 语义见 `docs/DESIGN.md` §3。
- **工具返回体必须是 lossless JSON**：值为 `undefined` 的键会被宿主判为非法（`ToolOutputError`，code `INVALID_TOOL_OUTPUT`；`JSON.stringify` 会丢键但校验在序列化之前）——四个工具与服务面返回值都经 `pruneUndefined`，细节见 `docs/DESIGN.md` §7。
- **委托任务**（#54，planner-worker 语义）：`delegate` 建任务表记录（`task:<id>`，TTL 7 天）并把任务以 `TASK <id>: <正文>` 注入 worker 会话的下一回合；worker 本轮结束（`turn/end`）时**自动回收**最终回答，也可调 `channel_task_result` **显式回传**（`resultSource:"tool"` 优先于 `auto`）；结果全文 ≤ 64 KB（超出截断并标注）、回传给委托方的通知正文截断到 8 KB；状态机 `pending → running → done / failed / canceled / timeout`（超时按**读取时懒判定**，缺省 1800 秒），终态不可回退；委托方 / 目标离线时通知留在流里（任务表仍可查）。细节见 `docs/DESIGN.md` §4.1。
- **agent 状态牌**（BACKLOG #1）：发布端订阅根 `ctx.on('agent/status')`（宿主 `AgentStatus` 仅 `idle` / `running`）与 `agent/created`（读 `agent.status` 作初始态），按 `agent.session.id` 写 `state:<sessionId>` = `{status, at}`；**`at` 只由状态转换事件写，心跳（5 s）只续 TTL、绝不刷新 `at`**（否则「running 且 `at` 超阈值 = 疑似卡死」判不了）；`agent/disposed`（代理离开注册表）/ `stop()` 删牌，崩溃靠 TTL 兜底；牌 TTL 缺省同 `presenceTtlSec`（15 s，`agentStateTtlSec` 可覆盖）。读数面 = `statusOf(sessionId)` 服务方法 + `session_channel` 工具 `action=state`；**卡死判定不依赖目标应答、无模型推理**：跨进程旁观者按「alive 过期 = 离线、`idle` = 待机、`running` 且 `at` 新 = 工作、`running` 且 `at` 超阈值 = 疑似卡死」只读判定（阈值由消费方配）。细节见 `docs/DESIGN.md` §3.2。
- 注入即「用户消息」：会开新回合、模型可能据此调用工具——发消息方须是可信会话（本机同用户）。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # tsc → dist/
npm run test    # node --test（无 redis-server 的机器上集成用例自动 skip）
```

设计决策见 `docs/DESIGN.md`；缺陷与待办见 `docs/BACKLOG.md`。
