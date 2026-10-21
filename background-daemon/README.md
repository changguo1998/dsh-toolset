# @dsh-toolset/background-daemon

DSH（DeepSeek Harness）进程内插件：**面向「agent 会话投递」的调度面**。调度是手段，投递才是目的——它调度的是「往某个活跃 agent 会话投一句话 / 执行一条 slash 命令」，不是「跑一个作业」。

设计正文与决策见 `docs/archived/2026-10-15-background-daemon-design.md`（项目级追踪文档）。

## 定位：三条非目标（防止范围膨胀）

1. **不跑 shell / 作业**：进程级作业（定时跑测试、拉备份）用 `systemd timer` / `cron`；本插件的 `command` 类型执行的是**会话里的 slash 命令**。
2. **不做进程外触发**：dsh 进程退出即停；重启后按任务表恢复（启动补算）。
3. **不做通用调度器的高级面**：任务依赖编排（DAG）、并发池 / 资源配额、多机分布、复杂重试矩阵一律不做。

## 能力

**定时执行**

| 选择器 | 说明 |
| --- | --- |
| `after_seconds` | 一次性，相对任务创建时刻 N 秒后 |
| `at` | 一次性，ISO 8601 绝对时点（创建时必须严格未来） |
| `every_seconds` | 固定间隔，下限 60 s，相位基准 = 创建时刻 |
| `daily` | 每日 `HH:MM`（显式 IANA 时区） |
| `weekly` | 每周若干 ISO 星期（1 = 周一 … 7 = 周日）的 `HH:MM` |

`cron` **不在首期**（后续可选项）。DST 缺口跳过、重叠取较早时点；同一日历日只触发一次。

到点执行的两种动作（语义分开，不互相降级）：

- `deliver`：构造 user 消息（`source.kind = "background-daemon"`）→ 推迟到宏任务 → `agent.followup`（排队、不打断当前回合）→ `sessions.flush` 作 L2 确认。同会话同批到期的任务**合并成一条消息**。
- `command`：`commands.find` 命中才执行 → 执行前过引擎侧安全复查（`security-guard` 的 `inspectCommand`）→ `commands.execute`（立即语义，不发给模型）。

**过程结果记录**

- 任务表：JSON 原子写（tmp + rename）+ `schemaVersion`；版本不认识 / JSON 损坏 / 记录非法（含选择器非规范化）→ **拒绝启用该面**并告警，不静默清空。
- 运行流水：JSONL 追加，缺省 **200 条**上限（与宿主 `schedule` 对齐），写满轮转到 `<file>.1`。
- 重启恢复：启动补算——周期任务只补**最近一次**错过的时点；一次性任务过期且在补发窗口（缺省 24 h）内仍触发，超窗记 `missed`。
- **不重试**：投递失败只记账（`failed` + 原因码）并写流水，周期任务等下一个触发点。

## 可见性

`/daemon`（`ctx.commands.register`，零 TUI 改动）：

守护**默认关闭**（进程内开关）：插件挂载后调度器不启动，`/daemon start` 开启、`/daemon stop` 关闭；状态**不落盘**，重启复位。未开启时写类子命令（`pause` / `resume` / `run` / `cancel`）与模型侧工具的写类 action 一律拒绝并提示先开启，读类（`list` / `show` / `log`）照常。

| 子命令 | 作用 |
| --- | --- |
| `start` | 开启守护并启动调度器（含启动补算：周期只补最近一次，一次性超窗记 `missed`） |
| `stop` | 关闭守护（撤销定时器，任务表保留；重启后仍需手动开启） |
| `list` | 任务列表（下次触发 / 状态 / 上次结果），空表输出「暂无守护任务」 |
| `show <id>` | 单条详情 |
| `pause <id>` / `resume <id>` | 暂停 / 恢复（恢复时周期任务按当前时钟重算下次） |
| `run <id>` | 立即投递一次（不改排期） |
| `cancel <id>` | 删除任务 |
| `log [<id>] [n]` | 运行流水（缺省最近 20 条） |

只读服务面 `ctx.get("backgroundDaemon")`：`list()` / `status()` / `journal(limit?, taskId?)`，供 `/daemon` 与**后续** TUI 状态列块消费；缺失时 TUI 按仓内惯例提示不可用。

模型侧工具 `daemon_task`（宿主 `schedule_create` 的等价物）：`create` / `list` / `show` / `pause` / `resume` / `run` / `cancel` / `log`。未开启时 `create` / `pause` / `resume` / `run` / `cancel` 返回 `error: "daemon_disabled"`，`list` / `show` / `log` 照常。

