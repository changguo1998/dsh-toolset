# 跨会话消息通道（intercom 插件）（接取条目：docs/BACKLOG.md「跨会话 broker（消息/委托/状态同步）」）

状态：关闭　　开启：2026-09-29　　关闭：2026-09-29

> 后续记录：插件关闭后按命名规范由 `intercom` 更名为 **`session-channel`**（功能、结构、键位语义不变；键前缀 `dsh:session-channel:`、工具 `session_channel`、服务 `sessionChannel`、socket `dsh-session-channel.sock`、unit `dsh-session-channel-redis.service`、注入前缀 `[CHANNEL] `）。本文件内文按当时名称保留。
> 本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

新建 `intercom` 插件（第 16 包），提供**本机跨 dsh 进程 / 跨会话的消息通道 MVP**：发送、投递（注入目标会话）、回执、在线与对端发现。传输用**专用 Redis 实例（路 B）**：unix socket、独立配置与数据目录、用户级 systemd 开机自启。系统 Redis 实例不动、不依赖。

范围外（关闭时另立条目）：跨会话委托/协调、扩展状态同步、消息历史检索（超出「最近 N 条」）。

## 调研

- **宿主缺口**（`archive/PI-DSH-FEATURE-COMPARISON.md` §3.3）：跨会话消息/委托/状态同步三项均缺；官方 `webhook` / `acp` / `sdk` 均非等效（`docs/host/HOST-PACKAGES.md` 已核）。
- **注入路径已有实证**（rule-engine）：`ctx.agents.get(sessionId).followup(msg)`，且必须在 `setTimeout(…, 0)` 宏任务里调用（`session/event` 同步派发窗口内的重入红线）；消息硬要求 `id` / `content[]` / `source.kind`。
- **显示路径**：TUI 只认 `source.kind === "rule-engine"` 的注入按用户块显示（`TUI/src/app/adapter/normalize.ts:79` 的 `ruleInjectionTextOf`）。
- **依赖现状**：14 个包全部零外部依赖（唯一依赖形式 = 跨包 `link:`）；`scripts/install.sh` 契约：不 sudo、只写 `$DSH_HOME` 与仓库。
- **本机实测**：Redis 7.0.15 已装（系统实例 active + enabled、`127.0.0.1:6379`、`noeviction`、`maxmemory 0`、`DBSIZE 0`）；`$XDG_RUNTIME_DIR=/run/user/1000` 存在；`/etc/redis/redis.conf` 由 root 管（工具沙箱内不可读）。
- **方案比选**（与用户逐项讨论过）：SQLite + 唤醒通道 / 纯 UDS / Redis（另对照 MQTT、D-Bus 会话总线、Postgres、NATS）。用户选定 **Redis 路 B**；不跨机；依赖可商量。
- **辅助决策**：离线策略=不在线直接报错；本机 Redis 系统实例已是 `noeviction` 且空库，但仍按路 B 起专用实例以彻底隔离。
- **API 探针实测**（临时 `redis-server 7.0.15` + unix socket，脚本 `tmp/probe-redis.mjs`，用后清理）：`createClient({socket:{path}})` 连通；`xAdd(key,"*",fields,{TRIM:{strategy:"MAXLEN",strategyModifier:"~",threshold}})` 返回消息 id；`xRead([{key,id}],{COUNT})` 返回 `[{name,messages:[{id,message}]}]`；`xRead(…,{BLOCK:200})` 空结果返回 `null`；`set(k,v,{EX})` / `get` / `sendCommand(["CONFIG","GET",…])` / `scanIterator({MATCH})` 行为符合预期；`info("server")` 可取 `redis_version`。
- **依赖安装实测**：`npm --cache tmp/npm-cache install --prefix intercom` 成功（10 个包）；仓库既有口径 = 各包提交 `package-lock.json`、`node_modules` 由 `.gitignore` 忽略。

## 决策

