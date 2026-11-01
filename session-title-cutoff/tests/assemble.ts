/**
 * 集成层装配器：用假工具面 / 假事件面 / 假服务面拼出宿主并调用 `apply`。
 *
 * 三个假面的形状按总追踪 4.2 的口径（工具 / 事件 / 服务）。本文件不以 `.test.ts` 结尾，
 * 也不计入覆盖率（dev/coverage 只统 `src`）。
 *
 * 本包没有工具注册与落盘，装配器要拼的是三件事：
 * - 服务面 `sessionTitle`：宿主的唯一 provider 槽位，同名 provider 只能注册一个；
 * - 事件面 `session/event`：实时记账「假 git 提交面」投递的 `tool/call` 事件；
 * - 服务面 `sessionQuery`：重启场景下按会话事件重建 cutoff 的只读快照（可注入抛错与畸形快照）。
 *
 * 宿主 helper 用 `ApplyDeps.loadHelper` 注入严格复刻 0.2.1 键面的假实现，不解析真实宿主包。
 */

import { apply } from "../src/index.ts";
import type { ApplyDeps, Config } from "../src/index.ts";

/** 会话事件的最小结构面（与 `latestCommitSeq` 读到的形状一致）。 */
export interface SessionEvent {
  seq?: unknown;
  type?: unknown;
  data?: unknown;
}

/** `apply` 注册出来的 provider 形状。 */
export interface RegisteredProvider {
  id: string;
  automatic: string;
  generate(request: unknown): Promise<{
    title: string;
    messageSeqs: readonly number[];
    model?: unknown;
  }>;
}

/** 假工具面：本包不注册工具，保留计数用零断言。 */
export interface ToolSurface {
  names(): string[];
  registerCount(): number;
}

/** 假事件面：记录订阅，按会话投递事件。 */
export interface EventSurface {
  on(event: string, listener: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): number;
  listenerCount(event?: string): number;
}

/** 假服务面：宿主 `ctx.get` 的替身。 */
export interface ServiceSurface {
  get(name: string): unknown;
  names(): string[];
}

/** 假 git 提交面：会话事件的只读快照（`sessionQuery.readSession` 的替身）。 */
export interface GitSurface {
  /** 写入某会话的事件快照。 */
  seed(sessionId: string, events: readonly SessionEvent[]): void;
  /** 让 `readSession` 抛错（模拟事件不可读）。 */
  failWith(error?: Error): void;
  /** 让快照的 `events` 字段不是数组（模拟缺字段 / 畸形）。 */
  malformed(sessionId: string): void;
  /** 读过的会话 id（按调用顺序）。 */
  reads(): string[];
}

/** 装配选项。 */
export interface AssembleOptions {
  /** 插件配置。 */
  config?: Config;
  /** 覆盖 helper：`undefined` 表示加载失败；缺省用 0.2.1 形态假 helper。 */
  helper?: unknown;
  /** 让 `sessionTitle.register` 抛错（模拟已有 provider 占位）。 */
  registerFails?: boolean;
  /** 不提供 `ctx.sessionTitle`（降级装配）。 */
  noTitleService?: boolean;
  /** 不提供 `ctx.logger`（告警回落 stderr）。 */
  noLogger?: boolean;
  /** 让 `logger.warn` 抛错（logger 自身失败）。 */
  loggerThrows?: boolean;
  /** helper 的 `executeSessionTitleLlm` 抛错（生成失败路径）。 */
  executeFails?: Error;
}

/** helper 返回的标题响应（`TitleResponse` 的替身）。 */
export interface FakeResponse {
  blocks: readonly { type: string; text?: string }[];
  finish: { kind: string };
  model?: unknown;
}

/** 假 helper 的调用记录。 */
export interface HelperCall {
  ctx: unknown;
  config: Record<string, unknown>;
  request: unknown;
  titleProvider: unknown;
  prepared: {
    system: string;
    input: string;
    messageSeqs: readonly number[];
    selectReasoningEffort(model: unknown): string | undefined;
  };
}

/** 装配后的宿主句柄。 */
export interface AssembledHost {
  readonly ctx: unknown;
  readonly tools: ToolSurface;
  readonly events: EventSurface;
  readonly services: ServiceSurface;
  readonly git: GitSurface;
  /** helper 的调用记录（生成路径断言用）。 */
  readonly calls: HelperCall[];
  /** `ctx.logger.warn` 收到的告警。 */
  readonly warnings: string[];
  /** 落到 stderr 的告警行（logger 缺失或自身失败时）。 */
  readonly stderr: string[];
  /** 已注册的 provider；未注册时抛错，便于用例直接失败。 */
  provider(): RegisteredProvider;
  /** 已注册的 provider，未注册时为 undefined。 */
  providerOrUndefined(): RegisteredProvider | undefined;
  /** helper 下一次返回的响应（缺省单文本块 + `stop`）。 */
  setResponse(response: FakeResponse): void;
  /** 投递一条 `session/event` 事件（`session` 参数为 `{ id }`）。 */
  emitSessionEvent(sessionId: string, event: SessionEvent): number;
  /** 卸载：逆序触发 `apply` 期间登记的撤销动作（本包当前不登记）。 */
  unload(): void;
}

/** 0.2.1 helper 接受的键集合（宿主 `CONFIG_KEYS`）。 */
const HELPER_CONFIG_KEYS = new Set([
  "maxInputBytes",
  "maxOutputTokens",
  "timeoutMs",
  "provider",
  "model",
]);