## 配置

```yaml
- id: background-daemon
  name: '@dsh-toolset/background-daemon'
  config:
    storePath: !!js process.env.BACKGROUND_DAEMON_STORE || dshHomePath('background-daemon/tasks.json')
    journalLimit: 200
    enabled: false             # 启动时的开关初始状态（缺省关闭；仅进程内, /daemon start 开启）
    awaitAgentMs: 0            # 目标未活跃时等多久再判 skipped
    catchUpWindowMs: 86400000  # 一次性任务过期补发窗口（缺省 24 h）
    maxDelayMs: 86400000       # 单段 timer 上限
    defaultSessionId: ''       # 模型侧工具的缺省目标会话（缺省无）
```

路径解析顺序：`config.storePath` → 环境变量 `BACKGROUND_DAEMON_STORE` → `$DSH_HOME/background-daemon/tasks.json`（`DSH_HOME` 缺省 `~/.dsh`）。流水与控制帐缺省与任务表同目录（`journal.jsonl` / `control.jsonl`，控制帐可用 `config.controlPath` 覆盖）。

## 依赖声明

`export const inject = ["agents", "sessions", "commands", "tools"]`：这四项在 `apply` 期就要读到（目标解析 / flush 确认 / 命令注册与命令类任务 / 模型侧工具注册），声明 inject 让 cordis 把激活顺序排在它们就绪之后——否则插件会先激活、`ctx.get(...)` 在严格模式下全部拿不到，表现为 `/daemon` 与 `daemon_task` 都未注册。

`timer` **不在 inject 里**：定时器走 `timer` 插件的 `clock` 统一面（`clock.now()` / `clock.scope(ctx)`；`src/main.ts` 的 `resolveTimers`），缺失时退回进程内 `setTimeout`（`systemTimer()`，unref）。

`memory`（记录底座）与 `guard`（命令复查）是可选依赖，不进 inject：memory 在 apply 期直读命中即挂载为底座，未命中且宿主提供 `ctx.inject` 时经 `ctx.inject(["memory"], cb)` 子分叉晚挂（参照 `agent-group` 先例）；两者缺失分别降级 JSON 快照 / fail-open 并标 `guardSkipped`。

## 边界（行为口径）

- **默认关闭（进程内开关）**：插件挂载后**不启动调度器**（`config.enabled` 缺省 `false` 是唯一开箱放行口）。`/daemon start` 开启并按启动补算口径补算（周期任务只补最近一次，一次性超窗记 `missed`）；`/daemon stop` 撤销定时器、任务表保留。开关状态**仅进程内、不落盘**：重启后需重新开启，未开启期间到点不投递。未开启时写类动作（`pause` / `resume` / `run` / `cancel` 与 `daemon_task` 的写类 action）一律拒绝并提示先开启，读类（`list` / `show` / `log`）照常。
- **S 档创建期目标校验**：`daemon_task create` 在落任务**之前**用 `sessionPaths.sessionDirFor` 只读探测目标会话；不可解析返回 `error: "session_unresolvable"` 且**不创建**任务（避免「内存里有、盘上没有」的半截任务与创建期写透告警）。`sessionPaths` 读不到时跳过校验（可选依赖，不进 inject）；`P` / `U` 档不校验（不落 session 层）。
- **目标 = 本进程内已注册的活跃 agent**：`agents.get(sessionId)` 未命中 → `skipped`（原因 `no-active-agent`）并写流水；`awaitAgentMs > 0` 时在窗口内按固定间隔复查（不是失败重试链）。**不**冷恢复会话、**不**跨进程唤醒。
- **投递语义 = at-least-once**：`flush` 成功（L2）才记持久投递；`flush` 返回 false 记 `delivered` + `durable:false`（原因码 `volatile`）+ 告警，**不**自动重投（D13）。崩溃窗口可能造成重复投递。
- **安全边界**：投递是 user 消息，后续工具调用照常受 `security-guard` 与 approval / sandbox 策略约束；本插件**不降级**任何策略、不自动批准、不绕过审批。命令类任务属「命令来自状态文件」一侧 → 引擎侧复查（`guardScope: engine-side`）；复查不可用时 fail-open 但结果标 `guardSkipped`。
- **单 timer**：任何时刻至多一个待触发定时器；长延迟分段（缺省 24 h）；检测到墙钟回拨按当前时钟重算周期任务的 `next`。
- **取消 / 暂停 / 恢复跨实例生效**：三个动作成功后往**共享控制帐**（`control.jsonl`，与任务表同目录）追加一条事件；每个实例在每次到期结算前先收敛控制帐（取消即删本地副本、暂停 / 恢复改状态），幂等。控制帐是 append-only、不轮转（只有人工操作写入），进程重启后同样收敛，兼作墓碑。不依赖 `session-channel` 等可选服务。
- **`skipped` 不写透 memory-base**：`no-active-agent` 不改变任务语义（状态与 `next` 由本进程本地推进），且目标会话可能已删——该结局只写本地 JSONL 与内存副本，跳过 `daemon_task` / `daemon_run` 写透，避免每周期刷「解析会话目录失败」告警；本地 `/daemon log` 仍可查。
- **记录底座边界**：memory 可用时任务表落 memory-base SQLite（库级锁 + 原子写），tasks.json 停写，多实例共享安全；memory 不可用（JSON 降级）时任务表是**进程内镜像 + `tasks.json` 整文件写回**，设计面向**单 dsh 进程**——多个 `dsh --profile fff` 实例共享同一 DSH_HOME 且都处于 JSON 降级时会互相覆盖任务表，属预期边界（请勿在 JSON 降级下多开实例）。

