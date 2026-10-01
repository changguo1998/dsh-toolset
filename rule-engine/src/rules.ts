/**
 * 规则归一化与两层合并。
 *
 * 两层：配置基线（`Config.rules`，只读）+ 运行时层（工具族增删改，落状态目录）。
 * 合并规则（按 id）：
 * 1. 基线按声明顺序生效，同 id 后出现者覆盖前者（记 warning）；
 * 2. 运行时层的 `removed` 列表屏蔽同名基线规则；
 * 3. 运行时层 `rules` 同 id 覆盖基线（就地替换、保持位置），新 id 追加到末尾。
 */

import { isPredicateName } from "./match.ts";
import type {
  EffectiveRule,
  MatchSpec,
  NormalizedRule,
  PredicateName,
  Rule,
  RuleDelivery,
  RuleOrigin,
  RuleSource,
  RuntimeLayer,
} from "./types.ts";

/** 合法匹配面（工具面入参校验与错误提示用）。 */
export const RULE_SOURCES: readonly RuleSource[] = [
  "assistant-text",
  "tool-call",
  "tool-result",
  "turn-end",
  "compaction",
];

/** 匹配面是否合法。 */
export function isRuleSource(value: unknown): value is RuleSource {
  return (
    typeof value === "string" && RULE_SOURCES.includes(value as RuleSource)
  );
}

/** 合法送达路径（工具面入参校验与错误提示用）。 */
export const RULE_DELIVERIES: readonly RuleDelivery[] = [
  "followup",
  "next-step",
];

/** 送达路径是否合法。 */
export function isRuleDelivery(value: unknown): value is RuleDelivery {
  return (
    typeof value === "string" && RULE_DELIVERIES.includes(value as RuleDelivery)
  );
}

/** 归一化结果：ok=false 时 error 为可读原因（工具面直接回给模型）。 */
export type NormalizeResult =
  | { ok: true; rule: NormalizedRule; warnings: string[] }
  | { ok: false; error: string };

/** 归一化命中条件：丢弃非字符串项与未知谓词名（记 warning）。 */
function normalizeMatch(
  input: unknown,
  warnings: string[],
): { spec: MatchSpec; provided: boolean } {
  if (input === undefined || input === null)
    return { spec: {}, provided: false };
  if (typeof input !== "object" || Array.isArray(input)) {
    warnings.push("match 不是对象，已按空条件处理");
    return { spec: {}, provided: false };
  }
  const raw = input as {
    keywords?: unknown;
    regex?: unknown;
    flags?: unknown;
    predicates?: unknown;
  };
  const spec: MatchSpec = {};
  let provided = false;
  const strings = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      warnings.push(`${field} 不是数组，已忽略`);
      return [];
    }
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) out.push(item);
      else warnings.push(`${field} 含非字符串/空串项，已忽略`);
    }
    return out;
  };
  const keywords = strings(raw.keywords, "match.keywords");
  if (keywords.length > 0) {
    spec.keywords = keywords;
    provided = true;
  }
  const regex = strings(raw.regex, "match.regex");
  if (regex.length > 0) {
    spec.regex = regex;
    spec.flags = typeof raw.flags === "string" ? raw.flags : undefined;
    provided = true;
  }
  if (raw.predicates !== undefined) {
    const predicates: PredicateName[] = [];
    const list = Array.isArray(raw.predicates) ? raw.predicates : [];
    if (!Array.isArray(raw.predicates))
      warnings.push("match.predicates 不是数组，已忽略");
    for (const item of list) {
      if (isPredicateName(item)) predicates.push(item);
      else warnings.push(`未知谓词名 ${JSON.stringify(item)}，已忽略`);
    }
    if (predicates.length > 0) {
      spec.predicates = predicates;
      provided = true;
    }
  }
  return { spec, provided };
}

