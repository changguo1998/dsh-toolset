/**
 * 集成层装配器（不以 `.test.ts` 结尾）：把「假工具面 / 假事件面 / 假服务面」拼成一个最小
 * 宿主 ctx，交给本包的 `apply(ctx, config)`。
 *
 * 三个假面的形状与阶段 2 规范 4.2 一致，换包时可复用同一套写法：
 * - 工具面：收集 `register(def)`，并把注册到的工具交给用例调用；
 * - 事件面：记录 `on(event, listener)`（本包不订阅事件，用例据此钉住边界）；
 * - 服务面：`get(key)` 一次返回全部假服务，`provide(name, value)` 记录本包提供的服务。
 *
 * 只依赖本包 `src/` 与 Node 标准库；落盘走临时目录（由用例传 `root`）。
 */

import { join } from "node:path";
import type { AgentGroupReadService, ToolDef } from "../src/index.ts";
import { apply } from "../src/index.ts";
import type { AgentGroupConfig } from "../src/types.ts";

/** 假工具面：注册即收集。 */
export function fakeToolsFace() {
  const registered: ToolDef[] = [];
  return {
    registered,
    register(def: unknown) {
      registered.push(def as ToolDef);
      return def;
    },
  };
}

/** 假事件面：只记录订阅（本包应当一次都不订阅）。 */
export function fakeEventsFace() {
  const subscriptions: Array<{ event: string; listener: unknown }> = [];
  return {
    subscriptions,
    on(event: string, listener: unknown) {
      subscriptions.push({ event, listener });
      return () => {};
    },
    emit() {},
  };
}

/** 假 sessionPaths：`sessionDirFor` 是唯一必需方法，可注入抛错。 */
export function fakeSessionPaths(root: string) {
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

/** 假 session-channel 服务面（真适配器会消费它；状态牌可缺省，模拟旧版）。 */
export function fakeSessionChannel(options: { statusOf?: boolean } = {}) {
  const online = new Set<string>();
  const aliases = new Map<string, string>();
  const tasks = new Map<
    string,
    { status: string; result?: string; error?: string }
  >();
  const agentStates = new Map<
    string,
    { status: "idle" | "running"; at: number }
  >();
  const delegated: Array<{
    from?: string;
    to: string;
    text: string;
    timeoutSec?: number;
  }> = [];
  const sent: Array<{ to: string; text: string; waitMs?: number }> = [];
  const face: Record<string, unknown> = {
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
  if (options.statusOf !== false) {
    face["statusOf"] = async (sessionId: string) => {
      const state = agentStates.get(sessionId);
      return {
        ok: true,
        ...(state === undefined ? {} : { state }),
      };
    };
  }
  return { face, online, aliases, tasks, agentStates, delegated, sent };
}

/** 假宿主 `sessions` 服务（只用到 `get(id).header.cwd`）。 */
export function fakeSessions(cwdOf: (sessionId: string) => string | undefined) {
  return {
    get: (sessionId: string) =>
      cwdOf(sessionId) === undefined
        ? undefined
        : { header: { cwd: cwdOf(sessionId) } },
  };
}

/** 假 memory-base 服务面（`registerKind` → 写句柄 `put`）。 */
export function fakeMemory() {
  const registrations: Array<{ kind: string }> = [];
  const writes: Array<Record<string, unknown>> = [];
  const state = { fail: false };
  const face = {
    registerKind(spec: { kind: string }) {
      registrations.push(spec);
      return {
        put: async (input: Record<string, unknown>) => {
          if (state.fail) throw new Error("写库失败（测试注入）");
          writes.push(input);
          return { ids: [1], created: 1 };
        },
      };
    },
  };
  return { face, registrations, writes, state };
}

/** 集合形态的服务面环境：`services` 只放用例给到的假服务。 */
export interface AssemblyOptions {
  root: string;
  /** 是否挂 sessionChannel / sessionPaths / sessions / memory（缺省全挂）。 */
  with?: {
    channel?: boolean;
    paths?: boolean;
    sessions?: boolean;
    memory?: boolean;
  };
  /** session-channel 是否提供状态牌读数面（缺省提供）。 */
  statusOf?: boolean;
  /** 宿主是否提供 `provide` 面（缺省提供）。 */
  provide?: boolean;
  /** 宿主是否提供 `tools` 面（缺省提供）。 */
  tools?: boolean;
  config?: AgentGroupConfig;
}

/** 装配结果：注册面、提供面、日志与调用入口。 */
export interface Assembly {
  tools: string[];
  registered: ToolDef[];
  provided: Map<string, unknown>;
  logs: string[];
  ctx: Record<string, unknown>;
  channel: ReturnType<typeof fakeSessionChannel>;
  paths: ReturnType<typeof fakeSessionPaths>;
  memory: ReturnType<typeof fakeMemory>;
  /** 当前注册到的 `agent_group` 工具（没注册到则抛）。 */
  tool(): ToolDef;
  /** 以某个会话身份执行 `agent_group`（缺省管理者会话）。 */
  call(
    args: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
}

/** 管理者会话 id（用例共用）。 */
export const MANAGER = "sess-manager";

/** 拼假宿主并调 `apply`。 */
export function assemble(options: AssemblyOptions): Assembly {
  const withFaces = {
    channel: options.with?.channel ?? true,
    paths: options.with?.paths ?? true,
    sessions: options.with?.sessions ?? true,
    memory: options.with?.memory ?? true,
  };
  const channel = fakeSessionChannel({ statusOf: options.statusOf });
  const paths = fakeSessionPaths(options.root);
  const memory = fakeMemory();
  const services: Record<string, unknown> = {
    ...(withFaces.channel ? { sessionChannel: channel.face } : {}),
    ...(withFaces.paths ? { sessionPaths: paths.service } : {}),
    ...(withFaces.sessions
      ? { sessions: fakeSessions(() => options.root) }
      : {}),
    ...(withFaces.memory ? { memory: memory.face } : {}),
  };

  const toolsFace = fakeToolsFace();
  const events = fakeEventsFace();
  const logs: string[] = [];
  const provided = new Map<string, unknown>();
  const ctx: Record<string, unknown> = {
    logger: () => ({ info: (message: string) => void logs.push(message) }),
    get: (key: string) => services[key],
    events,
    ...(options.tools === false ? {} : { tools: toolsFace }),
    ...(options.provide === false
      ? {}
      : {
          provide: (serviceName: string, value: unknown) => {
            provided.set(serviceName, value);
          },
        }),
  };

  apply(ctx, options.config ?? {});

  const tool = (): ToolDef => {
    const found = toolsFace.registered.find(
      (item) => item.name === "agent_group",
    );
    if (found === undefined) {
      throw new Error(`未注册 agent_group 工具；日志：${logs.join(" | ")}`);
    }
    return found;
  };

  return {
    tools: toolsFace.registered.map((item) => item.name),
    registered: toolsFace.registered,
    provided,
    logs,
    ctx,
    channel,
    paths,
    memory,
    tool,
    async call(args, sessionId = MANAGER) {
      return tool().execute(args, { agent: { session: { id: sessionId } } });
    },
  };
}

/** 取本包提供的只读服务面（TUI `/group` 的消费面）。 */
export function readService(assembly: Assembly): AgentGroupReadService {
  const service = assembly.provided.get("agentGroup");
  if (service === undefined) throw new Error("未提供 agentGroup 服务面");
  return service as AgentGroupReadService;
}
