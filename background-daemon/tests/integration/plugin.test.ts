/**
 * 集成层：`apply` 与宿主接线。
 *
 * 断言口径（总规范 4.2 / P2）：
 * - 工具面：注册名、参数面、`execute` 的 canonical 返回值;
 * - 投影面：`output.render` 把结果投影成单条 text JSON;
 * - 命令面：`/daemon` 的注册形态与 handler 输出;
 * - 投递内容：文本消息的注入前缀 / source / 目标会话, 命令行的规范化与执行参数;
 * - 事件面：`dispose` 回调撤销调度器, 重复触发幂等;
 * - 服务面：`provide` 与 `get` 同一实例, 状态视图字段与 memory 底座晚挂同步。
 *
 * 落盘一律写临时目录（`tempStateDir`）; 不依赖真实 dsh 进程、真实 timer 与外网。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  apply,
  COMMAND_NAME,
  INJECTION_PREFIX,
  SERVICE_FACE_METHODS,
  SOURCE_KIND,
  TOOL_NAME,
} from "../../src/index.ts";
import {
  assembleHost,
  FakeClock,
  findTool,
  tempStateDir,
  waitFor,
  type AssembledHost,
} from "../assemble.ts";

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function stateDir(): ReturnType<typeof tempStateDir> {
  const state = tempStateDir();
  cleanups.push(() => state.cleanup());
  return state;
}

interface ToolLike {
  name: string;
  description: string;
  parameters: {
    type: string;
    required?: string[];
    properties: Record<string, { enum?: string[] }>;
  };
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  output: {
    schema: { type: string };
    render(args: unknown, value: unknown): { type: string; text: string }[];
  };
}

interface CommandLike {
  definitionId?: string;
  name: string;
  description?: string;
  input?: { hint?: string };
  handler(invocation: {
    rawInput?: string;
  }): Promise<{ kind: string; text: string }>;
}

/** 装配一个已开启的守护（默认 JSON 底座, 假 clock 不排真 timer）。 */
async function boot(
  options: {
    services?: Record<string, unknown>;
    enabled?: boolean;
    withInject?: boolean;
  } = {},
): Promise<{
  host: AssembledHost;
  state: ReturnType<typeof tempStateDir>;
  tool: ToolLike | null;
  command: CommandLike | null;
  service: Record<string, unknown>;
}> {
  const state = stateDir();
  const host = assembleHost({
    services: {
      // 假 clock：排期只记录不触发, 用例不会被真实 timer 拖住
      clock: new FakeClock(Date.now()),
      ...(options.services ?? {}),
    },
    ...(options.withInject === undefined
      ? {}
      : { withInject: options.withInject }),
  });
  await apply(host.ctx, {
    ...state.config,
    defaultSessionId: "sess-1",
    enabled: options.enabled ?? true,
  });
  const tool =
    host.tools.registered.length === 0
      ? null
      : (findTool(host.tools, TOOL_NAME) as unknown as ToolLike);
  const command =
    host.commands.definitions.length === 0
      ? null
      : (host.commands.definitions[0] as unknown as CommandLike);
  const service = host.services.provided.get("backgroundDaemon") as Record<
    string,
    unknown
  >;
  cleanups.push(() => {
    host.events.emit("dispose");
  });
  return { host, state, tool, command, service };
}

test("工具面：注册 daemon_task, 参数面与描述稳定", async () => {
  const { tool, service } = await boot();
  assert.ok(tool !== null, "工具应已注册");
  assert.equal(tool.name, "daemon_task");
  assert.equal(TOOL_NAME, tool.name);
  assert.match(tool.description, /^用途: 面向会话投递/);
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual(tool.parameters.properties["action"]?.enum, [
    "create",
    "list",
    "show",
    "pause",
    "resume",
    "run",
    "cancel",
    "log",
  ]);
  assert.deepEqual(tool.parameters.properties["tier"]?.enum, ["S", "P", "U"]);
  assert.equal(tool.output.schema.type, "object");
  // 服务面与工具面同一次装配产出
  assert.equal(typeof service["status"], "function");
});

