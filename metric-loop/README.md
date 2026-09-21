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
- 结果含 `schedule` 提示（运行中为 `schedule_create` 的 `after_seconds` + `prompt`，已停止为 `null`）与一句话 `summary`。

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

宿主联调（smoke 幂等引导 profile `metric-loop`，并把 `stateDir` 重定向到临时目录）：

```sh
npm run smoke   # dsh headless 连跑三轮，断言跨进程状态与 plateau 停止
```

## 边界与限制

- 自动唤醒复用宿主 schedule 面：插件只返回 `schedule_create` 参数，由宿主按提示排下一次唤醒（`after_seconds` 一次性提醒链式续排）；不新建调度器。
- 轮内做什么改进动作（循环载体）由宿主 workflow / 会话编排，插件不感知。
- 跨进程语义依赖状态文件：每次 `dsh` 启动或 schedule 唤醒加载状态推进一轮；文件缺失视为循环不存在（`tick`/`stop` 报错，`status` 返回 `exists: false`）。
- 测量命令经 `/bin/sh -c` 执行，取 stdout 中最后一个数字（容忍 `score: 0.87` 等噪声）；信任契约内命令，不做沙箱隔离。
- metricless 循环不判 plateau，只按轮数/时间/token 边界或手动停止。

## 测试

```sh
npm run check   # 类型检查（tsc --noEmit，strict）
npm run build   # 编译到 dist/
npm run test    # node --test（35 例：engine / persist / controller，注入时钟与测量）
npm run smoke   # 宿主联调：profile 引导 + headless 连跑三轮 + 状态文件断言
```

`npm run smoke` 需本机可用 dsh 0.1.5-rc.2 与模型凭据。
