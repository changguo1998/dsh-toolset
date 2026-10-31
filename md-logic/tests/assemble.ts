/**
 * 集成层装配器：用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`。
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务）；本文件不以 `.test.ts` 结尾，
 * 也不计入覆盖率（dev/coverage 只统 `src`）。集成用例一律经本装配器接宿主，
 * 不直接 import 宿主运行时。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../src/index.ts";
import type { MdLogicConfig } from "../src/index.ts";

/** 工具定义的最小结构面（`ctx.tools.register` 的入参形状）。 */
export interface ToolDefLike {
  name: string;
  description: string;
  parameters: {
    type: string;
    required?: string[];
    properties: Record<string, unknown>;
  };
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  output: {
    schema: { type: string; additionalProperties?: boolean };
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

/** 假事件面：记录订阅（本包当前无事件消费者，用零订阅做断言）。 */
export interface EventSurface {
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): number;
  listenerCount(event?: string): number;
}

/** 假服务面：宿主 `ctx.get` 的替身。 */
export interface ServiceSurface {
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  names(): string[];
}

/** 装配后的宿主句柄。 */
export interface AssembledHost {
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  readonly logs: { info: string[]; warn: string[] };
  readonly ctx: unknown;
  unload(): void;
}

/** 装配选项：可关掉工具面 / 日志面，验证 `apply` 的可选依赖降级。 */
export interface AssembleOptions {
  config?: MdLogicConfig;
  /** false = 不提供 `ctx.tools`（apply 应静默跳过注册）。 */
  tools?: boolean;
  /** false = 不提供 `ctx.logger`（apply 应静默跳过日志）。 */
  logger?: boolean;
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

/** 装配 `apply`：三个假面 + 日志记录 + effect 卸载。 */
export function assemble(options: AssembleOptions = {}): AssembledHost {
  const services = createServiceSurface();
  const events = createEventSurface();
  const defs: ToolDefLike[] = [];
  const logs = { info: [] as string[], warn: [] as string[] };
  const disposers: Array<() => unknown> = [];
  const ctx = {
    get: (name: string): unknown => services.get(name),
    effect(fn: () => () => void): () => void {
      const dispose = fn();
      disposers.push(dispose);
      return () => {
        void dispose();
      };
    },
    on: (event: string, listener: (payload: unknown) => void): (() => void) =>
      events.on(event, listener),
    ...(options.logger === false
      ? {}
      : {
          logger: (ns: string) => ({
            info: (message: string): void => {
              logs.info.push(`${ns}: ${message}`);
            },
            warn: (message: string): void => {
              logs.warn.push(`${ns}: ${message}`);
            },
          }),
        }),
    ...(options.tools === false
      ? {}
      : {
          tools: {
            register: (def: unknown): void => {
              defs.push(def as ToolDefLike);
            },
          },
        }),
  };
  apply(ctx, options.config ?? {});
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
    ctx,
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
  };
}

/** 取工具渲染文本（契约：args 第一、value 第二）。 */
export function renderText(
  tool: ToolDefLike,
  value: unknown,
  args: unknown = {},
): string {
  return tool.output.render(args, value)[0]?.text ?? "";
}

/** 临时工作区：Markdown 落盘在 `os.tmpdir()`，用例结束统一删除。 */
export interface TempWorkspace {
  readonly dir: string;
  path(name: string): string;
  write(name: string, text: string): string;
  cleanup(): void;
}

export function createTempWorkspace(prefix = "md-logic-it-"): TempWorkspace {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    path: (name) => join(dir, name),
    write(name, text) {
      const file = join(dir, name);
      writeFileSync(file, text, "utf8");
      return file;
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
