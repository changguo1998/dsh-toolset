/**
 * 纯核心单测：plateau 判定、方向、默认值、边界、cadence、metricless。
 *
 * 直接驱动 engine.ts 纯函数（advance/shouldDefer/nextWakeMs/checkBounds/scheduleHint），
 * clock 与测量值手工注入，不依赖文件系统与子进程。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_WINDOW,
  advance,
  checkBounds,
  createInitialState,
  isBetter,
  nextWakeMs,
  normalizeSpec,
  scheduleHint,
  shouldDefer,
} from "../src/engine.ts";

/** 便捷：造一个带测量命令的初始状态。 */
function stateWith(
  overrides: Partial<Parameters<typeof createInitialState>[0]> = {},
) {
  return createInitialState(
    { measureCmd: "true", direction: "min", ...overrides },
    1_000,
  );
}

/** 便捷：从给定值序列推进多轮（min 方向、window 默认），返回最后状态。 */
function runSeries(
  values: Array<number | null>,
  opts: { window?: number; maxRounds?: number } = {},
) {
  let state = stateWith({ window: opts.window, maxRounds: opts.maxRounds });
  let now = 1_000;
  for (const v of values) {
    now += 1_000;
    const out = advance({
      state,
      now,
      value: v,
      measureFailed: v === null,
      tokensUsed: 0,
    });
    state = out.state;
    if (state.status === "stopped") break;
  }
  return state;
}

test("isBetter：min 要求更小、max 要求更大，相等不算改进", () => {
  assert.equal(isBetter(3, 5, "min"), true);
  assert.equal(isBetter(7, 5, "min"), false);
  assert.equal(isBetter(5, 5, "min"), false);
  assert.equal(isBetter(7, 5, "max"), true);
  assert.equal(isBetter(3, 5, "max"), false);
  assert.equal(isBetter(5, 5, "max"), false);
});

test("normalizeSpec：补默认 window=5 / maxRounds=50 / direction=min", () => {
  const spec = normalizeSpec({});
  assert.equal(spec.direction, "min");
  assert.equal(spec.window, 5);
  assert.equal(spec.maxRounds, 50);
  assert.equal(DEFAULT_WINDOW, 5);
  assert.equal(DEFAULT_MAX_ROUNDS, 50);
  assert.equal(spec.id, "default");
});

test("normalizeSpec：非法 window/maxRounds 抛错", () => {
  assert.throws(() => normalizeSpec({ window: 0 }));
  assert.throws(() => normalizeSpec({ window: 2.5 }));
  assert.throws(() => normalizeSpec({ maxRounds: 0 }));
  assert.throws(() => normalizeSpec({ direction: "sideways" as never }));
});

test("plateau（min）：连续 window 轮无改进后停止，best 保持历史最小", () => {
  // r1=10 基线, r2=8 改进, r3=9 无(1), r4=9 无(2), r5=9 无(3) → plateau
  const state = runSeries([10, 8, 9, 9, 9], { window: 3 });
  assert.equal(state.status, "stopped");
  assert.equal(state.stopReason, "plateau");
  assert.equal(state.rounds, 5);
  assert.equal(state.best, 8);
});

test("plateau（max）：更高者改进，连 window 轮未创新高则 plateau", () => {
  let state = createInitialState(
    { measureCmd: "true", direction: "max", window: 2 },
    1_000,
  );
  let now = 1_000;
  const values = [10, 12, 11, 11]; // r1 基线, r2 改进, r3 无(1), r4 无(2) → plateau
  for (const v of values) {
    now += 1_000;
    const out = advance({
      state,
      now,
      value: v,
      measureFailed: false,
      tokensUsed: 0,
    });
    state = out.state;
    if (state.status === "stopped") break;
  }
  assert.equal(state.status, "stopped");
  assert.equal(state.stopReason, "plateau");
  assert.equal(state.best, 12);
  assert.equal(state.rounds, 4);
});

test("plateau 中途改进则重置 streak，不停止", () => {
  // min, window=2: 10(基线) 9(改进) 9(无1) 8(改进,重置) 8(无1) → 未达 window
  const state = runSeries([10, 9, 9, 8, 8], { window: 2 });
  assert.equal(state.status, "running");
  assert.equal(state.streak, 1);
  assert.equal(state.best, 8);
});

test("默认 window=5：需连续 5 轮无改进才 plateau", () => {
  // min: 100 基线 + 连续 5 个 100 → 第 6 轮停
  const state = runSeries([100, 100, 100, 100, 100, 100]);
  assert.equal(state.stopReason, "plateau");
  assert.equal(state.rounds, 6);
});

test("边界：maxRounds 到顶停止（即使仍在改进）", () => {
  // 一直改进但 maxRounds=3 → 第 3 轮后 maxRounds 停
  const state = runSeries([10, 9, 8, 7], { maxRounds: 3 });
  assert.equal(state.stopReason, "maxRounds");
  assert.equal(state.rounds, 3);
});

test("边界：time 超时停止", () => {
  let state = createInitialState(
    { measureCmd: "true", timeBoundMs: 3_000 },
    1_000,
  );
  let now = 1_000;
  for (let i = 0; i < 5; i++) {
    now += 1_000;
    const out = advance({
      state,
      now,
      value: 100 - i,
      measureFailed: false,
      tokensUsed: 0,
    });
    state = out.state;
    if (state.status === "stopped") break;
  }
  // startedAt=2000（r1），now=5000 时 now-startedAt=3000>=3000 → time 停
  assert.equal(state.status, "stopped");
  assert.equal(state.stopReason, "time");
});

