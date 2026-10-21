# 默认关闭开关与创建期目标校验（接取条目：background-daemon/docs/BACKLOG.md「background-daemon 默认不开启, 需显式命令开启（1b）」；「创建指向不可解析会话的 S 档任务时仍弹 memory 写透告警」）

状态：测试　　开启：2026-10-21　　关闭：-
本文件是本任务唯一的过程记录与文档变更落点；计划外的文件不改。

## 目标

1. 守护**默认关闭**（进程内状态）：`/daemon start` 开启、`/daemon stop` 关闭；重启复位（不落盘）。
2. 未开启时：模型侧工具 `daemon_task` 与 `/daemon` 的**写类**动作按「未开启」口径拒绝并提示先开启；只读动作（`list` / `show` / `log`）仍可查。
3. 创建 **S 档**任务前校验目标会话可解析；不可解析即以明确错误码拒绝，**不**留半截任务，从而消除创建期那条 memory 写透 error 告警。

## 调研

来源：本包源码、`memory-base` / `session-paths` 源码、2026-10-20 真机记录（见 `docs/archived/2026-10-20-daemon-cross-instance-cancel.md`「测试与证据」末条）。

- **无开关语义**：`bootDaemon` 在 apply 期直接调用 `runtime.scheduler.start()`（`src/main.ts:489`）；`/daemon` 七个原始子命令（`src/commands.ts:22-30`）与 `daemon_task` 八个 action（`src/tools.ts:56-64`）全部直接可用。
- **告警现场**：`daemon_task create` → `TaskStore.create`（`src/store.ts:281-303`，先落内存、再 `mirror.save`）→ `MemoryTaskMirror.save`（`src/records.ts:370-394`）→ `scope.put` 走 **S 层**；memory-base 的 `TierSet.pathFor("session", …)` 调 `sessionPaths.sessionDirFor(sessionId)`（`memory-base/src/tiers.ts:111-125`），会话不在宿主 `sessions` 里时抛「会话「…」不在宿主的 sessions 里」（`session-paths/src/main.ts:145-160`），`#enqueue` 捕获后 `#fail` 打 `任务写入 memory-base 失败`（`src/records.ts:428-431`）→ stderr warn → TUI 显示红色 error 行。
- **为什么是「半截任务」**：memory 底座可用时 `store.disableSnapshot()`（`src/main.ts:283`）已停写 JSON 快照，创建期写透失败的任务在**内存里有、盘上没有**，重启即消失。
- **层级映射**：`tierForTask`（`src/records.ts:164-166`）：`S → session` / `P → project` / `U → user`；只有 S 层依赖会话目录，P / U 不受目标会话可解析性影响。
- **可用的探测面**：`memory-base` 经 `ctx.get("sessionPaths")` 结构化探测 `sessionDirFor`（`memory-base/src/index.ts:199-210`），本包可用同一手法；该服务缺失时无法校验（`pathFor` 届时返回 `undefined`，写入会被 memory-base 拒绝，属另一条降级路径）。

## 决策

**D1 开启状态的存放**（选项：a 进程内；b 状态目录持久化（`enabled.json`，多实例共享）；c 只走 `config.enabled`）

选定 **a**（用户 2026-10-21 裁定）。理由：与「默认不打开, 需人工用命令开启」字面一致，不引入新状态文件与跨实例语义。代价：重启后需重新 `/daemon start` 才会补算并触发定时任务（写进 README「边界」节）。

**D2 缺省关闭的落点**（选项：a 关闭时根本不启动调度器；b 调度器照常运行、只拦出口）

选定 **a**。理由：单点闸门，避免「调度器在跑但所有出口都被拒」的半开状态；`arm()` 在未启动时空转（`src/scheduler.ts:194-196`），故关闭态不会排任何 timer；开启时调 `scheduler.start()`，一并拿到启动补算语义。

**D3 未开启时命令面口径**（选项：a 全部拒绝；b 只读放行、写类拒绝）

选定 **b**：`list` / `show` / `log` / `help` / `start` 可用；`pause` / `resume` / `run` / `cancel` 拒绝并提示先 `/daemon start`；`stop` 报「未开启」。理由：排障需要读面；写面在关闭态没有可观察效果（调度器未启动）。

**D4 未开启时工具面口径**（选项：a 全部拒绝；b 只读放行）

选定 **b**（与 D3 对齐）：`create` / `pause` / `resume` / `run` / `cancel` 返回 `error: "daemon_disabled"`；`list` / `show` / `log` 照常。

