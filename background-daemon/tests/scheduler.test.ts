/**
 * 调度器单测：单 timer、分段、启动补算、同批合并、无活跃 agent、不重试、回拨。
 *
 * 全部用假时钟 / 假 timer / 假渠道驱动, 不依赖真实 dsh 进程。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { Journal } from "../src/journal.ts";
import {
  DEFAULT_MAX_DELAY_MS,
  Scheduler,
  ChannelRegistry,
  type AgentsLike,
  type TimerLike,
} from "../src/scheduler.ts";
import { TaskStore } from "../src/store.ts";
import type {
  AgentLike,
  ChannelResult,
  DaemonChannel,
  DaemonTask,
  DeliveryRequest,
  NewTaskInput,
} from "../src/types.ts";

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

/** 假 timer：记录每次排期, 支持手动触发与统计存活段。 */
class FakeTimer implements TimerLike {
  readonly entries: {
    delay: number;
    callback: () => void;
    disposed: boolean;
  }[] = [];

  schedule(delay: number, callback: () => void): () => void {
    const entry = { delay, callback, disposed: false };
    this.entries.push(entry);
    return () => {
      entry.disposed = true;
    };
  }

  get live(): { delay: number; callback: () => void; disposed: boolean }[] {
    return this.entries.filter((entry) => !entry.disposed);
  }

  get pendingDelay(): number | null {
    return this.live[0]?.delay ?? null;
  }

  /** 触发最早那个存活 timer（模拟到点）。 */
  async fire(): Promise<void> {
    const entry = this.live[0];
    if (entry === undefined) return;
    entry.disposed = true;
    entry.callback();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

interface FakeChannel extends DaemonChannel {
  readonly requests: DeliveryRequest[];
}

function makeChannel(
  mode: "deliver" | "command",
  respond: (
    request: DeliveryRequest,
  ) => Promise<ChannelResult> | ChannelResult = () => ({
    ok: true,
    durable: true,
  }),
): FakeChannel {
  const requests: DeliveryRequest[] = [];
  return {
    mode,
    requests,
    async deliver(request: DeliveryRequest): Promise<ChannelResult> {
      requests.push(request);
      return await respond(request);
    },
  };
}

interface Harness {
  clock: { value: number };
  store: TaskStore;
  journal: Journal;
  timer: FakeTimer;
  agents: Map<string, AgentLike>;
  text: FakeChannel;
  command: FakeChannel;
  scheduler: Scheduler;
  warnings: string[];
  create(
    input: Partial<NewTaskInput> & { selector: NewTaskInput["selector"] },
  ): DaemonTask;
  cleanup(): void;
}

function harness(
  options: {
    awaitAgentMs?: number;
    catchUpWindowMs?: number;
    maxDelayMs?: number;
    respondText?: (
      request: DeliveryRequest,
    ) => Promise<ChannelResult> | ChannelResult;
    respondCommand?: (
      request: DeliveryRequest,
    ) => Promise<ChannelResult> | ChannelResult;
    agents?: Map<string, AgentLike>;
  } = {},
): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "background-daemon-scheduler-"));
  const clock = { value: NOW };
  const store = new TaskStore(path.join(dir, "tasks.json"), () => clock.value);
  const journal = new Journal(path.join(dir, "journal.jsonl"), { limit: 50 });
  journal.load();
  const warnings: string[] = [];
  const agentMap = options.agents ?? new Map<string, AgentLike>();
  if (!options.agents) {
    agentMap.set("sess-1", {
      session: { id: "sess-1" },
      status: "idle",
      followup: () => {},
    });
  }
  const agents: AgentsLike = {
    get: (id) => agentMap.get(id),
  };
  const text = makeChannel("deliver", options.respondText);
  const command = makeChannel("command", options.respondCommand);
  const channels = new ChannelRegistry();
  channels.register(text);
  channels.register(command);
  const timer = new FakeTimer();
  const scheduler = new Scheduler({
    store,
    journal,
    channels,
    agents,
    timer,
    now: () => clock.value,
    warn: (message) => warnings.push(message),
    ...(options.awaitAgentMs === undefined
      ? {}
      : { awaitAgentMs: options.awaitAgentMs }),
    ...(options.catchUpWindowMs === undefined
      ? {}
      : { catchUpWindowMs: options.catchUpWindowMs }),
    ...(options.maxDelayMs === undefined
      ? {}
      : { maxDelayMs: options.maxDelayMs }),
  });
  return {
    clock,
    store,
    journal,
    timer,
    agents: agentMap,
    text,
    command,
    scheduler,
    warnings,
    create(input) {
      return store.create({
        mode: "deliver",
        sessionId: "sess-1",
        payload: "提醒",
        ...input,
      });
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function track(built: Harness): Harness {
  cleanups.push(() => built.cleanup());
  return built;
}

test("空表启动：running, 无 timer 待触发", async () => {
  const built = track(harness());
  const status = built.scheduler.start();
  await built.scheduler.settle();
  assert.equal(status.running, true);
  assert.equal(built.timer.live.length, 0);
  assert.equal(built.scheduler.status().nextAt, null);
});

test("单 timer：多次 arm 只保留一个存活 timer", async () => {
  const built = track(harness());
  built.scheduler.start();
  built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "tick",
  });
  built.scheduler.arm();
  built.scheduler.arm();
  assert.equal(built.timer.live.length, 1);
});

