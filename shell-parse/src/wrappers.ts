/**
 * wrappers.ts — 包装器表与剥离逻辑（纯函数，无宿主依赖）。
 *
 * 「包装器」= 自己不是要执行的程序，只转手去跑后面那条命令的入口：`sudo` / `env` /
 * `nohup` / `timeout` / `xargs` / `uv run` / `npx` / `pnpm exec` / `bundle exec` …
 * 剥离它们之后剩下的那个词才是**命令位**（`commandPositions` 据此判定真正跑的是什么）。
 *
 * 每条包装器只声明「多看几个词」「跳过几个位置参数」「哪些选项带值」三件事，
 * 不做完整选项解析：不认识的选项按无值处理（宁可多看一眼，也不少看）。
 */

import { commandName, isAssignment } from "./segments.ts";

/** 一条包装器声明。 */
export interface WrapperSpec {
  /** 包装器自己的命令名序列（多词包装器逐词匹配，如 `["uv", "run"]`）。 */
  readonly words: readonly string[];
  /** 包装器之后、被跑命令之前的固定位置参数个数（`timeout 30 cmd` 的 `30`）。 */
  readonly skipArgs?: number;
  /** 带值选项：选项的值也要一并跳过（`sudo -u root cmd` / `timeout -s KILL 5 cmd`）。 */
  readonly valueOptions?: readonly string[];
}

/**
 * 内置包装器表（顺序即匹配优先级，多词优先由数组顺序保证）。
 *
 * 收录标准：命令名稳定、语义就是「转手执行」，且在真实会话里出现过（含模型常见的
 * 脚手架包装）。**不收** `sh` / `bash` 这类 shell 本身 —— 它们由 `commandPositions`
 * 单独按 `-c` 递归处理；也不收 `docker` / `ssh` / `make` 这类「执行环境之间还隔着
 * 一层」的命令（见 README「已知边界」）。
 */
export const WRAPPERS: readonly WrapperSpec[] = [
  {
    words: ["sudo"],
    valueOptions: [
      "-u",
      "--user",
      "-g",
      "--group",
      "-C",
      "--close-from",
      "-D",
      "--chdir",
      "-h",
      "--host",
      "-p",
      "--prompt",
      "-r",
      "--role",
      "-t",
      "--type",
      "-U",
      "--other-user",
    ],
  },
  { words: ["doas"], valueOptions: ["-u", "-C"] },
  {
    words: ["env"],
    valueOptions: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
  },
  { words: ["nohup"] },
  { words: ["exec"], valueOptions: ["-a"] },
  { words: ["time"], valueOptions: ["-o", "--output", "-f", "--format"] },
  { words: ["nice"], valueOptions: ["-n", "--adjustment"] },
  {
    words: ["stdbuf"],
    valueOptions: ["-i", "-o", "-e", "--input", "--output", "--error"],
  },
  {
    words: ["timeout"],
    skipArgs: 1,
    valueOptions: ["-s", "--signal", "-k", "--kill-after"],
  },
  {
    words: ["xargs"],
    valueOptions: [
      "-a",
      "--arg-file",
      "-d",
      "--delimiter",
      "-E",
      "-e",
      "-I",
      "-i",
      "-L",
      "-l",
      "-n",
      "--max-args",
      "-P",
      "--max-procs",
      "-s",
      "--max-chars",
      "-J",
      "--replace",
    ],
  },
  {
    words: ["watch"],
    valueOptions: ["-n", "--interval", "-d", "--differences"],
  },
  { words: ["busybox"] },
  // shell 关键字：`if ...; then cmd; fi` 的段首词
  { words: ["if"] },
  { words: ["then"] },
  { words: ["else"] },
  { words: ["elif"] },
  { words: ["while"] },
  { words: ["until"] },
  { words: ["do"] },
  { words: ["fi"] },
  { words: ["done"] },
  { words: ["esac"] },
  { words: ["!"] },
  // 包管理与脚本运行入口（多词；`run` / `exec` 之后才是被跑的命令）
  {
    words: ["uv", "run"],
    valueOptions: [
      "-p",
      "--python",
      "-w",
      "--with",
      "--with-editable",
      "--with-requirements",
      "-i",
      "--index",
      "--extra",
      "--group",
      "--only-group",
      "--no-group",
    ],
  },
  {
    words: ["poetry", "run"],
    valueOptions: ["-C", "--directory", "-E", "--extras"],
  },
  { words: ["pipenv", "run"], valueOptions: ["-d", "--dir", "--envvars"] },
  {
    words: ["pdm", "run"],
    valueOptions: ["-p", "--project", "-g", "--group", "-G"],
  },
  { words: ["hatch", "run"] },
  { words: ["npx"], valueOptions: ["-p", "--package", "-c", "--call"] },
  { words: ["pnpm", "exec"], valueOptions: ["-C", "--dir", "-F", "--filter"] },
  { words: ["pnpm", "dlx"], valueOptions: ["-C", "--dir"] },
  { words: ["yarn", "exec"], valueOptions: ["-C", "--cwd"] },
  { words: ["yarn", "dlx"] },
  { words: ["bunx"] },
  { words: ["bundle", "exec"], valueOptions: ["-r", "--require"] },
];

