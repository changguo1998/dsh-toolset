// tests/clock.test.ts — 定时器统一面接线（假时钟 / 卸载撤销 / 服务缺失降级）
//
// 跨包 import 真实 `ManualClock`（clock-base 包）作假时钟；本文件不在 tsconfig 的 include 内
// （`rootDir` 限制，见 tsconfig.json 的 exclude），测试运行时经 node 类型擦除直接加载。
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createDefaultRunner } from "../src/cli.ts";
import { createHerdrPlugin } from "../src/main.ts";
import type { HerdrUseDeps } from "../src/main.ts";
import {
  createNetConnector,
  createTimersClock,
  realClock,
} from "../src/socket.ts";
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

/** 极简 cordis ctx：只实现本包消费的 `get` / `effect` / `on` / `tools`。 */
function fakeCtx(services: Record<string, unknown> = {}): {
  ctx: {
    get(name: string): unknown;
    effect(fn: () => () => void): () => void;
    on(): () => void;
    tools: { register(def: unknown): void };
  };
  defs: unknown[];
  unload(): void;
} {
  const disposers: Array<() => unknown> = [];
  const defs: unknown[] = [];
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
    tools: {
      register: (def: unknown): void => {
        defs.push(def);
      },
    },
  };
  return {
    ctx,
    defs,
    unload(): void {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
  };
}

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-use-clock-"));
  tempDirs.push(dir);
  return dir;
}

/** 造一个内容自定、可执行的 shell 脚本（子进程执行面测试用）。 */
function makeScript(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
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
  assert.equal(warnings.length, 1);
  assert.equal(typeof timers.scoped.now(), "number");
});

test("createDeadline: 到点触发 timeout；卸载触发 unload 且无残留", () => {
  const manual = new ManualClock(0);
  const { ctx, unload } = fakeCtx();
  const deadline = createDeadline(manual, ctx);
  const fired: string[] = [];

  deadline(100, (reason) => fired.push(reason));
  assert.equal(manual.pending, 1);
  manual.advance(100);
  assert.deepEqual(fired, ["timeout"]);
  assert.equal(manual.pending, 0);

  deadline(10_000, (reason) => fired.push(reason));
  assert.equal(manual.pending, 1);
  unload();
  assert.deepEqual(fired, ["timeout", "unload"]);
  assert.equal(manual.pending, 0);
});

test("createTimersClock: now / sleep 与假时钟同源", async () => {
  const manual = new ManualClock(1_000);
  const clock = createTimersClock(manual);
  assert.equal(clock.now(), 1_000);
  let slept = false;
  const sleeping = clock.sleep(50).then(() => {
    slept = true;
  });
  assert.equal(slept, false);
  manual.advance(50);
  await sleeping;
  assert.equal(slept, true);
  assert.equal(clock.now(), 1_050);
});

test("createDefaultRunner: 超时经 clock 排期，到点 SIGKILL 且无残留", async () => {
  const dir = tempDir();
  const bin = makeScript(dir, "hang", "exec sleep 5");
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx();
  const runner = createDefaultRunner(bin, createDeadline(manual, ctx));

  const result = runner.run(["pane", "read"], 60);
  await waitUntil(() => manual.pending >= 1);
  manual.advance(60);
  const outcome = await result;

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.exitCode, -1);
  assert.match(outcome.stderr, /timeout: 60ms/);
  assert.equal(manual.pending, 0, "收尾后无残留排期");
});

test("createNetConnector: 读超时经 clock 排期，到点返回 timeout 且无残留", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "herdr.sock");
  const server = createServer(() => {
    // 接了连接但永不写响应
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx();
  try {
    const response = createNetConnector(createDeadline(manual, ctx)).request(
      socketPath,
      '{"id":"req"}\n',
      80,
    );
    await waitUntil(() => manual.pending >= 1);
    manual.advance(80);
    const value = await response;
    assert.equal(value.kind, "timeout");
    assert.equal(manual.pending, 0);
  } finally {
    server.close();
  }
});

test("插件装配: clock 缺失时回落并只告警一次", () => {
  const { ctx, defs } = fakeCtx();
  const warnings: string[] = [];
  const deps: HerdrUseDeps = {
    readHandshake: () => ({
      binPath: "/usr/local/bin/herdr",
      socketPath: "/tmp/herdr-test.sock",
    }),
    probe: () => ({ ok: true, socketPath: "/tmp/herdr-test.sock" }),
    runner: {
      run: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
    },
    reader: {
      readPane: async () => ({
        ok: true,
        read: { text: "", truncated: false },
      }),
    },
    env: {},
    warn: (message) => warnings.push(message),
  };
  const plugin = createHerdrPlugin(ctx, {}, deps);
  assert.notEqual(plugin, undefined);
  assert.equal(defs.length, 10, "工具照常注册");
  assert.equal(warnings.length, 1, "每个插件实例只告警一次");
  assert.match(warnings[0] ?? "", /回落进程内定时器/);
  plugin?.dispose();
});

test("插件装配: clock 可用时不告警，stub 时钟仍可判稳", async () => {
  const manual = new ManualClock(0);
  const { ctx } = fakeCtx({ clock: fakeClock(manual) });
  const warnings: string[] = [];
  const plugin = createHerdrPlugin(
    ctx,
    {},
    {
      readHandshake: () => ({
        binPath: "/usr/local/bin/herdr",
        socketPath: "/tmp/herdr-test.sock",
      }),
      probe: () => ({ ok: true, socketPath: "/tmp/herdr-test.sock" }),
      runner: {
        run: async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        }),
      },
      reader: {
        readPane: async () => ({
          ok: true,
          read: { text: "", truncated: false },
        }),
      },
      env: {},
      warn: (message) => warnings.push(message),
    },
  );
  assert.notEqual(plugin, undefined);
  assert.deepEqual(warnings, []);
  assert.notEqual(plugin?.deps.clock, realClock, "判稳时钟应来自统一面");
  plugin?.dispose();
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
