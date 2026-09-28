# @dsh-toolset/session-channel

DSH 进程内插件：**本机跨会话消息通道**——把消息从一个 dsh 会话（或另一个 dsh 进程）投递到目标会话的下一回合，并回执。

## 能力

| action | 参数 | 说明 |
| --- | --- | --- |
| `peers` | — | 列在线会话（sessionId / pid / cwd / profile / 启动时刻） |
| `send` | `to`, `text`, `waitMs?` | 发消息：`to` = 会话 id 或 `cwd:<绝对路径>`；正文注入目标会话（前缀 `[CHANNEL] `） |
| `inbox` | `sessionId`, `count?` | 查某会话最近收到的消息（只读，新→旧，缺省 20 条） |
| `status` | — | 连接状态、服务端版本、已跟踪会话、错误信息 |

服务面：`ctx.get("sessionChannel")` → `{ peers, send, inbox, status }`（供 TUI / 其他插件调用）。

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
| `prefix` | `"[CHANNEL] "` | 注入正文前缀 |
| `readBlockMs` | `15000` | 阻塞读单次等待上限 |
| `instanceId` / `profile` | 随机 / `$DSH_PROFILE` | 在线元数据（排障用） |
| `disabled` | `false` | `true` = 只加载不连接 |

键位（全部 `dsh:session-channel:` 前缀）：

| 键 | 用途 |
| --- | --- |
| `inbox:<sessionId>` | 邮箱流（`XADD MAXLEN ~ 1000`） |
| `alive:<sessionId>` | 在线键（PeerInfo JSON，TTL） |
| `ack:<messageId>` | 回执键（`"injected"`，TTL 60s） |
| `meta` | 命名空间 schema 版本（不兼容时拒绝写入） |

## 使用示例

```jsonc
// 1) 看谁在线
{ "action": "peers" }
// 2) 发消息（等回执 3 秒）
{ "action": "send", "to": "cwd:/home/me/proj", "text": "构建完成，可以继续了", "waitMs": 3000 }
// 3) 查收件箱
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
- **不重复注入**：已写回执的消息在接收方重启后被跳过；消息本身留在邮箱流里（`inbox` 可查）。
- **不做限流**：本地单用户场景；单条正文上限 8 KB。
- **范围外**（后续条目）：跨会话委托/协调、扩展状态同步、消息历史检索。
- 注入即「用户消息」：会开新回合、模型可能据此调用工具——发消息方须是可信会话（本机同用户）。

## 测试

```sh
npm run check   # tsc --noEmit
npm run build   # tsc → dist/
npm run test    # node --test（18 例；无 redis-server 的机器上集成用例自动 skip）
```

设计决策见 `docs/DESIGN.md`。