test("边界：token 累计到顶停止", () => {
  let state = createInitialState({ measureCmd: "true", tokenBound: 10 }, 1_000);
  let now = 1_000;
  // 每轮 +6 token：r1=6, r2=12>=10 → 第 2 轮后 tokens 停
  for (let i = 0; i < 3; i++) {
    now += 1_000;
    const out = advance({
      state,
      now,
      value: 50 - i,
      measureFailed: false,
      tokensUsed: 6,
    });
    state = out.state;
    if (state.status === "stopped") break;
  }
  assert.equal(state.stopReason, "tokens");
  assert.equal(state.tokensUsed, 12);
});

test("checkBounds 优先级：maxRounds > time > tokens", () => {
  const state = createInitialState(
    { measureCmd: "true", maxRounds: 1, timeBoundMs: 1, tokenBound: 1 },
    1_000,
  );
  state.rounds = 1;
  state.startedAt = 1_000;
  state.tokensUsed = 5;
  assert.equal(checkBounds(state, 9_999_999), "maxRounds");
  const s2 = createInitialState(
    { measureCmd: "true", timeBoundMs: 1, tokenBound: 1 },
    1_000,
  );
  s2.rounds = 0;
  s2.startedAt = 1_000;
  s2.tokensUsed = 5;
  assert.equal(checkBounds(s2, 9_999_999), "time");
  s2.startedAt = 0;
  assert.equal(checkBounds(s2, 9_999_999), "tokens");
});

test("cadence：auto 唤醒在 cadence 内被节流（deferred），explicit 不受限", () => {
  const state = createInitialState(
    { measureCmd: "true", cadenceSec: 60 },
    1_000,
  );
  // 模拟刚完成一轮：lastSuccessAt = 10_000
  state.lastSuccessAt = 10_000;
  state.rounds = 1;
  const now = 30_000; // 距上次成功 20s < 60s
  assert.equal(shouldDefer(state, now, "auto"), true);
  assert.equal(shouldDefer(state, now, "explicit"), false);
  assert.equal(nextWakeMs(state, now), 40_000);
});

test("cadence：auto 唤醒超过 cadence 则放行", () => {
  const state = createInitialState(
    { measureCmd: "true", cadenceSec: 60 },
    1_000,
  );
  state.lastSuccessAt = 10_000;
  state.rounds = 1;
  const now = 70_000; // 距上次成功 60s，恰好到点
  assert.equal(shouldDefer(state, now, "auto"), false);
  assert.equal(nextWakeMs(state, now), 0);
});

test("cadence 缺省（未设）：auto 唤醒永不节流", () => {
  const state = createInitialState({ measureCmd: "true" }, 1_000);
  state.lastSuccessAt = 1_000;
  assert.equal(shouldDefer(state, 1_500, "auto"), false);
  assert.equal(nextWakeMs(state, 1_500), 0);
});

test("scheduleHint：运行中返回 schedule_create（after_seconds>=1），停止返回 null", () => {
  const running = createInitialState(
    { measureCmd: "true", cadenceSec: 60 },
    1_000,
  );
  running.lastSuccessAt = 10_000;
  running.rounds = 1;
  const hint = scheduleHint(running, 30_000);
  assert.ok(hint !== null);
  assert.equal(hint.tool, "schedule_create");
  assert.ok(hint.args.after_seconds >= 1);
  assert.equal(hint.args.after_seconds, 40);

  const stopped = createInitialState({ measureCmd: "true" }, 1_000);
  stopped.status = "stopped";
  stopped.stopReason = "plateau";
  assert.equal(scheduleHint(stopped, 30_000), null);
});

test("metricless（无测量命令）：不判 plateau，只按边界停止", () => {
  // 无 measureCmd，连续多轮相同“值”不应触发 plateau，只到 maxRounds
  let state = createInitialState(
    { direction: "min", window: 2, maxRounds: 4 },
    1_000,
  );
  let now = 1_000;
  for (let i = 0; i < 10; i++) {
    now += 1_000;
    const out = advance({
      state,
      now,
      value: null,
      measureFailed: false,
      tokensUsed: 0,
    });
    state = out.state;
    if (state.status === "stopped") break;
  }
  assert.equal(state.stopReason, "maxRounds"); // 非 plateau
  assert.equal(state.best, null);
  assert.equal(state.streak, 0); // metricless 不累加 streak
  assert.equal(state.rounds, 4);
});

test("测量失败（有命令但无数字）：按无改进处理，可累积到 plateau，best 不变", () => {
  let state = createInitialState({ measureCmd: "true", window: 2 }, 1_000);
  let now = 1_000;
  // r1=10 基线, r2=失败(1), r3=失败(2) → plateau
  const seq: Array<number | null> = [10, null, null];
  for (const v of seq) {
    now += 1_000;
    const out = advance({
      state,
      now,
      value: v,
      measureFailed: v === null,
      tokensUsed: 0,
    });
    state = out.state;
    if (state.status === "stopped") break;
  }
  assert.equal(state.stopReason, "plateau");
  assert.equal(state.best, 10); // best 保持
  assert.equal(state.rounds, 3);
});

test("已停止的 advance 不再变化（幂等守卫由控制器层负责，advance 本身只处理 running）", () => {
  const state = runSeries([1, 1, 1], { window: 2, maxRounds: 10 });
  assert.equal(state.status, "stopped");
  const roundsBefore = state.rounds;
  // advance 假设调用方保证 running；这里仅验证重复调用不越界崩溃
  const out = advance({
    state,
    now: 9_999,
    value: 0,
    measureFailed: false,
    tokensUsed: 0,
  });
  assert.equal(out.state.rounds, roundsBefore); // 未新增轮
});
