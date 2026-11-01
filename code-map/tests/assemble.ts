/**
 * 集成层装配器: 用假 astTools 服务面 / 假工具面 / 假服务面拼出宿主并调用 `apply`.
 *
 * 三个假面的形状按总追踪 4.2 的口径 (工具 / 事件 / 服务); 本文件不以 `.test.ts` 结尾,
 * 也不计入覆盖率 (dev/coverage 只统 `src`). 集成用例一律经本装配器接宿主, 不直接起
 * 宿主运行时.
 *
 * 本包消费 `ctx.tools` (注册 `code_map`)、`ctx.provide` (提供 `codeMap` 服务面)、
 * 可选 `ctx.logger`, 并经 `ctx.get("lsp")` 取语义层引用提供器; 事件面只为 "零订阅" 断言与
 * 换包复用而存在. ast 面用假实现 (只回放固定 outline / search), 用例不依赖 ast-grep 二进制;
 * 落盘面一律写 `os.tmpdir()` 下的临时目录, 用例结束删除.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import type {
  AstMatch,
  AstToolsBundle,
  OutlineSymbol,
} from "@dsh-toolset/ast-tools";

import { apply, type CodeMapConfig } from "../src/index.ts";
import type { LspReferencesProvider } from "../src/semantic/lsp.ts";

/** 工具定义的最小结构面 (`ctx.tools.register` 的入参形状) */
export interface ToolDefLike {
  name: string;
  description: string;
  parameters: {
    type: string;
    required?: string[];
    properties: Record<string, { type?: string; enum?: string[] }>;
  };
  execute(args: Record<string, unknown>): Promise<unknown>;
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

/** 假事件面: 记录订阅 (本包不消费事件, 用零订阅做断言) */
export interface EventSurface {
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): number;
  listenerCount(event?: string): number;
}

/** 假服务面: 宿主 `ctx.provide` / `ctx.get` 的替身 (同名重复注册即抛错, 与 cordis 一致) */
export interface ServiceSurface {
  provide(name: string, value: unknown): void;
  get(name: string): unknown;
  require(name: string): unknown;
  names(): string[];
}

/** `codeMap` 服务面的契约形状 (`ctx.provide("codeMap", ...)` 的入参) */
export interface CodeMapFacadeLike {
  getSummary(): unknown;
  getBundle(): unknown;
}

/** 假 astTools 面: 额外记录调用次数, 供惰性索引与 inflight 断言 */
export interface FakeAst extends AstToolsBundle {
  readonly outlineCalls: string[];
  readonly searchCalls: string[];
}

/** 标准项目: core (a/b/d) + cli (main) + 一个 outline 必失败的文件. */
export const PROJECT_FIXTURE: Record<string, string> = {
  "core/a.ts": [
    "export class Auth {",
    "  authenticate(user: string): string {",
    "    return user;",
    "  }",
    "}",
    "",
    "export function helper(): number {",
    "  return 42;",
    "}",
    "",
  ].join("\n"),
  "core/b.ts": [
    "import { Auth } from './a';",
    "export function use(): string {",
    "  return new Auth().authenticate('x');",
    "}",
    "",
  ].join("\n"),
  "core/d.ts": ["export const orphan = 1;", ""].join("\n"),
  "cli/main.ts": [
    "import { use } from '../core/b';",
    "import * as fs from 'node:fs';",
    "export const main = (): string => use() + String(fs);",
    "",
  ].join("\n"),
  "broken/gen.ts": "this file makes the fake ast throw\n",
};

/** outline 区间 (0-based 行号) */
function range(startLine: number, endLine: number): OutlineSymbol["range"] {
  return {
    start: { line: startLine, column: 0 },
    end: { line: endLine, column: 0 },
    byteOffset: { start: 0, end: 0 },
  };
}

/** outline 项: 缺省为顶层导出项, 逐条覆盖缺省值 */
function item(
  partial: Partial<OutlineSymbol> & Pick<OutlineSymbol, "name">,
): OutlineSymbol {
  return {
    role: "item",
    symbolType: "",
    range: range(0, 0),
    signature: "",
    astKind: "",
    isImport: false,
    isExported: true,
    ...partial,
  };
}

