/**
 * 集成层装配器：用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`。
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务），本文件不以 `.test.ts` 结尾，
 * 也不计入覆盖率（dev/coverage 只统 `src`）。集成用例一律经本装配器接宿主，
 * 不直接 import 宿主运行时。
 */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../src/index.ts";
import type { AstToolsConfig } from "../src/index.ts";

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

/** 假定时器：`clock.scope()` 返回值的最小结构面。 */
export interface FakeTimers {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
  interval(delayMs: number, callback: () => void): () => void;
}

/** 手控假时钟：记录 scoped 调用参数，排期可手动推进。 */
export interface FakeClock {
  service: { now(): number; scope(ctx?: unknown): FakeTimers };
  scopes: unknown[];
  pending(): number;
  advance(ms: number): void;
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

export function createFakeClock(): FakeClock {
  let now = 0;
  let seq = 0;
  const scheduled = new Map<
    number,
    { at: number; callback: () => void; repeat?: number }
  >();
  const scopes: unknown[] = [];
  const timers: FakeTimers = {
    now: () => now,
    schedule(delayMs, callback) {
      const id = ++seq;
      scheduled.set(id, {
        at: now + Math.max(0, delayMs),
        callback,
      });
      return () => {
        scheduled.delete(id);
      };
    },
    interval(delayMs, callback) {
      const id = ++seq;
      const step = Math.max(1, delayMs);
      scheduled.set(id, { at: now + step, callback, repeat: step });
      return () => {
        scheduled.delete(id);
      };
    },
  };
  return {
    service: {
      now: () => now,
      scope(ctx?: unknown): FakeTimers {
        scopes.push(ctx);
        return timers;
      },
    },
    scopes,
    pending: () => scheduled.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next:
          | [number, { at: number; callback: () => void; repeat?: number }]
          | undefined;
        for (const entry of scheduled) {
          if (entry[1].at > target) continue;
          if (next === undefined || entry[1].at < next[1].at) next = entry;
        }
        if (next === undefined) break;
        const [id, entry] = next;
        now = entry.at;
        if (entry.repeat === undefined) scheduled.delete(id);
        else entry.at = entry.at + entry.repeat;
        entry.callback();
      }
      now = target;
    },
  };
}

/** 装配 `apply`：三个假面 + 日志记录 + effect 卸载。 */
export function assemble(
  options: {
    services?: Record<string, unknown>;
    config?: AstToolsConfig;
  } = {},
): AssembledHost {
  const services = createServiceSurface(options.services);
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
  apply(ctx, options.config ?? { bin: process.execPath });
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

/** 假 ast-grep 可执行脚本：按子命令输出预置 JSON，并记录每次调用参数。 */
export interface FakeCli {
  readonly bin: string;
  readonly dir: string;
  args(): string[];
  cleanup(): void;
}

export function createFakeAstGrep(payloads: {
  run?: unknown;
  outline?: unknown;
  scan?: unknown;
}): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "ast-tools-fake-cli-"));
  const cases: string[] = [];
  for (const name of ["run", "outline", "scan"] as const) {
    const payload = payloads[name];
    if (payload === undefined) continue;
    const file = join(dir, `${name}.json`);
    writeFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
    cases.push(`  ${name}) cat "${file}" ;;`);
  }
  const script = join(dir, "ast-grep");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${join(dir, "args.log")}"`,
      'case "$1" in',
      ...cases,
      '  *) echo "unexpected subcommand: $*" >&2; exit 2 ;;',
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(script, 0o755);
  return {
    bin: script,
    dir,
    args(): string[] {
      try {
        return readFileSync(join(dir, "args.log"), "utf8")
          .trim()
          .split("\n")
          .filter((line: string) => line !== "");
      } catch {
        return [];
      }
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
