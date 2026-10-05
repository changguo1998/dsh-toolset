# @dsh-toolset/metric-loop

DSH（DeepSeek Harness）进程内插件：指标驱动的自动循环。注册工具 `metric_loop`，每轮执行用户提供的测量命令（stdout 解析单个数字），按方向比较历史最优；连续 `window` 轮无改进则 plateau 停止。循环状态持久化为 JSON，跨进程唤醒即可续跑。

## 能力

工具 `metric_loop`（单工具 + `action` 分派）：

| action | 参数 | 作用 |
| --- | --- | --- |
| `start` | `id?`、`measureCmd?`、`direction?`、`window?`、`maxRounds?`、`timeBoundMs?`、`tokenBound?`、`cadenceSec?` | 新建循环（重置同名旧状态）并跑第一轮（显式唤醒） |
| `tick` | `id?`、`wake?`（`auto` / `explicit`，缺省 `explicit`）、`tokensUsed?` | 推进一轮 |
| `status` | `id?` | 只读状态 |
| `stop` | `id?` | 手动停止（已停止则幂等） |

默认值：`id` = `default`、`direction` = `min`、`window` = 5、`maxRounds` = 50；`measureCmd` 缺省或空串即 metricless。`id` 仅保留文件名字符并限长 64。

语义：

- 停止原因优先级：`plateau` > `maxRounds` > `time` > `tokens`，另有 `manual`。plateau 仅在带测量命令时判定。
- 轮前边界检查：已达 `maxRounds` / `timeBoundMs` / `tokenBound` 时本轮不执行、直接停止（结果 `round: null`）。
- `wake: "auto"` 受 cadence 节流：距上次成功不足 `cadenceSec` 返回 `deferred: true`，不消耗轮次、不落盘；显式 start/tick 不受限。
- 测量失败（超时、非零退出、stdout 无数字）按本轮无改进处理，不更新最优值、不中断循环。
- 结果含 `schedule` 提示（运行中为 `schedule_create` 的 `title` + `after_seconds` + `prompt`，已停止为 `null`）与一句话 `summary`；另有复查相关标注：`guardScope`（本轮复查范围）与（仅复查不可用时）`guardSkipped: true`。

只读服务 `metricLoop`（`provide("metricLoop")`）：`list()` 返回活动/历史循环清单（只读子集，`updatedAt` 倒序，单个状态文件损坏则跳过），`status(id)` 查单循环或返回 `null`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `stateDir` | `~/.dsh/metric-loop` | 状态文件目录；环境变量 `METRIC_LOOP_STATE_DIR` 优先 |
| `commandTimeoutMs` | `30000` | 测量命令超时 |

状态文件为 `metric-loop-<id>.json`，原子写（tmp + rename），含 schema 版本（不兼容版本拒绝加载并报错）、历史轮次截断（最多 500 条）。

bundle 契约：`name` / `inject: ["tools"]` / `provide: ["metricLoop"]` / `Config` / `apply`。

## 使用示例

```jsonc
{ "action": "start", "id": "bundle-size", "measureCmd": "du -sk dist | cut -f1", "direction": "min", "window": 3, "maxRounds": 20, "cadenceSec": 900 }
{ "action": "tick", "id": "bundle-size", "wake": "auto", "tokensUsed": 1200 }  // cadence 未到时 deferred=true
{ "action": "status", "id": "bundle-size" }
{ "action": "stop", "id": "bundle-size" }
```

宿主联调（smoke 幂等引导 profile `dsh-toolset-metric-loop`，并把 `stateDir` 重定向到临时目录）：

```sh
npm run smoke   # dsh headless 连跑三轮，断言跨进程状态与 plateau 停止
```

## 与官方循环机制的分工（2026-10-06 裁定 A）

宿主另有两条「循环 / 自主续跑」面，与本包不是同类能力（依据与全过程：`docs/archived/2026-10-05-metric-loop-official-loops.md`）：

| 维度 | 本包 `metric-loop` | 官方 `goal-round-driver` | 官方 `tool-ralph` |
| --- | --- | --- | --- |
| 驱动源 | 模型调 `metric_loop`，每轮显式 `tick`（可经 schedule 提示唤醒） | 宿主事件：agent idle 时排 goal-round | 模型调 `ralph`，**前台阻塞**至结算 |
| 前置条件 | 无（新建循环即可） | **需已建 goal 且 `activation === "armed"`**（resume / fork 后 disarmed） | 无 |
| 测量与收敛 | **有**：测量命令 + best / streak / plateau | 无（模型自判） | 无（worker 自报） |
| 停止边界 | plateau / maxRounds / time / tokens / manual | complete / paused / blocked / 轮上限 | complete / blocked / 轮上限 |
| 跨进程状态 | **有**（JSON 状态文件，原子写 + schema 版本） | 无（activation 仅进程内） | 无（工作区即长期记忆） |
| 轮间共享 | 同一会话 + 状态文件 | 同一会话 | 仅一份有界结构化报告（每轮全新子 agent） |
| 本项目当前是否在位 | 是（本仓插件） | 是（`dsh-base` 装配） | **否** —— base 默认 `disabled: true`（`dsh-base/cordis.patch.yml:447-449`），一行 overlay（`- id: tool-ralph` + `disabled: false`）可恢复 |

