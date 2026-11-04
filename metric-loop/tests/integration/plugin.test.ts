/**
 * 集成层用例 (`metric-loop/tests/integration/plugin.test.ts`):
 * 用 `metric-loop/tests/assemble.ts` 的假工具面 / 假事件面 / 假服务面与 `clock-base` 的 `ManualClock`
 * 拼宿主并调用 `apply`, 断言 `metric_loop` 工具注册、`execute` 的 canonical 值、
 * `output.render` 投影、停止 / 时间边界 / 节流路径与服务面接线.
 *
 * 时间一律走假时钟 (`clock` 服务面), 停止与超时路径靠拨表触发, 不依赖真实等待;
 * 状态文件落在每个用例自己的临时目录, 用后统一清理.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { assemble } from "../assemble.ts";
import type { AssembledHost, ToolDefLike } from "../assemble.ts";
import {
  apply,
  inject,
  loadState,
  name,
  provide,
  saveState,
} from "../../src/index.ts";

/** 每个用例一份临时目录, 结束后统一清理. */
const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "metric-loop-it-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** 装配宿主: 缺省假时钟从 1000ms 起, 状态目录为独立临时目录. */
function hostWith(options: Parameters<typeof assemble>[0] = {}): AssembledHost {
  const host = assemble({
    ...options,
    config: { stateDir: stateDir(), ...options.config },
  });
  assert.ok(host.stateDir.length > 0, "集成用例必须落临时目录");
  return host;
}

function toolOf(host: AssembledHost): ToolDefLike {
  return host.tools.require("metric_loop");
}

/** 工具 execute 的返回面 (canonical 值). */
type ToolResult = Record<string, unknown>;

async function run(
  host: AssembledHost,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await toolOf(host).execute(args)) as ToolResult;
}

describe("工具注册与宿主接线", () => {
  it("apply 注册单个 metric_loop, 参数面四动作与缺省值不变", () => {
    const host = hostWith();
    assert.deepEqual(host.tools.names(), ["metric_loop"]);
    const tool = toolOf(host);
    assert.deepEqual(tool.parameters.required, ["action"]);
    const properties = tool.parameters.properties as Record<
      string,
      { enum?: string[]; type?: string }
    >;
    assert.deepEqual(properties.action?.enum, [
      "start",
      "tick",
      "status",
      "stop",
    ]);
    assert.deepEqual(properties.wake?.enum, ["auto", "explicit"]);
    assert.deepEqual(properties.direction?.enum, ["min", "max"]);
    assert.equal(
      (tool.output.schema as { type?: string }).type,
      "object",
      "output.schema 为宿主契约的 object 面",
    );
  });

  it("插件元数据: 名 metric-loop, 注入 tools, 提供 metricLoop", () => {
    assert.equal(name, "metric-loop");
    assert.deepEqual(inject, ["tools"]);
    assert.deepEqual(provide, ["metricLoop"]);
  });

  it("无事件消费者 (零订阅); 服务面出现 clock 与提供的 metricLoop", () => {
    const host = hostWith();
    assert.equal(host.events.listenerCount(), 0);
    assert.deepEqual(host.services.names(), ["clock", "metricLoop"]);
  });

  it("ctx 缺 tools 时降级: 不抛错、不注册、告警一条", async () => {
    const dir = stateDir();
    const chunks: string[] = [];
    const stream = process.stderr as unknown as {
      write: (chunk: string) => boolean;
    };
    const original = stream.write;
    stream.write = (chunk: string): boolean => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await apply({} as Parameters<typeof apply>[0], { stateDir: dir });
    } finally {
      stream.write = original;
    }
    assert.match(chunks.join(""), /ctx\.tools 不可用/);
  });
});

