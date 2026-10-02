/**
 * 控制器 + 工具面集成测试：MetricLoopController 注入 measure/clock，
 * 经 apply(假 ctx) 验证真实工具定义的分发与防御降级。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  apply,
  createController,
  loadState,
  MetricLoopController,
  provide,
  saveState,
  statePathFor,
  STATE_VERSION,
  type MetricLoopService,
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

/** 工具输出面（render 全函数契约用）。 */
interface RenderFace {
  name?: unknown;
  output: {
    render(args: unknown, value: unknown): { type?: string; text?: unknown }[];
  };
}

test("工具 render 全函数：text 恒为 string（undefined / 对象 / 字符串 / 不可序列化）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-render-"));
  const registered: RenderFace[] = [];
  try {
    await apply(
      {
        tools: {
          register: (def: unknown) => void registered.push(def as RenderFace),
        },
      },
      { stateDir: dir },
    );
    assert.equal(registered.length, 1, "metric_loop 单工具注册");
    assert.equal(registered[0]?.name, "metric_loop");
    const render = registered[0]!.output.render;

    // 裸 JSON.stringify(undefined, null, 2) === undefined：旧实现下此断言必失败
    const undef = render({}, undefined);
    assert.equal(typeof undef[0]?.text, "string");
    assert.equal(undef[0]?.text, "undefined");

    // 对象走 JSON 分支
    assert.match(String(render({}, { a: 1 })[0]?.text), /"a": 1/);

    // 字符串原样返回（不二次编码）
    assert.equal(render({}, "s")[0]?.text, "s");

    // 循环引用：JSON.stringify 抛错 → String 兜底
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    assert.equal(render({}, circular)[0]?.text, "[object Object]");
  } finally {
    cleanup(dir);
  }
});

test("list()：无循环返回空数组；活动/已停循环均入清单（只读子集、updatedAt 倒序）", async () => {
  const h = makeHarness();
  try {
    // 目录存在但无循环 → 空
    assert.deepEqual(h.controller.list(), []);

    // 一个 running + 一个已停（plateau）
    h.values.push(5, 5, 5, 9);
    await h.controller.start({
      id: "l-running",
      measureCmd: "echo 5",
      direction: "min",
      window: 2,
      cadenceSec: 30,
    }); // r1，仅 1 轮不停止 → running
    const running = h.controller.list();
    assert.equal(running.length, 1);
    assert.equal(running[0]?.id, "l-running");
    assert.equal(running[0]?.status, "running");
    assert.equal(running[0]?.rounds, 1);
    assert.equal(running[0]?.best, 5);
    assert.equal(running[0]?.measureCmd, "echo 5");
    assert.equal(running[0]?.direction, "min");
    assert.equal(running[0]?.cadenceSec, 30);

    h.setT(2_000);
    await h.controller.tick("l-running", "explicit"); // r2 无改进 streak=1
    h.setT(3_000);
    const stopped = await h.controller.tick("l-running", "explicit"); // plateau 停
    assert.equal(stopped.state.status, "stopped");
    assert.equal(stopped.state.stopReason, "plateau");

    // 再启动一个 metricless 循环（updatedAt 最新）
    await h.controller.start({ id: "l-metricless", maxRounds: 3 });
    const all = h.controller.list();
    assert.equal(all.length, 2);
    // 倒序：最新更新的 metricless 在前
    assert.equal(all[0]?.id, "l-metricless");
    assert.equal(all[1]?.id, "l-running");
    const stoppedEntry = all.find((e) => e.id === "l-running");
    assert.equal(stoppedEntry?.status, "stopped");
    assert.equal(stoppedEntry?.stopReason, "plateau");
    assert.equal(stoppedEntry?.rounds, 3);
    assert.equal(stoppedEntry?.streak, 2);
    assert.equal(stoppedEntry?.measureCmd, "echo 5");
    const metricless = all.find((e) => e.id === "l-metricless");
    assert.equal(metricless?.measureCmd, null);
    assert.equal(metricless?.best, null);
  } finally {
    cleanup(h.dir);
  }
});

