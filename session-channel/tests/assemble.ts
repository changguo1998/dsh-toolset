/**
 * 集成层装配器 (不以 `.test.ts` 结尾): 把「假工具面 / 假事件面 / 假服务面」拼成最小宿主 ctx,
 * 交给本包 `apply(ctx, config)`; 再把注册到的四个工具、`sessionChannel` 服务面与宿主事件面
 * 交回用例. 三个假面的形状与阶段 2 规范 4.2 一致.
 *
 * 外部世界全部是替身, 不连真 Redis、不建 socket:
 * - 假工具面: 收集 `register(def)`, 用例按工具名取回后调 `execute` / `output.render`;
 * - 假事件面: 记录 `on(event, listener)` 并可手动 `emit`, 用例据此核对订阅面与注入内容;
 * - 假服务面: `get(key)` 返回 `agents` / `sessions` 替身 (注入面), `provide` 记录本包提供的服务;
 * - 假 broker: `createFakeRedis()` 是内存版 Redis (字符串 / 列表 / 流 / 扫描 / EVAL),
 *   经 `SessionChannelDeps.connect` 注入 `createSessionChannelService`.
 *
 * `apply` 自身不接 deps (见追踪文档「偏差」), 故 `wireLive()` 先用 `apply` 拿到注册面,
 * 再把该服务实例的服务面方法接到「假 broker 上的真服务」—— 工具与 `provide` 面闭包都按
 * 属性名延迟取值 (`service.peers()`), 因此接线后走的是同一份真实现.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { RedisClientType } from "redis";
import type { SessionChannelConnection } from "../src/client.ts";
import type { BundleHost, SessionChannelService } from "../src/index.ts";
import {
  apply,
  createSessionChannelService,
  getSessionChannelService,
  SERVICE_FACE_METHODS,
} from "../src/index.ts";
import type { SessionChannelConfig } from "../src/types.ts";

/** 工具定义 (注册面最小形态). */
export interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  output: {
    schema?: Record<string, unknown>;
    render(
      args: unknown,
      value: unknown,
    ): Array<{ type?: string; text?: unknown }>;
  };
}

/** 事件面记录项. */
export interface Subscription {
  event: string;
  listener: (session: unknown, event: unknown) => void;
}

