# session-channel 首连失败后台重试（接取条目：`docs/BACKLOG.md`「session-channel 启动首连失败即整会话降级（假超时），状态栏别名段消失并打 warn」）

状态：实现　　开启：2026-10-08　　关闭：
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

用户报启动警告：`[tui] warn: 会话别名读取失败（状态栏不显示别名段）：Redis 连接失败（unix:/run/user/1000/dsh-session-channel.sock）：连接超时`。目标 = 去掉这条假失败并让通道自愈：① 插件首连失败不再等于整会话降级（后台重试直到连上）；② TUI 不在启动窗口内为此打 warn；③ 若真因是沙箱拒连，日志要留下真实 errno。

跨模块（`session-channel` + `TUI`），条目按规范放项目级。

## 调研

来源：本机实测 + 既有代码，2026-10-08（命令均在会话工作区执行）。

- **Redis 与 socket 健康**：`/run/user/1000/dsh-session-channel.sock` 存在且为 `srwx------`；`redis-cli -s <sock> ping` → `PONG`；`INFO server` → `redis_version:7.0.15`、`uptime_in_seconds:114393`、`process_id:1814`；`INFO clients` → `connected_clients:1`（当时的探测连接）、`maxclients:10000`、`blocked_clients:0`；`INFO stats` → `rejected_connections:0`（服务端从未拒绝过连接）；`client list` 只有探测连接本身。
- **通道长期无人连上**：`--scan --pattern 'dsh:session-channel:alive:*'` → **0 个**；`alias:*` → 215 个（历史别名）；`meta` = `1`。即当前所有 dsh 会话都没连上过通道。
- **插件代码本身没问题**：在子进程直接调用插件编译产物的连接函数 —— `node -e 'require("./dist/src/client.js").connectSessionChannel({}, log)'` → `OK connected in 20 ms; version: 7.0.15`；`redis` 客户端 `6.2.1`，与 `^6.2.1` 依赖一致。
- **失败点是进程内**：本会话（另一个 dsh 进程）调 `session_channel action=status` → `connected:false`、`address:""`、`version:""`、`error:"Redis 连接失败（unix:/run/user/1000/dsh-session-channel.sock）：连接超时"`；文件工具读该 socket 路径返回 `not a regular file`（证明宿主进程**看得见**该路径，非挂载命名空间缺失）。
- **假超时机制已复现**：`connect()` 之后同步阻塞 4 s（模拟启动期占用事件循环），`Promise.race([connect, 3 s 定时器])` → 定时器赢，报 `连接超时`，而 socket 连接在内核层早已完成。机理：libuv 恢复后 timers 阶段先于 pending/poll 阶段的连接完成回调。
- **另一未排除成因**：进程内被沙箱拒连（EACCES）。实测 node-redis 对连不上的 socket 会**无限退避重连**（error 事件 14/68/294/655/1228/2060 ms）、`connect()` **永不 settle** → 同样只能表现为 `连接超时`。故单看这条文案无法区分两者；插件对每次失败的 `main 连接错误：…` 日志走 stderr，在 TUI 里不可见。
- **代码现状**（`session-channel/src/index.ts`）：`start()` 仅一次 `connectSessionChannel`（`client.ts` 外层 `withTimeout(connect, 3000)`，`CONNECT_TIMEOUT_MS = 1500`），失败即 `status.error` + `未连接（降级）` 并 `return`，**此后不再重试**；重试只在 `#readerLoop`（已连上的前提下）。
- **TUI 现状**（`TUI/src/app/index.ts:1153` `maybeRefreshSessionAlias`）：随 `StatusTicker`（5 s）拉 `aliasList()`，首次 `ok:false` 即 `logger('warn: …')`（`aliasWarned` 每进程一次）；别名段随 tick 自动补齐，故 warn 是纯噪音。
- **验证手段**：本机 `redis-server` 可用，`session-channel/tests/helpers.ts` 有 `startTempRedis` / `makeFakeHost` / `waitUntil`，`SessionChannelDeps` 已可注入 `connect`，`package.json` 无 `format` 脚本（用全局 `format`）。

## 决策

- **选项 A（选定）：首连保持 3 s 预算，失败后转后台重试**。`start()` 语义不变（立即返回、失败不抛），重试用 unref 定时器按 `RETRY_DELAY_MS`（2 s）循环到连上或 `stop()`；连上后跑同一套「自检后启动步骤」（抽 `#afterConnect(conn)`），清空 `status.error`，并记一行「重试 N 次后连接成功」。理由：对两种成因都成立——假超时情形下重试在下一次尝试即成功（秒级恢复），沙箱拒连情形下 `status.error` + 插件 stderr 留真实 errno，且不再把一次失败固化为整会话降级。相比「加大超时」（只是降低假失败概率、真宕机时反而拖慢启动）与「启动期不连接、纯懒连」（TUI 首 tick 仍会 warn）更贴合根因。
- **测试时延**：重试间隔通过 `SessionChannelDeps.retryDelayMs`（缺省 `RETRY_DELAY_MS`）注入，回归用例用 10 ms，避免用例白等 2 s。与既有 `deps.now` / `deps.random` 的测试缝风格一致。
- **选项 A2（选定，TUI 侧）：连续失败达阈值才 warn**。`aliasFailStreak` 计数，成功即清零；连续 3 次 tick（约 10-15 s）仍失败才写一次 `warn`。理由：既消掉启动窗口的噪音，又保留「真的长时间读不到别名」的留痕。相比「`status().connected !== true` 就静默」，不依赖服务面新方法、也不会把永久故障变得完全无声。
- **明确不做**：不改连接超时数值、不改 Redis 侧配置（`setup-redis.sh` / systemd 单元）、不改 session-channel 的降级文案与工具面返回、不动 `#readerLoop` 既有重试语义、不在本任务里改 `SessionChannelLike` 类型（不需要新方法）。