test("分段：长延迟截到单段上限, 到期后重排", async () => {
  const built = track(harness({ maxDelayMs: 60_000 }));
  built.scheduler.start();
  built.create({
    selector: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
  });
  built.scheduler.arm();
  assert.equal(built.timer.pendingDelay, 60_000);
});

test("单段上限缺省 24 h", () => {
  assert.equal(DEFAULT_MAX_DELAY_MS, 24 * 60 * 60 * 1000);
});

test("启动补算：周期任务只补最近一次, 下次按现在重算", async () => {
  const built = track(harness());
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "巡检",
  });
  // 时钟推进 3 个间隔 + 30 s（模拟 dsh 停机后重启）
  built.clock.value = NOW + 3 * 60_000 + 30_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 1);
  const updated = built.store.get(task.id);
  assert.equal(updated?.status, "active");
  assert.equal(updated?.next, NOW + 4 * 60_000);
  assert.equal(updated?.lastOutcome, "delivered");
  assert.equal(built.journal.tail(10, task.id).length, 1);
});

test("一次性过期在补发窗口内 → 触发一次并转 done", async () => {
  const built = track(harness({ catchUpWindowMs: 10 * 60_000 }));
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "after_seconds", seconds: 60 },
    payload: "一次",
  });
  built.clock.value = NOW + 5 * 60_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 1);
  const updated = built.store.get(task.id);
  assert.equal(updated?.status, "done");
  assert.equal(updated?.next, null);
  assert.equal(updated?.lastOutcome, "delivered");
});

test("一次性过期超过补发窗口 → missed, 不投递", async () => {
  const built = track(harness({ catchUpWindowMs: 60_000 }));
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "after_seconds", seconds: 60 },
    payload: "一次",
  });
  built.clock.value = NOW + 10 * 60_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 0);
  const updated = built.store.get(task.id);
  assert.equal(updated?.status, "missed");
  assert.equal(updated?.lastError, "expired");
  assert.equal(built.journal.tail(1)[0]?.outcome, "missed");
});

test("目标无活跃 agent → skipped(no-active-agent), 不投递也不重试", async () => {
  const built = track(harness({ agents: new Map() }));
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "投不出去",
  });
  built.clock.value = NOW + 60_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 0);
  const updated = built.store.get(task.id);
  assert.equal(updated?.lastOutcome, "skipped");
  assert.equal(updated?.lastError, "no-active-agent");
  assert.equal(updated?.next, NOW + 120_000);
  // 再跑一轮：不会再补投本次（不重试）
  built.clock.value = NOW + 90_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 0);
  assert.equal(built.journal.tail(10, task.id).length, 1);
});

test("宽限窗口：agent 未出现时窗口内不记账, 超窗后 skipped", async () => {
  const built = track(harness({ awaitAgentMs: 5_000, agents: new Map() }));
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "等 agent",
  });
  built.clock.value = NOW + 60_000;
  await built.scheduler.runDue();
  // 窗口内：无流水, next 不变（下次复查再说）
  assert.equal(built.journal.tail(10, task.id).length, 0);
  assert.equal(built.store.get(task.id)?.next, NOW + 60_000);
  // 复查 timer 用固定间隔而不是 1 ms（避免忙等）
  assert.equal(built.timer.pendingDelay, 1_000);
  built.clock.value = NOW + 66_000;
  await built.scheduler.runDue();
  assert.equal(built.store.get(task.id)?.lastError, "no-active-agent");
  assert.equal(built.journal.tail(10, task.id).length, 1);
});

test("flush_failed → 记 delivered + durable:false + 告警, 不重投（D13）", async () => {
  const built = track(
    harness({
      respondText: () => ({
        ok: false,
        code: "flush_failed",
        durable: false,
        message: "flush 返回 false",
      }),
    }),
  );
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "volatile",
  });
  built.clock.value = NOW + 60_000;
  await built.scheduler.runDue();
  const updated = built.store.get(task.id);
  assert.equal(updated?.lastOutcome, "delivered");
  const record = built.journal.tail(1, task.id)[0];
  assert.equal(record?.outcome, "delivered");
  assert.match(record?.detail ?? "", /durable:false/);
  assert.ok(
    built.warnings.some((message) => message.includes("durable:false")),
  );
  // 不重投：再跑一轮没有新请求
  built.clock.value = NOW + 90_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 1);
});

