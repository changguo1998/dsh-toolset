/**
 * 投递渠道单测：文本（合并 / 宏任务推迟 / flush 确认与失败）与命令（命中 / 复查 / 执行）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CommandChannel,
  INJECTION_PREFIX,
  buildDeliverMessage,
  parseCommandLine,
  TextChannel,
  type CommandRuntimeLike,
} from "../src/deliver.ts";
import { makeCommandGuard } from "../src/guard.ts";
import {
  SOURCE_KIND,
  type AgentLike,
  type DaemonTask,
  type DeliveryRequest,
} from "../src/types.ts";

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

function task(over: Partial<DaemonTask> = {}): DaemonTask {
  return {
    id: "d-test01",
    tier: "S",
    mode: "deliver",
    selector: { kind: "after_seconds", seconds: 60 },
    payload: "提醒我喝水",
    sessionId: "sess-1",
    status: "active",
    createdAt: NOW,
    next: NOW + 60_000,
    lastFireAt: null,
    lastOutcome: null,
    lastError: null,
    ...over,
  };
}

function fakeAgent(over: Partial<AgentLike> = {}): {
  agent: AgentLike;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const agent: AgentLike = {
    session: { id: "sess-1" },
    status: "idle",
    followup: (message: unknown) => calls.push(message),
    ...over,
  };
  return { agent, calls };
}

function request(
  tasks: readonly DaemonTask[],
  agent: AgentLike,
  signal = new AbortController().signal,
): DeliveryRequest {
  return { tasks, agent, signal };
}

test("文本：flush 确认 → delivered（消息形态符合硬要求）", async () => {
  const { agent, calls } = fakeAgent();
  const channel = new TextChannel({
    sessions: { flush: async () => true },
    defer: (callback) => callback(),
  });
  const result = await channel.deliver(request([task()], agent));
  assert.deepEqual(result, {
    ok: true,
    durable: true,
    detail: "flush 确认（合并 1 条）",
  });
  assert.equal(calls.length, 1);
  const message = calls[0] as Record<string, unknown>;
  assert.equal(typeof message["id"], "string");
  assert.equal(message["role"], "user");
  const content = message["content"] as { type: string; text: string }[];
  assert.equal(content.length, 1);
  assert.equal(content[0]?.text, `${INJECTION_PREFIX}提醒我喝水`);
  assert.equal((message["source"] as { kind: string }).kind, SOURCE_KIND);
});

test("文本：同批多条合并为一条消息（followup 只调一次）", async () => {
  const { agent, calls } = fakeAgent();
  const channel = new TextChannel({
    sessions: { flush: async () => true },
    defer: (callback) => callback(),
  });
  const result = await channel.deliver(
    request(
      [
        task({ id: "d-a", payload: "任务 A" }),
        task({ id: "d-b", payload: "任务 B" }),
        task({ id: "d-c", payload: "任务 C" }),
      ],
      agent,
    ),
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const text = (
    (calls[0] as { content: { text: string }[] }).content[0] as { text: string }
  ).text;
  assert.match(text, /3 条守护任务到点/);
  assert.match(text, /任务 A/);
  assert.match(text, /任务 B/);
  assert.match(text, /任务 C/);
});

test("文本：注入动作推迟到宏任务（defer 未执行前 followup 不被调用）", async () => {
  const { agent, calls } = fakeAgent();
  const queue: (() => void)[] = [];
  const channel = new TextChannel({
    sessions: { flush: async () => true },
    defer: (callback) => queue.push(callback),
  });
  const pending = channel.deliver(request([task()], agent));
  assert.equal(calls.length, 0);
  assert.equal(queue.length, 1);
  queue[0]?.();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test("文本：目标 running 时照常排队（不 cancel / 不阻塞）", async () => {
  const { agent, calls } = fakeAgent({ status: "running" });
  const channel = new TextChannel({
    sessions: { flush: async () => true },
    defer: (callback) => callback(),
  });
  const result = await channel.deliver(request([task()], agent));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(agent.status, "running");
});

test("文本：flush 返回 false → flush_failed + durable:false（消息已入收件箱）", async () => {
  const { agent, calls } = fakeAgent();
  const channel = new TextChannel({
    sessions: { flush: async () => false },
    defer: (callback) => callback(),
  });
  const result = await channel.deliver(request([task()], agent));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "flush_failed");
    assert.equal(result.durable, false);
  }
  assert.equal(calls.length, 1);
});

test("文本：flush 抛错 → flush_failed；flush 面缺失 → 成功但 volatile", async () => {
  const throwing = new TextChannel({
    sessions: {
      flush: async () => {
        throw new Error("disk full");
      },
    },
    defer: (callback) => callback(),
  });
  const failed = await throwing.deliver(request([task()], fakeAgent().agent));
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, "flush_failed");

  const missing = new TextChannel({ defer: (callback) => callback() });
  const volatile = await missing.deliver(request([task()], fakeAgent().agent));
  assert.deepEqual(volatile, {
    ok: true,
    durable: false,
    detail: "flush 面不可用（落盘未确认）",
  });
});

test("文本：agent 无 followup 面 → no-active-agent", async () => {
  const channel = new TextChannel({
    sessions: { flush: async () => true },
    defer: (callback) => callback(),
  });
  const result = await channel.deliver(
    request([task()], { session: { id: "s" } }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "no-active-agent");
});

test("buildDeliverMessage：单条无列表, 多条带编号列表", () => {
  const single = buildDeliverMessage([task()], () => "id-1");
  assert.equal(single["id"], "id-1");
  assert.equal(
    (single["content"] as { text: string }[])[0]?.text,
    `${INJECTION_PREFIX}提醒我喝水`,
  );
  const batch = buildDeliverMessage(
    [task({ payload: "A" }), task({ payload: "B" })],
    () => "id-2",
  );
  const text = (batch["content"] as { text: string }[])[0]?.text ?? "";
  assert.match(text, /2 条守护任务到点：\n- A\n- B/);
  assert.match(String((batch["source"] as { summary: string }).summary), /d-test01/);
});

test("parseCommandLine：补斜杠 / 保留参数 / 拒绝非法名", () => {
  assert.deepEqual(parseCommandLine("/memory search x"), {
    line: "/memory search x",
    name: "memory",
  });
  assert.deepEqual(parseCommandLine("  loop tick  "), {
    line: "/loop tick",
    name: "loop",
  });
  assert.equal(parseCommandLine(""), null);
  assert.equal(parseCommandLine("/--bad"), null);
  assert.equal(parseCommandLine("/"), null);
});

test("命令：find 未命中 → command_not_found, 不执行也不降级", async () => {
  let executed = 0;
  const commands: CommandRuntimeLike = {
    find: () => undefined,
    execute: async () => {
      executed += 1;
      return undefined;
    },
  };
  const channel = new CommandChannel({ commands });
  const result = await channel.deliver(
    request([task({ mode: "command", payload: "/nope" })], fakeAgent().agent),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "command_not_found");
  assert.equal(executed, 0);
});

test("命令：引擎侧复查拦截 → guard_denied, 不执行", async () => {
  let executed = 0;
  const commands: CommandRuntimeLike = {
    find: () => ({ name: "memory" }),
    execute: async () => {
      executed += 1;
      return { result: { kind: "success", text: "ok" } };
    },
  };
  const channel = new CommandChannel({
    commands,
    guard: () => ({ receipt: "拒绝：命中硬拒模式", skipped: false }),
  });
  const result = await channel.deliver(
    request([task({ mode: "command", payload: "/memory search x" })], fakeAgent().agent),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "guard_denied");
    assert.match(result.message ?? "", /硬拒模式/);
  }
  assert.equal(executed, 0);
});

test("命令：命中即执行（规范化 slash 行 + 空附件 + signal）", async () => {
  const seen: { line: string; attachments: readonly unknown[]; signal: AbortSignal }[] = [];
  const signal = new AbortController().signal;
  const commands: CommandRuntimeLike = {
    find: (agent, name) => (name === "memory" ? { name } : undefined),
    execute: async (_agent, line, attachments, passedSignal) => {
      seen.push({ line, attachments, signal: passedSignal });
      return { result: { kind: "success", text: "检索完成" } };
    },
  };
  const channel = new CommandChannel({ commands });
  const result = await channel.deliver(
    request([task({ mode: "command", payload: "memory search 巡检" })], fakeAgent().agent, signal),
  );
  assert.deepEqual(result, { ok: true, detail: "检索完成" });
  assert.deepEqual(seen, [{ line: "/memory search 巡检", attachments: [], signal }]);
});

test("命令：execute 返回 undefined / error 结果 → failed", async () => {
  const undefinedChannel = new CommandChannel({
    commands: {
      find: () => ({ name: "memory" }),
      execute: async () => undefined,
    },
  });
  const unresolved = await undefinedChannel.deliver(
    request([task({ mode: "command", payload: "/memory" })], fakeAgent().agent),
  );
  assert.equal(unresolved.ok, false);
  if (!unresolved.ok) assert.equal(unresolved.code, "error");

  const errorChannel = new CommandChannel({
    commands: {
      find: () => ({ name: "memory" }),
      execute: async () => ({ result: { kind: "error", text: "命令失败" } }),
    },
  });
  const failed = await errorChannel.deliver(
    request([task({ mode: "command", payload: "/memory" })], fakeAgent().agent),
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.code, "error");
    assert.equal(failed.message, "命令失败");
  }
});

test("命令：复查不可用 → fail-open 执行并标 guardSkipped", async () => {
  const warnings: string[] = [];
  // 空 ctx：guard 服务缺失 → 复查器 fail-open
  const guard = makeCommandGuard({}, (message) => warnings.push(message));
  const channel = new CommandChannel({
    commands: {
      find: () => ({ name: "memory" }),
      execute: async () => ({ result: { kind: "success", text: "ok" } }),
    },
    guard,
  });
  const result = await channel.deliver(
    request([task({ mode: "command", payload: "/memory" })], fakeAgent().agent),
  );
  assert.deepEqual(result, { ok: true, detail: "ok", guardSkipped: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /security-guard 服务不可用/);
});

test("命令：commands 服务缺失 → failed(error)", async () => {
  const channel = new CommandChannel();
  const result = await channel.deliver(
    request([task({ mode: "command", payload: "/memory" })], fakeAgent().agent),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "error");
});
