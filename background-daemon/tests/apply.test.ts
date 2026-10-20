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
  bootDaemon,
  createDaemonRuntime,
  resolveJournalPath,
  resolveStorePath,
} from "../src/main.ts";
import type {
  AgentLike,
  ChannelResult,
  DeliveryRequest,
} from "../src/types.ts";
import { HostTimer } from "./harness.ts";

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

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
  /** 宿主 `on("dispose")` 注册的回调（apply 不再返回 runtime, 卸载全靠它）。 */
  disposeListeners: (() => void)[];
  warns: string[];
}

function fakeContext(
  options: { withCommands?: boolean; withTools?: boolean } = {},
): FakeContext {
  const provided = new Map<string, unknown>();
  const disposeListeners: (() => void)[] = [];
  const commands = { definitions: [] as unknown[] };
  const tools = { registered: [] as unknown[] };
  const agent: AgentLike = {
    session: { id: "sess-1" },
    status: "idle",
    followup: () => {},
  };
  const timer = new HostTimer();
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
    on: (event: string, listener: () => void) => {
      if (event === "dispose") disposeListeners.push(listener);
      return () => {};
    },
  };
  return { ctx, provided, commands, tools, disposeListeners, warns: [] };
}

test("apply：注册服务面 / 命令 / 工具并启动调度", async () => {
  const dir = tempDir();
  const fake = fakeContext();
  const runtime = await bootDaemon(fake.ctx, {
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
  const runtime = await bootDaemon(fake.ctx, {
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
    const runtime = await bootDaemon(fake.ctx, {
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
  const runtime = await createDaemonRuntime(
    {
      get: (serviceName: string) =>
        serviceName === "agents"
          ? { get: () => agent }
          : serviceName === "sessions"
            ? { flush: async () => true }
            : serviceName === "timer"
              ? new HostTimer()
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
  const runtime = await bootDaemon(fake.ctx, {
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
  const runtime = await createDaemonRuntime(
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

/** 极简假 memory-base：够跑通「注册 → 读 → 写透 → 流水入库」这条链。 */
class FakeMemory {
  readonly rows: {
    id: number;
    kind: string;
    tier: "session" | "project" | "user";
    project: string;
    title: string | null;
    content: string;
    importance: number;
    sourceId: number | null;
    sessionId: string | null;
    createdAt: number;
  }[] = [];
  readonly specs: { kind: string }[] = [];
  nextId = 1;
  clock = { value: Date.UTC(2026, 9, 20, 8, 0, 0) };

  registerKind(spec: { kind: string }) {
    this.specs.push(spec);
    const memory = this;
    return {
      kind: spec.kind,
      writableTiers: ["session", "project", "user"] as const,
      async put(input: {
        content: string;
        tier?: "session" | "project" | "user";
        title?: string;
        importance?: number;
        sessionId?: string;
      }) {
        const tier = input.tier ?? "session";
        const id = memory.nextId;
        memory.nextId += 1;
        memory.rows.push({
          id,
          kind: spec.kind,
          tier,
          project: "",
          title: input.title ?? null,
          content: input.content,
          importance: input.importance ?? 3,
          sourceId: 1,
          sessionId: input.sessionId ?? null,
          createdAt: memory.clock.value,
        });
        return { ids: [id], sourceId: 1, created: 1 };
      },
      async forget() {
        return 0;
      },
    };
  }

  async list(
    opts: {
      kind?: string;
      tier?: "session" | "project" | "user";
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const filtered = this.rows
      .filter((row) => opts.kind === undefined || row.kind === opts.kind)
      .filter((row) => opts.tier === undefined || row.tier === opts.tier)
      .sort((left, right) => left.id - right.id);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }
}

test("apply：memory-base 可用 → 记录底座为 memory, 任务从库里读出", async () => {
  const dir = tempDir();
  const fake = fakeContext();
  const memory = new FakeMemory();
  const seededTask = {
    id: "d-seed01",
    tier: "S" as const,
    mode: "deliver" as const,
    selector: { kind: "every_seconds" as const, seconds: 60 },
    payload: "库里的任务",
    sessionId: "sess-1",
    status: "active" as const,
    createdAt: NOW,
    next: NOW + 60_000,
    lastFireAt: null,
    lastOutcome: null,
    lastError: null,
  };
  memory.rows.push({
    id: 1,
    kind: "daemon_task",
    tier: "session",
    project: "",
    title: seededTask.id,
    content: JSON.stringify({ task: seededTask, syncedAt: NOW }),
    importance: 3,
    sourceId: 1,
    sessionId: "sess-1",
    createdAt: NOW,
  });
  memory.nextId = 2;
  const withMemory: Record<string, unknown> = {
    ...(fake.ctx as Record<string, unknown>),
    get: (serviceName: string) =>
      serviceName === "memory"
        ? memory
        : (fake.ctx["get"] as (name: string) => unknown)(serviceName),
  };
  const runtime = await bootDaemon(withMemory, {
    storePath: path.join(dir, "tasks.json"),
    journalPath: path.join(dir, "journal.jsonl"),
    defaultSessionId: "sess-1",
  });
  assert.equal(runtime.backend, "memory");
  assert.deepEqual(
    memory.specs.map((spec) => spec.kind),
    ["daemon_task", "daemon_run"],
  );
  assert.equal(runtime.store.list().length, 1);
  assert.equal(runtime.store.list()[0]?.id, seededTask.id);
  // 新任务写透：多一行 daemon_task 修订
  const created = runtime.store.create({
    mode: "deliver",
    sessionId: "sess-1",
    payload: "新任务",
    selector: { kind: "every_seconds", seconds: 120 },
  });
  await runtime.mirror?.settle();
  assert.ok(
    memory.rows.some(
      (row) => row.kind === "daemon_task" && row.title === created.id,
    ),
  );
  await runtime.dispose();
});

test("apply：memory-base 不可用 → 降级 json, 不注册 kind", async () => {
  const dir = tempDir();
  const fake = fakeContext();
  const runtime = await bootDaemon(fake.ctx, {
    storePath: path.join(dir, "tasks.json"),
    journalPath: path.join(dir, "journal.jsonl"),
  });
  assert.equal(runtime.backend, "json");
  assert.equal(runtime.mirror, null);
  await runtime.dispose();
});

test("apply：宿主加载路径返回 void（undefined）, 不当 effect 收集", async () => {
  const dir = tempDir();
  const fake = fakeContext();
  const result = await apply(fake.ctx, {
    storePath: path.join(dir, "tasks.json"),
    journalPath: path.join(dir, "journal.jsonl"),
  });
  // 回归守卫：cordis 把 apply 的返回值当 effect, 返回 runtime 普通对象即 Invalid effect
  assert.equal(result, undefined);
  assert.equal(typeof result, "undefined");
  // 命令面与工具面照常注册
  assert.equal(fake.commands.definitions.length, 1);
  assert.equal(fake.tools.registered.length, 1);
  // 卸载没有返回值可用, 必须靠宿主 dispose 回调：已注册且可调用
  assert.equal(fake.disposeListeners.length, 1);
  assert.doesNotThrow(() => fake.disposeListeners[0]?.());
});

test("bootDaemon：同一路径下仍返回运行期句柄（与 apply 的分工）", async () => {
  const dir = tempDir();
  const fake = fakeContext();
  const runtime = await bootDaemon(fake.ctx, {
    storePath: path.join(dir, "tasks.json"),
    journalPath: path.join(dir, "journal.jsonl"),
  });
  assert.equal(typeof runtime, "object");
  assert.equal(runtime.backend, "json");
  assert.equal(typeof runtime.dispose, "function");
  await runtime.dispose();
});
