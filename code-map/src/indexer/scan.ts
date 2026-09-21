/**
 * 结构层：全量扫描（文件收集 → ast-grep outline → 符号表 + import 边）。
 *
 * 复用 ast-tools（ast-grep CLI）`outlineFile({ items: "all" })`：
 * 对每个源文件返回 imports + structure + exports 三类符号。
 * import 边按相对说明符解析到仓库内文件（补扩展名/目录 index），
 * 裸模块与内置模块（fs、node:path、@scope/* 等）记外部（to=null）。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";
import type {
  AstToolsBundle,
  OutlineFile,
  OutlineSymbol,
} from "@dsh-toolset/ast-tools";
import { normalizeLanguage } from "@dsh-toolset/ast-tools";
import type {
  CodeMapFile,
  CodeMapSymbol,
  FileImport,
  ScanResult,
} from "../types.ts";

/** 常见源码扩展名 → ast-grep 语言。 */
export const SOURCE_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  cs: "csharp",
  kt: "kotlin",
  php: "php",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "c++",
  cpp: "c++",
  hpp: "c++",
};

/** 递归扫描时跳过的目录（仓库噪音）。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "tmp",
  "archive",
  ".ruff_cache",
  ".pi-glla",
  "coverage",
  ".dsh",
  ".vscode",
]);

/** 收集仓库内全部源码文件（绝对路径列表）。 */
export function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
      } else if (
        st.isFile() &&
        SOURCE_EXT[extname(name).slice(1)] !== undefined
      ) {
        out.push(normalize(p));
      }
    }
  };
  walk(normalize(root));
  return out.sort();
}

/** 相对说明符 → 仓库内绝对路径候选（补扩展名 / index 文件）。 */
function candidatePaths(base: string): string[] {
  const out: string[] = [];
  const ext = extname(base);
  if (ext !== "" && SOURCE_EXT[ext.slice(1)] !== undefined) {
    out.push(base);
  } else {
    for (const e of [
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".js",
      ".mjs",
      ".cjs",
      ".jsx",
      ".py",
      ".rs",
      ".go",
      ".java",
      ".rb",
      ".cs",
      ".kt",
      ".php",
    ]) {
      out.push(base + e);
      if (!ext.includes("ts")) out.push(join(base, `index${e}`));
    }
  }
  return out;
}

/** 解析 import 说明符到仓库内文件；无法解析（外部/内置/相对不存在）返回 null。 */
export function resolveImport(
  specifier: string,
  fromFile: string,
  root: string,
): string | null {
  const s = specifier.trim().replace(/["'`]/g, "");
  let base: string;
  if (s.startsWith("./") || s.startsWith("../")) {
    base = resolve(dirname(fromFile), s);
  } else if (s.startsWith("/") || isAbsolute(s)) {
    base = normalize(s);
  } else {
    return null; // 裸模块 / node: 内置 / @scope 外部
  }
  for (const cand of candidatePaths(base)) {
    const n = normalize(cand);
    if (existsSync(n) && n.startsWith(root)) return n;
  }
  return null;
}

/** outline 符号 → CodeMapSymbol（顶层 + 成员；成员保留简单名，层级由 kind 表达）。 */
function toCodeMapSymbol(
  sym: OutlineSymbol,
  file: string,
  language: string,
): CodeMapSymbol[] {
  const out: CodeMapSymbol[] = [
    {
      id: `${file}::${sym.range.start.line}:${sym.name}`,
      name: sym.name,
      kind: sym.astKind || sym.symbolType || "unknown",
      file,
      language,
      startLine: sym.range.start.line,
      endLine: sym.range.end.line,
      signature: sym.signature ?? "",
      exported: sym.isExported,
    },
  ];
  for (const m of sym.members ?? [])
    out.push(...toCodeMapSymbol(m, file, language));
  return out;
}

/** 从单文件 outline 结果提取 import 说明符列表（isImport 项）。 */
function collectSpecifiers(outline: OutlineFile): string[] {
  const acc: string[] = [];
  const walk = (syms: OutlineSymbol[]): void => {
    for (const s of syms) {
      if (s.isImport) {
        const raw = s.name.trim().replace(/["'`]/g, "");
        // 兼容 import/export 语句形态：可能整行或仅说明符
        const parts = raw.split(/\s+from\s+/i);
        acc.push(parts[parts.length - 1] ?? raw);
      }
      walk(s.members ?? []);
    }
  };
  walk(outline.items ?? []);
  return acc;
}

/**
 * 全量扫描。
 * @param ast ast-tools bundle（ast-grep 可用）
 * @param root 仓库根
 */
export async function scanProject(
  ast: AstToolsBundle,
  root: string,
): Promise<ScanResult> {
  const files = new Map<string, CodeMapFile>();
  const imports: FileImport[] = [];
  let filesScanned = 0;
  for (const file of collectSourceFiles(root)) {
    filesScanned++;
    let outlines: OutlineFile[];
    // 单文件输入：语言由 CLI 按扩展名推断（显式传语言避免个别扩展名歧义）
    const lang = normalizeLanguage(extname(file).slice(1));
    try {
      outlines = await ast.outline({
        path: file,
        items: "all",
        language: lang,
      });
    } catch {
      continue; // 语法错误/不受支持 → 结构层容错跳过该文件
    }
    const o = outlines[0];
    if (!o) continue;
    const symbols: CodeMapSymbol[] = [];
    for (const item of o.items ?? []) {
      if (item.isImport) continue;
      symbols.push(...toCodeMapSymbol(item, file, lang));
    }
    files.set(file, { path: file, language: lang, symbols });
    for (const spec of collectSpecifiers(o)) {
      imports.push({
        from: file,
        specifier: spec,
        to: resolveImport(spec, file, root),
      });
    }
  }
  return {
    files: [...files.values()],
    imports,
    filesScanned,
  };
}
