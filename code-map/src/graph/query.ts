/**
 * 图上查询：callers（候选引用）· callees（文件级）· impact（反向闭包）· 模块聚合。
 *
 * 首版语义边界（文档声明）：
 * - callers = 同名标识符候选（近似），精确裁决走 LSP 语义层（增量）；
 * - callees = 符号所在文件的直接 import 目标（文件级），符号级后置；
 * - impact = 反向 import 传递闭包，聚合到「相对 root 首段目录」的模块。
 */

import { relative, sep } from "node:path";
import type {
  CandidateRef,
  CallersResult,
  CodeMapSymbol,
  ImpactResult,
} from "../types.ts";
import { excludeDefinitionRange } from "../indexer/refs.ts";
import type { CodeGraph } from "./graph.ts";

/** 查询依赖（注入候选引用物化：ast-grep lazy 搜索）。 */
export interface QueryDeps {
  refsOf(symbol: CodeMapSymbol): Promise<CandidateRef[]>;
}

/** callers：候选引用（排除定义行）。 */
export async function callers(
  graph: CodeGraph,
  symbol: CodeMapSymbol,
  deps: QueryDeps,
): Promise<CallersResult> {
  const refs = excludeDefinitionRange(await deps.refsOf(symbol), symbol);
  const files = [...new Set(refs.map((r) => r.file))].sort();
  return { symbol: symbol.name, refs, files };
}

/** callees（文件级）：符号所在文件的直接 import 目标。 */
export function calleesFiles(
  graph: CodeGraph,
  symbol: CodeMapSymbol,
): string[] {
  return graph.importsOf(symbol.file).sort();
}

/** 文件相对 root 的首段目录；root 下的直接文件归 "."。 */
export function moduleOf(root: string, file: string): string {
  const rel = relative(root, file);
  const idx = rel.indexOf(sep);
  return idx === -1 ? "." : rel.slice(0, idx);
}

/** impact：从目标文件出发的反向 import 传递闭包 + 模块聚合。 */
export function impact(
  graph: CodeGraph,
  root: string,
  targetFile: string,
): ImpactResult {
  const files = graph.transitiveDependents(targetFile);
  const modules = [...new Set(files.map((f) => moduleOf(root, f)))].sort();
  return { target: targetFile, files, modules };
}
