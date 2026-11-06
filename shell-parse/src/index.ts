/**
 * shell-parse 插件入口（DSH bundle 接入面）。
 *
 * 角色：本仓**唯一**的 shell 命令词法层 —— 切段（引号内不切）、分词、剥离包装器、
 * 取命令位，并对 shell `-c` / `eval` / `$(...)` / 反引号递归。给 `security-guard`
 * （命令位黑名单）、`auto-approve`（命令形态学习）、`behavior-correction`（解释器识别）
 * 这类「要判断 bash 里到底跑了什么」的插件共用。
 *
 * 两种用法：
 * - **库面**：`import { commandWords, commandPositions } from "@dsh-toolset/shell-parse"`
 *   （纯函数，无状态，`link:` 依赖，与 `clock-base` 的导出面同形态）；
 * - **服务面**：`ctx.get("shellParse")` 取同一个实现（不 import 本包的插件用它）。
 *
 * 不做：别名 / 变量展开、通配符、重定向语义、`find -exec`、`make` recipe、
 * `docker run` / `ssh host '…'` 这类隔一层执行；也不读文件、不落盘、不注册工具。
 */

import {
  commandPositions,
  commandWords,
  isDynamicCommand,
} from "./command-position.ts";
import type {
  CommandParseOptions,
  CommandPosition,
} from "./command-position.ts";
import { splitCommandSegments, tokenizeSegment } from "./segments.ts";
import type { CommandToken, SegmentedCommand } from "./segments.ts";
import { WRAPPERS } from "./wrappers.ts";
import type { WrapperSpec } from "./wrappers.ts";

export {
  commandName,
  basenameOf,
  isAssignment,
  splitCommandSegments,
  substitutionBodies,
  tokenizeSegment,
} from "./segments.ts";
export type { CommandToken, SegmentedCommand } from "./segments.ts";
export {
  commandPositions,
  commandWords,
  isDynamicCommand,
  isShellName,
  SHELL_NAMES,
  DEFAULT_MAX_DEPTH,
} from "./command-position.ts";
export type {
  CommandParseOptions,
  CommandPosition,
  CommandSource,
} from "./command-position.ts";
export { stripWrappers, WRAPPERS } from "./wrappers.ts";
export type { WrapperSpec } from "./wrappers.ts";

/** bundle 条目 id（与 cordis.patch.yml / profile 层一致）。 */
export const name = "shell-parse";

/** 服务面挂载声明：需要在运行期解析命令的插件经 `ctx.get("shellParse")` 取用。 */
export const provide = ["shellParse"];

/** 服务面（`ctx.get("shellParse")`）：与包导出的纯函数同一实现。 */
export interface ShellParse {
  /** 切段（引号内不切），并带回引号是否配对。 */
  splitCommandSegments(command: string): SegmentedCommand;
  /** 分词（引号串整体算一个词，粘引号先断开）。 */
  tokenizeSegment(segment: string): CommandToken[];
  /** 命令位列表（含嵌套来源）。 */
  commandPositions(
    command: string,
    options?: CommandParseOptions,
  ): readonly CommandPosition[];
  /** 便利方法：只要命令名列表。 */
  commandWords(
    command: string,
    options?: CommandParseOptions,
  ): readonly string[];
  /** 命令位是否有展开产生的一处。 */
  isDynamicCommand(command: string, options?: CommandParseOptions): boolean;
  /** 内置包装器表（只读，供排查与扩展参考）。 */
  readonly wrappers: readonly WrapperSpec[];
}

/** 服务实现：无状态，直接转调包导出的纯函数。 */
export class ShellParseService implements ShellParse {
  splitCommandSegments(command: string): SegmentedCommand {
    return splitCommandSegments(command);
  }

  tokenizeSegment(segment: string): CommandToken[] {
    return tokenizeSegment(segment);
  }

  commandPositions(
    command: string,
    options?: CommandParseOptions,
  ): readonly CommandPosition[] {
    return options === undefined
      ? commandPositions(command)
      : commandPositions(command, options);
  }

  commandWords(
    command: string,
    options?: CommandParseOptions,
  ): readonly string[] {
    return options === undefined
      ? commandWords(command)
      : commandWords(command, options);
  }

  isDynamicCommand(command: string, options?: CommandParseOptions): boolean {
    return options === undefined
      ? isDynamicCommand(command)
      : isDynamicCommand(command, options);
  }

  readonly wrappers: readonly WrapperSpec[] = WRAPPERS;
}

/**
 * 挂载：把服务面挂到 ctx（cordis `provide`）；极简 ctx 无 `provide` 时退回直接属性挂载
 * （与 `clock-base` / `session-paths` 同套路）。重复挂载只告警，不掀翻宿主启动。
 */
export function apply(ctx: unknown): void {
  const service = new ShellParseService();
  const container = (ctx ?? {}) as { provide?: unknown };
  let provideFn: ((serviceName: string, value: unknown) => unknown) | undefined;
  try {
    const candidate = container.provide;
    if (typeof candidate === "function") {
      provideFn = candidate as (serviceName: string, value: unknown) => unknown;
    }
  } catch {
    provideFn = undefined;
  }
  if (provideFn !== undefined) {
    try {
      provideFn.call(ctx, "shellParse", service);
    } catch (error) {
      process.stderr.write(
        `[shell-parse] warn: 服务面 shellParse 注册失败：${String(error)}\n`,
      );
    }
    return;
  }
  if (ctx === null || typeof ctx !== "object") {
    process.stderr.write(
      "[shell-parse] warn: ctx 无 provide，服务面 shellParse 未注册\n",
    );
    return;
  }
  try {
    (ctx as Record<string, unknown>)["shellParse"] = service;
  } catch (error) {
    process.stderr.write(
      `[shell-parse] warn: 服务面 shellParse 注册失败：${String(error)}\n`,
    );
  }
}

/**
 * 读服务面：先看直接属性（`ctx.shellParse`），再走 `ctx.get("shellParse")`；
 * 形状校验只看 `commandWords` 是否为函数。取不到返回 `undefined`（调用方自行降级）。
 */
export function resolveShellParse(ctx?: unknown): ShellParse | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  const container = ctx as {
    shellParse?: unknown;
    get?: (service: string) => unknown;
  };
  let direct: unknown;
  try {
    direct = container.shellParse;
  } catch {
    direct = undefined;
  }
  if (isShellParseLike(direct)) return direct;
  if (typeof container.get !== "function") return undefined;
  try {
    const viaGet = container.get("shellParse");
    if (isShellParseLike(viaGet)) return viaGet;
  } catch {
    // 服务读取本身抛错（宿主严格模式 / 服务未就绪）：按缺席处理
  }
  return undefined;
}

/** 服务面形状校验（结构化类型，不依赖具体实现类）。 */
function isShellParseLike(value: unknown): value is ShellParse {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["commandWords"] === "function";
}
