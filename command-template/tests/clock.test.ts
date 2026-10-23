// tests/clock.test.ts — 定时器统一面接线（假时钟 / 卸载撤销 / 服务缺失降级）
//
// 跨包 import 真实 `ManualClock`（timer 包）作假时钟；本文件不在 tsconfig 的 include 内
// （`rootDir` 限制，见 tsconfig.json 的 exclude），测试运行时经 node 类型擦除直接加载。
import assert from "node:assert/strict";
import { test } from "node:test";

import { CommandTemplateService } from "../src/main.ts";
import { runOneShotAgent } from "../src/subagent.ts";
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

/** 极简 cordis ctx：只实现本包消费的 `get` / `effect` / `logger`。 */
function fakeCtx(services: Record<string, unknown> = {}): {
  ctx: {
    get(name: string): unknown;
    effect(fn: () => () => void): () => void;
    logger(ns: string): {
      info(message: string): void;
      warn(message: string): void;
    };
  };
  logs: string[];
  warnings: string[];
  unload(): void;
} {
  const logs: string[] = [];
  const warnings: string[] = [];
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
      warn: (message: string) => warnings.push(message),
    }),
  };
  return {
    ctx,
    logs,
    warnings,
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
  };
}

/** 永不终态的 subagents 服务 + 宿主 settleRun（制造超时 / 卸载收尾路径）。 */
function hangingRuntime(): Record<string, unknown> {
  const run = {
    id: "child-1",
    result: new Promise(() => {}),
    dispose: async () => {},
  };
  return {
    list: () => ["spawn"],
    getProvider: (name: string) => ({ name, start: async () => run }),
    start: async () => run,
  };
}

function hangingHostModule(): Record<string, unknown> {
  return { settleRun: () => new Promise(() => {}) };
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

test("runOneShotAgent: 超时经统一面排期，到点中止且无残留", async () => {
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx();
  const runtime = hangingRuntime();
  const running = runOneShotAgent({
    ctx: {
      get: (name: string) => (name === "subagents" ? runtime : undefined),
    },
    prompt: "干活",
    timeoutMs: 100,
    deadline: createDeadline(manual, ctx),
    loadHostModule: async () => hangingHostModule(),
  });

  await waitUntil(() => manual.pending >= 1);
  manual.advance(100);
  await assert.rejects(running, /子代理步骤超时/);
  assert.equal(manual.pending, 0, "收尾后无残留排期");
});

test("runOneShotAgent: 插件卸载时立即中止在途运行，无残留排期", async () => {
  const manual = new ManualClock(0);
  const { ctx, unload } = fakeCtx();
  const runtime = hangingRuntime();
  const running = runOneShotAgent({
    ctx: {
      get: (name: string) => (name === "subagents" ? runtime : undefined),
    },
    prompt: "干活",
    deadline: createDeadline(manual, ctx),
    loadHostModule: async () => hangingHostModule(),
  });

  await waitUntil(() => manual.pending >= 1);
  unload();
  await assert.rejects(running, /子代理步骤超时/);
  assert.equal(manual.pending, 0, "卸载后无残留排期");
});

test("CommandTemplateService: 服务缺失时只告警一次", () => {
  const { ctx, warnings } = fakeCtx();
  new CommandTemplateService(ctx, {});
  assert.equal(
    warnings.filter((line) => line.includes("clock 服务不可用")).length,
    1,
    `每个插件实例只告警一次（实际：${warnings.join(" | ")}）`,
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
