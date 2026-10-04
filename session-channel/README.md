# @dsh-toolset/session-channel

DSH 进程内插件：**本机跨会话消息通道**——把消息从一个 dsh 会话（或另一个 dsh 进程）投递到目标会话的下一回合，并回执。

## 能力

注册 4 个工具：`session_channel`（会话 / 通道运维）、`channel_delegate` / `channel_task` / `channel_task_result`（委托任务，planner-worker）。

| 入口 | 参数 | 说明 |
| --- | --- | --- |
| `session_channel` `peers` | — | 列在线会话（sessionId / pid / cwd / profile / 启动时刻） |
| `session_channel` `send` | `to`, `text`, `waitMs?` | 发消息：`to` = 会话 id、别名或 `cwd:<绝对路径>`；正文注入目标会话（形如 `[CHANNEL](来源) 正文`，来源 = 发送方别名，无别名时用会话 id） |
| `session_channel` `inbox` | `sessionId`, `count?` | 查某会话最近收到的消息（只读，新→旧，缺省 20 条） |
| `session_channel` `alias` | `op` = `set`/`list`/`clear`, `name?`, `to?`, `force?` | 别名管理：`set` 设别名（`to` 缺省 = 调用方会话，`force` 覆盖他人占用）、`list` 列别名（带在线标记）、`clear` 清别名（传 `name` 按别名、传 `to` 按会话） |
| `session_channel` `status` | — | 连接状态、服务端版本、已跟踪会话、错误信息 |
| `channel_delegate` | `to`, `task`, `timeoutSec?`, `waitMs?` | 把任务委托给另一个会话执行（planner-worker）；返回任务记录（`task.id`），结果自动 / 显式回传 |
| `channel_task` | `action` = `status`/`list`/`cancel`, `taskId?`, `sessionId?`, `status?`, `limit?` | 任务管理：查状态 / 列任务（`sessionId` 缺省 = 调用方会话）/ 取消 |
| `channel_task_result` | `taskId`, `text`, `failed?`, `error?` | worker 侧显式回传结果（优先于轮末自动回收） |

服务面：`ctx.get("sessionChannel")` → `{ peers, send, inbox, aliasSet, aliasList, aliasClear, kvSet, kvGet, kvList, kvDelete, delegate, taskStatus, taskList, taskCancel, taskResult, status }`（供 TUI / 其他插件调用；方法与语义见「键位」后的服务面表）。

接收侧：注入消息带 `source.kind:"session-channel"`，TUI 按**用户输入块**显示（与 `[RULE]` / `[AUTO]` 同通道）；历史恢复后仍在。

## 前置：专用 Redis 实例

插件用**专用** Redis 实例（unix socket），不占用系统 Redis（也不碰它的配置）：

```sh
cd <repo> && sh session-channel/scripts/setup-redis.sh --linger
# 幂等；--uninstall 卸载（--purge 连数据）；--manual 只写文件不调 systemctl；--dry-run 只打印
```

脚本写入 `~/.dsh/session-channel/redis.conf`（`port 0` + `$XDG_RUNTIME_DIR/dsh-session-channel.sock`、独立数据目录、`noeviction`、`appendonly yes`）与用户级服务 `~/.config/systemd/user/dsh-session-channel-redis.service`，并 `enable --now`。验证：`redis-cli -s "$XDG_RUNTIME_DIR/dsh-session-channel.sock" ping` → `PONG`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `url` | `$DSH_SESSION_CHANNEL_REDIS_URL` → `$XDG_RUNTIME_DIR/dsh-session-channel.sock` | `redis://…` URL 或 unix socket 路径 |
| `heartbeatMs` | `5000` | 心跳间隔（刷新在线键） |
| `presenceTtlSec` | `15` | 在线键 TTL（应大于心跳间隔） |
| `maxTextBytes` | `8192` | 单条正文上限（UTF-8 字节） |
| `prefix` | `"[CHANNEL]"` | 注入正文前缀（正文 = `<prefix>(<来源>) <正文>`） |
| `readBlockMs` | `15000` | 阻塞读单次等待上限 |
| `instanceId` / `profile` | 随机 / `$DSH_PROFILE` | 在线元数据（排障用） |
| `disabled` | `false` | `true` = 只加载不连接 |

键位（全部 `dsh:session-channel:` 前缀）：

