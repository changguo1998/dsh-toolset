// 定时器统一面核心单测：手控假时钟 + 真实定时器（含 fiber 清理与无 ctx 退化）。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTimers,
  ManualClock,
  MAX_ADVANCE_STEPS,
  resolveDelay,
} from "../src/timers.ts";

/** 真实等待（不用 unref：测试进程要等它）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ManualClock：排期 / 推进 / 撤销
// ---------------------------------------------------------------------------

test("ManualClock: 未到点不触发，到点触发一次，now 随推进", () => {
  const clock = new ManualClock(1_000);
  const fired: number[] = [];
  clock.schedule(50, () => fired.push(clock.now()));

  clock.advance(49);
  assert.deepEqual(fired, []);
  assert.equal(clock.now(), 1_049);
  assert.equal(clock.pending, 1);

  clock.advance(1);
  assert.deepEqual(fired, [1_050]);
  assert.equal(clock.now(), 1_050);
  assert.equal(clock.pending, 0);

  clock.advance(100);
  assert.deepEqual(fired, [1_050], "一次性排期不重复触发");
});

test("ManualClock: 撤销后再推进不触发，撤销幂等", () => {
  const clock = new ManualClock();
  let fired = 0;
  const dispose = clock.schedule(10, () => {
    fired += 1;
  });
  dispose();
  dispose();
  assert.equal(clock.pending, 0);
  clock.advance(100);
  assert.equal(fired, 0);
});

test("ManualClock: interval 按间隔重复，撤销后停", () => {
  const clock = new ManualClock();
  let ticks = 0;
  const dispose = clock.interval(10, () => {
    ticks += 1;
  });

  clock.advance(35);
  assert.equal(ticks, 3);
  assert.equal(clock.now(), 35);

  dispose();
  clock.advance(100);
  assert.equal(ticks, 3);
});

test("ManualClock: 同刻到期按插入顺序，早到期的先触发", () => {
  const clock = new ManualClock();
  const order: string[] = [];
  clock.schedule(20, () => order.push("late"));
  clock.schedule(10, () => order.push("early"));
  clock.schedule(10, () => order.push("early-2"));

  clock.advance(20);
  assert.deepEqual(order, ["early", "early-2", "late"]);
});

test("ManualClock: 回调里新排的期若在本次 target 内也触发", () => {
  const clock = new ManualClock();
  const order: string[] = [];
  clock.schedule(10, () => {
    order.push("first");
    clock.schedule(5, () => order.push("nested"));
  });
  clock.interval(10, () => order.push("interval"));

  clock.advance(15);
  assert.deepEqual(
    order,
    ["first", "interval", "nested"],
    "按绝对到期时刻排序，不按插入序",
  );
  assert.equal(clock.now(), 15);
});

test("ManualClock: 回调内可撤销别的排期与自己", () => {
  const clock = new ManualClock();
  const order: string[] = [];
  let disposeB: (() => void) | undefined;
  let disposeSelf: (() => void) | undefined;

  disposeSelf = clock.interval(10, () => {
    order.push("self");
    disposeSelf?.();
    disposeB?.();
  });
  disposeB = clock.schedule(15, () => order.push("b"));

  clock.advance(100);
  assert.deepEqual(order, ["self"]);
  assert.equal(clock.pending, 0);
});

test("ManualClock: advance(0) 会触发此刻到期的排期", () => {
  const clock = new ManualClock(500);
  let fired = 0;
  clock.schedule(0, () => {
    fired += 1;
  });
  clock.advance(0);
  assert.equal(fired, 1);
  assert.equal(clock.now(), 500);
});

test("ManualClock: 非法参数报错（延迟 / 起始时刻 / advance）", () => {
  const clock = new ManualClock();
  assert.throws(() => clock.schedule(Number.NaN, () => {}), RangeError);
  assert.throws(
    () => clock.interval(Number.POSITIVE_INFINITY, () => {}),
    RangeError,
  );
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => clock.advance(Number.NaN), RangeError);
  assert.throws(() => new ManualClock(Number.NaN), RangeError);
});

test("ManualClock: 0 间隔重复排期不会把 advance 挂死（步数上限报错）", () => {
  const clock = new ManualClock();
  let ticks = 0;
  clock.interval(0, () => {
    ticks += 1;
  });
  assert.throws(() => clock.advance(1), /步数过多/);
  assert.equal(ticks, MAX_ADVANCE_STEPS + 1, "到达上限即停，不会无限触发");
});

test("ManualClock: 负数延迟按 0 处理（与 setTimeout 一致）", () => {
  const clock = new ManualClock();
  let fired = 0;
  clock.schedule(-5, () => {
    fired += 1;
  });
  clock.advance(0);
  assert.equal(fired, 1);
});

// ---------------------------------------------------------------------------
// createTimers：真实定时器
// ---------------------------------------------------------------------------

test("createTimers: schedule 到点触发一次，disposer 撤销后不触发", async () => {
  const timers = createTimers();
  let fired = 0;
  timers.schedule(10, () => {
    fired += 1;
  });
  await sleep(40);
  assert.equal(fired, 1);

  const dispose = timers.schedule(10, () => {
    fired += 1;
  });
  dispose();
  dispose();
  await sleep(40);
  assert.equal(fired, 1);
});

test("createTimers: interval 重复触发，disposer 后停", async () => {
  const timers = createTimers();
  let ticks = 0;
  const dispose = timers.interval(10, () => {
    ticks += 1;
  });
  await sleep(55);
  assert.ok(ticks >= 2, `interval 至少触发两次（实际 ${ticks}）`);
  dispose();
  const frozen = ticks;
  await sleep(40);
  assert.equal(ticks, frozen);
});

test("createTimers: 给了带 effect 的 ctx 时，排期随其撤销动作清理", async () => {
  const disposers: Array<() => void> = [];
  const ctx = {
    effect(factory: () => () => void) {
      disposers.push(factory());
    },
  };
  const timers = createTimers({ ctx });
  let fired = 0;
  let ticks = 0;
  timers.schedule(20, () => {
    fired += 1;
  });
  timers.interval(10, () => {
    ticks += 1;
  });
  assert.equal(disposers.length, 2, "两个排期各登记一次 effect");

  for (const dispose of disposers) dispose();
  await sleep(45);
  assert.equal(fired, 0);
  assert.equal(ticks, 0);
});

test("createTimers: 没有 ctx / effect 形状不符时只认 disposer，不抛", async () => {
  const weird = {
    effect() {
      throw new Error("形状不符");
    },
  };
  const timers = createTimers({ ctx: weird });
  let fired = 0;
  const dispose = timers.schedule(10, () => {
    fired += 1;
  });
  await sleep(35);
  assert.equal(fired, 1);
  dispose();
});

test("createTimers: now 注入后读写同一时钟源", () => {
  const timers = createTimers({ now: () => 1234 });
  assert.equal(timers.now(), 1234);
});

test("resolveDelay: 负数归零，非有限数报错", () => {
  assert.equal(resolveDelay(-1), 0);
  assert.equal(resolveDelay(0), 0);
  assert.equal(resolveDelay(12.5), 12.5);
  assert.throws(() => resolveDelay(Number.NaN), RangeError);
  assert.throws(() => resolveDelay(Number.POSITIVE_INFINITY), RangeError);
});
