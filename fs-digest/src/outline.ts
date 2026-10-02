// src/outline.ts — 章节/符号大纲提取（outline 模式核心）。
// 三条来源：Markdown 标题解析 / LSP 文档符号 / 正则启发式（TS-JS、Python）。
// 深度语义：代码 = 声明嵌套层（顶层 1 级、类方法 2 级）；Markdown = 最大标题级。

import type { Language } from "./languages.ts";
import type { LspDocumentSymbol } from "./lsp.ts";
import type { MdBlock, OutlineNode, SymbolKind } from "./types.ts";

export type OutlineSource = "lsp" | "heuristic" | "markdown";

export interface OutlineData {
  source: OutlineSource;
  nodes: OutlineNode[];
  /** Markdown 块级结构清单（仅 `source: "markdown"` 且检出块时存在）。 */
  blocks?: MdBlock[];
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

/** Markdown 结构扫描结果：标题树（带行范围）+ 平铺块清单。 */
export interface MarkdownScan {
  nodes: OutlineNode[];
  blocks: MdBlock[];
}

const MD_HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const MD_FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const MD_LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const MD_QUOTE_RE = /^ {0,3}>/;
const MD_TABLE_SEP_RE = /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const MD_FM_KEY_RE = /^[A-Za-z0-9_.-]+\s*:/;

/**
 * Markdown 结构与块扫描（单遍）。口径：
 * - **标题集**：只有 `level <= depth` 的 ATX 标题进树；`endLine` 与块 `section` 一律以**输出中的标题**为准，
 *   depth 以下的标题不建节点，其正文（含块）归入最近的输出祖先节。
 * - **行范围**：节范围 = 标题行 → 下一个输出标题前一行（末节到文件最后一个非空行），**尾部空行不计**；
 *   父子范围是**包含关系**（父 ⊇ 子），不是分区。
 * - **块**：frontmatter（仅文件首行、需配对，区间内不认标题）、围栏代码块、GFM 表格、列表、引用，平铺输出。
 * - 不做 setext 标题 / HTML 块 / 嵌套引用；围栏按 CommonMark 的 `^ {0,3}` 缩进上限与「闭合串不短于开启串」。
 */
export function scanMarkdown(text: string, depth: number): MarkdownScan {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const roots: OutlineNode[] = [];
  const blocks: MdBlock[] = [];
  const stack: Array<{ node: OutlineNode; level: number }> = [];
  /** 输出节点 → 标题层级（行范围计算用）。 */
  const levels = new Map<OutlineNode, number>();
  let lastContent = 0;
  let i = 0;

  /** 追加块（`section` 取当前活动标题，保证只指向输出中的标题行）。 */
  const pushBlock = (block: Omit<MdBlock, "section">): void => {
    const top = stack[stack.length - 1];
    blocks.push(
      top === undefined ? block : { ...block, section: top.node.line },
    );
  };

  // frontmatter：仅文件首行开始、需在有界范围内配对收尾，且内部**只含 YAML 键 / 注释 / 空行**
  // （这样 `---` 起始的水平线 + 正文不会被误判，`# yaml 注释` 也不会被当成标题）。
  if ((lines[0] ?? "").trim() === "---") {
    let end = -1;
    const limit = Math.min(lines.length, 41);
    for (let k = 1; k < limit; k += 1) {
      if ((lines[k] ?? "").trim() === "---") {
        end = k;
        break;
      }
    }
    const inner = end > 0 ? lines.slice(1, end) : [];
    const looksYaml =
      inner.length > 0 &&
      inner.every(
        (l) =>
          (l ?? "").trim() === "" ||
          MD_FM_KEY_RE.test(l ?? "") ||
          /^\s*#/.test(l ?? ""),
      );
    if (end > 0 && looksYaml) {
      const keys = inner.filter((l) => MD_FM_KEY_RE.test(l)).length;
      pushBlock({
        kind: "frontmatter",
        line: 1,
        endLine: end + 1,
        count: keys,
      });
      lastContent = end + 1;
      i = end + 1;
    }
  }

  for (; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    if (raw.trim() !== "") lastContent = i + 1;

    const fence = raw.match(MD_FENCE_RE);
    if (fence !== null) {
      const opener = fence[1] ?? "```";
      const info = (fence[2] ?? "").trim();
      let end = lines.length - 1;
      for (let k = i + 1; k < lines.length; k += 1) {
        const cur = lines[k] ?? "";
        if (cur.trim() !== "") lastContent = k + 1;
        const close = cur.match(MD_FENCE_RE);
        if (
          close !== null &&
          (close[1] ?? "").startsWith(opener) &&
          (close[2] ?? "").trim() === ""
        ) {
          end = k;
          break;
        }
      }
      const lang = info.split(/\s+/)[0] ?? "";
      pushBlock({
        kind: "code",
        line: i + 1,
        endLine: end + 1,
        ...(lang === "" ? {} : { lang }),
      });
      i = end;
      continue;
    }

    const heading = raw.match(MD_HEADING_RE);
    if (heading !== null) {
      const level = heading[1]?.length ?? 0;
      if (level <= depth) {
        const node: OutlineNode = {
          kind: "heading",
          name: heading[2] ?? "",
          line: i + 1,
          children: [],
        };
        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top === undefined || top.level < level) break;
          stack.pop();
        }
        const parent = stack[stack.length - 1]?.node;
        if (parent !== undefined) parent.children.push(node);
        else roots.push(node);
        stack.push({ node, level });
        levels.set(node, level);
      }
      continue;
    }

