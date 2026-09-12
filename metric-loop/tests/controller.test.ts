/**
 * 控制器 + 工具面集成测试：MetricLoopController 注入 measure/clock，
 * 经 apply(假 ctx) 验证真实工具定义的分发与防御降级。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  apply,
  createController,
  type MetricLoopController,
} from "../src/index.ts";

interface Harness {
  dir: string;
  controller: MetricLoopController;
  t: () => number;
  setT: (v: number) => void;
  values: number[];
  count: () => number;
}

/** 造一个可控时钟 + 序列测量的控制器。 */
function makeHarness(): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-ctl-"));
  let nowMs = 1_000;
  const values: number[] = [];
  let measureCalls = 0;
  const controller = createController({
    stateDir: dir,
  });
  // 注入时钟与测量（绕过真实 measure 的 /bin/sh，保证确定性）
  (controller as unknown as { now: () => number }).now = () => nowMs;
  (
    controller as unknown as {
      measure: (
        cmd: string,
      ) => Promise<{ value: number | null; error: string | null }>;
    }
  ).measure = async () => {
    const v = values[measureCalls];
    measureCalls += 1;
    return v === undefined
      ? { value: null, error: "no more values" }
      : { value: v, error: null };
  };
  return {
    dir,
    controller,
    t: () => nowMs,
    setT: (v: number) => {
      nowMs = v;
    },
    values,
    count: () => measureCalls,
  };
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

test("start 跑第一轮并落盘；tick（explicit）继续推进", async () => {
  const h = makeHarness();
  try {
    h.values.push(10, 8);
    const started = await h.controller.start({
      id: "c1",
      measureCmd: "x",
      direction: "min",
      window: 5,
    });
    assert.equal(started.round?.round, 1);
    assert.equal(started.state.best, 10);
    assert.equal(started.state.status, "running");

    h.setT(2_000);
    const ticked = await h.controller.tick("c1", "explicit");
    assert.equal(ticked.round?.round, 2);
    assert.equal(ticked.state.best, 8); // 8 < 10 改进
    assert.equal(h.count(), 2);
  } finally {
    cleanup(h.dir);
  }
});

test("plateau 经控制器收敛：常量指标 + window=2 → 第 3 轮停", async () => {
  const h = makeHarness();
  try {
    h.values.push(7, 7, 7);
    let r = await h.controller.start({
      id: "p1",
      measureCmd: "x",
      direction: "min",
      window: 2,
    });
    assert.equal(r.state.status, "running"); // r1 基线
    h.setT(2_000);
    r = await h.controller.tick("p1", "explicit");
    assert.equal(r.state.status, "running"); // r2 无改进 streak=1
    h.setT(3_000);
    r = await h.controller.tick("p1", "explicit");
    assert.equal(r.state.status, "stopped"); // r3 无改进 streak=2 → plateau
    assert.equal(r.state.stopReason, "plateau");
    assert.equal(r.state.rounds, 3);
    assert.equal(r.state.best, 7);
  } finally {
    cleanup(h.dir);
  }
});

test("cadence：auto 唤醒在间隔内被节流，explicit 放行", async () => {
  const h = makeHarness();
  try {
    h.values.push(5, 5, 5);
    const started = await h.controller.start({
      id: "cd",
      measureCmd: "x",
      direction: "min",
      window: 10,
      cadenceSec: 60,
    });
    assert.equal(started.round?.round, 1);
    assert.equal(started.state.lastSuccessAt, 1_000);

    // 20s 后的 auto 唤醒 → deferred，不消耗测量
    h.setT(20_000);
    const deferred = await h.controller.tick("cd", "auto");
    assert.equal(deferred.deferred, true);
    assert.equal(deferred.round, null);
    assert.equal(h.count(), 1); // 未新增测量
    assert.equal(deferred.state.rounds, 1);

    // explicit 紧急唤醒不受限 → 跑第 2 轮
    const urgent = await h.controller.tick("cd", "explicit");
    assert.equal(urgent.deferred, false);
    assert.equal(urgent.round?.round, 2);
    assert.equal(h.count(), 2);

    // 超过 cadence（90s > 60s）后 auto 放行
    h.setT(100_000);
    const autoOk = await h.controller.tick("cd", "auto");
    assert.equal(autoOk.deferred, false);
    assert.equal(autoOk.round?.round, 3);
  } finally {
    cleanup(h.dir);
  }
});

test("已停止后 tick 不新增轮、不崩溃；stop 置 manual", async () => {
  const h = makeHarness();
  try {
    h.values.push(1, 1, 1);
    await h.controller.start({
      id: "s1",
      measureCmd: "x",
      direction: "min",
      window: 2,
    });
    h.setT(2_000);
    await h.controller.tick("s1", "explicit");
    h.setT(3_000);
    const stopped = await h.controller.tick("s1", "explicit"); // plateau
    assert.equal(stopped.state.status, "stopped");

    h.setT(4_000);
    const again = await h.controller.tick("s1", "explicit");
    assert.equal(again.round, null);
    assert.equal(again.state.rounds, stopped.state.rounds); // 未新增

    const stoppedState = h.controller.stop("s1");
    assert.equal(stoppedState.stopReason, "plateau"); // 已停保持原原因
  } finally {
    cleanup(h.dir);
  }
});

test("tick 不存在的循环抛错", async () => {
  const h = makeHarness();
  try {
    await assert.rejects(
      () => h.controller.tick("ghost", "explicit"),
      /不存在/,
    );
  } finally {
    cleanup(h.dir);
  }
});

test("apply(带 tools 的假 ctx)：注册 metric_loop，start/status 分发正常", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-apply-"));
  const registered: Array<Record<string, unknown>> = [];
  const ctx = {
    tools: {
      register: (def: unknown) =>
        registered.push(def as Record<string, unknown>),
    },
  };
  try {
    await apply(ctx, { stateDir: dir });
    assert.equal(registered.length, 1);
    const def = registered[0];
    assert.ok(def !== undefined);
    assert.equal(def?.["name"], "metric_loop");

    const execute = def?.["execute"] as (
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    assert.ok(typeof execute === "function");

    const startOut = await execute({
      action: "start",
      id: "ap",
      measureCmd: "echo 3",
      direction: "min",
      window: 2,
    });
    assert.equal(startOut.ok, true);
    assert.equal(startOut.round !== null, true);

    const statusOut = await execute({ action: "status", id: "ap" });
    assert.equal(statusOut.ok, true);
    assert.equal(statusOut.exists, true);

    const unknown = await execute({ action: "bogus" });
    assert.equal(unknown.ok, false);
  } finally {
    cleanup(dir);
  }
});

test("apply(无 tools 的 ctx)：不抛错、静默降级", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-apply2-"));
  try {
    await assert.doesNotReject(() => apply({}, { stateDir: dir }));
    await assert.doesNotReject(() => apply(null));
  } finally {
    cleanup(dir);
  }
});