describe("execute 的 canonical 值", () => {
  it("start: 落盘并跑第一轮, 返回完整 TickResult (tool-args 复查范围)", async () => {
    const host = hostWith();
    const result = await run(host, {
      action: "start",
      id: "it1",
      measureCmd: "echo 8",
      direction: "min",
      window: 2,
    });
    assert.deepEqual(result, {
      ok: true,
      deferred: false,
      round: {
        round: 1,
        value: 8,
        improved: true,
        at: 1_000,
        tokensUsed: 0,
      },
      state: {
        id: "it1",
        spec: {
          id: "it1",
          direction: "min",
          window: 2,
          maxRounds: 50,
          measureCmd: "echo 8",
        },
        createdAt: 1_000,
        startedAt: 1_000,
        updatedAt: 1_000,
        rounds: 1,
        best: 8,
        streak: 0,
        tokensUsed: 0,
        lastSuccessAt: 1_000,
        status: "running",
        stopReason: null,
        history: [
          { round: 1, value: 8, improved: true, at: 1_000, tokensUsed: 0 },
        ],
      },
      nextWakeSec: 0,
      schedule: {
        tool: "schedule_create",
        args: {
          title: "[metric-loop] it1",
          after_seconds: 1,
          prompt:
            "[metric-loop] 自动唤醒：调用 metric_loop tick（wake=auto，id=it1）继续指标循环",
        },
      },
      summary:
        "loop it1 运行中：第 1 轮 value=8（改进），共 1/50 轮，best=8，streak 0/2",
      guardScope: "tool-args",
    });
    // 状态文件与返回值一致 (落盘在临时目录)
    assert.deepEqual(loadState(host.stateDir, "it1"), result.state);
  });

  it("start 的 id 缺省 default; 无 measureCmd 时 metricless 只记轮", async () => {
    const host = hostWith();
    const result = await run(host, { action: "start", maxRounds: 3 });
    assert.equal(result.ok, true);
    assert.equal((result.state as { id?: string }).id, "default");
    assert.equal((result.round as { value?: number | null }).value, null);
    assert.equal(
      result.summary,
      "loop default 运行中：第 1 轮 测量失败/无指标（无改进），共 1/3 轮，streak 0/5",
      "metricless 轮按无指标记, 不走 plateau 判定",
    );
  });

  it("tick: auto 被 cadence 节流 (deferred), explicit 紧急唤醒继续推进并累计 token", async () => {
    const host = hostWith();
    await run(host, {
      action: "start",
      id: "cd",
      measureCmd: "printf 4",
      window: 10,
      cadenceSec: 60,
    });

    host.clock.advance(20_000); // 20s < 60s cadence
    const deferred = await run(host, {
      action: "tick",
      id: "cd",
      wake: "auto",
    });
    assert.equal(deferred.ok, true);
    assert.equal(deferred.deferred, true);
    assert.equal(deferred.round, null);
    assert.equal(
      (deferred.state as { rounds?: number }).rounds,
      1,
      "未消耗轮次",
    );
    assert.equal(deferred.nextWakeSec, 40);
    assert.deepEqual(deferred.schedule, {
      tool: "schedule_create",
      args: {
        title: "[metric-loop] cd",
        after_seconds: 40,
        prompt:
          "[metric-loop] 自动唤醒：调用 metric_loop tick（wake=auto，id=cd）继续指标循环",
      },
    });
    assert.equal(
      deferred.summary,
      "loop cd：cadence 未到，本轮跳过（40s 后可自动唤醒）",
    );
    assert.equal(deferred.guardScope, "engine-side");

    host.clock.advance(55_000); // 75s, 已过 cadence
    const ticked = await run(host, {
      action: "tick",
      id: "cd",
      wake: "explicit",
      tokensUsed: 5,
    });
    assert.equal(ticked.deferred, false);
    assert.deepEqual(ticked.round, {
      round: 2,
      value: 4,
      improved: false,
      at: 76_000,
      tokensUsed: 5,
    });
    assert.equal((ticked.state as { tokensUsed?: number }).tokensUsed, 5);
    assert.equal(ticked.nextWakeSec, 60);
    // 未挂 guard 服务: 复查被跳过 → 摘要显式标注 (fail-open 但可见)
    assert.equal(ticked.guardSkipped, true);
    assert.equal(
      ticked.summary,
      "loop cd 运行中：第 2 轮 value=4（无改进），共 2/50 轮，best=4，streak 1/10" +
        "（security-guard 复查不可用，本轮命令未复查即执行：guardSkipped）",
    );
  });

  it("tick: 未调用 start 的 id 转结构化错误, 不抛向宿主", async () => {
    const host = hostWith();
    const result = await run(host, { action: "tick", id: "ghost" });
    assert.deepEqual(result, {
      ok: false,
      error: '循环 "ghost" 不存在（先调用 metric_loop start）',
    });
  });

  it("status / stop: 只读查询、手动停止置 manual, 未知 action 给清单", async () => {
    const host = hostWith();
    const missing = await run(host, { action: "status", id: "nope" });
    assert.deepEqual(missing, { ok: true, exists: false, state: null });

    await run(host, { action: "start", id: "st", measureCmd: "echo 3" });
    const status = await run(host, { action: "status", id: "st" });
    assert.equal(status.exists, true);
    assert.equal((status.state as { rounds?: number }).rounds, 1);

    host.clock.advance(1_000);
    const stopped = await run(host, { action: "stop", id: "st" });
    assert.equal(stopped.ok, true);
    const stoppedState = stopped.state as {
      status?: string;
      stopReason?: string | null;
      updatedAt?: number;
    };
    assert.equal(stoppedState.status, "stopped");
    assert.equal(stoppedState.stopReason, "manual");
    assert.equal(stoppedState.updatedAt, 2_000);

    assert.deepEqual(await run(host, { action: "bogus" }), {
      ok: false,
      error: "未知 action：bogus（start/tick/status/stop）",
    });
  });
});

