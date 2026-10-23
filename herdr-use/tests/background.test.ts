import assert from "node:assert/strict";
import test from "node:test";

import {
  createBackgroundSession,
  DEFAULT_BACKGROUND_POLL_INTERVAL_MS,
  DEFAULT_BACKGROUND_START_TIMEOUT_MS,
} from "../src/background.ts";
import type { BackgroundSessionProbe } from "../src/background.ts";
import { okEnvelope, fakeRunner } from "./helpers.ts";

/** 依次返回给定探测结果（用尽后重复最后一个）。 */
function scriptedProbe(
  results: Array<BackgroundSessionProbe | Error>,
): { probe: () => Promise<BackgroundSessionProbe>; calls: () => number } {
  let index = 0;
  return {
    probe: async () => {
      const item =
        results[Math.min(index, results.length - 1)] ?? { running: false };
      index += 1;
      if (item instanceof Error) throw item;
      return item;
    },
    calls: () => index,
  };
}

const fast = { sleep: async () => undefined, startTimeoutMs: 50, pollIntervalMs: 10 };

test("会话不在：拉起一次并轮询到 running；之后缓存不再探测", async () => {
  const scripted = scriptedProbe([
    { running: false },
    { running: false },
    { running: true },
  ]);
  let starts = 0;
  const session = createBackgroundSession({
    binPath: "/bin/herdr",
    runner: fakeRunner(),
    timeoutMs: 1000,
    probe: scripted.probe,
    start: () => {
      starts += 1;
    },
    ...fast,
  });
  const first = await session.ensure();
  assert.deepEqual(first, { ok: true, started: true });
  assert.equal(starts, 1);

  const probesAfterFirst = scripted.calls();
  const second = await session.ensure();
  assert.deepEqual(second, { ok: true, started: false });
  assert.equal(scripted.calls(), probesAfterFirst);
  assert.equal(starts, 1);
});

test("会话已在：不拉起", async () => {
  const scripted = scriptedProbe([{ running: true }]);
  let starts = 0;
  const session = createBackgroundSession({
    binPath: "/bin/herdr",
    runner: fakeRunner(),
    timeoutMs: 1000,
    probe: scripted.probe,
    start: () => {
      starts += 1;
    },
    ...fast,
  });
  const result = await session.ensure();
  assert.deepEqual(result, { ok: true, started: false });
  assert.equal(starts, 0);
});

test("并发 ensure 只拉起一次（单飞）", async () => {
  let running = false;
  let starts = 0;
  let probes = 0;
  const session = createBackgroundSession({
    binPath: "/bin/herdr",
    runner: fakeRunner(),
    timeoutMs: 1000,
    probe: async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { running };
    },
    start: () => {
      starts += 1;
      running = true;
    },
    ...fast,
  });
  const [a, b, c] = await Promise.all([
    session.ensure(),
    session.ensure(),
    session.ensure(),
  ]);
  assert.equal(starts, 1);
  for (const result of [a, b, c]) assert.equal(result.ok, true);
  assert.ok(probes >= 2);
});

test("拉起超时：返回稳定失败与 herdr 原文；invalidate 后可再试", async () => {
  let running = false;
  const scripted = scriptedProbe([
    { running: false, detail: "session dshbg status=stopped" },
    { running: false, detail: "session dshbg status=stopped" },
    { running: false, detail: "session dshbg status=stopped" },
    { running: false, detail: "session dshbg status=stopped" },
    { running: false, detail: "session dshbg status=stopped" },
    { running: false, detail: "session dshbg status=stopped" },
    { running: false, detail: "session dshbg status=stopped" },
  ]);
  const session = createBackgroundSession({
    binPath: "/bin/herdr",
    runner: fakeRunner(),
    timeoutMs: 1000,
    probe: async () => {
      const result = await scripted.probe();
      return running ? { running: true } : result;
    },
    start: () => undefined,
    ...fast,
  });
  const failed = await session.ensure();
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.match(failed.message, /未就绪/);
  assert.match(failed.message, /status=stopped/);

  running = true;
  session.invalidate();
  const retried = await session.ensure();
  assert.deepEqual(retried, { ok: true, started: false });
});

test("拉起后 server 起不来：失败信息带探测原文", async () => {
  const scripted = scriptedProbe([{ running: false, detail: "boom" }]);
  const session = createBackgroundSession({
    binPath: "/bin/herdr",
    runner: fakeRunner(),
    timeoutMs: 1000,
    probe: scripted.probe,
    start: () => undefined,
    ...fast,
  });
  const result = await session.ensure();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /boom/);
});

test("spawn 抛错：返回失败，不静默退化", async () => {
  const session = createBackgroundSession({
    binPath: "/bin/herdr",
    runner: fakeRunner(),
    timeoutMs: 1000,
    probe: async () => ({ running: false }),
    start: () => {
      throw new Error("spawn 失败");
    },
    ...fast,
  });
  const result = await session.ensure();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /拉起后台 herdr session 失败/);
});

test("缺省探测：解析 session list JSON（信封形态）", async () => {
  const runner = fakeRunner((args) => {
    assert.deepEqual(args, ["session", "list", "--json"]);
    return okEnvelope({
      sessions: [
        { name: "default", running: true },
        { name: "dshbg", running: true },
      ],
    });
  });
  const session = createBackgroundSession({
    binPath: "/bin/herdr",
    runner,
    timeoutMs: 1000,
    start: () => {
      throw new Error("不应拉起");
    },
  });
  assert.deepEqual(await session.ensure(), { ok: true, started: false });
});

test("缺省探测：也接受裸数组与时 status 字段", async () => {
  const runner = fakeRunner(() => ({
    stdout: JSON.stringify([
      { name: "default", status: "running" },
      { name: "dshbg", status: "running" },
    ]),
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }));
  const session = createBackgroundSession({
    binPath: "/bin/herdr",
    runner,
    timeoutMs: 1000,
    start: () => {
      throw new Error("不应拉起");
    },
  });
  assert.deepEqual(await session.ensure(), { ok: true, started: false });
});

test("缺省探测：命令失败时说明里带 herdr 原文", async () => {
  const runner = fakeRunner(() => ({
    stdout: "",
    stderr: "server_not_running: no server",
    exitCode: 1,
    timedOut: false,
  }));
  const session = createBackgroundSession({
    binPath: "/bin/herdr",
    runner,
    timeoutMs: 1000,
    start: () => undefined,
    startTimeoutMs: 20,
    pollIntervalMs: 10,
    sleep: async () => undefined,
  });
  const result = await session.ensure();
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /server_not_running|no server/);
});

test("缺省常量：10s 与 250ms", () => {
  assert.equal(DEFAULT_BACKGROUND_START_TIMEOUT_MS, 10_000);
  assert.equal(DEFAULT_BACKGROUND_POLL_INTERVAL_MS, 250);
});