1. **拓扑（路 B）**：专用 Redis 实例，`port 0` 仅 unix socket（`$XDG_RUNTIME_DIR/dsh-intercom.sock`、`unixsocketperm 700`），独立 `dir`/`pidfile`/`appendonly`；配置落 `~/.dsh/intercom/redis.conf`；**系统实例与系统配置一律不动**。
1. **开机自启**：用户级服务 `~/.config/systemd/user/dsh-intercom-redis.service`（`Restart=on-failure`、`WantedBy=default.target`）；`systemctl --user enable --now`；可选 `loginctl enable-linger <user>`（登出后仍常驻）。
1. **Redis 客户端：npm `redis`（node-redis，安装版本 6.2.1）**——用户 2026-09-29 两方案对比后裁定选 B。理由：重连 / 分帧 / 超时 / 错误分类交给成熟库，开发更快、长期更稳；代价是本包成为首个带外部运行时依赖的包（`redis` 实际带入 `@redis/client` 等共 10 个包），且新机器安装链多一步 `npm install`。仅用其窄子集：`createClient({socket:{path}})` / `ping` / `info` / `sendCommand`（`CONFIG GET`）/ `get` / `set(EX)` / `scanIterator` / `xAdd(TRIM)` / `xRead(BLOCK)` / `xRevRange` / `del`。
1. **键位模型**（全部 `dsh:intercom:` 前缀，绝不 `FLUSHDB`/`FLUSHALL`，清理只用 SCAN + DEL）：
   - 邮箱流：`dsh:intercom:inbox:<sessionId>`（`XADD MAXLEN ~ 1000`）
   - 在线：`dsh:intercom:alive:<sessionId>` = JSON `{pid, instanceId, cwd, profile, startedAt}`，`SET … EX 15`；心跳每 5s 刷新
   - 回执：`dsh:intercom:ack:<msgId>` = `"injected"`，`SET … EX 60`
1. **投递**：接收方后台循环 `XREAD BLOCK 15000` → 解析消息 → `setTimeout(…, 0)` 宏任务里 `agent.followup()` 注入；消息 `source.kind:"intercom"`、正文前缀 `[INTERCOM] `；注入失败不重试（MVP），落 notice。
1. **离线策略**：目标心跳过期或 pid 已死 → 发送直接报错「目标不在线」；不做 spool / 离线队列。
1. **回执语义**：`send` 默认返回「已入队」（XADD 成功即返回 message id）；可选 `--wait <ms>` 等 `ack` 键（超时返回「未确认」）。
1. **寻址**：`sessionId` 精确；`cwd:<path>` 匹配该目录下的活跃会话（命中多条时列出候选并要求改精确指定）。
1. **工具与服务面**：工具 `intercom`（actions：`peers` 列在线 / `send` 发送 / `inbox` 查最近消息 / `status` 连接与版本自检）；`ctx.provide("intercom", { peers, send })` 供 TUI 与其他插件使用。
1. **TUI 显示**：`ruleInjectionTextOf` 泛化为识别 `rule-engine` + `intercom` 两种来源（仍显示为用户块）；改 `TUI/src/app/adapter/normalize.ts` + 用例。
1. **服务安装脚本**：`intercom/scripts/setup-redis.sh`（幂等；`--uninstall` 可逆；写 redis.conf 与 unit → `daemon-reload` → `enable --now` → 验证 `redis-cli -s <sock> ping`；`--linger` 可选）。根 `scripts/install.sh` 只加一行提示指向该脚本，**不改变其既有契约**。
1. **安全与边界**：socket 文件与目录 0700；插件只连本机 socket；单条正文上限 8 KB；不做频率限流（本地单用户）。
1. **启动自检**：连接顺序 `DSH_INTERCOM_REDIS_URL` → `$XDG_RUNTIME_DIR/dsh-intercom.sock` → 报错降级；校验 `PING`、`INFO server` 版本 ≥ 5.0、命名空间标记键 `dsh:intercom:meta`（schema 版本不兼容则拒绝写入并提示）。

## 规划

任务拆分与验证方式：

1. 包骨架（`package.json` / `tsconfig.json` / `cordis.patch.yml` / `src/index.ts`）→ 验证：`npm --prefix intercom run check`。

1. 客户端接入（`src/client.ts`：地址解析 + 连接 + 健康自检；依赖 `redis` 包）→ 验证：对临时 `redis-server`（`/tmp` 下 socket）实测连通与自检。

1. 业务层（`src/broker.ts`：presence / heartbeat / send / inbox / peers / 清理；`src/inject.ts`：宿主注入）→ 验证：临时 Redis 实例 + 假 agent 的单测（发送→读取→注入→回执全链）。

1. TUI 显示泛化（`TUI/src/app/adapter/normalize.ts` + 用例）→ 验证：`npm run test:tui`。

1. 服务安装脚本（`intercom/scripts/setup-redis.sh`，含 `--uninstall`）→ 验证：真机执行后 `systemctl --user status` + `redis-cli -s <sock> ping`。

1. 构建与文档接入（根 `package.json` 列表、`scripts/install.sh` 插件清单 **+ 新包依赖安装步骤**、根 `README.md`、`AGENTS.md` 包清单、`intercom/README.md`）→ 验证：全仓 `npm run check / build / test` 全绿。

1. 依赖落库：提交 `intercom/package.json` + `intercom/package-lock.json`（`node_modules` 忽略）→ 验证：干净目录 `npm ci --prefix intercom` 可复现。