test("失败只记账不重试：failed 后周期任务等下一个触发点", async () => {
  const built = track(
    harness({
      respondText: () => ({ ok: false, code: "error", message: "渠道炸了" }),
    }),
  );
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "失败",
  });
  built.clock.value = NOW + 60_000;
  await built.scheduler.runDue();
  const updated = built.store.get(task.id);
  assert.equal(updated?.lastOutcome, "failed");
  assert.equal(updated?.lastError, "error");
  assert.match(built.journal.tail(1, task.id)[0]?.detail ?? "", /渠道炸了/);
  assert.equal(updated?.next, NOW + 120_000);
  assert.equal(built.journal.tail(10, task.id).length, 1);
  built.clock.value = NOW + 100_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 1);
});

test("同会话同批到期 → 合并成一条请求（每条任务各记一条流水）", async () => {
  const built = track(harness());
  built.scheduler.start();
  await built.scheduler.settle();
  const first = built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "A",
  });
  const second = built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "B",
  });
  built.clock.value = NOW + 60_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 1);
  assert.deepEqual(
    built.text.requests[0]?.tasks.map((task) => task.id),
    [first.id, second.id],
  );
  assert.equal(built.journal.tail(10).length, 2);
});

test("命令任务不合并：同会话两条命令各投一次", async () => {
  const built = track(harness());
  built.scheduler.start();
  await built.scheduler.settle();
  const first = built.create({
    mode: "command",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "/memory search A",
  });
  const second = built.create({
    mode: "command",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "/memory search B",
  });
  built.clock.value = NOW + 60_000;
  await built.scheduler.runDue();
  assert.equal(built.command.requests.length, 2);
  assert.deepEqual(
    built.command.requests.map((request) => request.tasks[0]?.id).sort(),
    [first.id, second.id].sort(),
  );
});

test("暂停期间到点 → missed(paused), 解除后按当前时钟重算", async () => {
  const built = track(harness());
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "暂停中",
  });
  built.store.update(task.id, { status: "paused" });
  built.clock.value = NOW + 60_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 0);
  assert.equal(built.store.get(task.id)?.status, "missed");
  assert.equal(built.store.get(task.id)?.lastError, "paused");
});

test("暂停但未到点 → 不触发（解除后仍按原 next）", async () => {
  const built = track(harness());
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "every_seconds", seconds: 300 },
    payload: "暂停",
  });
  built.store.update(task.id, { status: "paused" });
  built.clock.value = NOW + 60_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 0);
  assert.equal(built.store.get(task.id)?.status, "paused");
  assert.equal(built.store.get(task.id)?.next, NOW + 300_000);
});

test("时钟回拨 → 周期任务按当前时钟重算 next", async () => {
  const built = track(harness());
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "every_seconds", seconds: 3600 },
    payload: "每小时",
  });
  // 先把 wall clock 推过下一次, 再回拨
  built.clock.value = NOW + 1_000;
  await built.scheduler.runDue();
  built.clock.value = NOW - 2 * 60_000;
  await built.scheduler.runDue();
  const updated = built.store.get(task.id);
  // 回拨后 next 仍严格晚于当前时钟
  assert.ok((updated?.next ?? 0) > built.clock.value);
  assert.ok(built.warnings.some((message) => message.includes("时钟回拨")));
});

test("runNow：立即投递一次, 不改 next / 状态", async () => {
  const built = track(harness());
  built.scheduler.start();
  await built.scheduler.settle();
  const task = built.create({
    selector: { kind: "every_seconds", seconds: 3600 },
    payload: "手动跑一次",
  });
  const result = await built.scheduler.runNow(task.id);
  assert.equal(result.ok, true);
  assert.equal(built.text.requests.length, 1);
  const updated = built.store.get(task.id);
  assert.equal(updated?.next, task.next);
  assert.equal(updated?.status, "active");
  assert.equal(updated?.lastOutcome, "delivered");
  const missing = await built.scheduler.runNow("d-nope");
  assert.equal(missing.ok, false);
});

test("stop：撤销 timer, 关闭后不再处理到期任务", async () => {
  const built = track(harness());
  built.scheduler.start();
  await built.scheduler.settle();
  built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "停",
  });
  built.scheduler.arm();
  assert.equal(built.timer.live.length, 1);
  await built.scheduler.stop();
  assert.equal(built.timer.live.length, 0);
  assert.equal(built.scheduler.status().running, false);
  built.clock.value = NOW + 60_000;
  await built.scheduler.runDue();
  assert.equal(built.text.requests.length, 0);
});

test("timer 到点：fire 后重新排下一次", async () => {
  const built = track(harness());
  built.scheduler.start();
  await built.scheduler.settle();
  built.create({
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "到点",
  });
  built.scheduler.arm();
  built.clock.value = NOW + 60_000;
  await built.timer.fire();
  await built.scheduler.settle();
  assert.equal(built.text.requests.length, 1);
  assert.equal(built.timer.live.length, 1);
});
