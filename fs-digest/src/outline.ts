// src/outline.ts — 章节/符号大纲提取（outline 模式核心）。
// 三条来源：Markdown 标题解析 / LSP 文档符号 / 正则启发式（TS-JS、Python）。
// 深度语义：代码 = 声明嵌套层（顶层 1 级、类方法 2 级）；Markdown = 最大标题级。

import type { Language } from "./languages.ts";
import type { LspDocumentSymbol } from "./lsp.ts";
import type { OutlineNode, SymbolKind } from "./types.ts";

export type OutlineSource = "lsp" | "heuristic" | "markdown";

export interface OutlineData {
  source: OutlineSource;
  nodes: OutlineNode[];
}

/** outline 默认深度。 */
export const DEFAULT_OUTLINE_DEPTH = 3;

// ---------------------------------------------------------------------------
// 共享：TS 系逐行注释剥离（状态机，跨行块注释/字符串安全）
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

/** 统计一行（已剥离注释）的净花括号增减。 */
export function countBraces(code: string): number {
  let delta = 0;
  for (const ch of code) {
    if (ch === "{") delta += 1;
    else if (ch === "}") delta -= 1;
  }
  return delta;
}

// ---------------------------------------------------------------------------
// Markdown 大纲
// ---------------------------------------------------------------------------

