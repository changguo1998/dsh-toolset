// src/clauses.ts — Done-when 条款 schema 校验与文本解析
//
// 字段对齐 task-engine Acceptance 契约（见 task-engine/src/types.ts 与
// task-engine/src/acceptance.ts parseAcceptance）：
//   { id, check, level: mechanical|semantic|human, command?, outputSchema? }
// 语义级规则与 task-engine 判定阶段一致：mechanical 必须带可执行 command。
//
// parseClauseText 同时接受两种输入（访谈回答 / 工具参数预填）：
//   - 整段为 JSON 数组 → 结构化条款（validateClauses）
//   - 每行一条的自由文本（行格式见 parseClauseText 注释）

import type { ClauseLevel, ClauseValidation, ContractClause } from "./types.ts";

/** 三级 level（对齐 task-engine LEVELS）。 */
export const CLAUSE_LEVELS: readonly ClauseLevel[] = [
  "mechanical",
  "semantic",
  "human",
];

/** 单契约条款数上限（防止访谈累计无界条款）。 */
export const MAX_CLAUSES = 32;

/** 提取非空字符串（trim 后）；否则 undefined。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * 校验并归一化条款数组（判别联合结果）。
 *
 * 规则（对齐 task-engine parseAcceptance 的 model 侧语义）：
 * - 非空数组，条数 ≤ MAX_CLAUSES
 * - 每条：id/check 非空字符串，id 唯一
 * - level 必须显式给出且 ∈ mechanical/semantic/human
 * - mechanical 必须带非空 command（否则 task-engine 判定阶段无法执行）
 * - outputSchema 仅 semantic 级有意义；接受 snake_case（output_schema，
 *   对齐 task-engine 工具入参）与 camelCase 两种写法，归一化为 outputSchema
 */
export function validateClauses(raw: unknown): ClauseValidation {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, errors: ["clauses 必须是非空数组"] };
  }
  if (raw.length > MAX_CLAUSES) {
    return { ok: false, errors: [`条款数不得超过 ${MAX_CLAUSES}`] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const clauses: ContractClause[] = [];
  raw.forEach((item, index) => {
    // 结构检查：非空对象
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`条款 ${index + 1} 不是对象`);
      return;
    }
    const o = item as Record<string, unknown>;
    const label = `条款 ${index + 1}`;
    const id = nonEmptyString(o.id);
    const check = nonEmptyString(o.check);
    const levelRaw = typeof o.level === "string" ? o.level : undefined;
    const level =
      levelRaw !== undefined &&
      (CLAUSE_LEVELS as readonly string[]).includes(levelRaw)
        ? (levelRaw as ClauseLevel)
        : undefined;
    const command = nonEmptyString(o.command);
    if (id === undefined) {
      errors.push(`${label} 缺 id（非空字符串）`);
    } else if (seen.has(id)) {
      errors.push(`${label} id "${id}" 重复`);
    } else {
      seen.add(id);
    }
    if (check === undefined) errors.push(`${label} 缺 check（非空字符串）`);
    if (level === undefined) {
      errors.push(`${label} level 必须是 mechanical/semantic/human 之一`);
    }
    // mechanical 级必须带验证命令
    if (level === "mechanical" && command === undefined) {
      errors.push(`${label} 为 mechanical 级但缺 command（验证命令）`);
    }
    // 归一化 outputSchema（snake_case 优先，对齐 task-engine 工具入参）
    const outputSchema =
      o.output_schema !== undefined ? o.output_schema : o.outputSchema;
    if (id !== undefined && check !== undefined && level !== undefined) {
      clauses.push({
        id,
        check,
        level,
        ...(command === undefined ? {} : { command }),
        ...(outputSchema === undefined ? {} : { outputSchema }),
      });
    }
  });
  return errors.length === 0 ? { ok: true, clauses } : { ok: false, errors };
}

/**
 * 解析条款文本（模型或用户的访谈回答 / 工具预填）：
 * - 整段 trim 后以 '[' 开头 → 按 JSON 数组解析（validateClauses）
 * - 否则逐行：非空且非 '#' 注释的每行一条条款
 *   - '[mechanical|semantic|human] 描述'（可选 level 前缀，显式指定层级）
 *   - '描述 → 命令' / '描述 -> 命令' → mechanical 级带 command
 *     （按第一个箭头分隔，命令自身可含箭头）
 *   - 无命令且无 level 前缀 → human 级（人工确认）
 *   - id 自动编号 c1..cN
 */
export function parseClauseText(text: string): ClauseValidation {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, errors: ["条款文本为空"] };
  if (trimmed.startsWith("[")) {
    // JSON 数组分支（解析失败给出明确反馈，供访谈重问）
    try {
      return validateClauses(JSON.parse(trimmed));
    } catch (err) {
      return {
        ok: false,
        errors: [`条款文本形似 JSON 数组但解析失败：${String(err)}`],
      };
    }
  }
  // 自由文本分支：逐行解析
  const items: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (l.length === 0 || l.startsWith("#")) continue;
    // 可选 [level] 前缀
    let rest = l;
    let level: ClauseLevel | undefined;
    const levelMatch = l.match(/^\[(mechanical|semantic|human)\]\s*(.*)$/);
    if (levelMatch !== null) {
      level = levelMatch[1] as ClauseLevel;
      rest = levelMatch[2] ?? "";
    }
    // '→' 或 '->' 分隔 check 与 command（第一个箭头）
    let check = rest;
    let command: string | undefined;
    const arrow = rest.match(/^(.*?)\s*(?:→|->)\s*(.+)$/);
    if (arrow !== null) {
      check = (arrow[1] ?? "").trim();
      command = (arrow[2] ?? "").trim();
    }
    if (check.length === 0) continue;
    // 层级：显式前缀 > 有命令即 mechanical > 默认 human
    const effectiveLevel: ClauseLevel =
      level ?? (command !== undefined ? "mechanical" : "human");
    items.push({
      id: `c${items.length + 1}`,
      check,
      level: effectiveLevel,
      ...(command === undefined ? {} : { command }),
    });
  }
  // 统一走 validateClauses（空集/条数/id 等规则一致）
  return validateClauses(items);
}
