// tests/clock.test.ts — 定时器统一面接线（假时钟 / 卸载撤销 / 服务缺失降级）
//
// 跨包 import 真实 `ManualClock`（timer 包）作假时钟；本文件不在 tsconfig 的 include 内
// （`rootDir` 限制，见 tsconfig.json 的 exclude），测试运行时经 node 类型擦除直接加载。
import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, runChildOnce } from "../src/main.ts";
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

/** 极简 cordis ctx：只实现本包消费的 `get` / `effect`。 */
function fakeCtx(services: Record<string, unknown> = {}): {
  ctx: {
    get(name: string): unknown;
    effect(fn: () => () => void): () => void;
  };
  unload(): void;
} {
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
  };
  return {
    ctx,
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
  };
}

/** 永不结算的 subagents 服务（制造超时 / 卸载收尾路径）。 */
function hangingSubagents(): Record<string, unknown> {
  return {
    getProvider: () => ({
      name: "spawn",
      capabilities: { agentOptions: true, outputSchema: true },
    }),
    start: () => ({
      id: "child-1",
      localAgent: { session: { id: "child-1" } },
      result: new Promise(() => {}),
      dispose: async () => {},
    }),
  };
}

test("resolveClock: clock 可用时按 ctx 造绑定排期器，另造一组不绑定排期器", () => {
  const manual = new ManualClock(0);
  const scopes: unknown[] = [];
  const { ctx } = fakeCtx({ clock: fakeClock(manual, scopes) });
  const warnings: string[] = [];
  const timers = resolveClock(ctx, (message) => warnings.push(message));

  assert.equal(timers.fromClock, true);
  assert.equal(timers.scoped, manual);
  assert.equal(timers.detached, manual);
  assert.deepEqual(scopes, [ctx, undefined]);
  assert.deepEqual(warnings, []);
});

test("resolveClock: 服务缺失时回落进程内定时器并告警一次", () => {
  const { ctx } = fakeCtx();
  const warnings: string[] = [];
  const timers = resolveClock(ctx, (message) => warnings.push(message));
  assert.equal(timers.fromClock, false);
  assert.equal(warnings.length, 1);
  assert.equal(typeof timers.scoped.now(), "number");
});

test("createDeadline: 到点触发 timeout；卸载触发 unload 且无残留", () => {
  const manual = new ManualClock(0);
  const { ctx, unload } = fakeCtx();
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

test("runChildOnce: 超时经统一面排期，到点中止且无残留", async () => {
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx();
  const subagents = hangingSubagents();
  const running = runChildOnce(
    {
      resolve: <T>(name: string): T | undefined =>
        (name === "subagents" ? subagents : undefined) as T | undefined,
      agent: { session: { id: "s1" } },
      warn: () => {},
      deadline: createDeadline(manual, ctx),
    },
    {
      label: "task:exec:c1",
      prompt: "干活",
      requireParent: true,
      timeoutMs: 100,
    },
  );

  await waitUntil(() => manual.pending >= 1);
  manual.advance(100);
  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.feedback, /超时.*后中止/);
  assert.equal(manual.pending, 0, "收尾后无残留排期");
});

test("runChildOnce: 插件卸载时立即中止在途 run，无残留排期", async () => {
  const manual = new ManualClock(0);
  const { ctx, unload } = fakeCtx();
  const subagents = hangingSubagents();
  const running = runChildOnce(
    {
      resolve: <T>(name: string): T | undefined =>
        (name === "subagents" ? subagents : undefined) as T | undefined,
      agent: { session: { id: "s1" } },
      warn: () => {},
      deadline: createDeadline(manual, ctx),
    },
    { label: "task:exec:c2", prompt: "干活", requireParent: true },
  );

  await waitUntil(() => manual.pending >= 1);
  unload();
  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.feedback, /超时.*后中止/);
  assert.equal(manual.pending, 0, "卸载后无残留排期");
});

test("apply: 服务缺失时只告警一次（回落进程内定时器）", async () => {
  const original = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await apply(
      {
        tools: { register: () => {} },
        get: () => undefined,
        provide: () => {},
      },
      {},
    );
  } finally {
    process.stderr.write = original;
  }
  assert.equal(
    chunks.filter((line) => line.includes("clock 服务不可用")).length,
    1,
    "每个插件实例只告警一次",
  );
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