1. 真机联调（两个 dsh 进程互发）→ 由用户确认（本机 TUI + headless 会话）。

计划改动文件清单（**只改这些**）：

- `docs/BACKLOG.md`（#30 状态；关闭时清理 + 新增后续条目）
- `docs/implementation/2026-09-29-cross-session-intercom.md`（本追踪文档）
- 新增包 `intercom/`：`package.json`、`package-lock.json`、`tsconfig.json`、`cordis.patch.yml`、`README.md`、`docs/DESIGN.md`（关闭时回写）、`scripts/setup-redis.sh`、`src/{index,client,broker,inject}.ts`、`tests/*.test.ts`（`node_modules` 忽略、不入库）
- `TUI/src/app/adapter/normalize.ts`、`TUI/tests/*`（显示泛化用例）
- 根 `package.json`、`scripts/install.sh`（插件清单 + 依赖安装步骤）、`README.md`、`AGENTS.md`（接入与文档索引）

明确不做：改动系统 Redis 实例或其配置；**除 `redis` 外再新增其他 npm 依赖**（本次依赖经用户裁定，仅此一个）；跨机；离线队列/委托/状态同步；`~/.dsh` 之外的服务端系统配置（user 级 unit 属用户配置，由 setup 脚本显式安装且可 `--uninstall`）。

## 风险与注意

- 工具沙箱对 `~/.dsh` 与 `~/.config` 只读 → `setup-redis.sh` 的真机执行由用户完成（或我尝试后经你确认提权）。
- 真机联调需要两个 dsh 进程；单进程内多会话（TUI 单活跃）覆盖有限。
- 新包加入根脚本后，全仓 check/build/test 必须保持全绿；`scripts/install.sh` 的插件清单/文档索引需同步，否则新机器装不上。
- Redis 版本要求 ≥ 5.0（Streams）；本机 7.0.15 满足。
- **首个外部依赖**：新机器安装需 npm 源可达（`install.sh` 增步骤）；node-redis 大版本升级需关注 API 变更；供应链面比既有 14 包大（用户已知并同意）。

## 实现记录

2026-09-29（进行中）：

- 已建包骨架：`intercom/package.json`（依赖 `redis ^6.2.1`）、`tsconfig.json`（对齐 code-map）、`cordis.patch.yml`（insert `@dsh-toolset/intercom`）。
- 已装依赖：`npm --cache tmp/npm-cache install --prefix intercom` → 10 个包，生成 `package-lock.json`（待入库）。
- 已完成 API 探针（结论见「调研」；临时脚本在 `tmp/`，收尾清理）。
- 本追踪文档已按决策 B 更新。
- 实现（同日）：
  - `intercom/src/{keys,types,constants,client,broker,inject,index}.ts`：键位 / 类型与错误码 / 常量 / 连接层（地址解析、双连接、健康自检、超时快速失败、失败路径关连接）/ 消息层（在线 + 懒清理、寻址、发送、收件箱、回执、阻塞读）/ 注入层（宏任务推迟 + 消息构造）/ 服务与接入面（会话跟踪、心跳、reader 循环、工具、provide、apply）。
  - 游标语义修正：新跟踪会话从 `0` 起读（发送方可能先入队、接收方后启动），已投递消息按回执照跳过（重启不重复注入）。
  - `intercom/scripts/setup-redis.sh`：路 B 安装（配置 + 用户级 unit + enable/linger + PING 验证；`--uninstall` / `--purge` / `--manual` / `--dry-run`）；补 socket 父目录创建（`$XDG_RUNTIME_DIR` 缺失时）。
  - TUI：`TUI/src/app/adapter/normalize.ts` 白名单泛化（`rule-engine` + `intercom` 走用户块通道）+ 用例。
  - 接入：根 `package.json`（check/build）、`scripts/test-parallel.sh`、`scripts/install.sh`（canonical 列表 + 计数文案）、根 `README.md`、`AGENTS.md`、`intercom/README.md`、`intercom/docs/DESIGN.md`。
- 途中发现（已修）：`connectIntercom` 在健康自检失败时未关闭已建立连接 → 句柄残留拖住进程（测试实测）；`setup-redis.sh --manual` 仍等待 socket；`setup-redis.sh` 未创建 `$XDG_RUNTIME_DIR`。
- **真机缺陷与修复**（最重的一条）：`inject` 只声明了 `["tools"]`，注入时直读 `ctx.agents` 在真实 cordis ctx 上抛 `cannot get property "agents" without inject` → 读循环反复重试、消息无回执、发送方 `delivered:false`。修法三处：① `inject = ["tools", "agents", "sessions"]`（与 rule-engine 同口径）；② 服务读取改为受保护访问器 `readService`（`ctx.get(name)` 优先、直读与其自身 `get` 读取均包 try/catch）；③ 注入后调 `sessions.flush(agent.session)` 落盘，并把单条投递失败与整批读取解耦。回归用例 3 例（`tests/inject.test.ts`：受保护读取三态、flush 调用、代理宿主端到端）。

