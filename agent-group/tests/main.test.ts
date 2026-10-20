/**
 * 接入面测试（假宿主）：apply 期注册（不依赖服务）、服务惰性解析、`agent_group` 的 7 个动作、状态落盘（0600）、
 * 跨实例读回、运行期目录解析失败时的降级、可选镜像进 memory-base。
 *
 * 只碰本包与临时目录，不依赖 Redis / 真 session-channel（传输用假服务面）。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ToolDef } from "../src/main.ts";
import { apply, callerSessionIdOf, inject, name } from "../src/main.ts";

const MANAGER = "sess-manager";
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-group-test-"));
  tempDirs.push(dir);
  return dir;
}

/** 假 sessionPaths（结构面：`sessionDirFor` 是唯一必需方法）。 */
function fakePaths(root: string) {
  const state = { fail: false };
  const service = {
    root: () => root,
    projectKey: () => "--test--",
    projectDir: () => root,
    sessionDir: (_cwd: string | undefined, sessionId: string) =>
      join(root, `session-${sessionId}`),
    sessionDirFor: (sessionId: string) => {
      if (state.fail) {
        throw new Error(`会话「${sessionId}」不在宿主的 sessions 里`);
      }
      return join(root, `session-${sessionId}`);
    },
    ensureSessionDir: async () => root,
  };
  return { service, state };
}

/** 假 session-channel 服务面（真适配器 `createSessionChannelTransport` 会消费它）。 */
function fakeChannel() {
  const online = new Set<string>();
  const aliases = new Map<string, string>();
  const tasks = new Map<
    string,
    { status: string; result?: string; error?: string }
  >();
  const delegated: Array<{
    from?: string;
    to: string;
    text: string;
    timeoutSec?: number;
  }> = [];
  const sent: Array<{ to: string; text: string; waitMs?: number }> = [];
  const face = {
    async peers() {
      return {
        ok: true,
        peers: [...online].map((sessionId) => ({ sessionId })),
      };
    },
    async aliasList() {
      return {
        ok: true,
        aliases: [...aliases].map(([alias, sessionId]) => ({
          alias,
          sessionId,
          online: online.has(sessionId),
        })),
      };
    },
    async delegate(request: {
      from?: string;
      to: string;
      text: string;
      timeoutSec?: number;
    }) {
      const taskId = `task-${delegated.length + 1}`;
      delegated.push(request);
      tasks.set(taskId, { status: "running" });
      return { ok: true, task: { id: taskId } };
    },
    async send(request: { to: string; text: string; waitMs?: number }) {
      sent.push(request);
      return { ok: true, delivered: true };
    },
    async taskStatus(taskId: string) {
      const task = tasks.get(taskId);
      return task === undefined
        ? { ok: false, error: "task_not_found" }
        : { ok: true, task: { ...task } };
    },
  };
  return { face, online, aliases, tasks, delegated, sent };
}

/** 假 memory-base 服务面（`registerKind` 返回写句柄 `put`；写入记录进 `calls`）。 */
function fakeMemory() {
  const calls: Array<Record<string, unknown>> = [];
  const state = { fail: false };
  const face = {
    registerKind(_spec: { kind: string }) {
      return {
        put: async (input: Record<string, unknown>) => {
          if (state.fail) throw new Error("写库失败（测试注入）");
          calls.push(input);
          return { ids: [1], sourceId: 1, created: 1 };
        },
      };
    },
  };
  return { face, calls, state };
}

interface FakeHostBox {
  host: Record<string, unknown>;
  logs: string[];
  tools: ToolDef[];
}

function makeHost(services: Record<string, unknown>): FakeHostBox {
  const logs: string[] = [];
  const tools: ToolDef[] = [];
  const host = {
    logger: () => ({ info: (message: string) => void logs.push(message) }),
    get: (key: string) => services[key],
    sessions: services["sessions"],
    tools: {
      register: (def: unknown) => void tools.push(def as ToolDef),
    },
  };
  return { host, logs, tools };
}

