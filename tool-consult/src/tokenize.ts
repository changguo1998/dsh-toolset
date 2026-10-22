/**
 * tokenize.ts — 检索用分词（纯函数，无宿主依赖）。
 *
 * 两套规则合并：ASCII 按非字母数字边界 + 驼峰切分后小写；CJK 取二元组
 * （单字串回落为单字）。英文停止词不入索引，避免 "the / to / of" 这类
 * 高频词把所有工具的分数拉平。
 */

/** 英文停止词（小写）。只收极高频、无区分度的词。 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "use",
  "used",
  "using",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

/** 是否 CJK 字符（基本区 + 扩展 A + 兼容区）。 */
export function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** 切 camelCase / PascalCase：`taskDecompose` → `task` `Decompose`。 */
function splitCamel(segment: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const ch of segment) {
    const upper = ch >= "A" && ch <= "Z";
    const prevLower =
      current.length > 0 &&
      current[current.length - 1]! >= "a" &&
      current[current.length - 1]! <= "z";
    if (upper && prevLower) {
      parts.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * 分词主入口：返回去重前的原始 token 序列（BM25 需要词频，故不在这里去重）。
 * @param text 查询或工具文档文本。
 * @returns 小写 ASCII 词与 CJK 二元组。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let ascii = "";
  let cjk = "";

  const flushAscii = (): void => {
    if (ascii.length === 0) return;
    for (const part of splitCamel(ascii)) {
      const lower = part.toLowerCase();
      if (lower.length >= 2 && !STOP_WORDS.has(lower)) tokens.push(lower);
    }
    ascii = "";
  };
  const flushCjk = (): void => {
    if (cjk.length === 0) return;
    if (cjk.length === 1) tokens.push(cjk);
    else {
      for (let i = 0; i + 1 < cjk.length; i += 1) {
        tokens.push(cjk.slice(i, i + 2));
      }
    }
    cjk = "";
  };

  for (const ch of text) {
    if (isCjk(ch)) {
      flushAscii();
      cjk += ch;
      continue;
    }
    const isWord =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9");
    if (isWord) {
      flushCjk();
      ascii += ch;
      continue;
    }
    flushAscii();
    flushCjk();
  }
  flushAscii();
  flushCjk();
  return tokens;
}

/** 去重并保留首次出现顺序（查询侧用）。 */
export function uniqueTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
