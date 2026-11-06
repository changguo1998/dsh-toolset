/**
 * command-position.ts — 命令位解析（纯函数，无宿主依赖）。
 *
 * 目标：回答「这条 bash 命令真正会跑哪些程序」。做法 = 切段 → 分词 → 剥离包装器 →
 * 取命令位词，并对四个藏身处递归：shell 族 `-c` 的脚本文本、`eval` 的参数、
 * `$(...)` 与反引号里的命令替换。深度有上限（缺省 3），到顶就停，不猜。
 *
 * 不做：别名展开、变量展开、通配符、重定向、`&&` / `||` 的短路语义、`find -exec`、
 * `make` 的 recipe、`docker run` / `ssh host '…'` 之类的「隔一层执行」（见 README）。
 */

import {
  commandName,
  isAssignment,
  splitCommandSegments,
  substitutionBodies,
  tokenizeSegment,
} from "./segments.ts";
import { stripWrappers, WRAPPERS } from "./wrappers.ts";
import type { WrapperSpec } from "./wrappers.ts";

/** shell 族命令名：它们的 `-c` 参数是一段要再解析的命令。 */
export const SHELL_NAMES: readonly string[] = [
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
];

/** 命令位的来源。 */
export type CommandSource = "top" | "shell" | "eval" | "substitution";

/** 一个命令位。 */
export interface CommandPosition {
  /** 命令名（已剥离包装器、取 basename；不带路径与引号）。 */
  readonly word: string;
  /** 所在段的序号（顶层命令从 0 开始；嵌套解析各自重新编号）。 */
  readonly segment: number;
  /** 递归深度（顶层为 0）。 */
  readonly depth: number;
  /** 剥离掉的包装器链，如 `["sudo", "env"]`。 */
  readonly wrappers: readonly string[];
  /** 这个命令位从哪来的。 */
  readonly source: CommandSource;
  /** 命令位是否由展开产生（`$cmd` / `$(...)` / 反引号），此时 `word` 不可信。 */
  readonly dynamic: boolean;
}

/** 解析选项。 */
export interface CommandParseOptions {
  /** 递归深度上限（缺省 3；0 = 只看顶层段）。 */
  readonly maxDepth?: number;
  /** 追加的包装器（排在 `WRAPPERS` 之前，优先匹配）。 */
  readonly wrappers?: readonly WrapperSpec[];
}

/** 缺省递归深度上限。 */
export const DEFAULT_MAX_DEPTH = 3;

/** 解析上下文（避免在递归里传五个参数）。 */
interface WalkContext {
  readonly maxDepth: number;
  readonly wrappers: readonly WrapperSpec[];
  readonly out: CommandPosition[];
}

/** 词是否由展开产生（词面不完整，命令名不可信）。 */
function isDynamicWord(token: string): boolean {
  return token.startsWith("$") || token.includes("$(") || token.includes("`");
}

/** shell 族 `-c` / `--command` 之后的脚本 token 下标。 */
function shellScriptIndex(rest: readonly string[]): number {
  return rest.findIndex(
    (token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token) || token === "--command",
  );
}

/** 处理一个命令位派生的嵌套脚本文本（shell `-c` / `eval`）。 */
function walkNested(
  word: string,
  rest: readonly string[],
  depth: number,
  context: WalkContext,
): void {
  const next = depth + 1;
  if (next > context.maxDepth) return;
  if (SHELL_NAMES.includes(word)) {
    const at = shellScriptIndex(rest);
    const script = at >= 0 ? rest[at + 1] : undefined;
    if (script !== undefined && script.trim().length > 0) {
      walk(script, next, "shell", context);
    }
    return;
  }
  if (word === "eval") {
    const script = rest.join(" ");
    if (script.trim().length > 0) walk(script, next, "eval", context);
  }
}

/** 递归主体：切段 → 剥离包装器 → 落命令位 → 递归嵌套来源。 */
function walk(
  text: string,
  depth: number,
  source: CommandSource,
  context: WalkContext,
): void {
  const { segments } = splitCommandSegments(text);
  for (const [index, segment] of segments.entries()) {
    const tokens = tokenizeSegment(segment).map((token) => token.value);
    if (tokens.length > 0) {
      const stripped = stripWrappers(tokens, context.wrappers);
      // 段首的变量赋值不属于命令位（`FOO=1 python x`）
      let at = stripped.index;
      while (tokens[at] !== undefined && isAssignment(tokens[at]!)) at += 1;
      const token = tokens[at];
      if (token !== undefined) {
        const dynamic = isDynamicWord(token);
        const word = commandName(token);
        if (word.length > 0) {
          context.out.push({
            word,
            segment: index,
            depth,
            wrappers: stripped.wrappers,
            source,
            dynamic,
          });
          if (!dynamic) {
            walkNested(word, tokens.slice(at + 1), depth, context);
          }
        }
      }
    }
    // 段内命令替换 / 反引号：与命令位平行，单独递归
    if (depth + 1 <= context.maxDepth) {
      for (const body of substitutionBodies(segment)) {
        walk(body, depth + 1, "substitution", context);
      }
    }
  }
}

/**
 * 解析命令位：按出现顺序返回所有段（含嵌套来源）里的命令位。
 *
 * 引号不配对时照常解析（调用方可先用 `splitCommandSegments().balanced` 判定是否信任）。
 */
export function commandPositions(
  command: string,
  options: CommandParseOptions = {},
): CommandPosition[] {
  const context: WalkContext = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    wrappers: [...(options.wrappers ?? []), ...WRAPPERS],
    out: [],
  };
  walk(command, 0, "top", context);
  return context.out;
}

/** 便利函数：只要命令名列表（按出现顺序，保留重复）。 */
export function commandWords(
  command: string,
  options: CommandParseOptions = {},
): string[] {
  return commandPositions(command, options).map((position) => position.word);
}

/** 命令位是否至少有一处由展开产生（`$cmd` / `$(...)` / 反引号）。 */
export function isDynamicCommand(
  command: string,
  options: CommandParseOptions = {},
): boolean {
  return commandPositions(command, options).some(
    (position) => position.dynamic,
  );
}

/** 某个命令名是否是 shell 族（供消费方复用自己的 `-c` 判断）。 */
export function isShellName(word: string): boolean {
  return SHELL_NAMES.includes(word);
}
