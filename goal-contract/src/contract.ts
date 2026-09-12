// src/contract.ts — 契约嵌入与回读（objective 内 Done-when 段）
//
// 官方 dsh GoalSnapshot 无独立契约字段（dsh-goal GoalSnapshot 仅
// objective/phase/revision 等），故条款集以机器可读的 "Done-when:" 标记段
// 嵌入 goal 的 objective 文本；回读时从当前 goal 视图解析该段还原条款。
//
// 嵌入格式（buildObjective 输出）：
//   <objective 文本>
//
//   Done-when:
//   [ 条款 JSON 数组（2 空格缩进） ]
//
// 往返保证：对任意合法契约，parseContract(buildObjective(o, c)) 还原出
// objective === o.trim() 且 clausesEqual(c, parsed) 为 true。

import { validateClauses } from "./clauses.ts";
import type { ContractClause } from "./types.ts";

/** 嵌入格式标记行（必须独占一行，trim 后精确匹配）。 */
export const DONE_WHEN_MARKER = "Done-when:";

/** 契约回读错误（objective 为空 / Done-when 段非法）。 */
export class ContractParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractParseError";
  }
}

/**
 * 将条款集嵌入 objective 文本（<objective>\n\nDone-when:\n<条款 JSON>）。
 *
 * @throws {ContractParseError} objective 含独占一行的 "Done-when:"（回读边界歧义）
 */
export function buildObjective(
  objective: string,
  clauses: ContractClause[],
): string {
  // objective 不得自带标记行，否则回读无法确定边界
  if (
    objective.split(/\r?\n/).some((line) => line.trim() === DONE_WHEN_MARKER)
  ) {
    throw new ContractParseError(
      `objective 不得包含独占一行的 "${DONE_WHEN_MARKER}"（契约标记）`,
    );
  }
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    throw new ContractParseError("objective 不得为空");
  }
  return `${trimmed}\n\n${DONE_WHEN_MARKER}\n${JSON.stringify(clauses, null, 2)}`;
}

/**
 * 从 objective 文本解析契约（回读）：
 * - 无标记行 → 普通 goal（无契约段），clauses 为空数组
 * - 标记段 JSON 非法 / objective 部分为空 / 条款校验失败 → ContractParseError
 */
export function parseContract(objectiveText: string): {
  objective: string;
  clauses: ContractClause[];
} {
  // 定位第一个独占一行的标记行
  const lines = objectiveText.split("\n");
  let markerLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === DONE_WHEN_MARKER) {
      markerLine = i;
      break;
    }
  }
  if (markerLine === -1) {
    return { objective: objectiveText.trim(), clauses: [] };
  }
  const objective = lines.slice(0, markerLine).join("\n").trim();
  if (objective.length === 0) {
    throw new ContractParseError("Done-when 段之前的 objective 为空");
  }
  const jsonText = lines
    .slice(markerLine + 1)
    .join("\n")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new ContractParseError(`Done-when 段不是合法 JSON：${String(err)}`);
  }
  const v = validateClauses(parsed);
  if (!v.ok) {
    throw new ContractParseError(
      `Done-when 段条款非法：${v.errors.join("；")}`,
    );
  }
  return { objective, clauses: v.clauses };
}

/** 两组条款是否一致（深相等：顺序与字段均敏感）。 */
export function clausesEqual(
  a: ContractClause[],
  b: ContractClause[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
