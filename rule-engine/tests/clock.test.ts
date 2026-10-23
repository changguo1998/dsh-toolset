// tests/clock.test.ts — 定时器统一面接线（假时钟 / 卸载撤销 / 服务缺失降级）
//
// 跨包 import 真实 `ManualClock`（timer 包）作假时钟；本文件不在 tsconfig 的 include 内
// （`rootDir` 限制，见 tsconfig.json 的 exclude），测试运行时经 node 类型擦除直接加载。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createAgentInjector } from "../src/inject.ts";
import type { InjectionHost } from "../src/inject.ts";
import { apply } from "../src/main.ts";
import { resolveClock } from "../src/timers.ts";
import type { InjectionRequest } from "../src/types.ts";
import { ManualClock } from "../../clock-base/src/timers.ts";

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

function request(): InjectionRequest {
  return {
    sourceId: "r1",
    sessionId: "s1",
    delivery: "followup",
    text: "正文",
    summary: "摘要",
  };
}

function fakeHost(): {
  host: InjectionHost;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const agent = {
    session: { id: "s1" },
    followup: (message: unknown): void => void calls.push(message),
  };
  return {
    calls,
    host: {
      agents: { get: (id: string) => (id === "s1" ? agent : undefined) },
      sessions: { flush: async () => true },
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
  const { ctx } = fakeCtx({ clock });
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

test("createAgentInjector: 推迟经统一面排期，到点送达", () => {
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx({ clock: fiberClock(manual) });
  const timers = resolveClock(ctx, () => {});
  const { host, calls } = fakeHost();
  const injector = createAgentInjector(host, {
    schedule: (delayMs, callback) => timers.scoped.schedule(delayMs, callback),
  });

  injector.inject(request());
  assert.equal(manual.pending, 1, "推迟的宏任务经统一面排期");
  manual.advance(0);
  assert.equal(manual.pending, 0);
  assert.equal(calls.length, 1, "到点送达宿主 followup");
});

test("createAgentInjector: 插件卸载后撤销排期、不再注入（无残留）", () => {
  const manual = new ManualClock(0);
  const { ctx, unload } = fakeCtx({ clock: fiberClock(manual) });
  const timers = resolveClock(ctx, () => {});
  const { host, calls } = fakeHost();
  const injector = createAgentInjector(host, {
    schedule: (delayMs, callback) => timers.scoped.schedule(delayMs, callback),
  });

  injector.inject(request());
  assert.equal(manual.pending, 1);
  unload();
  assert.equal(manual.pending, 0, "卸载后无残留排期");
  manual.advance(0);
  assert.deepEqual(calls, [], "卸载后不再回调宿主");
});

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rule-engine-clock-"));
  tempDirs.push(dir);
  return dir;
}

test("apply: 服务缺失时只告警一次（首个 onNotice 订阅者收到缓冲）", async () => {
  const provided: Array<{ name: string; value: unknown }> = [];
  const ctx = {
    agents: { get: () => undefined },
    sessions: { flush: async () => true },
    get: (): unknown => undefined,
    on: (): (() => void) => () => {},
    provide: (name: string, value: unknown): unknown => {
      provided.push({ name, value });
      return value;
    },
  };
  await apply(ctx, { stateDir: tempDir() });
  const service = provided.find((item) => item.name === "ruleEngine")
    ?.value as {
    onNotice(listener: (event: { text: string }) => void): () => void;
  };
  assert.notEqual(service, undefined);
  const notices: string[] = [];
  service.onNotice((event) => notices.push(event.text));
  assert.equal(
    notices.filter((line) => line.includes("clock 服务不可用")).length,
    1,
    "每个插件实例只告警一次",
  );
});
