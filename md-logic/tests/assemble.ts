/**
 * 集成层装配器：用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`。
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务）；本文件不以 `.test.ts` 结尾，
 * 也不计入覆盖率（dev/coverage 只统 `src`）。集成用例一律经本装配器接宿主，
 * 不直接 import 宿主运行时。
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import { apply } from "../src/index.ts";
import type { MdLogicConfig } from "../src/index.ts";
import type {
  MdFsServiceLike,
  MdSandboxPolicyServiceLike,
  MdWorkingDirectoryLike,
} from "../src/ctx-fs-io.ts";
import type { MdWriteIntent } from "../src/io.ts";

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
  /** 本次装配装上的假文件系统（`fs: false` 时为 `undefined`）。 */
  readonly fs: FakeFs | undefined;
  /** 一次 `fs/write-intent` 瀑布的记录。 */
  readonly waterfalls: WaterfallRecord[];
  /** 一次 `fs/observed` 观察记录。 */
  readonly observations: ObservationRecord[];
  /** `ctx.workingDirectory.ensure` 的调用记录。 */
  readonly ensureCalls: unknown[];
  unload(): void;
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

/** 装配选项：可关掉工具面 / 日志面，验证 `apply` 的可选依赖降级。 */
export interface AssembleOptions {
  config?: MdLogicConfig;
  /** false = 不提供 `ctx.tools`（apply 应静默跳过注册）。 */
  tools?: boolean;
  /** false = 不提供 `ctx.logger`（apply 应静默跳过日志）。 */
  logger?: boolean;
  /** false = 不装假文件系统（验证「宿主没挂 ctx.fs」的失败路径）。 */
  fs?: false | { sandboxMode?: string };
  /** 额外服务面（覆盖同名缺省项）。 */
  services?: Record<string, unknown>;
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

/** 装配 `apply`：三个假面 + 文件系统面 + 日志记录 + effect 卸载。 */
export function assemble(options: AssembleOptions = {}): AssembledHost {
  const fakeFs =
    options.fs === false ? undefined : createFakeFs(options.fs ?? {});
  const ensureCalls: unknown[] = [];
  const waterfalls: WaterfallRecord[] = [];
  const observations: ObservationRecord[] = [];
  const services = createServiceSurface({
    ...(fakeFs === undefined ? {} : { fs: fakeFs.service }),
    // 会话目录：与宿主同口径（读 exec.agent.session.header.cwd），无 agent 时不给
    workingDirectory: {
      ensure: async (agent: unknown): Promise<string | undefined> => {
        ensureCalls.push(agent);
        const cwd = (
          agent as { session?: { header?: { cwd?: unknown } } } | undefined
        )?.session?.header?.cwd;
        return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
      },
    },
    ...options.services,
  });
  const events = createEventSurface();
  const defs: ToolDefLike[] = [];
  const logs = { info: [] as string[], warn: [] as string[] };
  const disposers: Array<() => unknown> = [];
  const ctx = {
    get: (name: string): unknown => services.get(name),
    // cordis 里服务既是 `ctx.get(name)` 也是 `ctx.<name>` 属性; 假面同样按属性暴露
    get fs(): MdFsServiceLike | undefined {
      return services.get("fs") as MdFsServiceLike | undefined;
    },
    get workingDirectory(): MdWorkingDirectoryLike | undefined {
      return services.get("workingDirectory") as
        MdWorkingDirectoryLike | undefined;
    },
    get sandboxPolicy(): MdSandboxPolicyServiceLike | undefined {
      return services.get("sandboxPolicy") as
        MdSandboxPolicyServiceLike | undefined;
    },
    effect(fn: () => () => void): () => void {
      const dispose = fn();
      disposers.push(dispose);
      return () => {
        void dispose();
      };
    },
    on: (event: string, listener: (payload: unknown) => void): (() => void) =>
      events.on(event, listener),
    // 单槽决策瀑布：没有监听者, 只记录兜底返回值（= 调用方自己的写入意图）
    waterfall: async (
      event: "fs/write-intent",
      target: unknown,
      actor: unknown,
      next: () =>
        MdWriteIntent | undefined | Promise<MdWriteIntent | undefined>,
    ): Promise<MdWriteIntent | undefined> => {
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
  /** 让下一次 `writeText` 抛这个错误（抛一次即清空）。 */
  failNextWrite(error: unknown): void;
  /** 固定某个路径的版本令牌（模拟读后改动的并发场景）。 */
  setVersion(path: string, version: string): void;
}

/** 造一个假文件系统（缺省不围栏）。 */
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
