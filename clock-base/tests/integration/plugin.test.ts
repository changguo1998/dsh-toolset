// clock-base 集成层：经假宿主调 `apply`，断言服务面 `clock` 的 now / schedule / interval、
// `ManualClock` 的确定性行为，以及排期随 fiber 卸载撤销。装配器见 `tests/assemble.ts`。

import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, ManualClock } from "../../src/index.ts";
import { assemble, captureStderr } from "../assemble.ts";

/** 集成层等的真实时间：服务面排期走真实定时器，本层不能换成 ManualClock。 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 服务面注册
// ---------------------------------------------------------------------------

test("apply: 经 provide 注册 clock 服务，get 读回同一实例", () => {
  const host = assemble();
  assert.deepEqual(host.services.names(), ["clock"]);
  const first = host.clock();
  assert.equal(host.clock(), first, "每次 get 读到同一个服务对象");
  assert.equal(typeof first.now, "function");
  assert.equal(typeof first.scope, "function");
  assert.deepEqual(host.logs, { info: [], warn: [] });
  assert.deepEqual(host.stderr, []);
});

test("装配面: 本包不注册工具、不订阅事件", () => {
  const host = assemble();
  assert.deepEqual(host.tools.names(), []);
  assert.equal(host.events.listenerCount(), 0);
});

test("重复挂载: 告警且保留已注册的服务", () => {
  const host = assemble();
  const registered = host.clock();
  const lines = captureStderr(() => apply(host.ctx));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /clock 注册失败/);
  assert.equal(host.clock(), registered, "重复注册不覆盖原服务");
});

test("降级装配: 无 provide 时退回属性挂载，clock 仍可用", () => {
  const host = assemble({ shape: "no-provide" });
  assert.deepEqual(host.services.names(), []);
  assert.deepEqual(host.stderr, []);
  const clock = host.clock();
  assert.equal(typeof clock.now(), "number");
  assert.equal(typeof clock.scope().schedule, "function");
});

test("降级装配: 空 ctx 只告警、不抛", () => {
  const host = assemble({ shape: "empty" });
  assert.equal(host.stderr.length, 1);
  assert.match(host.stderr[0] ?? "", /ctx 无 provide/);
  assert.throws(() => host.clock(), /服务面 clock 未注册/);
});

// ---------------------------------------------------------------------------
// 服务面行为
// ---------------------------------------------------------------------------

test("clock.now: 读系统时钟，返回值落在此刻区间内", () => {
  const host = assemble();
  const clock = host.clock();
  const before = Date.now();
  const now = clock.now();
  const after = Date.now();
  assert.ok(Number.isFinite(now));
  assert.ok(
    now >= before && now <= after,
    `now=${now} 应在 [${before}, ${after}]`,
  );
});

test("clock.scope: schedule 到点触发一次，disposer 撤销后不触发", async () => {
  const host = assemble();
  const clock = host.clock();
  const fired: number[] = [];
  clock.scope().schedule(10, () => fired.push(clock.now()));
  await wait(40);
  assert.equal(fired.length, 1);

  const dispose = clock.scope().schedule(10, () => fired.push(clock.now()));
  dispose();
  dispose();
  await wait(30);
  assert.equal(fired.length, 1, "撤销后不再触发，且撤销幂等");
});

test("clock.scope: interval 按间隔重复，撤销后停", async () => {
  const host = assemble();
  const clock = host.clock();
  let ticks = 0;
  const dispose = clock.scope().interval(10, () => {
    ticks += 1;
  });
  await wait(45);
  dispose();
  const stopped = ticks;
  assert.ok(stopped >= 2, `45ms 内应至少两次（实际 ${stopped}）`);
  await wait(30);
  assert.equal(ticks, stopped, "撤销后不再累加");
});

test("clock.scope(ctx): 排期登记到 ctx.effect，卸载后不触发", async () => {
  const host = assemble();
  const clock = host.clock();
  let fired = 0;
  let ticks = 0;
  const timers = clock.scope(host.ctx);
  timers.schedule(15, () => {
    fired += 1;
  });
  timers.interval(10, () => {
    ticks += 1;
  });
  assert.deepEqual(host.effectLabels, ["clock.timer", "clock.timer"]);

  host.unload();
  await wait(40);
  assert.equal(fired, 0);
  assert.equal(ticks, 0);
  assert.deepEqual(host.effectLabels, ["clock.timer", "clock.timer"]);
});

test("clock.scope(): 省略 ctx 时不登记 effect，只认返回的 disposer", async () => {
  const host = assemble();
  const clock = host.clock();
  let fired = 0;
  const dispose = clock.scope().schedule(10, () => {
    fired += 1;
  });
  assert.deepEqual(host.effectLabels, []);
  dispose();
  host.unload();
  await wait(30);
  assert.equal(fired, 0);
});

// ---------------------------------------------------------------------------
// ManualClock：服务面同一接口的确定性实现
// ---------------------------------------------------------------------------

test("ManualClock: 跨刻按到期时刻、同刻按插入序触发，撤销后停", () => {
  const clock = new ManualClock(1_000);
  const order: string[] = [];
  clock.schedule(20, () => order.push(`schedule@${clock.now()}`));
  const tick = clock.interval(10, () => order.push(`interval@${clock.now()}`));

  clock.advance(20);
  assert.deepEqual(order, ["interval@1010", "schedule@1020", "interval@1020"]);
  assert.equal(clock.pending, 1);

  tick();
  clock.advance(30);
  assert.equal(clock.pending, 0);
  assert.equal(order.length, 3, "撤销后不再触发");
});

test("ManualClock: 未到点不触发，回调里新排的期在同次推进内触发", () => {
  const clock = new ManualClock();
  const order: string[] = [];
  clock.schedule(10, () => {
    order.push("outer");
    clock.schedule(5, () => order.push("nested"));
  });

  clock.advance(9);
  assert.deepEqual(order, []);
  assert.equal(clock.now(), 9);

  clock.advance(6);
  assert.deepEqual(order, ["outer", "nested"]);
  assert.equal(clock.now(), 15);
  assert.equal(clock.pending, 0);
});