/** 归一化一条规则：补齐缺省值、校验必填字段。纯数据进出，可持久化。 */
export function normalizeRule(input: unknown): NormalizeResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "规则必须是对象" };
  }
  const raw = input as Partial<Rule> & { action?: unknown };
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id.length === 0) return { ok: false, error: "规则 id 必须是非空字符串" };
  const actionRaw = raw.action;
  if (
    actionRaw === null ||
    typeof actionRaw !== "object" ||
    Array.isArray(actionRaw)
  ) {
    return { ok: false, error: `规则 "${id}" 缺少 action` };
  }
  const action = actionRaw as {
    type?: unknown;
    text?: unknown;
    summary?: unknown;
  };
  if (action.type !== "inject") {
    return {
      ok: false,
      error: `规则 "${id}" 的 action.type 只支持 "inject"（本期动作面）`,
    };
  }
  const text = typeof action.text === "string" ? action.text : "";
  if (text.trim().length === 0) {
    return { ok: false, error: `规则 "${id}" 的 action.text 必须是非空字符串` };
  }
  if (raw.source !== undefined && !isRuleSource(raw.source)) {
    return {
      ok: false,
      error: `规则 "${id}" 的 source 非法（可选：${RULE_SOURCES.join(" / ")}）`,
    };
  }
  if (raw.delivery !== undefined && !isRuleDelivery(raw.delivery)) {
    return {
      ok: false,
      error: `规则 "${id}" 的 delivery 非法（可选：${RULE_DELIVERIES.join(" / ")}）`,
    };
  }
  const warnings: string[] = [];
  const { spec, provided } = normalizeMatch(raw.match, warnings);
  if (!provided && raw.match !== undefined) {
    warnings.push(`规则 "${id}" 的 match 未提供有效条件`);
  }
  const int = (value: unknown, field: string, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      warnings.push(`规则 "${id}" 的 ${field} 非法，已取缺省 ${fallback}`);
      return fallback;
    }
    return Math.floor(value);
  };
  return {
    ok: true,
    warnings,
    rule: {
      id,
      enabled: raw.enabled !== false,
      source: isRuleSource(raw.source) ? raw.source : "assistant-text",
      delivery: isRuleDelivery(raw.delivery) ? raw.delivery : "followup",
      match: spec,
      action: {
        type: "inject",
        text,
        ...(typeof action.summary === "string" &&
        action.summary.trim().length > 0
          ? { summary: action.summary }
          : {}),
      },
      cooldownTurns: int(raw.cooldownTurns, "cooldownTurns", 0),
      cooldownMs: int(raw.cooldownMs, "cooldownMs", 0),
      dedupeInRecord: raw.dedupeInRecord === true,
      description:
        typeof raw.description === "string" && raw.description.trim().length > 0
          ? raw.description
          : null,
    },
  };
}

/** 归一化规则列表：非法项跳过并记 warning（不因单条坏配置拒绝整层）。 */
function normalizeList(
  inputs: readonly Rule[],
  layer: RuleOrigin,
  warnings: string[],
): NormalizedRule[] {
  const out: NormalizedRule[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const result = normalizeRule(input);
    if (!result.ok) {
      warnings.push(`${layer} 层规则跳过：${result.error}`);
      continue;
    }
    for (const w of result.warnings) warnings.push(`${layer} 层：${w}`);
    if (seen.has(result.rule.id)) {
      warnings.push(
        `${layer} 层规则 "${result.rule.id}" 重复声明，后出现者覆盖前者`,
      );
      const index = out.findIndex((r) => r.id === result.rule.id);
      if (index >= 0) out[index] = result.rule;
      continue;
    }
    seen.add(result.rule.id);
    out.push(result.rule);
  }
  return out;
}

/** 合并两层得到生效规则集。 */
export function effectiveRules(
  baseline: readonly Rule[],
  layer: RuntimeLayer,
): { rules: EffectiveRule[]; warnings: string[] } {
  const warnings: string[] = [];
  const base = normalizeList(baseline, "config", warnings);
  const runtime = normalizeList(layer.rules, "runtime", warnings);
  const removed = new Set(
    (Array.isArray(layer.removed) ? layer.removed : []).filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const merged: EffectiveRule[] = base
    .filter((rule) => !removed.has(rule.id))
    .map((rule) => ({ rule, origin: "config" as const }));
  for (const rule of runtime) {
    const index = merged.findIndex((item) => item.rule.id === rule.id);
    if (index >= 0) merged[index] = { rule, origin: "runtime" };
    else merged.push({ rule, origin: "runtime" });
  }
  return { rules: merged, warnings };
}
