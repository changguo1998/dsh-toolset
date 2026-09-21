/**
 * 候选引用（recall）：对目标符号做「同名标识符」全仓搜索（ast-grep）。
 *
 * 候选语义：无类型解析的近似——凡出现同名 identifier 即记为候选，
 * 精确裁决（是否真引用、消歧）由 LSP 语义层（增量）负责；首版这些候选
 * 即为 callers 答案，文档声明为近似。
 */

import { normalizeLanguage } from "@dsh-toolset/ast-tools";
import type { AstToolsBundle } from "@dsh-toolset/ast-tools";
import type { CandidateRef, CodeMapSymbol } from "../types.ts";

/** 惰性物化候选引用：全仓搜同名标识符。 */
export async function candidateRefs(
  ast: AstToolsBundle,
  root: string,
  symbol: CodeMapSymbol,
): Promise<CandidateRef[]> {
  const hits = await ast.search({
    pattern: symbol.name,
    language: normalizeLanguage(symbol.language),
    path: root,
    strictness: "smart",
  });
  return hits.map((h) => ({
    file: h.file,
    line: h.range.start.line,
    column: h.range.start.column,
    text: h.text,
  }));
}

/** 过滤掉与定义区间重叠的出现（定义本身不视为引用）。 */
export function excludeDefinitionRange(
  refs: CandidateRef[],
  symbol: CodeMapSymbol,
): CandidateRef[] {
  return refs.filter(
    (r) =>
      !(
        r.file === symbol.file &&
        r.line >= symbol.startLine &&
        r.line <= symbol.endLine
      ),
  );
}