describe("停止与超时路径 (假时钟拨表, 无真实等待)", () => {
  it("maxRounds 到顶: 本轮执行后停, schedule 置 null、nextWakeSec 0", async () => {
    const host = hostWith();
    const result = await run(host, {
      action: "start",
      id: "mr",
      measureCmd: "echo 2",
      maxRounds: 1,
    });
    assert.equal((result.state as { status?: string }).status, "stopped");
    assert.equal(
      (result.state as { stopReason?: string }).stopReason,
      "maxRounds",
    );
    assert.equal(result.nextWakeSec, 0);
    assert.equal(result.schedule, null);
    assert.equal(
      result.summary,
      "loop mr 已停止（maxRounds）：第 1 轮 value=2（改进），共 1 轮，best=2",
    );
  });

  it("时间边界到点: 轮前检查停止且不消耗本轮 (round null)", async () => {
    const host = hostWith();
    const started = await run(host, {
      action: "start",
      id: "tb",
      measureCmd: "echo 1",
      window: 10,
      timeBoundMs: 5_000,
    });
    assert.equal((started.state as { status?: string }).status, "running");

    host.clock.advance(5_000);
    const timedOut = await run(host, { action: "tick", id: "tb" });
    assert.equal(timedOut.deferred, false);
    assert.equal(timedOut.round, null, "已达时间边界: 本轮未执行");
    assert.equal((timedOut.state as { status?: string }).status, "stopped");
    assert.equal(
      (timedOut.state as { stopReason?: string }).stopReason,
      "time",
    );
    assert.equal((timedOut.state as { rounds?: number }).rounds, 1);
    assert.equal(timedOut.nextWakeSec, 0);
    assert.equal(timedOut.schedule, null);
    assert.equal(
      timedOut.summary,
      "loop tb 已停止（time）：（本轮未执行），共 1 轮，best=1" +
        "（security-guard 复查不可用，本轮命令未复查即执行：guardSkipped）",
    );
  });

  it("已停止的循环再 tick 不新增轮, 结果仍是 stopped", async () => {
    const host = hostWith();
    await run(host, {
      action: "start",
      id: "sg",
      measureCmd: "echo 9",
      maxRounds: 1,
    });
    const again = await run(host, { action: "tick", id: "sg" });
    assert.equal(again.round, null);
    assert.equal((again.state as { rounds?: number }).rounds, 1);
    assert.equal(again.schedule, null);
  });

  it("测量失败 (有命令但无数字): 记无改进, best 不变", async () => {
    const host = hostWith();
    const result = await run(host, {
      action: "start",
      id: "mf",
      measureCmd: "true",
    });
    assert.deepEqual(result.round, {
      round: 1,
      value: null,
      improved: false,
      at: 1_000,
      tokensUsed: 0,
    });
    assert.equal((result.state as { best?: number | null }).best, null);
    assert.equal((result.state as { streak?: number }).streak, 1);
    assert.equal(
      result.summary,
      "loop mf 运行中：第 1 轮 测量失败/无指标（无改进），共 1/50 轮，streak 1/5",
    );
  });
});

