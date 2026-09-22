/**
 * report 单测：详情级别、占用百分比、格式化、缺省与不可用分支。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReport,
  formatCount,
  formatMs,
  normalizeDetail,
  occupancyOf,
  tokenBuckets,
  withDefaults,
} from "../src/report.ts";
import { createInitialState, foldSession } from "../src/fold.ts";
import { stateFixture, typicalSession } from "./helpers.ts";

test("normalizeDetail：合法值透传，非法/缺失回落 standard", () => {
  assert.equal(normalizeDetail("summary"), "summary");
  assert.equal(normalizeDetail("full"), "full");
  assert.equal(normalizeDetail("nope"), "standard");
  assert.equal(normalizeDetail(undefined), "standard");
});

test("formatCount：千位与百万位简写", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1_500), "1.5k");
  assert.equal(formatCount(2_000_000), "2.0M");
});

test("formatMs：毫秒/秒/分钟分档", () => {
  assert.equal(formatMs(0), "0ms");
  assert.equal(formatMs(320), "320ms");
  assert.equal(formatMs(1_500), "1.5s");
  assert.equal(formatMs(90_000), "1m30s");
});

test("occupancyOf：容量缺省时不给百分比", () => {
  const only = occupancyOf({ projectedTokens: 1_000 }, undefined);
  assert.equal(only.projectedTokens, 1_000);
  assert.equal(only.contextWindow, undefined);
  assert.equal(only.occupancyPct, undefined, "容量未知不猜分母");
});

test("occupancyOf：容量已知时给出保留一位小数的占用", () => {
  const occ = occupancyOf(
    { projectedTokens: 25_000, contextWindow: 128_000 },
    undefined,
  );
  assert.equal(occ.occupancyPct, 19.5);
  assert.equal(occupancyOf({}, 64_000).contextWindow, 64_000, "兜底容量可传入");
});

test("occupancyOf：projected 缺省时退回 pressure", () => {
  const occ = occupancyOf(
    { pressureTokens: 6_400, contextWindow: 64_000 },
    undefined,
  );
  assert.equal(occ.occupancyPct, 10);
  assert.equal(occ.projectedTokens, undefined);
});

test("tokenBuckets：总量为四桶之和，reasoning 不重复计入", () => {
  const buckets = tokenBuckets(stateFixture());
  assert.equal(buckets.total, 1_400 + 160 + 50 + 20);
  assert.equal(buckets.reasoning, 30);
});

test("buildReport：summary 省略耗时与路由，standard 给出", () => {
  const state = stateFixture({ provider: "deepseek", model: "v4" });
  const summary = buildReport({
    sessionId: "s1",
    state,
    detail: "summary",
    generatedAt: 1,
  });
  assert.equal(summary.durations, undefined);
  assert.equal(summary.route, undefined);
  assert.equal(summary.projection, "sessionContext");
  assert.match(summary.text, /token 累计/);
  const standard = buildReport({
    sessionId: "s1",
    state,
    detail: "standard",
    generatedAt: 1,
  });
  assert.equal(standard.durations?.llmMs, 500);
  assert.deepEqual(standard.route, { provider: "deepseek", model: "v4" });
  assert.match(standard.text, /最近路由：deepseek\/v4/);
  assert.match(standard.text, /解码速率：约 \d+(\.\d+)? tok\/s/);
});

test("buildReport：full 给出 reasoning 细分与构成缺口提示", () => {
  const report = buildReport({
    sessionId: "s1",
    state: stateFixture(),
    detail: "full",
    generatedAt: 1,
  });
  assert.match(report.text, /reasoning 30（输出的子集，不重复计入总量）/);
  assert.match(report.text, /下次请求构成：未接入/);
});

test("buildReport：full 且有构成数据时渲染三档启发式", () => {
  const report = buildReport({
    state: stateFixture(),
    detail: "full",
    breakdown: {
      systemTokens: 1_000,
      toolsTokens: 2_000,
      messageTokens: 3_000,
    },
    generatedAt: 1,
  });
  assert.match(report.text, /system 1.0k、tools 2.0k、messages 3.0k/);
});

test("buildReport：状态缺省（投影未注册）时明确标注不可用而非 0", () => {
  const report = buildReport({ sessionId: "s1", generatedAt: 1 });
  assert.equal(report.projection, "unavailable");
  assert.equal(report.asOfSeq, -1);
  assert.equal(report.turns, 0);
  assert.match(report.text, /会话累计：不可用/);
  assert.match(report.text, /数据缺失不等于 0/);
});

test("buildReport 与 foldSession 串联：文本数字与折叠一致", () => {
  const state = foldSession(typicalSession());
  const report = buildReport({ state, detail: "standard", generatedAt: 1 });
  assert.equal(report.steps, 2);
  assert.equal(report.tokens.total, 1_400 + 160 + 50 + 20);
  assert.deepEqual(report.tokens, tokenBuckets(state));
});

test("withDefaults：归一 detail 并可补入构成", () => {
  const merged = withDefaults(
    { detail: "bogus" } as unknown as Parameters<typeof withDefaults>[0],
    { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
  );
  assert.equal(merged.detail, "standard");
  assert.deepEqual(merged.breakdown, {
    systemTokens: 1,
    toolsTokens: 2,
    messageTokens: 3,
  });
  const kept = withDefaults(
    {
      detail: "full",
      breakdown: { systemTokens: 9, toolsTokens: 9, messageTokens: 9 },
    },
    { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
  );
  assert.equal(kept.breakdown?.systemTokens, 9, "已有构成不被覆盖");
});

test("空状态报告：不抛错且给出零值", () => {
  const report = buildReport({ state: createInitialState(), generatedAt: 1 });
  assert.equal(report.tokens.total, 0);
  assert.equal(report.occupancy.occupancyPct, undefined);
  assert.match(report.text, /回合\/步：0 \/ 0/);
});
