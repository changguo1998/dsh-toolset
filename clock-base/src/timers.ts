/**
 * 定时器统一面核心（纯实现，不依赖宿主 / cordis）。
 *
 * 两个实现同一接口 `Timers`：
 * - `createTimers(options)`：真实定时器（`setTimeout` / `setInterval`）。给了调用方 `ctx`
 *   就把撤销动作登记到该 ctx 的 `effect` 上 —— 调用方插件卸载时定时器一起清掉，不泄漏；
 *   定时器句柄默认 `unref`（不拖住进程退出，与 `session-channel` / `background-daemon`
 *   的既有口径一致）。没有 `effect` 的极简 ctx（单测 / 纯函数场景）退化为只认返回的
 *   disposer。
 * - `ManualClock`：手控假时钟。`advance(ms)` 把表往前拨并按到期顺序触发回调（回调里再
 *   排期、或 interval 自我撤销都能正确处理），测试不必真等。
 *
 * 另带跨包公共接线层（`resolveClock` / `createDeadline` / `systemTimers` 等）: 消费方读
 * `clock` 服务, 服务缺席时回落进程内定时器, 不必各留一份副本.
 *
 * 为什么自己实现而不包装宿主 `cordis-plugin-timer`：宿主只提供 `timeout(cb, delay)` /
 * `interval(cb, delay)`，没有 `schedule(delay, cb)`；只返回 disposer、拿不到句柄因此无法
 * `unref`；且它的 mixin 需要调用方声明 `inject: ["timer"]`（cordis 无可选注入）。详见
 * 追踪文档 `docs/implementation/2026-10-19-timer-plugin.md` 的「决策项 3」。
 */

/** 取消句柄（幂等）：调用一次即撤销对应排期，重复调用无副作用。 */
export type Disposer = () => void;

/** 统一面：读钟 + 一次性排期 + 重复排期。参数序与仓内既有 `TimerLike` 一致（延迟在前）。 */
export interface Timers {
  /** 当前时刻（毫秒时间戳）；假时钟下由 `advance` 推进。 */
  now(): number;
  /** 过 `delayMs` 毫秒调用一次；返回撤销句柄。 */
  schedule(delayMs: number, callback: () => void): Disposer;
  /** 每 `delayMs` 毫秒调用一次；返回撤销句柄。 */
  interval(delayMs: number, callback: () => void): Disposer;
}

/** `createTimers` 选项。 */
export interface CreateTimersOptions {
  /** 调用方 ctx（cordis 上下文）：提供且带 `effect` 时，排期随该 fiber 卸载撤销。 */
  ctx?: unknown;
  /** 时钟源（缺省 `Date.now`）；与 `ManualClock.now` 同源即可让排期与读钟共用一个假表。 */
  now?: () => number;
  /** 是否 `unref` 定时器句柄（缺省 true：不阻止进程退出）。 */
  unref?: boolean;
}

/** 延迟归一：负数按 0（与 `setTimeout` 一致），非有限数直接报错（调用方算错时早暴露）。 */
export function resolveDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    throw new RangeError(
      `timers: 延迟必须是有限数字（收到 ${String(delayMs)}）`,
    );
  }
  return delayMs < 0 ? 0 : delayMs;
}

/** 真实定时器实现（`unref` 缺省开启）。 */
export function createTimers(options: CreateTimersOptions = {}): Timers {
  const readNow = options.now ?? Date.now;
  const unref = options.unref !== false;

  return {
    now: () => readNow(),
    schedule(delayMs, callback) {
      let handle: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const stop: Disposer = () => {
        if (done) return;
        done = true;
        if (handle !== undefined) clearTimeout(handle);
      };
      handle = setTimeout(() => {
        if (done) return;
        done = true;
        callback();
      }, resolveDelay(delayMs));
      if (unref) handle.unref?.();
      attachEffect(options.ctx, stop, "clock.timer");
      return stop;
    },
    interval(delayMs, callback) {
      let handle: ReturnType<typeof setInterval> | undefined;
      let done = false;
      const stop: Disposer = () => {
        if (done) return;
        done = true;
        if (handle !== undefined) clearInterval(handle);
      };
      handle = setInterval(() => {
        if (done) return;
        callback();
      }, resolveDelay(delayMs));
      if (unref) handle.unref?.();
      attachEffect(options.ctx, stop, "clock.timer");
      return stop;
    },
  };
}

/** `advance` 单次调用内的最大触发步数（防 0 间隔重复排期把测试挂死）。 */
export const MAX_ADVANCE_STEPS = 100_000;

interface ManualEntry {
  /** 绝对到期时刻。 */
  at: number;
  delay: number;
  callback: () => void;
  /** 是否重复。 */
  interval: boolean;
  disposed: boolean;
  /** 同刻到期的先后（插入序）。 */
  seq: number;
}

/**
 * 手控假时钟：`now()` 初值可给（缺省 0），`advance(ms)` 推进并按到期顺序触发。
 *
 * - 同一时刻到期的多个排期按插入顺序触发；
 * - 回调里新排的期（到期时刻不晚于本次 target）会在同一次 `advance` 内触发；
 * - interval 回调内自我撤销、或撤销别的排期都按当下状态生效。
 */
export class ManualClock implements Timers {
  #now: number;
  #seq = 0;
  #entries: ManualEntry[] = [];