/** Markdown ATX 标题大纲（跳过围栏代码块内行；深度 = 最大标题级）。 */
export function parseMarkdownOutline(
  text: string,
  depth: number,
): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: Array<{ node: OutlineNode; level: number }> = [];
  let inFence = false;
  let fenceChar = "";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const fence = raw.trimStart().match(/^(`{3,}|~{3,})/);
    if (fence !== null) {
      const marker = fence[1]?.[0] ?? "";
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m === null) continue;
    const level = m[1]?.length ?? 0;
    if (level > depth) continue;
    const node: OutlineNode = {
      kind: "heading",
      name: m[2] ?? "",
      line: i + 1,
      children: [],
    };
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined || top.level < level) break;
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1]?.node : undefined;
    if (parent !== undefined) parent.children.push(node);
    else roots.push(node);
    stack.push({ node, level });
  }
  return roots;
}

// ---------------------------------------------------------------------------
// TS / JS 启发式大纲
// ---------------------------------------------------------------------------

/** 顶层声明正则（按序尝试，先命中先归类）。 */
const TS_TOP_PATTERNS: Array<{ kind: SymbolKind; re: RegExp }> = [
  {
    kind: "function",
    re: /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  },
  { kind: "class", re: /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "interface", re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "enum", re: /^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/ },
  { kind: "type", re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/ },
];

/** 类方法行正则（修饰符 + 名称 + 参数列表开头）。 */
const TS_METHOD_RE =
  /^(?:static\s+|async\s+|readonly\s+|get\s+|set\s+|public\s+|private\s+|protected\s+|override\s+|\*)*(constructor|[A-Za-z_$][\w$]*)\s*\(/;

/** 顶层 const/let/var 箭头函数判定：名称 + 紧跟箭头头部（排除对象字面量等）。 */
const TS_ARROW_RE =
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*=\s*(.*)$/;
const TS_ARROW_HEAD_RE = /^(?:async\s+)?(\(|[A-Za-z_$][\w$]*\s*[=(]|function)/;

/** TS/JS 启发式大纲：顶层声明 + 类方法（按花括号深度跟踪类作用域）。 */
export function parseTsOutline(text: string, depth: number): OutlineNode[] {
  const strip = createTsLineStripper();
  const lines = text.split("\n");
  const roots: OutlineNode[] = [];
  const containers: Array<{ node: OutlineNode; openDepth: number }> = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const code = strip(raw).trim();
    if (code === "") continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      // 顶层：const 箭头函数先判（避免被其他模式误吞）
      const arrow = code.match(TS_ARROW_RE);
      let node: OutlineNode | undefined;
      let matchedKind: SymbolKind | undefined;
      if (
        arrow !== null &&
        TS_ARROW_HEAD_RE.test(arrow[2] ?? "") &&
        (arrow[2] ?? "").includes("=>") &&
        !(arrow[2] ?? "").includes("===>")
      ) {
        node = {
          kind: "function",
          name: arrow[1] ?? "",
          line: i + 1,
          children: [],
        };
        matchedKind = "function";
      } else {
        for (const { kind, re } of TS_TOP_PATTERNS) {
          const m = code.match(re);
          if (m !== null) {
            node = { kind, name: m[1] ?? "", line: i + 1, children: [] };
            matchedKind = kind;
            break;
          }
        }
      }
      if (node !== undefined) {
        roots.push(node);
        if (matchedKind === "class") {
          // 类容器：以本行花括号处理前的深度为界，回落到该深度即出类
          containers.push({ node, openDepth: braceDepth });
        }
      }
    } else if (containers.length > 0) {
      // 类方法：直接子层（深度 = 类开括号深度 + 1）且仍有深度预算
      const container = containers[containers.length - 1];
      if (
        container !== undefined &&
        braceDepth === container.openDepth + 1 &&
        depth >= 2
      ) {
        const m = code.match(TS_METHOD_RE);
        if (m !== null) {
          const name = m[1] ?? "";
          container.node.children.push({
            kind: name === "constructor" ? "constructor" : "method",
            name,
            line: i + 1,
            children: [],
          });
        }
      }
    }
    // 花括号深度推进 + 类容器出栈（对所有非空行统一执行）
    braceDepth += countBraces(strip(raw));
    while (containers.length > 0) {
      const top = containers[containers.length - 1];
      if (top === undefined || braceDepth > top.openDepth) break;
      containers.pop();
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Python 启发式大纲
// ---------------------------------------------------------------------------

/** Python 启发式大纲：顶层 def/class + 类内 def（按缩进跟踪类作用域）。 */
export function parsePythonOutline(text: string, depth: number): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const lines = text.split("\n");
  let currentClass: OutlineNode | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const lineNo = i + 1;

    if (indent === 0) {
      // 顶层语句：class 开启类作用域，其余（含顶层 def）结束类作用域
      const cls = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
      if (cls !== null) {
        currentClass = {
          kind: "class",
          name: cls[1] ?? "",
          line: lineNo,
          children: [],
        };
        roots.push(currentClass);
        continue;
      }
      const def = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/);
      if (def !== null) {
        roots.push({
          kind: "function",
          name: def[1] ?? "",
          line: lineNo,
          children: [],
        });
      }
      currentClass = null;
      continue;
    }

    // 缩进行：类作用域内记录方法/嵌套类
    if (currentClass !== null && depth >= 2) {
      const def = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/);
      if (def !== null) {
        currentClass.children.push({
          kind: "method",
          name: def[1] ?? "",
          line: lineNo,
          children: [],
        });
        continue;
      }
      const nested = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
      if (nested !== null) {
        currentClass.children.push({
          kind: "class",
          name: nested[1] ?? "",
          line: lineNo,
          children: [],
        });
      }
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------
// LSP 符号映射
// ---------------------------------------------------------------------------

const LSP_KIND_MAP: Record<string, SymbolKind> = {
  function: "function",
  method: "method",
  class: "class",
  struct: "class",
  interface: "interface",
  type: "type",
  typedef: "type",
  enum: "enum",
  variable: "variable",
  constant: "variable",
  module: "other",
  namespace: "other",
  heading: "heading",
  section: "heading",
};
LSP_KIND_MAP["constructor"] = "constructor";

function mapLspNode(
  sym: LspDocumentSymbol,
  level: number,
  depth: number,
): OutlineNode | null {
  if (level > depth) return null;
  const node: OutlineNode = {
    kind: LSP_KIND_MAP[sym.kind] ?? "other",
    name: sym.name,
    line: sym.line,
    children: [],
  };
  for (const child of sym.children ?? []) {
    const mapped = mapLspNode(child, level + 1, depth);
    if (mapped !== null) node.children.push(mapped);
  }
  return node;
}

/**
 * 组装 outline：Markdown 走标题解析；有 LSP 符号时走 LSP（任意语言）；
 * 否则 TS/Python 走启发式；unknown 语言且无 LSP 时返回空（digest 层负责报错）。
 */
export function buildOutline(
  text: string,
  language: Language,
  depth: number,
  symbols: LspDocumentSymbol[] | null | undefined,
): OutlineData {
  if (language === "markdown") {
    return { source: "markdown", nodes: parseMarkdownOutline(text, depth) };
  }
  if (symbols !== null && symbols !== undefined && symbols.length > 0) {
    const nodes = symbols
      .map((sym) => mapLspNode(sym, 1, depth))
      .filter((n): n is OutlineNode => n !== null);
    return { source: "lsp", nodes };
  }
  if (language === "typescript") {
    return { source: "heuristic", nodes: parseTsOutline(text, depth) };
  }
  if (language === "python") {
    return { source: "heuristic", nodes: parsePythonOutline(text, depth) };
  }
  return { source: "heuristic", nodes: [] };
}