/** 假宿主与三个假面拼出的装配结果. */
export interface Assembly {
  /** apply 收到的宿主 ctx. */
  ctx: Record<string, unknown>;
  /** 注册到的工具名 (注册顺序). */
  tools: string[];
  /** 四个工具定义. */
  registered: ToolDef[];
  /** 事件订阅记录 (apply 面 + wireLive 后的真服务). */
  subscriptions: Subscription[];
  /** `provide` 记录. */
  provided: Map<string, unknown>;
  /** 本包日志. */
  logs: string[];
  /** 注入到会话的消息 (假 agent 的 `followup` 收到). */
  injected: unknown[];
  /** `sessions.flush` 收到的会话. */
  flushed: unknown[];
  /** 会话替身注册表 (用例可加/删 agent). */
  agents: Map<string, FakeAgent>;
  /** apply 建的服务实例 (wireLive 会把服务面方法接到真服务上). */
  serviceInstance: SessionChannelService;
  /** `wireLive` 登记的连接态服务停止函数 (stop 时逐个调用). */
  liveStops: Array<() => Promise<void>>;
  /** 取某个已注册工具 (未注册即抛). */
  tool(name: string): ToolDef;
  /** 以 `exec` 身份调某工具. */
  call(
    name: string,
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  /** 触发一次已订阅事件. */
  emit(event: string, ...args: unknown[]): void;
  /** 停止 apply 面服务与 wireLive 面服务. */
  stop(): Promise<void>;
}

/** 会话替身 (注入面只需 `followup`). */
export interface FakeAgent {
  session?: unknown;
  followup(message: unknown): void;
}

/** 装配选项. */
export interface AssemblyOptions {
  /** apply 的配置 (缺省 `disabled: true`, 保证不发起连接). */
  config?: SessionChannelConfig;
  /** 是否挂工具面 (缺省挂). */
  tools?: boolean;
  /** 是否挂 provide 面 (缺省挂). */
  provide?: boolean;
  /** 是否用 `ctx.agents` 直读暴露 agent (缺省 false: 只走服务面 `get("agents")`). */
  directAgents?: boolean;
  /** 是否提供 `sessions.flush` (缺省提供). */
  flush?: boolean;
}

/** 注册一个可捕获注入的会话替身. */
export function registerAgent(
  assembly: Assembly,
  sessionId: string,
  sink: unknown[] = assembly.injected,
): FakeAgent {
  const agent: FakeAgent = {
    session: { id: sessionId },
    followup: (message: unknown) => void sink.push(message),
  };
  assembly.agents.set(sessionId, agent);
  return agent;
}

/** 等条件成立 (缺省 3s 上限). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await sleep(10);
  }
}

/** 拼假宿主并调 `apply`. */
export function assemble(options: AssemblyOptions = {}): Assembly {
  const injected: unknown[] = [];
  const flushed: unknown[] = [];
  const agents = new Map<string, FakeAgent>();
  const subscriptions: Subscription[] = [];
  const logs: string[] = [];
  const provided = new Map<string, unknown>();
  const registered: ToolDef[] = [];

  const agentsFace = {
    get: (id: string) => agents.get(id),
  };
  const sessionsFace = {
    flush: (session: unknown) => void flushed.push(session),
  };
  const services: Record<string, unknown> = {
    agents: agentsFace,
    ...(options.flush === false ? {} : { sessions: sessionsFace }),
  };

  const ctx: Record<string, unknown> = {
    logger: () => ({ info: (message: string) => void logs.push(message) }),
    get: (key: string) => services[key],
    on: (
      event: string,
      listener: (session: unknown, event: unknown) => void,
    ) => {
      subscriptions.push({ event, listener });
      return () => {
        const index = subscriptions.findIndex(
          (item) => item.event === event && item.listener === listener,
        );
        if (index >= 0) subscriptions.splice(index, 1);
      };
    },
    ...(options.tools === false
      ? {}
      : {
          tools: {
            register: (def: unknown) => {
              registered.push(def as ToolDef);
              return def;
            },
          },
        }),
    ...(options.provide === false
      ? {}
      : {
          provide: (key: string, value: unknown) => {
            provided.set(key, value);
          },
        }),
    ...(options.directAgents === true ? { agents: agentsFace } : {}),
  };

  apply(ctx as BundleHost & Record<string, unknown>, {
    disabled: true,
    instanceId: "integration",
    ...options.config,
  });
  const serviceInstance = getSessionChannelService();
  if (serviceInstance === undefined) throw new Error("apply 未登记服务实例");

  const tool = (toolName: string): ToolDef => {
    const found = registered.find((item) => item.name === toolName);
    if (found === undefined) {
      throw new Error(`未注册工具 ${toolName}; 日志: ${logs.join(" | ")}`);
    }
    return found;
  };

  const liveStops: Array<() => Promise<void>> = [];

  return {
    ctx,
    tools: registered.map((item) => item.name),
    registered,
    subscriptions,
    provided,
    logs,
    injected,
    flushed,
    agents,
    serviceInstance,
    liveStops,
    tool,
    async call(name, args, exec) {
      return tool(name).execute(args, exec);
    },
    emit(event, ...args) {
      for (const item of [...subscriptions]) {
        if (item.event === event) item.listener(args[0], args[1]);
      }
    },
    async stop() {
      for (const stop of liveStops.splice(0)) await stop();
      await serviceInstance.stop();
    },
  };
}

/** `wireLive` 返回的连接态句柄. */
export interface Live {
  service: SessionChannelService;
  redis: FakeRedis;
  stop(): Promise<void>;
}

/** 连接态选项. */
export interface LiveOptions {
  config?: SessionChannelConfig;
  /** 注入时刻 (任务超时懒判定用). */
  now?: () => number;
}

/**
 * 把 `apply` 已注册的工具 / 服务面接到「假 broker 上的真服务」:
 * 用 `createSessionChannelService` + 假 `connect` 起一份真服务, 再把 apply 服务实例的
 * 服务面方法逐条绑定到它 (工具与 provide 面都按属性名延迟取值, 故接线即生效).
 */
export async function wireLive(
  assembly: Assembly,
  options: LiveOptions = {},
): Promise<Live> {
  const redis = createFakeRedis();
  const service = createSessionChannelService(
    {
      instanceId: "integration-live",
      heartbeatMs: 60_000,
      presenceTtlSec: 60,
      readBlockMs: 20,
      ...options.config,
    },
    assembly.ctx as BundleHost,
    {
      connect: async () => redis.connection,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
  await service.start();
  const target = assembly.serviceInstance as unknown as Record<string, unknown>;
  const source = service as unknown as Record<string, unknown>;
  for (const method of SERVICE_FACE_METHODS) {
    const fn = source[method];
    if (typeof fn === "function") {
      target[method] = (fn as (...args: unknown[]) => unknown).bind(service);
    }
  }
  const handle: Live = {
    service,
    redis,
    stop: async () => {
      await service.stop();
    },
  };
  assembly.liveStops.push(handle.stop);
  return handle;
}

// ---------------------------------------------------------------------------
// 假 broker: 内存版 Redis (只实现本包用到的命令面)
// ---------------------------------------------------------------------------

/** 字符串键 (带可选过期时刻). */
interface StoredValue {
  value: string;
  expiresAt?: number;
}

/** 流条目. */
interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

/** 内存版 Redis 实例与观测面. */
export interface FakeRedis {
  connection: SessionChannelConnection;
  /** 主连接 (与 reader 共用同一份内存状态). */
  main: RedisClientType;
  /** 读连接. */
  reader: RedisClientType;
  values: Map<string, StoredValue>;
  lists: Map<string, string[]>;
  streams: Map<string, StreamEntry[]>;
  /** 已执行的命令名 (排障用). */
  commands: string[];
}

/** 流 id 比较 (`<ms>-<seq>`). */
function compareStreamId(a: string, b: string): number {
  const [aMs, aSeq] = a.split("-");
  const [bMs, bSeq] = b.split("-");
  const ms = Number(aMs ?? 0) - Number(bMs ?? 0);
  if (ms !== 0) return ms;
  return Number(aSeq ?? 0) - Number(bSeq ?? 0);
}

/** glob (`*` 通配) → 正则. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

/** 建一份内存版 Redis (main / reader 共用一个 store). */
export function createFakeRedis(): FakeRedis {
  const values = new Map<string, StoredValue>();
  const lists = new Map<string, string[]>();
  const streams = new Map<string, StreamEntry[]>();
  const commands: string[] = [];
  let streamMs = 0;
  let streamSeq = 0;

  const nextStreamId = (): string => {
    const ms = now();
    if (ms === streamMs) streamSeq += 1;
    else {
      streamMs = ms;
      streamSeq = 0;
    }
    return `${ms}-${streamSeq}`;
  };

  const now = (): number => Date.now();

  const valueOf = (key: string): string | null => {
    const stored = values.get(key);
    if (stored === undefined) return null;
    if (stored.expiresAt !== undefined && stored.expiresAt <= now()) {
      values.delete(key);
      return null;
    }
    return stored.value;
  };

  const keysOf = (): string[] => {
    const out = new Set<string>();
    for (const key of [...values.keys(), ...lists.keys(), ...streams.keys()]) {
      if (values.has(key) && valueOf(key) === null) continue;
      out.add(key);
    }
    return [...out];
  };

  const facade = {
    async connect(): Promise<void> {
      commands.push("connect");
    },
    async quit(): Promise<string> {
      commands.push("quit");
      return "OK";
    },
    destroy(): void {
      commands.push("destroy");
    },
    on(): void {},
    isOpen: true,
    async get(key: string): Promise<string | null> {
      commands.push("get");
      return valueOf(key);
    },
    async set(
      key: string,
      value: string,
      opts: { EX?: number; KEEPTTL?: boolean } = {},
    ): Promise<string> {
      commands.push("set");
      const previous = values.get(key);
      const expiresAt =
        opts.EX !== undefined
          ? now() + opts.EX * 1000
          : opts.KEEPTTL === true
            ? previous?.expiresAt
            : undefined;
      values.set(key, {
        value,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      return "OK";
    },
    async del(key: string | string[]): Promise<number> {
      commands.push("del");
      const keys = Array.isArray(key) ? key : [key];
      let removed = 0;
      for (const item of keys) {
        if (values.delete(item)) removed += 1;
        if (lists.delete(item)) removed += 1;
        if (streams.delete(item)) removed += 1;
      }
      return removed;
    },
    async expire(key: string, seconds: number): Promise<number> {
      commands.push("expire");
      const stored = values.get(key);
      if (stored === undefined) return 0;
      stored.expiresAt = now() + seconds * 1000;
      return 1;
    },
    /**
     * 本包只有一条 Lua 脚本 (共享 KV 的 CAS 写入), 按脚本契约在 JS 里等价实现:
     * KEYS = [payload, version], ARGV = [expectedVersion, valueJson, updatedAt, ttlSec].
     */
    async eval(
      _script: string,
      options: { keys: string[]; arguments: string[] },
    ): Promise<unknown[]> {
      commands.push("eval");
      const [payloadKey, versionKey] = options.keys;
      const [expected, valueJson, updatedAt, ttl] = options.arguments;
      if (payloadKey === undefined || versionKey === undefined) return [];
      const current = valueOf(payloadKey);
      let currentVersion = 0;
      if (current !== null) {
        try {
          const decoded = JSON.parse(current) as { version?: unknown };
          if (typeof decoded.version === "number") {
            currentVersion = decoded.version;
          }
        } catch {
          currentVersion = 0;
        }
      }
      if (expected !== undefined && expected !== "") {
        if (Number(expected) !== currentVersion) {
          return ["conflict", current ?? ""];
        }
      }
      const nextVersion = Number(valueOf(versionKey) ?? 0) + 1;
      values.set(versionKey, { value: String(nextVersion) });
      const encoded = JSON.stringify({
        value: JSON.parse(valueJson ?? "null"),
        version: nextVersion,
        updatedAt: Number(updatedAt ?? 0),
      });
      const ttlSec = Number(ttl ?? 0);
      values.set(payloadKey, {
        value: encoded,
        ...(ttlSec > 0 ? { expiresAt: now() + ttlSec * 1000 } : {}),
      });
      return ["ok", encoded];
    },
    async *scanIterator(
      options: { MATCH?: string } = {},
    ): AsyncGenerator<string[]> {
      commands.push("scan");
      const matcher =
        options.MATCH === undefined ? undefined : globToRegExp(options.MATCH);
      const matched = keysOf().filter(
        (key) => matcher === undefined || matcher.test(key),
      );
      if (matched.length > 0) yield matched;
    },
    async xAdd(
      key: string,
      id: string,
      fields: Record<string, string>,
      options: {
        TRIM?: { strategy: string; threshold: number };
      } = {},
    ): Promise<string> {
      commands.push("xadd");
      if (id !== "*") throw new Error(`假 broker 只支持 xAdd id="*": ${id}`);
      const entryId = nextStreamId();
      const list = streams.get(key) ?? [];
      list.push({ id: entryId, fields: { ...fields } });
      const threshold = options.TRIM?.threshold;
      if (threshold !== undefined && list.length > threshold) {
        list.splice(0, list.length - threshold);
      }
      streams.set(key, list);
      return entryId;
    },
    async xRevRange(
      key: string,
      _start: string,
      _end: string,
      options: { COUNT?: number } = {},
    ): Promise<Array<{ id: string; message: Record<string, string> }>> {
      commands.push("xrevrange");
      const list = [...(streams.get(key) ?? [])].reverse();
      const limited =
        options.COUNT === undefined ? list : list.slice(0, options.COUNT);
      return limited.map((entry) => ({
        id: entry.id,
        message: { ...entry.fields },
      }));
    },
    async xRead(
      targets: Array<{ key: string; id: string }>,
      options: { BLOCK?: number; COUNT?: number } = {},
    ): Promise<Array<{
      name: string;
      messages: Array<{ id: string; message: Record<string, string> }>;
    }> | null> {
      commands.push("xread");
      const reply: Array<{
        name: string;
        messages: Array<{ id: string; message: Record<string, string> }>;
      }> = [];
      for (const target of targets) {
        const fresh = (streams.get(target.key) ?? []).filter(
          (entry) => compareStreamId(entry.id, target.id) > 0,
        );
        const limited =
          options.COUNT === undefined ? fresh : fresh.slice(0, options.COUNT);
        if (limited.length > 0) {
          reply.push({
            name: target.key,
            messages: limited.map((entry) => ({
              id: entry.id,
              message: { ...entry.fields },
            })),
          });
        }
      }
      if (reply.length === 0) {
        // 模拟 BLOCK: 让出事件循环, 否则 reader 循环会忙等占住宏任务
        await new Promise((resolve) => setTimeout(resolve, 5));
        return null;
      }
      return reply;
    },
    async lPush(key: string, ...items: string[]): Promise<number> {
      commands.push("lpush");
      const list = lists.get(key) ?? [];
      list.unshift(...[...items].reverse());
      lists.set(key, list);
      return list.length;
    },
    async lTrim(key: string, start: number, stop: number): Promise<string> {
      commands.push("ltrim");
      const list = lists.get(key);
      if (list !== undefined) lists.set(key, list.slice(start, stop + 1));
      return "OK";
    },
    async lRange(key: string, start: number, stop: number): Promise<string[]> {
      commands.push("lrange");
      return (lists.get(key) ?? []).slice(start, stop + 1);
    },
  };

  const main = facade as unknown as RedisClientType;
  const reader = facade as unknown as RedisClientType;
  return {
    connection: {
      main,
      reader,
      address: { label: "fake:integration" },
      version: "7.0.0-fake",
    },
    main,
    reader,
    values,
    lists,
    streams,
    commands,
  };
}
