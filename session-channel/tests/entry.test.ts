/**
 * 入口锚点: `src/index.ts` 里未被既有用例走到的判定分支 —— 定时器统一面的四条回落路径
 * (缺服务 / 形状不符 / scope 返回形状不符 / scope 抛错) 与进程内定时器的撤销语义.
 *
 * 纯单元层: 不起宿主、不连 Redis; 定时器用毫秒级真实等待.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveTimers, systemTimers } from "../src/index.ts";

/** 带 `get` 的假宿主. */
function hostWith(services: Record<string, unknown>): unknown {
  return { get: (key: string) => services[key] };
}

test("systemTimers: schedule 只触发一次, interval 重复触发, 撤销后不再触发", async () => {
  const timers = systemTimers();
  assert.equal(typeof timers.now(), "number");

  let scheduled = 0;
  const stopSchedule = timers.schedule(5, () => {
    scheduled += 1;
  });
  let ticks = 0;
  const stopInterval = timers.interval(5, () => {
    ticks += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  stopSchedule();
  stopInterval();
  assert.equal(scheduled, 1, "schedule 只触发一次");
  assert.ok(ticks >= 2, `interval 应重复触发, 实际 ${ticks}`);
  const settled = ticks;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ticks, settled, "撤销后不再触发");
});

test("resolveTimers: 缺服务 / 形状不符 / scope 异常一律回落进程内定时器", () => {
  // 1) 没有 clock 服务
  const noService = resolveTimers(hostWith({}));
  assert.equal(Math.abs(noService.now() - Date.now()) < 1000, true);

  // 2) clock 缺 scope
  const noScope = resolveTimers(hostWith({ clock: { now: () => 1 } }));
  assert.equal(Math.abs(noScope.now() - Date.now()) < 1000, true);

  // 3) scope 返回 undefined / 返回形状不符 (缺 interval)
  const badScope = resolveTimers(
    hostWith({ clock: { now: () => 1, scope: () => undefined } }),
  );
  assert.equal(Math.abs(badScope.now() - Date.now()) < 1000, true);
  const badShape = resolveTimers(
    hostWith({
      clock: {
        now: () => 1,
        scope: () => ({ now: () => 2, schedule: () => () => {} }),
      },
    }),
  );
  assert.equal(Math.abs(badShape.now() - Date.now()) < 1000, true);

  // 4) scope 抛错
  const throwing = resolveTimers(
    hostWith({
      clock: {
        now: () => 1,
        scope: () => {
          throw new Error("scope 失败");
        },
      },
    }),
  );
  assert.equal(Math.abs(throwing.now() - Date.now()) < 1000, true);
});

test("resolveTimers: 合法 clock 服务原样使用 (心跳排期随调用方 fiber 撤销)", () => {
  const scheduled: Array<{ delayMs: number }> = [];
  const custom = {
    now: () => 42,
    schedule: (delayMs: number) => {
      scheduled.push({ delayMs });
      return () => {};
    },
    interval: () => () => {},
  };
  const timers = resolveTimers(
    hostWith({ clock: { now: () => 42, scope: () => custom } }),
  );
  assert.equal(timers.now(), 42, "用服务面时钟");
  timers.schedule(7, () => {});
  assert.deepEqual(scheduled, [{ delayMs: 7 }], "排期走服务面");
});
