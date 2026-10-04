# session-channel 设计

## 1. 定位

本机跨会话的消息通道：把「另一个 dsh 会话/进程」的消息投递进目标会话的下一回合。消费面见 `README.md`（`session-channel` 工具 + `session-channel` 服务 + 类型导出）。

已实现：共享 KV 状态同步（#55）、跨会话委托/协调（#54，planner-worker：任务表 + 结果自动/显式回传 + 任务三工具）。

不做（后续条目）：消息历史检索、跨机。

## 2. 架构取舍

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 传输 | **专用 Redis 实例（unix socket）** | 推送、回执、流（`XREAD BLOCK`）原生；专用实例把「共享实例的驱逐 / FLUSHALL / 配置漂移」风险从结构上消掉；系统 Redis 不动 |
| 客户端 | npm `redis`（node-redis） | 重连、分帧、超时、错误分类交给成熟库（自写 RESP 也是候选，见追踪文档的对比） |
| 连接数 | **两条**（main + reader） | `XREAD BLOCK` 会占住连接，不能与常规命令共用 |
| 在线判定 | 在线键 TTL + pid 快检 | 无服务端连接表可用（不用 Redis 的 client list 语义）；pid 快检让「崩溃」比 TTL 更快暴露 |
| 离线策略 | 直接报错 | 语义清晰；不做 spool（离线队列属后续条目） |
| 寻址 | `sessionId` / 别名 / `cwd:<path>` | 覆盖「精确指定」「会话别名」「同项目另一个会话」三类场景 |
| 覆盖面 | 只提升消息通道 | 一次只做一件可验收的事；委托（#54）与共享 KV（#55）另立条目后落地（见 §4.1 / §3） |

## 3. 消息与在线模型（`src/keys.ts` / `src/broker.ts`）

```
dsh:session-channel:inbox:<sessionId>   Stream  投递目标（XADD MAXLEN ~ 1000）
  字段：id / from / fromCwd / text / ts        （id 字段占位，真 id = 流条目 id）
dsh:session-channel:alive:<sessionId>   String  PeerInfo JSON：sessionId/pid/instanceId/cwd/profile/startedAt（TTL 15s）
dsh:session-channel:alias:<alias>        String  sessionId（**无 TTL**：用户意图，不随会话离线过期）
dsh:session-channel:cursor:<sessionId>  String  {"id":"<最后成功注入的流条目 id>","ts":<epoch ms>}（**无 TTL**，7 天懒清理）
dsh:session-channel:ack:<messageId>     String  "injected"（TTL 60s，仅发送方 waitMs 等待窗口）
dsh:session-channel:kv:<key>            String  {"value":…,"version":N,"updatedAt":ms}（共享 KV，可选 TTL；无默认过期）
dsh:session-channel:kvver:<key>         String  单调版本计数（INCR；独立命名空间，`kv:*` 扫描不命中）
dsh:session-channel:task:<id>           String  TaskRecord JSON（TTL 7 天；状态 + 结果 + 触发 seq）
dsh:session-channel:tasks:<sessionId>   List    该会话相关任务 id（LPUSH + LTRIM 0..49，新→旧；委托方与目标两侧都记）
dsh:session-channel:meta                String  schema 版本（不兼容 → 拒绝写入）
```