## 记录底座（memory-base 冻结接口）

记录底座按设计 D19 落 `memory-base`，接口按 2026-10-17 冻结版实现（`memory-base/docs/archived/2026-10-17-slim-and-storage-surfaces.md`）：

- 注册两个 kind：`daemon_task`（任务）与 `daemon_run`（运行流水），可写层声明为 `session` / `project` / `user` 三层全集；任务分档 `S / P / U` 映射到这三层。
- 任务：memory-base 没有 update 面，因此每次状态变更写一条**追加式修订行**（content 是任务快照 JSON，带 `syncedAt` 避免 `content_hash` 去重吃掉重复快照）；启动时 `list({kind})` 读出全部行，按 `(createdAt, id)` 取最新一条为当前状态；删除走 `scope.forget({tier, ids})`。
- 流水：每条写一行 `daemon_run`，因此进入全文检索（「流水可搜索」）。
- 写侧隔离：`scope.put` 的越权层会抛错、内容级闸门（隐私 / `preWrite`）走 `PutResult.skipped`；两者都只记入镜像的 `failures` 并告警，**不重试**。
- 坏行（解码失败 / 行层与任务分档不符）在启动时被**隔离**（不加载、逐条告警），行仍留在库里，由用户决定是否清理。

**记录底座 = memory 优先，JSON 仅降级**：memory 可用时在 apply 期直读命中即挂载，未命中则经 `ctx.inject(["memory"], cb)` 晚挂（agent-group 先例），挂载后注册 kind、任务表迁入 memory-base（SQLite，库级锁 + 原子写）、`tasks.json` 停写，`ctx.get("backgroundDaemon").status().records` 报 `"memory"`。`ctx.get("memory")` 缺失或注册 / 读取失败 → 退回本地 JSON 快照（`tasks.json`）与 JSONL 流水，`records` 报 `"json"`（此路径为单实例边界，见「边界」节）。首次启用 memory 底座时，若库里没有任务行而已有 JSON 快照，会把快照一次性导入（导入条数写日志）。

## 测试

```sh
npm --prefix background-daemon run check   # tsc --noEmit
npm --prefix background-daemon test        # node --test（假时钟 / 假 timer / 假渠道）
```

单测覆盖：选择器与 DST、补发口径、任务表损坏拒启、流水有界轮转、两条渠道（含 flush 失败与复查拦截）、调度器（单 timer / 分段 / 同批合并 / skipped / 回拨 / 不重试 / stop / 控制帐收敛）、共享控制帐（读写、坏行跳过、取消 / 暂停 / 恢复、幂等）、`/daemon` 九个子命令（`pause` 与 `resume` 分立，上表并列一行）、进程内开关（默认关闭 / `start` 与 `stop` 的调度器联动 / 关闭态闸门）、创建期目标校验（`sessionPaths` 可选读取、S 档探测、P / U 放行）、只读服务面、模型侧工具、`apply` 装配与降级、记录底座（假 memory-base：kind 注册 / 取最新修订 / 坏行隔离 / 写透 / 删除 / 流水外送）。

真机验证（`dsh --profile fff`）属实现条目的独立一步，尚未在本包完成。
