/**
 * timer 插件入口（DSH bundle 接入面）：把统一面挂成服务 `clock`。
 *
 * 角色：本仓「排期 + 读钟」的唯一来源。消费方（`background-daemon` 的调度器、
 * `session-channel` 的心跳、`metric-loop` 的 cadence、`TUI` 的 `StatusTicker`）经
 * `ctx.get("clock")` 读取，不再各自 `setInterval` / 假设宿主 `ctx.timer` 有 `schedule`。
 *
 * 服务面（`ctx.get("clock")`，结构化类型，消费方不 import 本包）：
 * - `now()`：当前时刻（假时钟注入时同步推进）；
 * - `scope(ctx)`：按调用方 ctx 造一组 `Timers` —— `schedule` / `interval` 的撤销动作
 *   登记在该 ctx 的 `effect` 上，调用方插件卸载即清，不泄漏；也返回自己的 `now()`。
 *
 * 与宿主 `cordis-plugin-timer` 的关系：**并存**，不包装、不替代。宿主只提供
 * `timeout(cb, delay)` / `interval(cb, delay)`（无 `schedule`、不支持 `unref`、mixin 需
 * 声明 `inject`），本包按仓内语义自实现（见 `src/timers.ts` 文件头）。
 *
 * 宿主依赖姿态：不写进 `inject`，`apply` 只接收 ctx；没有宿主也照常加载（服务面即可用）。
 */

import { createTimers, ManualClock } from "./timers.ts";
import type { CreateTimersOptions, Disposer, Timers } from "./timers.ts";

export { createTimers, ManualClock, resolveDelay } from "./timers.ts";
export type { CreateTimersOptions, Disposer, Timers } from "./timers.ts";

/** bundle 条目 id（与 cordis.patch.yml / profile 层一致）。 */
export const name = "timer-toolset";

/** 服务面挂载声明：其他插件经 `ctx.get("clock")` 取用（刻意不叫 `timer`，避开宿主服务）。 */
export const provide = ["clock"];

/** 服务面（`ctx.get("clock")`）；边界语义见文件头。 */
export interface Clock {
  /** 当前时刻（毫秒时间戳）。 */
  now(): number;
  /**
   * 按调用方 ctx 造一组排期器：给了带 `effect` 的 ctx 时，排期随该 fiber 卸载撤销；
   * 省略 ctx 时只能靠返回的 disposer 撤销。
   */
  scope(ctx?: unknown): Timers;
}

/** 服务实现：时钟源可注入（测试给假表；生产缺省 `Date.now`）。 */
export class ClockService implements Clock {
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  now(): number {
    return this.#now();
  }

  scope(ctx?: unknown): Timers {
    const options: CreateTimersOptions = { now: this.#now };
    if (ctx !== undefined) options.ctx = ctx;
    return createTimers(options);
  }
}

/**
 * 挂载：把服务面挂到 ctx（cordis `provide`）；极简 ctx 无 `provide` 时退回直接属性挂载
 * （与 `session-paths` 同套路）。重复挂载（同 id 两个条目）时 cordis 会抛
 * 「already registered」，只告警、不掀翻宿主启动。
 */
export function apply(ctx: unknown): void {
  const service = new ClockService();
  const container = (ctx ?? {}) as { provide?: unknown };
  let provideFn: ((serviceName: string, value: unknown) => unknown) | undefined;
  try {
    const candidate = container.provide;
    if (typeof candidate === "function") {
      provideFn = candidate as (serviceName: string, value: unknown) => unknown;
    }
  } catch {
    provideFn = undefined;
  }
  if (provideFn !== undefined) {
    try {
      provideFn.call(ctx, "clock", service);
    } catch (error) {
      process.stderr.write(
        `[timer] warn: 服务面 clock 注册失败：${String(error)}\n`,
      );
    }
    return;
  }
  if (ctx === null || typeof ctx !== "object") {
    process.stderr.write("[timer] warn: ctx 无 provide，服务面 clock 未注册\n");
    return;
  }
  try {
    (ctx as Record<string, unknown>)["clock"] = service;
  } catch (error) {
    process.stderr.write(
      `[timer] warn: 服务面 clock 注册失败：${String(error)}\n`,
    );
  }
}