## 测试与证据

- 单测 18 例（`npm --prefix intercom run test`）：`client` 5（地址解析三态 / 连通自检写 meta / schema 不兼容 / 连不上快速失败）+ `broker` 6（在线与死 pid 懒清理 / 寻址精确与 cwd 多命中 / 发送错误码三态与成功入库 / 回执等待 / 阻塞读游标）+ `service` 5（端到端注入与回执 / 停止清在线键 / 重启不重复注入 / disabled 与连不上降级 / 键前缀 sanity）+ `apply` 2（工具与 provide 面全链 / 无 tools 面不抛）。集成用例在临时 `redis-server 7.0.15`（unix socket）上跑，无该二进制的机器自动 skip。
- 安装脚本实测：`--manual` 生成配置 → 手动起实例 → `PING` = PONG；`maxmemory-policy=noeviction` / `port=0` / `appendonly=yes` 生效；socket 权限 `srwx------`；SIGTERM 干净退出（AOF/RDB 落盘）。
- 门禁：根 `npm run check` 0 error（16 包）、`npm run build` 0 error；全仓 `npm run test` 全 OK——intercom 18、TUI 1206（+1 为 intercom 显示用例）、其余 14 包无回归。
- 真机（**已通过**，2026-09-29）：用户级服务安装成功（`setup-redis.sh --linger`：配置 + unit + enable + linger + PING=PONG，socket 0700，`DBSIZE 0`）；跨进程联调（两个 dsh 会话）四段全通——① 重启补投：首条失败消息在接收方重启后按游标 0 补投并写回执（`ack:1790637235680-0`）；② live 实时投递：`send` 返回 `delivered: true`；③ 注入显示：接收方界面出现 `[INTERCOM] 跨进程测试` / `[INTERCOM] 实时第二条` 用户块；④ 在线项两条（pid / cwd / startedAt 正确）。
- 真机发现并修复（见下「途中发现」）：`ctx.agents` 直读抛错导致注入失败、回执缺失——修复后 21 例单测（+3 回归）全绿。

## 收尾

- 回写 `intercom/README.md`（能力 / 前置 / 配置 / 键位 / 用法 / 边界 / 测试）与 `intercom/docs/DESIGN.md`（定位 / 取舍 / 模型 / 管线 / 生命周期 / 运维 / 接入面 / 边界 / 明确不做）。
- 回写根 `README.md`（插件表 + 目录树 + 文档索引 + 计数）与 `AGENTS.md`（包清单 + 计数 + 插件子包说明）。
- `docs/BACKLOG.md`：#30 清理；新增两条后续条目——跨会话委托/协调、扩展状态同步（本条范围外，用户 2026-09-29 裁定的拆分）。
- 本文件移入 `docs/archived/`。
- 遗留项：无；`vm.overcommit_memory` WARNING 可忽略（要消除需 root）。
- **改名（关闭后按命名规范执行）**：`intercom` → `session-channel`。范围 = 包目录、包名 `@dsh-toolset/session-channel`、工具 `session_channel`、服务 `sessionChannel`、键前缀 `dsh:session-channel:`、socket `dsh-session-channel.sock`、unit `dsh-session-channel-redis.service`、env `DSH_SESSION_CHANNEL_REDIS_URL`、注入前缀 `[CHANNEL] `（源码 kind `"session-channel"`）、根脚本清单 / README / AGENTS / TUI 白名单 / BACKLOG 引用 / 本文件顶部注记。
- **改名后真机复验（2026-09-29）**：旧 unit 与 `~/.dsh/intercom` 卸载、新 unit 安装（`--linger`）、profile 依赖与 bundle 换成新名并 `pnpm install`、两会话重启后互发——接收方界面出现 `[CHANNEL] 改名后验证`，发送方 `delivered: true`；新实例 socket 0700 + PONG + meta=1，旧 socket 已消失。
- 门禁（改名后）：根 `check` / `build` 0 error；全仓 `test` 16 包全 OK（session-channel 21、TUI 1206）。
- 临时文件：`tmp/probe-redis.mjs`、`tmp/probe-teardown*.mjs`、`tmp/probe-ours.mjs`、`tmp/npm-cache/`（收尾已清理）。
