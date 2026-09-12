/**
 * 规则执行：ast-grep scan --rule <file.yml> | --inline-rules <yaml 文本> --json=compact <paths...>。
 *
 * 规则为 YAML（id/language/message/severity/rule/fix/utils/constraints，
 * 见 ast-grep rule 文档），语言在规则内声明，无需 -l。
 * 带 fix 的规则，命中会附带 replacement/replacementOffsets（与 replaceAst 同源，
 * 调用方可复用同一编辑应用逻辑）；error 级命中时 CLI 非零退出，
 * 但 stdout 仍为纯 JSON，本模块按 JSON 输出为准（见 binary.runCliJson）。
 */

import { runCliJson } from "./binary.ts";
import type { AstOptions, AstRuleHit, RunRulesParams } from "./types.ts";

/** 对指定文件/目录执行 YAML 规则（文件或内联文本），返回全部命中。 */
export async function runRules(
  params: RunRulesParams,
  opts: AstOptions = {},
): Promise<AstRuleHit[]> {
  const args = ["scan", "--json=compact"];
  if (params.rule.kind === "file") {
    args.push("--rule", params.rule.rulePath);
  } else {
    args.push("--inline-rules", params.rule.rules);
  }
  if (params.includeMetadata) args.push("--include-metadata");
  if (params.minSeverity) args.push("--min-severity", params.minSeverity);
  args.push(...params.paths);
  const results = await runCliJson(args, opts);
  return results as AstRuleHit[];
}