  constructor(startMs = 0) {
    if (!Number.isFinite(startMs)) {
      throw new RangeError(
        `ManualClock: 起始时刻必须是有限数字（收到 ${String(startMs)}）`,
      );
    }
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  /** 仍在排期中的条目数（已撤销 / 已触发的一次性不算）。 */
  get pending(): number {
    return this.#entries.filter((entry) => !entry.disposed).length;
  }

  schedule(delayMs: number, callback: () => void): Disposer {
    return this.#add(delayMs, callback, false);
  }

  interval(delayMs: number, callback: () => void): Disposer {
    return this.#add(delayMs, callback, true);
  }

  /** 把表往前拨 `ms` 毫秒（负数 / 非有限数报错），按到期顺序触发回调。 */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(
        `ManualClock.advance: 只接受非负有限毫秒（收到 ${String(ms)}）`,
      );
    }
    const target = this.#now + ms;
    for (let steps = 0; steps <= MAX_ADVANCE_STEPS; steps += 1) {
      const due = this.#nextDue(target);
      if (due === undefined) {
        this.#now = target;
        return;
      }
      this.#now = due.at;
      if (due.interval) due.at += due.delay;
      else due.disposed = true;
      due.callback();
    }
    throw new Error(
      "ManualClock.advance: 单次推进触发步数过多（疑似 0 间隔的重复排期）",
    );
  }

  #add(delayMs: number, callback: () => void, interval: boolean): Disposer {
    const delay = resolveDelay(delayMs);
    const entry: ManualEntry = {
      at: this.#now + delay,
      delay,
      callback,
      interval,
      disposed: false,
      seq: this.#seq,
    };
    this.#seq += 1;
    this.#entries.push(entry);
    return () => {
      entry.disposed = true;
    };
  }

  #nextDue(target: number): ManualEntry | undefined {
    let due: ManualEntry | undefined;
    for (const entry of this.#entries) {
      if (entry.disposed || entry.at > target) continue;
      if (
        due === undefined ||
        entry.at < due.at ||
        (entry.at === due.at && entry.seq < due.seq)
      ) {
        due = entry;
      }
    }
    return due;
  }
}

// ---------------------------------------------------------------------------
// 跨包公共接线层: 读 `clock` 服务, 缺席时回落进程内定时器
//
// 这些函数原先在 ast-tools / auto-approve / task-engine 等包里各有一份副本;
// 现收拢到本包作为公共版本, 消费方从入口导入, 不再复制.
// ---------------------------------------------------------------------------

/** 排期器（`clock.scope()` 的返回值; 结构子集, 与 `Timers` 同形）. */
export type TimersLike = Timers;

/** `clock` 服务面（`scope(ctx)` 把撤销动作登记到调用方 fiber）. */
interface ClockLike {
  now(): number;
  scope(ctx?: unknown): TimersLike;
}

/** 超时触发原因: 正常到点 / 插件卸载. */
export type DeadlineReason = "timeout" | "unload";

/** 操作级超时排期: 返回取消句柄（操作正常收尾时调用）. */
export type Deadline = (
  delayMs: number,
  fire: (reason: DeadlineReason) => void,
) => () => void;

/** 统一面解析结果. */
export interface ClockTimers {
  /** 绑定本插件 fiber 的排期器（卸载即撤销）. */
  readonly scoped: TimersLike;
  /** 不绑定 fiber 的排期器（操作级等待用, 调用方自己撤销）. */
  readonly detached: TimersLike;
  /** 是否来自 `clock` 服务（false = 进程内回落）. */
  readonly fromClock: boolean;
}

/** 延迟归一（`resolveDelay` 的公共别名; 负数按 0, 非有限数报错）. */
export function delayOf(delayMs: number): number {
  return resolveDelay(delayMs);
}

/** 进程内回落: `unref` 不拖住进程退出（与本包既有裸定时器口径一致）. */
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

/** 结构面校验: `now` / `schedule` / `interval` 三个方法都在才认. */
export function isTimers(value: unknown): value is TimersLike {
  if (value === null || typeof value !== "object") return false;
  const timers = value as Partial<TimersLike>;
  return (
    typeof timers.now === "function" &&
    typeof timers.schedule === "function" &&
    typeof timers.interval === "function"
  );
}

/** 受保护读 `ctx.get("clock")`（未 inject 的服务直读会抛, 故只走 get）. */
export function readClock(ctx: unknown): ClockLike | undefined {
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
 * 读定时器统一面. `clock` 可用时造两组排期器（`scoped` 绑定本插件 ctx,
 * `detached` 不绑定）; 缺失 / 形状不符 / `scope` 抛错 → 进程内回落并告警一次.
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
      // 形状不符 / scope 抛错: 走回落（可选服务不影响加载）.
    }
  }
  warn(
    "clock 服务不可用, 回落进程内定时器（排期不随插件卸载撤销; 本条每个插件实例只告警一次）",
  );
  const fallback = systemTimers();
  return { scoped: fallback, detached: fallback, fromClock: false };
}

/** effect 的 disposer 可能返回 Promise（cordis）: 静默跑完, 卸载期不抛. */
export function runDisposer(dispose: (() => unknown) | undefined): void {
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
    // 已卸载 / 形状不符: 忽略.
  }
}

/**
 * 把撤销动作登记到调用方 ctx 的 fiber 上（没有 `effect` / 形状不符时静默跳过）.
 * 形状与 cordis 一致: `ctx.effect(() => disposer, label)` —— 工厂立即执行, 返回的
 * disposer 在 fiber 卸载时调用. 返回该 disposer（拿不到时 undefined）.
 */
export function attachEffect(
  ctx: unknown,
  run: () => void,
  label?: string,
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
    const dispose = (
      effect as (factory: () => () => void, label?: string) => unknown
    ).call(ctx, () => run, label);
    return typeof dispose === "function"
      ? (dispose as () => unknown)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 造操作级超时排期. 卸载时立即按超时路径收尾（`fire("unload")`）并撤销排期,
 * 因此插件卸载后不会留下未触发的超时; 正常收尾调用返回的取消句柄即可.
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
