/**
 * 集成层装配器: 用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`.
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务）, 本文件不以 `.test.ts` 结尾,
 * 也不计入覆盖率（dev/coverage 只统 `src`）. 集成用例一律经本装配器接宿主, 不直接 import
 * 宿主运行时.
 *
 * 本包只消费 `ctx.tools`, 不订阅事件、不 provide 服务: 事件面与服务面在此只为「零订阅 /
 * 零登记」的断言与换包复用而存在. 落盘面一律写 `os.tmpdir()` 下的临时目录, 用例结束删除.
 */

import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import { apply, type Config } from "../src/index.ts";
import type {
  HashFsServiceLike,
  HashSandboxPolicyServiceLike,
  HashWorkingDirectoryLike,
} from "../src/ctx-fs-io.ts";
import type { HashWriteIntent } from "../src/io.ts";

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
    listDir(
      target: FakeFsTarget,
      signal?: AbortSignal,
    ): Promise<Array<{ name: string; type: "file" | "directory" | "other" }>>;
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
  const versionOf = async (key: string): Promise<string> => {
    const override = versions.get(key);
    if (override !== undefined) return override;
    const info = await stat(key);
    return `${info.size}:${info.mtimeMs}`;
  };
  const typeOf = (info: {
    isFile(): boolean;
    isDirectory(): boolean;
  }): "file" | "directory" | "other" =>
    info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
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
        const info = await stat(target.targetKey);
        return {
          version: await versionOf(target.targetKey),
          type: typeOf(info),
          size: info.size,
        };
      } catch {
        return undefined;
      }
    },
    async readText(target: FakeFsTarget): Promise<string> {
      // 与真实后端同口径: NUL 与非法 UTF-8 一律 FS_NOT_TEXT（不做有损解码）
      const raw = await readFile(target.targetKey);
      if (raw.includes(0)) {
        throw Object.assign(
          new Error(`cannot read "${target.displayPath}": binary file`),
          { code: "FS_NOT_TEXT" },
        );
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        throw Object.assign(
          new Error(`cannot read "${target.displayPath}": invalid UTF-8 text`),
          { code: "FS_NOT_TEXT" },
        );
      }
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
      await writeFile(target.targetKey, text, "utf8");
      versions.delete(target.targetKey);
      return { version: await versionOf(target.targetKey) };
    },
    async listDir(
      target: FakeFsTarget,
    ): Promise<Array<{ name: string; type: "file" | "directory" | "other" }>> {
      const names = await readdir(target.targetKey);
      const entries: Array<{
        name: string;
        type: "file" | "directory" | "other";
      }> = [];
      for (const name of names) {
        const info = await stat(join(target.targetKey, name));
        entries.push({ name, type: typeOf(info) });
      }
      return entries;
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

/** 工具定义的最小结构面（`ctx.tools.register` 的入参形状） */
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
    schema: { type: string; additionalProperties?: boolean };
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type: string; text: string }>;
  };
}

/** 假工具面: 收集注册定义, 按名取用 */
export interface ToolSurface {
  readonly defs: ToolDefLike[];
  names(): string[];
  require(name: string): ToolDefLike;
}

/** 假事件面: 记录订阅（本包不消费事件, 用零订阅做断言） */
export interface EventSurface {
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): number;
  listenerCount(event?: string): number;
}

/** 假服务面: 宿主 `ctx.get` / `ctx.provide` 的替身（同名重复注册即抛错, 与 cordis 一致） */
export interface ServiceSurface {
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  names(): string[];
}

/**
 * 装配形态: 完整宿主 / 缺 ctx.tools.
 *
 * 不设「空 ctx」形态: `apply` 未做 `ctx === null || typeof ctx !== "object"` 守卫,
 * 传 undefined 会抛 TypeError（豁免台账见包追踪文档「测试与证据」）.
 */
export type HostShape = "full" | "no-tools";

/** 装配选项 */
export interface AssembleOptions {
  /** 宿主面形态, 缺省 `full` */
  shape?: HostShape;
  /** 插件配置（`root` 为相对路径基准） */
  config?: Config;
  /** 工具注册抛错（宿主拒绝注册） */
  registerThrows?: boolean;
  /** 假文件系统配置（`false` = 不装, 验证「宿主没挂 ctx.fs」的失败路径） */
  fs?: false | { sandboxMode?: string };
  /** 额外服务面（覆盖同名缺省项） */
  services?: Record<string, unknown>;
}

/** 一次 `fs/write-intent` 瀑布的记录 */
export interface WaterfallRecord {
  event: string;
  target: unknown;
  actor: unknown;
  /** 兜底函数（无监听者时）返回的意图 */
  delegated: unknown;
}

/** 一次 `fs/observed` 观察记录 */
export interface ObservationRecord {
  event: string;
  target: unknown;
  observation: unknown;
  actor: unknown;
}

