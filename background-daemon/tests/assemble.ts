/**
 * 集成层装配器（`tests/integration/*.test.ts` 共用; 不叫 `.test.ts`, 不被用例入口直接跑）。
 *
 * 三个假面（与总规范 4.2 的形状一致, 换包可复用写法）：
 * - 工具面：`register(tool)`, 记录注册表;
 * - 事件面：`on(event, listener)` / `emit(event)`, 记录监听器;
 * - 服务面：`get` / `provide` / `inject`, 记录已提供值与待就绪的子分叉。
 *
 * 宿主 ctx 把三个面合成一个对象（cordis 也把 registry 方法混在 ctx 上）。用例只经
 * `background-daemon/src/index.ts` 的公开面驱动插件, 断工具返回的 canonical 值、`output.render` 投影、
 * 事件回调后的状态与服务的 provide / get。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 工具面。 */
export interface ToolFace {
  readonly registered: object[];
  register(tool: unknown): () => void;
}

/** 事件面。 */
export interface EventFace {
  readonly listeners: Map<string, (() => void)[]>;
  on(event: string, listener: () => void): () => void;
  /** 触发某事件的全部监听器（宿主卸载即 `dispose`）。 */
  emit(event: string): void;
}

/** 命令面（宿主 `commands` 服务的注册侧）。 */
export interface CommandFace {
  readonly definitions: Record<string, unknown>[];
  register(definition: unknown): () => void;
}

/** 服务面（`get` / `provide` / `inject` 与已提供值）。 */
export interface ServiceFace {
  readonly provided: Map<string, unknown>;
  readonly services: Map<string, unknown>;
  readonly pendingInject: { deps: string[]; done: boolean }[];
  get(name: string): unknown;
  provide(name: string, value: unknown): void;
  inject(deps: string[], callback: (child: unknown) => unknown): () => void;
  /** 让最近一次 `inject` 子分叉就绪（模拟宿主服务挂载完成后回调）。 */
  ready(childServices: Record<string, unknown>): void;
}

/** 装配结果。 */
export interface AssembledHost {
  ctx: Record<string, unknown>;
  services: ServiceFace;
  tools: ToolFace;
  events: EventFace;
  commands: CommandFace;
}

export interface AssembleOptions {
  /** 预置服务（覆盖缺省的 agents / sessions）。 */
  services?: Record<string, unknown>;
  /** 是否装命令面（缺省 true）。 */
  withCommands?: boolean;
  /** 是否装工具面（缺省 true）。 */
  withTools?: boolean;
  /** 是否提供 `ctx.inject`（缺省 true; cordis 真机才有, 纯服务面宿主没有）。 */
  withInject?: boolean;
}

/** 假 timer：只记录排期, 不真正触发（到点由用例直接驱动）。 */
export class FakeTimers {
  readonly entries: {
    delay: number;
    callback: () => void;
    disposed: boolean;
  }[] = [];

  schedule(delay: number, callback: () => void): () => void {
    const entry = { delay, callback, disposed: false };
    this.entries.push(entry);
    return () => {
      entry.disposed = true;
    };
  }

  interval(_delay: number, _callback: () => void): () => void {
    return () => {};
  }

  get pendingDelay(): number | null {
    return this.entries.find((entry) => !entry.disposed)?.delay ?? null;
  }
}

/**
 * 假 `clock` 服务：`now()` 可控, `scope()` 返回记录型排期器。
 */
export class FakeClock {
  value: number;
  readonly timers = new FakeTimers();
  readonly scopes: unknown[] = [];

  constructor(value: number) {
    this.value = value;
  }

  now(): number {
    return this.value;
  }

  /** 按本插件 ctx 造一组排期器（形状同 `clock` 服务面）。 */
  scope(ctx: unknown): {
    now(): number;
    schedule(delay: number, callback: () => void): () => void;
    interval(delay: number, callback: () => void): () => void;
  } {
    this.scopes.push(ctx);
    const clock = this;
    return {
      now: () => clock.value,
      schedule: (delay: number, callback: () => void) =>
        clock.timers.schedule(delay, callback),
      interval: (delay: number, callback: () => void) =>
        clock.timers.interval(delay, callback),
    };
  }
}

