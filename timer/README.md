# timer

DSH（DeepSeek Harness）进程内定时器统一面：以服务 `clock` 提供「读钟 + 排期」，**排期随调用方插件的 fiber 卸载自动撤销**；带可手控假时钟，测试不必真等。

## 为什么有这个包

本仓多处各管定时器、或按不同假设读宿主 `ctx.timer`：

- `background-daemon` 的 `TimerLike` 假设 `schedule(delay, cb)`，而宿主 `cordis-plugin-timer` 只有 `timeout(cb, delay)` / `interval(cb, delay)` —— 真机报 `timer.schedule is not a function`；
- `session-channel` 心跳自己 `setInterval` + `unref`；`TUI` 的 `StatusTicker` 自己 `setInterval`；`metric-loop` 的 cadence 直接读 `Date.now`。

宿主面也不适合直接包装：它返回的只有 disposer（拿不到句柄，无法 `unref`），mixin 需要消费方声明 `inject: ["timer"]`（cordis 没有可选注入），参数序还与仓内既有 `TimerLike` 相反。故本包按仓内语义自实现，与宿主 timer **并存**：宿主面继续服务官方插件，本包服务本仓消费方。

## 服务面

`ctx.get("clock")`：

| 方法 | 语义 |
| --- | --- |
| `now()` | 当前时刻（毫秒时间戳）；假时钟注入时同步推进 |
| `scope(ctx?)` | 按调用方 ctx 造一组 `Timers`：`schedule` / `interval` 的撤销动作登记到该 ctx 的 `effect`，调用方插件卸载即清；省略 ctx 时只能靠返回的 disposer 撤销 |

`Timers`（`scope` 的返回值，也是纯函数 `createTimers()` 的返回类型）：

| 方法 | 语义 |
| --- | --- |
| `now()` | 与服务的 `now()` 同源 |
| `schedule(delayMs, callback)` | 过 `delayMs` 毫秒调用一次；返回幂等 disposer |
| `interval(delayMs, callback)` | 每 `delayMs` 毫秒调用一次；返回幂等 disposer |

延迟为负按 0 处理（与 `setTimeout` 一致），非有限数抛 `RangeError`。定时器句柄默认 `unref`：不阻止进程退出。

纯函数 `createTimers(options)` 同时具名导出（`import { createTimers } from "@dsh-toolset/timer"`），无宿主 ctx 的场景（TUI demo / 单测）可直接用。

## 假时钟

`ManualClock`（`export class`）实现同一 `Timers` 接口，`advance(ms)` 把表往前拨并按到期顺序触发：

- 同一时刻到期的多个排期按插入顺序触发；
- 回调里新排的期（到期不晚于本次 target）会在同一次 `advance` 内触发；
- 支持回调内撤销自己 / 别的排期；`pending` 给出仍在排期的条目数；
- 0 间隔的重复排期有步数上限（`MAX_ADVANCE_STEPS`），防测试挂死。

消费方测试可以直接 `new ManualClock(start)` 当 `clock` 用（它自己带 `now` / `scope`，`scope()` 返回自身），把「读钟」与「排期」一起钉在假表上。

## 用法

消费方不 import 本包（仓内包彼此零运行时依赖），按结构化类型读服务：

```ts
const clock = readService<ClockLike>(ctx, "clock");
const timers = clock?.scope(ctx) ?? createTimers(); // 未挂载时回落进程内定时器
const dispose = timers.schedule(1_000, () => { /* 到点做事 */ });
// 插件卸载时：若走了 scope(ctx)，无需手动 dispose；否则调用方自己 dispose。
```

挂载顺序：`clock` 应排在使用方之前激活（`scripts/install.sh` 的 `canonical_pkgs` 已把 `timer` 置首）。使用方对 `clock` 一律**可选读取**（不进 `inject`），未挂载时回落各自原有的进程内定时器。

## 配置

无。`cordis.patch.yml` 只做一条 `insert`：

```yaml
- insert:
    - id: timer
      name: '@dsh-toolset/timer'
```

## 与宿主 `cordis-plugin-timer` 的关系

**并存，不包装、不替代**：服务名刻意用 `clock`（宿主没有该服务），宿主 `timer` / `ctx.timeout` / `ctx.interval` 原样保留给官方插件。若将来宿主补齐「返回句柄 / 可 unref」，只需改 `src/timers.ts` 一处，服务面不变。

## 测试

```sh
npm run check   # 类型检查（src + tests）
npm test        # 手控假时钟 / 真实定时器 / fiber 卸载清理 / 服务注册
```

## 边界

1. 不做日历 / cron / 时区算术：本包只管「过多久」，`at` / `daily` / `weekly` 等选择器在 `background-daemon`（含时区与夏令时处理）。
2. 不做 `sleep` / `debounce` / `throttle`：暂无消费方，需要时再加。
3. 不做持久化与补偿：进程重启后不恢复未触发的排期（那是 `background-daemon` 的任务表职责）。
4. 不读宿主 `ctx.timer`：宿主服务缺失、版本变动都不影响本包加载。
