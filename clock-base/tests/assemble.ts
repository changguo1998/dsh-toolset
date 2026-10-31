/**
 * 集成层装配器：用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`。
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务），本文件不以 `.test.ts` 结尾，
 * 也不计入覆盖率（dev/coverage 只统 `src`）。集成用例一律经本装配器接宿主，
 * 不直接 import 宿主运行时。
 *
 * 时钟源：`apply` 产出的 `ClockService` 缺省读系统时钟（`Date.now`），装配器不替换它；
 * 需要确定时间的用例直接用本包入口导出的 `ManualClock`，不 mock `Date.now`。
 */

import { apply } from "../src/index.ts";
import type { Clock } from "../src/index.ts";

/** 工具定义的最小结构面（`ctx.tools.register` 的入参形状）。 */
export interface ToolDefLike {
  name: string;
  description: string;
  parameters: {
    type: string;
    required?: string[];
    properties: Record<string, unknown>;
  };
  execute(args: Record<string, unknown>): Promise<unknown>;
  output: {
    schema: { type: string };
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

/** 假工具面：收集注册定义，按名取用。 */
export interface ToolSurface {
  readonly defs: ToolDefLike[];
  names(): string[];
  require(name: string): ToolDefLike;
}

/** 假事件面：记录订阅（本包无事件消费者，用零订阅做断言）。 */
export interface EventSurface {
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): number;
  listenerCount(event?: string): number;
}

/** 假服务面：宿主 `ctx.get` / `ctx.provide` 的替身（同名重复注册即抛错，与 cordis 一致）。 */
export interface ServiceSurface {
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  names(): string[];
}

/** 装配形态：完整宿主 / 无 `provide` / 空 ctx。 */
export type HostShape = "full" | "no-provide" | "empty";

/** 装配后的宿主句柄。 */
export interface AssembledHost {
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  readonly logs: { info: string[]; warn: string[] };
  /** `apply` 写到 stderr 的告警行（降级与重复注册两种）。 */
  readonly stderr: string[];
  /** `ctx.effect` 登记过的标签（本包只应出现 `clock.timer`）。 */
  readonly effectLabels: string[];
  /** 装配时用的 ctx（`empty` 形态为 undefined）。 */
  readonly ctx: unknown;
  /** 取服务面 `clock`；未注册时抛错，便于用例直接失败。 */
  clock(): Clock;
  /** 模拟 fiber 卸载：逆序调用登记的撤销动作（幂等）。 */
  unload(): void;
}

export function createServiceSurface(
  initial: Record<string, unknown> = {},
): ServiceSurface {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    provide(name, value) {
      if (values.has(name)) {
        throw new Error(`service "${name}" already registered`);
      }
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

/** 临时替换 stderr.write，返回收集到的行。 */
export function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

/** 装配 `apply`：三个假面 + 日志记录 + effect 卸载。 */
export function assemble(options: { shape?: HostShape } = {}): AssembledHost {
  const shape = options.shape ?? "full";
  const services = createServiceSurface();
  const events = createEventSurface();
  const defs: ToolDefLike[] = [];
  const logs = { info: [] as string[], warn: [] as string[] };
  const disposers: Array<() => unknown> = [];
  const effectLabels: string[] = [];

  const base = {
    get: (name: string): unknown => services.get(name),
    effect(fn: () => () => void, label?: string): () => void {
      effectLabels.push(label ?? "");
      const dispose = fn();
      disposers.push(dispose);
      return () => {
        void dispose();
      };
    },
    logger: (ns: string) => ({
      info: (message: string): void => {
        logs.info.push(`${ns}: ${message}`);
      },
      warn: (message: string): void => {
        logs.warn.push(`${ns}: ${message}`);
      },
    }),
    tools: {
      register: (def: unknown): void => {
        defs.push(def as ToolDefLike);
      },
    },
    on: (event: string, listener: (payload: unknown) => void): (() => void) =>
      events.on(event, listener),
  };

  let ctx: unknown;
  if (shape === "empty") {
    ctx = undefined;
  } else if (shape === "no-provide") {
    ctx = base;
  } else {
    ctx = {
      ...base,
      provide: (name: string, value: unknown): void => {
        services.provide(name, value);
      },
    };
  }

  const stderr = captureStderr(() => apply(ctx));

  const tools: ToolSurface = {
    defs,
    names: () => defs.map((def) => def.name),
    require(name) {
      const found = defs.find((def) => def.name === name);
      if (found === undefined) throw new Error(`未注册工具：${name}`);
      return found;
    },
  };

  return {
    tools,
    events,
    services,
    logs,
    stderr,
    effectLabels,
    ctx,
    clock(): Clock {
      const value =
        services.get("clock") ??
        (typeof ctx === "object" && ctx !== null
          ? (ctx as Record<string, unknown>)["clock"]
          : undefined);
      if (value === undefined) throw new Error("服务面 clock 未注册");
      return value as Clock;
    },
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
  };
}