/** 起一套完整环境（临时目录 + 假服务面）。 */
async function environment(options: { memory?: boolean } = {}) {
  const root = await tempDir();
  const paths = fakePaths(root);
  const channel = fakeChannel();
  channel.online.add("sess-alice");
  channel.online.add("sess-bob");
  channel.aliases.set("alice-alias", "sess-alice");
  const memory = fakeMemory();
  const services: Record<string, unknown> = {
    sessionChannel: channel.face,
    sessionPaths: paths.service,
    sessions: {
      get: (sessionId: string) =>
        sessionId === MANAGER || sessionId === "sess-alice"
          ? { header: { cwd: root } }
          : undefined,
    },
    ...(options.memory === false ? {} : { memory: memory.face }),
  };
  const box = makeHost(services);
  apply(box.host, {});
  const tool = box.tools.find((item) => item.name === "agent_group");
  assert.ok(tool, `应注册 agent_group 工具；日志：${box.logs.join(" | ")}`);
  const exec = { agent: { session: { id: MANAGER } } };
  const call = async (args: Record<string, unknown>) =>
    tool.execute(args, exec);
  return { root, paths, channel, memory, box, tool, call };
}

/** 宿主同口径的 lossless JSON 判定（`undefined` / 非有限数 / 非平凡原型一律非法）。 */
function isLosslessJson(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return value.every(isLosslessJson);
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isLosslessJson);
}

/**
 * 模拟 cordis ctx：**未 inject 的服务做属性读取会直接抛错**
 * （真实文案 `cannot get property "<name>" without inject`）。本包只把 `tools` 写进静态
 * `inject`，其余服务走 `ctx.inject` 动态分叉；假宿主没有 `inject` 时解析退回直读 —— 用
 * Proxy 把「直读未注入服务会抛」这条钉住，确保 apply 期不会裸读可选服务。
 */
function cordisLikeHost(options: {
  services?: Record<string, unknown>;
  omitTools?: boolean;
}) {
  const logs: string[] = [];
  const registered: ToolDef[] = [];
  const base: Record<string, unknown> = {
    get: (key: string) => options.services?.[key],
    logger: () => ({ info: (message: string) => void logs.push(message) }),
  };
  if (options.omitTools !== true) {
    base["tools"] = {
      register: (def: unknown) => void registered.push(def as ToolDef),
    };
  }
  const host = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { host, logs, registered };
}

/**
 * 假 cordis `ctx.inject`：还原真机形态 —— 兄弟 bundle 提供的服务**直读不到**（`get` 返回
 * `undefined`），只能经注入分叉的子 ctx 拿到。这是「工具注册不上」回归用例的基础设施。
 */
function injectedHost(services: Record<string, unknown>) {
  const logs: string[] = [];
  const registered: ToolDef[] = [];
  const host: Record<string, unknown> = {
    logger: () => ({ info: (message: string) => void logs.push(message) }),
    // 兄弟 fiber 提供的服务：直读一律拿不到（cordis 4.0.5 实测）
    get: (key: string) => (key === "tools" ? host["tools"] : undefined),
    tools: {
      register: (def: unknown) => void registered.push(def as ToolDef),
    },
    // 只有声明在 deps 里的服务，子分叉才看得到
    inject: (
      deps: string[],
      callback: (child: Record<string, unknown>) => unknown,
    ) => {
      const child: Record<string, unknown> = {
        get: (key: string) => (deps.includes(key) ? services[key] : undefined),
      };
      callback(child);
    },
  };
  return { host, logs, registered };
}

test("静态 inject 声明 tools（不声明时真机工具永远进不了工具表）", () => {
  assert.deepEqual(inject, ["tools"]);
});

