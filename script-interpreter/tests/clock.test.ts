// tests/clock.test.ts — 定时器统一面接线（假时钟 / 卸载撤销 / 服务缺失降级）
//
// 跨包 import 真实 `ManualClock`（clock-base 包）作假时钟；本文件不在 tsconfig 的 include 内
// （`rootDir` 限制，见 tsconfig.json 的 exclude），测试运行时经 node 类型擦除直接加载。
import assert from "node:assert/strict";
import { test } from "node:test";

import { apply } from "../src/index.ts";
import { runScript } from "../src/run.ts";
import { createDeadline, resolveClock } from "../src/timers.ts";
import { ManualClock } from "../../clock-base/src/timers.ts";

/** `clock` 服务的假实现：`scope()` 一律返回同一块手控表，并记录调用参数。 */
function fakeClock(manual: ManualClock, scopes: unknown[] = []): unknown {
  return {
    now: () => manual.now(),
    scope(ctx?: unknown): ManualClock {
      scopes.push(ctx);
      return manual;
    },
  };
}

/** 极简 cordis ctx：只实现本包消费的 get / effect / logger / tools。 */
function fakeHost(services: Record<string, unknown> = {}): {
  ctx: {
    get(name: string): unknown;
    effect(fn: () => () => void): () => void;
    logger(ns: string): {
      info(message: string): void;
      warn(message: string): void;
    };
    tools: { register(def: unknown): void };
  };
  logs: string[];
  defs: unknown[];
  unload(): void;
} {
  const logs: string[] = [];
  const defs: unknown[] = [];
  const disposers: Array<() => unknown> = [];
  const ctx = {
    get: (name: string): unknown => services[name],
    effect(fn: () => () => void): () => void {
      const dispose = fn();
      disposers.push(dispose);
      return () => {
        void dispose();
      };
    },
    logger: (): {
      info(message: string): void;
      warn(message: string): void;
    } => ({
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(`警告：${message}`),
    }),
    tools: {
      register: (def: unknown): void => {
        defs.push(def);
      },
    },
  };
  return {
    ctx,
    logs,
    defs,
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
  };
}

test("resolveClock: clock 可用时按 ctx 造绑定排期器，另造一组不绑定排期器", () => {
  const manual = new ManualClock(0);
  const scopes: unknown[] = [];
  const { ctx } = fakeHost({ clock: fakeClock(manual, scopes) });
  const warnings: string[] = [];
  const timers = resolveClock(ctx, (message) => warnings.push(message));

  assert.equal(timers.fromClock, true);
  assert.equal(timers.scoped, manual);
  assert.equal(timers.detached, manual);
  assert.deepEqual(scopes, [ctx, undefined]);
  assert.deepEqual(warnings, []);
});

test("resolveClock: 服务缺失时回落进程内定时器并告警一次", () => {
  const { ctx } = fakeHost();
  const warnings: string[] = [];
  const timers = resolveClock(ctx, (message) => warnings.push(message));
  assert.equal(timers.fromClock, false);
  assert.equal(warnings.length, 1);
  assert.equal(typeof timers.scoped.now(), "number");
});

test("createDeadline: 到点触发 timeout；卸载触发 unload 且无残留", () => {
  const manual = new ManualClock(0);
  const { ctx, unload } = fakeHost();
  const deadline = createDeadline(manual, ctx);
  const fired: string[] = [];

  deadline(100, (reason) => fired.push(reason));
  manual.advance(100);
  assert.deepEqual(fired, ["timeout"]);
  assert.equal(manual.pending, 0);

  deadline(10_000, (reason) => fired.push(reason));
  unload();
  assert.deepEqual(fired, ["timeout", "unload"]);
  assert.equal(manual.pending, 0);
});

test("runScript: 超时经 clock 排期，到点终止进程组且无残留", async () => {
  const manual = new ManualClock(0);
  const { ctx } = fakeHost();
  const running = runScript({
    argv: ["sh"],
    script: "sleep 5",
    timeoutMs: 100,
    maxOutputChars: 1_000,
    deadline: createDeadline(manual, ctx),
  });
  await waitUntil(() => manual.pending >= 1);
  manual.advance(100);
  const outcome = await running;

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.exitCode, null);
  assert.equal(manual.pending, 0, "收尾后无残留排期");
});

test("runScript: 插件卸载时立即 SIGKILL（不再排宽限）且无残留", async () => {
  const manual = new ManualClock(0);
  const { ctx, unload } = fakeHost();
  const running = runScript({
    argv: ["sh"],
    script: "sleep 5",
    timeoutMs: 60_000,
    maxOutputChars: 1_000,
    deadline: createDeadline(manual, ctx),
  });
  await waitUntil(() => manual.pending >= 1);
  unload();
  const outcome = await running;

  assert.equal(outcome.signal, "SIGKILL");
  assert.equal(outcome.timedOut, false, "卸载不是超时，只是立即收尾");
  assert.equal(manual.pending, 0, "卸载后无残留排期");
});

test("apply: clock 可用时工具照常注册且不告警", () => {
  const manual = new ManualClock(0);
  const { ctx, logs, defs } = fakeHost({ clock: fakeClock(manual) });
  apply(ctx, { languages: ["sh"] });
  assert.equal(defs.length, 1);
  assert.deepEqual(
    logs.filter((line) => line.includes("clock 服务不可用")),
    [],
  );
});

test("apply: 服务缺失时工具照常注册，且只告警一次", () => {
  const { ctx, logs, defs } = fakeHost();
  apply(ctx, { languages: ["sh"] });
  assert.equal(defs.length, 1);
  assert.equal(
    logs.filter((line) => line.includes("clock 服务不可用")).length,
    1,
    "每个插件实例只告警一次",
  );
});

test("apply: 卸载时在途脚本被终止，假时钟无残留排期", async () => {
  const manual = new ManualClock(0);
  const { ctx, defs, unload } = fakeHost({ clock: fakeClock(manual) });
  apply(ctx, { languages: ["sh"] });
  const tool = defs[0] as {
    execute(args: unknown, exec?: unknown): Promise<unknown>;
  };
  const running = tool.execute(
    { script: "sleep 5", description: "sleep in plugin" },
    {},
  );
  await waitUntil(() => manual.pending >= 1);
  unload();
  const value = (await running) as { signal?: unknown };
  assert.equal(value.signal, "SIGKILL");
  assert.equal(manual.pending, 0, "卸载后无残留排期");
});

/** 轮询谓词直到成立（真实定时器；判稳用）。 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const at = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > at) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