test("工具 execute：create 的 canonical 任务 + list / show / log 投影", async () => {
  const { tool, service } = await boot();
  assert.ok(tool !== null);
  const created = await tool.execute({
    action: "create",
    selector: { kind: "after_seconds", seconds: 600 },
    payload: "集成任务",
    tier: "P",
  });
  assert.equal(created["ok"], true);
  const task = created["task"] as Record<string, unknown>;
  assert.match(String(task["id"]), /^d-[0-9a-f]{8}$/);
  assert.equal(task["tier"], "P");
  assert.equal(task["mode"], "deliver");
  assert.equal(task["status"], "active");
  assert.equal(task["payload"], "集成任务");
  assert.equal(task["sessionId"], "sess-1");
  assert.equal(task["lastOutcome"], null);
  assert.equal(typeof task["next"], "number");
  assert.match(String(created["text"]), /已创建 d-/);

  const listed = await tool.execute({ action: "list" });
  assert.equal(listed["ok"], true);
  assert.equal((listed["tasks"] as unknown[]).length, 1);
  assert.match(String(listed["text"]), /守护任务 1 个/);
  assert.match(String(listed["text"]), new RegExp(String(task["id"])));

  const shown = await tool.execute({ action: "show", id: task["id"] });
  assert.equal(shown["ok"], true);
  assert.equal((shown["task"] as Record<string, unknown>)["id"], task["id"]);
  assert.match(String(shown["text"]), /分档：P/);

  const log = await tool.execute({ action: "log", id: task["id"] });
  assert.equal(log["ok"], true);
  assert.deepEqual(log["records"], []);
  assert.match(String(log["text"]), /暂无流水/);

  // 服务面读到同一份任务表
  assert.equal((service["list"] as () => unknown[])().length, 1);
});

test("工具 execute：pause / resume / cancel 与错误码 canonical 值", async () => {
  const { tool } = await boot();
  assert.ok(tool !== null);
  const created = await tool.execute({
    action: "create",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "状态迁移",
  });
  const id = String((created["task"] as Record<string, unknown>)["id"]);

  const paused = await tool.execute({ action: "pause", id });
  assert.equal(paused["ok"], true);
  assert.equal((paused["task"] as Record<string, unknown>)["status"], "paused");
  assert.equal(paused["text"], `已暂停 ${id}`);

  const resumed = await tool.execute({ action: "resume", id });
  assert.equal(resumed["ok"], true);
  assert.equal(
    (resumed["task"] as Record<string, unknown>)["status"],
    "active",
  );

  const cancelled = await tool.execute({ action: "cancel", id });
  assert.equal(cancelled["ok"], true);
  assert.equal(cancelled["text"], `已删除 ${id}`);

  const gone = await tool.execute({ action: "show", id });
  assert.equal(gone["ok"], false);
  assert.equal(gone["error"], "task_not_found");

  const unknown = await tool.execute({ action: "explode" });
  assert.equal(unknown["ok"], false);
  assert.equal(unknown["error"], "unknown_action");

  const invalidSelector = await tool.execute({
    action: "create",
    selector: { kind: "every_seconds", seconds: 5 },
    payload: "太密",
  });
  assert.equal(invalidSelector["ok"], false);
  assert.equal(invalidSelector["error"], "frequency_too_high");
});

test("工具 output.render：结果投影为单条 text JSON", async () => {
  const { tool } = await boot();
  assert.ok(tool !== null);
  const value = {
    ok: true,
    text: "已创建 d-0000abcd",
    task: { id: "d-0000abcd", next: NOW + 60_000 },
  };
  const rendered = tool.output.render({ action: "create" }, value);
  assert.equal(rendered.length, 1);
  const block = rendered[0];
  assert.ok(block !== undefined);
  assert.equal(block.type, "text");
  assert.deepEqual(JSON.parse(block.text), value);
});

