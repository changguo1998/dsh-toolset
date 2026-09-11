// src/signatures.ts — 函数/方法签名提取（signatures 模式核心）。
// 从源码行还原签名：多行声明折叠为单行，超过 8 行截断。
// LSP 面直接给出 signature 字段时优先使用。

import type { Language } from "./languages.ts";
import type { LspDocumentSymbol } from "./lsp.ts";
import type { SignatureEntry } from "./types.ts";

export type SignaturesSource = "lsp" | "heuristic" | "markdown";

export interface SignaturesData {
  source: SignaturesSource;
  signatures: SignatureEntry[];
}

/** 单个签名最多折叠的声明行数（超出截断并带 … 标记）。 */
const MAX_SIGNATURE_LINES = 8;

const SIGNATURE_KINDS = new Set(["function", "method", "constructor"]);

// ---------------------------------------------------------------------------
// 共享：TS 系逐行注释剥离（与 outline.ts 相同实现，独立模块避免循环依赖）
// ---------------------------------------------------------------------------

/** 创建逐行剥离器：去掉 // 行注释与块注释片段，保留字符串字面量内容。 */
function createTsLineStripper(): (line: string) => string {
  let inBlock = false;
  return (line: string): string => {
    let out = "";
    let str: string | null = null;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i] ?? "";
      const next = line[i + 1] ?? "";
      if (inBlock) {
        if (ch === "*" && next === "/") {
          inBlock = false;
          i += 1;
        }
        continue;
      }
      if (str !== null) {
        if (ch === "\\") i += 1;
        else if (ch === str) str = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        str = ch;
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlock = true;
        i += 1;
        continue;
      }
      out += ch;
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// 签名折叠
// ---------------------------------------------------------------------------

/**
 * 从起始行收集声明文本，直到括号配平且该行结束；
 * 折叠为单行，超过 MAX_SIGNATURE_LINES 行截断并追加 …。
 */
function collectSignature(lines: string[], startIdx: number): string {
  const parts: string[] = [];
  let open = 0;
  let closed = false;
  for (
    let i = startIdx;
    i < lines.length && parts.length < MAX_SIGNATURE_LINES;
    i += 1
  ) {
    const raw = lines[i] ?? "";
    const code = raw.trim();
    if (code === "") continue;
    parts.push(code);
    // 括号配平跟踪：( ) { } 全部计数，配平后且该行非继续符则结束
    for (const ch of code) {
      if (ch === "(" || ch === "{" || ch === "[") open += 1;
      else if (ch === ")" || ch === "}" || ch === "]") open -= 1;
    }
    const looksClosed =
      open <= 0 && !(code.endsWith(",") || code.endsWith("\\"));
    if (looksClosed) {
      closed = true;
      break;
    }
  }
  let text = parts.join(" ");
  if (!closed) text += " …";
  return text;
}

/** TS/JS 启发式签名提取：函数声明、箭头函数、类方法（缩进 > 0）。 */
export function extractTsSignatures(text: string): SignatureEntry[] {
  const strip = createTsLineStripper();
  const lines = text.split("\n");
  const out: SignatureEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const code = strip(raw).trim();
    if (code === "") continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      // 顶层：函数声明与箭头函数
      const fn = code.match(
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      );
      if (fn !== null) {
        out.push({
          kind: "function",
          name: fn[1] ?? "",
          line: i + 1,
          signature: collectSignature(lines, i),
        });
        continue;
      }
      const arrow = code.match(
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?\s*=\s*(?:async\s+)?/,
      );
      const head =
        arrow !== null
          ? code.slice((arrow[1] ?? "").length + (arrow[0] ?? "").length)
          : "";
      if (
        arrow !== null &&
        head.trimStart().includes("=>") &&
        /^(?:\(|[A-Za-z_$])/.test(head.trimStart())
      ) {
        out.push({
          kind: "function",
          name: arrow[1] ?? "",
          line: i + 1,
          signature: collectSignature(lines, i),
        });
      }
    } else {
      // 类方法（缩进行）
      const m = code.match(
        /^(?:static\s+|async\s+|get\s+|set\s+|public\s+|private\s+|protected\s+|override\s+|\*)*(constructor|[A-Za-z_$][\w$]*)\s*\(/,
      );
      if (m !== null) {
        const name = m[1] ?? "";
        const kind = name === "constructor" ? "constructor" : "method";
        out.push({
          kind,
          name,
          line: i + 1,
          signature: collectSignature(lines, i),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Python 签名提取
// ---------------------------------------------------------------------------

/** 括号配平收集 Python def 签名（缩进块内的下一缩进块/冒号结束）。 */
/** Python 头行结尾的 ":" 是语法部件而非签名内容，统一去掉。 */
function stripHeaderColon(sig: string): string {
  return sig.replace(/:\s*$/, "");
}

function collectPythonSignature(lines: string[], startIdx: number): string {
  const startLine = (lines[startIdx] ?? "").trim();
  // 单行即完整（以 : 结尾）
  if (startLine.endsWith(":")) return stripHeaderColon(startLine);
  // 多行：直到括号配平的一行
  let open = 0;
  const parts: string[] = [];
  for (
    let i = startIdx;
    i < lines.length && parts.length < MAX_SIGNATURE_LINES;
    i += 1
  ) {
    const code = (lines[i] ?? "").trim();
    if (code === "") continue;
    parts.push(code);
    for (const ch of code) {
      if (ch === "(" || ch === "[") open += 1;
      else if (ch === ")" || ch === "]") open -= 1;
    }
    if (open <= 0) break;
  }
  return stripHeaderColon(parts.join(" "));
}

/** Python 启发式签名提取：顶层与缩进 def（方法 vs 函数按缩进区分）。 */
export function extractPythonSignatures(text: string): SignatureEntry[] {
  const lines = text.split("\n");
  const out: SignatureEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (m === null) continue;
    const kind: "function" | "method" = indent === 0 ? "function" : "method";
    out.push({
      kind,
      name: m[1] ?? "",
      line: i + 1,
      signature: collectPythonSignature(lines, i),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// LSP 符号 → 签名
// ---------------------------------------------------------------------------

function signatureFromLines(lines: string[], sym: LspDocumentSymbol): string {
  if (sym.signature !== undefined) return sym.signature;
  const idx = Math.max(0, sym.line - 1);
  const available = lines.length - idx;
  const truncated = available < MAX_SIGNATURE_LINES;
  const slice = lines.slice(idx, idx + MAX_SIGNATURE_LINES);
  const joined = (slice ?? []).filter((l) => (l ?? "").trim() !== "").join(" ");
  return truncated ? `${joined} …` : joined;
}

/** 从 LSP 符号树收集 function/method/constructor 签名（递归）。 */
export function extractLspSignatures(
  symbols: LspDocumentSymbol[],
  lines: string[],
): SignatureEntry[] {
  const out: SignatureEntry[] = [];
  const walk = (list: LspDocumentSymbol[]): void => {
    for (const sym of list) {
      if (SIGNATURE_KINDS.has(sym.kind)) {
        out.push({
          kind: sym.kind as SignatureEntry["kind"],
          name: sym.name,
          line: sym.line,
          signature: signatureFromLines(lines, sym),
        });
      }
      walk(sym.children ?? []);
    }
  };
  walk(symbols);
  return out;
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/** 组装 signatures：LSP 优先；Markdown 无函数概念返回空；TS/Python 走启发式。 */
export function buildSignatures(
  text: string,
  language: Language,
  symbols: LspDocumentSymbol[] | null | undefined,
): SignaturesData {
  const lines = text.split("\n");
  if (
    language !== "markdown" &&
    symbols !== null &&
    symbols !== undefined &&
    symbols.length > 0
  ) {
    return { source: "lsp", signatures: extractLspSignatures(symbols, lines) };
  }
  if (language === "typescript") {
    return { source: "heuristic", signatures: extractTsSignatures(text) };
  }
  if (language === "python") {
    return { source: "heuristic", signatures: extractPythonSignatures(text) };
  }
  // Markdown 或 unknown（无 LSP）：无函数签名
  return {
    source: language === "markdown" ? "markdown" : "heuristic",
    signatures: [],
  };
}