| 键 | 用途 |
| --- | --- |
| `inbox:<sessionId>` | 邮箱流（`XADD MAXLEN ~ 1000`） |
| `alive:<sessionId>` | 在线键（PeerInfo JSON，TTL） |
| `cursor:<sessionId>` | 投递游标（`{"id":"<最后成功注入的流条目 id>","ts":<ms>}`，**无 TTL**，7 天懒清理） |
| `alias:<alias>` | 别名 → `sessionId`（**无 TTL**；`alias set/list/clear` 管理，不随会话离线过期） |
| `ack:<messageId>` | 回执键（`"injected"`，TTL 60s；只服务发送方 `waitMs` 等待窗口） |
| `kv:<key>` | 共享 KV 条目（`{"value":…,"version":N,"updatedAt":ms}`；可选 TTL，无默认过期） |
| `kvver:<key>` | 共享 KV 版本计数（`INCR` 单调；独立命名空间，`kv:*` 扫描不命中） |
| `task:<id>` | 委托任务记录（`TaskRecord` JSON，TTL 7 天；状态 + 结果 + 触发 seq） |
| `tasks:<sessionId>` | 每会话任务索引（`LPUSH` + `LTRIM 0..49`，新→旧；委托方与目标两侧都记） |
| `meta` | 命名空间 schema 版本（不兼容时拒绝写入） |

服务面（`ctx.get("sessionChannel")`，供 TUI / 其他插件调用）：

| 方法 | 说明 |
| --- | --- |
| `peers()` / `status()` | 在线对端 / 连接状态（只读） |
| `send(req)` / `inbox(sessionId, count?)` | 发消息 / 查收件箱（同工具语义） |
| `aliasSet(alias, sessionId, opts?)` / `aliasList()` / `aliasClear(opts)` | 别名管理 |
| `kvSet(key, value, opts?)` | 共享 KV 写入（last-value + 版本号；`{expectedVersion, ttlSec}` 可选，CAS 冲突 → `kv_conflict` + `current`） |
| `kvGet(key)` / `kvList()` / `kvDelete(key)` | 共享 KV 读单键 / 列全量（按键名排序）/ 删除（payload + 版本键） |
| `delegate(req)` | 委托任务（`{from?, to, text, timeoutSec?, ttlSec?, waitMs?}`）；目标唯一命中后建任务表记录并把任务注入 worker |
| `taskStatus(taskId)` / `taskList(opts?)` / `taskCancel(taskId)` | 查单个任务（懒判定超时）/ 列任务（`{sessionId?, status?, limit?}`，缺省按会话索引）/ 取消 |
| `taskResult(input)` | 显式回传结果（`{taskId, text, failed?, error?}`；`resultSource:"tool"` 优先于自动回收） |

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

- **仅本机**：unix socket + 文件权限（0700）；不跨机（跨机需换 store/网络后端，属后续条目）。
- **离线直接报错**：目标心跳过期或 pid 已死 → `target_offline`（不做 spool / 离线队列）。
- **不重复注入**：投递位置记在无 TTL 的 `cursor:<sessionId>` 里——接收方启动/重启从游标续读，**且只在该条注入成功后推进**；已投递过的消息（即便回执键早已过期）不会重复注入，注入失败的消息仍会补投。游标按 `ts` 懒清理（7 天），过期后该会话重来会从流起点重读（历史消息可能重投）。消息本身留在邮箱流里（`inbox` 可查）。
- **别名**：`[A-Za-z0-9_-]{1,32}`，保留字（`inbox/alive/ack/cursor/alias/meta/peers/send/status`）不可用；一会话一别名（设新的顶掉旧的）；被别的会话占用需 `force`；别名键无 TTL，`alias clear` 手工清理。
- **共享 KV**（#55）：`kvSet` / `kvGet` / `kvList` / `kvDelete`，last-value + 单调版本号（CAS 用 `expectedVersion`），键 `[A-Za-z0-9_.-]{1,64}`、值 JSON 可序列化且 ≤ `maxTextBytes`；**拉取式**（无订阅 / 通知）、仅本机共享。
- **不做限流**：本地单用户场景；单条正文上限 8 KB。
- **委托任务**（#54，planner-worker 语义）：`delegate` 建任务表记录（`task:<id>`，TTL 7 天）并把任务以
  `TASK <id>: <正文>` 注入 worker 会话的下一回合；worker 本轮结束（`turn/end`）时**自动回收**最终回答
  作为结果，worker 也可调 `channel_task_result` **显式回传**（`resultSource:"tool"` 优先于 `auto`）；
  结果全文 ≤ 64 KB（超出截断并标注），回传给委托方的通知正文截断到 8 KB；状态机
  `pending → running → done / failed / canceled / timeout`（超时按**读取时懒判定**，缺省 1800 秒）；
  终态不可回退；委托方 / 目标离线时通知留在流里（任务表仍可查）。
- **范围外**（后续条目）：消息历史检索。
- 注入即「用户消息」：会开新回合、模型可能据此调用工具——发消息方须是可信会话（本机同用户）。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # tsc → dist/
npm run test    # node --test（47 例；无 redis-server 的机器上集成用例自动 skip）
```

设计决策见 `docs/DESIGN.md`；缺陷与待办见 `docs/BACKLOG.md`。
