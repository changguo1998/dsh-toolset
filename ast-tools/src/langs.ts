/**
 * 语言别名归一化：用户友好名 → ast-grep CLI 语言标识。
 *
 * 映射清单基于 ast-grep 0.45.x 支持的语言
 * (https://ast-grep.github.io/reference/languages.html)；
 * 未收录的值一律小写后原样透传，由 CLI 校验并给出支持语言列表报错。
 */

/** 常见别名映射（未列出的名称小写后直接透传）。 */
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  rs: "rust",
  cpp: "c++",
  cc: "c++",
  cxx: "c++",
  cs: "csharp",
  rb: "ruby",
  yml: "yaml",
  sh: "bash",
  zsh: "bash",
  kt: "kotlin",
  go: "go",
};

/**
 * 归一化语言名："TS" → "typescript"，"ts" → "typescript"，
 * "C++" → "c++"（小写），"go" → "go"，未知值 → 小写透传。
 */
export function normalizeLanguage(language: string): string {
  const key = language.trim().toLowerCase();
  return LANG_ALIASES[key] ?? key;
}
