// tests/clock.test.ts — 定时器统一面接线（假时钟 / 卸载撤销 / 服务缺失降级）
//
// 跨包 import 真实 `ManualClock`（timer 包）作假时钟；本文件不在 tsconfig 的 include 内
// （`rootDir` 限制，见 tsconfig.json 的 exclude），测试运行时经 node 类型擦除直接加载。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createHerdrPlugin } from "../src/main.ts";
import type { HerdrPluginDeps } from "../src/main.ts";
import { HerdrClient } from "../src/herdr.ts";
import { createDeadline, resolveClock } from "../src/timers.ts";
import { ManualClock } from "../../timer/src/timers.ts";

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

/** 极简 cordis ctx：只实现本包消费的 `get` / `effect` / `on`。 */
function fakeCtx(services: Record<string, unknown> = {}): {
  ctx: {
    get(name: string): unknown;
    effect(fn: () => () => void): () => void;
    on(event: string, listener: (...args: unknown[]) => unknown): () => void;
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
    on(): () => void {
      return () => {};
    },
  };
  return {
    ctx,
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
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
  assert.deepEqual(
    scopes,
    [ctx, undefined],
    "scope 先传本插件 ctx、再传 undefined",
  );
  assert.deepEqual(warnings, []);
});

test("resolveClock: 服务缺失时回落进程内定时器并告警一次", () => {
  const { ctx } = fakeCtx();
  const warnings: string[] = [];

  const timers = resolveClock(ctx, (message) => warnings.push(message));

  assert.equal(timers.fromClock, false);
  assert.equal(warnings.length, 1, "每个插件实例只告警一次");
  assert.match(warnings[0] ?? "", /clock 服务不可用/);
  assert.equal(typeof timers.scoped.now(), "number");
  // 进程内回落仍可排期与撤销（真实定时器，短延迟）
  let fired = 0;
  const stop = timers.scoped.schedule(5, () => {
    fired += 1;
  });
  assert.equal(typeof stop, "function");
  stop();
});

test("createDeadline: 到点触发 timeout；正常收尾撤销后不再触发", () => {
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx();
  const deadline = createDeadline(manual, ctx);
  const fired: string[] = [];

  const cancel = deadline(100, (reason) => fired.push(reason));
  assert.equal(manual.pending, 1);

  manual.advance(99);
  assert.deepEqual(fired, []);
  manual.advance(1);
  assert.deepEqual(fired, ["timeout"]);
  assert.equal(manual.pending, 0);

  cancel();
  manual.advance(1_000);
  assert.deepEqual(fired, ["timeout"]);
});

test("createDeadline: 插件卸载时立即按超时收尾并撤销排期（无残留）", () => {
  const manual = new ManualClock(0);
  const { ctx, unload } = fakeCtx();
  const deadline = createDeadline(manual, ctx);
  const fired: string[] = [];

  deadline(10_000, (reason) => fired.push(reason));
  assert.equal(manual.pending, 1);

  unload();
  assert.deepEqual(fired, ["unload"], "卸载即收尾，不让在途操作悬挂");
  assert.equal(manual.pending, 0, "卸载后无残留排期");
});

test("createDeadline: 显式取消后卸载不再触发", () => {
  const manual = new ManualClock(0);
  const { ctx, unload } = fakeCtx();
  const deadline = createDeadline(manual, ctx);
  const fired: string[] = [];

  const cancel = deadline(10_000, (reason) => fired.push(reason));
  cancel();
  assert.equal(manual.pending, 0);
  unload();
  assert.deepEqual(fired, []);
});

/** 记录型 sender（本文件只关心插件装配与排期，不校验报文）。 */
function recordingSender(): HerdrPluginDeps["sender"] {
  return {
    setSessionRef: () => {},
    reportSession: async () => {},
    reportState: async () => {},
    release: async () => {},
    releaseSync: () => {},
  };
}

const ENV = {
  paneId: "p1",
  socketPath: "/tmp/herdr-clock-test.sock",
  source: "dsh",
  agent: "dsh",
};

test("插件装配: 周期补发经 clock 排期，dispose 后无残留", () => {
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx({ clock: fakeClock(manual) });
  const warnings: string[] = [];
  const plugin = createHerdrPlugin(
    ctx,
    { refreshIntervalMs: 1_000 },
    {
      sender: recordingSender(),
      readHerdrEnv: () => ENV,
      readRoots: () => [],
      warn: (message) => warnings.push(message),
    },
  );
  assert.ok(plugin);
  assert.deepEqual(warnings, [], "clock 可用时不告警");
  assert.equal(manual.pending, 1, "周期补发已经统一面排期");

  plugin.dispose();
  assert.equal(manual.pending, 0, "卸载后无残留排期");
});

test("插件装配: 服务缺失仍可工作，且只告警一次", () => {
  const { ctx } = fakeCtx();
  const warnings: string[] = [];
  const plugin = createHerdrPlugin(
    ctx,
    { refreshIntervalMs: 0 },
    {
      sender: recordingSender(),
      readHerdrEnv: () => ENV,
      readRoots: () => [],
      warn: (message) => warnings.push(message),
    },
  );
  assert.ok(plugin);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /回落进程内定时器/);
  plugin.dispose();
});

const tempDirs: string[] = [];
const servers: Server[] = [];

/** 只收不回的 socket 服务端（制造请求超时）。 */
function silentServer(): {
  path: string;
  listen(): Promise<void>;
  close(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "herdr-clock-"));
  tempDirs.push(dir);
  const path = join(dir, "herdr.sock");
  const server = createServer(() => {});
  servers.push(server);
  return {
    path,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: () => {
      server.close();
    },
  };
}

after(() => {
  for (const server of servers) server.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 轮询谓词直到成立（真实定时器；判稳用）。 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadlineAt) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("HerdrClient: socket 等待超时经 clock 排期，两档都到点后无残留", async () => {
  const server = silentServer();
  await server.listen();
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx();
  const client = new HerdrClient({
    paneId: "p1",
    socketPath: server.path,
    source: "dsh",
    agent: "dsh",
    attemptTimeoutMs: 100,
    deadline: createDeadline(manual, ctx),
  });

  const sent = client.reportState("idle");
  await waitUntil(() => manual.pending >= 1);
  manual.advance(100); // 首档超时 → 立即补发第二档（1500ms）
  await waitUntil(() => manual.pending >= 1);
  manual.advance(1_500); // 第二档也超时
  await sent;

  assert.equal(manual.pending, 0, "两档都结束后无残留排期");
  server.close();
});
