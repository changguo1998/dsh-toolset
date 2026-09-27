/**
 * 回合审查单测：notice / 反馈文案生成、逐符号冷却（时间 / run 双维度、按会话隔离）、
 * warnModel 关闭与全冷却返回 null。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SymbolReviewer } from "../src/review.ts";
import { resolveSymbolRules } from "../src/symbols.ts";

/** 造一个审查器（默认冷却关闭，便于文案断言；冷却用例单独配置）。 */
function reviewer(
  overrides: Record<string, unknown> = {},
  now: () => number = Date.now,
): SymbolReviewer {
  return new SymbolReviewer({
    rules: resolveSymbolRules({ cooldownMs: 0, cooldownRuns: 0, ...overrides }),
    now,
  });
}

test("review：替换与警示生成 notice 与合并反馈", () => {
  const result = reviewer().review("s1", "完成 ✔，失败 ❌，星标 ⭐。");
  assert.ok(result !== null);
  assert.match(result.notice, /符号已替换 2 处为推荐符号/);
  assert.match(result.notice, /未推荐符号：⭐/);
  assert.ok(result.feedback !== null);
  assert.match(result.feedback, /^\[符号规范\] /);
  assert.match(result.feedback, /请将「❌」改为「✗」/);
  assert.match(result.feedback, /另有 1 处变体符号已按推荐替换/);
  assert.match(result.feedback, /「⭐」无推荐替代/);
});

test("review：无违规返回 null", () => {
  assert.equal(reviewer().review("s1", "正常文本，无符号问题。"), null);
});

test("review：cooldownMs 冷却期内不再提醒，过期后恢复", () => {
  let now = 1_000;
  const r = reviewer({ cooldownMs: 5_000 }, () => now);
  const first = r.review("s1", "失败 ❌。");
  assert.ok(first !== null);
  now = 2_000;
  assert.equal(r.review("s1", "失败 ❌。"), null, "冷却期内 → 跳过");
  now = 7_000;
  const again = r.review("s1", "失败 ❌。");
  assert.ok(again !== null, "冷却过期 → 恢复提醒");
});

test("review：冷却按会话隔离、run 计数逐次推进", () => {
  const r = reviewer({ cooldownRuns: 3 });
  assert.ok(r.review("s1", "失败 ❌。") !== null, "第 1 次提醒");
  assert.equal(r.review("s1", "失败 ❌。"), null, "run 冷却中 → 跳过");
  assert.ok(r.review("s2", "失败 ❌。") !== null, "另一个会话不受影响");
  assert.ok(r.review("s3", "失败 ❌。") !== null, "第三个会话不受影响");
});

test("review：warnModel=false 只给 notice、不给反馈", () => {
  const result = reviewer({ warnModel: false }).review("s1", "失败 ❌。");
  assert.ok(result !== null);
  assert.match(result.notice, /符号已替换/);
  assert.equal(result.feedback, null);
});

test("review：clearSession 清空冷却记账", () => {
  const r = reviewer({ cooldownTurns: 0, cooldownMs: 60_000 });
  assert.ok(r.review("s1", "失败 ❌。") !== null);
  assert.equal(r.sessionCount(), 1);
  r.clearSession("s1");
  assert.equal(r.sessionCount(), 0);
  assert.ok(r.review("s1", "失败 ❌。") !== null, "清空后重新可提醒");
});
