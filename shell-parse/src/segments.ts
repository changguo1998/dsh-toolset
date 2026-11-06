/**
 * segments.ts — 命令切段与分词（纯函数，无宿主依赖）。
 *
 * 口径：只做词法级处理，**不解释 shell 语义**（别名、变量展开、通配符、重定向、
 * 命令替换的执行顺序都不管）。分隔符 = `;` `|` `&` 与换行，引号内的分隔符不切。
 * 引号不配对时 `balanced` 为 `false`，由上层决定是否信任结果（本层不抛错、不猜）。
 */

/** 切段结果。 */
export interface SegmentedCommand {
  /** 按分隔符切出的命令段（已去首尾空白，空段丢弃）。 */
  readonly segments: readonly string[];
  /** 引号是否配对；`false` 表示引号内的分隔符可能被当成了段边界。 */
  readonly balanced: boolean;
}

/** 一个词。 */
export interface CommandToken {
  /** 词面（外层引号已去掉）。 */
  readonly value: string;
  /** 是否含引号片段（`'a;b'` / `"a b"` / `'a'`）。 */
  readonly quoted: boolean;
}

/**
 * 切段：按 `;` `|` `&` 与换行切分，引号内的分隔符不切。
 *
 * `||` / `&&` / `;;` 这类连续分隔符按单个处理（中间的 `current` 为空，直接丢弃）。
 */
export function splitCommandSegments(command: string): SegmentedCommand {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of command) {
    // 引号内原样累积，直到配对引号闭合
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
      if (current.trim().length > 0) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) segments.push(current.trim());
  return { segments, balanced: quote === null };
}

/**
 * 分词：空白分隔；引号串整体算一个词，且引号紧贴前文时先断开
 * （`-m"b"` → `-m` + `b`，与 `-m "b"` 同形）。转义符 `\` 吞掉自身、保留后一个字符。
 */
export function tokenizeSegment(segment: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let current = "";
  let quoted = false;
  let quote: string | null = null;
  // 落词：空串只有在带引号（`''`）时才算一个词
  const flush = (): void => {
    if (current.length > 0 || quoted) tokens.push({ value: current, quoted });
    current = "";
    quoted = false;
  };
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        quoted = true;
        continue;
      }
      // 双引号内的 `\"` 是字面量；单引号内没有转义
      if (ch === "\\" && quote === '"') {
        const next = segment[i + 1];
        if (next !== undefined) {
          current += next;
          i += 1;
          continue;
        }
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (current.length > 0) flush();
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === "\\") {
      const next = segment[i + 1];
      if (next !== undefined) {
        current += next;
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

/** 路径的最后一段（无分隔符时原样返回）。 */
export function basenameOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * 词 → 命令名：去掉前导结构符（`(` `[` `{` `!`）、残留括号与分号、成对引号，再取 basename。
 * 只看词形，不判断它是否真是可执行文件。
 */
export function commandName(word: string): string {
  const trimmed = word.replace(/^[([{!]+/, "").replace(/[)\]};]+$/, "");
  return basenameOf(trimmed).replace(/^["']+|["']+$/g, "");
}

/** 是否是变量赋值（`VAR=值` / `VAR="值"`），赋值不属于命令位。 */
export function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/**
 * 命令替换与反引号里的正文（`$(...)` 里的 `...`、`` `...` `` 里的 `...`）。
 *
 * `$(` 按括号配平找闭合（不处理引号语义）；`$((` 视为算术表达式跳过。
 * 反引号按下一处反引号配对，不处理嵌套。
 */
export function substitutionBodies(text: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      // 算术表达式 `$((1 + 2))` 不是命令
      if (text[i + 2] === "(") continue;
      let depth = 1;
      let j = i + 2;
      for (; j < text.length; j += 1) {
        const inner = text[j]!;
        if (inner === "(") depth += 1;
        else if (inner === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth === 0) {
        bodies.push(text.slice(i + 2, j));
        i = j;
      }
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        bodies.push(text.slice(i + 1, end));
        i = end;
      }
    }
  }
  return bodies;
}
