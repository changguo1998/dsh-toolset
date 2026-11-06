/**
 * flow-track 插件入口（DSH bundle 接入面）。
 *
 * 角色：把本仓「标准流程」固化成机制的三件组合——
 * ① 阶段模板（`stages.ts`，八阶段）由回合边界的注入交给模型，模型据此手动 `task_decompose`；
 * ② 流程记录（`store.ts`，memory-base 项目层 kind `flow`）由 `flow_record` 写、`flow_status` 读；
 * ③ 推进状态（`status.ts`，只读 `taskEngine.query()`）+ 合规提示（`observe.ts` 数写类工具调用）
 *    在回合边界合成一条注入。
 *
 * 固化强度 = 中档（决策项 4.3 = b）：**只提示不拦截**。
 *
 * 降级：`ruleEngine` 缺席 → 告警且不注册消费者；`memory` 缺席 → 工具返回可读错误、注入里只剩模板与
 * 状态；`taskEngine` 缺席 → 状态段退化为「没有可识别的阶段树」。
 */

import type { SnapshotLike } from "./status.ts";
import { FlowStore, type FlowRecord } from "./store.ts";
import { WriteObserver, type SessionEventLike } from "./observe.ts";
import { decideText } from "./inject.ts";
import { flowTools } from "./tools.ts";

export const name = "flow-track";

/** 硬依赖：消费者注册面（rule-engine provide `ruleEngine`）。 */
export const inject = ["ruleEngine"];

/** 插件配置（类型声明，宿主不校验；缺省见 resolveConfig）。 */
export interface Config {
  /** 是否开启注入（缺省 `true`；显式 `false` 时工具仍可用）。 */
  enabled?: boolean;
  /** 唤醒节点（缺省 `["turn-start", "user-message"]`）。 */
  sources?: readonly string[];
  /** 投递方式（缺省 `"inject"`）。 */
  delivery?: "steer" | "inject" | "followup";
}

/** 归一化后的配置。 */
export interface ResolvedConfig {
  enabled: boolean;
  sources: readonly string[];
  delivery: "steer" | "inject" | "followup";
}

/** 归一化配置（非法值回退缺省，不抛错）。 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const sources =
    Array.isArray(config?.sources) && config.sources.length > 0
      ? config.sources.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
      : [];
  return {
    enabled: config?.enabled !== false,
    sources: sources.length > 0 ? sources : ["turn-start", "user-message"],
    delivery:
      config?.delivery === "steer" || config?.delivery === "followup"
        ? config.delivery
        : "inject",
  };
}

/** rule-engine 消费者注册面（结构化类型）。 */
interface ConsumerRegistrar {
  registerConsumer(input: {
    id: string;
    sources?: readonly string[];
    delivery?: string;
    dedupeInRecord?: number;
    decide: (context: {
      sessionId: string;
      turn: number;
      text: string;
      trigger: string;
    }) => { text: string; summary?: string } | null;
  }): () => void;
}

/** 只读快照面（task-engine `provide("taskEngine")`）。 */
interface TaskEngineFace {
  query?(): SnapshotLike;
  frameStack?(): readonly string[];
}

/** 插件上下文的结构化面。 */
interface PluginContext {
  ruleEngine?: ConsumerRegistrar;
  get?(name: string): unknown;
  tools?: { register(def: unknown): unknown };
  on?(event: string, handler: (...args: unknown[]) => unknown): () => void;
  logger?: { warn?: (message: string) => void };
}

/** 反射面（`ctx.reflect.get`：不要求 inject 就能读服务）。 */
interface ReflectLike {
  get?(name: string): unknown;
}

/**
 * 读一个服务（本包未 inject 的服务经 `ctx.reflect.get` 读；取不到返回 undefined）。
 *
 * 直接读 `ctx.memory` 这类未 inject 的服务属性在 cordis 里会抛错，故先走反射面，
 * 再退回属性读（两者都包在 try 里）。
 */