- **在线 = 在线键存在（TTL 内）且 `process.kill(pid, 0)` 不抛 ESRCH**；形状不符或 pid 已死的残留键由 `listPeers` 懒清理（无额外守护进程）。
- **寻址解析**（`resolveTarget`）：`cwd:<绝对路径>` 前缀 → 按路径匹配；否则**会话 id 精确匹配 → 别名（`alias:<alias>`）**；都不命中返回空，由发送侧报 `target_offline`。别名由 `setAlias` 写入（校验字符集与保留字 → 冲突需 `force` → 顶掉同会话旧别名 → 写入）。
- **游标语义**：投递位置记在**无 TTL** 的 `cursor:<sessionId>`（值 `{id, ts}`）里——接收方跟踪会话或重启时读该键作为读取起点（**读不到才退化为 `0`**：发送方可能先入队、接收方后启动），且**只在注入成功后推进**（失败不推进 → 重启补投）。读取完成前该会话不进 reader 读取集合（`cursorReady` 门），避免「先用 `0` 读一次」的重复窗口面。`start()` 时按 `ts` 懒清理超过 7 天（`CURSOR_TTL_MS`）的游标键。
- **回执**：接收方注入成功才写回执（`ack:<messageId>`，TTL 60s），**只服务发送方 `send` 的 `waitMs` 等待窗口**（100ms 轮询）——**不作为去重依据**（去重靠游标，回执过期不影响去重）。注入失败（会话不在本进程）不写回执，消息留在流里（`inbox` 可查）。
- **共享 KV**（#55）：`kv:<key>` 存 last-value（JSON 可序列化，UTF-8 上限取 `maxTextBytes`），`kvver:<key>` 用 `INCR` 提供**单调版本号**；写入在单条 Lua 脚本内完成「读旧版本 → CAS 校验 → 版本 +1 → SET」，`expectedVersion` 不匹配返回 `kv_conflict` + 当前值（供合并重试）；`ttlSec > 0` 时带过期；`kvDelete` 同时删两个键（版本归零）。键名 `[A-Za-z0-9_.-]{1,64}`。语义：last-value + 版本号，供插件跨会话 / 跨进程同步状态；不做订阅 / 通知（拉取式）。

## 4. 投递管线（`src/index.ts` / `src/inject.ts` / `src/tasks.ts`）

```
session/event ──▶ noteSession（记录 sessionId + header.cwd，上限 32 个，超限淘汰最久未见者）
                 └─▶ announcePresence（首次立即写；此后每 heartbeatMs 刷新）
reader 循环 ──▶ XREAD BLOCK（多流单次读，id = 各流游标；游标未载入的会话不参与）
                 └─▶ setTimeout(0) ──▶ agent.followup(user 消息) + sessions.flush
                                        └─▶ 注入成功后：写投递游标 + 写回执
```

- **时序红线**：`session/event` 监听器运行在 `Session.append` 的同步派发窗口内，直接调 `agent.followup()` 会撞重入保护（消息不落盘）——统一 `setTimeout(…, 0)` 推迟宏任务（rule-engine 已实证）。
- 消息构造硬要求：`id` 非空、`content` 数组、`source.kind` 非空（否则 append/resume 校验抛 `lacks an identified message`）。
- 注入来源 `source.kind = "session-channel"`；TUI 侧 `ruleInjectionTextOf` 白名单（`rule-engine` / `session-channel`）按用户块渲染。

### 4.1 委托任务（#54，planner-worker）

- **建立**：`delegate` 解析目标（同 `send` 寻址，须唯一命中）→ 写任务表（`task:<id>` + 委托方/目标双侧索引 `tasks:<sid>`）→ 经**同一条消息通道**把 `TASK <id>: <正文>` 注入 worker 的下一回合。
- **注入对位**：worker 侧 `user/message` 事件正文匹配 `TASK <id>:` → 记 `status: running` + `triggerSeq`，并入待回收队列；任务终态或不属于该会话则跳过。
- **结果回收两条路**：worker 轮末（`turn/end`）自动回收最后一条 assistant 文本（`resultSource: "auto"`）；worker 也可调 `channel_task_result` 显式回传（`resultSource: "tool"`，优先于 auto，见 `applyTaskPatch`）。两条路都经消息通道把 `RESULT <id>: …`（失败为 `<STATUS> <id>: …`）通知委托方；委托方未指明（`from` 空）则不通知。
- **状态机与超时**：`pending → running → done / failed / canceled / timeout`；超时按**读取时懒判定**（`withTimeoutCheck`，缺省 1800 秒），终态不可回退。结果全文存表 ≤ 64 KB（超出截断并标 `resultTruncated`），通知正文截断到 8 KB。
- **前缀归属**：`taskInjectionText` 只产 `TASK <id>: …`，`[CHANNEL](来源)` 前缀由投递路径（`#deliver`）统一加，避免双前缀。

## 5. 生命周期与降级（`src/client.ts`）