test("真机形态：兄弟 bundle 的服务直读不到时，经 ctx.inject 分叉仍可用", async () => {
  const root = await tempDir();
  const channel = fakeChannel();
  channel.online.add("sess-alice");
  const memory = fakeMemory();
  const box = injectedHost({
    sessionChannel: channel.face,
    sessionPaths: fakePaths(root).service,
    sessions: { get: () => ({ header: { cwd: root } }) },
    memory: memory.face,
  });
  apply(box.host as never, {});
  assert.equal(
    box.registered.length,
    1,
    `工具应注册；日志：${box.logs.join(" | ")}`,
  );

  const tool = box.registered[0]!;
  const exec = { agent: { session: { id: MANAGER } } };
  const created = await tool.execute(
    { action: "create_group", name: "team" },
    exec,
  );
  assert.equal(created["ok"], true, JSON.stringify(created));
  const added = await tool.execute(
    {
      action: "add_member",
      group: "team",
      name: "alice",
      target: "sess-alice",
    },
    exec,
  );
  assert.equal(added["ok"], true, JSON.stringify(added));
  assert.equal(
    String(memory.calls.at(-1)?.["title"]).startsWith("agent-group "),
    true,
    "镜像应经分叉拿到 memory 服务并写入",
  );
  const file = join(root, `session-${MANAGER}`, "agent-group.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("宿主 ctx.inject 抛错：apply 不冒泡，工具照常注册", () => {
  const registered: ToolDef[] = [];
  const logs: string[] = [];
  const host: Record<string, unknown> = {
    logger: () => ({ info: (message: string) => void logs.push(message) }),
    get: (key: string) => (key === "tools" ? host["tools"] : undefined),
    tools: { register: (def: unknown) => void registered.push(def as ToolDef) },
    inject: () => {
      throw new Error("注入面坏了（测试注入）");
    },
  };
  assert.doesNotThrow(() => apply(host as never, {}));
  assert.equal(registered.length, 1);
  assert.ok(
    logs.some((line) => line.includes("服务注入失败")),
    `应记录注入失败：${logs.join(" | ")}`,
  );
});

test("未 inject 的宿主：服务齐全时正常注册（属性回退读取不冒泡）", async () => {
  const root = await tempDir();
  const box = cordisLikeHost({
    services: {
      sessionChannel: fakeChannel().face,
      sessionPaths: fakePaths(root).service,
    },
  });
  assert.doesNotThrow(
    () => apply(box.host as never, {}),
    "未声明服务（sessions / memory）的属性读取抛错必须被吞掉",
  );
  assert.equal(box.registered.length, 1);
  assert.equal(box.registered[0]?.name, "agent_group");
});

test("未 inject 的宿主：服务缺失时仍注册（apply 不抛、无服务读取）", async () => {
  const box = cordisLikeHost({ services: {} });
  assert.doesNotThrow(() => apply(box.host as never, {}));
  assert.equal(box.registered.length, 1, "工具必须注册");
  assert.deepEqual(box.logs, [], "注册期不为依赖发警告（改为调用期错误）");
  const result = await box.registered[0]!.execute(
    { action: "status", group: "team" },
    { agent: { session: { id: MANAGER } } },
  );
  assert.equal(result["ok"], false);
  assert.equal(result["error"], "session_channel_unavailable");
  assert.match(String(result["next"]), /session-channel/);
});

test("未 inject 的宿主：tools 属性也抛错时按「未挂载」降级（不冒泡）", async () => {
  const root = await tempDir();
  const box = cordisLikeHost({
    services: {
      sessionChannel: fakeChannel().face,
      sessionPaths: fakePaths(root).service,
    },
    omitTools: true,
  });
  assert.doesNotThrow(() => apply(box.host as never, {}));
  assert.equal(box.registered.length, 0);
  assert.ok(
    box.logs.some((line) => line.includes("tools 未挂载")),
    `应有一条 tools 未挂载的警告：${box.logs.join(" | ")}`,
  );
});

test("极端宿主：连 ctx.get 与 logger 都抛错时 apply 仍不抛", () => {
  const host = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    },
  );
  assert.doesNotThrow(() => apply(host as never, {}));
});

test("注册期不依赖服务：服务缺失也照常注册工具，调用时返回可用性错误", async () => {
  const cases: Array<{
    label: string;
    services: Record<string, unknown>;
    error: string;
  }> = [
    {
      label: "缺 sessionChannel",
      services: {},
      error: "session_channel_unavailable",
    },
    {
      label: "sessionChannel 缺 delegate",
      services: { sessionChannel: { peers: async () => ({ ok: true }) } },
      error: "session_channel_unavailable",
    },
    {
      label: "缺 sessionPaths",
      services: { sessionChannel: fakeChannel().face },
      error: "session_paths_unavailable",
    },
    {
      label: "sessionPaths 缺 sessionDirFor",
      services: {
        sessionChannel: fakeChannel().face,
        sessionPaths: { root: () => "/tmp" },
      },
      error: "session_paths_unavailable",
    },
  ];
  for (const item of cases) {
    const box = makeHost(item.services);
    apply(box.host, {});
    assert.equal(
      box.tools.length,
      1,
      `${item.label}：工具必须在 apply 期注册（晚注册会进不了工具表）`,
    );
    const result = await box.tools[0]!.execute(
      { action: "status", group: "team" },
      { agent: { session: { id: MANAGER } } },
    );
    assert.equal(result["ok"], false, item.label);
    assert.equal(result["error"], item.error, item.label);
    assert.match(String(result["reason"]), /不可用/, item.label);
    assert.match(String(result["next"]), /profile/, item.label);
  }
});

