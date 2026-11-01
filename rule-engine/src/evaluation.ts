/**
 * 规则求值层：编译生效规则集（基线 + 运行时层），在节点上做匹配 → 冷却 → 记录去重，
 * 产出待注入段；另给只读的 `evaluate` 口径（消费者 API 与 `rule_test` 干跑共用）。
 *
 * 不持有会话态、也不注入：节流记账表（`SessionState.fired`）与「会话记录里已注入几条」
 * 的读面都由调用方传入，本层只读（去重命中时仍记本次命中，与既有语义一致）。
 */

import type { Segment } from "./delivery.ts";
import type { SessionState } from "./engine-state.ts";
import { boundSummary, compileMatcher, type CompiledMatcher } from "./match.ts";
import { effectiveRules, isRuleSource } from "./rules.ts";
import type {
  EvaluateInput,
  EvaluateResult,
  NormalizedRule,
  Rule,
  RuleHit,
  RuleOrigin,
  RuleSource,
  RuntimeLayer,
} from "./types.ts";

/** 编译后的规则（归一化数据 + 匹配器 + 来源层）。 */
export interface CompiledRule {
  rule: NormalizedRule;
  origin: RuleOrigin;
  matcher: CompiledMatcher;
}

/** 生效规则集编译（引擎构造与每次变更后调用）。 */
export function compileRules(
  baseline: readonly Rule[],
  layer: RuntimeLayer,
  warn: (message: string) => void,
): CompiledRule[] {
  const { rules, warnings } = effectiveRules(baseline, layer);
  for (const warning of warnings) warn(`${warning}`);
  const compiled: CompiledRule[] = [];
  for (const { rule, origin } of rules) {
    const matcher = compileMatcher(rule.match);
    for (const warning of matcher.warnings) {
      warn(`规则 "${rule.id}"：${warning}`);
    }
    compiled.push({ rule, origin, matcher });
  }
  return compiled;
}

/** 一次规则收集的入参。 */
export interface RuleCollectionInput {
  readonly compiled: readonly CompiledRule[];
  readonly trigger: RuleSource;
  readonly text: string;
  readonly sessionId: string;
  readonly turn: number;
  /** 本会话内存态（只读 `resumed` 与就地记 `fired`）。 */
  readonly state: SessionState;
  /** 时钟（逐条命中时取一次，与既有语义一致）。 */
  readonly now: () => number;
  /** 会话记录里本引擎注入某摘要的条数（按记录去重用）。 */
  readonly countInRecord: (sessionId: string, key: string) => number;
  /** 产出段收集处（按规则注册顺序追加）。 */
  readonly segments: Segment[];
}

/** 规则命中收集：规则级节流 → 投影计数去重 → 产出段。 */
export function collectRuleSegments(input: RuleCollectionInput): void {
  const { compiled, trigger, text, sessionId, turn, state, segments } = input;
  for (const item of compiled) {
    const rule = item.rule;
    if (!rule.enabled || !rule.sources.includes(trigger)) continue;
    // 会话级 ctx（resumed 会话内稳定）供 `session-fresh` / `session-resumed` 谓词判定
    if (!item.matcher.match(text, trigger, { resumed: state.resumed }))
      continue;
    const now = input.now();
    const last = state.fired.get(rule.id);
    if (last !== undefined) {
      if (rule.cooldownTurns > 0 && turn - last.turn < rule.cooldownTurns)
        continue;
      if (rule.cooldownMs > 0 && now - last.time < rule.cooldownMs) continue;
    }
    const summary = rule.action.summary ?? boundSummary(rule.action.text);
    // 按记录去重：记录里已有 N 条本注入 → 不产出，仍记本次命中（避免每次触发都重读记录）；
    // 直写节点（directWrite）跳过该判断、直接写入
    if (
      !rule.directWrite.includes(trigger) &&
      rule.dedupeInRecord > 0 &&
      input.countInRecord(sessionId, summary) >= rule.dedupeInRecord
    ) {
      state.fired.set(rule.id, { turn, time: now });
      continue;
    }
    state.fired.set(rule.id, { turn, time: now });
    segments.push({
      sourceId: rule.id,
      delivery: rule.delivery,
      text: rule.action.text,
      summary,
    });
  }
}

/** 只读判定（消费者 API）：返回命中规则（含可注入内容）与未启用规则；不注入、不改状态。 */
export function evaluateRules(
  compiled: readonly CompiledRule[],
  input: EvaluateInput,
): EvaluateResult {
  const source: RuleSource =
    input.source !== undefined && isRuleSource(input.source)
      ? input.source
      : "assistant-text";
  const matched: RuleHit[] = [];
  const disabled: string[] = [];
  for (const item of compiled) {
    if (!item.rule.sources.includes(source)) continue;
    if (!item.rule.enabled) {
      disabled.push(item.rule.id);
      continue;
    }
    // 会话无关的只读判定：不传 ctx → 匹配器按缺省 `{ resumed: false }` 处理
    // （`session-fresh` 命中、`session-resumed` 不命中；rule_test 干跑同口径）
    if (!item.matcher.match(input.text, source)) continue;
    const text = item.rule.action.text;
    matched.push({
      id: item.rule.id,
      origin: item.origin,
      source,
      delivery: item.rule.delivery,
      description: item.rule.description,
      text,
      summary: item.rule.action.summary ?? boundSummary(text),
    });
  }
  return { source, matched, disabled };
}
