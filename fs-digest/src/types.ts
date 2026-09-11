// src/types.ts — fs-digest 核心类型：三模式（outline/signatures/pruned）的输入输出契约。
// 结果统一 JSON-serializable（dsh tool/result 值约束）；行号一律 1 基。

/** 三种读取模式。 */
export const DIGEST_MODES = ["outline", "signatures", "pruned"] as const;
export type DigestMode = (typeof DIGEST_MODES)[number];

export type DigestErrorCode =
  | "invalid_option"
  | "file_not_found"
  | "not_a_file"
  | "too_large"
  | "binary"
  | "lsp_unavailable"
  | "unsupported_language";

/** 符号种类（outline 节点 / signatures 条目共用）。 */
export type SymbolKind =
  | "heading"
  | "function"
  | "method"
  | "constructor"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "other";

/** outline 树节点。 */
export interface OutlineNode {
  kind: SymbolKind;
  name: string;
  /** 1 基行号。 */
  line: number;
  children: OutlineNode[];
}

export interface OutlineResult {
  ok: true;
  mode: "outline";
  path: string;
  language: string;
  /** 数据来源：lsp=宿主 LSP 符号；heuristic=正则启发式；markdown=Markdown 标题解析。 */
  source: "lsp" | "heuristic" | "markdown";
  /** 生效的深度上限。 */
  depth: number;
  nodes: OutlineNode[];
}

export interface SignatureEntry {
  kind: "function" | "method" | "constructor";
  name: string;
  /** 1 基行号（声明起始行）。 */
  line: number;
  /** 签名原文（多行声明折叠为单行，超过 8 行截断并带 … 标记）。 */
  signature: string;
}

export interface SignaturesResult {
  ok: true;
  mode: "signatures";
  path: string;
  language: string;
  source: "lsp" | "heuristic" | "markdown";
  signatures: SignatureEntry[];
}

export interface PrunedResult {
  ok: true;
  mode: "pruned";
  path: string;
  totalLines: number;
  /** false = 文件在预算内，text 为全文。 */
  truncated: boolean;
  /** 保留的头部行数（truncated=false 时为 totalLines）。 */
  keptHead: number;
  /** 保留的尾部行数（truncated=false 时为 0）。 */
  keptTail: number;
  elidedLines: number;
  /** 输出文本的 token 估算（按 4 字符/token）。 */
  estimatedTokens: number;
  /** 头部 + 省略标记 + 尾部（truncated=false 时为全文）。 */
  text: string;
}

export interface DigestErrorResult {
  ok: false;
  /** 非法 mode 时为 "unknown"。 */
  mode: DigestMode | "unknown";
  path: string;
  error: DigestErrorCode;
  message: string;
}

export type DigestResult =
  OutlineResult | SignaturesResult | PrunedResult | DigestErrorResult;

/** digest() 调用选项（工具入参同形）。 */
export interface DigestOptions {
  mode: DigestMode;
  /** outline：最大嵌套深度（markdown = 最大标题级），缺省 3。 */
  depth?: number;
  /** pruned：输出总行数上限（含 1 行省略标记），缺省 200。 */
  maxLines?: number;
  /** pruned：token 估算上限（4 字符/token），缺省 4000。 */
  maxTokens?: number;
  /** 语言提示（markdown/typescript/python）；缺省按扩展名推断。 */
  language?: string;
  /** true 时 LSP 不可用（无 provider / 返回空 / 失败）直接报 lsp_unavailable，不降级启发式。 */
  requireLsp?: boolean;
}
