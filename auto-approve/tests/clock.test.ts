// tests/clock.test.ts — 定时器统一面接线（假时钟 / 卸载撤销 / 服务缺失降级）
//
// 跨包 import 真实 `ManualClock`（timer 包）作假时钟；本文件不在 tsconfig 的 include 内
// （`rootDir` 限制，见 tsconfig.json 的 exclude），测试运行时经 node 类型擦除直接加载。
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import { CallTable } from "../src/calls.ts";
import { FingerprintStore } from "../src/fingerprint.ts";
import { FormStore, createLearner } from "../src/learn.ts";
import { createBundle, name } from "../src/main.ts";
import { runReview, type Reviewer } from "../src/review.ts";
import { SessionObserver } from "../src/sessions.ts";
import { createDeadline, resolveClock } from "../src/timers.ts";
import type { PluginHost } from "../src/types.ts";
import { ManualClock } from "../../clock-base/src/timers.ts";
import { createFakeHost } from "./fakes.ts";

/**
 * 假 `clock`：`scope(ctx)` 把每次排期的撤销动作登记到 ctx 的 `effect` 上
 * （与 timer 的 `ClockService.scope(ctx)` 同语义），用于断言卸载即撤销。
 */
function fiberClock(manual: ManualClock): unknown {
  return {
    now: () => manual.now(),
    scope(ctx?: unknown) {
      const bind = (stop: () => void): (() => void) => {
        if (ctx !== null && typeof ctx === "object") {
          const effect = (ctx as { effect?: unknown }).effect;
          if (typeof effect === "function") {
            (effect as (fn: () => () => void) => unknown).call(ctx, () => stop);
          }
        }
        return stop;
      };
      return {
        now: () => manual.now(),
        schedule(delayMs: number, callback: () => void): () => void {
          return bind(manual.schedule(delayMs, callback));
        },
        interval(delayMs: number, callback: () => void): () => void {
          return bind(manual.interval(delayMs, callback));
        },
      };
    },
  };
}

/** 极简 cordis ctx：只实现本包消费的 `get` / `effect`。 */
function fakeCtx(services: Record<string, unknown> = {}): {
  ctx: {
    get(name: string): unknown;
    effect(fn: () => () => void): () => void;
  };
  warnings: string[];
  unload(): void;
} {
  const warnings: string[] = [];
  const disposers: Array<() => unknown> = [];
  const ctx = {
    get: (service: string): unknown => services[service],
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
    warnings,
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
  };
}

test("resolveClock: clock 可用时按 ctx 造绑定排期器，另造一组不绑定排期器", () => {
  const manual = new ManualClock(0);
  const scopes: unknown[] = [];
  const clock = {
    now: () => manual.now(),
    scope(ctx?: unknown): ManualClock {
      scopes.push(ctx);
      return manual;
    },
  };
  const { ctx, warnings } = fakeCtx({ clock });
  const timers = resolveClock(ctx, (message) => warnings.push(message));

  assert.equal(timers.fromClock, true);
  assert.equal(timers.scoped, manual);
  assert.equal(timers.detached, manual);
  assert.deepEqual(scopes, [ctx, undefined]);
  assert.deepEqual(warnings, []);
});

test("resolveClock: 服务缺失时回落进程内定时器并告警一次", () => {
  const { ctx, warnings } = fakeCtx();
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

test("runReview: 审查超时经统一面排期，到点中止且无残留", async () => {
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx();
  const reviewer: Reviewer = {
    route: () => ({ provider: "p", model: "m" }),
    deadline: createDeadline(manual, ctx),
    review: (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted by deadline")),
          { once: true },
        );
      }),
  };

  const running = runReview(
    reviewer,
    {
      toolName: "bash",
      arguments: {},
      cwd: "/w",
      history: [],
      projectInstructions: [],
    },
    50,
  );
  await waitUntil(() => manual.pending >= 1);
  manual.advance(50);
  await assert.rejects(running, /aborted by deadline/);
  assert.equal(manual.pending, 0, "收尾后无残留排期");
});

test("学习窗口: 排期经统一面，卸载即撤销且无残留", () => {
  const manual = new ManualClock(0);
  const { ctx, unload, warnings } = fakeCtx({ clock: fiberClock(manual) });
  const timers = resolveClock(ctx, (message) => warnings.push(message));
  const config = resolveConfig({});
  const calls = new CallTable(config.callTableCapacity);
  const sessions = new SessionObserver();
  const reviews: unknown[] = [];
  const learner = createLearner({
    config,
    calls,
    sessions,
    forms: new FormStore(config.formCapacity),
    fingerprints: new FingerprintStore(config.fingerprintCapacity),
    isActive: () => true,
    reviewer: async (request) => {
      reviews.push(request);
      return request.candidates.map(() => ({
        allow: true,
        risk: "low" as const,
      }));
    },
    warn: (message) => warnings.push(message),
    schedule: (fn, ms) => timers.scoped.schedule(ms, fn),
  });
  calls.record({
    callId: "c1",
    name: "bash",
    arguments: { command: "ls" },
    sessionId: "s1",
    cwd: "/w",
  });
  learner.observe("s1", {
    type: "approval/asked",
    data: { id: "a1", toolName: "bash", callId: "c1" },
  });
  learner.observe("s1", {
    type: "approval/decided",
    data: { id: "a1", outcome: "allowed-once" },
  });
  assert.equal(manual.pending, 1, "学习窗口经统一面排期");

  unload();
  assert.equal(manual.pending, 0, "卸载后无残留排期");
  manual.advance(10_000);
  assert.deepEqual(reviews, [], "卸载后不再发起审阅");
  learner.dispose();
});

test("createBundle: 服务缺失时只告警一次", () => {
  const warnings: string[] = [];
  const host = createFakeHost();
  const bundle = createBundle(
    host as unknown as PluginHost,
    resolveConfig({}),
    (message) => warnings.push(message),
  );
  try {
    assert.equal(
      warnings.filter((line) => line.includes("clock 服务不可用")).length,
      1,
      `每个插件实例只告警一次（实际：${warnings.join(" | ")}）`,
    );
  } finally {
    bundle.dispose();
  }
  assert.equal(name, "auto-approve");
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
