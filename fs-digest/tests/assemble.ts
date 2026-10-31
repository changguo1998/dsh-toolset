/**
 * 集成层装配器: 用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`.
 *
 * 三个假面的形状按总追踪 4.2 的口径 (工具 / 事件 / 服务), 本文件不以 `.test.ts` 结尾,
 * 也不计入覆盖率 (dev/coverage 只统 `src`). 集成用例一律经本装配器接宿主,
 * 不直接 import 宿主运行时.
 */

import { apply } from "../src/index.ts";

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

/** 装配后的宿主句柄. */
export interface AssembledHost {
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
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

/** 装配 `apply`: 三个假面 + 按名取工具的句柄. */
export function assemble(
  options: {
    services?: Record<string, unknown>;
    config?: ApplyConfig;
  } = {},
): AssembledHost {
  const toolSurface = createToolSurface();
  const events = createEventSurface();
  const services = createServiceSurface(options.services);
  const ctx = {
    tools: {
      register: (def: ToolDefLike): void => {
        toolSurface.defs.push(def);
      },
    },
    on: events.on,
    get: (name: string): unknown => services.get(name),
  };
  apply(ctx as Parameters<typeof apply>[0], options.config ?? {});
  return { tools: toolSurface.surface, events, services, ctx };
}

/** 取工具渲染文本 (契约: args 第一、value 第二). */
export function renderText(
  tool: ToolDefLike,
  value: unknown,
  args: unknown = {},
): string {
  return tool.output.render(args, value)[0]?.text ?? "";
}
