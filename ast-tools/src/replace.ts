/**
 * 结构化替换：ast-grep run -p <pattern> -r <fix> -l <lang> --json=compact <file>。
 *
 * CLI 为每个命中返回替换文本与替换区间（replacement + replacementOffsets，字节偏移）；
 * 本模块按偏移降序把编辑应用到原始字节流（避免先改的编辑影响后续偏移），
 * 再可选写回。替换文本支持 $VAR 元变量引用与 $$$VAR 序列变量展开（CLI fix 语义）。
 * 读写只经 `AstFileIo`（决策 D2）：插件侧是 `ctx.fs`, 库面缺省是 node 的 fs 实现。
 *
 * 写回顺序：取版本 → 读原文 → 跑 CLI → 按偏移拼接 → 带版本写回。
 * 版本取自写前最后一次 `stat`, 期间文件被改动时后端抛 `FS_STALE_VERSION`, 整次失败而不是覆盖。
 */

import { runCliJson } from "./binary.ts";
import { AstFileError, nodeAstFileIo, type AstFileIo } from "./io.ts";
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
 * write=false（缺省）时仅返回内存中的新内容；write=true 时按读到的版本写回原文件。
 * @param params 替换参数（`path` 相对路径按 `io` 的基准目录解析）。
 * @param opts 通用选项（二进制与超时）。
 * @param io 文件读写面; 缺省用 `nodeAstFileIo()`（库面 / 示例 / 单测）。
 */
export async function replaceAst(
  params: ReplaceParams,
  opts: AstOptions = {},
  io?: AstFileIo,
): Promise<ReplaceResult> {
  const files = io ?? nodeAstFileIo();
  const target = await files.resolve(params.path);
  const info = await files.stat(target);
  if (info === undefined) {
    throw new AstFileError("FS_NOT_FOUND", `无法读取: ${target.displayPath}`);
  }
  if (info.type !== "file") {
    throw new AstFileError(
      "FS_NOT_REGULAR_FILE",
      `只有普通文件能替换: ${target.displayPath}`,
    );
  }
  const source = await files.readText(target);

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
  args.push(files.processPath(target));
  const matches = (await runCliJson(args, opts)) as AstMatch[];

  // 仅收集带 replacement 与 replacementOffsets 的命中（无 fix 语义时两者缺省）
  const edits: Edit[] = matches.flatMap((match) => {
    const offsets = match.replacementOffsets;
    if (match.replacement === undefined || !offsets) return [];
    return [
      { start: offsets.start, end: offsets.end, text: match.replacement },
    ];
  });

  const updated = applyEdits(Buffer.from(source, "utf8"), edits);
  const updatedSource = updated.toString("utf8");
  let written = false;
  if (params.write) {
    await files.writeText(target, updatedSource, {
      kind: "replaceIfVersion",
      version: info.version,
    });
    written = true;
  }
  return {
    updatedSource,
    replacedCount: edits.length,
    written,
    matches,
  };
}
