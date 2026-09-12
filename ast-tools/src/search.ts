/**
 * AST 结构搜索：ast-grep run -p <pattern> -l <lang> [--strictness] --json=compact <path>。
 *
 * 模式语义对齐 readSeek_search（AST 模式匹配）：$VAR 捕获单节点、$$$VAR/$$$ 捕获节点序列，
 * 返回命中节点原文、0-based 行列范围与元变量捕获。
 */

import { runCliJson } from "./binary.ts";
import { normalizeLanguage } from "./langs.ts";
import type { AstMatch, AstOptions, SearchParams } from "./types.ts";

/** 在指定文件/目录内按 AST 模式搜索，返回全部命中。 */
export async function searchAst(
  params: SearchParams,
  opts: AstOptions = {},
): Promise<AstMatch[]> {
  const args = [
    "run",
    "-p",
    params.pattern,
    "-l",
    normalizeLanguage(params.language),
    "--json=compact",
  ];
  if (params.strictness) args.push("--strictness", params.strictness);
  args.push(params.path);
  const results = await runCliJson(args, opts);
  return results as AstMatch[];
}