    // GFM 表格：表头行 + 分隔行
    const next = lines[i + 1] ?? "";
    if (raw.includes("|") && MD_TABLE_SEP_RE.test(next) && next.includes("-")) {
      let end = i + 1;
      while (
        end + 1 < lines.length &&
        (lines[end + 1] ?? "").includes("|") &&
        (lines[end + 1] ?? "").trim() !== ""
      ) {
        end += 1;
      }
      pushBlock({
        kind: "table",
        line: i + 1,
        endLine: end + 1,
        count: Math.max(0, end - i - 1),
      });
      lastContent = end + 1;
      i = end;
      continue;
    }

    // 引用块（连续 `>` 行，尾随空行不计）
    if (MD_QUOTE_RE.test(raw)) {
      let end = i;
      while (end + 1 < lines.length && MD_QUOTE_RE.test(lines[end + 1] ?? "")) {
        end += 1;
      }
      pushBlock({
        kind: "quote",
        line: i + 1,
        endLine: end + 1,
        count: end - i + 1,
      });
      lastContent = Math.max(lastContent, end + 1);
      i = end;
      continue;
    }

    // 列表块（允许条目间空行与缩进续行）
    if (MD_LIST_RE.test(raw)) {
      let end = i;
      let count = 1;
      for (let k = i + 1; k < lines.length; k += 1) {
        const cur = lines[k] ?? "";
        if (MD_FENCE_RE.test(cur)) break;
        if (MD_LIST_RE.test(cur)) {
          end = k;
          count += 1;
          continue;
        }
        if (cur.trim() === "") {
          let nk = k + 1;
          while (nk < lines.length && (lines[nk] ?? "").trim() === "") nk += 1;
          if (nk < lines.length && MD_LIST_RE.test(lines[nk] ?? "")) {
            k = nk - 1;
            continue;
          }
          break;
        }
        if (/^\s{2,}\S/.test(cur)) {
          end = k;
          continue;
        }
        break;
      }
      pushBlock({
        kind: "list",
        line: i + 1,
        endLine: end + 1,
        count,
      });
      lastContent = Math.max(lastContent, end + 1);
      i = end;
    }
  }

  // 行范围：节 = 标题行 → 下一个「层级 ≤ 本节」的标题前一行（末节到文件末非空行），尾部空行不计；
  // 随后按子树扩展，保证父子是**包含关系**（父 ⊇ 子），而不是分区。
  const allHeadings: Array<{ level: number; line: number }> = [];
  for (let k = 0; k < lines.length; k += 1) {
    const h = (lines[k] ?? "").match(MD_HEADING_RE);
    if (h !== null) allHeadings.push({ level: h[1]?.length ?? 0, line: k + 1 });
  }
  const extend = (node: OutlineNode): number => {
    const level = levels.get(node) ?? 0;
    let end = lastContent;
    for (const h of allHeadings) {
      if (h.line > node.line && h.level <= level) {
        end = h.line - 1;
        break;
      }
    }
    while (end > node.line && (lines[end - 1] ?? "").trim() === "") end -= 1;
    let childEnd = node.line;
    for (const child of node.children) {
      childEnd = Math.max(childEnd, extend(child));
    }
    const finalEnd = Math.max(node.line, end, childEnd);
    node.endLine = finalEnd;
    return finalEnd;
  };
  for (const root of roots) extend(root);

  return { nodes: roots, blocks };
}

/** Markdown ATX 标题大纲（`scanMarkdown` 的树部分，保留旧签名）。 */
export function parseMarkdownOutline(
  text: string,
  depth: number,
): OutlineNode[] {
  return scanMarkdown(text, depth).nodes;
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
    const scan = scanMarkdown(text, depth);
    return { source: "markdown", nodes: scan.nodes, blocks: scan.blocks };
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
