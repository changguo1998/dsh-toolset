/**
 * 文件大纲：ast-grep outline --json=compact [options] <path>。
 *
 * 返回顶层符号（函数/类/import 等）及其成员（方法等），
 * 每项含 0-based 范围、签名、astKind 与 import/export 标记。
 * 默认 items=auto：文件输入取 structure（不含 import），
 * 需要 import 时显式传 items:"imports" 或 "all"。
 */

import { runCliJson } from "./binary.ts";
import { normalizeLanguage } from "./langs.ts";
import type { AstOptions, OutlineFile, OutlineParams } from "./types.ts";

/** 获取文件/目录的符号大纲。 */
export async function outlineFile(
  params: OutlineParams,
  opts: AstOptions = {},
): Promise<OutlineFile[]> {
  const args = ["outline", "--json=compact"];
  if (params.items) args.push("--items", params.items);
  if (params.types && params.types.length > 0) {
    args.push("--type", params.types.join(","));
  }
  if (params.language) args.push("-l", normalizeLanguage(params.language));
  args.push(params.path);
  const results = await runCliJson(args, opts);
  return results as OutlineFile[];
}
