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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import { apply } from "../src/index.ts";
import type { AstToolsConfig } from "../src/index.ts";
import type {
  AstFsServiceLike,
  AstSandboxPolicyServiceLike,
  AstWorkingDirectoryLike,
} from "../src/ctx-fs-io.ts";
import type { AstWriteIntent } from "../src/io.ts";

/** 工具定义的最小结构面（`ctx.tools.register` 的入参形状）。 */
export interface ToolDefLike {
  name: string;
  description: string;
  parameters: {
    type: string;
    required?: string[];
    properties: Record<string, unknown>;
  };
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>;
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
  /** 本次装配装上的假文件系统（`fs: false` 时为 `undefined`）。 */
  readonly fs: FakeFs | undefined;
  /** 一次 `fs/write-intent` 瀑布的记录（事件名 / 目标 / 兜底返回值）。 */
  readonly waterfalls: WaterfallRecord[];
  /** 一次 `fs/observed` 观察记录。 */
  readonly observations: ObservationRecord[];
  /** `ctx.workingDirectory.ensure` 的调用记录。 */
  readonly ensureCalls: unknown[];
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

/** 一次 `fs/write-intent` 瀑布的记录。 */
export interface WaterfallRecord {
  event: string;
  target: unknown;
  actor: unknown;
  /** 兜底函数（无监听者时）返回的意图。 */
  delegated: unknown;
}

/** 一次 `fs/observed` 观察记录。 */
export interface ObservationRecord {
  event: string;
  target: unknown;
  observation: unknown;
  actor: unknown;
}

/** 模拟 cordis 代理: 未 inject 的服务属性直读按宿主文案抛错（`fs` / `tools` 不受影响）。 */
function unreachableService(name: string): never {
  throw new Error(`cannot get property "${name}" without inject`);
}

/** 按 `injectGuard` 把宿主面包成 cordis 代理形态: 两个未 inject 的服务直读即抛。 */
function guardServices<T extends object>(host: T, guard: boolean): T {
  if (!guard) return host;
  return new Proxy(host, {
    get(target, prop, receiver) {
      if (prop === "workingDirectory" || prop === "sandboxPolicy") {
        unreachableService(String(prop));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** 装配 `apply`：三个假面 + 文件系统面 + 日志记录 + effect 卸载。 */
export function assemble(
  options: {
    services?: Record<string, unknown>;
    /** 模拟 cordis 代理: 未 inject 的服务属性直读按宿主文案抛错（`fs` / `tools` 不受影响）。 */
    injectGuard?: boolean;
    config?: AstToolsConfig;
    /** `false` = 不装假文件系统（用于验证「宿主没挂 ctx.fs」的失败路径）。 */
    fs?: false | { sandboxMode?: string };
  } = {},
): AssembledHost {
  const injectGuard = options.injectGuard === true;
  const fakeFs =
    options.fs === false ? undefined : createFakeFs(options.fs ?? {});
  const ensureCalls: unknown[] = [];
  const waterfalls: WaterfallRecord[] = [];
  const observations: ObservationRecord[] = [];
  const services = createServiceSurface({
    ...(fakeFs === undefined ? {} : { fs: fakeFs.service }),
    workingDirectory: {
      ensure: async (agent: unknown, signal?: AbortSignal): Promise<string> => {
        ensureCalls.push({ agent, signal });
        return process.cwd();
      },
    },
    ...options.services,
  });
  const events = createEventSurface();
  const defs: ToolDefLike[] = [];
  const logs = { info: [] as string[], warn: [] as string[] };
  const disposers: Array<() => unknown> = [];
  const base = {
    get: (name: string): unknown => services.get(name),
    // cordis 里服务既是 `ctx.get(name)` 也是 `ctx.<name>` 属性; 假面同样按属性暴露
    get fs(): AstFsServiceLike | undefined {
      return services.get("fs") as AstFsServiceLike | undefined;
    },
    get workingDirectory(): AstWorkingDirectoryLike | undefined {
      return services.get("workingDirectory") as
        AstWorkingDirectoryLike | undefined;
    },
    get sandboxPolicy(): AstSandboxPolicyServiceLike | undefined {
      return services.get("sandboxPolicy") as
        AstSandboxPolicyServiceLike | undefined;
    },
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
    // 单槽决策瀑布：没有监听者, 只记录兜底返回值（= 调用方自己的写入意图）
    waterfall: async (
      event: "fs/write-intent",
      target: unknown,
      actor: unknown,
      next: () =>
        AstWriteIntent | undefined | Promise<AstWriteIntent | undefined>,
    ): Promise<AstWriteIntent | undefined> => {
      const delegated = await next();
      waterfalls.push({ event, target, actor, delegated });
      return delegated;
    },
    emit: (
      event: string,
      target: unknown,
      observation: unknown,
      actor: unknown,
    ): void => {
      observations.push({ event, target, observation, actor });
    },
  };
  const ctx = guardServices(base, injectGuard);
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
    fs: fakeFs,
    waterfalls,
    observations,
    ensureCalls,
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

/** 假文件目标（宿主 `FsTarget` 的同形子集）。 */
export interface FakeFsTarget {
  targetKey: string;
  displayPath: string;
}

/** 一次 `writeText` 的记录（intent / sandboxPolicy 原样留证）。 */
export interface FakeWriteCall {
  target: FakeFsTarget;
  text: string;
  intent: unknown;
  sandboxPolicy: unknown;
}

/** 假文件系统：真落盘 + 可编程 version 与抛错能力（宿主 `ctx.fs` 的形状子集）。 */
export interface FakeFs {
  readonly service: {
    readonly sandboxMode?: string;
    resolve(
      path: string,
      opts?: { cwd?: string; signal?: AbortSignal },
    ): Promise<FakeFsTarget>;
    processPath(target: FakeFsTarget): string;
    stat(
      target: FakeFsTarget,
      signal?: AbortSignal,
    ): Promise<
      | { version: string; type: "file" | "directory" | "other"; size: number }
      | undefined
    >;
    readText(target: FakeFsTarget, signal?: AbortSignal): Promise<string>;
    writeText(
      target: FakeFsTarget,
      text: string,
      intent?: unknown,
      signal?: AbortSignal,
      sandboxPolicy?: unknown,
    ): Promise<{ version: string }>;
  };
  /** 已发生的写入（按序）。 */
  readonly writes: FakeWriteCall[];
  /** 让下一次 `writeText` 抛这个错误（抛一次即清空；用于 stale / sandbox 拒绝）。 */
  failNextWrite(error: unknown): void;
  /** 固定某个路径的版本令牌（模拟读后改动的并发场景）。 */
  setVersion(path: string, version: string): void;
}

/** 造一个假文件系统（缺省带 `workspace-write` 之外的「不围栏」形态）。 */
export function createFakeFs(options: { sandboxMode?: string } = {}): FakeFs {
  const writes: FakeWriteCall[] = [];
  const versions = new Map<string, string>();
  let failure: unknown;
  const versionOf = (key: string): string => {
    const override = versions.get(key);
    if (override !== undefined) return override;
    const info = statSync(key);
    return `${info.size}:${info.mtimeMs}`;
  };
  const service = {
    ...(options.sandboxMode === undefined
      ? {}
      : { sandboxMode: options.sandboxMode }),
    async resolve(
      path: string,
      opts?: { cwd?: string; signal?: AbortSignal },
    ): Promise<FakeFsTarget> {
      const key = isAbsolute(path)
        ? path
        : resolvePath(opts?.cwd ?? process.cwd(), path);
      return { targetKey: key, displayPath: key };
    },
    processPath(target: FakeFsTarget): string {
      return target.targetKey;
    },
    async stat(
      target: FakeFsTarget,
      _signal?: AbortSignal,
    ): Promise<
      | { version: string; type: "file" | "directory" | "other"; size: number }
      | undefined
    > {
      try {
        const info = statSync(target.targetKey);
        return {
          version: versionOf(target.targetKey),
          type: info.isFile()
            ? "file"
            : info.isDirectory()
              ? "directory"
              : "other",
          size: info.size,
        };
      } catch {
        return undefined;
      }
    },
    async readText(target: FakeFsTarget): Promise<string> {
      return readFileSync(target.targetKey, "utf8");
    },
    async writeText(
      target: FakeFsTarget,
      text: string,
      intent?: unknown,
      _signal?: AbortSignal,
      sandboxPolicy?: unknown,
    ): Promise<{ version: string }> {
      writes.push({ target, text, intent, sandboxPolicy });
      if (failure !== undefined) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      writeFileSync(target.targetKey, text, "utf8");
      versions.delete(target.targetKey);
      return { version: versionOf(target.targetKey) };
    },
  };
  return {
    service,
    writes,
    failNextWrite(error: unknown): void {
      failure = error;
    },
    setVersion(path: string, version: string): void {
      versions.set(path, version);
    },
  };
}