/** 单个选项的处理方式。 */
type OptionShape = "none" | "separate" | "attached";

/** 判断选项是否带值：`separate` 表示值在下一个 token，`attached` 表示值粘在本 token 上。 */
function optionShape(
  token: string,
  valueOptions: readonly string[],
): OptionShape {
  for (const option of valueOptions) {
    if (token === option) return "separate";
    if (token.startsWith(`${option}=`)) return "attached";
    // 短选项粘值：-n1 / -pfoo（只对两字符短选项生效，避免把 --user 当成 -u 的变体）
    if (
      option.length === 2 &&
      token.startsWith(option) &&
      token.length > option.length &&
      !token.startsWith("--")
    ) {
      return "attached";
    }
  }
  return "none";
}

/** 在 `index` 处是否匹配某个包装器。 */
function matchesAt(
  tokens: readonly string[],
  index: number,
  words: readonly string[],
): boolean {
  for (const [offset, expected] of words.entries()) {
    const token = tokens[index + offset];
    // `commandName` 会剥掉 `(` `!` 这类结构符，`!` 之类的关键字按原词再比一次
    if (
      token === undefined ||
      (commandName(token) !== expected && token !== expected)
    ) {
      return false;
    }
  }
  return true;
}

/** 跳过包装器自己的参数，返回被跑命令的下标。 */
function skipWrapperArgs(
  tokens: readonly string[],
  start: number,
  spec: WrapperSpec,
): number {
  const valueOptions = spec.valueOptions ?? [];
  let remaining = spec.skipArgs ?? 0;
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    // `--` 之后就是被跑的命令（`uv run -- python x.py`）
    if (token === "--") return index + 1;
    if (isAssignment(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      index += optionShape(token, valueOptions) === "separate" ? 2 : 1;
      continue;
    }
    if (remaining > 0) {
      remaining -= 1;
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

/**
 * 逐层剥离包装器：返回命令位下标与经过的包装器链（`["sudo", "env"]`）。
 *
 * 只在段首生效（词法层不知道管道后的新命令，那属于切段的事）；`guard` 防自指死循环。
 */
export function stripWrappers(
  tokens: readonly string[],
  wrappers: readonly WrapperSpec[] = WRAPPERS,
): { readonly index: number; readonly wrappers: readonly string[] } {
  const chain: string[] = [];
  let index = 0;
  let guard = 0;
  while (index < tokens.length && guard < 32) {
    guard += 1;
    let matched: WrapperSpec | undefined;
    for (const spec of wrappers) {
      if (matchesAt(tokens, index, spec.words)) {
        matched = spec;
        break;
      }
    }
    if (matched === undefined) break;
    chain.push(matched.words.join(" "));
    index = skipWrapperArgs(tokens, index + matched.words.length, matched);
  }
  return { index, wrappers: chain };
}