test("list()：状态目录缺失返回空数组；损坏/版本不符的单文件被跳过", async () => {
  const h = makeHarness();
  try {
    await h.controller.start({ id: "good", measureCmd: "echo 1" });
    assert.equal(h.controller.list().length, 1);

    // 伪造损坏文件与版本不符文件（同前缀）→ 清单不受拖累
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path.join(h.dir, "metric-loop-broken.json"),
      "{not json",
      "utf8",
    );
    writeFileSync(
      path.join(h.dir, "metric-loop-oldver.json"),
      JSON.stringify({ version: 99, state: null }),
      "utf8",
    );
    const list = h.controller.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, "good");
  } finally {
    cleanup(h.dir);
  }
});

test("提供方：metricLoop 服务挂到 ctx（provide + list/status 只读面）", async () => {
  // 插件声明 provide，宿主命令可注入/ctx.get 访问
  assert.deepEqual(provide, ["metricLoop"]);

  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-provide-"));
  const registered: Array<Record<string, unknown>> = [];
  const provided = new Map<string, unknown>();
  const ctx = {
    tools: {
      register: (def: unknown) =>
        registered.push(def as Record<string, unknown>),
    },
    provide: (name: string, value: unknown) => {
      provided.set(name, value);
      return () => {};
    },
  };
  try {
    await apply(ctx, { stateDir: dir });
    assert.equal(registered.length, 1);
    assert.ok(provided.has("metricLoop"), "metricLoop 应被提供");

    const svc = provided.get("metricLoop") as MetricLoopService;
    assert.equal(typeof svc?.list, "function");
    assert.equal(typeof svc?.status, "function");
    assert.deepEqual(svc.list(), []);

    // 经另一控制器（或后续宿主命令同一目录）写状态后，服务可见
    const writer = createController({ stateDir: dir });
    await writer.start({ id: "svc1", measureCmd: "echo 7", window: 2 });
    assert.equal(svc.status("svc1")?.status, "running");
    const items = svc.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, "svc1");
    assert.equal(items[0]?.rounds, 1);
  } finally {
    cleanup(dir);
  }
});