**D5 条目 2 修法**（选项：a 创建期校验并拒绝；b 写透失败降级为一次性 debug 记录；c 两者都做）

选定 **a**（用户 2026-10-21 裁定）。理由：b 会留下「内存里有、盘上没有」的半截任务（JSON 快照已停写），用户以为建成实则重启即失。

**D6 探测服务的依赖姿态**（选项：a 把 `sessionPaths` 写进 `inject`；b 可选读取，缺失时不校验）

选定 **b**：不进 `inject`（与 `memory` / `guard` 同姿态），缺失时跳过校验、保持既有行为。理由：改 `inject` 会动激活顺序与既有降级面；memory 底座本身依赖该服务，正常挂载下可读到。

**D7 `status` 面是否暴露开关**（选项：a 暴露 `enabled`；b 不暴露）

选定 **a**：`DaemonStatusView` 增 `enabled: boolean`；只读服务面的**方法**集合不变（`SERVICE_FACE_METHODS` 不动）。

## 规划

任务拆分：

1. 新增 `src/switch.ts`：`DaemonSwitch`（进程内布尔开关，缺省关闭；`enable` / `disable` / `enabled`）。
2. 新增 `src/target.ts`：`createTargetValidator(ctx)` —— 可选读取 `sessionPaths`，返回 `(sessionId) => string | null`（不可解析时给出原因文案）；服务缺失返回 `undefined`。
3. `src/commands.ts`：`SUBCOMMANDS` 增 `start` / `stop`；写类子命令加闸门；`start` 调 `scheduler.start()`、`stop` 调 `scheduler.stop()`；usage 同步。
4. `src/tools.ts`：写类 action 加闸门（`daemon_disabled`）；S 档创建前调 `validateTarget`，不可解析返回 `session_unresolvable`。
5. `src/main.ts`：`DaemonConfig.enabled`（缺省 false）+ 装配 `DaemonSwitch`；按开关决定是否 `scheduler.start()`（未开启打一行 notice）；命令面 / 工具面注入开关、生命周期与校验器；运行期句柄暴露 `switcher`。
6. `src/service.ts`：`DaemonStatusView.enabled` + deps `enabled`。
7. `src/index.ts`：导出 `DaemonSwitch`、`createTargetValidator` 及其类型。
8. 测试：新增 `tests/switch.test.ts`、`tests/target.test.ts`；适配 `tests/harness.ts`、`tests/commands.test.ts`、`tests/tools.test.ts`、`tests/apply.test.ts`、`tests/service.test.ts`。
9. 文档：`background-daemon/README.md`（开关、未开启口径、创建期校验；关闭时回写）、`background-daemon/docs/BACKLOG.md`（条目状态）。

计划改动文件清单：

- `background-daemon/src/switch.ts`（新建）
- `background-daemon/src/target.ts`（新建）
- `background-daemon/src/commands.ts`
- `background-daemon/src/tools.ts`
- `background-daemon/src/main.ts`
- `background-daemon/src/service.ts`
- `background-daemon/src/index.ts`
- `background-daemon/tests/switch.test.ts`（新建）
- `background-daemon/tests/target.test.ts`（新建）
- `background-daemon/tests/harness.ts`
- `background-daemon/tests/commands.test.ts`
- `background-daemon/tests/tools.test.ts`
- `background-daemon/tests/apply.test.ts`
- `background-daemon/tests/service.test.ts`
- `background-daemon/docs/BACKLOG.md`（条目状态）
- 本文件
- `background-daemon/README.md`（关闭时回写）

明确不做：

- 不落盘开启状态（D1：不新增 `enabled.json`，不做跨实例开关同步）。
- 不改 `inject` 声明（D6）。
- 不改 JSON 降级口径与任务表存储形态。
- 不改 TUI（`/daemon` 之外无 TUI 侧改动；状态列块本期不做）。
- 不处理「S 档任务建成后目标会话被删」的后续写透（属运行期路径，另行登记则可）。

## 实现记录

