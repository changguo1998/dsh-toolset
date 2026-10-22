/**
 * 定时器统一面接线（`timer` 插件的 `clock` 服务；结构面访问，不 import 该包）。
 *
 * 两件事：
 * - `resolveClock(ctx, warn)`：读 `clock`，按调用方 ctx 造「绑定 fiber」与「不绑定」两组
 *   排期器；服务缺失 / 形状不符 / `scope` 抛错 → 回落进程内定时器，并告警一次（调用方
 *   只在装配期调用一次，故天然是「每个插件实例一次」）。
 * - `createDeadline(timers, ctx)`：操作级超时。到点触发 `fire("timeout")`；插件卸载时
 *   立即触发 `fire("unload")` 并撤销排期——避免在途 socket 请求 / 子进程失去兜底而悬挂。
 *
 * 为什么本包各带一份：仓内包彼此零运行时依赖（跨包共享只能走 ctx 服务 + 结构面），
 * 与 `readService` 的多包复制同例。
 */

/** 排期器（`clock.scope()` 的返回值；结构子集）。 */
export interface TimersLike {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
  interval(delayMs: number, callback: () => void): () => void;
}

/** `clock` 服务面（`scope(ctx)` 把撤销动作登记到调用方 fiber）。 */
interface ClockLike {
  now(): number;
  scope(ctx?: unknown): TimersLike;
}

/** 超时触发原因：正常到点 / 插件卸载。 */
export type DeadlineReason = "timeout" | "unload";

/** 操作级超时排期：返回取消句柄（操作正常收尾时调用）。 */
export type Deadline = (
  delayMs: number,
  fire: (reason: DeadlineReason) => void,
) => () => void;

/** 统一面解析结果。 */
export interface ClockTimers {
  /** 绑定本插件 fiber 的排期器（卸载即撤销）。 */
  readonly scoped: TimersLike;
  /** 不绑定 fiber 的排期器（操作级等待用，调用方自己撤销）。 */
  readonly detached: TimersLike;
  /** 是否来自 `clock` 服务（false = 进程内回落）。 */
  readonly fromClock: boolean;
}

/** 延迟归一：负数按 0（与 `setTimeout` 一致），非有限数直接报错。 */
function delayOf(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    throw new RangeError(`定时器延迟必须是有限数字（收到 ${String(delayMs)}）`);
  }
  return delayMs < 0 ? 0 : delayMs;
}

/** 进程内回落：`unref` 不拖住进程退出（与本包原有裸定时器口径一致）。 */
export function systemTimers(): TimersLike {
  return {
    now: () => Date.now(),
    schedule(delayMs, callback) {
      const handle = setTimeout(callback, delayOf(delayMs));
      handle.unref?.();
      return () => clearTimeout(handle);
    },
    interval(delayMs, callback) {
      const handle = setInterval(callback, delayOf(delayMs));
      handle.unref?.();
      return () => clearInterval(handle);
    },
  };
}

/** 结构面校验：三个方法都在才认。 */
function isTimers(value: unknown): value is TimersLike {
  if (value === null || typeof value !== "object") return false;
  const timers = value as Partial<TimersLike>;
  return (
    typeof timers.now === "function" &&
    typeof timers.schedule === "function" &&
    typeof timers.interval === "function"
  );
}

/** 受保护读 `ctx.get("clock")`（未 inject 的服务直读会抛，故只走 get）。 */
function readClock(ctx: unknown): ClockLike | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  let get: unknown;
  try {
    get = (ctx as { get?: unknown }).get;
  } catch {
    return undefined;
  }
  if (typeof get !== "function") return undefined;
  try {
    const clock = (get as (name: string) => unknown).call(ctx, "clock") as
      Partial<ClockLike> | null | undefined;
    if (
      clock === null ||
      clock === undefined ||
      typeof clock.now !== "function" ||
      typeof clock.scope !== "function"
    ) {
      return undefined;
    }
    return clock as ClockLike;
  } catch {
    return undefined;
  }
}

/**
 * 读定时器统一面。`clock` 可用时造两组排期器（`scoped` 绑定本插件 ctx、`detached` 不绑定）；
 * 缺失 / 形状不符 / `scope` 抛错 → 进程内回落并告警一次。
 */
export function resolveClock(
  ctx: unknown,
  warn: (message: string) => void,
): ClockTimers {
  const clock = readClock(ctx);
  if (clock !== undefined) {
    try {
      const scoped = clock.scope(ctx);
      const detached = clock.scope();
      if (isTimers(scoped) && isTimers(detached)) {
        return { scoped, detached, fromClock: true };
      }
    } catch {
      // 形状不符 / scope 抛错：走回落（可选服务不影响加载）。
    }
  }
  warn(
    "clock 服务不可用，回落进程内定时器（排期不随插件卸载撤销；本条每个插件实例只告警一次）",
  );
  const fallback = systemTimers();
  return { scoped: fallback, detached: fallback, fromClock: false };
}

/** effect 的 disposer 可能是返回 Promise 的函数（cordis）：静默跑完，卸载期不抛。 */
function runDisposer(dispose: (() => unknown) | undefined): void {
  if (dispose === undefined) return;
  try {
    const result = dispose();
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      void (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    // 已卸载 / 形状不符：忽略。
  }
}

/** 注册卸载回调；ctx 无 `effect`（极简测试宿主）时返回 undefined。 */
function attachEffect(
  ctx: unknown,
  run: () => void,
): (() => unknown) | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  let effect: unknown;
  try {
    effect = (ctx as { effect?: unknown }).effect;
  } catch {
    return undefined;
  }
  if (typeof effect !== "function") return undefined;
  try {
    const dispose = (effect as (fn: () => () => void) => unknown).call(
      ctx,
      () => run,
    );
    return typeof dispose === "function"
      ? (dispose as () => unknown)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 造操作级超时排期。卸载时立即按超时路径收尾（`fire("unload")`）并撤销排期，
 * 因此插件卸载后不会留下未触发的超时；正常收尾调用返回的取消句柄即可。
 */
export function createDeadline(timers: TimersLike, ctx: unknown): Deadline {
  return (delayMs, fire) => {
    let armed = true;
    const stop = timers.schedule(delayMs, () => {
      if (!armed) return;
      armed = false;
      fire("timeout");
    });
    const detach = attachEffect(ctx, () => {
      if (!armed) return;
      armed = false;
      stop();
      fire("unload");
    });
    return () => {
      if (!armed) return;
      armed = false;
      stop();
      runDisposer(detach);
    };
  };
}
