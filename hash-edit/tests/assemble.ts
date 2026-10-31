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

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, type Config } from "../src/index.ts";

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
}

/** 装配后的宿主句柄 */
export interface Assembled {
  readonly ctx: unknown;
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  /** `apply` 写到 stderr 的告警行（降级与注册失败两种） */
  readonly stderr: string[];
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

/** 装配 `apply`: 三个假面 + 告警收集 */
export async function assemble(
  options: AssembleOptions = {},
): Promise<Assembled> {
  const shape = options.shape ?? "full";
  const services = createServiceSurface();
  const events = createEventSurface();
  const defs: ToolDefLike[] = [];

  const base = {
    get: (name: string): unknown => services.get(name),
    on: (event: string, listener: (payload: unknown) => void): (() => void) =>
      events.on(event, listener),
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
    read: () => tools.require("hash_read"),
    edit: () => tools.require("hash_edit"),
    execute: (name, args, exec) => tools.require(name).execute(args, exec),
    render: (name, value, args) =>
      tools.require(name).output.render(args ?? {}, value),
  };
}