- 启动：连接（`connectTimeout` + 3s 总超时）→ PING → 版本 ≥ 5.0 → `meta` schema 校验（缺失则写入）。
- **任何失败只降级不抛**：插件照常加载，`status` 与工具返回值给出可读错误（`unavailable` / `schema_mismatch` / `bad_config`）。
- 自检失败路径也会关掉已建立的连接（否则句柄残留，进程不退出——测试时实测过）。
- 关闭：清本进程所有在线键 → 断开两条连接（reader 用 `disconnect` 打断阻塞读）。

## 6. 安装与运维（`scripts/setup-redis.sh`）

写 `~/.dsh/session-channel/redis.conf`（`port 0` / unix socket 0700 / 独立 dir / `noeviction` / `appendonly yes`）+ 用户级 unit `dsh-session-channel-redis.service`（`Restart=on-failure`、`WantedBy=default.target`）→ `daemon-reload` + `enable --now` → 等 socket 并 PING 验证。`--linger` 让服务在登出后常驻；`--uninstall` / `--purge` 可逆；`--manual` 供无用户管理器的环境（只写文件）。

已知提示：内核 `vm.overcommit_memory=1` 未开时 Redis 启动日志有 WARNING（本插件用量极小，可忽略；要消除需 root 改 sysctl）。

## 7. DSH 接入面（`src/index.ts`）

`export { name, inject, provide, apply }`：`name = "session-channel"`、`inject = ["tools", "agents", "sessions"]`、`provide = ["sessionChannel"]`。`apply` 内 `createSessionChannelService` + `service.start()`（异步、不阻塞）+ `tools.register` + `provide("sessionChannel", …)`。

服务面方法（键集合由 `SERVICE_FACE_METHODS` 声明，`tests/apply.test.ts` 守卫：新增公开方法漏暴露即测试失败）：`peers` / `send` / `inbox` / `aliasSet` / `aliasList` / `aliasClear` / `kvSet` / `kvGet` / `kvList` / `kvDelete` / `delegate` / `taskStatus` / `taskList` / `taskCancel` / `taskResult` / `status`；`start` / `stop` / `noteSession` 为宿主生命周期 / 内部面，不暴露。

工具 `session_channel` 动作：`peers` / `send` / `inbox` / `alias`（`op=set|list|clear`，`name`=别名，`to` 缺省为调用方会话，`force` 覆盖占用）/ `status`。`execute(args, exec)` 从宿主 `exec.agent.session.id` 取调用方会话（非 agent 调用方 → 须显式传 `to`）。

任务三工具（planner-worker）：`channel_delegate`（`to` / `task` / `timeoutSec?` / `waitMs?`）、`channel_task`（`action=status|list|cancel`；`list` 的 `sessionId` 缺省 = 调用方会话，`limit` 上限 100）、`channel_task_result`（`taskId` / `text` / `failed?` / `error?`）。

## 8. 约束与已知边界

- 仅本机；Redis 必须 ≥ 5.0（Streams）。
- 邮箱流按 `MAXLEN ~ 1000` 近似裁剪：极端量下早期消息会被裁掉（无持久归档）。
- 会话跟踪上限 32（TUI 单活跃场景远超需求）；`session/event` 未覆盖的会话（如从未产生事件）不会被跟踪。
- 本进程内多会话同时在线时，各会话独立邮箱流与游标；一个进程只有一个 reader 连接（多流单次读）。
- 游标键随会话累计且无 TTL：由 `start()` 懒清理（`ts` 超 7 天）；被清理后该会话若再来，会从邮箱流起点重读，历史消息可能重投（可接受：宁可重投不漏投）。
- 依赖 `redis` 包（首个带外部运行时依赖的包）：`node_modules` 不入库，新机器需 `npm install --prefix session-channel`（`scripts/install.sh` 已含该步）。

## 9. 明确不做

跨机传输、离线队列 / spool（目标离线只报 `target_offline`；任务结果通知也留在流里）、消息内容过滤/审批闸门（注入即用户消息，信任边界 = 本机同用户）、限流、历史检索与归档；KV 不做订阅 / 通知 / 跨机，也不承担任务语义（任务走 `task:` 表）。后续条目见 `docs/BACKLOG.md`。
