# @dsh-toolset/dsh-metric-loop

DSH（DeepSeek Harness）进程内集成插件：指标驱动的自动循环。循环状态持久化为 JSON，
每次 `dsh` headless 启动 / schedule 唤醒即推进一轮：执行用户提供的测量命令（stdout 解析
单个数字），按方向比较历史最优，连续 `window` 轮无改进则 plateau 停止。

- 任务契约：`TASK.md`；实现契约：`DSH-CTX-API.md`（跨插件共享研读笔记，只读），当前对齐版本 0.1.5-rc.2。
- 停止语义：`plateau`（仅带测量命令的循环）/ `maxRounds`（默认 50）/ `time`（可选，毫秒）/
  `tokens`（可选，累计）/ `manual`。优先级：plateau > maxRounds > time > tokens。
- `cadence`：成功后自动唤醒的最小间隔（秒），仅节流 `wake=auto`；显式 start/resume（`wake=explicit`）
  为紧急唤醒，不受限。
- `metricless`：无测量命令（缺省或空串）时不做 plateau 判定，只按边界停止。

## 命令

```sh
npm run check   # 类型检查（tsc --noEmit，strict）
npm run build   # 编译到 dist/
npm run test    # 运行 tests/*.test.ts（node --test，31 项）
npm run smoke   # 宿主联调：profile 引导 + headless 连跑三轮 + 状态文件断言（约 1-3 分钟）
```

## 结构

- `src/types.ts` — 共享类型（LoopSpec/LoopState/RoundRecord/TickResult）
- `src/engine.ts` — 纯函数核心：isBetter/normalizeSpec/advance（plateau + 边界）/cadence/nextWakeMs/scheduleHint
- `src/measure.ts` — 测量命令执行（/bin/sh -c，默认 30s 超时）与 stdout 单数字解析
- `src/persist.ts` — 状态文件原子读写（tmp+rename）、id 归一化、history 截断（500 条）
- `src/index.ts` — DSH bundle 接入面：`metric_loop` 工具（start/tick/status/stop）、MetricLoopController、apply 防御降级
- `tests/` — engine/persist/controller 单测（注入时钟与测量，无宿主依赖）
- `smoke/smoke.mjs` — 宿主联调 smoke（自动化验收门）

## 宿主联调（smoke）

`npm run smoke` 全自动化（约 1-3 分钟，需本机可用 dsh 0.1.5-rc.2 与模型凭据）：

1. 幂等引导独立 profile `dsh-metric-loop`（headless 模板；`dsh plugin add` 以 `link:` 挂载本包；
   用户层 `cordis.patch.yml` 配置 stateDir——`METRIC_LOOP_STATE_DIR` 环境变量可重定向，
   缺省 `~/.dsh/metric-loop`）；
1. 缺 `dist/` 自动构建；
1. 真实 dsh headless 连跑三次，每次恰好推进一轮（常量指标 `echo 42`，window=2）：
   R1 start（第 1 轮基线，running）→ R2 tick（streak=1，running）→ R3 tick（streak=2 → plateau 停止）；
1. 每轮后断言状态文件（跨进程持久化）：rounds 递增、终态 `stopped/plateau/rounds=3/best=42`、
   history 三条（首条 improved，后续无改进）。

profile 属机器级配置（`~/.dsh/profiles/`），不入库；smoke 会幂等重建/刷新其用户层配置。

## 使用（模型侧）

宿主内 `metric_loop` 工具：

- `start`：`{action:"start", id, measureCmd, direction?, window?, maxRounds?, timeBoundMs?, tokenBound?, cadenceSec?}`，
  新建循环并跑第一轮（显式唤醒）。
- `tick`：`{action:"tick", id, wake?("auto"|"explicit"), tokensUsed?}`，推进一轮；
  `wake=auto` 受 cadence 节流（未到期返回 `deferred=true`，不消耗轮次）。
- `status` / `stop`：只读状态 / 手动停止。

结果含 `schedule` 提示：运行中按提示的 `schedule_create` 参数（`after_seconds`）排下次自动唤醒；
已停止为 `null`。循环载体（轮内做什么改进动作）由宿主 workflow/会话编排，本插件不感知。

## 状态

> 状态：核心语义（direction/window plateau、maxRounds/time/tokens 边界、cadence 节流、metricless、
> 手动停止、跨进程状态持久化）已实现；31/31 测试通过，`check/build` 退出 0；宿主联调完成
> （profile `dsh-metric-loop` + `npm run smoke` 全链路 PASS，含 headless 连跑一轮循环 + plateau 停止断言）。
