// src/lsp.ts — LSP 符号源（tool-lsp 数据底座）的结构面适配。
// 零 DSH 运行时依赖：宿主 LSP 面以 duck-typing 接入（documentSymbols 或 symbols 方法），
// 真实 tool-lsp surface 联调时仅需在本文件对齐方法名。

/** LSP 文档符号（结构类型；line 为 1 基行号，kind 为 LSP SymbolKind 的字符串名）。 */
export interface LspDocumentSymbol {
  name: string;
  kind: string;
  line: number;
  children?: LspDocumentSymbol[];
  /** 部分 LSP 面直接给出签名文本；缺省时由调用方从源码行还原。 */
  signature?: string;
}

/** 符号提供器：返回 null 表示该文件无符号或不受支持（调用方降级启发式）。 */
export interface SymbolProvider {
  documentSymbols(filePath: string): Promise<LspDocumentSymbol[] | null>;
}

/**
 * 解析符号提供器：优先显式注入（deps.provider，单测/嵌入用），
 * 其次宿主 ctx 结构面（ctx.lsp 或 ctx.get("lsp") 的 duck-typed 方法）。
 */
export function resolveSymbolProvider(
  ctx: unknown,
  injected?: SymbolProvider,
): SymbolProvider | undefined {
  if (injected !== undefined) return injected;
  const c = ctx as
    { lsp?: unknown; get?: (name: string) => unknown } | null | undefined;
  const surface =
    c?.lsp ?? (typeof c?.get === "function" ? c.get("lsp") : undefined);
  if (typeof surface !== "object" || surface === null) return undefined;
  const s = surface as { documentSymbols?: unknown; symbols?: unknown };
  const method =
    typeof s.documentSymbols === "function"
      ? (s.documentSymbols as (
          p: string,
        ) => Promise<LspDocumentSymbol[] | null> | LspDocumentSymbol[] | null)
      : typeof s.symbols === "function"
        ? (s.symbols as (
            p: string,
          ) => Promise<LspDocumentSymbol[] | null> | LspDocumentSymbol[] | null)
        : undefined;
  if (method === undefined) return undefined;
  return { documentSymbols: (filePath) => Promise.resolve(method(filePath)) };
}
