// tests/usage.test.ts — 子会话计量：usage 投影优先、pressure 回退、双缺不写字段。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { measureChildTokens, readUsageOutputTokens } from "../src/main.ts";

/** 有样本的投影状态（`last !== null` 才代表上报过 usage）。 */
const sampled = (outputTokens: number): unknown => ({
  totals: { uncachedInputTokens: 900, outputTokens },
  last: { turn: 1, step: 1, buckets: { outputTokens } },
});

describe("readUsageOutputTokens（tokenUsage 投影结构子集）", () => {
  it("有样本时取 totals.outputTokens（含 0）", () => {
    assert.equal(readUsageOutputTokens(sampled(4096)), 4096);
    assert.equal(readUsageOutputTokens(sampled(0)), 0, "上报过 0 也是有效读数");
  });

  it("尚无样本（last 为 null/缺失）→ undefined：totals 全 0 是初值不是用量", () => {
    for (const noSample of [
      { totals: { outputTokens: 0 } },
      { totals: { outputTokens: 0 }, last: null },
      { totals: { outputTokens: 999 }, last: null },
    ]) {
      assert.equal(
        readUsageOutputTokens(noSample),
        undefined,
        `输入 ${JSON.stringify(noSample)} 应视为不可用`,
      );
    }
  });

  it("缺失 / 类型不对 / 非有限数 → undefined", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "x",
      [],
      {},
      { totals: null, last: { turn: 1 } },
      { totals: {}, last: { turn: 1 } },
      { totals: { outputTokens: "4096" }, last: { turn: 1 } },
      { totals: { outputTokens: Number.NaN }, last: { turn: 1 } },
      { totals: { outputTokens: Number.POSITIVE_INFINITY }, last: { turn: 1 } },
      { totals: { outputTokens: null }, last: { turn: 1 } },
    ]) {
      assert.equal(
        readUsageOutputTokens(bad),
        undefined,
        `输入 ${JSON.stringify(bad) ?? String(bad)} 应为 undefined`,
      );
    }
  });
});

/** 假宿主服务：计数调用次数，便于断言「没有走回退」。 */
function fakes(options: {
  projectionState?: unknown;
  projectionThrows?: boolean;
  pressure?: number;
  pressureThrows?: boolean;
}): {
  resolve<T>(name: string): T | undefined;
  warns: string[];
  calls: { stateOf: number; measure: number };
} {
  const calls = { stateOf: 0, measure: 0 };
  const warns: string[] = [];
  const services: Record<string, unknown> = {
    sessionProjections: {
      stateOf: (_session: unknown, key: string) => {
        calls.stateOf += 1;
        assert.equal(key, "tokenUsage");
        if (options.projectionThrows === true)
          throw new Error("projection 崩了");
        return options.projectionState;
      },
    },
    tokenMeter: {
      measure: (_session: unknown) => {
        calls.measure += 1;
        if (options.pressureThrows === true) throw new Error("meter 崩了");
        return { totalTokens: options.pressure };
      },
    },
  };
  return {
    resolve: <T>(name: string): T | undefined =>
      services[name] as T | undefined,
    warns,
    calls,
  };
}

describe("measureChildTokens", () => {
  it("投影可用 → usage 口径，且不碰 tokenMeter", () => {
    const f = fakes({ projectionState: sampled(3210), pressure: 19413 });
    const fields = measureChildTokens({
      session: { id: "child" },
      resolve: f.resolve,
      warn: (m) => f.warns.push(m),
    });
    assert.deepEqual(fields, { tokens: 3210, tokensKind: "usage" });
    assert.equal(f.calls.measure, 0, "usage 到手就不该再走 pressure");
    assert.deepEqual(f.warns, []);
  });

  it("投影无该状态 / 字段非法 → 回退 pressure（不参与 overBudget）", () => {
    for (const state of [
      undefined,
      {},
      { totals: {} },
      { totals: { outputTokens: 0 }, last: null },
    ]) {
      const f = fakes({ projectionState: state, pressure: 19413 });
      const fields = measureChildTokens({
        session: { id: "child" },
        resolve: f.resolve,
        warn: (m) => f.warns.push(m),
      });
      assert.deepEqual(
        fields,
        { tokens: 19413, tokensKind: "pressure" },
        `state=${JSON.stringify(state) ?? String(state)}`,
      );
      assert.equal(f.calls.measure, 1);
    }
  });

  it("投影抛错 → 告警 + 回退 pressure", () => {
    const f = fakes({ projectionThrows: true, pressure: 999 });
    const fields = measureChildTokens({
      session: { id: "child" },
      resolve: f.resolve,
      warn: (m) => f.warns.push(m),
    });
    assert.deepEqual(fields, { tokens: 999, tokensKind: "pressure" });
    assert.equal(f.warns.length, 1);
    assert.match(f.warns[0] ?? "", /sessionProjections\.stateOf 失败/);
  });

  it("两个服务都拿不到 / 都取不到数 → 空字段", () => {
    const none = measureChildTokens({
      session: { id: "child" },
      resolve: () => undefined,
      warn: () => {},
    });
    assert.deepEqual(none, {});
    const meterThrows = fakes({ pressureThrows: true });
    const fields = measureChildTokens({
      session: { id: "child" },
      resolve: meterThrows.resolve,
      warn: (m) => meterThrows.warns.push(m),
    });
    assert.deepEqual(fields, {});
    assert.match(meterThrows.warns[0] ?? "", /tokenMeter\.measure 失败/);
  });

  it("没有子会话句柄 → 不解析任何服务", () => {
    const f = fakes({ projectionState: sampled(1) });
    const fields = measureChildTokens({
      session: undefined,
      resolve: f.resolve,
      warn: (m) => f.warns.push(m),
    });
    assert.deepEqual(fields, {});
    assert.deepEqual(f.calls, { stateOf: 0, measure: 0 });
  });
});