test("apply 期完全不读 sessionChannel / sessionPaths（只注册，解析留到调用）", () => {
  let reads = 0;
  const services = new Proxy(
    {},
    {
      get() {
        reads += 1;
        throw new Error("注册期不该读服务");
      },
    },
  ) as Record<string, unknown>;
  const registered: ToolDef[] = [];
  const tools = {
    register: (def: unknown) => void registered.push(def as ToolDef),
  };
  const host = {
    logger: () => ({ info: () => {} }),
    // `tools` 是注册面本身，不算「依赖服务」；其余键落到会抛错的 proxy 上
    get: (key: string) => (key === "tools" ? tools : services[key]),
    tools,
  };
  assert.doesNotThrow(() => apply(host, {}));
  assert.equal(registered.length, 1, "工具照常注册");
  assert.equal(reads, 0, "注册期读取依赖服务次数应为 0");
});

test("惰性解析会自愈：先缺服务报错，服务到位后同一工具即可用", async () => {
  const root = await tempDir();
  const services: Record<string, unknown> = {};
  const box = makeHost(services);
  apply(box.host, { mirror: false });
  const tool = box.tools[0]!;
  const exec = { agent: { session: { id: MANAGER } } };

  const missing = await tool.execute({ action: "status", group: "team" }, exec);
  assert.equal(missing["error"], "session_channel_unavailable");

  // 服务晚到（宿主稍后 provide）：下一次调用应重新解析成功
  services["sessionChannel"] = fakeChannel().face;
  services["sessionPaths"] = fakePaths(root).service;
  const created = await tool.execute(
    { action: "create_group", name: "team" },
    exec,
  );
  assert.equal(created["ok"], true, JSON.stringify(created));
  assert.equal(created["group"], "team");
});

test("enabled: false 时不注册也不警告", () => {
  const box = makeHost({
    sessionChannel: fakeChannel().face,
    sessionPaths: fakePaths("/tmp").service,
  });
  apply(box.host, { enabled: false });
  assert.equal(box.tools.length, 0);
  assert.deepEqual(box.logs, []);
});

test("工具定义：动作、参数与描述齐备，render 输出字符串", async () => {
  const env = await environment();
  assert.equal(name, "agent-group");
  assert.equal(env.tool.name, "agent_group");
  const parameters = env.tool.parameters as {
    properties: { action: { enum: string[] } };
    required: string[];
  };
  assert.deepEqual(parameters.properties.action.enum, [
    "create_group",
    "add_member",
    "link",
    "link_peer",
    "send",
    "send_peer",
    "broadcast",
    "check",
    "remove",
    "status",
  ]);
  assert.deepEqual(parameters.required, ["action"]);
  assert.match(env.tool.description, /每.*主从连接.*未结/);
  assert.match(env.tool.description, /link_peer/);
  const rendered = env.tool.output.render({}, { ok: true, value: 1 });
  assert.equal(rendered[0]?.type, "text");
  assert.match(String(rendered[0]?.text), /"value": 1/);
});