**本项目口径（裁定 A）**：

- 要**按指标收敛**的长跑（有可测目标数字、按方向比较、plateau 自动收手、跨进程续跑）→ 用本包；这三项官方两条都没有。
- 要**同一个 goal 的自主多轮推进**（目标是完成一件事，而不是优化一个数字）→ 用官方 goal + `goal-round-driver`；本包不参与。
- `tool-ralph` **本项目不启用**：每轮全新子 agent、跨轮只传一份结构化报告，且完成 / 受阻是 worker 自报而非独立评估；即使用也需人明确要求，且与本包的指标循环不是同类能力。
- 建议**不把两条循环叠在同一个目标上**：同一目标同时挂本包与 goal 续轮会形成两条互不知情的推进链，各有独立停止条件，收敛语义无法归因。

## 边界与限制

- 自动唤醒复用宿主 schedule 面：插件只返回 `schedule_create` 参数，由宿主按提示排下一次唤醒（`after_seconds` 一次性提醒链式续排）；不新建调度器。**字段已对齐官方入参校验**（`dsh-schedule` 0.2.0-rc.2 的 `validateCreateArgs`：键白名单、恰好一个选择器、`prompt` / `title` trim 后非空且 `title` ≤120 字符、`after_seconds` 为正安全整数；`title` 为 `[metric-loop] <id>`），照提示调用即可成功。该提示的**可执行性仍取决于 profile 是否挂载 `@deepseek-ai/dsh-schedule`**（模型侧 `schedule_create` 工具由它提供）；未挂载时提示只是文案，循环仍需靠显式 `tick` 或其他唤醒路径推进。回归背景见 `docs/archived/2026-10-06-metric-loop-schedule-hint.md`。
- 轮内做什么改进动作（循环载体）由宿主 workflow / 会话编排，插件不感知。
- 跨进程语义依赖状态文件：每次 `dsh` 启动或 schedule 唤醒加载状态推进一轮；文件缺失视为循环不存在（`tick`/`stop` 报错，`status` 返回 `exists: false`）。
- 测量命令经 `/bin/sh -c` 执行，取 stdout 中最后一个数字（容忍 `score: 0.87` 等噪声）；信任契约内命令，不做沙箱隔离。
- **命令执行前的安全复查**（2026-10-02；分工与留痕口径同日硬化）：复查按**命令来源**分工，结果里的
  `guardScope` 标明本轮走的是哪一侧 ——
  - `measureCmd` 来自**工具入参**（`action=start`）：已由 security-guard 的 `tools/pre-execute` 覆盖 →
    工具层显式声明 `guardScope: "tool-args"`，引擎内**不重复判定**（同一命令不会在 guard 的 `recent()` 里
    落两条记录）；
  - 命令来自**状态文件**（`tick` 执行 `spec.measureCmd`）：pre-execute 看不到它 → 引擎内复查
    （`guardScope: "engine-side"`；与 `bash` 同一套命令黑名单 / 敏感层，`allowPatterns` 生效），命中即不测量、不落盘。
    直连 `MetricLoopController.start()` / `createController()`（不经工具面）时 `guardScope` 缺省仍是
    `engine-side` —— 有复查器就复查，不给 D2 留空洞（`createController()` 默认不接线复查器）。
    **复查不可用时可见（D1）**：guard 未挂载 / 复查抛错 → **fail-open 照常测量**（每种失效模式只告警一次，
    原先抛错是每轮都告警），但结果会标 `guardSkipped: true` 且 `summary` 写明「本轮命令未复查即执行」；
    未接线（无复查器）的路径不标 `guardSkipped`（那属于「没接线」，不是「复查失败」）。
- metricless 循环不判 plateau，只按轮数/时间/token 边界或手动停止。

## 相关文档

- 宿主 bundle 契约（`name` / `inject` / `provide` / `Config` / `apply`）：`docs/host/DSH-CTX-API.md` §0；本包与 `task-engine` 同款——零 DSH 运行时依赖、以结构面访问 ctx。
- 宿主面依据与升级面：`docs/host/HOST-PACKAGES.md`（`schedule` 行、`tools` 服务）、`docs/host/HOST-UPGRADE-0.2.0-rc.2.md`。
- `metric_loop` 的模型侧参数 schema 以 `src/index.ts` 的 `toToolDef()` 为唯一来源（本 README 的表格与其保持一致）；复查分工的实现见 `src/index.ts` 的 `makeCommandGuard` / `runRound`。

## 测试

```sh
npm run check   # 类型检查（tsc --noEmit，strict）
npm run build   # 编译到 dist/
npm run test    # node --test（45 例：engine / persist / controller，注入时钟与测量）
npm run smoke   # 宿主联调：profile 引导 + headless 连跑三轮 + 状态文件断言
```

`npm run smoke` 需本机可用 dsh 0.2.0-rc.2 与模型凭据。