## 规划

任务拆分：① 插件后台重试（含 `#afterConnect` 抽取与 `stop()` 终止）；② TUI warn 阈值；③ 回归用例 + 机械验证；④ 收尾（条目完成清理、追踪文档归档、README/DESIGN 回写）。

计划改动文件清单（按顺序）：

1. `docs/BACKLOG.md` —— 项目级条目（进行中 → 完成后清理移除）
1. `docs/implementation/2026-10-08-session-channel-connect-retry.md` —— 本追踪文档
1. `session-channel/src/index.ts` —— 重试循环 + `#afterConnect` + `#stopped` + `deps.retryDelayMs` + unref 等待
1. `TUI/src/app/index.ts` —— 别名读取失败阈值（`aliasFailStreak` + 常量）
1. `session-channel/tests/service.test.ts` —— 回归用例（首连失败 → 重试 → 连上、`error` 清空、通道可用）
1. 关闭后按需回写：`session-channel/README.md`（连接失败语义由「一次失败即降级」改为「转后台重试」）、`session-channel/docs/DESIGN.md`（若其连接时序一节需同步）、`TUI/docs/DESIGN.md`（若 TUI#48 一节口径需同步）

明确不做：见「决策」末条。

## 实现记录

2026-10-08（本回合）按「规划」清单实现，未改清单外文件。

1. `session-channel/src/index.ts`
   - `start()`：首连失败改为记 `未连接（降级，后台重试）：<err>` 后 `void this.#retryConnect()`（仍立即返回，不阻塞启动）。
   - 新增 `#retryConnect()`：每 `deps.retryDelayMs ?? RETRY_DELAY_MS`（2 s）一次，连上即清 `status.error`、记一行 `重试 N 次后连接成功`、跑启动步骤；`stop()` 置 `#stopped` 后退出（在途尝试最长 3 s 内收敛）。
   - 原「连接就绪后的启动步骤」抽为 `#afterConnect()`（首连与后台重试共用，心跳定时器仍 unref）。
   - 新增 `sleepUnref()`（unref 定时器：后台重试不阻止进程退出）与 `SessionChannelDeps.retryDelayMs`（测试注入用，与既有 `deps.now` / `deps.random` 同风格）。
1. `TUI/src/app/index.ts`
   - 新增常量 `ALIAS_WARN_AFTER_FAILS = 3` 与字段 `aliasFailStreak`：别名读取连续失败 3 次（StatusTicker 5 s → 约 10-15 s）才写一次 warn，成功即清零；仍保持「每进程一次」不刷屏。
1. 回归用例 `session-channel/tests/service.test.ts`
   - 「首连失败转后台重试：连上后补齐启动步骤并清空 error」：注入 `connect`（首调抛 `unavailable/连接超时`，次调走真实连接）→ 断言降级立即返回、重试后 `connected` / `error` 清空 / `peers` 可用 / 恰好调 2 次。
   - 「重试期间 stop()：不再继续重试（不连上）」：`stop()` 后等待 80 ms，连接调用次数不再增长。

途中发现（已在本任务内修正，未新增 BACKLOG 条目）：新用例起初漏了 `redis.stop()`，临时 redis 子进程会让测试进程不退出（`node --test` 挂住）；已改为 `try/finally` 收尾，与本文件既有用例同构。

## 测试与证据

- `npm run check`（全仓 `tsc --noEmit`，20 包）→ exit 0，无报错行。
- `npm run build`（全仓 `tsc`）→ exit 0。
- `cd session-channel && npm test` → `tests 49 / pass 49 / fail 0`，8.9 s，进程正常退出（此前失败态：单文件跑完不退出，即上面那条临时 redis 泄漏）。
- `npm run test:tui -- app.test.ts` → `tests 167 / pass 167 / fail 0`（TUI 侧改动触达面）。
- `npm run test`（全仓 21 包并行）→ exit 0，逐包 `fail 0`（合计 pass 2421；TUI pass 1345、session-channel pass 49）。
- 真机验证（待用户执行）：重启 `dsh --profile fff` 后观察——预期无启动 warn，且状态栏别名段在数秒内出现（插件日志应出现 `重试 N 次后连接成功`）；若持续不出现，则日志里的真实 errno 即「沙箱拒连」成因证据，转入下一轮排查。

## 收尾

（回写文档、遗留项、是否移入 `docs/archived/`、BACKLOG 已完成条目的清理）