/**
 * 严格复刻 0.2.1 `resolveSessionTitleLlmConfig` 的键面：未知键抛、正整数、
 * `provider` / `model` 成对且非空、返回冻结对象（与单元层的替身同口径）。
 */
function strictResolveSessionTitleLlmConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config === null || typeof config !== "object") {
    throw new Error("session-title-llm: configuration is required");
  }
  for (const key of Object.keys(config)) {
    if (!HELPER_CONFIG_KEYS.has(key)) {
      throw new Error(`session-title-llm: unknown config key "${key}"`);
    }
  }
  for (const key of [
    "maxInputBytes",
    "maxOutputTokens",
    "timeoutMs",
  ] as const) {
    const value = config[key];
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new Error(`session-title-llm: ${key} must be a positive integer`);
    }
  }
  const hasProvider = config["provider"] !== undefined;
  if (hasProvider !== (config["model"] !== undefined)) {
    throw new Error(
      "session-title-llm: provider and model must be supplied together",
    );
  }
  return Object.freeze({ ...config });
}

/** 装配 `apply`：三个假面 + 假 helper + 告警收集。 */
export async function assemble(
  options: AssembleOptions = {},
): Promise<AssembledHost> {
  const providers: RegisteredProvider[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const warnings: string[] = [];
  const toolNames: string[] = [];
  const disposers: Array<() => unknown> = [];
  const calls: HelperCall[] = [];
  const gitReads: string[] = [];
  const snapshots = new Map<string, readonly SessionEvent[] | "malformed">();
  let gitFailure: Error | undefined;
  let response: FakeResponse = {
    blocks: [{ type: "text", text: "集成层标题" }],
    finish: { kind: "stop" },
    model: { reasoning: { efforts: [{ id: "high" }] } },
  };

  const git: GitSurface = {
    seed(sessionId, events) {
      snapshots.set(sessionId, events);
    },
    failWith(error) {
      gitFailure = error ?? new Error("sessionQuery.readSession failed");
    },
    malformed(sessionId) {
      snapshots.set(sessionId, "malformed");
    },
    reads() {
      return [...gitReads];
    },
  };

  const helper =
    options.helper === undefined
      ? {
          resolveSessionTitleLlmConfig: strictResolveSessionTitleLlmConfig,
          executeSessionTitleLlm: async (
            ctx: unknown,
            config: Record<string, unknown>,
            request: unknown,
            titleProvider: unknown,
            prepared: HelperCall["prepared"],
          ) => {
            calls.push({ ctx, config, request, titleProvider, prepared });
            if (options.executeFails !== undefined) throw options.executeFails;
            return response;
          },
        }
      : options.helper;

  const deps: ApplyDeps = {
    loadHelper: async () => helper as never,
  };

  const serviceValues = new Map<string, unknown>();
  serviceValues.set("sessionQuery", {
    readSession: async (sessionId: string) => {
      gitReads.push(sessionId);
      if (gitFailure !== undefined) throw gitFailure;
      const snapshot = snapshots.get(sessionId);
      if (snapshot === "malformed") return { events: "not-an-array" };
      return { events: snapshot ?? [] };
    },
  });

  if (options.noTitleService !== true) {
    serviceValues.set("sessionTitle", {
      register(provider: RegisteredProvider) {
        if (options.registerFails === true) {
          throw new Error('provider "session-title-all-prompts-llm" exists');
        }
        providers.push(provider);
        return () => {
          const index = providers.indexOf(provider);
          if (index >= 0) providers.splice(index, 1);
        };
      },
    });
  }

  const events: EventSurface = {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (set === undefined) return 0;
      for (const listener of [...set]) listener(payload);
      return set.size;
    },
    listenerCount(event) {
      if (event !== undefined) return listeners.get(event)?.size ?? 0;
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };

  const ctx: Record<string, unknown> = {
    get: (name: string) => serviceValues.get(name),
    llm: {},
    tools: {
      register: (def: { name?: unknown }) => {
        toolNames.push(String(def.name));
      },
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const dispose = events.on(event, (payload) => {
        const envelope = payload as { session: unknown; event: unknown };
        listener(envelope.session, envelope.event);
      });
      disposers.push(dispose);
      return dispose;
    },
  };
  const titleService = serviceValues.get("sessionTitle");
  if (titleService !== undefined) ctx["sessionTitle"] = titleService;
  if (options.noLogger !== true) {
    ctx["logger"] = {
      warn: (message: string) => {
        if (options.loggerThrows === true) throw new Error("logger down");
        warnings.push(message);
      },
    };
  }

  const stderr: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await apply(ctx, options.config, deps);
  } finally {
    process.stderr.write = original;
  }

  const emitSessionEvent = (sessionId: string, event: SessionEvent): number =>
    events.emit("session/event", { session: { id: sessionId }, event });

  return {
    ctx,
    tools: {
      names: () => [...toolNames],
      registerCount: () => toolNames.length,
    },
    events,
    services: {
      get: (name) => serviceValues.get(name),
      names: () => [...serviceValues.keys()],
    },
    git,
    calls,
    warnings,
    stderr,
    provider() {
      const found = providers[0];
      if (found === undefined) throw new Error("未注册标题 provider");
      return found;
    },
    providerOrUndefined: () => providers[0],
    setResponse(next) {
      response = next;
    },
    emitSessionEvent,
    unload() {
      for (const dispose of disposers.splice(0).reverse()) void dispose();
    },
  };
}