/**
 * 固定 outline 表 (相对路径 → 符号项).
 *
 * 覆盖 scan 的三条边: import 说明符整行形态 (`import { Auth } from './a'`)、
 * `signature` 缺失与 `astKind` 为空 (走 `?? ""` 与 kind 兜底)、成员符号递归.
 */
function projectOutlines(): Record<string, OutlineSymbol[]> {
  return {
    "core/a.ts": [
      item({
        name: "Auth",
        astKind: "class_declaration",
        symbolType: "class",
        range: range(0, 4),
        signature: "class Auth",
        members: [
          item({
            name: "authenticate",
            role: "member",
            astKind: "method_definition",
            symbolType: "method",
            range: range(1, 3),
            signature: "authenticate(user: string): string",
            isExported: false,
          }),
        ],
      }),
      item({
        name: "helper",
        astKind: "function_declaration",
        symbolType: "function",
        range: range(6, 8),
        signature: "function helper(): number",
      }),
    ],
    "core/b.ts": [
      item({
        name: "import { Auth } from './a'",
        astKind: "import_statement",
        symbolType: "import",
        isImport: true,
        isExported: false,
      }),
      item({
        name: "use",
        astKind: "function_declaration",
        symbolType: "function",
        range: range(1, 3),
        signature: "export function use(): string",
      }),
    ],
    "core/d.ts": [
      item({
        name: "orphan",
        astKind: "",
        symbolType: "",
        range: range(0, 1),
        signature: undefined as unknown as string,
      }),
    ],
    "cli/main.ts": [
      item({
        name: "import { use } from '../core/b'",
        astKind: "import_statement",
        symbolType: "import",
        isImport: true,
        isExported: false,
      }),
      item({
        name: "import * as fs from 'node:fs'",
        astKind: "import_statement",
        symbolType: "import",
        isImport: true,
        isExported: false,
      }),
      item({
        name: "main",
        astKind: "lexical_declaration",
        symbolType: "variable",
        range: range(2, 2),
        signature: undefined as unknown as string,
      }),
    ],
  };
}

/** 一条 search 命中 (0-based 行列) */
function hit(
  file: string,
  line: number,
  column: number,
  text: string,
): AstMatch {
  return {
    text,
    file,
    range: {
      start: { line, column },
      end: { line, column: column + text.length },
      byteOffset: { start: 0, end: 0 },
    },
  };
}

/** 固定 search 命中表 (模式 → 命中), 覆盖 "定义区间内命中须被排除" 一类边界. */
function projectHits(root: string): Record<string, AstMatch[]> {
  const a = join(root, "core/a.ts");
  const b = join(root, "core/b.ts");
  const main = join(root, "cli/main.ts");
  return {
    Auth: [
      hit(a, 0, 13, "Auth"),
      hit(a, 1, 2, "Auth"), // 定义区间内 → 应被 excludeDefinitionRange 排除
      hit(b, 2, 15, "Auth"),
    ],
    helper: [hit(a, 6, 16, "helper")],
    use: [hit(b, 1, 16, "use"), hit(main, 0, 9, "use")],
  };
}

/** 假 astTools 面: 按固定表回放 outline / search, `broken/gen.ts` 一律抛错. */
export function createFakeAst(root: string): FakeAst {
  const outlines = projectOutlines();
  const hits = projectHits(root);
  const outlineCalls: string[] = [];
  const searchCalls: string[] = [];
  return {
    bin: "fake-ast-grep",
    outlineCalls,
    searchCalls,
    async outline(params: { path: string }) {
      outlineCalls.push(params.path);
      const rel = relative(root, params.path).split(sep).join("/");
      if (rel === "broken/gen.ts") {
        throw new Error("fake ast-grep: 解析失败");
      }
      return [
        {
          path: params.path,
          language: "typescript",
          items: outlines[rel] ?? [],
        },
      ];
    },
    async search(params: { pattern: string }) {
      searchCalls.push(params.pattern);
      return hits[params.pattern] ?? [];
    },
    async replace() {
      throw new Error("fake ast: replace 不可用");
    },
    async rules() {
      throw new Error("fake ast: rules 不可用");
    },
    dispose() {
      /* 无持久资源 */
    },
  };
}

