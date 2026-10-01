/**
 * 规则层单测：归一化（缺省值 + 非法项处理）与两层合并（覆盖 / 屏蔽 / 顺序）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  effectiveRules,
  isRuleDelivery,
  isRuleSource,
  normalizeRule,
  RULE_DELIVERIES,
  RULE_SOURCES,
} from "../src/rules.ts";
import type { Rule, RuntimeLayer } from "../src/types.ts";

/** 便捷：造一条合法规则输入。 */
function ruleInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "r1",
    action: { type: "inject", text: "请遵守规范" },
    ...overrides,
  };
}

test("normalizeRule：补齐缺省值", () => {
  const result = normalizeRule(ruleInput());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.rule, {
    id: "r1",
    enabled: true,
    source: "assistant-text",
    delivery: "followup",
    match: {},
    action: { type: "inject", text: "请遵守规范" },
    cooldownTurns: 0,
    cooldownMs: 0,
    dedupeInRecord: false,
    description: null,
  });
});

test("normalizeRule：显式字段覆盖缺省", () => {
  const result = normalizeRule(
    ruleInput({
      enabled: false,
      source: "tool-call",
      delivery: "next-step",
      match: { regex: ["rm -rf"], flags: "" },
      cooldownTurns: 2,
      cooldownMs: 5000,
      dedupeInRecord: true,
      description: "越界操作提醒",
      action: { type: "inject", text: "不要删库", summary: "约束提醒" },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rule.enabled, false);
  assert.equal(result.rule.source, "tool-call");
  assert.equal(result.rule.delivery, "next-step");
  assert.deepEqual(result.rule.match, { regex: ["rm -rf"], flags: "" });
  assert.equal(result.rule.cooldownTurns, 2);
  assert.equal(result.rule.cooldownMs, 5000);
  assert.equal(result.rule.dedupeInRecord, true);
  assert.equal(result.rule.description, "越界操作提醒");
  assert.equal(result.rule.action.summary, "约束提醒");
});

test("normalizeRule：非法输入逐条报错", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /必须是对象/],
    ["x", /必须是对象/],
    [{ action: { type: "inject", text: "t" } }, /id/],
    [{ id: "  ", action: { type: "inject", text: "t" } }, /id/],
    [{ id: "a" }, /缺少 action/],
    [{ id: "a", action: { type: "notice", text: "t" } }, /只支持 "inject"/],
    [
      { id: "a", action: { type: "inject", text: "   " } },
      /text 必须是非空字符串/,
    ],
    [ruleInput({ source: "nope" }), /source 非法/],
    [ruleInput({ delivery: "later" }), /delivery 非法/],
  ];
  for (const [input, pattern] of cases) {
    const result = normalizeRule(input);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(input)}`);
    if (result.ok) continue;
    assert.match(result.error, pattern);
  }
});

test("normalizeRule：条件里的非法项被丢弃并记 warning", () => {
  const result = normalizeRule(
    ruleInput({
      match: {
        keywords: ["ok", "", 3],
        regex: "not-array",
        predicates: ["has-cjk", "unknown-predicate"],
        flags: 7,
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.rule.match.keywords, ["ok"]);
  assert.equal(result.rule.match.regex, undefined);
  assert.deepEqual(result.rule.match.predicates, ["has-cjk"]);
  assert.equal(result.warnings.length, 4);
  assert.ok(result.warnings.some((w) => /未知谓词名/.test(w)));
});

test("normalizeRule：节流字段非法取缺省并记 warning", () => {
  const result = normalizeRule(
    ruleInput({ cooldownTurns: -1, cooldownMs: Number.NaN }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rule.cooldownTurns, 0);
  assert.equal(result.rule.cooldownMs, 0);
  assert.equal(result.warnings.length, 2);
});

test("effectiveRules：基线 + 运行时覆盖 + 屏蔽 + 顺序", () => {
  const baseline = [
    ruleInput({ id: "a", action: { type: "inject", text: "A" } }),
    ruleInput({ id: "b", action: { type: "inject", text: "B" } }),
  ] as unknown as Rule[];
  const layer: RuntimeLayer = {
    rules: [
      ruleInput({
        id: "b",
        action: { type: "inject", text: "B2" },
      }) as unknown as Rule,
      ruleInput({
        id: "c",
        action: { type: "inject", text: "C" },
      }) as unknown as Rule,
    ],
    removed: ["a"],
  };
  const { rules, warnings } = effectiveRules(baseline, layer);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    rules.map((item) => [item.rule.id, item.origin, item.rule.action.text]),
    [
      ["b", "runtime", "B2"],
      ["c", "runtime", "C"],
    ],
  );
});

test("effectiveRules：基线重复 id 后出现者覆盖并记 warning；坏规则跳过不拖垮整层", () => {
  const baseline = [
    ruleInput({ id: "a", action: { type: "inject", text: "first" } }),
    ruleInput({ id: "a", action: { type: "inject", text: "second" } }),
    { id: "broken" },
  ] as unknown as Rule[];
  const { rules, warnings } = effectiveRules(baseline, {
    rules: [],
    removed: [],
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.rule.action.text, "second");
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => /重复声明/.test(w)));
  assert.ok(warnings.some((w) => /跳过/.test(w)));
});

test("effectiveRules：运行时层被 removed 屏蔽的 id 若同时出现在 runtime.rules，则运行时版本生效", () => {
  const baseline = [ruleInput({ id: "a" })] as unknown as Rule[];
  const layer: RuntimeLayer = {
    rules: [
      ruleInput({
        id: "a",
        action: { type: "inject", text: "重写" },
      }) as unknown as Rule,
    ],
    removed: ["a"],
  };
  const { rules } = effectiveRules(baseline, layer);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.origin, "runtime");
  assert.equal(rules[0]?.rule.action.text, "重写");
});

test("isRuleSource：合法匹配面枚举", () => {
  for (const source of RULE_SOURCES) assert.equal(isRuleSource(source), true);
  assert.equal(isRuleSource("compaction"), true);
  assert.equal(isRuleSource("turn_end"), false);
  assert.equal(isRuleSource(undefined), false);
});

test("isRuleDelivery：合法送达路径枚举", () => {
  for (const delivery of RULE_DELIVERIES) {
    assert.equal(isRuleDelivery(delivery), true);
  }
  assert.equal(isRuleDelivery("next_step"), false);
  assert.equal(isRuleDelivery(undefined), false);
});
