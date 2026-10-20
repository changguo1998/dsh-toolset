/**
 * timer 适配单测：`hostTimer()` 把宿主 `timeout(cb, delay)` 适配成内部 `schedule`,
 * 以及装配层对宿主形状的读取 / 形状不符回落的回归（事故：宿主 timer 无 `schedule`,
 * 真机 arm() 抛 `timer.schedule is not a function`）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { createDaemonRuntime } from "../src/main.ts";
import { hostTimer, type HostTimerLike } from "../src/scheduler.ts";
import type { AgentLike } from "../src/types.ts";
import { HostTimer, NOW } from "./harness.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "background-daemon-timer-"));
  dirs.push(dir);
  return dir;
}

test("hostTimer：按宿主 timeout(cb, delay) 适配, disposer 透传", () => {
  const calls: { callback: () => void; delay: number }[] = [];
  const disposed: number[] = [];
  const service: HostTimerLike = {
    timeout(callback, delayMs) {
      const index = calls.push({ callback, delay: delayMs }) - 1;
      return () => disposed.push(index);
    },
  };
  const timer = hostTimer(service);
  let fired = 0;
  const dispose = timer.schedule(1500, () => {
    fired += 1;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.delay, 1500);
  calls[0]?.callback();
  assert.equal(fired, 1);
  dispose();
  assert.deepEqual(disposed, [0]);
});

test("装配回归：宿主形状 timer 建任务 + arm 不抛, 到点投递成功", async () => {
  const dir = tempDir();
  const clock = { value: NOW };
  const agent: AgentLike = {
    session: { id: "sess-1" },
    followup: () => {},
  };
  const hostTimerFake = new HostTimer();
  const runtime = await createDaemonRuntime(
    {
      get: (serviceName: string) =>
        serviceName === "agents"
          ? { get: () => agent }
          : serviceName === "sessions"
            ? { flush: async () => true }
            : serviceName === "timer"
              ? hostTimerFake
              : undefined,
    },
    {
      storePath: path.join(dir, "tasks.json"),
      journalPath: path.join(dir, "journal.jsonl"),
    },
    () => clock.value,
    () => {},
  );
  runtime.scheduler.start();
  const task = runtime.store.create({
    mode: "deliver",
    sessionId: "sess-1",
    payload: "到点",
    selector: { kind: "after_seconds", seconds: 30 },
  });
  // 事故现场：宿主形状 timer 上没有 schedule, 这里曾抛 TypeError
  assert.doesNotThrow(() => runtime.scheduler.arm());
  assert.equal(hostTimerFake.pendingDelay, 30_000);
  clock.value += 30_000;
  await hostTimerFake.fire();
  await runtime.scheduler.settle();
  assert.equal(runtime.store.get(task.id)?.lastOutcome, "delivered");
  await runtime.dispose();
});

test("形状不符回落：宿主 timer 对象在场但缺 timeout → 告警并改用进程内定时器", async () => {
  const dir = tempDir();
  const warnings: string[] = [];
  const runtime = await createDaemonRuntime(
    {
      get: (serviceName: string) =>
        serviceName === "agents"
          ? { get: () => undefined }
          : serviceName === "sessions"
            ? { flush: async () => true }
            : serviceName === "timer"
              ? ({ setTimeout: () => () => {} } as unknown)
              : undefined,
    },
    {
      storePath: path.join(dir, "tasks.json"),
      journalPath: path.join(dir, "journal.jsonl"),
    },
    Date.now,
    (message) => warnings.push(message),
  );
  runtime.scheduler.start();
  runtime.store.create({
    mode: "deliver",
    sessionId: "sess-1",
    payload: "到点",
    selector: { kind: "after_seconds", seconds: 30 },
  });
  assert.doesNotThrow(() => runtime.scheduler.arm());
  assert.ok(warnings.some((w) => w.includes("形状不符")));
  await runtime.dispose();
});