/** 装配后的宿主句柄 */
export interface Assembled {
  readonly ctx: unknown;
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  /** `apply` 写到 stderr 的告警行（降级与注册失败两种） */
  readonly stderr: string[];
  /** 本次装配装上的假文件系统（`fs: false` 时为 `undefined`） */
  readonly fs: FakeFs | undefined;
  /** 一次 `fs/write-intent` 瀑布的记录 */
  readonly waterfalls: WaterfallRecord[];
  /** 一次 `fs/observed` 观察记录 */
  readonly observations: ObservationRecord[];
  /** `ctx.workingDirectory.ensure` 的调用记录 */
  readonly ensureCalls: unknown[];
  /** 取 `hash_read`（未注册即抛错） */
  read(): ToolDefLike;
  /** 取 `hash_edit`（未注册即抛错） */
  edit(): ToolDefLike;
  /** 经工具 `execute` 调一次（缺省无会话上下文） */
  execute(
    name: string,
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<unknown>;
  /** 经工具 `output.render` 投影一次（args 第一、value 第二, 与宿主同序） */
  render(
    name: string,
    value: unknown,
    args?: unknown,
  ): Array<{ type: string; text: string }>;
}

/** 临时工作区: 一次装配内的落盘目录, 用例结束必须 `cleanup` */
export interface Workspace {
  readonly dir: string;
  /** 目录内文件绝对路径 */
  path(name: string): string;
  /** 目录条目名（断言无临时文件残留） */
  list(): Promise<string[]>;
  cleanup(): Promise<void>;
}

/** 造临时工作区并按名写入初始文件（缺省 `sample.txt`） */
export async function makeWorkspace(
  files: Record<string, string | Buffer> = { "sample.txt": "alpha\nbeta\n" },
): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "hash-edit-integration-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return {
    dir,
    path: (name: string) => join(dir, name),
    list: () => readdir(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
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

/** 临时替换 stderr.write, 收集 `apply` 的告警行（异步安全: 恢复在 finally） */
export async function captureStderr(run: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

/** 装配 `apply`: 三个假面 + 文件系统面 + 告警收集 */
export async function assemble(
  options: AssembleOptions = {},
): Promise<Assembled> {
  const shape = options.shape ?? "full";
  const fakeFs =
    options.fs === false ? undefined : createFakeFs(options.fs ?? {});
  const ensureCalls: unknown[] = [];
  const waterfalls: WaterfallRecord[] = [];
  const observations: ObservationRecord[] = [];
  const services = createServiceSurface({
    ...(fakeFs === undefined ? {} : { fs: fakeFs.service }),
    // 会话目录: 与宿主同口径（读 exec.agent.session.header.cwd）
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

  const base = {
    get: (name: string): unknown => services.get(name),
    // cordis 里服务既是 `ctx.get(name)` 也是 `ctx.<name>` 属性; 假面同样按属性暴露
    get fs(): HashFsServiceLike | undefined {
      return services.get("fs") as HashFsServiceLike | undefined;
    },
    get workingDirectory(): HashWorkingDirectoryLike | undefined {
      return services.get("workingDirectory") as
        HashWorkingDirectoryLike | undefined;
    },
    get sandboxPolicy(): HashSandboxPolicyServiceLike | undefined {
      return services.get("sandboxPolicy") as
        HashSandboxPolicyServiceLike | undefined;
    },
    on: (event: string, listener: (payload: unknown) => void): (() => void) =>
      events.on(event, listener),
    // 单槽决策瀑布: 没有监听者, 只记录兜底返回值（= 调用方自己的写入意图）
    waterfall: async (
      event: "fs/write-intent",
      target: unknown,
      actor: unknown,
      next: () =>
        HashWriteIntent | undefined | Promise<HashWriteIntent | undefined>,
    ): Promise<HashWriteIntent | undefined> => {
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
    tools: {
      register: (def: unknown): void => {
        if (options.registerThrows === true) {
          throw new Error("tool registry rejected");
        }
        defs.push(def as ToolDefLike);
      },
    },
  };

  let ctx: Record<string, unknown>;
  if (shape === "no-tools") {
    ctx = {
      get: base.get,
      on: base.on,
      provide: (name: string, value: unknown): void => {
        services.provide(name, value);
      },
    };
  } else {
    ctx = {
      ...base,
      provide: (name: string, value: unknown): void => {
        services.provide(name, value);
      },
    };
  }

  const stderr = await captureStderr(() => apply(ctx, options.config ?? {}));

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
    ctx,
    tools,
    events,
    services,
    stderr,
    fs: fakeFs,
    waterfalls,
    observations,
    ensureCalls,
    read: () => tools.require("hash_read"),
    edit: () => tools.require("hash_edit"),
    execute: (name, args, exec) => tools.require(name).execute(args, exec),
    render: (name, value, args) =>
      tools.require(name).output.render(args ?? {}, value),
  };
}