test("命令面：/daemon 注册形态与 handler 输出", async () => {
  const { command, host } = await boot();
  assert.ok(command !== null, "命令应已注册");
  assert.equal(command.name, COMMAND_NAME);
  assert.equal(command.definitionId, "background-daemon:daemon");
  assert.match(command.description ?? "", /后台守护任务（默认关闭/);
  assert.match(command.input?.hint ?? "", /start \| stop \| list/);

  const listed = await command.handler({ rawInput: "list" });
  assert.deepEqual(listed, { kind: "success", text: "暂无守护任务" });

  const unknown = await command.handler({ rawInput: "nope" });
  assert.equal(unknown.kind, "error");
  assert.match(unknown.text, /未知子命令：nope/);

  const stopped = await command.handler({ rawInput: "stop" });
  assert.equal(stopped.kind, "success");
  const service = host.services.provided.get("backgroundDaemon") as {
    status(): { enabled: boolean; running: boolean };
  };
  assert.equal(service.status().enabled, false);
  assert.equal(service.status().running, false);

  const started = await command.handler({ rawInput: "start" });
  assert.equal(started.kind, "success");
  assert.match(started.text, /已开启/);
  assert.equal(service.status().enabled, true);
  assert.equal(service.status().running, true);
});

test("投递内容：文本任务 run 后注入前缀 / source / 目标会话都对", async () => {
  const injected: unknown[] = [];
  const flushed: unknown[] = [];
  const agent = {
    session: { id: "sess-1" },
    status: "idle",
    followup(message: unknown): void {
      injected.push(message);
    },
  };
  const { tool, service } = await boot({
    services: {
      agents: { get: (id: string) => (id === "sess-1" ? agent : undefined) },
      sessions: {
        flush: async (session: unknown) => {
          flushed.push(session);
          return true;
        },
      },
    },
  });
  assert.ok(tool !== null);
  const created = await tool.execute({
    action: "create",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "到点提醒",
  });
  const id = String((created["task"] as Record<string, unknown>)["id"]);

  const run = await tool.execute({ action: "run", id });
  assert.equal(run["ok"], true);
  assert.equal((run["result"] as Record<string, unknown>)["ok"], true);

  assert.equal(injected.length, 1);
  const message = injected[0] as {
    id: string;
    role: string;
    content: { type: string; text: string }[];
    source: { kind: string; summary: string };
  };
  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [
    { type: "text", text: `${INJECTION_PREFIX}到点提醒` },
  ]);
  assert.equal(message.source.kind, SOURCE_KIND);
  assert.match(message.source.summary, new RegExp(id));
  assert.deepEqual(flushed, [{ id: "sess-1" }]);

  // 流水：delivered + flush 确认的 detail
  const journal = (
    service["journal"] as (
      limit?: number,
      taskId?: string,
    ) => Record<string, unknown>[]
  )(5, id);
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.["outcome"], "delivered");
  assert.match(String(journal[0]?.["detail"]), /flush 确认/);
});

test("投递内容：命令任务执行规范化的 slash 行, 复查缺席时标 guardSkipped", async () => {
  const executed: {
    line: string;
    attachments: readonly unknown[];
    hasSignal: boolean;
  }[] = [];
  const commands = {
    register: () => () => {},
    find: (_agent: unknown, name: string) =>
      name === "daemon" ? { name: "daemon" } : undefined,
    execute: async (
      _agent: unknown,
      line: string,
      attachments: readonly unknown[],
      signal: AbortSignal,
    ) => {
      executed.push({ line, attachments, hasSignal: signal !== undefined });
      return { result: { kind: "success", text: "命令已执行" } };
    },
  };
  const { tool, service } = await boot({ services: { commands } });
  assert.ok(tool !== null);
  const created = await tool.execute({
    action: "create",
    mode: "command",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "daemon list",
  });
  const id = String((created["task"] as Record<string, unknown>)["id"]);
  const run = await tool.execute({ action: "run", id });
  assert.equal(run["ok"], true);
  assert.deepEqual(executed, [
    { line: "/daemon list", attachments: [], hasSignal: true },
  ]);
  assert.equal(
    (run["result"] as Record<string, unknown>)["guardSkipped"],
    true,
  );
  const journal = (
    service["journal"] as (
      limit?: number,
      taskId?: string,
    ) => Record<string, unknown>[]
  )(5, id);
  assert.match(String(journal[0]?.["detail"]), /命令已执行；guardSkipped/);
});

