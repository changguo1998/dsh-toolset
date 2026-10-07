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

/** 首行概括的显示列上限（状态列只显示 objective 首个逻辑行；最窄正文 19 列 → 折 ≤3 行） */
export const SUMMARY_MAX_WIDTH = 40;

/** 宽字符（东亚全宽 / emoji）近似判定：只服务「首句字数」上限，不追求逐码点精确 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** objective **首个逻辑行**（概括句）的显示宽度（列）；空 / 全空白 → 0 */
export function summaryWidth(objective: string): number {
  const first = objective.split(/\r?\n/).find((line) => line.trim() !== "");
  if (first === undefined) return 0;
  let w = 0;
  for (const ch of first.trim()) {
    w += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return w;
}

/**
 * 首行概括超限时的可操作报错（未超 → null）。
 * 状态列只显示首个逻辑行，所以「一句话概括」的字数要在**起草侧**收住；
 * 具体行数仍由状态列宽决定（宽列 1 行、窄列自然折更多行）。
 */
export function checkSummaryWidth(objective: string): string | null {
  const w = summaryWidth(objective);
  return w > SUMMARY_MAX_WIDTH
    ? `objective 首行（一句话概括）过长：${w} 显示列 > ${SUMMARY_MAX_WIDTH}（约 20 个汉字 / 40 个英文字符）——状态列只显示首行，请把第一句压成一句话概括`
    : null;
}

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
  const overLimit = checkSummaryWidth(trimmed);
  if (overLimit !== null) {
    throw new ContractParseError(overLimit);
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