function readService<T>(
  ctx: PluginContext,
  serviceName: string,
): T | undefined {
  let reflect: ReflectLike | undefined;
  try {
    reflect = (ctx as { reflect?: ReflectLike }).reflect;
  } catch {
    reflect = undefined;
  }
  if (typeof reflect?.get === "function") {
    try {
      const value = reflect.get(serviceName);
      if (value !== undefined) return value as T;
    } catch {
      /* 反射面读失败：落到属性读 */
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[serviceName] as
      T | undefined;
  } catch {
    return undefined;
  }
}

/** 组装只读快照（taskEngine 缺席或抛错 → undefined）。 */
function snapshotOf(
  engine: TaskEngineFace | undefined,
): SnapshotLike | undefined {
  if (engine === undefined || typeof engine.query !== "function")
    return undefined;
  try {
    return engine.query();
  } catch {
    return undefined;
  }
}

/** 会话事件里取会话 id（`session.id`）。 */
function sessionIdOf(session: unknown): string | undefined {
  const id = (session as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * 挂载：注册两个工具、订阅 `session/event` 记账、注册 rule-engine 消费者。
 * 返回 dispose（注销消费者与事件订阅）。
 */
export function apply(ctx: unknown, config?: Config): () => void {
  const c = (ctx ?? {}) as PluginContext;
  const logger = readService<{ warn?(message: string): void }>(c, "logger");
  const warn = (message: string): void => {
    if (typeof logger?.warn === "function") {
      logger.warn(`[flow-track] ${message}`);
      return;
    }
    process.stderr.write(`[flow-track] warn: ${message}\n`);
  };
  const resolved = resolveConfig(config);
  const engine = readService<ConsumerRegistrar>(c, "ruleEngine");
  if (engine === undefined || typeof engine.registerConsumer !== "function") {
    warn(
      "ctx.ruleEngine 不可用，阶段模板与推进状态不会注入（请检查 rule-engine 是否挂载）",
    );
    return () => {};
  }
  const memory = readService<{
    registerKind(spec: {
      kind: string;
      writableTiers?: readonly string[];
    }): never;
    list?(opts: {
      kind?: string;
      tier?: string;
      limit?: number;
    }): Promise<never[]>;
  }>(c, "memory");
  // memory 缺席时给一个「注册即抛错」的替身：FlowStore 走 available=false 分支，工具返回可读错误
  const store = new FlowStore(
    memory ?? {
      registerKind(): never {
        throw new Error("ctx.memory 不可用（请检查 memory-base 是否挂载）");
      },
    },
  );
  if (!store.available) {
    warn(`流程记录不可写入：${store.unavailableReason ?? "原因未知"}`);
  }
  const taskEngine = readService<TaskEngineFace>(c, "taskEngine");
  if (taskEngine === undefined) {
    warn("ctx.taskEngine 不可用，推进状态段会退化为「没有可识别的阶段树」");
  }

  const observer = new WriteObserver();

  /** 记录缓存：`decide` 是同步的，读库（异步）只能提前喂进来。 */
  const cache: { records: FlowRecord[] } = { records: [] };
  const refresh = async (): Promise<void> => {
    try {
      cache.records = await store.list({ limit: 20 });
    } catch {
      cache.records = [];
    }
  };
  void refresh();

  const tools = readService<{ register(def: unknown): unknown }>(c, "tools");
  if (tools !== undefined && typeof tools.register === "function") {
    const deps = {
      store,
      observer,
      snapshot: () => snapshotOf(taskEngine),
      slugFor: (sessionId: string) => sessionId,
      onRecorded: () => void refresh(),
    };
    for (const tool of flowTools(deps)) {
      try {
        tools.register(tool);
      } catch (error) {
        warn(`工具 ${tool.name} 注册失败：${String(error)}`);
      }
    }
  } else {
    warn("ctx.tools 不可用，flow_record / flow_status 不会出现");
  }

  const disposers: Array<() => void> = [];
  if (typeof c.on === "function") {
    const off = c.on("session/event", (...args: unknown[]) => {
      const sessionId = sessionIdOf(args[0]);
      const event = args[1] as SessionEventLike | undefined;
      if (sessionId === undefined || event === undefined) return;
      observer.observe(sessionId, event);
      // 写类调用后刷一次记录缓存（下一次 decide 就能看到最新状态）
      void refresh();
    });
    if (typeof off === "function") disposers.push(off);
  } else {
    warn("ctx.on 不可用，合规观测不会生效（请检查宿主版本）");
  }

  try {
    const off = engine.registerConsumer({
      id: name,
      sources: resolved.sources,
      delivery: resolved.delivery,
      dedupeInRecord: 0,
      decide: (context) => {
        if (!resolved.enabled) return null;
        const snapshot = snapshotOf(taskEngine);
        const lastWriteTool = observer.lastWriteTool(context.sessionId);
        const text = decideText({
          ...(snapshot === undefined ? {} : { snapshot }),
          records: cache.records,
          writeSeen: observer.writeSeen(context.sessionId),
          ...(lastWriteTool === undefined ? {} : { lastWriteTool }),
        });
        return text === undefined ? null : { text, summary: "流程推进" };
      },
    });
    if (typeof off === "function") disposers.push(off);
  } catch (error) {
    warn(`注册消费者失败：${String(error)}`);
  }

  return () => {
    for (const dispose of disposers) dispose();
    observer.clear();
  };
}