test("apply(无 provide 的 ctx)：不抛错、仍注册工具", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-noprovide-"));
  const registered: Array<Record<string, unknown>> = [];
  try {
    await apply(
      {
        tools: {
          register: (d: unknown) =>
            void registered.push(d as Record<string, unknown>),
        },
      },
      { stateDir: dir },
    );
    assert.equal(registered.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("render 形参顺序哨兵：渲染的必须是第二参（变异回单形参必失败）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-render-order-"));
  const registered: RenderFace[] = [];
  try {
    await apply(
      {
        tools: {
          register: (def: unknown) => void registered.push(def as RenderFace),
        },
      },
      { stateDir: dir },
    );
    assert.equal(
      registered.length,
      1,
      "metric_loop 单工具注册（探针须覆盖全部）",
    );
    // 本包 render 是 jsonText(value)：整个 value 进 JSON 文本，任意字段都会回显 →
    // 最小结构即可。哨兵放 **value 位**；args 用同形结构、标记放同一可回显字段，
    // 形参写反 / 少参（单形参实现）时渲染器拿到的是 args → ②③ 双失败。
    const argsShaped = { marker: "ARGS_MARKER_NOT_RENDERED" };
    const valueShaped = { marker: "SENTINEL_VALUE_MARKER" };
    for (const tool of registered) {
      const label = String(tool.name ?? "metric_loop");
      const text = tool.output.render(argsShaped, valueShaped)[0]?.text;
      assert.equal(
        typeof text,
        "string",
        `${label}：blocks[0].text 必须是 string`,
      );
      assert.ok(
        String(text).includes("SENTINEL_VALUE_MARKER"),
        `${label}：渲染的必须是第二参（value）`,
      );
      assert.ok(
        !String(text).includes("ARGS_MARKER_NOT_RENDERED"),
        `${label}：第一参（args）不该被当成 value 渲染`,
      );
    }
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 状态文件命令复查：tick 执行的 measureCmd 取自状态文件、不在工具入参里，
// 故在测量前补一道复查（security-guard 服务面；追踪文档
// docs/implementation/2026-10-02-metric-loop-state-cmd-check.md）。
// ---------------------------------------------------------------------------

/** 命中 sudo 规则的无害命令文本（拼接构造：仓库内不出现真实危险命令字面量）。 */
function riskyCommand(): string {
  return `echo 0 # su${"do"} --version`;
}

/** 假复查器（与 guard 服务面同契约）：命中危险文本 → 回执；记录每次调用的命令与来源。 */
function makeFakeGuard(): {
  checker: (command: string, source?: string) => string | null;
  calls: { command: string; source?: string }[];
} {
  const calls: { command: string; source?: string }[] = [];
  const marker = `su${"do"}`;
  return {
    calls,
    checker: (command, source) => {
      calls.push({ command, source });
      return command.includes(marker)
        ? "[security-guard] 已拦截：命令命中黑名单规则「sudo」。"
        : null;
    },
  };
}

test("tick 前复查：状态文件里的危险命令被执行前拦下（不测量、不落盘、带来源标注）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-guard-"));
  try {
    let measureCalls = 0;
    const { checker, calls } = makeFakeGuard();
    const controller = new MetricLoopController({
      stateDir: dir,
      commandGuard: checker,
      measure: async () => {
        measureCalls += 1;
        return { value: 1, error: null };
      },
    });
    // ① start：命令来自入参（guard 的 pre-execute 已覆盖），引擎内复查为第二道 → 放行
    await controller.start({ id: "g1", measureCmd: "echo 1" });
    assert.equal(measureCalls, 1);

    // ② 模拟「命令先落地状态文件、再 tick」的旁路：手改状态文件里的 measureCmd
    const loaded = loadState(dir, "g1");
    assert.ok(loaded !== null);
    loaded.spec.measureCmd = riskyCommand();
    saveState(dir, loaded);
    const before = loadState(dir, "g1");
    assert.ok(before !== null);

    // ③ tick：执行前被拦（抛错 → 工具层转 ok:false 结构化错误）
    await assert.rejects(
      () => controller.tick("g1", "explicit"),
      /状态文件中的测量命令被 security-guard 拦截/,
    );
    assert.equal(measureCalls, 1, "被拦的命令不得进入测量");
    assert.equal(calls.at(-1)?.command, riskyCommand());
    assert.equal(calls.at(-1)?.source, "metric_loop{tick} id=g1");

    // ④ 状态文件原样：轮次 / 更新时间 / 命令文本都不变（本轮未消耗）
    const after = loadState(dir, "g1");
    assert.ok(after !== null);
    assert.equal(after.rounds, before.rounds);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.spec.measureCmd, riskyCommand());

    // 复查逐轮记录：start 一次、被拦的 tick 一次，各带来源标注
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.source, "metric_loop{start}");
    assert.equal(calls[0]?.command, "echo 1");

    // ⑤ 改回普通命令 → tick 恢复正常推进（拦一次不把循环停死）
    const fixed = loadState(dir, "g1");
    assert.ok(fixed !== null);
    fixed.spec.measureCmd = "echo 2";
    saveState(dir, fixed);
    const ticked = await controller.tick("g1", "explicit");
    assert.equal(ticked.round?.round, before.rounds + 1);
    assert.equal(measureCalls, 2);
  } finally {
    cleanup(dir);
  }
});

