// timer 插件入口单测：服务注册（provide / 直接挂载 / 重复注册告警）+ clock 服务面形状。

import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, ClockService, name, provide } from "../src/main.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 最小 cordis 形状：`provide` 记到表里、`get` 读回来。 */
function makeHost(): {
  ctx: {
    get: (key: string) => unknown;
    provide: (key: string, value: unknown) => void;
  };
  services: Map<string, unknown>;
} {
  const services = new Map<string, unknown>();
  return {
    services,
    ctx: {
      get: (key) => services.get(key),
      provide: (key, value) => {
        if (services.has(key)) {
          throw new Error(`service "${key}" already registered`);
        }
        services.set(key, value);
      },
    },
  };
}

/** 临时替换 stderr.write，返回收集到的行。 */
function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test("bundle 声明：name=timer、provide=[clock]", () => {
  assert.equal(name, "timer");
  assert.deepEqual(provide, ["clock"]);
});

test("apply: 经 provide 注册 clock，get 可读回且形状正确", () => {
  const { ctx, services } = makeHost();
  apply(ctx);
  const clock = services.get("clock") as ClockService;
  assert.ok(clock instanceof ClockService);
  assert.equal(typeof clock.now(), "number");
  const timers = clock.scope(ctx);
  assert.equal(typeof timers.now, "function");
  assert.equal(typeof timers.schedule, "function");
  assert.equal(typeof timers.interval, "function");
  const dispose = timers.schedule(0, () => {});
  assert.equal(typeof dispose, "function");
  dispose();
});

test("apply: ctx 无 provide 时退回直接属性挂载", () => {
  const ctx: Record<string, unknown> = {};
  const lines = captureStderr(() => apply(ctx));
  assert.deepEqual(lines, []);
  assert.ok(ctx["clock"] instanceof ClockService);
});

test("apply: ctx 为空时只告警、不抛", () => {
  const lines = captureStderr(() => apply(undefined));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /ctx 无 provide/);
});

test("apply: 重复注册时告警、不掀翻宿主启动", () => {
  const { ctx } = makeHost();
  apply(ctx);
  const lines = captureStderr(() => apply(ctx));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /clock 注册失败/);
});

test("ClockService: now 可注入；scope 的 now 与 service 同源", () => {
  let current = 7_000;
  const clock = new ClockService(() => current);
  assert.equal(clock.now(), 7_000);
  const timers = clock.scope();
  assert.equal(timers.now(), 7_000);
  current = 9_000;
  assert.equal(clock.now(), 9_000);
  assert.equal(timers.now(), 9_000);
});

test("ClockService: scope 拿调用方 ctx 的 effect 注册清理（卸载后不触发）", async () => {
  const disposers: Array<() => void> = [];
  const ctx = {
    effect(factory: () => () => void) {
      disposers.push(factory());
    },
  };
  const clock = new ClockService();
  const timers = clock.scope(ctx);
  let fired = 0;
  timers.schedule(20, () => {
    fired += 1;
  });
  assert.equal(disposers.length, 1);
  for (const dispose of disposers) dispose();
  await sleep(45);
  assert.equal(fired, 0);
});

test("ClockService: scope 省略 ctx 时仍可排期与撤销", async () => {
  const clock = new ClockService();
  const timers = clock.scope();
  let fired = 0;
  const dispose = timers.schedule(10, () => {
    fired += 1;
  });
  dispose();
  await sleep(30);
  assert.equal(fired, 0);
});
