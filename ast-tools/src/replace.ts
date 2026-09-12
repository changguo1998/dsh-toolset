/**
 * 结构化替换：ast-grep run -p <pattern> -r <fix> -l <lang> --json=compact <file>。
 *
 * CLI 为每个命中返回替换文本与替换区间（replacement + replacementOffsets，字节偏移）；
 * 本模块按偏移降序把编辑应用到原始字节流（避免先改的编辑影响后续偏移），
 * 再可选写回磁盘。替换文本支持 $VAR 元变量引用与 $$$VAR 序列变量展开（CLI fix 语义）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { runCliJson } from "./binary.ts";
import { normalizeLanguage } from "./langs.ts";
import type {
  AstMatch,
  AstOptions,
  ReplaceParams,
  ReplaceResult,
} from "./types.ts";

/** 单个替换编辑（目标文件内的字节偏移区间 + 替换文本）。 */
interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * 收集并应用替换编辑：按 start 降序逐个拼接，
 * 跳过与已应用编辑区间重叠的编辑（CLI 命中本不应重叠，此处防御性处理）。
 */
function applyEdits(source: Buffer, edits: Edit[]): Buffer {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart) continue; // 与已应用编辑重叠，跳过
    const replacement = Buffer.from(edit.text, "utf8");
    // 字节偏移边界必落在字节上，直接按字节切片拼接
    const next = Buffer.concat([
      out.subarray(0, edit.start),
      replacement,
      out.subarray(edit.end),
    ]);
    out = next;
    lastStart = edit.start;
  }
  return out;
}

/**
 * 对单个文件执行 AST 模式替换。
 * write=false（缺省）时仅返回内存中的新内容；write=true 时写回原文件。
 */
export async function replaceAst(
  params: ReplaceParams,
  opts: AstOptions = {},
): Promise<ReplaceResult> {
  const args = [
    "run",
    "-p",
    params.pattern,
    "-r",
    params.replacement,
    "-l",
    normalizeLanguage(params.language),
    "--json=compact",
  ];
  if (params.strictness) args.push("--strictness", params.strictness);
  args.push(params.path);
  const matches = (await runCliJson(args, opts)) as AstMatch[];

  // 仅收集带 replacement 与 replacementOffsets 的命中（无 fix 语义时两者缺省）
  const edits: Edit[] = matches.flatMap((match) => {
    const offsets = match.replacementOffsets;
    if (match.replacement === undefined || !offsets) return [];
    return [
      { start: offsets.start, end: offsets.end, text: match.replacement },
    ];
  });

  const source = readFileSync(params.path);
  const updated = applyEdits(source, edits);
  let written = false;
  if (params.write) {
    writeFileSync(params.path, updated);
    written = true;
  }
  return {
    updatedSource: updated.toString("utf8"),
    replacedCount: edits.length,
    written,
    matches,
  };
}