test("tick 前复查：未配置（无 guard 服务）不拦；状态文件缺失/形状异常不崩且行为明确", async () => {
  // ① 未配置复查器：危险文本照常进入测量（fail-open，与既有版本一致）
  const h = makeHarness();
  try {
    h.values.push(5, 3);
    await h.controller.start({ id: "n1", measureCmd: riskyCommand() });
    const ticked = await h.controller.tick("n1", "explicit");
    assert.equal(ticked.round?.round, 2);
    assert.equal(h.count(), 2);
  } finally {
    cleanup(h.dir);
  }

  // ② 形状异常：spec 非对象 / measureCmd 非 string → 清晰错误（不测量、不复查、不崩）
  const shapeDir = mkdtempSync(path.join(tmpdir(), "metric-loop-shape-"));
  try {
    const { checker, calls } = makeFakeGuard();
    const controller = new MetricLoopController({
      stateDir: shapeDir,
      commandGuard: checker,
      measure: async () => {
        throw new Error("形状异常时不该测量");
      },
    });
    const base = {
      id: "shape",
      rounds: 0,
      best: null,
      streak: 0,
      tokensUsed: 0,
      status: "running",
      stopReason: null,
      history: [],
    };
    writeFileSync(
      statePathFor(shapeDir, "bad-spec"),
      JSON.stringify({
        version: STATE_VERSION,
        state: { ...base, id: "bad-spec", spec: 42 },
      }),
    );
    await assert.rejects(
      () => controller.tick("bad-spec", "explicit"),
      /spec 段形状非法/,
    );
    writeFileSync(
      statePathFor(shapeDir, "bad-cmd"),
      JSON.stringify({
        version: STATE_VERSION,
        state: { ...base, id: "bad-cmd", spec: { measureCmd: 42 } },
      }),
    );
    await assert.rejects(
      () => controller.tick("bad-cmd", "explicit"),
      /spec\.measureCmd 形状非法/,
    );
    // ③ 状态文件缺失：既有语义（报「不存在」，不崩）
    await assert.rejects(() => controller.tick("ghost", "explicit"), /不存在/);
    // 形状异常与缺失一律不进复查（更不执行命令）
    assert.equal(calls.length, 0);
  } finally {
    cleanup(shapeDir);
  }
});

test("apply 接线：ctx.get('guard').inspectCommand 在 tick 生效（拦危险 / 放行普通）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "metric-loop-guard-apply-"));
  const registered: Array<Record<string, unknown>> = [];
  const calls: { command: string; source?: string }[] = [];
  const marker = `su${"do"}`;
  const ctx = {
    tools: {
      register: (def: unknown) =>
        void registered.push(def as Record<string, unknown>),
    },
    provide: () => {},
    // 假 guard 服务面（与 security-guard 的 GuardService 同契约）
    get: (name: string): unknown =>
      name === "guard"
        ? {
            inspectCommand: (
              command: string,
              source?: string,
            ): string | null => {
              calls.push({ command, source });
              return command.includes(marker)
                ? "[security-guard] 已拦截：命令命中黑名单规则「sudo」。（放行方式：allowPatterns）"
                : null;
            },
          }
        : undefined,
  };
  try {
    await apply(ctx, { stateDir: dir });
    const def = registered[0];
    assert.ok(def !== undefined);
    const execute = def["execute"] as (
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    // ① start：入参命令经引擎内复查放行，真实 /bin/sh -c 执行 echo 3
    const started = await execute({
      action: "start",
      id: "ap",
      measureCmd: "echo 3",
    });
    assert.equal(started.ok, true);
    assert.equal((started.round as { value?: number } | null)?.value, 3);

    // ② 手改状态文件为危险命令 → tick 被拦，回执透出在结构化错误里
    const loaded = loadState(dir, "ap");
    assert.ok(loaded !== null);
    loaded.spec.measureCmd = riskyCommand();
    saveState(dir, loaded);
    const blocked = await execute({
      action: "tick",
      id: "ap",
      wake: "explicit",
    });
    assert.equal(blocked.ok, false);
    assert.match(
      String(blocked.error),
      /状态文件中的测量命令被 security-guard 拦截/,
    );
    assert.match(String(blocked.error), /「sudo」/);
    assert.equal(calls.at(-1)?.command, riskyCommand());
    assert.equal(calls.at(-1)?.source, "metric_loop{tick} id=ap");
    // start 那次也走同一复查缝（来源标注区分 start / tick）
    assert.equal(calls[0]?.source, "metric_loop{start}");
    assert.equal(calls[0]?.command, "echo 3");

    // ③ 改回普通命令 → tick 恢复（真实执行，轮次推进）
    const fixed = loadState(dir, "ap");
    assert.ok(fixed !== null);
    fixed.spec.measureCmd = "echo 4";
    saveState(dir, fixed);
    const ok = await execute({ action: "tick", id: "ap", wake: "explicit" });
    assert.equal(ok.ok, true);
    assert.equal((ok.round as { value?: number } | null)?.value, 4);
  } finally {
    cleanup(dir);
  }
});
