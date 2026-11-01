import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeadline,
  resolveClock,
  systemTimers,
  type DeadlineReason,
  type TimersLike,
} from "@dsh-toolset/clock-base";

/** 手控排期器（只实现本包用到的 schedule；interval 不参与 createDeadline）。 */
function manualTimers(): {
  timers: TimersLike;
  pending(): number;
  advance(ms: number): void;
} {
  const queue: Array<{ at: number; callback: () => void }> = [];
  let now = 0;
  const timers: TimersLike = {
    now: () => now,
    schedule(delayMs, callback) {
      const entry = { at: now + delayMs, callback };
      queue.push(entry);
      return () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    interval() {
      return () => {};
    },
  };
  return {
    timers,
    pending: () => queue.length,
    advance(ms) {
      now += ms;
      for (const entry of [...queue]) {
        if (entry.at > now) continue;
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        entry.callback();
      }
    },
  };
}

test("systemTimers: schedule 到点触发一次, 取消后不触发", async () => {
  const timers = systemTimers();
  assert.equal(typeof timers.now(), "number");
  const fired: string[] = [];
  const cancel = timers.schedule(5, () => fired.push("hit"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(fired, ["hit"]);

  const cancelSecond = timers.schedule(5, () => fired.push("second"));
  cancelSecond();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(fired, ["hit"], "取消后的排期不触发");
  cancel();
});

test("systemTimers: interval 反复触发, 取消后停止", async () => {
  const timers = systemTimers();
  let hits = 0;
  const cancel = timers.interval(5, () => {
    hits += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  cancel();
  const settled = hits;
  assert.equal(settled > 1, true, `间隔排期应触发多次（实际 ${settled}）`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hits, settled, "取消后不再触发");
});

test("systemTimers: 延迟非有限数抛 RangeError, 负数按 0 立即排期", async () => {
  const timers = systemTimers();
  assert.throws(
    () => timers.schedule(Number.NaN, () => {}),
    /延迟必须是有限数字/,
  );
  assert.throws(
    () => timers.interval(Number.POSITIVE_INFINITY, () => {}),
    RangeError,
  );
  const fired: string[] = [];
  timers.schedule(-5, () => fired.push("negative"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fired, ["negative"]);
});

test("resolveClock: 缺 ctx / 缺 get / get 抛错 / clock 形状不符 都回落并告警", () => {
  const cases: unknown[] = [
    null,
    {},
    {
      get() {
        throw new Error("服务未注册");
      },
    },
    { get: () => ({ now: () => 0 }) },
    { get: () => ({ now: () => 0, scope: "不是函数" }) },
  ];
  for (const ctx of cases) {
    const warnings: string[] = [];
    const timers = resolveClock(ctx, (message) => warnings.push(message));
    assert.equal(timers.fromClock, false, `ctx=${String(ctx)} 应回落`);
    assert.equal(timers.scoped, timers.detached, "回落时两组共用进程内定时器");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /clock 服务不可用/);
  }
});

test("resolveClock: scope 抛错或返回非定时器形状时回落告警", () => {
  for (const scope of [
    () => {
      throw new Error("fiber 已卸载");
    },
    () => ({}),
  ]) {
    const warnings: string[] = [];
    const timers = resolveClock(
      { get: () => ({ now: () => 0, scope }) },
      (message) => warnings.push(message),
    );
    assert.equal(timers.fromClock, false);
    assert.equal(warnings.length, 1);
  }
});

test("resolveClock: clock 可用时 scoped 绑定 ctx、detached 不绑定", () => {
  const manual = manualTimers();
  const scopes: unknown[] = [];
  const timers = resolveClock(
    {
      get: () => ({
        now: () => 0,
        scope(ctx?: unknown) {
          scopes.push(ctx);
          return manual.timers;
        },
      }),
    },
    (message) => assert.fail(`不应告警：${message}`),
  );
  assert.equal(timers.fromClock, true);
  assert.equal(scopes.length, 2);
  assert.notEqual(scopes[0], undefined, "第一次带 ctx");
  assert.equal(scopes[1], undefined, "第二次不带 ctx");
});

test("createDeadline: 到点触发 timeout 一次, 取消句柄撤销排期", () => {
  const manual = manualTimers();
  const fired: DeadlineReason[] = [];
  const deadline = createDeadline(manual.timers, undefined);

  deadline(100, (reason) => fired.push(reason));
  assert.equal(manual.pending(), 1);
  manual.advance(100);
  assert.deepEqual(fired, ["timeout"]);
  assert.equal(manual.pending(), 0);

  const cancel = deadline(100, (reason) => fired.push(reason));
  assert.equal(manual.pending(), 1);
  cancel();
  assert.equal(manual.pending(), 0, "取消后无残留排期");
  cancel();
  manual.advance(100);
  assert.deepEqual(fired, ["timeout"], "取消后不再触发");
});

test("createDeadline: ctx 无 effect / effect 抛错时到点仍触发", () => {
  for (const ctx of [
    undefined,
    { effect: "不是函数" },
    {
      effect() {
        throw new Error("宿主 fiber 已卸载");
      },
    },
  ]) {
    const manual = manualTimers();
    const fired: DeadlineReason[] = [];
    const deadline = createDeadline(manual.timers, ctx);
    deadline(50, (reason) => fired.push(reason));
    manual.advance(50);
    assert.deepEqual(fired, ["timeout"]);
  }
});

test("createDeadline: 卸载触发 unload 并撤销排期, 已触发后不重复", () => {
  const manual = manualTimers();
  let unloadAction: (() => void) | undefined;
  const ctx = {
    effect(fn: () => () => void) {
      unloadAction = fn();
      return () => unloadAction?.();
    },
  };
  const fired: DeadlineReason[] = [];
  createDeadline(manual.timers, ctx)(10_000, (reason) => fired.push(reason));
  assert.equal(manual.pending(), 1);
  unloadAction?.();
  assert.deepEqual(fired, ["unload"]);
  assert.equal(manual.pending(), 0, "卸载后无残留排期");
  unloadAction?.();
  assert.deepEqual(fired, ["unload"], "重复卸载不重复触发");
});

test("createDeadline: 取消时执行 effect 的 disposer, 抛错与拒绝都不外泄", () => {
  const failing = manualTimers();
  const throwingCtx = {
    effect() {
      return () => {
        throw new Error("disposer 抛错");
      };
    },
  };
  const cancel = createDeadline(failing.timers, throwingCtx)(100, () => {});
  assert.doesNotThrow(() => cancel());

  const rejecting = manualTimers();
  const rejectingCtx = {
    effect() {
      return () => Promise.reject(new Error("disposer 拒绝"));
    },
  };
  const cancelRejecting = createDeadline(rejecting.timers, rejectingCtx)(
    100,
    () => {},
  );
  assert.doesNotThrow(() => cancelRejecting());
});