test("端到端（假服务面）：建组 → 加成员（别名解析）→ link → send → check → status → remove", async () => {
  const env = await environment();
  const results: Array<Record<string, unknown>> = [];
  const created = await env.call({ action: "create_group", name: "team" });
  results.push(created);
  assert.equal(created["ok"], true, JSON.stringify(created));
  assert.equal(created["group"], "team");

  const added = await env.call({
    action: "add_member",
    group: "team",
    name: "alice",
    target: "alice-alias",
  });
  results.push(added);
  assert.equal(added["ok"], true, JSON.stringify(added));
  assert.equal(added["sessionId"], "sess-alice", "别名应解析成会话 id");
  const addedBob = await env.call({
    action: "add_member",
    group: "team",
    name: "bob",
    target: "sess-bob",
  });
  results.push(addedBob);
  assert.equal(addedBob["ok"], true);

  const linked = await env.call({
    action: "link",
    group: "team",
    from: "manager",
    to: "alice",
  });
  results.push(linked);
  assert.equal(linked["ok"], true, JSON.stringify(linked));
  assert.equal(linked["level"], 1);

  const sent = await env.call({
    action: "send",
    group: "team",
    to: "alice",
    text: "写一份设计",
    timeoutMs: 60_000,
  });
  results.push(sent);
  assert.equal(sent["ok"], true, JSON.stringify(sent));
  assert.equal(sent["taskId"], "task-1");
  assert.deepEqual(
    {
      from: env.channel.delegated[0]?.from,
      to: env.channel.delegated[0]?.to,
      text: env.channel.delegated[0]?.text,
    },
    { from: MANAGER, to: "sess-alice", text: "写一份设计" },
  );

  const stillOpen = await env.call({ action: "check", group: "team" });
  results.push(stillOpen);
  assert.deepEqual(stillOpen["open"], ["alice"]);
  assert.deepEqual(stillOpen["settled"], []);

  env.channel.tasks.set("task-1", { status: "done", result: "设计在这" });
  const checked = await env.call({ action: "check", group: "team" });
  results.push(checked);
  assert.equal(checked["ok"], true);
  const settled = checked["settled"] as Array<Record<string, unknown>>;
  assert.equal(settled[0]?.["status"], "success");
  assert.equal(settled[0]?.["result"], "设计在这");

  const status = await env.call({ action: "status", group: "team" });
  results.push(status);
  assert.equal(status["ok"], true);
  const view = status["view"] as {
    members: Array<{ name: string; level: number; principal: string | null }>;
    summary: { success: number; open: number };
  };
  assert.equal(view.summary.success, 1);
  assert.equal(view.summary.open, 0);
  assert.equal(
    view.members.find((member) => member.name === "alice")?.principal,
    "manager",
  );

  const removed = await env.call({
    action: "remove",
    group: "team",
    name: "bob",
  });
  results.push(removed);
  assert.equal(removed["ok"], true, JSON.stringify(removed));

  for (const result of results) {
    assert.ok(
      isLosslessJson(result),
      `返回体应 lossless JSON：${JSON.stringify(result)}`,
    );
  }
});

test("状态落盘：0600、原子写、跨实例读回；镜像内容带 kind 与组视图", async () => {
  const env = await environment();
  await env.call({ action: "create_group", name: "team" });
  await env.call({
    action: "add_member",
    group: "team",
    name: "alice",
    target: "alice-alias",
  });

  const file = join(env.root, `session-${MANAGER}`, "agent-group.json");
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, `状态文件应为 0600，实际 ${mode.toString(8)}`);
  const saved = JSON.parse(await readFile(file, "utf8")) as {
    version: number;
    managerSessionId: string;
    groups: Record<string, { members: Record<string, unknown> }>;
  };
  assert.equal(saved.version, 1);
  assert.equal(saved.managerSessionId, MANAGER);
  assert.ok(saved.groups["team"]?.members["alice"]);

  // 跨实例读回：新 apply 一套（模拟进程重启）后 status 从磁盘读
  const services = {
    sessionChannel: env.channel.face,
    sessionPaths: env.paths.service,
    sessions: { get: () => ({ header: { cwd: env.root } }) },
  };
  const box = makeHost(services);
  apply(box.host, { mirror: false });
  const tool = box.tools[0];
  assert.ok(tool);
  const status = await tool.execute(
    { action: "status", group: "team" },
    { agent: { session: { id: MANAGER } } },
  );
  assert.equal(status["ok"], true, JSON.stringify(status));
  const view = status["view"] as {
    members: Array<{ name: string; target: string }>;
  };
  assert.deepEqual(view.members.map((member) => member.name).sort(), [
    "alice",
    "manager",
  ]);

  // 镜像：每次变更经 registerKind 拿到的写句柄写入 session 层（sessionId / project / source.ref）
  const last = env.memory.calls.at(-1);
  assert.ok(last, "应有镜像写入");
  assert.equal(last["sessionId"], MANAGER);
  assert.equal(last["project"], env.root, "project 取管理者会话的 cwd");
  assert.match(String(last["title"]), /^agent-group team$/);
  const source = last["source"] as { kind?: string; ref?: string };
  assert.equal(source.kind, "manual");
  assert.equal(typeof source.ref, "string");
  const content = JSON.parse(String(last["content"])) as {
    name: string;
    members: unknown[];
  };
  assert.equal(content.name, "team");
  assert.equal(content.members.length, 2);
});

