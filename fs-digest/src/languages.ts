// src/languages.ts — 语言推断：按扩展名，可被显式 language 提示覆盖。
// 启发式解析覆盖 Markdown / TS-JS / Python；其余语言依赖 LSP 符号源，
// 无 LSP 时由 digest 层以 unsupported_language 明确报错。

export type Language = "markdown" | "typescript" | "python" | "unknown";

const EXT_TO_LANGUAGE: Record<string, Language> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdown": "markdown",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".pyi": "python",
};

const HINT_TO_LANGUAGE: Record<string, Language> = {
  markdown: "markdown",
  md: "markdown",
  typescript: "typescript",
  ts: "typescript",
  javascript: "typescript",
  js: "typescript",
  python: "python",
  py: "python",
};

/** 先查语言提示（小写），再查扩展名；都未命中返回 "unknown"。 */
export function detectLanguage(filePath: string, hint?: string): Language {
  const normalized = hint?.trim().toLowerCase();
  if (normalized !== undefined && normalized !== "") {
    const mapped = HINT_TO_LANGUAGE[normalized];
    if (mapped !== undefined) return mapped;
  }
  const dot = filePath.lastIndexOf(".");
  if (dot > 0) {
    const ext = filePath.slice(dot).toLowerCase();
    const mapped = EXT_TO_LANGUAGE[ext];
    if (mapped !== undefined) return mapped;
  }
  return "unknown";
}
