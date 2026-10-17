/**
 * 装配单测：apply 的注册形态、损坏任务表的降级、缺失服务的降级、dispose 收尾。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  apply,
  createDaemonRuntime,
  resolveJournalPath,
  resolveStorePath,
} from "../src/main.ts";
import type {
  AgentLike,
  ChannelResult,
  DeliveryRequest,
} from "../src/types.ts";
import { FakeTimer } from "./harness.ts";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "background-daemon-apply-"));
  dirs.push(dir);
  return dir;
}

interface FakeContext {
  ctx: Record<string, unknown>;
  provided: Map<string, unknown>;
  commands: { definitions: unknown[] };
  tools: { registered: unknown[] };
  warns: string[];
}

function fakeContext(
  options: { withCommands?: boolean; withTools?: boolean } = {},
): FakeContext {
  const provided = new Map<string, unknown>();
  const commands = { definitions: [] as unknown[] };
  const tools = { registered: [] as unknown[] };
  const agent: AgentLike = {
    session: { id: "sess-1" },
    status: "idle",
    followup: () => {},
  };
  const timer = new FakeTimer();
  const services: Record<string, unknown> = {
    agents: { get: (id: string) => (id === "sess-1" ? agent : undefined) },
    sessions: { flush: async () => true },
    timer,
  };
  if (options.withCommands !== false) {
    services["commands"] = {
      register: (definition: unknown) => {
        commands.definitions.push(definition);
        return () => {};
      },
      find: () => undefined,
      execute: async () => undefined,
    };
  }
  if (options.withTools !== false) {
    services["tools"] = {
      register: (tool: unknown) => tools.registered.push(tool),
    };
  }
  const ctx: Record<string, unknown> = {
    get: (serviceName: string) => services[serviceName],
    provide: (serviceName: string, value: unknown) =>
      provided.set(serviceName, value),
    on: () => () => {},
  };
  return { ctx, provided, commands, tools, warns: [] };
}

test("apply：注册服务面 / 命令 / 工具并启动调度", async () => {
  const dir = tempDir();
  const fake = fakeContext();
  const runtime = apply(fake.ctx, {
    storePath: path.join(dir, "tasks.json"),
    journalPath: path.join(dir, "journal.jsonl"),
    defaultSessionId: "sess-1",
  });
  assert.equal(fake.provided.has("backgroundDaemon"), true);
  assert.equal(fake.commands.definitions.length, 1);
  assert.equal(fake.tools.registered.length, 1);
  assert.equal(runtime.scheduler.status().running, true);
  assert.equal(runtime.storePath, path.join(dir, "tasks.json"));
  await runtime.dispose();
  assert.equal(runtime.scheduler.status().running, false);
});

test("apply：任务表损坏 → 面不启用但命令面仍注册（错误可见）", async () => {
  const dir = tempDir();
  const storePath = path.join(dir, "tasks.json");
  writeFileSync(storePath, "{ 半截", "utf8");
  const fake = fakeContext();
  const runtime = apply(fake.ctx, {
    storePath,
    journalPath: path.join(dir, "journal.jsonl"),
  });
  assert.equal(runtime.scheduler.status().running, false);
  assert.match(runtime.scheduler.status().error ?? "", /任务表损坏/);
  assert.equal(fake.commands.definitions.length, 1);
  await runtime.dispose();
});

test("apply：commands / tools 缺失 → 降级告警, 不抛", async () => {
  const dir = tempDir();
  const fake = fakeContext({ withCommands: false, withTools: false });
  const original = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = (chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const runtime = apply(fake.ctx, {
      storePath: path.join(dir, "tasks.json"),
      journalPath: path.join(dir, "journal.jsonl"),
    });
    assert.equal(runtime.scheduler.status().running, true);
    await runtime.dispose();
  } finally {
    process.stderr.write = original;
  }
  const text = captured.join("");
  assert.match(text, /ctx\.commands 不可用/);
  assert.match(text, /ctx\.tools 不可用/);
});

test("createDaemonRuntime：注入时钟, 到期即投递", async () => {
  const dir = tempDir();
  const clock = { value: Date.UTC(2026, 9, 20, 8, 0, 0) };
  const delivered: DeliveryRequest[] = [];
  const agent: AgentLike = {
    session: { id: "sess-1" },
    followup: () => {},
  };
  const runtime = createDaemonRuntime(
    {
      get: (serviceName: string) =>
        serviceName === "agents"
          ? { get: () => agent }
          : serviceName === "sessions"
            ? { flush: async () => true }
            : serviceName === "timer"
              ? new FakeTimer()
              : undefined,
    },
    {
      storePath: path.join(dir, "tasks.json"),
      journalPath: path.join(dir, "journal.jsonl"),
    },
    () => clock.value,
    () => {},
  );
  void delivered;
  runtime.scheduler.start();
  await runtime.scheduler.settle();
  const task = runtime.store.create({
    mode: "deliver",
    sessionId: "sess-1",
    payload: "到点",
    selector: { kind: "every_seconds", seconds: 60 },
  });
  clock.value += 60_000;
  await runtime.scheduler.runDue();
  assert.equal(runtime.store.get(task.id)?.lastOutcome, "delivered");
  assert.equal(runtime.journal.tail(5, task.id).length, 1);
  await runtime.dispose();
});

test("路径解析：config 优先, 环境变量兜底, 缺省落 DSH_HOME", () => {
  const dir = tempDir();
  const previousStore = process.env["BACKGROUND_DAEMON_STORE"];
  const previousHome = process.env["DSH_HOME"];
  try {
    process.env["BACKGROUND_DAEMON_STORE"] = path.join(dir, "from-env.json");
    assert.equal(resolveStorePath(), path.join(dir, "from-env.json"));
    assert.equal(
      resolveStorePath({ storePath: path.join(dir, "from-config.json") }),
      path.join(dir, "from-config.json"),
    );
    delete process.env["BACKGROUND_DAEMON_STORE"];
    process.env["DSH_HOME"] = dir;
    assert.equal(
      resolveStorePath(),
      path.join(dir, "background-daemon", "tasks.json"),
    );
    assert.equal(
      resolveJournalPath(),
      path.join(dir, "background-daemon", "journal.jsonl"),
    );
  } finally {
    if (previousStore === undefined)
      delete process.env["BACKGROUND_DAEMON_STORE"];
    else process.env["BACKGROUND_DAEMON_STORE"] = previousStore;
    if (previousHome === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = previousHome;
  }
});

test("工具注册：缺省 defaultSessionId 时 create 报 missing_session", async () => {
  const dir = tempDir();
  const fake = fakeContext();
  const runtime = apply(fake.ctx, {
    storePath: path.join(dir, "tasks.json"),
    journalPath: path.join(dir, "journal.jsonl"),
  });
  const tool = fake.tools.registered[0] as {
    execute: (
      args: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
  const result = await tool.execute({
    action: "create",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "x",
  });
  assert.equal(result["ok"], false);
  assert.equal(result["error"], "missing_session");
  await runtime.dispose();
});

test("dispose 幂等：重复调用不抛", async () => {
  const dir = tempDir();
  const runtime = createDaemonRuntime(
    {},
    {
      storePath: path.join(dir, "tasks.json"),
      journalPath: path.join(dir, "journal.jsonl"),
    },
    () => Date.UTC(2026, 9, 20),
    () => {},
  );
  runtime.scheduler.start();
  await runtime.dispose();
  await runtime.dispose();
  assert.equal(runtime.scheduler.status().running, false);
});

test("渠道结果类型在装配里被使用（防未使用导出漂移）", () => {
  const result: ChannelResult = { ok: true, durable: true };
  assert.equal(result.ok, true);
});
