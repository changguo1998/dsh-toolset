/**
 * 集成层装配器: 用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`.
 *
 * 三个假面的形状按总追踪 4.2 的口径 (工具 / 事件 / 服务); 时间用 `clock-base` 导出的
 * `ManualClock` 顶替真实时钟 (经 `clock` 服务面注入, 本包只消费 `now()`).
 * 本文件不以 `.test.ts` 结尾, 也不计入覆盖率 (dev/coverage 只统 `src`).
 */

import { apply } from "../src/index.ts";

/**
 * `clock-base` 导出的 `ManualClock`: 静态 import 会把对端源码拉进本包 `tsconfig` 的
 * 编译范围 (rootDir 之外, TS6059), 故用**非字面量** URL 动态取同一个类; 形状由本文件
 * 的结构接口兜住 (只有 `now()` / `advance(ms)` 用于本包集成层).
 */
export interface ManualClockLike {
  now(): number;
  advance(ms: number): void;
}

const { ManualClock } = (await import(
  new URL("../../clock-base/src/index.ts", import.meta.url).href
)) as { ManualClock: new (startMs?: number) => ManualClockLike };

/** apply 的配置形态 (与 `src/index.ts` 的 `Config` 同形, 不跨包引类型). */
export type ApplyConfig = NonNullable<Parameters<typeof apply>[1]>;

/** 工具定义的最小结构面 (`ctx.tools.register` 的入参形状). */
export interface ToolDefLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>;
  output: {
    schema: Record<string, unknown>;
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

/** 假工具面: 收集注册定义, 按名取用. */
export interface ToolSurface {
  readonly defs: ToolDefLike[];
  names(): string[];
  require(name: string): ToolDefLike;
}

/** 假事件面: 记录订阅 (本包当前无事件消费者, 用零订阅做断言). */
export interface EventSurface {
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): number;
  listenerCount(event?: string): number;
}

/** 假服务面: 宿主 `ctx.get` 的替身. */
export interface ServiceSurface {
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  names(): string[];
}

/** 假时钟面: `ManualClock` 本体 + 形状与 `clock` 服务一致的只读视图. */
export interface ClockSurface {
  readonly manual: ManualClockLike;
  /** 注入到服务面 `clock` 的最小结构面 (`now()`); 与 clock-base 的服务面同形. */
  readonly service: { now(): number };
}

/** 装配后的宿主句柄. */
export interface AssembledHost {
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  readonly clock: ManualClockLike;
  /** 本包状态文件目录 (由 `config.stateDir` 给出). */
  readonly stateDir: string;
  readonly ctx: unknown;
}

export function createToolSurface(): {
  surface: ToolSurface;
  defs: ToolDefLike[];
} {
  const defs: ToolDefLike[] = [];
  return {
    defs,
    surface: {
      defs,
      names: () => defs.map((def) => def.name),
      require(name) {
        const found = defs.find((def) => def.name === name);
        if (found === undefined) throw new Error(`未注册工具: ${name}`);
        return found;
      },
    },
  };
}

export function createEventSurface(): EventSurface {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (set === undefined) return 0;
      for (const listener of [...set]) listener(payload);
      return set.size;
    },
    listenerCount(event) {
      if (event !== undefined) return listeners.get(event)?.size ?? 0;
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

export function createServiceSurface(
  initial: Record<string, unknown> = {},
): ServiceSurface {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    provide(name, value) {
      values.set(name, value);
    },
    get(name) {
      return values.get(name);
    },
    names() {
      return [...values.keys()];
    },
  };
}

/** 造假时钟 (缺省从 1000ms 起, 与既有单元用例同基线). */
export function createClockSurface(startMs = 1_000): ClockSurface {
  const manual = new ManualClock(startMs);
  return { manual, service: { now: () => manual.now() } };
}

/**
 * 装配 `apply`: 三个假面 + 按名取工具的句柄.
 *
 * `clock` 缺省注入 (本包的读钟走 `ctx.get('clock')`), 给数字即该起始时刻的假时钟,
 * 传 `clock: false` 可验证回落 `Date.now`; `services` 里的同名键会覆盖缺省注入.
 */
export function assemble(
  options: {
    services?: Record<string, unknown>;
    config?: ApplyConfig;
    clock?: ClockSurface | false | number;
  } = {},
): AssembledHost {
  const toolSurface = createToolSurface();
  const events = createEventSurface();
  const clockSurface: ClockSurface | undefined =
    options.clock === false
      ? undefined
      : typeof options.clock === "object"
        ? options.clock
        : createClockSurface(options.clock);
  const services = createServiceSurface({
    ...(clockSurface === undefined ? {} : { clock: clockSurface.service }),
    ...options.services,
  });
  const ctx = {
    tools: {
      register: (def: ToolDefLike): void => {
        toolSurface.defs.push(def);
      },
    },
    on: events.on,
    get: (name: string): unknown => services.get(name),
    provide: (name: string, value: unknown): void => {
      services.provide(name, value);
    },
  };
  apply(ctx as Parameters<typeof apply>[0], options.config ?? {});
  return {
    tools: toolSurface.surface,
    events,
    services,
    // clock 缺席时仍给一个假时钟占位 (用例不推进它), 便于统一句柄
    clock: clockSurface?.manual ?? new ManualClock(0),
    stateDir: options.config?.stateDir ?? "",
    ctx,
  };
}

/** 取工具渲染文本 (契约: args 第一、value 第二). */
export function renderText(
  tool: ToolDefLike,
  value: unknown,
  args: unknown = {},
): string {
  return tool.output.render(args, value)[0]?.text ?? "";
}