function makeToolFace(): ToolFace {
  const registered: object[] = [];
  return {
    registered,
    register(tool: unknown): () => void {
      registered.push(tool as object);
      return () => {
        const index = registered.indexOf(tool as object);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  };
}

function makeEventFace(): EventFace {
  const listeners = new Map<string, (() => void)[]>();
  return {
    listeners,
    on(event, listener): () => void {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return () => {
        const index = bucket.indexOf(listener);
        if (index >= 0) bucket.splice(index, 1);
      };
    },
    emit(event): void {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
  };
}

function makeCommandFace(): CommandFace {
  const definitions: Record<string, unknown>[] = [];
  return {
    definitions,
    register(definition: unknown): () => void {
      definitions.push(definition as Record<string, unknown>);
      return () => {
        const index = definitions.indexOf(
          definition as Record<string, unknown>,
        );
        if (index >= 0) definitions.splice(index, 1);
      };
    },
  };
}

/**
 * 拼出宿主 ctx。
 *
 * 缺省服务：`agents`（含会话 `sess-1` 的活跃 agent）、`sessions`（flush 恒确认）、
 * `clock`（记录型排期器）；`commands` / `tools` 由对应假面注入。
 */
export function assembleHost(options: AssembleOptions = {}): AssembledHost {
  const services = new Map<string, unknown>();
  const provided = new Map<string, unknown>();
  const pendingInject: { deps: string[]; done: boolean }[] = [];
  const injectCallbacks = new Map<number, (child: unknown) => unknown>();

  const agent = {
    session: { id: "sess-1" },
    status: "idle",
    followup: () => {},
  };
  services.set("agents", {
    get: (id: string) => (id === "sess-1" ? agent : undefined),
  });
  services.set("sessions", { flush: async () => true });

  const tools = makeToolFace();
  const events = makeEventFace();
  const commands = makeCommandFace();
  if (options.withCommands !== false) services.set("commands", commands);
  if (options.withTools !== false) services.set("tools", tools);
  for (const [name, service] of Object.entries(options.services ?? {})) {
    services.set(name, service);
  }

  const serviceFace: ServiceFace = {
    provided,
    services,
    pendingInject,
    get(name: string): unknown {
      return services.get(name) ?? provided.get(name);
    },
    provide(name: string, value: unknown): void {
      provided.set(name, value);
    },
    inject(deps: string[], callback: (child: unknown) => unknown): () => void {
      const index = pendingInject.length;
      pendingInject.push({ deps, done: false });
      injectCallbacks.set(index, callback);
      return () => {
        injectCallbacks.delete(index);
      };
    },
    ready(childServices: Record<string, unknown>): void {
      const index = pendingInject.findIndex((item) => !item.done);
      if (index < 0) return;
      pendingInject[index]!.done = true;
      const callback = injectCallbacks.get(index);
      if (callback === undefined) return;
      callback({
        get: (name: string) => childServices[name],
      });
    },
  };

  const ctx: Record<string, unknown> = {
    get: (name: string) => serviceFace.get(name),
    provide: (name: string, value: unknown) => serviceFace.provide(name, value),
    on: (event: string, listener: () => void) => events.on(event, listener),
  };
  if (options.withInject !== false) {
    ctx["inject"] = (deps: string[], callback: (child: unknown) => unknown) =>
      serviceFace.inject(deps, callback);
  }
  return { ctx, services: serviceFace, tools, events, commands };
}

/** 临时目录（每个用例一份; 落盘类断言都落在它下面）。 */
export function tempStateDir(prefix = "background-daemon-integration-"): {
  dir: string;
  config: {
    storePath: string;
    journalPath: string;
    controlPath: string;
  };
  cleanup(): void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    config: {
      storePath: path.join(dir, "tasks.json"),
      journalPath: path.join(dir, "journal.jsonl"),
      controlPath: path.join(dir, "control.jsonl"),
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 取工具面上的具名工具（未注册即断言失败, 避免空跑）。 */
export function findTool(
  face: ToolFace,
  name: string,
): Record<string, unknown> {
  const found = face.registered.find(
    (tool) => (tool as { name?: string }).name === name,
  );
  if (found === undefined) throw new Error(`工具未注册：${name}`);
  return found as Record<string, unknown>;
}

/** 等待条件成立（异步镜像 / 晚挂底座用; 不做无限忙等）。 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