- 2026-10-21：新增 `src/switch.ts`（`DaemonSwitch`：缺省关闭、`enable` / `disable` 幂等、状态仅进程内）。
- 2026-10-21：新增 `src/target.ts`（`createTargetValidator(ctx)` 经 `readService` 只读探测 `sessionPaths.sessionDirFor`；`TARGET_UNRESOLVABLE = "session_unresolvable"`；服务缺失或形状不符返回 `undefined` = 不校验）。S 档才探测，P / U 直接放行。
- 2026-10-21：`src/commands.ts` —— `SUBCOMMANDS` 增 `start` / `stop`；`DaemonCommandDeps` 增必填 `switcher`；`start` 先开开关再 `scheduler.start()`（`running === false` 时回滚开关并报错），`stop` 关开关后 `await scheduler.stop()`；`pause` / `resume` / `run` / `cancel` 首行加关闭态闸门（`notEnabled()`）；usage 与注册描述同步。
- 2026-10-21：`src/tools.ts` —— `DaemonToolDeps` 增必填 `switcher` 与可选 `validateTarget`；`WRITE_ACTIONS`（create / pause / resume / run / cancel）在关闭态返回 `error: "daemon_disabled"`；`createTask` 在 `store.create` **之前**校验 S 档目标，不可解析返回 `error: "session_unresolvable"` 且不落任务。
- 2026-10-21：`src/main.ts` —— `DaemonConfig.enabled`（缺省 `false`）；运行期建 `DaemonSwitch` 并暴露为 `DaemonRuntime.switcher`；`bootDaemon` 按开关决定是否 `scheduler.start()`（关闭态打印「未开启」提示，并在任务表不可用时打一条告警）；命令面 / 工具面注入开关与目标校验器。
- 2026-10-21：`src/service.ts` —— `DaemonStatusView` 增 `enabled`；deps 增 `enabled?: boolean | (() => boolean)`（支持函数形式实时读）。
- 2026-10-21：`src/index.ts` —— 导出 `DaemonSwitch` / `createTargetValidator` / `TARGET_UNRESOLVABLE` / `TargetValidator`。
- 2026-10-21：测试 —— 新增 `tests/switch.test.ts`（5 例）与 `tests/target.test.ts`（4 例）；`tests/harness.ts` 增 `switcher` 与 `enabled` 选项（用例缺省按已开启跑）；`commands` / `tools` / `apply` / `service` 补开关与校验相关用例。

## 偏差

- **计划外文件**：`tests/activation.test.ts`。「inject 防漏声明」守卫会把 `apply` 期读取的每个非可选服务都要求进 `inject`；本次按决策 D6 新增的 `sessionPaths` 读取属可选依赖，故把 `sessionPaths` 登记进该用例的 `OPTIONAL_SERVICES`（附理由注释）。不改会让合法改动被判成「漏声明」。影响：仅测试守卫的口径表，不涉及运行期行为。
- 其余无偏差：计划里的「明确不做」（不落盘开关、不改 `inject`、不改 TUI、不改任务表存储形态）均未发生。

## 测试与证据

- `npm --prefix background-daemon run check`：通过（`tsc --noEmit`，0 错误）。
- `npm --prefix background-daemon run build`：通过（产物含 `dist/src/switch.js` / `dist/src/target.js`）。
- `npm --prefix background-daemon test`：**165 例全绿**（新增 9 例：开关 5、目标校验 4；另补工具关闭态闸门 1 例、创建期校验 1 例、服务面 `enabled` 1 例）。
- 全仓 `npm run check`：通过（30 包）。
- 全仓 `npm run test`：30 包全绿（`background-daemon` 165 例）。
- 新增用例清单：
  - `tests/switch.test.ts`：`DaemonSwitch` 缺省关闭与幂等；`/daemon start` 联动调度器与重复 start；`/daemon stop` 撤销 timer 且任务保留；关闭态读类放行 / 写类拒绝且状态不被改动；任务表不可用时 `start` 失败并回滚开关。
  - `tests/target.test.ts`：服务缺失 / 形状不符 → 不校验；S 档探测（可解析 / 不可解析）；P / U 放行；`ctx.get` 缺失时的直接属性读兜底；错误码常量。
  - `tests/tools.test.ts`：关闭态写类 action 返回 `daemon_disabled` 且不建任务、读类照常、开启后可建；S 档目标不可解析返回 `session_unresolvable` 且任务表为空、P 档同目标可建。
  - `tests/apply.test.ts`：缺省关闭 → 调度器不启动、服务面 `enabled=false`、经注册 handler `start` 后启动；既有装配用例显式 `enabled: true` 保持原断言。
  - `tests/service.test.ts`：`status().enabled` 跟随开关函数、缺省 false。
- 真机验证（待人工确认）：`dsh --profile fff` 重启后 stderr 出现「未开启（默认关闭）」；`/daemon start` 后 `daemon_task list` 正常、`create` 可用；对不存在会话建 S 档任务返回 `session_unresolvable` 且不再出现「任务写入 memory-base 失败」error 行；`/daemon stop` 后写类动作被拒。

## 收尾

（待关闭时填写）
