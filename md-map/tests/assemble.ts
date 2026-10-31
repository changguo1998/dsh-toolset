/**
 * 集成层装配器: 用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`.
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务）, 本文件不以 `.test.ts` 结尾,
 * 也不计入覆盖率（dev/coverage 只统 `src`）. 集成用例一律经本装配器接宿主, 不直接 import
 * 宿主运行时.
 *
 * 本包消费 `ctx.tools`（注册 md_map）、`ctx.provide`（提供 `mdMap` 服务面）与可选的
 * `ctx.logger`; 事件面只为「零订阅」断言与换包复用而存在. 落盘面一律写 `os.tmpdir()` 下的
 * 临时目录, 用例结束删除.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { apply, type Config } from "../src/index.ts";

/** 工具定义的最小结构面（`ctx.tools.register` 的入参形状） */
export interface ToolDefLike {
  name: string;
  description: string;
  parameters: {
    type: string;
    required?: string[];
    additionalProperties?: boolean;
    properties: Record<string, { type?: string; enum?: string[] }>;
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

/** 假服务面: 宿主 `ctx.provide` 的替身（同名重复注册即抛错, 与 cordis 一致） */
export interface ServiceSurface {
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  require(name: string): unknown;
  names(): string[];
}

/** `mdMap` 服务面的契约形状（`ctx.provide("mdMap", ...)` 的入参） */
export interface MdMapFacadeLike {
  getService(): unknown;
  getSummary(): { ready: boolean; [key: string]: unknown };
}

/**
 * 装配形态: 完整宿主 / 缺 ctx.tools / 缺 ctx.provide / 无 logger.
 *
 * 不设「空 ctx」形态: `apply` 未做 `ctx === null || typeof ctx !== "object"` 守卫,
 * 传 undefined 会抛 TypeError（豁免台账见包追踪文档「测试与证据」）.
 */
export type HostShape = "full" | "no-tools" | "no-provide" | "no-logger";

/** 装配选项 */
export interface AssembleOptions {
  /** 宿主面形态, 缺省 `full` */
  shape?: HostShape;
  /** 插件配置（`root` / `maxFiles` / `exclude`） */
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
  /** `apply` 经 `ctx.logger` 打的日志行（`命名空间: 消息`） */
  readonly logs: string[];
  /** `apply` 直接写到 stderr 的告警行 */
  readonly stderr: string[];
  /** 取 `md_map`（未注册即抛错） */
  tool(): ToolDefLike;
  /** 取 `mdMap` 服务面（未 provide 即抛错） */
  facade(): MdMapFacadeLike;
  /** 经工具 `execute` 调一次（缺省无会话上下文） */
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>;
  /** 经工具 `output.render` 投影一次（args 第一、value 第二, 与宿主同序） */
  render(value: unknown, args?: unknown): Array<{ type: string; text: string }>;
}

/** 临时工作区: 一次装配内的落盘目录, 用例结束必须 `cleanup` */
export interface Workspace {
  readonly dir: string;
  /** 相对路径对应的绝对路径 */
  path(rel: string): string;
  cleanup(): Promise<void>;
}

/** 标准文档集: 覆盖 internal / wiki / file / external / broken / ref 六类边与入口判定. */
export const DOC_FIXTURE: Record<string, string> = {
  "README.md": [
    "# 项目",
    "",
    "[A](docs/a.md)",
    "[A 锚点](docs/a.md#小节)",
    "[[docs/b|B 文档]]",
    "[代码](src/x.ts)",
    "[外链](https://example.com)",
    "[断链](docs/missing.md)",
    "[出界](../outside.md)",
    "行内代码引用 `docs/a.md`",
    "",
  ].join("\n"),
  "docs/a.md": [
    "# A",
    "",
    "## 小节",
    "",
    "[B 坏锚点](b.md#不存在)",
    "[回 README](../README.md)",
    "",
  ].join("\n"),
  "docs/b.md": "# B\n",
  "docs/orphan.md": "# 孤儿\n",
};

/** 造临时工作区并按名写入初始文件 */
export async function makeWorkspace(
  files: Record<string, string> = {},
): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "md-map-integration-"));
  for (const [name, body] of Object.entries(files)) {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  return {
    dir,
    path: (rel: string) => join(dir, rel),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** 落盘标准文档集（外加一个非 md 文件供 `file` 边） */
export async function makeDocProject(): Promise<Workspace> {
  return makeWorkspace({ ...DOC_FIXTURE, "src/x.ts": "export const x = 1;\n" });
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
    require(name) {
      if (!values.has(name)) throw new Error(`未提供面：${name}`);
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

/** 装配 `apply`: 三个假面 + 日志与告警收集 */
export async function assemble(
  options: AssembleOptions = {},
): Promise<Assembled> {
  const shape = options.shape ?? "full";
  const services = createServiceSurface();
  const events = createEventSurface();
  const defs: ToolDefLike[] = [];
  const logs: string[] = [];

  const logger =
    shape === "no-logger"
      ? undefined
      : (namespace: string) => ({
          info: (message: string): void => {
            logs.push(`${namespace}: ${message}`);
          },
        });

  const ctx: Record<string, unknown> = {
    get: (name: string): unknown => services.get(name),
    on: (event: string, listener: (payload: unknown) => void): (() => void) =>
      events.on(event, listener),
    ...(logger === undefined ? {} : { logger }),
    ...(shape === "no-tools"
      ? {}
      : {
          tools: {
            register: (def: unknown): void => {
              if (options.registerThrows === true) {
                throw new Error("tool registry rejected");
              }
              defs.push(def as ToolDefLike);
            },
          },
        }),
    ...(shape === "no-provide"
      ? {}
      : {
          provide: (name: string, value: unknown): void => {
            services.provide(name, value);
          },
        }),
  };

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
    logs,
    stderr,
    tool: () => tools.require("md_map"),
    facade: () => services.require("mdMap") as MdMapFacadeLike,
    execute: (args, exec) => tools.require("md_map").execute(args, exec),
    render: (value, args) =>
      tools.require("md_map").output.render(args ?? {}, value),
  };
}