test("向后兼容：旧落盘文件缺 peerLinks 时按空补齐（status 可读、link_peer 可用）", async () => {
  const env = await environment();
  await env.call({ action: "create_group", name: "team" });
  await env.call({
    action: "add_member",
    group: "team",
    name: "alice",
    target: "alice-alias",
  });
  // 手工改写成旧版落盘形状（无 peerLinks 字段）
  const file = join(env.root, `session-${MANAGER}`, "agent-group.json");
  const legacy = JSON.parse(await readFile(file, "utf8")) as {
    groups: Record<string, Record<string, unknown>>;
  };
  delete legacy.groups["team"]?.["peerLinks"];
  await writeFile(file, JSON.stringify(legacy), "utf8");

  // 新实例读回（模拟旧文件 + 新代码）：status 正常、link_peer 可建
  const services = {
    sessionChannel: env.channel.face,
    sessionPaths: env.paths.service,
    sessions: { get: () => ({ header: { cwd: env.root } }) },
  };
  const box = makeHost(services);
  apply(box.host, { mirror: false });
  const tool = box.tools[0];
  assert.ok(tool);
  const status = await tool.execute(
    { action: "status", group: "team" },
    { agent: { session: { id: MANAGER } } },
  );
  assert.equal(status["ok"], true, JSON.stringify(status));
  const linked = await tool.execute(
    { action: "link_peer", group: "team", from: "manager", to: "alice" },
    { agent: { session: { id: MANAGER } } },
  );
  assert.equal(linked["ok"], true, JSON.stringify(linked));
  assert.equal(
    (linked["view"] as { summary: { peerLinks: number } }).summary.peerLinks,
    1,
  );
});

test("运行期目录解析失败：写动作报 state_unavailable（带原因 + 下一步），status 仍可读", async () => {
  const env = await environment();
  await env.call({ action: "create_group", name: "team" });
  env.paths.state.fail = true;

  const failed = await env.call({
    action: "add_member",
    group: "team",
    name: "alice",
    target: "alice-alias",
  });
  assert.equal(failed["ok"], false);
  assert.equal(failed["error"], "state_unavailable");
  assert.match(String(failed["reason"]), /sessions/);
  assert.match(String(failed["next"]), /sessionDirFor/);

  const status = await env.call({ action: "status", group: "team" });
  assert.equal(status["ok"], true, "只读视图命中缓存，不碰存储");
  assert.equal((status["view"] as { name: string }).name, "team");
});

test("无调用方会话：返回 no_caller（服务面 / 无 exec 调用没有管理者身份）", async () => {
  const env = await environment();
  const result = await env.tool.execute({ action: "status", group: "x" });
  assert.equal(result["ok"], false);
  assert.equal(result["error"], "no_caller");
  assert.match(String(result["next"]), /agent/);
  assert.equal(callerSessionIdOf({ agent: { session: { id: "s" } } }), "s");
  assert.equal(callerSessionIdOf({}), undefined);
});

test("镜像失败只计数不重试，动作仍成功；memory-base 缺失时镜像是关闭状态", async () => {
  const env = await environment();
  await env.call({ action: "create_group", name: "team" });
  const before = env.memory.calls.length;
  env.memory.state.fail = true;
  const added = await env.call({
    action: "add_member",
    group: "team",
    name: "alice",
    target: "alice-alias",
  });
  assert.equal(added["ok"], true, "镜像失败不影响动作");
  const status = await env.call({ action: "status", group: "team" });
  const mirror = status["mirror"] as {
    enabled: boolean;
    ok: number;
    failed: number;
    lastError?: string;
  };
  assert.equal(mirror.enabled, true);
  assert.ok(mirror.failed >= 1);
  assert.match(String(mirror.lastError), /写库失败/);
  assert.equal(env.memory.calls.length, before, "失败不写入");

  const noMemory = await environment({ memory: false });
  await noMemory.call({ action: "create_group", name: "team" });
  const plain = await noMemory.call({ action: "status", group: "team" });
  assert.equal((plain["mirror"] as { enabled: boolean }).enabled, false);
});