describe("output.render 投影", () => {
  it("对象结果投影为缩进 JSON, 字符串原样, undefined 给占位", async () => {
    const host = hostWith();
    const tool = toolOf(host);
    const result = await run(host, {
      action: "start",
      id: "rn",
      measureCmd: "echo 5",
    });
    assert.deepEqual(tool.output.render({}, result), [
      { type: "text", text: JSON.stringify(result, null, 2) },
    ]);
    assert.deepEqual(tool.output.render({}, "已停止"), [
      { type: "text", text: "已停止" },
    ]);
    assert.deepEqual(tool.output.render({}, undefined), [
      { type: "text", text: "undefined" },
    ]);
  });
});

describe("假服务面: metricLoop 查询面与 clock 读钟", () => {
  it("metricLoop 提供 list / status, 与状态文件一致", async () => {
    const host = hostWith();
    const svc = host.services.get("metricLoop") as {
      list(): Array<Record<string, unknown>>;
      status(id: string): Record<string, unknown> | null;
    };
    assert.deepEqual(svc.list(), []);
    await run(host, {
      action: "start",
      id: "sv",
      measureCmd: "echo 6",
      cadenceSec: 30,
    });
    const items = svc.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.["id"], "sv");
    assert.equal(items[0]?.["status"], "running");
    assert.equal(items[0]?.["measureCmd"], "echo 6");
    assert.equal(items[0]?.["cadenceSec"], 30);
    assert.equal(svc.status("sv")?.["rounds"], 1);
    assert.equal(svc.status("missing"), null);
  });

  it("读钟走 ctx.get('clock').now(); clock 缺席时回落 Date.now", async () => {
    const host = hostWith();
    await run(host, { action: "start", id: "ck", measureCmd: "echo 1" });
    assert.equal(loadState(host.stateDir, "ck")?.startedAt, 1_000);

    const before = Date.now();
    const fallback = hostWith({ clock: false });
    const result = await run(fallback, {
      action: "start",
      id: "ck2",
      measureCmd: "echo 1",
    });
    const startedAt = (result.state as { startedAt?: number }).startedAt ?? 0;
    assert.ok(
      startedAt >= before && startedAt <= Date.now(),
      `clock 缺席时应回落到真实时钟, 实际 ${startedAt}`,
    );
  });
});

describe("假服务面: security-guard 命令复查", () => {
  it("start (tool-args) 不复查, tick (engine-side) 复查并透出拦截回执", async () => {
    const calls: Array<{ command: string; source?: string | undefined }> = [];
    const host = hostWith({
      services: {
        guard: {
          inspectCommand: (command: string, source?: string): string | null => {
            calls.push({ command, source });
            return command.includes("BLOCK_ME")
              ? "[security-guard] 已拦截：命中黑名单规则。"
              : null;
          },
        },
      },
    });

    const started = await run(host, {
      action: "start",
      id: "gd",
      measureCmd: "echo 2",
    });
    assert.equal(started.guardScope, "tool-args");
    assert.equal(calls.length, 0, "工具入参侧命令不重复判定 (D2)");

    const ticked = await run(host, { action: "tick", id: "gd" });
    assert.equal(ticked.ok, true);
    assert.deepEqual(calls, [
      { command: "echo 2", source: "metric_loop{tick} id=gd" },
    ]);

    // 模拟「状态文件被改成危险命令」的旁路: 执行前复查拦下, 不测量也不落盘
    const dir = host.stateDir;
    const state = loadState(dir, "gd");
    assert.ok(state !== null);
    state.spec.measureCmd = "echo BLOCK_ME";
    saveState(dir, state);
    const blocked = await run(host, { action: "tick", id: "gd" });
    assert.equal(blocked.ok, false);
    assert.match(
      String(blocked.error),
      /状态文件中的测量命令被 security-guard 拦截/,
    );
    assert.match(String(blocked.error), /命中黑名单规则/);
    assert.equal(loadState(dir, "gd")?.rounds, 2, "被拦的一轮不推进");
  });
});