/** 临时工作区: 一次装配内的落盘目录, 用例结束必须 `cleanup` */
export interface Workspace {
  readonly dir: string;
  path(rel: string): string;
  exists(rel: string): boolean;
  cleanup(): Promise<void>;
}

/** 造临时工作区并按名写入初始文件 */
export async function makeProject(
  files: Record<string, string> = PROJECT_FIXTURE,
): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "code-map-integration-"));
  for (const [name, body] of Object.entries(files)) {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  return {
    dir,
    path: (rel: string) => join(dir, rel),
    exists: (rel: string) => existsSync(join(dir, rel)),
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
    require(name) {
      if (!values.has(name)) throw new Error(`未提供面: ${name}`);
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

/** 临时替换 stderr.write, 收集 `apply` 的告警行 (异步安全: 恢复在 finally) */
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

/**
 * 装配形态: 完整宿主 / 缺 ctx.tools / 缺 ctx.provide / 无 logger.
 *
 * 不设 "空 ctx" 形态: `apply` 未做 `ctx === null || typeof ctx !== "object"` 守卫,
 * 传 undefined 会抛 TypeError (豁免台账见包追踪文档「测试与证据」).
 */
export type HostShape = "full" | "no-tools" | "no-provide" | "no-logger";

/** 装配选项 */
export interface AssembleOptions {
  /** 索引根 (与 `Workspace.dir` 同值) */
  root: string;
  /** 宿主面形态, 缺省 `full` */
  shape?: HostShape;
  /** 工具注册抛错 (宿主拒绝注册) */
  registerThrows?: boolean;
  /** 宿主 `ctx.get("lsp")` 提供的语义层引用提供器 */
  lsp?: LspReferencesProvider;
  /** 额外插件配置 (缺省只传 `root` 与假 ast) */
  config?: Omit<CodeMapConfig, "root" | "ast">;
}

/** 装配后的宿主句柄 */
export interface Assembled {
  readonly ctx: unknown;
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  /** 假 astTools 面 (`outlineCalls` / `searchCalls` 供惰性断言) */
  readonly ast: FakeAst;
  /** `apply` 经 `ctx.logger` 打的日志行 (`命名空间: 消息`) */
  readonly logs: string[];
  /** `apply` 直接写到 stderr 的告警行 */
  readonly stderr: string[];
  /** 取 `code_map` (未注册即抛错) */
  tool(): ToolDefLike;
  /** 取 `codeMap` 服务面 (未 provide 即抛错) */
  facade(): CodeMapFacadeLike;
  /** 经工具 `execute` 调一次 */
  execute(args: Record<string, unknown>): Promise<unknown>;
  /** 经工具 `output.render` 投影一次 (args 第一、value 第二, 与宿主同序) */
  render(value: unknown, args?: unknown): Array<{ type: string; text: string }>;
}

/** 装配 `apply`: 三个假面 + 假 ast + 日志与告警收集 */
export async function assemble(options: AssembleOptions): Promise<Assembled> {
  const shape = options.shape ?? "full";
  const ast = createFakeAst(options.root);
  const services = createServiceSurface(
    options.lsp === undefined ? {} : { lsp: options.lsp },
  );
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

  const stderr = await captureStderr(() =>
    apply(ctx, { ...options.config, root: options.root, ast }),
  );

  const tools: ToolSurface = {
    defs,
    names: () => defs.map((def) => def.name),
    require(name) {
      const found = defs.find((def) => def.name === name);
      if (found === undefined) throw new Error(`未注册工具: ${name}`);
      return found;
    },
  };

  return {
    ctx,
    tools,
    events,
    services,
    ast,
    logs,
    stderr,
    tool: () => tools.require("code_map"),
    facade: () => services.require("codeMap") as CodeMapFacadeLike,
    execute: (args) => tools.require("code_map").execute(args),
    render: (value, args) =>
      tools.require("code_map").output.render(args ?? {}, value),
  };
}