test("拒绝路径：未知 action、没有主从连接的 send、非叶子的 remove 都带原因与下一步", async () => {
  const env = await environment();

  const unknown = await env.call({ action: "nope" });
  assert.equal(unknown["ok"], false);
  assert.equal(unknown["error"], "unknown_action");

  await env.call({ action: "create_group", name: "team" });
  await env.call({
    action: "add_member",
    group: "team",
    name: "alice",
    target: "alice-alias",
  });
  await env.call({
    action: "add_member",
    group: "team",
    name: "bob",
    target: "sess-bob",
  });
  const noPrincipal = await env.call({
    action: "send",
    group: "team",
    to: "alice",
    text: "任务",
  });
  assert.equal(noPrincipal["error"], "no_principal");
  assert.match(String(noPrincipal["next"]), /link/);

  await env.call({
    action: "link",
    group: "team",
    from: "manager",
    to: "alice",
  });
  await env.call({
    action: "link",
    group: "team",
    from: "alice",
    to: "bob",
  });
  const notLeaf = await env.call({
    action: "remove",
    group: "team",
    name: "alice",
  });
  assert.equal(notLeaf["error"], "not_leaf");
  assert.match(String(notLeaf["reason"]), /bob/);
  assert.ok(Array.isArray(notLeaf["subordinates"]));
});

test("状态文件损坏：报 state_unavailable（不静默重置），提示删掉后重建", async () => {
  const env = await environment();
  await env.call({ action: "create_group", name: "team" });
  const file = join(env.root, `session-${MANAGER}`, "agent-group.json");
  await writeFile(file, "{not json", "utf8");

  const box = makeHost({
    sessionChannel: env.channel.face,
    sessionPaths: env.paths.service,
  });
  apply(box.host, { mirror: false });
  const tool = box.tools[0];
  assert.ok(tool);
  const status = await tool.execute(
    { action: "status", group: "team" },
    { agent: { session: { id: MANAGER } } },
  );
  assert.equal(status["ok"], false);
  assert.equal(status["error"], "state_unavailable");
  assert.match(String(status["reason"]), /JSON/);
  assert.match(String(status["next"]), /删掉/);
});

test("端到端（假服务面）：link_peer → send_peer → broadcast 全绿、不产生未结", async () => {
  const env = await environment();
  await env.call({ action: "create_group", name: "team" });
  await env.call({
    action: "add_member",
    group: "team",
    name: "alice",
    target: "alice-alias",
  });
  await env.call({
    action: "add_member",
    group: "team",
    name: "bob",
    target: "sess-bob",
  });

  const linked = await env.call({
    action: "link_peer",
    group: "team",
    from: "manager",
    to: "bob",
  });
  assert.equal(linked["ok"], true, JSON.stringify(linked));
  assert.equal(
    (linked["view"] as { summary: { peerLinks: number } }).summary.peerLinks,
    1,
  );

  const sentPeer = await env.call({
    action: "send_peer",
    group: "team",
    to: "bob",
    text: "平等连接你好",
  });
  assert.equal(sentPeer["ok"], true, JSON.stringify(sentPeer));
  assert.equal(sentPeer["delivered"], true);
  assert.deepEqual(
    env.channel.sent.map((s) => ({ to: s.to, text: s.text })),
    [{ to: "sess-bob", text: "平等连接你好" }],
  );

  const cast = await env.call({
    action: "broadcast",
    group: "team",
    text: "全体集合",
  });
  assert.equal(cast["ok"], true, JSON.stringify(cast));
  assert.deepEqual(cast["targets"], ["alice", "bob"]);
  assert.equal((cast["delivery"] as { delivered: number }).delivered, 2);
  assert.deepEqual(
    env.channel.sent
      .slice(-2)
      .map((s) => s.to)
      .sort(),
    ["sess-alice", "sess-bob"],
  );

  const status = await env.call({ action: "status", group: "team" });
  const view = status["view"] as {
    summary: { open: number; peerLinks: number };
    instructions: unknown[];
  };
  assert.equal(view.summary.open, 0, "平等 / 广播不产生未结指令");
  assert.equal(view.summary.peerLinks, 1);
  assert.equal(view.instructions.length, 0);
});