test("事件面：dispose 回调撤销调度器, 重复触发幂等", async () => {
  const { host, service } = await boot();
  const status = service["status"] as () => {
    running: boolean;
    enabled: boolean;
  };
  assert.equal(status().running, true, "开启态装配后调度器应在运行");
  assert.equal(host.events.listeners.get("dispose")?.length, 1);

  host.events.emit("dispose");
  await waitFor(() => status().running === false);
  assert.equal(status().running, false);

  assert.doesNotThrow(() => host.events.emit("dispose"));
  assert.equal(status().running, false);
});

test("服务面：provide 与 get 同一实例, 状态视图字段齐全", async () => {
  const { host, state, service } = await boot();
  const getService = host.ctx["get"] as (name: string) => unknown;
  assert.equal(getService("backgroundDaemon"), service);
  for (const method of SERVICE_FACE_METHODS) {
    assert.equal(typeof service[method], "function", method);
  }
  const status = (
    service["status"] as () => Record<string, unknown>
  )() as Record<string, unknown>;
  assert.equal(status["running"], true);
  assert.equal(status["enabled"], true);
  assert.equal(status["records"], "json");
  assert.equal(status["rejectedRows"], 0);
  assert.deepEqual(status["channels"], ["deliver", "command"]);
  assert.equal(status["storeFile"], state.config.storePath);
  assert.equal(status["journalFile"], state.config.journalPath);
  assert.equal(status["taskCount"], 0);
  assert.equal(status["journalCount"], 0);
  assert.deepEqual((service["list"] as () => unknown[])(), []);
  assert.deepEqual((service["journal"] as () => unknown[])(), []);
});

test("服务面：memory 底座经 inject 晚挂后, 状态视图与写透同步切到 memory", async () => {
  const rows: { kind: string; title: string | null; content: string }[] = [];
  const specs: string[] = [];
  let nextId = 1;
  const memory = {
    registerKind(spec: { kind: string }) {
      specs.push(spec.kind);
      return {
        kind: spec.kind,
        writableTiers: ["session", "project", "user"],
        async put(input: { content: string; title?: string }) {
          rows.push({
            kind: spec.kind,
            title: input.title ?? null,
            content: input.content,
          });
          const id = nextId;
          nextId += 1;
          return { ids: [id], sourceId: 1, created: 1 };
        },
        async forget() {
          return 0;
        },
      };
    },
    async list() {
      return [];
    },
  };
  const { host, tool, service } = await boot({
    services: {},
    withInject: true,
  });
  const status = service["status"] as () => Record<string, unknown>;
  assert.equal(status()["records"], "json");
  assert.equal(host.services.pendingInject[0]?.deps[0], "memory");

  host.services.ready({ memory });
  await waitFor(() => status()["records"] === "memory");
  assert.equal(status()["records"], "memory");
  assert.deepEqual(specs, ["daemon_task", "daemon_run"]);

  assert.ok(tool !== null);
  const created = await tool.execute({
    action: "create",
    selector: { kind: "every_seconds", seconds: 60 },
    payload: "入库",
  });
  const id = String((created["task"] as Record<string, unknown>)["id"]);
  await waitFor(() => rows.some((row) => row.title === id));
  assert.ok(rows.some((row) => row.kind === "daemon_task" && row.title === id));
});
